/**
 * ステージエディタ製のステージ。
 * エディタはマス目（1マス = ワールド1単位）で編集し、ゲームには StageDef に変換して渡す。
 * データはブラウザ（localStorage）に保存し、JSONで書き出し/読み込みできる。
 * 対戦ではルーム作成者が rooms/{room}/match.custom に書いて全員に配る。
 *
 * マス座標は左上が原点（x: 右が正、y: 手前が正）。y=0 の辺が奥の壁（出口側）。
 * w×h マスは壁の内側の広さ（壁の内面がマス目の外周に一致する）。
 */
import { PRICE_TIERS } from '../config';
import { GONDOLA_H, ISLAND_H, registerStage, type Rect, type ShelfDef, type Side, type StageDef } from './stages';
import { WALL_T } from './world';

export interface CustomShelf {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 料金帯（config.PRICE_TIERS のインデックス）。-1 はおまかせ（全商品からランダム） */
  tier: number;
  /** 平台（低い棚。カメラの視線を遮らない） */
  low: boolean;
  /** 売り場ラベル（マップに表示。空でもよい） */
  label: string;
}

/** 防犯カメラ。位置 (x,y) と注視点 (ax,ay)。0.5マス刻み */
export interface CustomCam {
  x: number;
  y: number;
  ax: number;
  ay: number;
}

export interface CustomStageData {
  v: 1;
  id: string;
  name: string;
  /** 広さ（マス） */
  w: number;
  h: number;
  shelves: CustomShelf[];
  cams: CustomCam[];
  /** 出口（奥の壁）。x は左端のマス、w は幅（マス） */
  exit: { x: number; w: number };
  /** ネズミプレイヤーの初期位置（マス）。チームの1人目・2人目 */
  spawns: [{ x: number; y: number }, { x: number; y: number }];
  /** ダミーNPCの人数 */
  npcCount: number;
}

export const STAGE_LIMITS = {
  minW: 12,
  maxW: 60,
  minH: 10,
  maxH: 40,
  maxNpc: 150,
  minExitW: 2,
  maxExitW: 6,
  maxName: 16,
  maxLabel: 8,
} as const;

/** おまかせ（全商品からランダム）の料金帯 */
export const TIER_RANDOM = -1;

const LS_KEY = 'dorobo-stages';
/** 棚の面から盗みスポットまでの距離（world.ts の自動配置と同じ） */
const SPOT_OFF = 0.7;
/** 盗みスポットの間隔の目安（マス） */
const SPOT_PITCH = 2.8;

export function newStageId(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`;
}

/** 空のステージ（壁と出口・スポーンだけ） */
export function newStageData(name: string): CustomStageData {
  const w = 28;
  const h = 20;
  return {
    v: 1,
    id: newStageId(),
    name,
    w,
    h,
    shelves: [],
    cams: [],
    exit: { x: Math.floor((w - 3) / 2), w: 3 },
    spawns: [
      { x: Math.floor(w * 0.3), y: h - 3 },
      { x: Math.floor(w * 0.7), y: h - 3 },
    ],
    npcCount: 28,
  };
}

/**
 * 名前・ラベルを整える。他の人が作ったステージの名前はロビーやリザルトのHTMLにそのまま入るので、
 * HTMLとして解釈される文字は落とす
 */
export function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[<>&"'`]/g, '').trim().slice(0, max) : '';
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const int = (v: unknown, fallback: number) => Math.round(num(v, fallback));
const half = (v: unknown, fallback: number) => Math.round(num(v, fallback) * 2) / 2;
/** Firebase は配列を（空なら消し、穴があればオブジェクトにして）返すことがあるので配列に戻す */
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

/**
 * 外から来たデータ（JSON読み込み・localStorage・ルームの match.custom）を正しい形に整える。
 * 範囲外の値は丸め、壊れた要素は捨てる。ステージとして読めなければ null
 */
