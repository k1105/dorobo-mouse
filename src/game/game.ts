import * as THREE from 'three';
import { CONFIG, COLORS } from '../config';
import type { NetAdapter } from '../net';
import type { GameEvent, PhaseState, PlayerInfo, PosMsg, Role } from '../types';
import { isMouse } from '../types';
import { Controls } from './controls';
import { CctvView } from './cctv';
import { createNpcSims, NpcSim } from './npc';
import { buildWorld, makeCapsule, type World } from './world';
import { Hud } from '../ui/hud';

interface RemoteAvatar {
  mesh: THREE.Mesh;
  role: Role;
  target: PosMsg | null;
}

interface Beacon {
  mesh: THREE.Mesh;
  expireAt: number;
}

/** 1ラウンドのゲーム本体。roleに応じて操作・表示を切り替える */
export class Game {
  private net: NetAdapter;
  private room: string;
  private myRole: Role;
  private startAt: number;
  private seed: number;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private followCam = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  private world: World;
  private controls = new Controls();
  private hud: Hud;
  private cctv: CctvView | null = null;

  private myMesh: THREE.Mesh | null = null;
  private selfRing: THREE.Mesh | null = null;
  private remotes = new Map<string, RemoteAvatar>();
  private npcSims: NpcSim[];
  private npcMeshes: THREE.Mesh[] = [];
  private npcFlashUntil: number[] = [];

  private targetMarker: THREE.Group;
  private beacons: Beacon[] = [];

  private stealCount = 0;
  private myCarrying = 0;
  private insideStart: number | null = null;
  private lastTargetIdx = -1;
  private frozenUntil = 0;
  private phase: PhaseState;
  private seenEvents = new Set<string>();
  private eventsInitialized = false;

  private raf = 0;
  private lastFrame = performance.now();
  private lastPosSend = 0;
  private unsubs: (() => void)[] = [];
  private disposed = false;

  constructor(
    private container: HTMLElement,
    net: NetAdapter,
    room: string,
    private players: Record<string, PlayerInfo>,
    phase: PhaseState,
  ) {
    this.net = net;
    this.room = room;
    this.phase = phase;
    this.myRole = players[net.clientId]?.role ?? 'none';
    this.startAt = phase.startAt ?? Date.now();
    this.seed = phase.seed ?? 1;

    // レンダラ
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);
    this.onResize();

    // ワールドとNPC
    this.world = buildWorld(this.scene, this.seed);
    this.npcSims = createNpcSims(this.seed, CONFIG.npcCount);
    for (let i = 0; i < CONFIG.npcCount; i++) {
      const mesh = makeCapsule('mouse');
      this.scene.add(mesh);
      this.npcMeshes.push(mesh);
      this.npcFlashUntil.push(0);
    }

