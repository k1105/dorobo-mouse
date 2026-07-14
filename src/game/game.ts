import * as THREE from 'three';
import { CONFIG } from '../config';
import type { NetAdapter } from '../net';
import type { GameEvent, PhaseState, PlayerInfo, PosMsg, Role, Round, Team } from '../types';
import { isMouseInRound, teamOf } from '../types';
import { Controls } from './controls';
import { CctvView } from './cctv';
import { CamMapView } from '../ui/map';
import { createNpcSims, NpcSim } from './npc';
import { buildWorld, makeCapsule, type World } from './world';
import { Hud } from '../ui/hud';

interface RemoteAvatar {
  mesh: THREE.Mesh;
  target: PosMsg | null;
}

/**
 * 1ラウンド分のゲーム本体。1分経過または ダウト成功でラウンドが終わり、
 * 前半(round=1)はチームAがネズミ、後半(round=2)は攻守交代する。main.tsがラウンドごとに作り直す。
 */
export class Game {
  readonly round: Round;
  private net: NetAdapter;
  private room: string;
  private myRole: Role;
  private myTeam: Team | null;
  private amMouse: boolean;
  private amCat: boolean;
  private startAt: number;
  private seed: number;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private followCam = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  private world: World;
  private controls = new Controls();
  private hud: Hud;
  private cctv: CctvView | null = null;
  private camMap: CamMapView | null = null;
  private raycaster = new THREE.Raycaster();

  private myMesh: THREE.Mesh | null = null;
  private selfRing: THREE.Mesh | null = null;
  /** 揺れモーション抜きの自分の実位置（移動・判定はこちらを使う） */
  private baseX = 0;
  private baseZ = 0;
  private remotes = new Map<string, RemoteAvatar>();
  private npcSims: NpcSim[];
  private npcMeshes: THREE.Mesh[] = [];
  private npcFlashUntil: number[] = [];

  private targetMarker: THREE.Group;

  private stealCount = 0;
  private myCarrying = 0;
  private scoreA = 0;
  private scoreB = 0;
  private myDoubtsUsed = 0;
  private insideStart: number | null = null;
  private lastTargetIdx = -1;
  private phase: PhaseState;
  private endSent = false;
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
    this.round = phase.round ?? 1;
    this.myRole = players[net.clientId]?.role ?? 'none';
    this.myTeam = teamOf(this.myRole);
    this.amMouse = this.myRole !== 'none' && isMouseInRound(this.myRole, this.round);
    this.amCat = this.myTeam !== null && !this.amMouse;
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
    this.npcSims = createNpcSims(this.seed, CONFIG.npcCount, this.world.nav);
    for (let i = 0; i < CONFIG.npcCount; i++) {
      const mesh = makeCapsule();
      this.scene.add(mesh);
      this.npcMeshes.push(mesh);
      this.npcFlashUntil.push(0);
    }