export function normalizeStageData(raw: unknown): CustomStageData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.w !== 'number' || typeof r.h !== 'number') return null;
  const L = STAGE_LIMITS;
  const w = clamp(int(r.w, 28), L.minW, L.maxW);
  const h = clamp(int(r.h, 20), L.minH, L.maxH);

  const shelves: CustomShelf[] = [];
  for (const item of list(r.shelves)) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    // はみ出した分は切り落とす
    const x0 = clamp(int(s.x, 0), 0, w);
    const y0 = clamp(int(s.y, 0), 0, h);
    const x1 = clamp(int(s.x, 0) + int(s.w, 1), 0, w);
    const y1 = clamp(int(s.y, 0) + int(s.h, 1), 0, h);
    if (x1 <= x0 || y1 <= y0) continue;
    const tier = int(s.tier, TIER_RANDOM);
    shelves.push({
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      tier: tier >= 0 && tier < PRICE_TIERS.length ? tier : TIER_RANDOM,
      low: s.low === true,
      label: cleanText(s.label, L.maxLabel),
    });
  }

  const cams: CustomCam[] = [];
  for (const item of list(r.cams)) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const x = clamp(half(c.x, 0), 0, w);
    const y = clamp(half(c.y, 0), 0, h);
    let ax = clamp(half(c.ax, w / 2), 0, w);
    const ay = clamp(half(c.ay, h / 2), 0, h);
    if (ax === x && ay === y) ax = x < w ? x + 1 : x - 1; // 注視点が位置と同じだと向きが決まらない
    cams.push({ x, y, ax, ay });
  }

  const ex = (r.exit ?? {}) as Record<string, unknown>;
  const exitW = clamp(int(ex.w, 3), L.minExitW, L.maxExitW);
  const exit = { x: clamp(int(ex.x, Math.floor((w - exitW) / 2)), 0, w - exitW), w: exitW };

  const sp = list(r.spawns);
  const spawn = (i: number, fx: number) => {
    const p = (sp[i] ?? {}) as Record<string, unknown>;
    return { x: clamp(int(p.x, Math.floor(w * fx)), 0, w - 1), y: clamp(int(p.y, h - 3), 0, h - 1) };
  };

  return {
    v: 1,
    id: typeof r.id === 'string' && /^c_[a-z0-9]+$/.test(r.id) ? r.id : newStageId(),
    name: cleanText(r.name, L.maxName) || '名称未設定',
    w,
    h,
    shelves,
    cams,
    exit,
    spawns: [spawn(0, 0.3), spawn(1, 0.7)],
    npcCount: clamp(int(r.npcCount, 28), 0, L.maxNpc),
  };
}

/** どのマスが棚で埋まっているか（行優先。1 = 棚） */
export function occupancy(data: CustomStageData): Uint8Array {
  const occ = new Uint8Array(data.w * data.h);
  for (const s of data.shelves) {
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) occ[y * data.w + x] = 1;
    }
  }
  return occ;
}

const SIDES: readonly Side[] = ['n', 's', 'e', 'w'];

/**
 * 棚の1面に沿って、前が通路（空きマス）になっている連続区間を返す（[開始, 長さ]。面に沿ったマス単位）。
 * 壁や別の棚に接している部分は盗めないので除く
 */
function openRuns(data: CustomStageData, occ: Uint8Array, s: CustomShelf, side: Side): [number, number][] {
  const horizontal = side === 'n' || side === 's';
  const len = horizontal ? s.w : s.h;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= len; i++) {
    let open = false;
    if (i < len) {
      const cx = horizontal ? s.x + i : side === 'w' ? s.x - 1 : s.x + s.w;
      const cy = horizontal ? (side === 'n' ? s.y - 1 : s.y + s.h) : s.y + i;
      open = cx >= 0 && cx < data.w && cy >= 0 && cy < data.h && !occ[cy * data.w + cx];
    }
    if (open && start < 0) start = i;
    if (!open && start >= 0) {
      runs.push([start, i - start]);
      start = -1;
    }
  }
  return runs;
}

/** マス座標の原点（左上）のワールド座標。歩行グリッド（整数座標）がマスの角に乗るよう整数にする */
function origin(data: CustomStageData): { ox: number; oz: number } {
  return { ox: -Math.floor(data.w / 2), oz: -Math.floor(data.h / 2) };
}

