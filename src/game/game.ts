import * as THREE from 'three';
import { AVATAR_PALETTE, CONFIG, COLORS } from '../config';
import type { NetAdapter } from '../net';
import type { GameEvent, PhaseState, PlayerInfo, PosMsg, Role, Round, SetResult, Team } from '../types';
import { isMouseInRound, miceTeamOf, setsWon, teamOf } from '../types';
import { mulberry32 } from './rng';
import { Controls } from './controls';
import { CctvView } from './cctv';
import { CamMapView, MiniMapView } from '../ui/map';
import { createNpcSims, NpcSim } from './npc';
import {
  buildWorld,
  CAPSULE_Y,
  LABEL_LAYER,
  makeCapsule,
  makeNameLabel,
  UPPER_LAYER,
  UPPER_LAYER_MIN_Y,
  type MoverPos,
  type Spot,
  type World,
} from './world';
import { getStage, type StageDef } from './stages';

/** カメラマップの画面下端からの余白（style.css の .cam-map の bottom と合わせる） */
const CAM_MAP_BOTTOM_PX = 10;
import { Hud } from '../ui/hud';

/** ステージ紹介のカメラカット（from→to へスイープしながら lookFrom→lookTo を注視する） */
interface IntroShot {
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
}

interface RemoteAvatar {
  mesh: THREE.Mesh;
  target: PosMsg | null;
  /** 補間済みの実位置（揺れオフセットを含まない）。mesh.positionは表示用でこれに揺れを足す */
  sx: number;
  sz: number;
  /** 補間済みの高さ（スロープの昇り降りで段差に見えないように） */
  sy: number;
  /** ダウトされて姿を消す（退場する）までの時刻(performance.now)。この間は再ダウトの対象外 */
  caughtUntil: number;
}

/**
 * 1ラウンド分のゲーム本体。制限時間が経過するとラウンドが終わり、
 * 前半(round=1)はチームAがネズミ、後半(round=2)は攻守交代する。main.tsがラウンドごとに作り直す。
 * ダウト成功ではラウンドは終わらず、見破られたネズミは商品を失ってゲームから退場し、
 * 観戦者と同じ神様目線（店内全体の俯瞰）でラウンド終了まで見守る。
 */
export class Game {
  readonly round: Round;
  /** 現在のセット（1始まり）と総セット数。スコアは同じセットのイベントだけを集計する */
  readonly set: number;
  private sets: number;
  /**
   * 練習モード（攻守交代の着せ替え時間に、後半で猫になる陣営が無人の店内でカメラ操作を試す）。
   * NPC・プレイヤーは出さず、位置・イベントの送受信もしない。着せ替え時間が終わると main.ts が作り直す
   */
  readonly practice: boolean;
  private net: NetAdapter;
  private room: string;
  private myRole: Role;
  private myTeam: Team | null;
  private amMouse: boolean;
  private amCat: boolean;
  private startAt: number;
  private seed: number;
  private stage: StageDef;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private followCam = new THREE.PerspectiveCamera(CONFIG.followFov, 1, 0.1, 200);
  private world: World;
  private controls = new Controls();
  private hud: Hud;
  private cctv: CctvView | null = null;
  private camMap: CamMapView | null = null;
  /** ネズミ用の常時表示ミニマップ（左下）。猫のカメラマップと同じ図に自分の位置を重ねる */
  private miniMap: MiniMapView | null = null;
  private raycaster = new THREE.Raycaster();

  private myMesh: THREE.Mesh | null = null;
  private selfRing: THREE.Mesh | null = null;
  /** 揺れモーション抜きの自分の実位置（移動・判定はこちらを使う）。floor はいるフロア（スロープ上は直前のフロア） */
  private base: MoverPos = { x: 0, z: 0, floor: 0 };
  /** 観戦（退場後・役割なし）の俯瞰で上階を表示するか。Fキーで切替 */
  private spectateUpper = false;
  private remotes = new Map<string, RemoteAvatar>();
  private npcSims: NpcSim[];
  private npcMeshes: THREE.Mesh[] = [];
  private npcFlashUntil: number[] = [];
  /** NPCごとの色（パレットからseedで配色。プレイヤーの着せ替えと同じパレットなので紛れられる） */
  private npcColors: number[] = [];
  /** 前半開始前のステージ紹介（3カット）。後半は攻守交代のみなので無し */
  private introShots: IntroShot[] = [];
  private introCam = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
  private introActive = false;
  /** リザルト表示中（操作UI・マップ・モニタ枠は隠したまま） */
  private showingResult = false;

  private stealCount = 0;
  private myCarrying = 0;
  /** 所持中の商品の合計金額（円）。出口を通るとこの値がスコアに加算される */
  private myCarryingValue = 0;
  private scoreA = 0;
  private scoreB = 0;
  private myDoubtsUsed = 0;
  /** 盗み中のスポットと開始時刻（ゲーム内時間）。nullなら盗んでいない */
  private stealSpot: Spot | null = null;
  private stealStart: number | null = null;
  /**
   * ダウトされたネズミが退場する時刻（ゲーム内時間）。ダウトされた直後は演出のためこの時刻まで
   * その場に（緑色で）見えたまま固まり、その後退場する。nullなら通常状態
   */
  private eliminateAt: number | null = null;
  /** 退場済み（ダウトされた or 商品を持って店外へ脱出した）。自分のアバターは消え、俯瞰で観戦中 */
  private eliminated = false;
  /** 商品を持って店外へ脱出して退場した（eliminated の内訳。HUD表示用） */
  private escaped = false;
  /** このラウンドでダウトされた（退場した）ネズミプレイヤーのID */
  private caughtMice = new Set<string>();
  /** このラウンドで商品を持って店外へ脱出した（退場した）ネズミプレイヤーのID */
  private escapedMice = new Set<string>();
  /** 泥棒全員が退場（ダウト or 脱出）したときに、演出を見せてからラウンドを即終了する時刻（ゲーム内時間） */
  private allOutAt: number | null = null;
  /** 一人称（泥棒目線）カメラモード。ネズミ役のデフォルトで、HUDのボタンで追従カメラとトグル */
  private fpsMode = true;
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
    this.set = phase.set ?? 1;
    this.sets = phase.sets ?? 1;
    this.practice = phase.phase === 'costume';
    this.myRole = players[net.clientId]?.role ?? 'none';
    this.myTeam = teamOf(this.myRole);
    this.amMouse = !this.practice && this.myRole !== 'none' && isMouseInRound(this.myRole, this.round);
    this.amCat = this.myTeam !== null && !this.amMouse;
    this.startAt = phase.startAt ?? Date.now();
    this.seed = phase.seed ?? 1;
    this.stage = getStage(phase.stage);
    // ダウトのレイキャストと追従カメラは上階のレイヤも対象にする（追従カメラは状況に応じて外す）。
    // 名前ラベルは泥棒チームのクライアントだけが見える（猫・観戦には映さない）
    this.raycaster.layers.enableAll();
    this.followCam.layers.enableAll();
    if (this.myTeam !== miceTeamOf(this.round)) this.followCam.layers.disable(LABEL_LAYER);
    this.introCam.layers.enable(UPPER_LAYER);
    if (this.round === 1 && !this.practice) {
      this.introShots = this.buildIntroShots();
      this.introActive = true;
    }