    // 自分のアバター（このラウンドでネズミの場合のみ。猫はカメラ越しに見るだけで店内にいない）
    if (this.amMouse) {
      this.myMesh = makeCapsule();
      const spawn = this.spawnPos();
      this.baseX = spawn.x;
      this.baseZ = spawn.z;
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

    // 他プレイヤーのアバター（このラウンドでネズミのプレイヤーのみ店内に存在する）
    for (const [pid, info] of Object.entries(players)) {
      if (pid === net.clientId) continue;
      if (info.role === 'none' || !isMouseInRound(info.role, this.round)) continue;
      const mesh = makeCapsule();
      mesh.visible = false; // 最初の位置情報が来るまで隠す
      this.scene.add(mesh);
      this.remotes.set(pid, { mesh, target: null });
    }

    // お題スポットのマーカー（ネズミにだけ見える）
    this.targetMarker = this.buildTargetMarker();
    this.targetMarker.visible = false;
    this.scene.add(this.targetMarker);

    // HUD
    this.hud = new Hud(container, this.roleLabel());
    if (phase.note) this.hud.banner(phase.note, 'info');
    if (this.round === 2 && this.myTeam) {
      this.hud.banner(`後半戦: あなたは${this.amMouse ? '🐭 ネズミ' : '🎥 カメラ監視'}です`, 'info');
    }

    // 猫チームはCCTVビュー（同時オンライン4台まで）とカメラマップ（Mでモーダル表示）
    if (this.amCat) {
      this.cctv = new CctvView(container, this.world.cctvCams.length, () =>
        this.camMap?.toggle(),
      );
      this.camMap = new CamMapView(container, this.world.mapData);
      this.renderer.domElement.style.cursor = 'crosshair';
      this.renderer.domElement.addEventListener('click', this.onCanvasClick);
      // どのカメラがオンラインかを全クライアントへ共有（球の発光・視野ハイライト用）
      this.cctv.onChange = () => this.publishCams();
      this.publishCams();
      this.net.onDisconnectRemove(`rooms/${this.room}/cams/${this.net.clientId}`);
    }

    this.controls.onKey = (code) => this.onKey(code);

    // ネットワーク購読
    this.unsubs.push(
      this.net.subscribe(`rooms/${room}/pos`, (val) => this.onPositions(val)),
      this.net.subscribe(`rooms/${room}/events`, (val) => this.onEvents(val)),
      this.net.subscribe(`rooms/${room}/phase`, (val) => this.onPhase(val)),
      this.net.subscribe(`rooms/${room}/cams`, (val) => this.onCams(val)),
    );

    this.applyTarget();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---- 初期化ヘルパ ----

  private roleLabel(): string {
    if (!this.myTeam) return '観戦';
    return `チーム${this.myTeam}・${this.amMouse ? '🐭 ネズミ' : '🎥 カメラ監視'}`;
  }

  private spawnPos(): { x: number; z: number } {
    // ネズミは下側の通路にばらけてスポーン
    const i = this.myRole === 'a1' || this.myRole === 'b1' ? -1 : 1;
    return { x: i * 7.5, z: 10.5 };
  }

  private buildTargetMarker(): THREE.Group {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CONFIG.stealRadius - 0.25, CONFIG.stealRadius, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffb300,
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
      new THREE.MeshBasicMaterial({ color: 0xffb300, transparent: true, opacity: 0.35 }),
    );
    beam.position.y = 3;
    g.add(beam);
    return g;
  }

  /** joinedAt最小のプレイヤーがホスト（時間切れのラウンド送りを担当） */
  private isHost(): boolean {
    let host: string | null = null;
    let min = Infinity;
    for (const [pid, p] of Object.entries(this.players)) {
      if (p.joinedAt < min) {
        min = p.joinedAt;
        host = pid;
      }
    }
    return host === this.net.clientId;
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
    switch (ev.type) {
      case 'steal':
        if (ev.round !== this.round) break;
        this.stealCount++;
        if (ev.by === this.net.clientId) this.myCarrying++;
        if (!silent && this.amMouse) {
          this.hud.banner(
            ev.by === this.net.clientId
              ? '盗み成功！出口から持ち出そう！'
              : '仲間が盗みに成功！',
            'info',
          );
        }
        break;
      case 'escape': {
        const team = teamOf(this.players[ev.by]?.role ?? 'none');
        if (team === 'A') this.scoreA++;
        else if (team === 'B') this.scoreB++;
        // リロード時のイベント再生でも所持数が正しく復元されるようにする
        if (ev.by === this.net.clientId && ev.round === this.round) this.myCarrying = 0;
        if (!silent && team) {
          this.hud.banner(
            ev.by === this.net.clientId
              ? '万引き成功！+1ポイント'
              : `チーム${team}が1ポイント獲得！`,
            'info',
          );
        }
        break;
      }
      case 'miss':
        if (ev.round !== this.round) break;
        if (ev.by === this.net.clientId) this.myDoubtsUsed++;
        if (!silent) {
          this.npcFlashUntil[ev.npcIdx] = performance.now() + 1000;
          if (ev.by === this.net.clientId) {
            this.hud.banner(
              `ダウト失敗…NPCだった（残り${this.doubtsLeft()}回）`,
              'alert',
            );
          } else if (this.amCat) {
            this.hud.banner('相方のダウトはNPCだった…', 'info');
          }
        }
        break;
      case 'caught':
        if (!silent) {
          const name = this.players[ev.mouseId]?.name ?? 'ネズミ';
          this.hud.banner(`🚨 ダウト成功！${name} が見破られた！`, 'alert');
        }
        break;
    }
  }