/** ゲーム用のステージ定義に変換する */
export function toStageDef(data: CustomStageData, id: string = data.id): StageDef {
  const { ox, oz } = origin(data);
  const occ = occupancy(data);
  const shelves: ShelfDef[] = data.shelves.map((s) => {
    const sides: Side[] = [];
    const spots: { x: number; z: number }[] = [];
    for (const side of SIDES) {
      const runs = openRuns(data, occ, s, side);
      if (runs.length > 0) sides.push(side);
      for (const [start, len] of runs) {
        const count = Math.max(1, Math.round(len / SPOT_PITCH));
        for (let k = 0; k < count; k++) {
          const along = start + (len * (k + 0.5)) / count;
          if (side === 'n') spots.push({ x: ox + s.x + along, z: oz + s.y - SPOT_OFF });
          else if (side === 's') spots.push({ x: ox + s.x + along, z: oz + s.y + s.h + SPOT_OFF });
          else if (side === 'w') spots.push({ x: ox + s.x - SPOT_OFF, z: oz + s.y + along });
          else spots.push({ x: ox + s.x + s.w + SPOT_OFF, z: oz + s.y + along });
        }
      }
    }
    const def: ShelfDef = {
      minX: ox + s.x,
      maxX: ox + s.x + s.w,
      minZ: oz + s.y,
      maxZ: oz + s.y + s.h,
      h: s.low ? ISLAND_H : GONDOLA_H,
      label: s.label,
      sides,
      spots,
    };
    if (s.tier >= 0) def.tier = s.tier;
    return def;
  });
  // 壁は rect の線を中心に立つので、壁の内面がマス目の外周に一致するよう半分だけ外に広げる
  const t = WALL_T / 2;
  const rect: Rect = { minX: ox - t, maxX: ox + data.w + t, minZ: oz - t, maxZ: oz + data.h + t };
  return {
    id,
    name: data.name,
    desc: `${data.w}×${data.h}マス・カメラ${data.cams.length}台（自作）`,
    floors: [
      {
        name: '1F',
        y: 0,
        rect,
        shelves,
        cams: data.cams.map((c) => ({ x: ox + c.x, z: oz + c.y, aimX: ox + c.ax, aimZ: oz + c.ay })),
        exit: { x: ox + data.exit.x + data.exit.w / 2, halfW: data.exit.w / 2 },
      },
    ],
    ramps: [],
    spawns: [
      { x: ox + data.spawns[0].x + 0.5, z: oz + data.spawns[0].y + 0.5 },
      { x: ox + data.spawns[1].x + 0.5, z: oz + data.spawns[1].y + 0.5 },
    ],
    npcCount: data.npcCount,
  };
}

/** 盗みスポットの位置（マス座標）。エディタの表示用 */
export function spotCells(data: CustomStageData): { x: number; y: number }[] {
  const { ox, oz } = origin(data);
  return toStageDef(data).floors[0].shelves.flatMap((s) =>
    (s.spots ?? []).map((p) => ({ x: p.x - ox, y: p.z - oz })),
  );
}

/**
 * カメラの視線を遮る矩形（マス座標）。背の高い棚と外周の壁（出口の隙間は空ける）。
 * world.ts が作る occluders と同じ内容で、エディタの視野プレビューに使う
 */
export function occluderCells(data: CustomStageData): Rect[] {
  const { w, h, exit } = data;
  const rects: Rect[] = data.shelves
    .filter((s) => !s.low)
    .map((s) => ({ minX: s.x, maxX: s.x + s.w, minZ: s.y, maxZ: s.y + s.h }));
  rects.push(
    { minX: -WALL_T, maxX: exit.x, minZ: -WALL_T, maxZ: 0 },
    { minX: exit.x + exit.w, maxX: w + WALL_T, minZ: -WALL_T, maxZ: 0 },
    { minX: -WALL_T, maxX: w + WALL_T, minZ: h, maxZ: h + WALL_T },
    { minX: -WALL_T, maxX: 0, minZ: -WALL_T, maxZ: h + WALL_T },
    { minX: w, maxX: w + WALL_T, minZ: -WALL_T, maxZ: h + WALL_T },
  );
  return rects;
}

/**
 * NPCが歩ける場所。NPCの歩行グリッド（nav.ts）はマスの角（格子点）に乗り、周りの4マスが空いている格子点だけを通る
 * （= 幅1マスの通路には入れない）。出口の前はNPCがたまらないよう除外され、孤立した領域は最大のものだけが残る。
 * 返り値は格子点 (i, j)（i: 1..w-1, j: 1..h-1）が歩けるかどうか（index = j * (w + 1) + i）
 */
export function npcNodes(data: CustomStageData): { walk: Uint8Array; count: number } {
  const { w, h } = data;
  const occ = occupancy(data);
  const stride = w + 1;
  const walk = new Uint8Array(stride * (h + 1));
  const exitC = data.exit.x + data.exit.w / 2;
  for (let j = 1; j < h; j++) {
    for (let i = 1; i < w; i++) {
      if (occ[(j - 1) * w + i - 1] || occ[(j - 1) * w + i] || occ[j * w + i - 1] || occ[j * w + i]) continue;
      // 出口前の除外帯（world.ts の navObstacles: 出口の左右3・奥の壁から1.8まで、余白0.6）
      if (Math.abs(i - exitC) < 3.6 && j < 1.8 - WALL_T / 2 + 0.6) continue;
      walk[j * stride + i] = 1;
    }
  }
  // 最大の連結成分だけを残す
  const comp = new Int32Array(walk.length).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < walk.length; start++) {
    if (!walk[start] || comp[start] >= 0) continue;
    const id = sizes.length;
    sizes.push(0);
    comp[start] = id;
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      sizes[id]++;
      for (const n of [cur - 1, cur + 1, cur - stride, cur + stride]) {
        if (n >= 0 && n < walk.length && walk[n] && comp[n] < 0) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
  let count = 0;
  for (let i = 0; i < walk.length; i++) {
    if (walk[i] && comp[i] !== best) walk[i] = 0;
    if (walk[i]) count++;
  }
  return { walk, count };
}

/** start のマスからプレイヤーが歩いて行けるマス（上下左右に隣り合う空きマス伝い） */
function reachable(data: CustomStageData, occ: Uint8Array, start: { x: number; y: number }): Uint8Array {
  const { w, h } = data;
  const seen = new Uint8Array(w * h);
  if (occ[start.y * w + start.x]) return seen;
  seen[start.y * w + start.x] = 1;
  const stack = [start.y * w + start.x];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const x = cur % w;
    const y = (cur - x) / w;
    const tryCell = (nx: number, ny: number) => {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
      const n = ny * w + nx;
      if (occ[n] || seen[n]) return;
      seen[n] = 1;
      stack.push(n);
    };
    tryCell(x - 1, y);
    tryCell(x + 1, y);
    tryCell(x, y - 1);
    tryCell(x, y + 1);
  }
  return seen;
}

