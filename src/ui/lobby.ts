import * as THREE from 'three';
import type { NetAdapter } from '../net';
import type { FirstPick, MatchConfig, PhaseState, PlayerInfo, Role, Team } from '../types';
import { isMouseInRound, isStalePhase, rolesOfTeam, TEAM_LABELS, TEAM_NAMES, teamOf } from '../types';
import { AVATAR_PALETTE, CONFIG } from '../config';
import { DEFAULT_STAGE_ID, getStage, STAGES } from '../game/stages';
import { loadStages, registerCustomStage, validateStage, type CustomStageData } from '../game/customStage';
import { buildWorld, type MapData } from '../game/world';
import { CostumePreview, type CostumeMember } from './costume';
import { StrategyMapView } from './map';
import { TitleBackdrop } from './titlebg';
import { roundLabel, sideLabel, SIDE_MICE, SIDE_WATCH, turnLabel } from './text';

type Screen = 'title' | 'intro' | 'name' | 'rooms' | 'room';

const LS_NAME = 'dorobo-name';

/** アクティブなエリア一覧（roomIndex/r_{code}/{pid} = 名前。切断時に自動削除） */
type RoomIndex = Record<string, Record<string, string>>;

/** イントロダクション（世界観の紹介）の画面。資料の「要素 画面1 / 画面2」 */
const INTRO_PAGES: string[][] = [
  [
    'ここは、ネズミたちが暮らす「タイニータウン」。',
    'みんなちょっぴりヤンチャで、小競り合いは日常茶飯事。',
    '',
    'この街では「トレトレバトル」という',
    '一風変わった戦いが繰り広げられている。',
  ],
  [
    'スーパーを営むネズミたちは、',
    'ライバル店に意地悪をすべく、“まんびき” を働こうとする。',
    'しかしライバル店も黙っていない。',
    '監視カメラで “まんびきチュー” のマウスを狙いにかかる。',
    '',
    'まんびき VS 監視。',
    'スーパーを舞台にした、世界一小さな戦争が幕を開ける！',
  ],
];

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function randomColor(): number {
  return AVATAR_PALETTE[Math.floor(Math.random() * AVATAR_PALETTE.length)].hex;
}

/** エリアの住所（XX-XX-XX）を新しく作る */
function newAddress(): string {
  const part = () => String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return `${part()}-${part()}-${part()}`;
}