  private publishCams(): void {
    this.net.set(`rooms/${this.room}/cams/${this.net.clientId}`, {
      ids: this.cctv?.onlineIds() ?? [],
    });
  }

  /**
   * 猫たちのオンラインカメラ状態の反映。オンラインのカメラは球体が発光し、
   * その視野内の床が明るくなる（ネズミにも見える＝「みられている」場所の可視化）。
   */
  private onCams(val: unknown): void {
    const all = (val ?? {}) as Record<string, { ids?: number[] }>;
    const active = new Set<number>();
    for (const v of Object.values(all)) {
      for (const id of Object.values(v?.ids ?? {})) active.add(id as number);
    }
    this.world.camBalls.forEach((ball, i) => {
      const on = active.has(i);
      const mat = ball.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(on ? 0xff2222 : 0x000000);
      mat.emissiveIntensity = on ? 1.6 : 0;
      ball.scale.setScalar(on ? 1.35 : 1);
      this.world.camFovMeshes[i].visible = on;
    });
  }

  private onPhase(val: unknown): void {
    const phase = val as PhaseState | null;
    if (!phase) return;
    this.phase = phase;
    if (phase.phase === 'ended' && phase.winner) {
      this.hud.showEnd(
        phase.winner,
        phase.reason ?? '',
        phase.scoreA ?? this.scoreA,
        phase.scoreB ?? this.scoreB,
        () => {
          // 誰でもロビーに戻せる（プロトタイプ）
          this.net.remove(`rooms/${this.room}/events`);
          this.net.remove(`rooms/${this.room}/pos`);
          this.net.remove(`rooms/${this.room}/cams`);
          this.net.set(`rooms/${this.room}/phase`, { phase: 'lobby' } satisfies PhaseState);
        },
      );
    }
  }

  /**
   * ラウンドを終わらせる。前半なら攻守交代して後半へ、後半ならポイント集計で勝敗確定。
   * 時間切れはホスト、ダウト成功は当てた猫が書き込む（楽観的・プロトタイプ想定）。
   */
  private advanceRound(reasonText: string): void {
    if (this.endSent) return;
    if (this.phase.phase !== 'playing' || (this.phase.round ?? 1) !== this.round) return;
    this.endSent = true;
    if (this.round === 1) {
      this.net.remove(`rooms/${this.room}/pos`);
      this.net.set(`rooms/${this.room}/phase`, {
        phase: 'playing',
        round: 2,
        startAt: Date.now() + CONFIG.countdownSec * 1000,
        seed: Math.floor(Math.random() * 2 ** 31),
        note: `${reasonText} — 攻守交代！`,
      } satisfies PhaseState);
    } else {
      const winner = this.scoreA > this.scoreB ? 'A' : this.scoreB > this.scoreA ? 'B' : 'draw';
      this.net.set(`rooms/${this.room}/phase`, {
        ...this.phase,
        phase: 'ended',
        winner,
        reason: reasonText,
        scoreA: this.scoreA,
        scoreB: this.scoreB,
      } satisfies PhaseState);
    }
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
    this.targetMarker.visible = this.amMouse;
    if (this.amMouse) this.hud.setTarget(spot.item);
  }

  // ---- 入力 ----

  private onKey(code: string): void {
    if (code === 'KeyM' && this.camMap) {
      this.camMap.toggle();
      return;
    }
    this.cctv?.handleKey(code);
  }

