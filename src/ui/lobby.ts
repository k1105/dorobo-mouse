import type { NetAdapter } from '../net';
import type { MatchConfig, PhaseState, PlayerInfo, Role, Team } from '../types';
import { isMouseInRound, isStalePhase, rolesOfTeam, TEAM_LABELS, teamOf } from '../types';
import { AVATAR_PALETTE, CONFIG } from '../config';
import { DEFAULT_STAGE_ID, getStage, STAGES } from '../game/stages';
import { loadStages, registerCustomStage, validateStage, type CustomStageData } from '../game/customStage';
import { CostumePreview, type CostumeMember } from './costume';
import { TitleBackdrop } from './titlebg';

type Screen = 'title' | 'name' | 'rooms' | 'room';

const LS_NAME = 'dorobo-name';
const LS_COLOR = 'dorobo-color';

/** アクティブなルーム一覧（roomIndex/r_{code}/{pid} = 名前。切断時に自動削除） */
type RoomIndex = Record<string, Record<string, string>>;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * ロビー。タイトル → 名前入力 → ルーム一覧/新設 → ルーム（陣営選択・着せ替え・ステージ選択・開始）。
 * 攻守交代時（phase=costume）は泥棒陣営に着せ替え・作戦会議の画面を出す（猫陣営はゲーム側で練習モード）。
 */
export class Lobby {
  private root: HTMLDivElement;
  private net: NetAdapter;
  private screen: Screen = 'title';
  private name = '';
  private color: number = AVATAR_PALETTE[0].hex;
  room: string | null = null;
  players: Record<string, PlayerInfo> = {};
  phase: PhaseState = { phase: 'lobby' };
  /** 試合構成（セット数とセットごとのステージ。rooms/{room}/match。ルーム作成時にホストが決める） */
  match: MatchConfig = { sets: 1, stages: [DEFAULT_STAGE_ID] };
  /** 部屋の状態が変わるたびに呼ばれる（main.tsが画面遷移を判断） */
  onUpdate: ((room: string, players: Record<string, PlayerInfo>, phase: PhaseState) => void) | null =
    null;
  /** タイトルの「ステージエディタ」が押されたときに呼ばれる（main.tsがエディタを開く） */
  onOpenEditor: (() => void) | null = null;
  private unsubs: (() => void)[] = [];
  private roomIndex: RoomIndex = {};
  private unsubRoomIndex: (() => void) | null = null;
  private preview: CostumePreview | null = null;
  private backdrop: TitleBackdrop | null = null;
  /** ルーム作成時に決める試合構成（入室後は変更しない） */
  private createSets = 1;
  private createStages: string[] = [DEFAULT_STAGE_ID];
  /** ルーム作成で選べる自作ステージ（このブラウザに保存されていて、遊べる状態のもの） */
  private customStages: CustomStageData[] = [];
  /**
   * 試合構成（match）を受信済みか。自作ステージのデータは match に入っているので、
   * 届く前にゲームを始めると別のステージで作られてしまう。届くまで onUpdate を呼ばない
   */
  private matchLoaded = false;
  private timerId = 0;

  constructor(parent: HTMLElement, net: NetAdapter) {
    this.net = net;
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
    try {
      this.name = localStorage.getItem(LS_NAME) ?? '';
      const c = Number(localStorage.getItem(LS_COLOR));
      if (AVATAR_PALETTE.some((p) => p.hex === c)) this.color = c;
    } catch {
      // localStorage が使えない環境ではデフォルトのまま
    }
    this.render();
  }

  // ---- 画面遷移 ----

  private go(screen: Screen): void {
    if (this.screen === 'rooms' && screen !== 'rooms') this.unwatchRooms();
    if (screen !== 'title') this.destroyBackdrop();
    this.screen = screen;
    if (screen === 'rooms') this.watchRooms();
    this.render();
  }

