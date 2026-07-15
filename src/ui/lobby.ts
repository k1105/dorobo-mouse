import type { NetAdapter } from '../net';
import type { PhaseState, PlayerInfo, Role } from '../types';
import { ROLE_LABELS } from '../types';
import { CONFIG } from '../config';

const ROLES: Role[] = ['a1', 'a2', 'b1', 'b2'];

/** ロビー画面（部屋への参加・チーム選択・ゲーム開始） */
export class Lobby {
  private root: HTMLDivElement;
  private net: NetAdapter;
  room: string | null = null;
  players: Record<string, PlayerInfo> = {};
  phase: PhaseState = { phase: 'lobby' };
  /** 部屋の状態が変わるたびに呼ばれる（main.tsが画面遷移を判断） */
  onUpdate: ((room: string, players: Record<string, PlayerInfo>, phase: PhaseState) => void) | null =
    null;
  private unsubs: (() => void)[] = [];

  constructor(parent: HTMLElement, net: NetAdapter) {
    this.net = net;
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
    this.renderJoinForm();
  }

  private renderJoinForm(): void {
    const modeLabel =
      this.net.mode === 'firebase'
        ? '🌐 オンライン（Firebase）'
        : '💻 ローカル（同一PCのタブ間のみ・Firebase未設定）';
    this.root.innerHTML = `
      <div class="lobby-panel">
        <h1>🐭 ドロボーマウス 🐱</h1>
        <p class="mode-badge">${modeLabel}</p>
        <p class="lobby-desc">
          2チームに分かれて${CONFIG.roundTimeSec}秒×2ラウンドの攻守戦。<br>
          ネズミ側はNPCに紛れて商品を盗み、出口から持ち出すと商品の値段分を獲得。<br>
          猫側は監視カメラ越しに怪しいネズミをクリックしてダウト。<br>
          盗んだ商品の累計金額が多いチームの勝ち。
        </p>
        <label>名前 <input id="in-name" maxlength="12" placeholder="なまえ" /></label>
        <label>部屋コード <input id="in-room" maxlength="8" placeholder="ABCD" /></label>
        <button class="btn primary" id="btn-join">部屋に入る</button>
      </div>
    `;
    this.root.querySelector<HTMLButtonElement>('#btn-join')!.onclick = () => {
      const name =
        this.root.querySelector<HTMLInputElement>('#in-name')!.value.trim() || 'プレイヤー';
      const room =
        this.root
          .querySelector<HTMLInputElement>('#in-room')!
          .value.trim()
          .toUpperCase() || 'ROOM1';
      this.join(room, name);
    };
  }

  private join(room: string, name: string): void {
    this.room = room;
    const pid = this.net.clientId;
    this.net.set(`rooms/${room}/players/${pid}`, {
      name,
      role: 'none',
      joinedAt: Date.now(),
    } satisfies PlayerInfo);
    this.net.onDisconnectRemove(`rooms/${room}/players/${pid}`);
    this.net.onDisconnectRemove(`rooms/${room}/pos/${pid}`);

    this.unsubs.push(
      this.net.subscribe(`rooms/${room}/players`, (val) => {
        this.players = (val ?? {}) as Record<string, PlayerInfo>;
        this.renderRoom();
        this.onUpdate?.(room, this.players, this.phase);
      }),
      this.net.subscribe(`rooms/${room}/phase`, (val) => {
        this.phase = (val as PhaseState) ?? { phase: 'lobby' };
        this.renderRoom();
        this.onUpdate?.(room, this.players, this.phase);
      }),
    );
  }

  /** joinedAtが最小のプレイヤーがホスト（開始ボタンを持つ） */
  private hostId(): string | null {
    let host: string | null = null;
    let min = Infinity;
    for (const [pid, p] of Object.entries(this.players)) {
      if (p.joinedAt < min) {
        min = p.joinedAt;
        host = pid;
      }
    }
    return host;
  }