  private doubtsLeft(): number {
    return Math.max(0, CONFIG.doubtsPerRound - this.myDoubtsUsed);
  }

  /** 猫のダウト: カメラ映像内のキャラクターをクリック → レイキャストで対象を特定 */
  private onCanvasClick = (e: MouseEvent): void => {
    if (!this.cctv || this.phase.phase !== 'playing') return;
    if ((this.phase.round ?? 1) !== this.round) return;
    const t = this.gameTime();
    if (t < 0) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pick = this.cctv.pick(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      this.world.cctvCams,
    );
    if (!pick) return;
    this.raycaster.setFromCamera(pick.ndc, pick.cam);
    const targets: THREE.Object3D[] = [...this.npcMeshes];
    for (const r of this.remotes.values()) if (r.mesh.visible) targets.push(r.mesh);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return;
    if (this.doubtsLeft() <= 0) {
      this.hud.banner('ダウトの残り回数がありません', 'alert');
      return;
    }
    const obj = hits[0].object;
    for (const [pid, r] of this.remotes) {
      if (r.mesh === obj) {
        this.net.push(`rooms/${this.room}/events`, {
          type: 'caught',
          by: this.net.clientId,
          mouseId: pid,
          round: this.round,
          at: Date.now(),
        } satisfies GameEvent);
        const name = this.players[pid]?.name ?? 'ネズミ';
        this.advanceRound(`ダウト成功！${name} を見破った！`);
        return;
      }
    }
    const npcIdx = this.npcMeshes.indexOf(obj as THREE.Mesh);
    if (npcIdx >= 0) {
      this.net.push(`rooms/${this.room}/events`, {
        type: 'miss',
        by: this.net.clientId,
        npcIdx,
        round: this.round,
        at: Date.now(),
      } satisfies GameEvent);
    }
  };

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
    const playing =
      this.phase.phase === 'playing' && (this.phase.round ?? 1) === this.round && t >= 0;

    // 開始前カウントダウン
    if (this.phase.phase === 'playing' && t < 0) {
      this.hud.setCenter(String(Math.ceil(-t)));
    } else {
      this.hud.setCenter('');
    }

    // 自分の移動（実位置=base。表示位置は揺れモーションを足す）
    if (this.myMesh && playing) {
      const mv = this.controls.moveVec();
      if (mv.x !== 0 || mv.z !== 0) {
        this.moveWithCollision(mv.x * CONFIG.mouseSpeed * dt, mv.z * CONFIG.mouseSpeed * dt);
        this.myMesh.rotation.y = Math.atan2(mv.x, mv.z);
      }
    }
    if (this.myMesh) {
      // 盗み中は体をわずかに左右（向きに対して垂直方向）に揺さぶる
      let ox = 0;
      let oz = 0;
      if (playing && this.insideStart !== null) {
        const s = Math.sin(t * CONFIG.swayHz * Math.PI * 2) * CONFIG.swayAmp;
        const ry = this.myMesh.rotation.y;
        ox = Math.cos(ry) * s;
        oz = -Math.sin(ry) * s;
      }
      this.myMesh.position.x = this.baseX + ox;
      this.myMesh.position.z = this.baseZ + oz;
      // 位置送信（スロットリング）。揺れ込みの表示位置を送るのでカメラ側からも揺れが見える
      if (playing && now - this.lastPosSend > 1000 / CONFIG.posSendHz) {
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
        mat.color.setHex(flashing ? 0xff3333 : 0x3b72b0);
      }
    }

    // リモートプレイヤーの補間（出口脱出→再スポーンなどの大きな移動はワープ）
    for (const r of this.remotes.values()) {
      if (!r.target) continue;
      const dist = Math.hypot(r.target.x - r.mesh.position.x, r.target.z - r.mesh.position.z);
      if (dist > 4) {
        r.mesh.position.x = r.target.x;
        r.mesh.position.z = r.target.z;
      } else {
        const k = Math.min(1, dt * 12);
        r.mesh.position.x += (r.target.x - r.mesh.position.x) * k;
        r.mesh.position.z += (r.target.z - r.mesh.position.z) * k;
      }
      r.mesh.rotation.y = r.target.ry;
    }