    // レンダラ
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', this.onResize);
    this.onResize();

    // ワールドとNPC
    this.world = buildWorld(this.scene, this.seed, this.stage);
    // 練習モードは無人（NPC・他プレイヤー無し）
    const npcCount = this.practice ? 0 : this.stage.npcCount;
    this.npcSims = createNpcSims(this.seed, npcCount, this.world.nav);
    const colorRng = mulberry32(this.seed ^ 0xc01035);
    for (let i = 0; i < npcCount; i++) {
      const color = AVATAR_PALETTE[Math.floor(colorRng() * AVATAR_PALETTE.length)].hex;
      const mesh = makeCapsule(color);
      this.scene.add(mesh);
      this.npcMeshes.push(mesh);
      this.npcColors.push(color);
      this.npcFlashUntil.push(0);
    }

    // 自分のアバター（このラウンドでネズミの場合のみ。猫はカメラ越しに見るだけで店内にいない）
    if (this.amMouse) {
      this.myMesh = makeCapsule(this.colorOf(net.clientId));
      this.myMesh.add(makeNameLabel(players[net.clientId]?.name ?? ''));
      const spawn = this.spawnPos();
      this.base = { x: spawn.x, z: spawn.z, floor: 0 };
      this.myMesh.position.x = spawn.x;
      this.myMesh.position.z = spawn.z;
      // 初期の向きは店内側(-z)。一人称に切り替えた直後に壁ではなく店内が見えるようにする
      this.myMesh.rotation.y = Math.PI;
      this.scene.add(this.myMesh);
      // デフォルトは一人称（泥棒目線）なので画角も一人称用にしておく
      this.followCam.fov = this.fpsMode ? CONFIG.fpsFov : CONFIG.followFov;
      this.followCam.updateProjectionMatrix();
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
      if (this.practice || pid === net.clientId) continue;
      if (info.role === 'none' || !isMouseInRound(info.role, this.round)) continue;
      const mesh = makeCapsule(this.colorOf(pid));
      mesh.add(makeNameLabel(info.name));
      mesh.visible = false; // 最初の位置情報が来るまで隠す
      this.scene.add(mesh);
      this.remotes.set(pid, { mesh, target: null, sx: 0, sz: 0, sy: 0, caughtUntil: 0 });
    }

    // HUD
    this.hud = new Hud(container, this.roleLabel());
    if (this.amMouse) {
      // 盗みはボタンを押している間だけ進み、離すと中断する
      this.hud.showStealButton(
        () => this.tryStartSteal(),
        () => this.cancelSteal(),
      );
      this.hud.showCamToggle(() => this.toggleFpsMode(), this.fpsMode);
      // 自分の位置が分かるように、猫側と同じマップを左下に常時表示する
      this.miniMap = new MiniMapView(container, this.world.mapData);
    }
    if (this.practice) {
      this.hud.banner(
        `${this.round === 1 ? '前半' : '攻守交代！ 後半'}はあなたが 🎥 カメラ監視。相手の着せ替え時間のあいだ、無人の店内でカメラ操作を練習できます`,
        'info',
      );
    }
    if (phase.note && !this.practice) this.hud.banner(phase.note, 'info');
    if (this.round === 1) {
      this.hud.banner(`${this.sets > 1 ? `第${this.set}セット / ` : ''}ステージ: ${this.stage.name}`, 'info');
    }
    if (this.round === 2 && this.myTeam && !this.practice) {
      this.hud.banner(`後半戦: あなたは${this.amMouse ? '🐭 ネズミ' : '🎥 カメラ監視'}です`, 'info');
    }

    // 猫チームはCCTVビュー（同時オンライン4台まで）と、カメラをクリックでオン/オフする操作マップ（画面中央に常時表示、Mで表示切替）
    if (this.amCat) {
      const cctv = new CctvView(container, this.world.cctvCams.length);
      this.cctv = cctv;
      const camMap = new CamMapView(container, this.world.mapData, (id) => cctv.toggleCam(id));
      this.camMap = camMap;
      this.renderer.domElement.style.cursor = 'crosshair';
      this.renderer.domElement.addEventListener('click', this.onCanvasClick);
      // どのカメラがオンラインかを全クライアントへ共有（球の発光・視野ハイライト用）し、マップにも反映
      const syncCams = () => {
        camMap.setOnline(cctv.onlineIds(), CONFIG.maxViewCams);
        this.publishCams();
      };
      cctv.onChange = syncCams;
      // モニタは画面上端のHUDバーと画面下端のカメラマップの間の中央に並べる
      cctv.getReserved = () => ({
        top: this.hud.topBarBottom(),
        bottom: camMap.panelHeight() + CAM_MAP_BOTTOM_PX,
      });
      cctv.onDeny = () => {
        camMap.deny();
        this.hud.banner(
          `同時にオンラインにできるのは${CONFIG.maxViewCams}台まで。先にどれかをオフにしてください`,
          'alert',
        );
      };
      syncCams();
      this.net.onDisconnectRemove(`rooms/${this.room}/cams/${this.net.clientId}`);
      // ステージ紹介中はモニタ・マップを隠して全画面の映像を見せる
      if (this.introActive) {
        cctv.setVisible(false);
        camMap.setVisible(false);
      }
    }
    if (this.introActive) {
      this.hud.setIntroMode(true);
      this.miniMap?.setVisible(false);
    }