  private renderRoom(): void {
    if (!this.room || this.root.classList.contains('hidden')) return;
    const pid = this.net.clientId;
    const me = this.players[pid];
    if (!me) return;
    const isHost = this.hostId() === pid;
    const inGame = this.phase.phase === 'playing';

    const slots = ROLES.map((role) => {
      const owner = Object.entries(this.players).find(([, p]) => p.role === role);
      const mine = owner?.[0] === pid;
      const cls = `role-slot ${role.startsWith('a') ? 'team-a' : 'team-b'} ${
        mine ? 'mine' : ''
      } ${owner && !mine ? 'taken' : ''}`;
      const hint = role.startsWith('a') ? '前半:🐭ネズミ / 後半:🎥猫' : '前半:🎥猫 / 後半:🐭ネズミ';
      return `
        <button class="${cls}" data-role="${role}" ${owner && !mine ? 'disabled' : ''}>
          <span class="role-name">${ROLE_LABELS[role]}</span>
          <span class="role-hint">${hint}</span>
          <span class="role-owner">${owner ? owner[1].name : '空き'}</span>
        </button>
      `;
    }).join('');

    const everyoneHasRole = Object.values(this.players).every((p) => p.role !== 'none');
    const filledCount = Object.values(this.players).filter((p) => p.role !== 'none').length;

    this.root.innerHTML = `
      <div class="lobby-panel wide">
        <h1>部屋: ${this.room}</h1>
        <p class="lobby-desc">チームの枠を選んでください（クリックで選択・変更）</p>
        <div class="role-grid">${slots}</div>
        <p class="lobby-note">
          ${filledCount < 4 ? '⚠️ 4人未満でも開始できます（動作確認用）' : '✅ 全枠が埋まりました'}
        </p>
        ${
          inGame
            ? '<p class="lobby-note">ゲーム進行中です…</p>'
            : isHost
              ? `<button class="btn primary" id="btn-start" ${
                  everyoneHasRole && filledCount > 0 ? '' : 'disabled'
                }>ゲーム開始</button>`
              : '<p class="lobby-note">ホストの開始を待っています…</p>'
        }
        <div class="controls-help">
          <h3>ルールと操作方法</h3>
          <p>⏱ ${CONFIG.roundTimeSec}秒×2ラウンド。前半はチームAがネズミ（攻撃）、チームBが猫（監視カメラ）。後半で攻守交代</p>
          <p>🐭 ネズミ: WASD or 矢印キーで移動。好きな商品棚の近くで「盗む」ボタンを押し、そのまま${CONFIG.stealTimeSec}秒とどまると盗み成功（その間、体が左右に揺れて目立つ！）→ 出口(緑ゲート)から持ち出すと商品の値段分のスコアを獲得。持ち出した後はカメラの死角にリスポーンして何度でも狙える</p>
          <p>🎥 猫: 店内カメラ12台をボタン or 数字キーでオンライン⇔オフライン切替（同時${CONFIG.maxViewCams}台まで）。映像内の怪しいネズミをクリックでダウト（1ラウンド各${CONFIG.doubtsPerRound}回まで）。的中でそのラウンド即終了、NPCなら空振り</p>
          <p>💡 オンラインのカメラは球体が赤く発光し、視野に入っている床が明るくなる（ネズミからも「みられている場所」が分かる）</p>
          <p>🐱 猫: Mキーでカメラマップ（視野と死角の俯瞰図）をモーダル表示</p>
          <p>🏆 2ラウンドで盗んだ商品の累計金額が多いチームの勝ち</p>
        </div>
      </div>
    `;

    this.root.querySelectorAll<HTMLButtonElement>('.role-slot').forEach((b) => {
      b.onclick = () => {
        this.net.set(`rooms/${this.room}/players/${pid}`, {
          ...me,
          role: b.dataset.role as Role,
        } satisfies PlayerInfo);
      };
    });
    this.root.querySelector<HTMLButtonElement>('#btn-start')?.addEventListener('click', () => {
      // 前の試合の残骸を消してから開始
      this.net.remove(`rooms/${this.room}/events`);
      this.net.remove(`rooms/${this.room}/pos`);
      this.net.remove(`rooms/${this.room}/cams`);
      this.net.set(`rooms/${this.room}/phase`, {
        phase: 'playing',
        round: 1,
        startAt: Date.now() + CONFIG.countdownSec * 1000,
        seed: Math.floor(Math.random() * 2 ** 31),
      } satisfies PhaseState);
    });
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.renderRoom();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.root.remove();
  }
}