export interface StageCheck {
  /** このままでは遊べない問題（テストプレイ・ルーム作成で選べない） */
  errors: string[];
  /** 遊べるが気を付けたい点 */
  warnings: string[];
}

/** ステージとして成立しているかを調べる */
export function validateStage(data: CustomStageData): StageCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { w, h } = data;
  const occ = occupancy(data);

  const cellCount = data.shelves.reduce((n, s) => n + s.w * s.h, 0);
  if (occ.reduce((n, v) => n + v, 0) !== cellCount) errors.push('棚どうしが重なっています');

  const reach = data.spawns.map((sp) => reachable(data, occ, sp));
  data.spawns.forEach((sp, i) => {
    if (occ[sp.y * w + sp.x]) {
      errors.push(`スポーン地点${i + 1}が棚の上にあります`);
      return;
    }
    let ok = false;
    for (let x = data.exit.x; x < data.exit.x + data.exit.w; x++) if (reach[i][x]) ok = true;
    if (!ok) errors.push(`スポーン地点${i + 1}から出口まで行けません（棚で塞がっています）`);
  });

  const nodes = npcNodes(data);
  if (data.npcCount > 0 && nodes.count === 0) {
    errors.push('NPCが歩ける場所がありません（NPCは幅2マス以上の通路しか歩けません）');
  }

  if (data.shelves.length === 0) warnings.push('棚がありません（盗む商品がありません）');
  else if (spotCells(data).length === 0) warnings.push('盗める棚がありません（棚の前に通路がありません）');
  if (data.cams.length === 0) warnings.push('カメラがありません（猫が店内を見られません）');

  const tall = data.shelves.filter((s) => !s.low);
  data.cams.forEach((c, i) => {
    if (tall.some((s) => c.x > s.x && c.x < s.x + s.w && c.y > s.y && c.y < s.y + s.h)) {
      warnings.push(`カメラ${i + 1}が高い棚の内側にあります（マップに視野が出ません。棚の縁か通路に置いてください）`);
    }
  });

  // プレイヤーは入れるがNPCが通らないマス（幅1マスの通路など）。そこにいるとプレイヤーだとばれる
  if (nodes.count > 0) {
    const stride = w + 1;
    const exitC = data.exit.x + data.exit.w / 2;
    let lonely = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!reach[0][y * w + x] && !reach[1][y * w + x]) continue;
        if (y <= 2 && Math.abs(x + 0.5 - exitC) < 4.6) continue; // 出口前はもともとNPCが来ない
        const near =
          nodes.walk[y * stride + x] ||
          nodes.walk[y * stride + x + 1] ||
          nodes.walk[(y + 1) * stride + x] ||
          nodes.walk[(y + 1) * stride + x + 1];
        if (!near) lonely++;
      }
    }
    if (lonely > 0) {
      warnings.push(`NPCが通らない場所が${lonely}マスあります（幅1マスの通路など。そこにいるとプレイヤーだと分かります）`);
    }
  }
  return { errors, warnings };
}

// ---- 保存（localStorage） ----

/** このブラウザに保存されている自作ステージ */
export function loadStages(): CustomStageData[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    const out: CustomStageData[] = [];
    for (const item of list(raw)) {
      const data = normalizeStageData(item);
      if (data && !out.some((s) => s.id === data.id)) out.push(data);
    }
    return out;
  } catch {
    // localStorage が使えない・壊れている場合は空
    return [];
  }
}

/** 保存できたら true */
export function saveStages(stages: CustomStageData[]): boolean {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(stages));
    return true;
  } catch {
    return false;
  }
}

/** 外から来たデータ（ルームの match.custom）をステージとして登録する。読めなければ何もしない */
export function registerCustomStage(id: string, raw: unknown): void {
  const data = normalizeStageData(raw);
  if (data) registerStage(toStageDef(data, id));
}