    // ネズミの盗み判定
    if (playing && this.amMouse && this.myMesh) {
      const spot = this.world.spots[this.currentTargetIdx()];
      const d = Math.hypot(this.baseX - spot.x, this.baseZ - spot.z);
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
            round: this.round,
            at: Date.now(),
          } satisfies GameEvent);
        }
      } else {
        this.insideStart = null;
        this.hud.setProgress(null);
      }
      // 出口判定: 商品を持って出口を通ると1ポイント → カメラの死角にリスポーンして次のお題へ
      if (this.myCarrying > 0 && this.world.isInExitZone(this.baseX, this.baseZ)) {
        this.myCarrying = 0;
        this.net.push(`rooms/${this.room}/events`, {
          type: 'escape',
          by: this.net.clientId,
          round: this.round,
          at: Date.now(),
        } satisfies GameEvent);
        this.baseX = this.world.blindSpawn.x;
        this.baseZ = this.world.blindSpawn.z;
        this.insideStart = null;
      }
    }

    // お題マーカーの明滅
    if (this.targetMarker.visible) {
      const s = 1 + Math.sin(now / 250) * 0.08;
      this.targetMarker.scale.set(s, 1, s);
    }

    // タイマー・スコア・補助情報
    const remain = CONFIG.roundTimeSec - Math.max(0, t);
    this.hud.setTimer(remain);
    this.hud.setScore(this.round, this.scoreA, this.scoreB);
    if (this.amMouse) {
      this.hud.setInfo(`盗み: ${this.stealCount} / 所持: ${this.myCarrying}`);
    } else if (this.amCat) {
      this.hud.setInfo(`ダウト残り: ${this.doubtsLeft()}/${CONFIG.doubtsPerRound}`);
    }

    // 時間切れ → ラウンド送り（通常はホストが書く。ホスト不在に備えて2秒後は誰でも書く）
    if (playing && remain <= 0 && (this.isHost() || remain <= -2)) {
      this.advanceRound(this.round === 1 ? '前半終了！' : '試合終了！');
    }

    // 描画
    if (this.cctv) {
      this.cctv.render(this.renderer, this.scene, this.world.cctvCams);
    } else {
      this.updateFollowCam();
      this.renderer.render(this.scene, this.followCam);
    }
  };

  private moveWithCollision(dx: number, dz: number): void {
    const r = 0.4;
    const b = this.world.bounds;
    const collides = (x: number, z: number) =>
      this.world.obstacles.some(
        (o) => x + r > o.minX && x - r < o.maxX && z + r > o.minZ && z - r < o.maxZ,
      );
    // 軸ごとに判定して壁ずりを可能にする
    let x = this.baseX + dx;
    if (collides(x, this.baseZ)) x = this.baseX;
    let z = this.baseZ + dz;
    if (collides(x, z)) z = this.baseZ;
    this.baseX = Math.min(b.maxX, Math.max(b.minX, x));
    this.baseZ = Math.min(b.maxZ, Math.max(b.minZ, z));
  }

  private updateFollowCam(): void {
    if (this.myMesh) {
      const p = this.myMesh.position;
      this.followCam.position.set(p.x, p.y + 8, p.z + 7);
      this.followCam.lookAt(p.x, 0.5, p.z - 1);
    } else {
      // 観戦者は俯瞰（フロア全体が入る高さ）
      this.followCam.position.set(0, 36, 18);
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
    // 攻守交代・ロビー復帰時に自分のカメラ接続状態を消す（次のラウンドは新しい猫が書く）
    if (this.amCat) this.net.remove(`rooms/${this.room}/cams/${this.net.clientId}`);
    this.controls.dispose();
    this.hud.dispose();
    this.cctv?.dispose();
    this.camMap?.dispose();
    this.renderer.domElement.removeEventListener('click', this.onCanvasClick);
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
