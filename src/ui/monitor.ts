import * as THREE from 'three';
import { CONFIG } from '../config';
import type { NetAdapter } from '../net';
import { registerCustomStage } from '../game/customStage';
import { createNpcSims, type NpcSim } from '../game/npc';
import { getStage, type StageDef } from '../game/stages';
import { buildWorld, castRay, type MapData, type Spot } from '../game/world';
import {
  isMouseInRound,
  TEAM_COLORS,
  TEAM_NAMES,
  teamOf,
  TRACK_HIDDEN,
  TRACK_STRIDE,
  TRACK_SWAY,
  type GameEvent,
  type LogCamEntry,
  type LogMeta,
  type LogTurnEnd,
  type LogTurnInfo,
  type Role,
  type TurnLog,
} from '../types';
import { drawMap, type MapCanvas } from './map';
import { pt, roundLabel, turnLabel } from './text';

/** 軌跡の1サンプル（t はターン開始からのミリ秒） */
interface Sample {
  t: number;
  x: number;
  z: number;
  ry: number;
  f: number;
  flags: number;
}

/** 再生中のターンのステージ（マップ・NPC・棚の位置）。同じステージ・seed なら作り直さない */
interface TurnWorld {
  key: string;
  stage: StageDef;
  mapData: MapData;
  spots: Spot[];
  npcs: NpcSim[];
}

/** 連続するサンプルの間隔がこれより開いていたら補間せずワープ（ミリ秒） */
const INTERP_MAX_MS = 1500;
/** 再生速度の選択肢 */
const SPEEDS = [0.5, 1, 2, 4];
/** 監視サイドの2人のカメラ視野の色（ゲーム中のカメラマップと同じく赤・青） */
const WATCHER_COLORS = ['255, 82, 82', '80, 170, 255'];
const RAYS_PER_CAM = 48;
/** 進行中とみなす上限（ターン開始からこの時間を過ぎて end が無ければ、途中で止まった試合） */
const LIVE_WINDOW_MS = (CONFIG.roundTimeSec + 60) * 1000;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** 0:00.0 のような経過時間の表記 */
function fmtMs(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

function fmtDate(at: number): string {
  return new Date(at).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Firebase は配列をオブジェクト（キーが添字）で返すことがあるので、どちらでも数値の列にする */
function numList(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number);
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, n]) => Number(n));
  }
  return [];
}

function values<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v.filter((x) => x != null) as T[];
  if (v && typeof v === 'object') return Object.values(v as Record<string, T>).filter((x) => x != null);
  return [];
}

/**
 * ログモニター。タイトル画面から開き、Firebase（ローカルモードではタブ間）に残した移動ログを
 * 俯瞰マップの上で再生する。試合 → ターンを選ぶと、まんびきサイドの軌跡・一般客（seed から再計算）・
 * 監視サイドが ON にしたカメラの視野・イベント（盗み・脱出・ダウト）が時間に沿って動く。
 * 進行中のターンは LIVE で末尾に追従する（書き込みは1秒ごとなので1〜2秒遅れる）
 */
export class LogMonitor {
  private root: HTMLDivElement;
  private logsEl: HTMLDivElement;
  private turnsEl: HTMLDivElement;
  private stageEl: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private emptyEl: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private liveBtn: HTMLButtonElement;
  private seek: HTMLInputElement;
  private timeEl: HTMLSpanElement;
  private speedSel: HTMLSelectElement;
  private npcChk: HTMLInputElement;
  private trailChk: HTMLInputElement;
  private playersEl: HTMLDivElement;
  private eventsEl: HTMLDivElement;

  private index: Record<string, LogMeta> = {};
  private selLog: string | null = null;
  private selTurn: string | null = null;
  private unsubIndex: (() => void) | null = null;
  private unsubTurn: (() => void) | null = null;