    this.controls.onKey = (code) => this.onKey(code);

    // ネットワーク購読
    this.unsubs.push(
      this.net.subscribe(`rooms/${room}/pos`, (val) => this.onPositions(val)),
      this.net.subscribe(`rooms/${room}/events`, (val) => this.onEvents(val)),
      this.net.subscribe(`rooms/${room}/phase`, (val) => this.onPhase(val)),
      this.net.subscribe(`rooms/${room}/cams`, (val) => this.onCams(val)),
    );

    this.raf = requestAnimationFrame(this.loop);
  }

  // ---- 初期化ヘルパ ----

  /** プレイヤーのカプセル色（着せ替えで選んだ色。未設定ならフォールバック） */
  private colorOf(pid: string): number {
    return this.players[pid]?.color ?? COLORS.mouse;
  }

  /**
   * ステージ紹介の3カット。1: 高い位置から店全体を横切る俯瞰、2: 通路の高さで手前から出口へドリー、
   * 3: 複数フロアならスロープを見上げながら2Fへ、1フロアなら出口ゲート前を横切る
   */
  private buildIntroShots(): IntroShot[] {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const f0 = this.stage.floors[0];
    const r = f0.rect;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    const topY = this.stage.floors[this.stage.floors.length - 1].y;
    const exitX = f0.exit?.x ?? cx;
    const shots: IntroShot[] = [];
    const h1 = Math.max(w, d) * 0.55 + topY;
    shots.push({
      from: v(cx - w * 0.45, h1, cz + d * 0.95),
      to: v(cx + w * 0.45, h1, cz + d * 0.95),
      lookFrom: v(cx, 0, cz),
      lookTo: v(cx, 0, cz),
    });
    shots.push({
      from: v(cx, 2.2, cz + d * 0.42),
      to: v(exitX, 2.2, cz - d * 0.2),
      lookFrom: v(cx, 1.0, cz - d * 0.1),
      lookTo: v(exitX, 1.0, r.minZ),
    });
    const ramp = this.stage.ramps[0];
    if (ramp) {
      const rx = (ramp.rect.minX + ramp.rect.maxX) / 2;
      const rz = (ramp.rect.minZ + ramp.rect.maxZ) / 2;
      const y0 = this.stage.floors[ramp.from].y;
      const y1 = this.stage.floors[ramp.to].y;
      const dir = v(cx - rx, 0, cz - rz).normalize();
      shots.push({
        from: v(rx + dir.x * 11, y0 + 2.5, rz + dir.z * 11),
        to: v(rx + dir.x * 7, y1 + 5, rz + dir.z * 7),
        lookFrom: v(rx, y0 + 1, rz),
        lookTo: v(rx, y1 + 0.5, rz),
      });
    } else {
      shots.push({
        from: v(r.minX + w * 0.2, 5, r.minZ + d * 0.45),
        to: v(r.maxX - w * 0.2, 5, r.minZ + d * 0.45),
        lookFrom: v(exitX, 0.5, r.minZ),
        lookTo: v(exitX, 0.5, r.minZ),
      });
    }
    return shots;
  }

  /** ステージ紹介の進行度 u（0..1）に応じてカメラを動かす */
  private updateIntroCam(u: number): void {
    const n = this.introShots.length;
    const cut = Math.min(n - 1, Math.floor(u * n));
    const k = Math.min(1, Math.max(0, u * n - cut));
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
    const shot = this.introShots[cut];
    this.introCam.position.lerpVectors(shot.from, shot.to, e);
    const look = new THREE.Vector3().lerpVectors(shot.lookFrom, shot.lookTo, e);
    this.introCam.lookAt(look);
  }

  /** ステージ紹介が終わったら通常表示（猫はモニタ・マップ）に戻す */
  private endIntro(): void {
    if (!this.introActive) return;
    this.introActive = false;
    if (this.showingResult) return; // リザルトが先に出ていたらUIは隠したまま
    this.hud.setIntroMode(false);
    this.miniMap?.setVisible(true);
    this.cctv?.setVisible(true);
    this.camMap?.setVisible(true);
    this.cctv?.relayout();
  }

  /** このラウンドで店内にいるネズミプレイヤーの人数 */
  private miceCount(): number {
    return Object.values(this.players).filter(
      (p) => p.role !== 'none' && isMouseInRound(p.role, this.round),
    ).length;
  }

  private roleLabel(): string {
    if (this.practice) return `チーム${this.myTeam}・🎥 カメラ練習`;
    if (!this.myTeam) return '観戦';
    return `チーム${this.myTeam}・${this.amMouse ? '🐭 ネズミ' : '🎥 カメラ監視'}`;
  }

  private spawnPos(): { x: number; z: number } {
    // ネズミは手前側の通路にばらけてスポーン（ステージ定義の2地点）
    const i = this.myRole === 'a1' || this.myRole === 'b1' ? 0 : 1;
    return this.stage.spawns[i];
  }

  /** 複数フロアのステージか */
  private multiFloor(): boolean {
    return this.stage.floors.length > 1;
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
          r.sx = pos.x;
          r.sz = pos.z;
          r.sy = this.world.heightAt(pos.x, pos.z, pos.f ?? 0);
          r.mesh.position.set(pos.x, CAPSULE_Y + r.sy, pos.z);
        }
        // 退場済み（ダウト・脱出）のプレイヤーは非表示（ダウトの対象にもならない）。
        // ダウトで緑色にした後、姿を消したタイミングで元の色に戻す
        r.mesh.visible = !pos.hidden;
        if (pos.hidden) (r.mesh.material as THREE.MeshStandardMaterial).color.setHex(this.colorOf(pid));
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
  }

  private applyEvent(ev: GameEvent, silent: boolean): void {
    // 別のセットのイベントは無視する（イベントは試合を通して残る）
    if ((ev.set ?? 1) !== this.set) return;
    switch (ev.type) {
      case 'steal': {
        if (ev.round !== this.round) break;
        this.stealCount++;
        const item = this.world.spots[ev.spotIdx]?.item;
        if (ev.by === this.net.clientId) {
          this.myCarrying++;
          this.myCarryingValue += item?.price ?? 0;
        }
        if (!silent && this.amMouse) {
          this.hud.banner(
            ev.by === this.net.clientId
              ? `${item ? `「${item.name}」(${item.price}円)を` : ''}盗んだ！出口から持ち出そう！`
              : '仲間が盗みに成功！',
            'info',
          );
        }
        break;
      }
      case 'escape': {
        const team = teamOf(this.players[ev.by]?.role ?? 'none');
        if (team === 'A') this.scoreA += ev.value;
        else if (team === 'B') this.scoreB += ev.value;
        // チキンレース方式: 店外へ出たネズミはそのラウンドには戻れない（退場して観戦）
        if (ev.round === this.round) {
          this.escapedMice.add(ev.by);
          this.checkAllOut(silent);
        }
        // リロード時のイベント再生でも所持数・所持金額が正しく復元されるようにする
        if (ev.by === this.net.clientId && ev.round === this.round) {
          this.myCarrying = 0;
          this.myCarryingValue = 0;
          // 通常は出口判定の時点で退場済み。リロード時のイベント再生では演出なしでここで退場する
          this.escaped = true;
          this.eliminate();
        }
        if (!silent && team) {
          this.hud.banner(
            ev.by === this.net.clientId
              ? `万引き成功！+${ev.value}円`
              : `チーム${team}が${ev.value}円分を獲得！`,
            'info',
          );
          // ダウト成功と同じ全画面演出で万引き成功を大きく見せる
          this.hud.showBigText('万引き成功！', CONFIG.doubtEffectSec * 1000);
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
      case 'caught': {
        if (ev.round !== this.round) break;
        // ダウトは成功しても回数を消費する
        if (ev.by === this.net.clientId) this.myDoubtsUsed++;
        this.caughtMice.add(ev.mouseId);
        this.checkAllOut(silent);
        const isMe = ev.mouseId === this.net.clientId;
        // 見破られたネズミは所持中の商品を失う（リロード時のイベント再生でも復元されるよう silent でも実行）
        if (isMe) {
          this.myCarrying = 0;
          this.myCarryingValue = 0;
        }
        if (silent) {
          // リロード時のイベント再生: 演出なしで即退場
          if (isMe) this.eliminate();
          break;
        }
        const name = this.players[ev.mouseId]?.name ?? 'ネズミ';
        this.hud.banner(
          isMe
            ? `🚨 見破られた！商品を没収され、退場となります`
            : `🚨 ダウト成功！${name} が見破られて退場！`,
          'alert',
        );
        // 全画面演出＋見破られたプレイヤーを緑色にして誰が捕まったか見せる
        this.hud.showBigText('ダウト成功！', CONFIG.doubtEffectSec * 1000);
        const remote = this.remotes.get(ev.mouseId);
        const mesh = isMe ? this.myMesh : remote?.mesh;
        if (mesh) {
          (mesh.material as THREE.MeshStandardMaterial).color.setHex(COLORS.caught);
        }
        if (remote) {
          // 当人が演出後に退場して hidden の位置情報を送ってくるまで、二重ダウトの対象から外す（余裕を持って+3秒）
          remote.caughtUntil = performance.now() + (CONFIG.doubtEffectSec + 3) * 1000;
        }
        if (isMe && this.myMesh) {
          // 演出の間はその場で固まって見えたまま → その後退場（俯瞰の観戦に切り替わる）
          const t = this.gameTime();
          this.eliminateAt = t + CONFIG.doubtEffectSec;
          this.cancelSteal();
        }
        break;
      }
    }
  }

  /**
   * 泥棒全員が退場（ダウト or 脱出）していたら、演出が終わった時点でラウンドを即終了する予約を入れる
   * （後半なら試合終了）
   */
  private checkAllOut(silent: boolean): void {
    if (this.allOutAt !== null || this.miceCount() <= 0) return;
    const out = new Set([...this.caughtMice, ...this.escapedMice]);
    if (out.size < this.miceCount()) return;
    this.allOutAt = silent ? this.gameTime() : this.gameTime() + CONFIG.doubtEffectSec;
  }

  /**
   * ネズミの退場処理（ダウトされた／商品を持って店外へ脱出した）。
   * 自分のアバターを店内から消し（他クライアントには hidden を送る）、
   * ネズミ用のUIを片付けて、ゲーム途中参加の観戦者と同じ神様目線（店内全体の俯瞰）に切り替える。
   */
  private eliminate(): void {
    if (!this.myMesh || this.eliminated) return;
    this.eliminated = true;
    this.eliminateAt = null;
    this.cancelSteal();
    // 最後の位置情報として hidden を送り、他クライアントから姿を消す（以降は送信しない）
    this.net.set(`rooms/${this.room}/pos/${this.net.clientId}`, {
      x: this.base.x,
      z: this.base.z,
      f: this.base.floor,
      ry: this.myMesh.rotation.y,
      t: Date.now(),
      hidden: true,
      sway: false,
    } satisfies PosMsg);
    for (const mesh of [this.myMesh, this.selfRing]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.traverse(disposeObject);
    }
    this.myMesh = null;
    this.selfRing = null;
    this.miniMap?.dispose();
    this.miniMap = null;
    // 一人称だった場合は俯瞰用の画角に戻す
    this.fpsMode = false;
    this.followCam.fov = CONFIG.followFov;
    this.followCam.updateProjectionMatrix();
    this.hud.hideMouseControls();
    this.hud.setRole(`チーム${this.myTeam}・${this.escaped ? '🏃 脱出成功（観戦）' : '👻 退場（観戦）'}`);
  }

  /** 観戦（退場後・役割なし）の俯瞰で表示するフロアの説明 */
  private spectateInfo(): string {
    if (!this.multiFloor()) return '';
    return ` / 俯瞰: ${this.spectateUpper ? '2F' : '1F'}（Fキーで切替）`;
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
    // 自分以外の猫がオンラインにしているカメラ（カメラマップに「相方が見ている場所」として表示）
    const others = new Set<number>();
    for (const [pid, v] of Object.entries(all)) {
      for (const id of Object.values(v?.ids ?? {})) {
        active.add(id as number);
        if (pid !== this.net.clientId) others.add(id as number);
      }
    }
    this.camMap?.setOthers(others);
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
    if ((phase.phase === 'ended' || phase.phase === 'setEnd') && phase.winner) {
      // リザルト演出の邪魔になる操作UI・マップ・モニタ枠を隠す
      this.showingResult = true;
      this.hud.setIntroMode(true);
      this.miniMap?.setVisible(false);
      this.cctv?.setVisible(false);
      this.camMap?.setVisible(false);
      const results = phase.results ?? [];
      const tally = setsWon(results);
      if (phase.phase === 'setEnd') {
        // セット終了: このセットのスコアと、ここまでのセット数。次のセットへは main.ts が until で進める
        const nextStage = getStage(phase.stages?.[(phase.set ?? 1)] ?? phase.stage);
        this.hud.showEnd({
          heading: `第${phase.set ?? 1}セット終了`,
          winner: phase.winner,
          scoreA: phase.scoreA ?? this.scoreA,
          scoreB: phase.scoreB ?? this.scoreB,
          reason: phase.reason ?? '',
          tally,
          totalSets: phase.sets ?? 1,
          next: `次は第${(phase.set ?? 1) + 1}セット（ステージ: ${nextStage.name}）。まもなく準備時間に入ります`,
        });
      } else {
        // 試合終了: 最終成績（セット数）と各セットのスコア
        this.hud.showEnd({
          heading: '試合終了',
          winner: phase.winner,
          scoreA: phase.scoreA ?? this.scoreA,
          scoreB: phase.scoreB ?? this.scoreB,
          reason: phase.reason ?? '',
          tally,
          totalSets: phase.sets ?? 1,
          results,
          final: true,
          onLobby: () => {
            // 誰でもロビーに戻せる（プロトタイプ）
            this.net.remove(`rooms/${this.room}/events`);
            this.net.remove(`rooms/${this.room}/pos`);
            this.net.remove(`rooms/${this.room}/cams`);
            this.net.set(`rooms/${this.room}/phase`, { phase: 'lobby' } satisfies PhaseState);
          },
        });
      }
    }
  }

  /**
   * ラウンドを終わらせる。前半なら攻守交代して後半へ、後半ならポイント集計で勝敗確定。
   * 時間切れ、または泥棒全員ダウトで呼ばれ、通常はホストが書き込む（楽観的・プロトタイプ想定）。
   */
  private advanceRound(reasonText: string): void {
    if (this.endSent) return;
    if (this.phase.phase !== 'playing' || (this.phase.round ?? 1) !== this.round) return;
    this.endSent = true;
    // セット構成は phase から持ち回る（Firebase は undefined を拒否するので未定義は入れない）
    const carry: PhaseState = { phase: 'playing', set: this.set, sets: this.sets, stage: this.stage.id };
    if (this.phase.stages) carry.stages = this.phase.stages;
    if (this.phase.results) carry.results = this.phase.results;
    if (this.round === 1) {
      // 攻守交代: 後半の前に着せ替え・作戦会議の時間を挟む（後半の開始は main.ts が until で書く）
      this.net.remove(`rooms/${this.room}/pos`);
      this.net.set(`rooms/${this.room}/phase`, {
        ...carry,
        phase: 'costume',
        round: 2,
        until: Date.now() + CONFIG.costumeSec * 1000,
        note: `${reasonText} — 攻守交代！`,
      } satisfies PhaseState);
      return;
    }
    // セット終了。結果を積み、最終セットなら試合終了（獲得セット数で勝敗。同数なら合計金額、それも同じなら引き分け）
    const result: SetResult = { scoreA: this.scoreA, scoreB: this.scoreB };
    const results = [...(this.phase.results ?? []), result];
    const setWinner = this.scoreA > this.scoreB ? 'A' : this.scoreB > this.scoreA ? 'B' : 'draw';
    if (this.set < this.sets) {
      this.net.set(`rooms/${this.room}/phase`, {
        ...carry,
        phase: 'setEnd',
        round: 2,
        results,
        until: Date.now() + CONFIG.setEndSec * 1000,
        winner: setWinner,
        reason: reasonText.replace('試合終了', '後半終了'),
        scoreA: this.scoreA,
        scoreB: this.scoreB,
      } satisfies PhaseState);
      return;
    }
    const tally = setsWon(results);
    const totalA = results.reduce((n, r) => n + r.scoreA, 0);
    const totalB = results.reduce((n, r) => n + r.scoreB, 0);
    const winner =
      tally.a > tally.b ? 'A' : tally.b > tally.a ? 'B' : totalA > totalB ? 'A' : totalB > totalA ? 'B' : 'draw';
    this.net.set(`rooms/${this.room}/phase`, {
      ...carry,
      phase: 'ended',
      round: 2,
      results,
      winner,
      reason:
        this.sets > 1
          ? tally.a === tally.b
            ? `セット数 ${tally.a} - ${tally.b}。合計金額で決着`
            : `セット数 ${tally.a} - ${tally.b}`
          : reasonText,
      scoreA: totalA,
      scoreB: totalB,
    } satisfies PhaseState);
  }

  // ---- 盗み ----

  /** 盗むボタンを押した: 一番近い商品棚スポットが判定半径内にあれば盗みを開始する（離すと cancelSteal） */
  private tryStartSteal(): void {
    if (!this.amMouse || !this.myMesh || this.stealStart !== null) return;
    if (this.eliminateAt !== null) return;
    if (this.phase.phase !== 'playing' || (this.phase.round ?? 1) !== this.round) return;
    const t = this.gameTime();
    if (t < 0) return;
    let best: Spot | null = null;
    let bestD: number = CONFIG.stealRadius;
    for (const s of this.world.spots) {
      if (s.floor !== this.base.floor) continue; // 別のフロアの棚は盗めない
      const d = Math.hypot(this.base.x - s.x, this.base.z - s.z);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) {
      this.hud.banner('商品棚の近くでないと盗めません', 'alert');
      return;
    }
    this.stealSpot = best;
    this.stealStart = t;
    this.hud.setStealActive(true);
  }

  /** 盗みの中断・完了処理（進捗バーとボタン状態を戻す） */
  /** 盗みの中断（ボタンを離した・棚から離れた・成立した・ダウトされた 等） */
  private cancelSteal(): void {
    this.stealSpot = null;
    this.stealStart = null;
    this.hud.setProgress(null);
    this.hud.setStealActive(false);
    this.hud.releaseStealButton();
  }

  // ---- 入力 ----

  private onKey(code: string): void {
    if (code === 'KeyM' && this.camMap) {
      this.camMap.toggle();
      // マップの表示/非表示でモニタを置ける帯の高さが変わる
      this.cctv?.relayout();
      return;
    }
    if (code === 'KeyF' && !this.myMesh && !this.amCat && this.multiFloor()) {
      // 観戦の俯瞰: 1F ⇔ 2F（上階の床板を表示するか）
      this.spectateUpper = !this.spectateUpper;
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
    // すでに見破られて消えるのを待っているネズミは対象外（二重ダウト防止）
    const now = performance.now();
    for (const r of this.remotes.values()) {
      if (r.mesh.visible && now >= r.caughtUntil) targets.push(r.mesh);
    }
    // 鼻や耳などのパーツをクリックしても当たるように子も含めて判定し、本体（targets の要素）に戻す
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return;
    if (this.doubtsLeft() <= 0) {
      this.hud.banner('ダウトの残り回数がありません', 'alert');
      return;
    }
    let obj: THREE.Object3D = hits[0].object;
    while (obj.parent && !targets.includes(obj)) obj = obj.parent;
    for (const [pid, r] of this.remotes) {
      if (r.mesh === obj) {
        this.net.push(`rooms/${this.room}/events`, {
          type: 'caught',
          by: this.net.clientId,
          mouseId: pid,
          round: this.round,
          set: this.set,
          at: Date.now(),
        } satisfies GameEvent);
        // ラウンドは終わらない。見破られたネズミ側が caught イベントを受けて退場する
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
        set: this.set,
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

    // ダウト演出中に見えたまま固まる時間。過ぎたら退場（アバターが消えて俯瞰の観戦に切り替わる）
    if (this.myMesh && this.eliminateAt !== null && t >= this.eliminateAt) {
      this.eliminate();
    }
    // 開始前: ステージ紹介（前半のみ）→ 3/2/1 カウントダウン
    const inIntro = this.introActive && t < -CONFIG.countdownSec;
    if (this.introActive && !inIntro) this.endIntro();
    if (inIntro) {
      this.hud.setCenter('');
    } else if (this.phase.phase === 'playing' && t < 0) {
      this.hud.setCenter(String(Math.ceil(-t)));
    } else {
      this.hud.setCenter('');
    }

    // 自分の移動（実位置=base。表示位置は揺れモーションを足す）。ダウト演出中は動けない
    if (this.myMesh && playing && this.eliminateAt === null) {
      if (this.fpsMode) {
        // 一人称: A/D・左右で向きを回し、W/S・上下で向いている方向へ前進/後退
        const inp = this.controls.fpsInput();
        // 前方ベクトルは(sin(ry), cos(ry))なので、ryを増やすと左旋回になる
        this.myMesh.rotation.y -= inp.turn * CONFIG.fpsTurnSpeed * dt;
        if (inp.forward !== 0) {
          const fx = Math.sin(this.myMesh.rotation.y);
          const fz = Math.cos(this.myMesh.rotation.y);
          const step = inp.forward * CONFIG.mouseSpeed * dt;
          this.moveWithCollision(fx * step, fz * step);
        }
      } else {
        const mv = this.controls.moveVec();
        if (mv.x !== 0 || mv.z !== 0) {
          this.moveWithCollision(mv.x * CONFIG.mouseSpeed * dt, mv.z * CONFIG.mouseSpeed * dt);
          this.myMesh.rotation.y = Math.atan2(mv.x, mv.z);
        }
      }
    }
    if (this.myMesh) {
      // 盗み中は体を小さな円を描くように揺さぶる（一方向の往復だとカメラの視線と揺れの軸が
      // 一致したとき奥行き方向の動きになって見えないため、XZ両軸に動かす）
      const swaying = playing && this.stealStart !== null;
      let ox = 0;
      let oz = 0;
      if (swaying) {
        const phase = t * CONFIG.swayHz * Math.PI * 2;
        ox = Math.cos(phase) * CONFIG.swayAmp;
        oz = Math.sin(phase) * CONFIG.swayAmp;
      }
      this.myMesh.position.x = this.base.x + ox;
      this.myMesh.position.z = this.base.z + oz;
      this.myMesh.position.y = CAPSULE_Y + this.world.heightAt(this.base.x, this.base.z, this.base.floor);
      // 位置送信（スロットリング）。揺れは低頻度送信+補間で潰れるため位置には含めず、
      // swayフラグを送って受信側にローカルで再生させる
      if (playing && now - this.lastPosSend > 1000 / CONFIG.posSendHz) {
        this.lastPosSend = now;
        this.net.set(`rooms/${this.room}/pos/${this.net.clientId}`, {
          x: this.base.x,
          z: this.base.z,
          f: this.base.floor,
          ry: this.myMesh.rotation.y,
          t: Date.now(),
          hidden: false,
          sway: swaying,
        } satisfies PosMsg);
      }
    }
    if (this.myMesh) {
      // 一人称モード中は自分のカプセルが視界を塞ぐので隠す
      const visible = !this.fpsMode;
      this.myMesh.visible = visible;
      if (this.selfRing) {
        this.selfRing.visible = visible;
        this.selfRing.position.x = this.myMesh.position.x;
        this.selfRing.position.z = this.myMesh.position.z;
        this.selfRing.position.y = this.myMesh.position.y - CAPSULE_Y + 0.05;
      }
      this.miniMap?.update(
        this.base.x,
        this.base.z,
        this.myMesh.rotation.y,
        false,
        this.base.floor,
      );
    }

    // NPC（カウントダウン中は開始時点の配置で立たせておく）
    {
      const nt = Math.max(0, t);
      for (let i = 0; i < this.npcSims.length; i++) {
        const p = this.npcSims[i].posAt(nt);
        const mesh = this.npcMeshes[i];
        const y = this.world.heightAt(p.x, p.z, p.layer);
        mesh.position.set(p.x, CAPSULE_Y + y, p.z);
        mesh.rotation.y = p.ry;
        this.assignLayer(mesh, y);
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const flashing = now < this.npcFlashUntil[i];
        mat.color.setHex(flashing ? 0xff3333 : this.npcColors[i]);
      }
    }

    // リモートプレイヤーの補間（出口脱出→再スポーンなどの大きな移動はワープ）
    for (const r of this.remotes.values()) {
      if (!r.target) continue;
      const dist = Math.hypot(r.target.x - r.sx, r.target.z - r.sz);
      if (dist > 4) {
        r.sx = r.target.x;
        r.sz = r.target.z;
      } else {
        const k = Math.min(1, dt * 12);
        r.sx += (r.target.x - r.sx) * k;
        r.sz += (r.target.z - r.sz) * k;
      }
      // 盗みモーションは補間位置に対してローカルで再生する（自分の表示と同じ円運動）
      let rox = 0;
      let roz = 0;
      if (r.target.sway) {
        const phase = t * CONFIG.swayHz * Math.PI * 2;
        rox = Math.cos(phase) * CONFIG.swayAmp;
        roz = Math.sin(phase) * CONFIG.swayAmp;
      }
      const ty = this.world.heightAt(r.sx, r.sz, r.target.f ?? 0);
      r.sy = dist > 4 ? ty : r.sy + (ty - r.sy) * Math.min(1, dt * 12);
      r.mesh.position.set(r.sx + rox, CAPSULE_Y + r.sy, r.sz + roz);
      r.mesh.rotation.y = r.target.ry;
      this.assignLayer(r.mesh, r.sy);
    }

    // ネズミの盗み判定（盗むボタンで開始し、スポットの判定半径内に居続けると成立）
    if (playing && this.amMouse && this.myMesh) {
      if (this.stealSpot && this.stealStart !== null) {
        const d = Math.hypot(this.base.x - this.stealSpot.x, this.base.z - this.stealSpot.z);
        if (d > CONFIG.stealRadius || this.stealSpot.floor !== this.base.floor) {
          // 棚から離れたら中断
          this.cancelSteal();
        } else {
          const p = (t - this.stealStart) / CONFIG.stealTimeSec;
          this.hud.setProgress(p);
          if (p >= 1) {
            const spotIdx = this.stealSpot.idx;
            this.cancelSteal();
            this.net.push(`rooms/${this.room}/events`, {
              type: 'steal',
              by: this.net.clientId,
              spotIdx,
              round: this.round,
              set: this.set,
              at: Date.now(),
            } satisfies GameEvent);
          }
        }
      }
      // 出口判定: 商品を持って出口を通ると所持金額分のポイント。
      // チキンレース方式: 店外へ出たらそのラウンドには戻れず、退場して観戦になる
      if (
        !this.eliminated &&
        this.myCarrying > 0 &&
        this.world.isInExitZone(this.base.x, this.base.z, this.base.floor)
      ) {
        const value = this.myCarryingValue;
        this.myCarrying = 0;
        this.myCarryingValue = 0;
        this.net.push(`rooms/${this.room}/events`, {
          type: 'escape',
          by: this.net.clientId,
          value,
          round: this.round,
          set: this.set,
          at: Date.now(),
        } satisfies GameEvent);
        this.escaped = true;
        this.eliminate();
      }
    } else if (this.stealStart !== null) {
      // ラウンド終了・開始前カウントダウン中は盗みを中断する
      this.cancelSteal();
    }

    // タイマー・スコア・補助情報（練習モードは着せ替え時間の残りを出す）
    const remain = this.practice
      ? ((this.phase.until ?? Date.now()) - Date.now()) / 1000
      : CONFIG.roundTimeSec - Math.max(0, t);
    this.hud.setTimer(remain);
    this.hud.setScore(this.round, this.scoreA, this.scoreB, this.sets > 1 ? `第${this.set}/${this.sets}セット` : '');
    if (this.practice) {
      this.hud.setInfo(`無人の店内で練習中（${this.round === 1 ? '前半' : '後半'}開始まで）`);
    } else if (this.amMouse && this.eliminated) {
      this.hud.setInfo(`${this.escaped ? '脱出済み（観戦）' : '退場中（観戦）'} / チームの盗み: ${this.stealCount}${this.spectateInfo()}`);
    } else if (this.amMouse) {
      const floorLabel = this.multiFloor() ? `${this.stage.floors[this.base.floor].name} / ` : '';
      this.hud.setInfo(`${floorLabel}盗み: ${this.stealCount} / 所持: ${this.myCarrying}個 (${this.myCarryingValue}円)`);
    } else if (this.amCat) {
      this.hud.setInfo(`ダウト残り: ${this.doubtsLeft()}/${CONFIG.doubtsPerRound}`);
    } else {
      this.hud.setInfo(`観戦${this.spectateInfo()}`);
    }

    // 時間切れ → ラウンド送り（通常はホストが書く。ホスト不在に備えて2秒後は誰でも書く）
    if (playing && remain <= 0 && (this.isHost() || remain <= -2)) {
      this.advanceRound(this.round === 1 ? '前半終了！' : '試合終了！');
    }
    // 泥棒全員が退場（ダウト or 脱出）→ 時間を待たずにラウンド即終了（前半なら攻守交代、後半なら試合終了）
    if (
      playing &&
      this.allOutAt !== null &&
      t >= this.allOutAt &&
      (this.isHost() || t >= this.allOutAt + 2)
    ) {
      const why =
        this.escapedMice.size === 0
          ? '泥棒全員ダウト！'
          : this.caughtMice.size === 0
            ? '泥棒全員脱出！'
            : '泥棒全員退場！';
      this.advanceRound(why + (this.round === 1 ? '前半終了！' : '試合終了！'));
    }

    // 描画
    if (inIntro) {
      const u = (t + CONFIG.countdownSec + CONFIG.introSec) / CONFIG.introSec;
      this.updateIntroCam(Math.min(1, Math.max(0, u)));
      this.renderer.render(this.scene, this.introCam);
    } else if (this.cctv) {
      this.cctv.render(this.renderer, this.scene, this.world.cctvCams);
    } else {
      this.updateFollowCam();
      this.renderer.render(this.scene, this.followCam);
    }
  };

  private moveWithCollision(dx: number, dz: number): void {
    // 棚・壁との衝突とスロープでのフロア移動はワールド側で処理する
    this.world.move(this.base, dx, dz);
  }

  /**
   * 動くもの（NPC・他プレイヤー）を高さに応じて上階レイヤに入れる。
   * 1Fにいるネズミの追従カメラでは上階レイヤを描かないので、2Fの相手は床板ごと隠れる
   */
  private assignLayer(mesh: THREE.Mesh, y: number): void {
    if (!this.multiFloor()) return;
    const layer = y >= UPPER_LAYER_MIN_Y ? UPPER_LAYER : 0;
    mesh.layers.set(layer);
    // 鼻や耳などのパーツも本体と同じレイヤに入れる（名前ラベルは専用レイヤのまま）
    for (const c of mesh.children) {
      if (c instanceof THREE.Mesh) c.layers.set(layer);
    }
  }

  /** 視点切替ボタン: 追従カメラ ⇔ 一人称（泥棒目線） */
  private toggleFpsMode(): void {
    if (!this.myMesh) return;
    this.fpsMode = !this.fpsMode;
    this.followCam.fov = this.fpsMode ? CONFIG.fpsFov : CONFIG.followFov;
    this.followCam.updateProjectionMatrix();
    this.hud.setCamMode(this.fpsMode);
  }

  private updateFollowCam(): void {
    const { x, z, floor } = this.base;
    const groundY = this.world.heightAt(x, z, floor);
    if (this.myMesh && this.fpsMode) {
      // 一人称: 目の高さから自分の向き（A/Dで回す）を見る。上階の床板も見える
      this.followCam.layers.enable(UPPER_LAYER);
      const dx = Math.sin(this.myMesh.rotation.y);
      const dz = Math.cos(this.myMesh.rotation.y);
      // 揺れモーション込みの表示位置ではなく実位置(base)に置く（カメラまで揺れると画面酔いするため）
      const eye = groundY + CONFIG.fpsEyeHeight;
      this.followCam.position.set(x, eye, z);
      this.followCam.lookAt(x + dx, eye - 0.15, z + dz);
    } else if (this.myMesh) {
      // 揺れモーション込みの表示位置ではなく実位置(base)を追従する（カメラまで揺れると画面酔いするため）。
      // 1F（上階の床板の下）にいるときは上階レイヤを描かない
      const upper = groundY >= UPPER_LAYER_MIN_Y;
      if (upper) this.followCam.layers.enable(UPPER_LAYER);
      else this.followCam.layers.disable(UPPER_LAYER);
      this.followCam.position.set(x, groundY + CAPSULE_Y + 8, z + 7);
      this.followCam.lookAt(x, groundY + 0.5, z - 1);
    } else {
      // 観戦者・退場したネズミは俯瞰（フロア全体が入る高さ）。複数フロアではFキーで表示フロアを切替
      if (this.spectateUpper) this.followCam.layers.enable(UPPER_LAYER);
      else this.followCam.layers.disable(UPPER_LAYER);
      const rect = this.stage.floors[0].rect;
      const cx = (rect.minX + rect.maxX) / 2;
      const cz = (rect.minZ + rect.maxZ) / 2;
      const k = Math.max((rect.maxX - rect.minX) / 42, (rect.maxZ - rect.minZ) / 28);
      this.followCam.position.set(cx, 36 * k, cz + 18 * k);
      this.followCam.lookAt(cx, 0, cz);
    }
  }

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.followCam.aspect = w / h;
    this.followCam.updateProjectionMatrix();
    this.introCam.aspect = w / h;
    this.introCam.updateProjectionMatrix();
    this.cctv?.relayout();
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
    this.miniMap?.dispose();
    this.renderer.domElement.removeEventListener('click', this.onCanvasClick);
    window.removeEventListener('resize', this.onResize);
    this.scene.traverse(disposeObject);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** メッシュ・スプライトのGPU資源を解放する（scene.traverse / Object3D.traverse 用） */
function disposeObject(obj: THREE.Object3D): void {
  if (obj instanceof THREE.Mesh) {
    obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) m.dispose();
  } else if (obj instanceof THREE.Sprite) {
    obj.material.map?.dispose();
    obj.material.dispose();
  }
}