  private render(): void {
    if (this.root.classList.contains('hidden')) return;
    if (this.screen === 'title') this.renderTitle();
    else if (this.screen === 'name') this.renderName();
    else if (this.screen === 'rooms') this.renderRooms();
    else if (this.phase.phase === 'costume' && !isStalePhase(this.phase)) this.renderCostumePhase();
    else this.renderRoom();
  }

  private modeLabel(): string {
    return this.net.mode === 'firebase'
      ? '🌐 オンライン（Firebase）'
      : '💻 ローカル（同一PCのタブ間のみ・Firebase未設定）';
  }

  private renderTitle(): void {
    this.destroyPreview();
    this.root.innerHTML = `
      <div class="scr scr-title">
        <div class="title-center">
          <p class="title-kicker">猫が経営するスーパーで、群衆に紛れて万引きする 2 vs 2</p>
          <h1 class="title-logo">🐭 ドロボーマウス 🐱</h1>
          <button class="btn big" id="btn-title-start">スタート</button>
          <button class="btn title-editor" id="btn-title-editor">🛠 ステージエディタ</button>
        </div>
        <span class="mode-badge title-mode">${this.modeLabel()}</span>
      </div>
    `;
    if (!this.backdrop) this.backdrop = new TitleBackdrop();
    this.root.querySelector('.scr-title')!.prepend(this.backdrop.el);
    this.root.querySelector<HTMLButtonElement>('#btn-title-start')!.onclick = () => this.go('name');
    this.root.querySelector<HTMLButtonElement>('#btn-title-editor')!.onclick = () => this.onOpenEditor?.();
  }

  private destroyBackdrop(): void {
    this.backdrop?.dispose();
    this.backdrop = null;
  }

  private renderName(): void {
    this.destroyPreview();
    this.root.innerHTML = `
      <div class="scr scr-name">
        <div class="name-box">
          <h1>名前を入力</h1>
          <p class="lobby-note dim">ゲーム中、仲間のカプセルの頭上にこの名前が出ます（12文字まで）</p>
          <label>名前 <input id="in-name" maxlength="12" placeholder="なまえ" value="${esc(this.name)}" /></label>
          <div class="btn-row">
            <button class="btn" id="btn-back">戻る</button>
            <button class="btn big" id="btn-next">次へ</button>
          </div>
        </div>
      </div>
    `;
    const input = this.root.querySelector<HTMLInputElement>('#in-name')!;
    input.focus();
    const next = () => {
      this.name = input.value.trim() || 'プレイヤー';
      try {
        localStorage.setItem(LS_NAME, this.name);
      } catch {
        // 保存できなくても続行
      }
      this.go('rooms');
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') next();
    };
    this.root.querySelector<HTMLButtonElement>('#btn-next')!.onclick = next;
    this.root.querySelector<HTMLButtonElement>('#btn-back')!.onclick = () => this.go('title');
  }

  // ---- ルーム一覧 ----

  private watchRooms(): void {
    this.unsubRoomIndex = this.net.subscribe('roomIndex', (val) => {
      this.roomIndex = (val ?? {}) as RoomIndex;
      if (this.screen === 'rooms') this.renderRoomList();
    });
  }

  private unwatchRooms(): void {
    this.unsubRoomIndex?.();
    this.unsubRoomIndex = null;
  }