/** 入力された住所を Firebase のキーに使える形にする（. # $ [ ] / は使えない） */
function normalizeAddress(s: string): string {
  return s.trim().toUpperCase().replace(/[.#$[\]/\s]/g, '');
}

/**
 * ロビー。タイトル → イントロダクション → 名前 → エリア（住所）の選択/新設 → ロビー（チーム・先攻・START）。
 * 各ターンの前（phase=planning）は両チームに作戦会議タイム（値段付きの俯瞰マップ）を出す。
 */
export class Lobby {
  private root: HTMLDivElement;
  private net: NetAdapter;
  private screen: Screen = 'title';
  private introPage = 0;
  private name = '';
  private color: number = randomColor();
  room: string | null = null;
  players: Record<string, PlayerInfo> = {};
  phase: PhaseState = { phase: 'lobby' };
  /** 試合構成（セット数とセットごとのステージ。rooms/{room}/match。エリア作成時にホストが決める） */
  match: MatchConfig = { sets: 1, stages: [DEFAULT_STAGE_ID] };
  /** 先攻（第1ターンにまんびきするチーム。rooms/{room}/first。ホストが選ぶ） */
  first: FirstPick = 'random';
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
  /** 作戦会議のマップ（同じ seed・ステージなら作り直さない） */
  private strategyMap: { key: string; view: StrategyMapView } | null = null;
  /** 変装の色を決めたターン（`${set}-${round}`）。同じターンで2回決めない */
  private disguisedFor = '';
  private timerId = 0;
  /** エリア作成モーダルの入力（セット数とセットごとのステージ） */
  private createSets = 1;
  private createStages: string[] = [DEFAULT_STAGE_ID];
  private createCode = '';
  /** エディタで作った自作ステージ（遊べるものだけ） */
  private customStages: CustomStageData[] = [];
  /** match（試合構成）を受信済みか。受信前にゲームを作ると自作ステージが引けないので待つ */
  private matchLoaded = false;

  constructor(parent: HTMLElement, net: NetAdapter) {
    this.net = net;
    this.root = document.createElement('div');
    this.root.className = 'lobby';
    parent.appendChild(this.root);
    try {
      this.name = localStorage.getItem(LS_NAME) ?? '';
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
    else if (this.screen === 'intro') this.renderIntro();
    else if (this.screen === 'name') this.renderName();
    else if (this.screen === 'rooms') this.renderRooms();
    else if (this.phase.phase === 'planning' && !isStalePhase(this.phase)) this.renderPlanning();
    else this.renderRoom();
    if (this.screen !== 'room' || this.phase.phase !== 'planning') this.destroyStrategyMap();
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
          <p class="title-kicker">万引きVS監視。史上最小!?の戦い勃発！</p>
          <h1 class="title-logo">まんびきチュー</h1>
          <p class="title-sub">~SUPER TINY WAR~</p>
          <button class="btn big" id="btn-title-start">PRESS TO START</button>
          <button class="btn title-editor" id="btn-title-editor">🛠 ステージエディタ</button>
        </div>
        <span class="mode-badge title-mode">${this.modeLabel()}</span>
      </div>
    `;
    if (!this.backdrop) this.backdrop = new TitleBackdrop();
    this.root.querySelector('.scr-title')!.prepend(this.backdrop.el);
    this.root.querySelector<HTMLButtonElement>('#btn-title-start')!.onclick = () => {
      this.introPage = 0;
      this.go('intro');
    };
    this.root.querySelector<HTMLButtonElement>('#btn-title-editor')!.onclick = () => this.onOpenEditor?.();
  }

  private destroyBackdrop(): void {
    this.backdrop?.dispose();
    this.backdrop = null;
  }

  /** イントロダクション（世界観や楽しみ方を端的に紹介する画面。SKIP で飛ばせる） */
  private renderIntro(): void {
    this.destroyPreview();
    const page = INTRO_PAGES[this.introPage];
    const last = this.introPage === INTRO_PAGES.length - 1;
    this.root.innerHTML = `
      <div class="scr scr-intro">
        <div class="intro-box">
          <p class="intro-text">${page.map((l) => (l ? esc(l) : '&nbsp;')).join('<br>')}</p>
          <div class="intro-nav">
            <span class="intro-dots">${INTRO_PAGES.map((_, i) => `<i class="${i === this.introPage ? 'on' : ''}"></i>`).join('')}</span>
            <button class="btn big" id="btn-intro-next">${last ? 'はじめる' : 'つぎへ'}</button>
            <button class="link-btn" id="btn-intro-skip" data-pad-back>SKIP &gt;</button>
          </div>
        </div>
      </div>
    `;
    this.root.querySelector<HTMLButtonElement>('#btn-intro-next')!.onclick = () => {
      if (last) this.go('name');
      else {
        this.introPage++;
        this.render();
      }
    };
    this.root.querySelector<HTMLButtonElement>('#btn-intro-skip')!.onclick = () => this.go('name');
  }

  private renderName(): void {
    this.destroyPreview();
    this.root.innerHTML = `
      <div class="scr scr-name">
        <div class="name-box">
          <h1>キミの名前を入力しよう！</h1>
          <p class="lobby-note dim">ゲーム中、仲間の頭上にこの名前が出ます（12文字まで）</p>
          <label>名前 <input id="in-name" maxlength="12" placeholder="なまえ" value="${esc(this.name)}" /></label>
          <div class="btn-row">
            <button class="btn" id="btn-back" data-pad-back>戻る</button>
            <button class="btn big" id="btn-next">つぎへ</button>
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

  // ---- エリア（住所）の選択 / 新設 ----

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

  private isActiveRoom(code: string): boolean {
    return Object.keys(this.roomIndex[`r_${code}`] ?? {}).length > 0;
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
          <h1>参加するエリアの住所を入力しよう！</h1>
          <span class="crumb"><b>${esc(this.name)}</b> として参加 <button class="link-btn" id="btn-back" data-pad-back>名前を変える</button></span>
        </div>
        <div class="rooms-grid">
          <div class="panel rooms-panel">
            <h3 class="section-title">いま開いているエリア <small>クリックで参加</small></h3>
            <div class="room-list" id="room-list"></div>
          </div>
          <div class="panel address-panel">
            <h3 class="section-title">住所を知っている <small>仲間から聞いた住所を入力</small></h3>
            <label>エリアの住所 <input id="in-room" maxlength="8" placeholder="XX-XX-XX" /></label>
            <button class="btn big" id="btn-join">このエリアに参加する</button>
            <div class="address-or">または</div>
            <button class="btn big accent" id="btn-new">新たな住所をゲットする！</button>
            <p class="lobby-note dim">新しいエリアを作ると住所が発行されます。仲間に伝えて同じエリアに集まろう</p>
          </div>
        </div>
        <div class="modal-backdrop hidden" id="create-modal">
          <div class="modal">
            <h2>新しいエリア</h2>
            <p class="lobby-note dim">この住所を仲間に伝えてください</p>
            <div class="address-big" id="create-code"></div>
            <details class="create-details">
              <summary>くわしい設定 <small>ラウンド数とステージ</small></summary>
              <h3 class="section-title">ラウンド数 <small>1ラウンド = 第1ターン＋第2ターン（攻守交代）</small></h3>
              <div class="set-options">${CONFIG.setOptions
                .map(
                  (n) =>
                    `<button class="seg ${n === this.createSets ? 'selected' : ''}" data-sets="${n}">${n}</button>`,
                )
                .join('')}</div>
              <h3 class="section-title">ラウンドごとのステージ</h3>
              <div class="set-stages" id="set-stages">${this.setStagesHtml()}</div>
              <p class="lobby-note dim">🛠 は自作ステージ。タイトル画面の「ステージエディタ」で作ったものがここに出ます</p>
            </details>
            <div class="btn-row modal-actions">
              <button class="btn" id="btn-cancel-create" data-pad-back>やめる</button>
              <button class="btn big" id="btn-create">エリアを作って入る</button>
            </div>
          </div>
        </div>
      </div>
    `;
    this.renderRoomList();
    const modal = this.root.querySelector<HTMLDivElement>('#create-modal')!;
    const codeEl = this.root.querySelector<HTMLDivElement>('#create-code')!;
    const input = this.root.querySelector<HTMLInputElement>('#in-room')!;
    const openModal = (code: string) => {
      this.createCode = code;
      codeEl.textContent = code;
      modal.classList.remove('hidden');
      this.root.querySelector<HTMLButtonElement>('#btn-create')!.focus();
    };
    const closeModal = () => modal.classList.add('hidden');
    const joinTyped = () => {
      const code = normalizeAddress(input.value);
      if (!code) {
        input.focus();
        return;
      }
      // 開いているエリアなら参加。無ければその住所で新しいエリアを作る
      if (this.isActiveRoom(code)) this.join(code);
      else openModal(code);
    };
    this.root.querySelector<HTMLButtonElement>('#btn-join')!.onclick = joinTyped;
    this.root.querySelector<HTMLButtonElement>('#btn-new')!.onclick = () => {
      let code = newAddress();
      while (this.isActiveRoom(code)) code = newAddress();
      openModal(code);
    };
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
        // 増えた分は直前のラウンドと同じステージで埋める
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
      const code = this.createCode;
      if (!code) return;
      // モーダルを開いている間に誰かが同じ住所を開いていたら参加のみ。新設なら試合構成を決めてから入る
      if (!this.isActiveRoom(code)) {
        const stages = this.createStages.slice(0, this.createSets);
        const match: MatchConfig = { sets: this.createSets, stages };
        // 自作ステージは作成者のブラウザにしか無いので、データごとエリアに書いて全員に配る
        const custom = this.customStages.filter((s) => stages.includes(s.id));
        if (custom.length > 0) match.custom = Object.fromEntries(custom.map((s) => [s.id, s]));
        this.net.set(`rooms/${code}/match`, match);
        this.net.set(`rooms/${code}/first`, 'random' satisfies FirstPick);
      }
      this.join(code);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') joinTyped();
    };
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') closeModal();
    };
    this.root.querySelector<HTMLButtonElement>('#btn-create')!.onclick = create;
    this.root.querySelector<HTMLButtonElement>('#btn-back')!.onclick = () => this.go('name');
  }

  /** ラウンドごとのステージ選択（エリア作成時）。1行 = 1ラウンド */
  private setStagesHtml(): string {
    const rows: string[] = [];
    for (let i = 0; i < this.createSets; i++) {
      const options = [
        ...STAGES.map((st) => ({ id: st.id, name: st.name, desc: st.desc })),
        ...this.customStages.map((st) => ({
          id: st.id,
          name: `🛠 ${st.name}`,
          desc: `${st.w}×${st.h}マス・カメラ${st.cams.length}台・一般客${st.npcCount}人（自作）`,
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
      rows.push(`<div class="set-row"><span class="set-label">${roundLabel(i + 1)}</span><div class="set-picks">${picks}</div></div>`);
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
      list.innerHTML = '<div class="room-empty">開いているエリアはありません。「新たな住所をゲットする！」から作れます</div>';
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

  // ---- ロビー（エリア内） ----

  private join(room: string): void {
    this.room = room;
    this.matchLoaded = false;
    this.disguisedFor = '';
    const pid = this.net.clientId;
    // 変装（カプセルの色）は選ばずランダム
    this.color = randomColor();
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
        this.onPhaseChanged();
        this.render();
        if (this.matchLoaded) this.onUpdate?.(room, this.players, this.phase);
      }),
      this.net.subscribe(`rooms/${room}/first`, (val) => {
        this.first = val === 'A' || val === 'B' ? val : 'random';
        this.render();
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

  /**
   * フェーズが変わったときの自分のデータ更新。
   * 作戦会議タイムに入ったら、そのターンでまんびきサイドになる自分の変装（色）をランダムに決め直す
   */
  private onPhaseChanged(): void {
    if (this.phase.phase !== 'planning' || isStalePhase(this.phase)) return;
    const me = this.players[this.net.clientId];
    if (!me || me.role === 'none') return;
    const round = this.phase.round ?? 1;
    if (!isMouseInRound(me.role, round, this.phase.firstMice ?? 'A')) return;
    const key = `${this.phase.set ?? 1}-${round}`;
    if (this.disguisedFor === key) return;
    this.disguisedFor = key;
    this.color = randomColor();
    this.net.set(`rooms/${this.room}/players/${this.net.clientId}/color`, this.color);
  }

  /** 前の試合の残骸を消してロビー状態にする（開始時・誰もいない部屋への入室時・「もう一度勝負する」） */
  private resetRoom(): void {
    this.net.remove(`rooms/${this.room}/events`);
    this.net.remove(`rooms/${this.room}/pos`);
    this.net.remove(`rooms/${this.room}/cams`);
    this.net.set(`rooms/${this.room}/phase`, { phase: 'lobby' } satisfies PhaseState);
  }

  /**
   * 試合終了後の「もう一度 勝負する」。自分はエリアのロビー画面へ戻る。
   * ホストなら phase を lobby に戻す（まだセレモニーを見ている人の画面は main.ts が消さない）
   */
  returnToRoom(): void {
    if (!this.room) return;
    if (this.isHost() && this.phase.phase === 'ended') this.resetRoom();
    this.show();
  }

  /** エリアから抜ける（「別のエリアで勝負する」= エリア一覧へ / 「ゲームを止める」= タイトルへ） */
  leaveRoom(to: 'rooms' | 'title'): void {
    const room = this.room;
    const pid = this.net.clientId;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    if (room) {
      this.net.remove(`rooms/${room}/players/${pid}`);
      this.net.remove(`rooms/${room}/pos/${pid}`);
      this.net.remove(`rooms/${room}/cams/${pid}`);
      this.net.remove(`roomIndex/r_${room}/${pid}`);
    }
    this.room = null;
    this.players = {};
    this.phase = { phase: 'lobby' };
    this.matchLoaded = false;
    this.destroyStrategyMap();
    this.root.classList.remove('hidden');
    this.go(to);
  }

  /** joinedAtが最小のプレイヤーがホスト（START ボタンと先攻の選択を持つ・フェーズ送りを担当） */
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

  /** チームのメンバー（枠順） */
  private teamMembers(team: Team): { pid: string; info: PlayerInfo }[] {
    const out: { pid: string; info: PlayerInfo }[] = [];
    for (const role of rolesOfTeam(team)) {
      const e = Object.entries(this.players).find(([, p]) => p.role === role);
      if (e) out.push({ pid: e[0], info: e[1] });
    }
    return out;
  }

  /** 先攻の選択に応じた、チームの攻守の順番の説明 */
  private orderHint(team: Team): string {
    if (this.first === 'random') return '順番は START 時にランダムで決定';
    return this.first === team
      ? `第1ターン: ${sideLabel(true)} → 第2ターン: ${sideLabel(false)}`
      : `第1ターン: ${sideLabel(false)} → 第2ターン: ${sideLabel(true)}`;
  }

  private renderRoom(): void {
    if (!this.room) return;
    const pid = this.net.clientId;
    const me = this.players[pid];
    if (!me) return;
    const isHost = this.isHost();
    const stale = isStalePhase(this.phase);
    const inGame = this.phase.phase !== 'lobby' && this.phase.phase !== 'ended' && !stale;
    // 試合終了後、ホストが「もう一度」を押すまでの待ち（ホスト自身は returnToRoom で phase を戻している）
    const waitingHost = this.phase.phase === 'ended' && !stale;
    const busy = inGame || waitingHost;
    const myTeam = this.myTeam();

    // チームカード（先着順。満員なら入れない）
    const teamCards = (['A', 'B'] as Team[])
      .map((team) => {
        const members = this.teamMembers(team);
        const full = members.length >= 2;
        const mine = myTeam === team;
        // カプセル型の枠。空きをクリックするとそのチームに入る（自分のカプセルの色で埋まる）
        const slots = [0, 1]
          .map((i) => {
            const m = members[i];
            const isMe = m?.pid === pid;
            const color = m ? (m.info.color ?? AVATAR_PALETTE[0].hex) : 0;
            const style = m ? `style="background:#${color.toString(16).padStart(6, '0')}"` : '';
            return `
              <button class="cap-slot ${m ? 'filled' : 'empty'} ${isMe ? 'me' : ''}" data-team="${team}"
                ${m || busy ? 'disabled' : ''} title="${m ? esc(m.info.name) : 'クリックで参加'}">
                <span class="cap" ${style}>${m ? '' : '＋'}</span>
                <span class="cap-name">${m ? esc(m.info.name) : '空き'}</span>
              </button>`;
          })
          .join('');
        return `
          <div class="team-card team-${team.toLowerCase()} ${mine ? 'mine' : ''}">
            <div class="team-name">${TEAM_LABELS[team]}${mine ? '<small>参加中</small>' : full ? '<small>満員</small>' : ''}</div>
            <div class="team-hint">${this.orderHint(team)}</div>
            <div class="team-slots">${slots}</div>
          </div>`;
      })
      .join('');

    const everyoneHasRole = Object.values(this.players).every((p) => p.role !== 'none');
    const filledCount = Object.values(this.players).filter((p) => p.role !== 'none').length;

    const waiting = Object.values(this.players).filter((p) => p.role === 'none').length;
    const status = inGame
      ? '試合が進行中です'
      : waitingHost
        ? 'ホストが「もう一度 勝負する」を押すと、次の試合の準備ができます'
        : filledCount === 0
          ? '誰もチームに入っていません'
          : waiting > 0
            ? `チームを選んでいない人が${waiting}人います`
            : filledCount < 4
              ? `${filledCount}人で開始できます（4人未満は動作確認用）`
              : '4人そろいました';
    const firstOptions: { v: FirstPick; label: string }[] = [
      { v: 'A', label: `${TEAM_NAMES.A} が先にまんびきする` },
      { v: 'B', label: `${TEAM_NAMES.B} が先にまんびきする` },
      { v: 'random', label: '🎲 ランダム' },
    ];
    this.root.innerHTML = `
      <div class="scr">
        <div class="scr-head">
          <h1>トレトレバトル！</h1>
          <span class="crumb">住所 <b>${esc(this.room)}</b> / ${Object.keys(this.players).length}人が入室中 / ホスト: <b>${esc(
            this.players[this.hostId() ?? '']?.name ?? '-',
          )}</b> / ${this.match.sets}ラウンド <button class="link-btn pill" id="btn-rules">？ ルール</button></span>
        </div>
        <div class="room-body">
          <p class="lobby-note dim">空いているカプセルをクリックしてチームに入る（先着順・各2人）</p>
          <div class="team-grid">${teamCards}</div>
          <div class="first-pick">
            <span class="first-pick-label">先攻</span>
            <div class="seg-row">${firstOptions
              .map(
                (o) =>
                  `<button class="seg ${o.v === this.first ? 'selected' : ''}" data-first="${o.v}" ${
                    isHost && !busy ? '' : 'disabled'
                  }>${o.label}</button>`,
              )
              .join('')}</div>
            <span class="lobby-note dim">${isHost ? 'ホストが決めます' : 'ホストが決めます（あなたは変更できません）'}</span>
          </div>
        </div>
        <div class="room-footer">
          <div class="room-footer-inner">
            <div class="status-block">
              <span class="status-line">${status}${!isHost && !busy ? '。ホストの START を待っています' : ''}</span>
              <span class="status-line dim">START すると ${CONFIG.planningSec}秒の作戦会議タイム → フィールド紹介 → 3・2・1 で第1ターンが始まります</span>
            </div>
            ${
              isHost && !busy
                ? `<button class="btn big" id="btn-start" ${
                    everyoneHasRole && filledCount > 0 ? '' : 'disabled'
                  }>START</button>`
                : ''
            }
          </div>
        </div>
        <div class="modal-backdrop hidden" id="rules-modal">
          <div class="modal rules">
          <h2>ルールと操作方法</h2>
          <p>🏪 高額商品を盗みたい <b>${SIDE_MICE}</b> VS それを防ぎたい <b>${SIDE_WATCH}</b>。TEAM PINK と TEAM BLUE の2チーム（各2匹）で、攻守を入れ替えながら戦う</p>
          <p>⏱ 1ターン ${CONFIG.roundTimeSec}秒。第1ターンと第2ターンで攻守を交代し、それを1ラウンドとする（ラウンド数はエリア作成時に決める）。各ターンの前に ${CONFIG.planningSec}秒の作戦会議タイム（棚ごとの商品とポイントが載った店内マップを見ながら相談）</p>
          <p>🐭 ${SIDE_MICE}: 一般客に変装して店内へ（変装の色はランダム。一般客も同じ色のどれか）。WASD or 矢印キーで移動。好きな商品棚の近くで「盗む」ボタンを押し続け、${CONFIG.stealTimeSec}秒とどまると盗み成功（ボタンを離すと中断。その間は目立つ！）。出口から持ち出すとその商品のポイントが確定。ただし店の外に出たらそのターンには戻れない（欲張って盗み続けるか、早めに持ち出すかの駆け引き）</p>
          <p>📹 ${SIDE_WATCH}: 画面下のカメラマップでカメラ番号をクリック（or 数字キー）して ONLINE⇔OFFLINE 切替（同時 ${CONFIG.maxViewCams}台まで。映像は中央のモニタに表示、カーソルを乗せるとそのモニタが拡大）。映像内の怪しいネズミをクリックで「ダウト」（1ターン各 ${CONFIG.doubtsPerRound}回まで）。的中したネズミはポイントを没収されて退場（以降は店内全体を俯瞰で観戦）、一般客なら空振り。ターンは時間切れ、または ${SIDE_MICE} 全員の退場で終了</p>
          <p>💡 ONLINE のカメラは球体が赤く発光し、視野に入っている床が明るくなる（${SIDE_MICE} からも「みられている場所」が分かる）。カメラマップには自分が ON にしたカメラの視野（赤）・相方が ON にしたカメラの視野（青）と死角が表示される（Mキーで表示/非表示）。${SIDE_MICE} は同じマップが左下に常時表示され、自分の位置が分かる。仲間の頭上には名前が出る（監視カメラには映らない）</p>
          <p>🏬 「2フロア」ステージでは東側のスロープで2Fへ上がれる（一般客も行き来する）。出口は1Fのみ。カメラマップは1F・2Fが横に並ぶ</p>
          <p>🏆 ラウンドごとに合計ポイントの多いチームがそのラウンドを獲得。獲得ラウンド数の多いチームの勝ち（同数なら合計ポイント、それも同じなら引き分け）</p>
          <p>🎮 コントローラー（PS4）でも操作できる。${SIDE_MICE}: 左スティックで移動（一人称は左スティック上下で前進・後退、右スティック左右で向きを変える）、×を押し続けて盗む、△で視点切替。${SIDE_WATCH}: 左スティックで照準を動かし、×でクリック（カメラ番号のON/OFF・ダウト）、□でカメラマップの表示/非表示。メニュー: 十字キー or 左スティックで選び、×で決定、○で戻る</p>
          <div class="btn-row modal-actions"><button class="btn" id="btn-rules-close" data-pad-back>閉じる</button></div>
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
    this.root.querySelectorAll<HTMLButtonElement>('[data-first]').forEach((b) => {
      b.onclick = () => this.net.set(`rooms/${this.room}/first`, b.dataset.first as FirstPick);
    });
    this.root.querySelector<HTMLButtonElement>('#btn-start')?.addEventListener('click', () => {
      // 前の試合の残骸を消してから開始。まず作戦会議タイム → （main.ts が）第1ターンを開始する。
      // 先攻（第1ターンにまんびきするチーム）はここで確定し、商品配置の seed も作戦会議のマップ用にここで決める
      const firstMice: Team = this.first === 'random' ? (Math.random() < 0.5 ? 'A' : 'B') : this.first;
      this.net.remove(`rooms/${this.room}/events`);
      this.net.remove(`rooms/${this.room}/pos`);
      this.net.remove(`rooms/${this.room}/cams`);
      this.net.set(`rooms/${this.room}/phase`, {
        phase: 'planning',
        round: 1,
        set: 1,
        sets: this.match.sets,
        stages: this.match.stages,
        results: [],
        firstMice,
        seed: Math.floor(Math.random() * 2 ** 31),
        until: Date.now() + CONFIG.planningSec * 1000,
        stage: this.match.stages[0],
        note: this.match.sets > 1 ? roundLabel(1) : '',
      } satisfies PhaseState);
    });
    this.destroyPreview();
  }

  /** チームに入る（空いている枠の若い方。先着順） */
  private joinTeam(team: Team): void {
    const taken = new Set(Object.values(this.players).map((p) => p.role));
    const role = rolesOfTeam(team).find((r) => !taken.has(r));
    if (!role) return;
    this.net.set(`rooms/${this.room}/players/${this.net.clientId}/role`, role satisfies Role);
  }

  // ---- 作戦会議タイム ----

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
   * 作戦会議用の店内マップのデータ。ゲームと同じ buildWorld で商品配置（seed）を再現し、
   * 使い捨てのシーンに組んでからマップ用データだけを取り出す（描画はしないので GPU 資源は作られない）
   */
  private mapDataFor(stageId: string | undefined, seed: number): MapData {
    const scene = new THREE.Scene();
    const world = buildWorld(scene, seed, getStage(stageId));
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    scene.clear();
    return world.mapData;
  }

  /** 作戦会議のマップを差し込み口に付ける（同じ seed・ステージなら作り直さない） */
  private mountStrategyMap(): void {
    const slot = this.root.querySelector<HTMLDivElement>('.strategy-slot');
    if (!slot) return;
    const seed = this.phase.seed ?? 1;
    const key = `${this.phase.stage ?? ''}:${seed}`;
    if (this.strategyMap && this.strategyMap.key !== key) this.destroyStrategyMap();
    if (!this.strategyMap) {
      this.strategyMap = { key, view: new StrategyMapView(this.mapDataFor(this.phase.stage, seed)) };
    }
    slot.appendChild(this.strategyMap.view.el);
  }

  private destroyStrategyMap(): void {
    this.strategyMap?.view.dispose();
    this.strategyMap = null;
  }

  /**
   * 作戦会議タイム（各ターンの前）。両チームとも、棚ごとの商品とポイントが載った俯瞰マップを見ながら
   * どう役割分担して攻めるか／守るかを相談する。まんびきサイドには今回の変装（ランダムな色）も見せる
   */
  private renderPlanning(): void {
    const round = this.phase.round ?? 1;
    const me = this.players[this.net.clientId];
    const team = teamOf(me?.role ?? 'none');
    const firstMice = this.phase.firstMice ?? 'A';
    const isThief = !!me && isMouseInRound(me.role, round, firstMice);
    const multi = (this.phase.sets ?? 1) > 1;
    const progress = multi ? `${roundLabel(this.phase.set ?? 1)}・${turnLabel(round)}` : turnLabel(round);
    const fmt = (until: number) => {
      const r = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
    };
    const stage = getStage(this.phase.stage);
    const camCount = stage.floors.reduce((n, f) => n + f.cams.length, 0);
    this.root.innerHTML = `
      <div class="scr scr-planning">
        <div class="scr-head">
          <h1>作戦会議タイム</h1>
          <span class="crumb">${esc(this.phase.note ?? '')}${this.phase.note ? ' / ' : ''}ステージ: ${esc(stage.name)}</span>
        </div>
        <div class="planning">
          <div class="panel planning-side">
            <p class="costume-timer">${progress} 開始まで<span class="costume-timer-num">${fmt(this.phase.until ?? Date.now())}</span></p>
            ${
              team
                ? `<div class="planning-role ${team.toLowerCase()}"><small>${TEAM_LABELS[team]}</small>${sideLabel(isThief)}</div>`
                : '<div class="planning-role">観戦</div>'
            }
            <p class="lobby-note">${
              isThief
                ? `一般客に紛れて商品を盗み、出口から持ち出そう。どの棚を狙うか、誰がどこへ行くか相談しよう`
                : `${camCount}台のカメラのうち ${CONFIG.maxViewCams}台を同時に見られる。どこを見張るか、2人で手分けを決めよう`
            }</p>
            ${
              isThief && team
                ? `<h3 class="section-title">今回の変装 <small>色はランダム。一般客も同じ色のどれか</small></h3><div class="costume-slot"></div>`
                : ''
            }
            <p class="lobby-note dim">時間になると自動で始まります（フィールド紹介 → 3・2・1）</p>
          </div>
          <div class="panel planning-map">
            <h3 class="section-title">店内マップ <small>棚の商品とポイント・カメラの視野（薄い扇形）・出口</small></h3>
            <div class="strategy-slot"></div>
          </div>
        </div>
      </div>
    `;
    if (isThief && team) this.mountPreview(team);
    else this.destroyPreview();
    this.mountStrategyMap();
    // 残り時間の表示だけを毎秒更新する
    window.clearInterval(this.timerId);
    this.timerId = window.setInterval(() => {
      const el = this.root.querySelector<HTMLSpanElement>('.costume-timer-num');
      if (!el || this.phase.phase !== 'planning') {
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
    this.destroyStrategyMap();
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
    this.destroyStrategyMap();
    window.clearInterval(this.timerId);
    this.root.remove();
  }
}