    // 自分のアバター（ネズミ or 鬼猫。カメラ監視役と観戦者はアバターなし）
    if (isMouse(this.myRole) || this.myRole === 'catSeeker') {
      this.myMesh = makeCapsule(isMouse(this.myRole) ? 'mouse' : 'cat');
      const spawn = this.spawnPos();
      this.myMesh.position.x = spawn.x;
      this.myMesh.position.z = spawn.z;
      this.scene.add(this.myMesh);
      // 自分がどのカプセルか分かるように、自分にだけ見えるリングを足元に表示
      this.selfRing = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.65, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
      );
      this.selfRing.rotation.x = -Math.PI / 2;
      this.selfRing.position.y = 0.05;
      this.scene.add(this.selfRing);
    }

    // 他プレイヤーのアバター
    for (const [pid, info] of Object.entries(players)) {
      if (pid === net.clientId) continue;
      if (!isMouse(info.role) && info.role !== 'catSeeker') continue;
      const mesh = makeCapsule(isMouse(info.role) ? 'mouse' : 'cat');
      mesh.visible = false; // 最初の位置情報が来るまで隠す
      this.scene.add(mesh);
      this.remotes.set(pid, { mesh, role: info.role, target: null });
    }

    // お題スポットのマーカー（ネズミにだけ見える）
    this.targetMarker = this.buildTargetMarker();
    this.targetMarker.visible = false;
    this.scene.add(this.targetMarker);

    // HUD
    this.hud = new Hud(container, this.myRole);

    // カメラ監視役はCCTVビュー
    if (this.myRole === 'catCamera') {
      this.cctv = new CctvView(container, this.world.cctvCams.length, (camId) => {
        this.net.push(`rooms/${this.room}/events`, {
          type: 'alert',
          by: this.net.clientId,
          camId,
          at: Date.now(),
        } satisfies GameEvent);
        this.hud.banner(`CAM ${camId + 1} にアラートを送信しました`, 'info');
      });
    }

    this.controls.onKey = (code) => this.onKey(code);

    // ネットワーク購読
    this.unsubs.push(
      this.net.subscribe(`rooms/${room}/pos`, (val) => this.onPositions(val)),
      this.net.subscribe(`rooms/${room}/events`, (val) => this.onEvents(val)),
      this.net.subscribe(`rooms/${room}/phase`, (val) => this.onPhase(val)),
    );

    this.applyTarget();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** ロビーに戻ったときの後始末（呼び出しはmain.ts） */
  onExit: (() => void) | null = null;

  // ---- 初期化ヘルパ ----

  private spawnPos(): { x: number; z: number } {
    if (this.myRole === 'catSeeker') return { x: 0, z: 10.5 };
    // ネズミは下側の通路にばらけてスポーン
    const i = this.myRole === 'mouse1' ? -1 : 1;
    return { x: i * 7.5, z: 10.5 };
  }

  private buildTargetMarker(): THREE.Group {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CONFIG.stealRadius - 0.25, CONFIG.stealRadius, 40),
      new THREE.MeshBasicMaterial({
        color: COLORS.target,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 6, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: COLORS.target, transparent: true, opacity: 0.35 }),
    );
    beam.position.y = 3;
    g.add(beam);
    return g;
  }

  // ---- ネットワークイベント ----

  private onPositions(val: unknown): void {
    const all = (val ?? {}) as Record<string, PosMsg>;
    for (const [pid, pos] of Object.entries(all)) {
      if (pid === this.net.clientId) continue;
      const r = this.remotes.get(pid);
      if (r) {
        if (!r.target) {
          // 初回はワープして表示
          r.mesh.position.x = pos.x;
          r.mesh.position.z = pos.z;
          r.mesh.visible = true;
        }
        r.target = pos;
      }
    }
  }

  private onEvents(val: unknown): void {
    const all = (val ?? {}) as Record<string, GameEvent>;
    const keys = Object.keys(all).sort();
    const firstBatch = !this.eventsInitialized;
    for (const key of keys) {
      if (this.seenEvents.has(key)) continue;
      this.seenEvents.add(key);
      this.applyEvent(all[key], firstBatch);
    }
    this.eventsInitialized = true;
    this.applyTarget();
  }

  private applyEvent(ev: GameEvent, silent: boolean): void {
    const isCatTeam = this.myRole === 'catSeeker' || this.myRole === 'catCamera';
    switch (ev.type) {
      case 'steal':
        this.stealCount++;
        if (ev.by === this.net.clientId) this.myCarrying++;
        if (!silent && isMouse(this.myRole)) {
          this.hud.banner(
            ev.by === this.net.clientId ? '盗み成功！出口から逃げよう！' : '仲間が盗みに成功！',
            'info',
          );
        }
        break;
      case 'alert':
        if (!silent && isCatTeam) {
          if (this.myRole === 'catSeeker') {
            this.hud.banner(`🚨 CAM ${ev.camId + 1} 付近に不審な動き！`, 'alert');
          }
          this.spawnBeacon(ev.camId);
        }
        break;
      case 'miss':
        if (!silent) {
          this.npcFlashUntil[ev.npcIdx] = performance.now() + 1000;
          if (this.myRole === 'catSeeker' && ev.by !== this.net.clientId) {
            this.hud.banner('相方がNPCを誤キャッチ！', 'info');
          }
        }
        break;
      case 'caught':
      case 'escape':
        // 勝敗はphaseの変更で処理される
        break;
    }
  }

  private spawnBeacon(camId: number): void {
    const pos = this.world.camPositions[camId];
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 5, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff5722,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.set(pos.x, 2.5, pos.z);
    this.scene.add(mesh);
    this.beacons.push({ mesh, expireAt: performance.now() + 6000 });
  }

  private onPhase(val: unknown): void {
    const phase = val as PhaseState | null;
    if (!phase) return;
    this.phase = phase;
    if (phase.phase === 'ended' && phase.winner) {
      this.hud.showEnd(phase.winner, phase.reason ?? '', () => {
        // 誰でもロビーに戻せる（プロトタイプ）
        this.net.remove(`rooms/${this.room}/events`);
        this.net.remove(`rooms/${this.room}/pos`);
        this.net.set(`rooms/${this.room}/phase`, { phase: 'lobby' } satisfies PhaseState);
      });
    }
  }

  /** 勝敗を確定させる（すでに終了していたら何もしない） */
  private endGame(winner: 'mice' | 'cats', reason: string): void {
    if (this.phase.phase !== 'playing') return;
    this.net.set(`rooms/${this.room}/phase`, {
      ...this.phase,
      phase: 'ended',
      winner,
      reason,
    } satisfies PhaseState);
  }

  // ---- お題 ----

  private currentTargetIdx(): number {
    return this.world.targetOrder[this.stealCount % this.world.targetOrder.length];
  }

  private applyTarget(): void {
    const idx = this.currentTargetIdx();
    if (idx === this.lastTargetIdx) return;
    this.lastTargetIdx = idx;
    this.insideStart = null;
    const spot = this.world.spots[idx];
    this.targetMarker.position.set(spot.x, 0, spot.z);
    // お題の場所と内容はネズミにしか見えない
    this.targetMarker.visible = isMouse(this.myRole);
    if (isMouse(this.myRole)) this.hud.setTarget(spot.item);
  }

  // ---- 入力 ----

  private onKey(code: string): void {
    if (this.cctv) {
      this.cctv.handleKey(code);
      return;
    }
    if (code === 'Space' && this.myRole === 'catSeeker') this.tryCatch();
  }

  private tryCatch(): void {
    if (!this.myMesh || this.phase.phase !== 'playing') return;
    const now = performance.now();
    if (now < this.frozenUntil) return;
    const t = this.gameTime();
    if (t < 0) return;
    const px = this.myMesh.position.x;
    const pz = this.myMesh.position.z;

    let best: { kind: 'npc'; idx: number } | { kind: 'player'; pid: string } | null = null;
    let bestDist: number = CONFIG.catchRadius;
    this.npcSims.forEach((sim, i) => {
      const p = sim.posAt(t);
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < bestDist) {
        bestDist = d;
        best = { kind: 'npc', idx: i };
      }
    });
    for (const [pid, r] of this.remotes) {
      if (!isMouse(r.role) || !r.target) continue;
      const d = Math.hypot(r.mesh.position.x - px, r.mesh.position.z - pz);
      if (d < bestDist) {
        bestDist = d;
        best = { kind: 'player', pid };
      }
    }
    if (!best) return;
    const hit = best as { kind: 'npc'; idx: number } | { kind: 'player'; pid: string };
    if (hit.kind === 'player') {
      this.net.push(`rooms/${this.room}/events`, {
        type: 'caught',
        by: this.net.clientId,
        mouseId: hit.pid,
        at: Date.now(),
      } satisfies GameEvent);
      const name = this.players[hit.pid]?.name ?? 'ネズミ';
      this.endGame('cats', `${name} を捕まえた！`);
    } else {
      this.net.push(`rooms/${this.room}/events`, {
        type: 'miss',
        by: this.net.clientId,
        npcIdx: hit.idx,
        at: Date.now(),
      } satisfies GameEvent);
      this.frozenUntil = now + CONFIG.catchPenaltySec * 1000;
    }
  }

  // ---- メインループ ----

  private gameTime(): number {
    return (Date.now() - this.startAt) / 1000;
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const t = this.gameTime();
    const playing = this.phase.phase === 'playing' && t >= 0;

    // 開始前カウントダウン
    if (this.phase.phase === 'playing' && t < 0) {
      this.hud.setCenter(String(Math.ceil(-t)));
    } else if (this.myRole === 'catSeeker' && now < this.frozenUntil) {
      this.hud.setCenter(`😵 ${Math.ceil((this.frozenUntil - now) / 1000)}`);
    } else {
      this.hud.setCenter('');
    }

    // 自分の移動
    if (this.myMesh && playing && !(this.myRole === 'catSeeker' && now < this.frozenUntil)) {
      const mv = this.controls.moveVec();
      const speed = this.myRole === 'catSeeker' ? CONFIG.catSpeed : CONFIG.mouseSpeed;
      if (mv.x !== 0 || mv.z !== 0) {
        this.moveWithCollision(mv.x * speed * dt, mv.z * speed * dt);
        this.myMesh.rotation.y = Math.atan2(mv.x, mv.z);
      }
      // 位置送信（スロットリング）
      if (now - this.lastPosSend > 1000 / CONFIG.posSendHz) {
        this.lastPosSend = now;
        this.net.set(`rooms/${this.room}/pos/${this.net.clientId}`, {
          x: this.myMesh.position.x,
          z: this.myMesh.position.z,
          ry: this.myMesh.rotation.y,
          t: Date.now(),
        } satisfies PosMsg);
      }
    }
    if (this.myMesh && this.selfRing) {
      this.selfRing.position.x = this.myMesh.position.x;
      this.selfRing.position.z = this.myMesh.position.z;
    }

    // NPC（カウントダウン中は開始時点の配置で立たせておく）
    {
      const nt = Math.max(0, t);
      for (let i = 0; i < this.npcSims.length; i++) {
        const p = this.npcSims[i].posAt(nt);
        const mesh = this.npcMeshes[i];
        mesh.position.x = p.x;
        mesh.position.z = p.z;
        mesh.rotation.y = p.ry;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const flashing = now < this.npcFlashUntil[i];
        mat.color.setHex(flashing ? 0xff3333 : COLORS.mouse);
      }
    }

    // リモートプレイヤーの補間
    for (const r of this.remotes.values()) {
      if (!r.target) continue;
      const k = Math.min(1, dt * 12);
      r.mesh.position.x += (r.target.x - r.mesh.position.x) * k;
      r.mesh.position.z += (r.target.z - r.mesh.position.z) * k;
      r.mesh.rotation.y = r.target.ry;
    }

    // ネズミの盗み判定
    if (playing && isMouse(this.myRole) && this.myMesh) {
      const spot = this.world.spots[this.currentTargetIdx()];
      const d = Math.hypot(this.myMesh.position.x - spot.x, this.myMesh.position.z - spot.z);
      if (d <= CONFIG.stealRadius) {
        if (this.insideStart === null) this.insideStart = t;
        const p = (t - this.insideStart) / CONFIG.stealTimeSec;
        this.hud.setProgress(p);
        if (p >= 1) {
          this.insideStart = null;
          this.hud.setProgress(null);
          this.net.push(`rooms/${this.room}/events`, {
            type: 'steal',
            by: this.net.clientId,
            spotIdx: spot.idx,
            at: Date.now(),
          } satisfies GameEvent);
        }
      } else {
        this.insideStart = null;
        this.hud.setProgress(null);
      }
      // 出口判定（何か持っていれば脱出成功）
      if (
        this.myCarrying > 0 &&
        this.world.isInExitZone(this.myMesh.position.x, this.myMesh.position.z)
      ) {
        const name = this.players[this.net.clientId]?.name ?? 'ネズミ';
        this.net.push(`rooms/${this.room}/events`, {
          type: 'escape',
          by: this.net.clientId,
          at: Date.now(),
        } satisfies GameEvent);
        this.endGame('mice', `${name} が商品を持って逃げ切った！`);
      }
    }

    // お題マーカーの明滅
    if (this.targetMarker.visible) {
      const s = 1 + Math.sin(now / 250) * 0.08;
      this.targetMarker.scale.set(s, 1, s);
    }

    // アラートビーコンの寿命
    for (let i = this.beacons.length - 1; i >= 0; i--) {
      const b = this.beacons[i];
      b.mesh.rotation.y += dt * 2;
      if (now > b.expireAt) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.beacons.splice(i, 1);
      }
    }

    // タイマー・時間切れ
    const remain = CONFIG.roundTimeSec - Math.max(0, t);
    this.hud.setTimer(remain);
    if (playing && remain <= 0) {
      this.endGame('cats', '時間切れ！ネズミは逃げられなかった…');
    }
    if (isMouse(this.myRole)) this.hud.setSteals(this.stealCount, this.myCarrying);

    // 描画
    if (this.cctv) {
      this.cctv.render(this.renderer, this.scene, this.world.cctvCams);
    } else {
      this.updateFollowCam();
      this.renderer.render(this.scene, this.followCam);
    }
  };

  private moveWithCollision(dx: number, dz: number): void {
    if (!this.myMesh) return;
    const r = 0.4;
    const b = this.world.bounds;
    const collides = (x: number, z: number) =>
      this.world.obstacles.some(
        (o) => x + r > o.minX && x - r < o.maxX && z + r > o.minZ && z - r < o.maxZ,
      );
    // 軸ごとに判定して壁ずりを可能にする
    let x = this.myMesh.position.x + dx;
    if (collides(x, this.myMesh.position.z)) x = this.myMesh.position.x;
    let z = this.myMesh.position.z + dz;
    if (collides(x, z)) z = this.myMesh.position.z;
    this.myMesh.position.x = Math.min(b.maxX, Math.max(b.minX, x));
    this.myMesh.position.z = Math.min(b.maxZ, Math.max(b.minZ, z));
  }

  private updateFollowCam(): void {
    if (this.myMesh) {
      const p = this.myMesh.position;
      this.followCam.position.set(p.x, p.y + 8, p.z + 7);
      this.followCam.lookAt(p.x, 0.5, p.z - 1);
    } else {
      // 観戦者は俯瞰
      this.followCam.position.set(0, 28, 14);
      this.followCam.lookAt(0, 0, 0);
    }
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.followCam.aspect = w / h;
    this.followCam.updateProjectionMatrix();
  };

  /** リソース解放（Three.js資源・購読・rAF・DOM） */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsubs) u();
    this.controls.dispose();
    this.hud.dispose();
    this.cctv?.dispose();
    window.removeEventListener('resize', this.onResize);
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