  private renderRooms(): void {
    this.destroyPreview();
    // エディタで作り直されている・消されていることがあるので、表示のたびに読み直す
    this.customStages = loadStages().filter((s) => validateStage(s).errors.length === 0);
    const known = new Set([...STAGES.map((s) => s.id), ...this.customStages.map((s) => s.id)]);
    this.createStages = this.createStages.map((id) => (known.has(id) ? id : DEFAULT_STAGE_ID));
    this.root.innerHTML = `
      <div class="scr">
        <div class="scr-head">
          <h1>ルームを選ぶ</h1>
          <span class="crumb"><b>${esc(this.name)}</b> として参加 <button class="link-btn" id="btn-back">名前を変える</button></span>
        </div>
        <div class="panel rooms-panel">
          <h3 class="section-title">いま開いているルーム <small>クリックで参加</small></h3>
          <div class="room-list" id="room-list"></div>
        </div>
        <button class="fab" id="btn-open-create">＋ ルームを新規作成</button>
        <div class="modal-backdrop hidden" id="create-modal">
          <div class="modal">
            <h2>ルームを新規作成</h2>
            <p class="lobby-note dim">番号を決めて仲間に伝えてください。ステージは作った人が決めます</p>
            <label>ルーム番号 <input id="in-room" maxlength="8" placeholder="例: 1234" /></label>
            <h3 class="section-title">セット数 <small>1セット = 前半・後半（攻守交代）</small></h3>
            <div class="set-options">${CONFIG.setOptions
              .map(
                (n) =>
                  `<button class="seg ${n === this.createSets ? 'selected' : ''}" data-sets="${n}">${n}</button>`,
              )
              .join('')}</div>
            <h3 class="section-title">セットごとのステージ</h3>
            <div class="set-stages" id="set-stages">${this.setStagesHtml()}</div>
            <p class="lobby-note dim">🛠 は自作ステージ。タイトル画面の「ステージエディタ」で作ったものがここに出ます</p>
            <div class="btn-row modal-actions">
              <button class="btn" id="btn-cancel-create">やめる</button>
              <button class="btn big" id="btn-create">作成して入室</button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.renderRoomList();
    const modal = this.root.querySelector<HTMLDivElement>('#create-modal')!;
    const input = this.root.querySelector<HTMLInputElement>('#in-room')!;
    const openModal = () => {
      modal.classList.remove('hidden');
      input.focus();
    };
    const closeModal = () => modal.classList.add('hidden');
    this.root.querySelector<HTMLButtonElement>('#btn-open-create')!.onclick = openModal;
    this.root.querySelector<HTMLButtonElement>('#btn-cancel-create')!.onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };
    const setStages = this.root.querySelector<HTMLDivElement>('#set-stages')!;
    const bindStageRows = () => {
      setStages.querySelectorAll<HTMLButtonElement>('.stage-pick').forEach((b) => {
        b.onclick = () => {
          const i = Number(b.dataset.set);
          this.createStages[i] = b.dataset.stage ?? DEFAULT_STAGE_ID;
          setStages.innerHTML = this.setStagesHtml();
          bindStageRows();
        };
      });
    };
    bindStageRows();
    this.root.querySelectorAll<HTMLButtonElement>('.seg').forEach((b) => {
      b.onclick = () => {
        this.createSets = Number(b.dataset.sets);
        // 増えた分は直前のセットと同じステージで埋める
        while (this.createStages.length < this.createSets) {
          this.createStages.push(this.createStages[this.createStages.length - 1] ?? DEFAULT_STAGE_ID);
        }
        this.createStages.length = this.createSets;
        this.root.querySelectorAll<HTMLButtonElement>('.seg').forEach((c) => {
          c.classList.toggle('selected', c === b);
        });
        setStages.innerHTML = this.setStagesHtml();
        bindStageRows();
      };
    });
    const create = () => {
      const code = input.value.trim().toUpperCase();
      if (!code) {
        input.focus();
        return;
      }
      // すでに開いているルームなら参加のみ。新設なら試合構成を決めてから入る
      const active = Object.keys(this.roomIndex[`r_${code}`] ?? {}).length > 0;
      if (!active) {
        const stages = this.createStages.slice(0, this.createSets);
        const match: MatchConfig = { sets: this.createSets, stages };
        // 自作ステージは作成者のブラウザにしか無いので、データごとルームに書いて全員に配る
        const custom = this.customStages.filter((s) => stages.includes(s.id));
        if (custom.length > 0) match.custom = Object.fromEntries(custom.map((s) => [s.id, s]));
        this.net.set(`rooms/${code}/match`, match);
      }
      this.join(code);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') create();
      if (e.key === 'Escape') closeModal();
    };
    this.root.querySelector<HTMLButtonElement>('#btn-create')!.onclick = create;
    this.root.querySelector<HTMLButtonElement>('#btn-back')!.onclick = () => this.go('name');
  }

  /** セットごとのステージ選択（ルーム作成時）。1行 = 1セット */
  private setStagesHtml(): string {
    const rows: string[] = [];
    for (let i = 0; i < this.createSets; i++) {
      const options = [
        ...STAGES.map((st) => ({ id: st.id, name: st.name, desc: st.desc })),
        ...this.customStages.map((st) => ({
          id: st.id,
          name: `🛠 ${st.name}`,
          desc: `${st.w}×${st.h}マス・カメラ${st.cams.length}台・NPC${st.npcCount}人（自作）`,
        })),
      ];
      const picks = options
        .map(
          (st) => `
          <button class="stage-pick ${st.id === this.createStages[i] ? 'selected' : ''}" data-set="${i}" data-stage="${st.id}" title="${esc(st.desc)}">
            ${esc(st.name)}
          </button>`,
        )
        .join('');
      rows.push(`<div class="set-row"><span class="set-label">第${i + 1}セット</span><div class="set-picks">${picks}</div></div>`);
    }
    return rows.join('');
  }

  /** 一覧部分だけを描き直す（入力欄の内容を消さないため） */
  private renderRoomList(): void {
    const list = this.root.querySelector<HTMLDivElement>('#room-list');
    if (!list) return;
    const rooms = Object.entries(this.roomIndex)
      .filter(([key, members]) => key.startsWith('r_') && members && Object.keys(members).length > 0)
      .map(([key, members]) => ({ code: key.slice(2), names: Object.values(members) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    if (rooms.length === 0) {
      list.innerHTML = '<div class="room-empty">開いているルームはありません。右下の「ルームを新規作成」から作れます</div>';
      return;
    }
    list.innerHTML = rooms
      .map(
        (r) => `
        <button class="room-card" data-room="${esc(r.code)}">
          <span class="room-code">${esc(r.code)}</span>
          <span class="room-members">${r.names.map(esc).join('・')}</span>
          <span class="room-count">${r.names.length}/4人</span>
        </button>`,
      )
      .join('');
    list.querySelectorAll<HTMLButtonElement>('.room-card').forEach((b) => {
      b.onclick = () => this.join(b.dataset.room!);
    });
  }

  // ---- ルーム ----

  private join(room: string): void {
    this.room = room;
    this.matchLoaded = false;
    const pid = this.net.clientId;
    this.net.set(`rooms/${room}/players/${pid}`, {
      name: this.name,
      role: 'none',
      joinedAt: Date.now(),
      color: this.color,
    } satisfies PlayerInfo);
    this.net.set(`roomIndex/r_${room}/${pid}`, this.name);
    this.net.onDisconnectRemove(`rooms/${room}/players/${pid}`);
    this.net.onDisconnectRemove(`rooms/${room}/pos/${pid}`);
    this.net.onDisconnectRemove(`roomIndex/r_${room}/${pid}`);

    let firstSnapshot = true;
    this.unsubs.push(
      this.net.subscribe(`rooms/${room}/players`, (val) => {
        this.players = (val ?? {}) as Record<string, PlayerInfo>;
        if (firstSnapshot) {
          firstSnapshot = false;
          // 自分以外に誰もいない部屋は、前の試合の残骸（phase・events 等）が残っていても
          // 誰も進行できないので、入室時にロビー状態へ戻す
          if (!Object.keys(this.players).some((id) => id !== pid)) this.resetRoom();
        }
        this.render();
        if (this.matchLoaded) this.onUpdate?.(room, this.players, this.phase);
      }),
      this.net.subscribe(`rooms/${room}/phase`, (val) => {
        this.phase = (val as PhaseState) ?? { phase: 'lobby' };
        this.render();
        if (this.matchLoaded) this.onUpdate?.(room, this.players, this.phase);
      }),
      this.net.subscribe(`rooms/${room}/match`, (val) => {
        const m = val as Partial<MatchConfig> | null;
        // 自作ステージを先に登録する（以降 getStage でIDから引ける）
        for (const [id, raw] of Object.entries(m?.custom ?? {})) registerCustomStage(id, raw);
        const stages = Array.isArray(m?.stages) ? m.stages.map((id) => getStage(id).id) : [];
        const sets = Math.max(1, Math.floor(Number(m?.sets) || stages.length || 1));
        while (stages.length < sets) stages.push(stages[stages.length - 1] ?? DEFAULT_STAGE_ID);
        this.match = { sets, stages: stages.slice(0, sets) };
        this.matchLoaded = true;
        this.render();
        this.onUpdate?.(room, this.players, this.phase);
      }),
    );
    this.go('room');
  }

  /** 前の試合の残骸を消してロビー状態にする（開始時・誰もいない部屋への入室時） */
  private resetRoom(): void {
    this.net.remove(`rooms/${this.room}/events`);
    this.net.remove(`rooms/${this.room}/pos`);
    this.net.remove(`rooms/${this.room}/cams`);
    this.net.set(`rooms/${this.room}/phase`, { phase: 'lobby' } satisfies PhaseState);
  }

  /** joinedAtが最小のプレイヤーがホスト（開始ボタンを持つ・フェーズ送りを担当） */
  hostId(): string | null {
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

  isHost(): boolean {
    return this.hostId() === this.net.clientId;
  }

  private myTeam(): Team | null {
    return teamOf(this.players[this.net.clientId]?.role ?? 'none');
  }

  /** 陣営のメンバー（枠順） */
  private teamMembers(team: Team): { pid: string; info: PlayerInfo }[] {
    const out: { pid: string; info: PlayerInfo }[] = [];
    for (const role of rolesOfTeam(team)) {
      const e = Object.entries(this.players).find(([, p]) => p.role === role);
      if (e) out.push({ pid: e[0], info: e[1] });
    }
    return out;
  }

  private setColor(hex: number): void {
    this.color = hex;
    try {
      localStorage.setItem(LS_COLOR, String(hex));
    } catch {
      // 保存できなくても続行
    }
    this.net.set(`rooms/${this.room}/players/${this.net.clientId}/color`, hex);
  }

  private renderRoom(): void {
    if (!this.room) return;
    const pid = this.net.clientId;
    const me = this.players[pid];
    if (!me) return;
    const isHost = this.isHost();
    const inGame = this.phase.phase === 'playing' && !isStalePhase(this.phase);
    const myTeam = this.myTeam();

    // 陣営カード（先着順。満員なら入れない）
    const teamCards = (['A', 'B'] as Team[])
      .map((team) => {
        const members = this.teamMembers(team);
        const full = members.length >= 2;
        const mine = myTeam === team;
        const hint = team === 'A' ? '前半:🐭ネズミ → 後半:🎥猫' : '前半:🎥猫 → 後半:🐭ネズミ';
        // カプセル型の枠。空きをクリックするとその陣営に入る（自分のカプセルの色で埋まる）
        const slots = [0, 1]
          .map((i) => {
            const m = members[i];
            const isMe = m?.pid === pid;
            const color = m ? (m.info.color ?? AVATAR_PALETTE[0].hex) : 0;
            const style = m ? `style="background:#${color.toString(16).padStart(6, '0')}"` : '';
            return `
              <button class="cap-slot ${m ? 'filled' : 'empty'} ${isMe ? 'me' : ''}" data-team="${team}"
                ${m || inGame ? 'disabled' : ''} title="${m ? esc(m.info.name) : 'クリックで参加'}">
                <span class="cap" ${style}>${m ? '' : '＋'}</span>
                <span class="cap-name">${m ? esc(m.info.name) : '空き'}</span>
              </button>`;
          })
          .join('');
        return `
          <div class="team-card team-${team.toLowerCase()} ${mine ? 'mine' : ''}">
            <div class="team-name">${TEAM_LABELS[team]}${mine ? '<small>参加中</small>' : full ? '<small>満員</small>' : ''}</div>
            <div class="team-hint">${hint}</div>
            <div class="team-slots">${slots}</div>
          </div>`;
      })
      .join('');

    const everyoneHasRole = Object.values(this.players).every((p) => p.role !== 'none');
    const filledCount = Object.values(this.players).filter((p) => p.role !== 'none').length;

    const waiting = Object.values(this.players).filter((p) => p.role === 'none').length;
    const status = inGame
      ? 'ゲーム進行中です'
      : filledCount === 0
        ? '誰も陣営に入っていません'
        : waiting > 0
          ? `陣営を選んでいない人が${waiting}人います`
          : filledCount < 4
            ? `${filledCount}人で開始できます（4人未満は動作確認用）`
            : '4人そろいました';
    this.root.innerHTML = `
      <div class="scr">
        <div class="scr-head">
          <h1>ルーム <span style="color:#ffb300">${esc(this.room)}</span></h1>
          <span class="crumb">${Object.keys(this.players).length}人が入室中 / ホスト: <b>${esc(
            this.players[this.hostId() ?? '']?.name ?? '-',
          )}</b> / ${this.match.sets}セット <button class="link-btn pill" id="btn-rules">？ ルール</button></span>
        </div>
        <div class="room-body">
          <p class="lobby-note dim">空いているカプセルをクリックして陣営に入る（先着順・各2人）</p>
          <div class="team-grid">${teamCards}</div>
        </div>
        <div class="room-footer">
          <div class="room-footer-inner">
            <div class="status-block">
              <span class="status-line">${status}${!isHost && !inGame ? '。ホストの開始を待っています' : ''}</span>
              <span class="status-line dim">開始すると、まず${CONFIG.costumeSec}秒の着せ替え（先攻陣営）とカメラ練習（後攻陣営）の時間があります</span>
            </div>
            ${
              isHost && !inGame
                ? `<button class="btn big" id="btn-start" ${
                    everyoneHasRole && filledCount > 0 ? '' : 'disabled'
                  }>ゲーム開始</button>`
                : ''
            }
          </div>
        </div>
        <div class="modal-backdrop hidden" id="rules-modal">
          <div class="modal rules">
          <h2>ルールと操作方法</h2>
          <p>⏱ ${CONFIG.roundTimeSec}秒×2ラウンド。前半は先攻陣営がネズミ（攻撃）、後攻陣営が猫（監視カメラ）。後半で攻守交代。交代のときは${CONFIG.costumeSec}秒の着せ替え・作戦会議（猫側はカメラ操作の練習）</p>
          <p>🐭 ネズミ: WASD or 矢印キーで移動。好きな商品棚の近くで「盗む」ボタンを押し続け、そのまま${CONFIG.stealTimeSec}秒とどまると盗み成功（ボタンを離すと中断）（その間、体が左右に揺れて目立つ！）→ 出口(緑ゲート)から持ち出すと商品の値段分のスコアを獲得。ただし店の外に出たらそのラウンドには戻れない（チキンレース）。欲張って盗み続けるか、早めに持ち出すかの駆け引き</p>
          <p>🎥 猫: 画面下のカメラマップでカメラ番号をクリック（or 数字キー）してオンライン⇔オフライン切替（同時${CONFIG.maxViewCams}台まで。映像は中央のモニタに表示、カーソルを乗せるとそのモニタが拡大）。映像内の怪しいネズミをクリックでダウト（1ラウンド各${CONFIG.doubtsPerRound}回まで）。的中したネズミは商品を没収されて退場（以降は店内全体を俯瞰で観戦）、NPCなら空振り。ラウンドは時間切れ、またはネズミ全員のダウトに成功した時点で即終了</p>
          <p>💡 オンラインのカメラは球体が赤く発光し、視野に入っている床が明るくなる（ネズミからも「みられている場所」が分かる）</p>
          <p>🎨 ネズミの色は着せ替えで選ぶ。NPCも同じ色のどれかなので色では見分けがつかない。仲間の頭上には名前が出る（猫のカメラには映らない）</p>
          <p>🐱 猫: カメラマップには自分がオンにしたカメラの視野（赤）・相方がオンにしたカメラの視野（青）と死角が表示される（Mキーで表示/非表示）。🐭 ネズミは同じマップが左下に常時表示され、自分の位置が分かる</p>
          <p>🏬 「2フロア」ステージでは東側のスロープで2Fへ上がれる（NPCも行き来する）。出口は1Fのみ。猫のカメラマップは1F・2Fが横に並ぶ</p>
          <p>🏆 2ラウンドで盗んだ商品の累計金額が多いチームの勝ち</p>
          <div class="btn-row modal-actions"><button class="btn" id="btn-rules-close">閉じる</button></div>
          </div>
        </div>
      </div>
    `;
    const rulesModal = this.root.querySelector<HTMLDivElement>('#rules-modal')!;
    this.root.querySelector<HTMLButtonElement>('#btn-rules')!.onclick = () => rulesModal.classList.remove('hidden');
    this.root.querySelector<HTMLButtonElement>('#btn-rules-close')!.onclick = () => rulesModal.classList.add('hidden');
    rulesModal.onclick = (e) => {
      if (e.target === rulesModal) rulesModal.classList.add('hidden');
    };

    this.root.querySelectorAll<HTMLButtonElement>('.cap-slot.empty').forEach((b) => {
      b.onclick = () => this.joinTeam(b.dataset.team as Team);
    });
    this.root.querySelector<HTMLButtonElement>('#btn-start')?.addEventListener('click', () => {
      // 前の試合の残骸を消してから開始。まず着せ替え・練習の時間 → （main.ts が）前半を開始する
      this.net.remove(`rooms/${this.room}/events`);
      this.net.remove(`rooms/${this.room}/pos`);
      this.net.remove(`rooms/${this.room}/cams`);
      this.net.set(`rooms/${this.room}/phase`, {
        phase: 'costume',
        round: 1,
        set: 1,
        sets: this.match.sets,
        stages: this.match.stages,
        results: [],
        until: Date.now() + CONFIG.costumeSec * 1000,
        stage: this.match.stages[0],
        note: this.match.sets > 1 ? '第1セット' : '',
      } satisfies PhaseState);
    });
    this.destroyPreview();
  }

  /** 陣営に入る（空いている枠の若い方。先着順） */
  private joinTeam(team: Team): void {
    const taken = new Set(Object.values(this.players).map((p) => p.role));
    const role = rolesOfTeam(team).find((r) => !taken.has(r));
    if (!role) return;
    this.net.set(`rooms/${this.room}/players/${this.net.clientId}/role`, role satisfies Role);
  }

  // ---- 着せ替え ----

  /** 着せ替えパネル（プレビューの差し込み口 + パレット）。パレットには誰がどの色を選んでいるか名札を出す */
  private costumeHtml(team: Team): string {
    const members = this.teamMembers(team);
    const swatches = AVATAR_PALETTE.map((p) => {
      const owners = members.filter((m) => (m.info.color ?? AVATAR_PALETTE[0].hex) === p.hex);
      const mine = owners.some((m) => m.pid === this.net.clientId);
      const tags = owners
        .map((m) => `<span class="swatch-tag ${m.pid === this.net.clientId ? 'me' : ''}">${esc(m.info.name)}</span>`)
        .join('');
      return `
        <button class="swatch ${mine ? 'selected' : ''}" data-hex="${p.hex}" title="${p.name}"
          style="background:#${p.hex.toString(16).padStart(6, '0')}">${tags}</button>`;
    }).join('');
    return `
      <div class="costume">
        <h3 class="section-title">着せ替え <small>${TEAM_LABELS[team]}</small></h3>
        <div class="costume-slot"></div>
        <div class="palette">${swatches}</div>
        <p class="lobby-note dim">カプセルの色を選ぶ。NPCも同じ色のどれかになるので、猫は色では見分けられない。仲間が選び直すとその場で反映される</p>
      </div>
    `;
  }

  private bindCostume(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => {
      b.onclick = () => this.setColor(Number(b.dataset.hex));
    });
  }

  /** プレビュー（WebGL）は描画のたびに作り直さず、差し込み口に付け替える */
  private mountPreview(team: Team): void {
    const slot = this.root.querySelector<HTMLDivElement>('.costume-slot');
    if (!slot) {
      this.destroyPreview();
      return;
    }
    if (!this.preview) this.preview = new CostumePreview();
    slot.appendChild(this.preview.el);
    const members: CostumeMember[] = this.teamMembers(team).map((m) => ({
      pid: m.pid,
      name: m.info.name,
      color: m.info.color ?? AVATAR_PALETTE[0].hex,
      isMe: m.pid === this.net.clientId,
    }));
    this.preview.setMembers(members);
  }

  private destroyPreview(): void {
    this.preview?.dispose();
    this.preview = null;
  }

  /**
   * 攻守交代時の着せ替え・作戦会議（泥棒陣営向け）。後半でネズミになる陣営だけがこの画面を見る。
   * 猫陣営は main.ts がゲームの練習モード（無人の店内でカメラ操作）を出す
   */
  private renderCostumePhase(): void {
    const round = this.phase.round ?? 2;
    const me = this.players[this.net.clientId];
    const team = teamOf(me?.role ?? 'none');
    const isThief = !!me && isMouseInRound(me.role, round);
    const half = round === 1 ? '前半' : '後半';
    const setLabel = (this.phase.sets ?? 1) > 1 ? `第${this.phase.set ?? 1}セット ` : '';
    const fmt = (until: number) => {
      const r = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
    };
    this.root.innerHTML = `
      <div class="scr">
        <div class="scr-head">
          <h1>${setLabel}${round === 1 ? (this.phase.set ?? 1) > 1 ? '開始前の準備' : '試合開始前の準備' : '攻守交代 — 後半の準備'}</h1>
          <span class="crumb">${esc(this.phase.note ?? '')}</span>
        </div>
        <div class="costume-phase">
          <div class="panel">
            <p class="costume-timer">${half}開始まで<span class="costume-timer-num">${fmt(this.phase.until ?? Date.now())}</span></p>
            <p class="lobby-note">${
              isThief ? `${half}、あなたは 🐭 ネズミです。カプセルの色を選びながら、仲間と作戦会議をしましょう` : `${half}の開始を待っています`
            }</p>
            <p class="lobby-note dim">ステージ: ${esc(getStage(this.phase.stage).name)}。時間になると自動で${half}が始まります${
              round === 1 ? '（ステージ紹介 → 3・2・1のカウントダウン）' : '（3・2・1のカウントダウン）'
            }。猫陣営はこの間、無人の店内でカメラ操作を練習しています</p>
          </div>
          <div class="panel">
            ${isThief && team ? this.costumeHtml(team) : `<div class="costume-wait">着せ替えは${half}にネズミになる陣営だけが行います</div>`}
          </div>
        </div>
      </div>
    `;
    this.bindCostume();
    if (isThief && team) this.mountPreview(team);
    else this.destroyPreview();
    // 残り時間の表示だけを毎秒更新する
    window.clearInterval(this.timerId);
    this.timerId = window.setInterval(() => {
      const el = this.root.querySelector<HTMLSpanElement>('.costume-timer-num');
      if (!el || this.phase.phase !== 'costume') {
        window.clearInterval(this.timerId);
        return;
      }
      el.textContent = fmt(this.phase.until ?? Date.now());
    }, 250);
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.destroyPreview();
    this.destroyBackdrop();
    window.clearInterval(this.timerId);
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.render();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unwatchRooms();
    this.destroyPreview();
    this.destroyBackdrop();
    window.clearInterval(this.timerId);
    this.root.remove();
  }
}