  private info: LogTurnInfo | null = null;
  private end: LogTurnEnd | null = null;
  private tracks = new Map<string, Sample[]>();
  private events: GameEvent[] = [];
  private cams = new Map<string, LogCamEntry[]>();
  private world: TurnWorld | null = null;
  private base: MapCanvas | null = null;
  private dpr = 1;

  /** 再生位置（ターン開始からのミリ秒） */
  private cur = 0;
  private playing = true;
  private speed = 1;
  /** 進行中のターンの末尾に追従する */
  private live = false;
  private pastCount = -1;
  private raf = 0;
  private lastFrame = performance.now();
  private disposed = false;

  constructor(
    parent: HTMLElement,
    private net: NetAdapter,
    onExit: () => void,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'monitor';
    this.root.innerHTML = `
      <div class="mon-top">
        <button class="btn" id="mon-back">← タイトルへ</button>
        <h1>📼 ログモニター</h1>
        <span class="mon-hint">試合とターンを選ぶと、まんびきサイドの動き・一般客・監視サイドが見ていたカメラ・イベントを再生します。Space: 再生/停止、←→: 5秒移動</span>
      </div>
      <div class="mon-body">
        <aside class="mon-list">
          <h3 class="section-title">試合 <small>新しい順</small></h3>
          <div class="mon-logs"></div>
          <h3 class="section-title">ターン</h3>
          <div class="mon-turns"></div>
        </aside>
        <main class="mon-center">
          <div class="mon-stage">
            <canvas></canvas>
            <div class="mon-empty">左の一覧から試合を選んでください</div>
          </div>
          <div class="mon-ctrl">
            <button class="btn" id="mon-play" title="再生 / 一時停止">⏸</button>
            <input type="range" id="mon-seek" min="0" max="1000" step="100" value="0" />
            <span class="mon-time">0:00.0 / 0:00.0</span>
            <select id="mon-speed" title="再生速度">
              ${SPEEDS.map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>×${s}</option>`).join('')}
            </select>
            <button class="btn mon-live" id="mon-live" title="進行中のターンの末尾に追従">● LIVE</button>
            <label><input type="checkbox" id="mon-npc" checked /> 一般客</label>
            <label><input type="checkbox" id="mon-trail" checked /> 軌跡</label>
          </div>
        </main>
        <aside class="mon-side">
          <h3 class="section-title">プレイヤー</h3>
          <div class="mon-players"></div>
          <h3 class="section-title">イベント <small>クリックでその時刻へ</small></h3>
          <div class="mon-events"></div>
        </aside>
      </div>
    `;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector<T>(sel)!;
    this.logsEl = q('.mon-logs');
    this.turnsEl = q('.mon-turns');
    this.stageEl = q('.mon-stage');
    this.canvas = q('.mon-stage canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.emptyEl = q('.mon-empty');
    this.playBtn = q('#mon-play');
    this.liveBtn = q('#mon-live');
    this.seek = q('#mon-seek');
    this.timeEl = q('.mon-time');
    this.speedSel = q('#mon-speed');
    this.npcChk = q('#mon-npc');
    this.trailChk = q('#mon-trail');
    this.playersEl = q('.mon-players');
    this.eventsEl = q('.mon-events');

    q<HTMLButtonElement>('#mon-back').onclick = onExit;
    this.playBtn.onclick = () => this.togglePlay();
    this.liveBtn.onclick = () => {
      this.live = !this.live;
      if (this.live) this.playing = true;
    };
    this.seek.oninput = () => {
      this.live = false;
      this.cur = Number(this.seek.value);
      this.draw();
    };
    this.speedSel.onchange = () => {
      this.speed = Number(this.speedSel.value) || 1;
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);

    this.unsubIndex = this.net.subscribe('logIndex', (val) => this.onIndex(val));
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---- 一覧 ----

  private onIndex(val: unknown): void {
    this.index = (val ?? {}) as Record<string, LogMeta>;
    // ログに同梱された自作ステージを登録する（ステージ名の表示と再生のため）
    for (const meta of Object.values(this.index)) {
      for (const [id, raw] of Object.entries(meta?.custom ?? {})) registerCustomStage(id, raw);
    }
    if (this.selLog && !this.index[this.selLog]) {
      this.selLog = null;
      this.selectTurn(null);
    }
    this.renderLogs();
    this.renderTurns();
    // 選択中のターンの終了情報が届いたら反映する
    if (this.selLog && this.selTurn) {
      const turn = this.index[this.selLog]?.turns?.[this.selTurn];
      const hadInfo = !!this.info;
      this.info = turn?.info ?? null;
      this.end = turn?.end ?? null;
      if (!hadInfo && this.info) this.onTurnReady();
      this.renderPlayers();
    }
  }

  private sortedLogs(): [string, LogMeta][] {
    return Object.entries(this.index)
      .filter(([, m]) => m && typeof m === 'object')
      .sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0));
  }

  /** ターンを (set, round) 順に並べる */
  private sortedTurns(meta: LogMeta): [string, LogTurnInfo, LogTurnEnd | null][] {
    return Object.entries(meta.turns ?? {})
      .filter(([, t]) => !!t?.info)
      .map(([k, t]) => [k, t.info!, t.end ?? null] as [string, LogTurnInfo, LogTurnEnd | null])
      .sort((a, b) => a[1].set - b[1].set || a[1].round - b[1].round);
  }

  /** そのターンが進行中か（終了情報が無く、開始から時間が経ちすぎていない） */
  private isLiveTurn(info: LogTurnInfo, end: LogTurnEnd | null): boolean {
    return !end && Date.now() - info.startAt < LIVE_WINDOW_MS;
  }

  private renderLogs(): void {
    const logs = this.sortedLogs();
    if (logs.length === 0) {
      this.logsEl.innerHTML = `<p class="lobby-note dim">まだログがありません。試合を START すると記録が始まります</p>`;
      return;
    }
    this.logsEl.innerHTML = logs
      .map(([id, m]) => {
        const turns = this.sortedTurns(m);
        const names = new Set<string>();
        for (const [, info] of turns) for (const p of Object.values(info.players ?? {})) names.add(p.name);
        const last = turns[turns.length - 1];
        const live = last && this.isLiveTurn(last[1], last[2]);
        const stages = [...new Set(m.stages ?? [])].map((s) => getStage(s).name).join(' / ');
        return `
          <button class="mon-card ${id === this.selLog ? 'selected' : ''}" data-log="${esc(id)}">
            <div class="mon-card-head"><b>${esc(m.room ?? '')}</b><span>${fmtDate(m.createdAt)}</span>${live ? '<i class="mon-live-dot">LIVE</i>' : ''}</div>
            <div class="mon-card-sub">${m.sets ?? 1}ラウンド・${esc(stages)}・ターン ${turns.length}</div>
            <div class="mon-card-names">${esc([...names].join('、')) || '（参加者の記録なし）'}</div>
          </button>`;
      })
      .join('');
    this.logsEl.querySelectorAll<HTMLButtonElement>('[data-log]').forEach((b) => {
      b.onclick = () => this.selectLog(b.dataset.log!);
    });
  }

  private renderTurns(): void {
    const meta = this.selLog ? this.index[this.selLog] : null;
    if (!meta) {
      this.turnsEl.innerHTML = `<p class="lobby-note dim">試合を選ぶとターンが出ます</p>`;
      return;
    }
    const turns = this.sortedTurns(meta);
    if (turns.length === 0) {
      this.turnsEl.innerHTML = `<p class="lobby-note dim">まだターンが始まっていません（作戦会議中）</p>`;
      return;
    }
    this.turnsEl.innerHTML = turns
      .map(([key, info, end]) => {
        const status = end
          ? `${esc(end.reason)}　PINK ${pt(end.scoreA)} - BLUE ${pt(end.scoreB)}`
          : this.isLiveTurn(info, end)
            ? '<i class="mon-live-dot">LIVE</i> 進行中'
            : '（終了の記録なし）';
        return `
          <button class="mon-card small ${key === this.selTurn ? 'selected' : ''}" data-turn="${esc(key)}">
            <div class="mon-card-head"><b>${meta.sets > 1 ? `${roundLabel(info.set)}・` : ''}${turnLabel(info.round)}</b><span>${esc(getStage(info.stage).name)}</span></div>
            <div class="mon-card-sub">${status}</div>
          </button>`;
      })
      .join('');
    this.turnsEl.querySelectorAll<HTMLButtonElement>('[data-turn]').forEach((b) => {
      b.onclick = () => this.selectTurn(b.dataset.turn!);
    });
  }

  private selectLog(id: string): void {
    if (this.selLog === id) return;
    this.selLog = id;
    // 既定は最新のターン（進行中ならそれを追う）
    const turns = this.sortedTurns(this.index[id]);
    this.selectTurn(turns.length > 0 ? turns[turns.length - 1][0] : null);
    this.renderLogs();
  }

  private selectTurn(key: string | null): void {
    this.unsubTurn?.();
    this.unsubTurn = null;
    this.selTurn = key;
    this.tracks = new Map();
    this.events = [];
    this.cams = new Map();
    this.pastCount = -1;
    const turn = key && this.selLog ? this.index[this.selLog]?.turns?.[key] : null;
    this.info = turn?.info ?? null;
    this.end = turn?.end ?? null;
    this.renderTurns();
    this.renderPlayers();
    this.renderEvents();
    if (!key || !this.selLog) {
      this.world = null;
      this.base = null;
      this.emptyEl.classList.remove('hidden');
      this.draw();
      return;
    }
    this.unsubTurn = this.net.subscribe(`logs/${this.selLog}/${key}`, (val) => this.onTurnData(val));
    if (this.info) this.onTurnReady();
  }

  /** ターン情報が揃ったらステージを組み、先頭から再生する（進行中なら LIVE） */
  private onTurnReady(): void {
    if (!this.info) return;
    this.emptyEl.classList.add('hidden');
    this.ensureWorld(this.info);
    this.cur = 0;
    this.playing = true;
    this.live = this.isLiveTurn(this.info, this.end);
    this.draw();
  }

  // ---- ターンのデータ ----

  private onTurnData(val: unknown): void {
    const log = (val ?? {}) as TurnLog;
    const tracks = new Map<string, Sample[]>();
    for (const [pid, chunks] of Object.entries(log.tracks ?? {})) {
      const samples: Sample[] = [];
      for (const chunk of values<unknown>(chunks)) {
        const nums = numList(chunk);
        for (let i = 0; i + TRACK_STRIDE <= nums.length; i += TRACK_STRIDE) {
          samples.push({
            t: nums[i],
            x: nums[i + 1],
            z: nums[i + 2],
            ry: nums[i + 3],
            f: nums[i + 4],
            flags: nums[i + 5],
          });
        }
      }
      samples.sort((a, b) => a.t - b.t);
      tracks.set(pid, samples);
    }
    this.tracks = tracks;
    const prevEvents = this.events.length;
    this.events = values<GameEvent>(log.events).sort((a, b) => a.at - b.at);
    const cams = new Map<string, LogCamEntry[]>();
    for (const [pid, entries] of Object.entries(log.cams ?? {})) {
      cams.set(
        pid,
        values<LogCamEntry>(entries)
          .map((e) => ({ t: Number(e.t), ids: numList(e.ids) }))
          .sort((a, b) => a.t - b.t),
      );
    }
    this.cams = cams;
    if (this.events.length !== prevEvents) this.renderEvents();
    this.draw();
  }

  /** ステージ（マップ・NPC・棚）を用意する。ゲームと同じ buildWorld を使い捨てのシーンで呼んで必要なものだけ取り出す */
  private ensureWorld(info: LogTurnInfo): void {
    const key = `${info.stage}:${info.seed}`;
    if (this.world?.key === key) {
      this.layoutCanvas();
      return;
    }
    const stage = getStage(info.stage);
    const scene = new THREE.Scene();
    const world = buildWorld(scene, info.seed, stage);
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    scene.clear();
    this.world = {
      key,
      stage,
      mapData: world.mapData,
      spots: world.spots,
      npcs: createNpcSims(info.seed, stage.npcCount, world.nav),
    };
    this.layoutCanvas();
  }

  /** 中央の領域に収まる大きさで下地のマップを描く */
  private layoutCanvas(): void {
    if (!this.world) return;
    const availW = Math.max(320, this.stageEl.clientWidth - 24);
    const availH = Math.max(240, this.stageEl.clientHeight - 24);
    // drawMap は高さを maxW の 0.75 倍までに収めるので、縦が足りないときは幅の方を絞る
    const maxW = Math.min(availW, availH / 0.75, 1400);
    this.base = drawMap(document.createElement('canvas'), this.world.mapData, maxW, { prices: true });
    this.canvas.width = this.base.canvas.width;
    this.canvas.height = this.base.canvas.height;
    this.canvas.style.width = this.base.canvas.style.width;
    this.canvas.style.height = this.base.canvas.style.height;
    this.dpr = this.base.canvas.width / this.base.cssW;
  }

  private onResize = (): void => {
    this.layoutCanvas();
    this.draw();
  };

  // ---- 右パネル ----

  private playerName(pid: string): string {
    return this.info?.players?.[pid]?.name ?? pid;
  }

  private isMouse(role: Role): boolean {
    return !!this.info && role !== 'none' && isMouseInRound(role, this.info.round, this.info.firstMice);
  }

  /** 監視サイドのプレイヤー（枠順）。カメラ視野の色の割り当てに使う */
  private watchers(): string[] {
    if (!this.info) return [];
    return Object.entries(this.info.players ?? {})
      .filter(([, p]) => p.role !== 'none' && !this.isMouse(p.role))
      .sort((a, b) => a[1].role.localeCompare(b[1].role))
      .map(([pid]) => pid);
  }

  private renderPlayers(): void {
    if (!this.info) {
      this.playersEl.innerHTML = `<p class="lobby-note dim">—</p>`;
      return;
    }
    const watchers = this.watchers();
    const rows = Object.entries(this.info.players ?? {})
      .sort((a, b) => a[1].role.localeCompare(b[1].role))
      .map(([pid, p]) => {
        const team = teamOf(p.role);
        const mouse = this.isMouse(p.role);
        const wi = watchers.indexOf(pid);
        const swatch = mouse
          ? `<i class="mon-swatch" style="background:${hex(p.color ?? 0x888888)};border-color:${team ? TEAM_COLORS[team] : '#888'}"></i>`
          : wi >= 0
            ? `<i class="mon-swatch cam" style="background:rgba(${WATCHER_COLORS[wi % WATCHER_COLORS.length]},0.6)"></i>`
            : `<i class="mon-swatch" style="background:#555;border-color:#555"></i>`;
        const side = p.role === 'none' ? '観戦' : mouse ? '🐭 まんびき' : '📹 監視';
        return `<div class="mon-player">${swatch}<b>${esc(p.name)}</b><span class="mon-team" style="color:${team ? TEAM_COLORS[team] : '#aaa'}">${team ? TEAM_NAMES[team] : ''}</span><span>${side}</span></div>`;
      });
    this.playersEl.innerHTML = rows.join('') || `<p class="lobby-note dim">記録なし</p>`;
  }

  private eventText(ev: GameEvent): string {
    const by = this.playerName(ev.by);
    switch (ev.type) {
      case 'steal': {
        const item = this.world?.spots[ev.spotIdx]?.item;
        return `${by} が${item ? `「${item.name}」(${pt(item.price)})を` : ''}盗んだ`;
      }
      case 'escape':
        return `${by} が脱出！ +${pt(ev.value)}`;
      case 'caught':
        return `${by} のダウト成功！ ${this.playerName(ev.mouseId)} が退場`;
      case 'miss':
        return `${by} のダウト失敗（一般客）`;
    }
  }

  private renderEvents(): void {
    this.pastCount = -1;
    if (!this.info || this.events.length === 0) {
      this.eventsEl.innerHTML = `<p class="lobby-note dim">${this.info ? 'まだイベントがありません' : '—'}</p>`;
      return;
    }
    const start = this.info.startAt;
    this.eventsEl.innerHTML = this.events
      .map(
        (ev, i) =>
          `<button class="mon-event ${ev.type}" data-i="${i}"><span class="mon-event-t">${fmtMs(ev.at - start)}</span>${esc(this.eventText(ev))}</button>`,
      )
      .join('');
    this.eventsEl.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((b) => {
      b.onclick = () => {
        const ev = this.events[Number(b.dataset.i)];
        if (!ev || !this.info) return;
        this.live = false;
        this.cur = Math.max(0, ev.at - this.info.startAt - 1500);
        this.draw();
      };
    });
  }

  /** 再生位置より前のイベントを強調する（件数が変わったときだけ DOM を触る） */
  private updateEventHighlight(): void {
    if (!this.info) return;
    const start = this.info.startAt;
    let n = 0;
    while (n < this.events.length && this.events[n].at - start <= this.cur) n++;
    if (n === this.pastCount) return;
    this.pastCount = n;
    this.eventsEl.querySelectorAll<HTMLButtonElement>('.mon-event').forEach((b, i) => {
      b.classList.toggle('past', i < n);
      b.classList.toggle('latest', i === n - 1);
    });
    const latest = this.eventsEl.querySelector<HTMLElement>('.mon-event.latest');
    latest?.scrollIntoView({ block: 'nearest' });
  }

  // ---- 再生 ----

  /** 記録されている一番遅い時刻（LIVE の追従先） */
  private latestT(): number {
    if (!this.info) return 0;
    let t = 0;
    for (const s of this.tracks.values()) if (s.length > 0) t = Math.max(t, s[s.length - 1].t);
    for (const ev of this.events) t = Math.max(t, ev.at - this.info.startAt);
    for (const c of this.cams.values()) if (c.length > 0) t = Math.max(t, c[c.length - 1].t);
    return t;
  }

  private duration(): number {
    if (!this.info) return 0;
    if (this.end) return Math.max(0, this.end.at - this.info.startAt);
    return this.latestT();
  }

  private togglePlay(): void {
    if (!this.info) return;
    if (!this.playing && this.cur >= this.duration() && !this.isLiveTurn(this.info, this.end)) this.cur = 0;
    this.playing = !this.playing;
    if (!this.playing) this.live = false;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      this.live = false;
      const d = e.code === 'ArrowLeft' ? -5000 : 5000;
      this.cur = Math.min(this.duration(), Math.max(0, this.cur + d));
      this.draw();
    }
  };

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(200, now - this.lastFrame);
    this.lastFrame = now;
    if (!this.info) return;
    const dur = this.duration();
    const liveTurn = this.isLiveTurn(this.info, this.end);
    if (this.live && liveTurn) {
      this.cur = dur;
    } else if (this.playing) {
      this.cur = Math.min(dur, this.cur + dt * this.speed);
      if (this.cur >= dur) {
        // 進行中のターンなら末尾に追いついたので LIVE に切り替え、終わったターンなら止まる
        if (liveTurn) this.live = true;
        else this.playing = false;
      }
    }
    if (this.live && !liveTurn) this.live = false;
    this.playBtn.textContent = this.playing ? '⏸' : '▶';
    this.liveBtn.classList.toggle('hidden', !liveTurn);
    this.liveBtn.classList.toggle('on', this.live);
    this.seek.max = String(Math.max(1000, dur));
    this.seek.value = String(Math.round(this.cur));
    this.timeEl.textContent = `${fmtMs(this.cur)} / ${fmtMs(dur)}`;
    this.updateEventHighlight();
    this.draw();
  };

  // ---- 描画 ----

  /** pid の時刻 t での位置。サンプルが無ければスポーン地点（開始前）か null */
  private posAt(pid: string, t: number): Sample | null {
    const samples = this.tracks.get(pid);
    if (!samples || samples.length === 0 || t < samples[0].t) {
      const role = this.info?.players?.[pid]?.role;
      if (!role || !this.isMouse(role) || !this.world) return null;
      const spawn = this.world.stage.spawns[role === 'a1' || role === 'b1' ? 0 : 1];
      return { t, x: spawn.x, z: spawn.z, ry: Math.PI, f: 0, flags: 0 };
    }
    // t 以下の最後のサンプル（二分探索）
    let lo = 0;
    let hi = samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    const a = samples[lo];
    const b = samples[lo + 1];
    if (!b || b.t - a.t > INTERP_MAX_MS || b.f !== a.f || a.flags & TRACK_HIDDEN) return a;
    const k = (t - a.t) / (b.t - a.t);
    return { t, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, ry: a.ry, f: a.f, flags: a.flags };
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.base || !this.world || !this.info) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    ctx.drawImage(this.base.canvas, 0, 0);
    ctx.scale(this.dpr, this.dpr);
    const { tx, tz } = this.base;
    const t = this.cur;
    const start = this.info.startAt;
    const mapData = this.world.mapData;

    // 監視サイドが ON にしているカメラの視野（赤=1人目・青=2人目）
    const watchers = this.watchers();
    watchers.forEach((pid, wi) => {
      const entries = this.cams.get(pid);
      if (!entries) return;
      let ids: number[] = [];
      for (const e of entries) {
        if (e.t > t) break;
        ids = e.ids;
      }
      const rgb = WATCHER_COLORS[wi % WATCHER_COLORS.length];
      for (const id of ids) {
        mapData.floors.forEach((floor, fi) => {
          const cam = floor.cams.find((c) => c.id === id);
          if (!cam) return;
          const half = ((cam.hfovDeg / 2) * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(tx(cam.x, fi), tz(cam.z, fi));
          for (let i = 0; i <= RAYS_PER_CAM; i++) {
            const a = cam.angle - half + (2 * half * i) / RAYS_PER_CAM;
            const d = castRay(cam.x, cam.z, Math.cos(a), Math.sin(a), cam.range, floor.occluders);
            ctx.lineTo(tx(cam.x + Math.cos(a) * d, fi), tz(cam.z + Math.sin(a) * d, fi));
          }
          ctx.closePath();
          ctx.fillStyle = `rgba(${rgb}, 0.22)`;
          ctx.fill();
          ctx.strokeStyle = `rgba(${rgb}, 0.7)`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(tx(cam.x, fi), tz(cam.z, fi), 8, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
          ctx.lineWidth = 2.5;
          ctx.stroke();
        });
      }
    });

    // 一般客（seed から同じ動きを再計算）
    if (this.npcChk.checked) {
      const nt = Math.max(0, t / 1000);
      for (const npc of this.world.npcs) {
        const p = npc.posAt(nt);
        const fi = Math.min(mapData.floors.length - 1, Math.max(0, p.layer));
        ctx.beginPath();
        ctx.arc(tx(p.x, fi), tz(p.z, fi), 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(220, 224, 230, 0.55)';
        ctx.fill();
      }
    }

    // 起きたイベントの跡（盗んだ棚・脱出・ダウトの場所）
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const ev of this.events) {
      const et = ev.at - start;
      if (et > t) break;
      const fresh = t - et < 2500;
      ctx.globalAlpha = fresh ? 1 : 0.75;
      if (ev.type === 'steal') {
        const spot = this.world.spots[ev.spotIdx];
        if (!spot) continue;
        const x = tx(spot.x, spot.floor);
        const y = tz(spot.z, spot.floor);
        this.star(x, y, fresh ? 9 : 6, '#ffd54f');
      } else if (ev.type === 'caught' || ev.type === 'escape') {
        const p = this.posAt(ev.type === 'caught' ? ev.mouseId : ev.by, et);
        if (!p) continue;
        const x = tx(p.x, p.f);
        const y = tz(p.z, p.f);
        if (ev.type === 'caught') this.cross(x, y, fresh ? 10 : 7, '#ff5252');
        else {
          ctx.beginPath();
          ctx.arc(x, y, fresh ? 10 : 7, 0, Math.PI * 2);
          ctx.strokeStyle = '#43a047';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = '#43a047';
          ctx.fillText(`+${pt(ev.value)}`, x, y - 12);
        }
      } else if (ev.type === 'miss') {
        const npc = this.world.npcs[ev.npcIdx];
        if (!npc) continue;
        const p = npc.posAt(Math.max(0, et / 1000));
        const fi = Math.min(mapData.floors.length - 1, Math.max(0, p.layer));
        this.cross(tx(p.x, fi), tz(p.z, fi), fresh ? 7 : 5, 'rgba(200, 200, 210, 0.9)');
      }
    }
    ctx.globalAlpha = 1;

    // まんびきサイドの軌跡と現在位置
    for (const [pid, p] of Object.entries(this.info.players ?? {})) {
      if (!this.isMouse(p.role)) continue;
      const team = teamOf(p.role);
      const teamColor = team ? TEAM_COLORS[team] : '#ffffff';
      const samples = this.tracks.get(pid) ?? [];
      if (this.trailChk.checked && samples.length > 1) {
        ctx.beginPath();
        let pen = false;
        let prev: Sample | null = null;
        for (const s of samples) {
          if (s.t > t) break;
          if (s.flags & TRACK_HIDDEN) break;
          const x = tx(s.x, s.f);
          const y = tz(s.z, s.f);
          // フロアが変わる・間隔が開いたところでは線を切る
          if (!pen || !prev || prev.f !== s.f || s.t - prev.t > INTERP_MAX_MS) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
          pen = true;
          prev = s;
        }
        ctx.strokeStyle = teamColor;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      const pos = this.posAt(pid, t);
      if (!pos) continue;
      const x = tx(pos.x, pos.f);
      const y = tz(pos.z, pos.f);
      const hidden = !!(pos.flags & TRACK_HIDDEN);
      ctx.globalAlpha = hidden ? 0.35 : 1;
      // 向き（進行方向の三角）
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(Math.cos(pos.ry), Math.sin(pos.ry)) + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(-5, -7);
      ctx.lineTo(5, -7);
      ctx.closePath();
      ctx.fillStyle = teamColor;
      ctx.fill();
      ctx.restore();
      // 盗み中は黄色いリングで示す
      if (pos.flags & TRACK_SWAY) {
        ctx.beginPath();
        ctx.arc(x, y, 12 + 2 * Math.sin(t / 120), 0, Math.PI * 2);
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = hex(p.color ?? 0x888888);
      ctx.fill();
      ctx.strokeStyle = teamColor;
      ctx.lineWidth = 3;
      ctx.stroke();
      // 名前（退場・脱出の状態も添える）
      let label = p.name;
      if (hidden) {
        const caught = this.events.some((e) => e.type === 'caught' && e.mouseId === pid && e.at - start <= t);
        label += caught ? '（退場）' : '（脱出）';
      }
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.strokeText(label, x, y - 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y - 16);
      ctx.globalAlpha = 1;
    }
  }

  private star(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.45;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private cross(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  /** リソース解放（購読・rAF・イベントリスナ・DOM） */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unsubIndex?.();
    this.unsubIndex = null;
    this.unsubTurn?.();
    this.unsubTurn = null;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}
