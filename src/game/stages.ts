/**
 * ステージ（店のレイアウト）定義。
 * ロビーでホストが選び、phase.stage で全クライアントに共有される。
 * 座標は XZ 平面。z負側が「奥」（出口側）、z正側が「手前」（ネズミのスポーン側）。
 * フロアは floors[0] が1F。上階は y（床面の高さ）を持ち、スロープ（ramps）で行き来する。
 */

/** XZ平面上の矩形（衝突判定用） */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** 盗みスポット・商品飾りを置く面。n=z負側(奥/出口側), s=z正側(手前), e=x正側, w=x負側 */
export type Side = 'n' | 's' | 'e' | 'w';

export interface ShelfDef {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h: number;
  label: string;
  sides: Side[];
  /** 料金帯（config.PRICE_TIERS のインデックス）。指定するとその帯の商品だけが割り当てられる。未指定は全商品からランダム */
  tier?: number;
  /** 盗みスポットの位置を直接指定する（ステージエディタ製）。未指定なら sides に沿って自動配置する */
  spots?: { x: number; z: number }[];
}

/** 防犯カメラ。位置と注視点（死角設計はここを調整する） */
export interface CamDef {
  x: number;
  z: number;
  aimX: number;
  aimZ: number;
  range?: number;
}

export interface FloorDef {
  /** 表示名（マップの見出し） */
  name: string;
  /** 床面の高さ */
  y: number;
  /** 床の範囲。外周には壁（1F）または手すり（上階）が立つ */
  rect: Rect;
  shelves: ShelfDef[];
  cams: CamDef[];
  /** 出口（minZ側の壁の隙間）。1Fのみ */
  exit?: { x: number; halfW: number };
}

/**
 * スロープ。rect の範囲が坂で、up の方向へ進むほど高くなり floors[from] から floors[to] へ上がる。
 * 上階では rect が吹き抜け（穴）になる。両端以外の辺には手すりが立ち、横からは出入りできない。
 */
export interface RampDef {
  rect: Rect;
  up: Side;
  from: number;
  to: number;
}

export type StageId = 'standard' | 'simple' | 'twofloor';

export interface StageDef {
  /** 組み込みは StageId。ステージエディタ製は 'c_' で始まるID */
  id: string;
  name: string;
  desc: string;
  floors: FloorDef[];
  ramps: RampDef[];
  /** ネズミプレイヤーの初期位置（1F）。チームの1人目・2人目 */
  spawns: [{ x: number; z: number }, { x: number; z: number }];
  npcCount: number;
}

const CASE_H = 2.0; // 壁面ケース
export const GONDOLA_H = 2.2; // 中央ゴンドラ
export const ISLAND_H = 1.0; // 平台（低いのでカメラの視線は通る）

// ---------------------------------------------------------------------------
// スタンダード（従来のレイアウト）
// ---------------------------------------------------------------------------

// 店内レイアウト。通路幅はプレイヤー・NPCが通れるよう最低2.4を確保する
const STANDARD_SHELVES: ShelfDef[] = [
  // ---- 壁面ケース ----
  { minX: -20.7, maxX: -19.5, minZ: -11, maxZ: 5, h: CASE_H, label: '鮮魚', sides: ['e'] },
  { minX: -20.7, maxX: -19.5, minZ: 7, maxZ: 12, h: CASE_H, label: '塩干', sides: ['e'] },
  { minX: -19.5, maxX: -3.5, minZ: -13.7, maxZ: -12.5, h: CASE_H, label: '精肉', sides: ['s'] },
  { minX: 3.5, maxX: 13, minZ: -13.7, maxZ: -12.5, h: CASE_H, label: '惣菜', sides: ['s'] },
  { minX: 13, maxX: 19.5, minZ: -13.7, maxZ: -12.5, h: CASE_H, label: 'ベーカリー', sides: ['s'] },
  { minX: 19.5, maxX: 20.7, minZ: -11, maxZ: -1, h: CASE_H, label: '酒', sides: ['w'] },
  { minX: 19.5, maxX: 20.7, minZ: 1, maxZ: 11, h: CASE_H, label: '飲料', sides: ['w'] },
  { minX: -19.5, maxX: -6, minZ: 12.5, maxZ: 13.7, h: CASE_H, label: '日配', sides: ['n'] },
  { minX: -2, maxX: 10, minZ: 12.5, maxZ: 13.7, h: CASE_H, label: '冷凍食品', sides: ['n'] },
  { minX: 12, maxX: 19.5, minZ: 12.5, maxZ: 13.7, h: CASE_H, label: '青果', sides: ['n'] },
  // ---- 左ゾーン（縦ゴンドラ、中央に横断通路） ----
  { minX: -16.8, maxX: -15.2, minZ: -9, maxZ: -3, h: GONDOLA_H, label: '精肉', sides: ['e', 'w'] },
  { minX: -16.8, maxX: -15.2, minZ: 1, maxZ: 9, h: GONDOLA_H, label: '鮮魚', sides: ['e', 'w'] },
  { minX: -10.8, maxX: -9.2, minZ: -9, maxZ: -3, h: GONDOLA_H, label: '日配', sides: ['e', 'w'] },
  { minX: -10.8, maxX: -9.2, minZ: 1, maxZ: 9, h: GONDOLA_H, label: '冷凍', sides: ['e', 'w'] },
  // ---- 中央ゾーン（横ゴンドラ4列 × 2区間。x=3〜5が縦の横断通路） ----
  { minX: -6, maxX: 3, minZ: -8.8, maxZ: -7.2, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -8.8, maxZ: -7.2, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: -4.8, maxZ: -3.2, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -4.8, maxZ: -3.2, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: -0.8, maxZ: 0.8, h: GONDOLA_H, label: '飲料', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: -0.8, maxZ: 0.8, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: -6, maxX: 3, minZ: 3.2, maxZ: 4.8, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: 5, maxX: 15, minZ: 3.2, maxZ: 4.8, h: GONDOLA_H, label: '日配', sides: ['n', 's'] },
  // ---- 平台の島（低い。カメラは上越しに見えるが、通行は塞ぐ） ----
  { minX: -1.2, maxX: 1.2, minZ: -12.3, maxZ: -10.3, h: ISLAND_H, label: '惣菜平台', sides: ['e', 'w', 's'] },
  { minX: -3.1, maxX: -0.9, minZ: 6.9, maxZ: 9.1, h: ISLAND_H, label: '特売', sides: ['n', 's', 'e', 'w'] },
  { minX: 10.7, maxX: 13.3, minZ: 7.2, maxZ: 9.8, h: ISLAND_H, label: '青果平台', sides: ['n', 's', 'e', 'w'] },
  { minX: 15.7, maxX: 18.3, minZ: 7.2, maxZ: 9.8, h: ISLAND_H, label: '青果平台', sides: ['n', 's', 'w'] },
];

const STANDARD_CAMS: CamDef[] = [
  { x: -19.5, z: -11.5, aimX: -10, aimZ: -4 }, // 1: 左上コーナー
  { x: 0, z: -13.2, aimX: 0, aimZ: -4 }, // 2: 出口上から店内向き
  { x: 19.5, z: -11.5, aimX: 10, aimZ: -4 }, // 3: 右上コーナー
  { x: -19.5, z: -1, aimX: -8, aimZ: -1 }, // 4: 左壁中央（左ゾーン横断通路）
  { x: 19.5, z: 0, aimX: 10, aimZ: 0 }, // 5: 右壁中央（中央列の東端）
  { x: -19.5, z: 11.5, aimX: -10, aimZ: 6 }, // 6: 左下コーナー
  { x: -4, z: 13.2, aimX: -2, aimZ: 4 }, // 7: 下壁のケースの隙間（スポーン前通路）
  { x: 19.5, z: 11.5, aimX: 12, aimZ: 7 }, // 8: 右下コーナー（青果）
  { x: 4, z: -10.5, aimX: 4, aimZ: 4 }, // 9: 中央の縦横断通路を南向き
  { x: -8, z: -1, aimX: -16, aimZ: -1 }, // 10: 左ゾーン横断通路を西向き
  { x: -13, z: 10.5, aimX: -13, aimZ: 0 }, // 11: 左ゾーン縦通路を北向き
  { x: 17, z: 2, aimX: 5, aimZ: 2 }, // 12: C-D列間の通路を西向き
];

const STANDARD: StageDef = {
  id: 'standard',
  name: 'スタンダード',
  desc: '広い売り場にカメラ12台。従来のレイアウト',
  floors: [
    {
      name: '1F',
      y: 0,
      rect: { minX: -21, maxX: 21, minZ: -14, maxZ: 14 },
      shelves: STANDARD_SHELVES,
      cams: STANDARD_CAMS,
      exit: { x: 0, halfW: 1.5 },
    },
  ],
  ramps: [],
  spawns: [
    { x: -7.5, z: 10.5 },
    { x: 7.5, z: 10.5 },
  ],
  npcCount: 50,
};

// ---------------------------------------------------------------------------
// シンプル（小さめの売り場・カメラ6台）
// ---------------------------------------------------------------------------

const SIMPLE_SHELVES: ShelfDef[] = [
  // ---- 壁面ケース ----
  { minX: -12.5, maxX: -3.5, minZ: -9.7, maxZ: -8.5, h: CASE_H, label: '精肉', sides: ['s'] },
  { minX: 3.5, maxX: 12.5, minZ: -9.7, maxZ: -8.5, h: CASE_H, label: '惣菜', sides: ['s'] },
  { minX: -13.7, maxX: -12.5, minZ: -6.5, maxZ: 6.5, h: CASE_H, label: '鮮魚', sides: ['e'] },
  { minX: 12.5, maxX: 13.7, minZ: -6.5, maxZ: 6.5, h: CASE_H, label: '飲料', sides: ['w'] },
  { minX: -12.5, maxX: -2.5, minZ: 8.5, maxZ: 9.7, h: CASE_H, label: '日配', sides: ['n'] },
  { minX: 2.5, maxX: 12.5, minZ: 8.5, maxZ: 9.7, h: CASE_H, label: '青果', sides: ['n'] },
  // ---- 中央ゴンドラ（横2列。x=-1〜1 が縦の横断通路） ----
  { minX: -8, maxX: -1.2, minZ: -3.8, maxZ: -2.2, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: 1.2, maxX: 8, minZ: -3.8, maxZ: -2.2, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: -8, maxX: -1.2, minZ: 2.2, maxZ: 3.8, h: GONDOLA_H, label: '冷凍', sides: ['n', 's'] },
  { minX: 1.2, maxX: 8, minZ: 2.2, maxZ: 3.8, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  // ---- 平台 ----
  { minX: -1.1, maxX: 1.1, minZ: -7.6, maxZ: -5.6, h: ISLAND_H, label: '特売', sides: ['e', 'w', 's'] },
];

const SIMPLE_CAMS: CamDef[] = [
  { x: -12.5, z: -8, aimX: -4, aimZ: -1 }, // 1: 左上コーナー
  { x: 12.5, z: -8, aimX: 4, aimZ: -1 }, // 2: 右上コーナー
  { x: 0, z: -9.2, aimX: 0, aimZ: 0 }, // 3: 出口上から店内向き
  { x: -12.5, z: 8, aimX: -4, aimZ: 1 }, // 4: 左下コーナー
  { x: 12.5, z: 8, aimX: 4, aimZ: 1 }, // 5: 右下コーナー
  { x: 11, z: 0, aimX: -8, aimZ: 0 }, // 6: 中央横断通路を西向き
];

const SIMPLE: StageDef = {
  id: 'simple',
  name: 'シンプル',
  desc: '小さな売り場にカメラ6台。短時間で決着がつく',
  floors: [
    {
      name: '1F',
      y: 0,
      rect: { minX: -14, maxX: 14, minZ: -10, maxZ: 10 },
      shelves: SIMPLE_SHELVES,
      cams: SIMPLE_CAMS,
      exit: { x: 0, halfW: 1.5 },
    },
  ],
  ramps: [],
  spawns: [
    { x: -5, z: 6.5 },
    { x: 5, z: 6.5 },
  ],
  npcCount: 28,
};

// ---------------------------------------------------------------------------
// 2フロア（奥半分が2階建て。東側のスロープで行き来する）
// ---------------------------------------------------------------------------

/** 2Fの床面の高さ。1Fのカメラ（3.6）・棚（2.2）より上 */
const FLOOR2_Y = 4.5;

const TWOFLOOR_1F_SHELVES: ShelfDef[] = [
  // ---- 壁面ケース ----
  { minX: -14.5, maxX: -3.5, minZ: -11.7, maxZ: -10.5, h: CASE_H, label: '精肉', sides: ['s'] },
  { minX: 3.5, maxX: 11, minZ: -11.7, maxZ: -10.5, h: CASE_H, label: '惣菜', sides: ['s'] },
  { minX: -15.7, maxX: -14.5, minZ: -9, maxZ: 9, h: CASE_H, label: '鮮魚', sides: ['e'] },
  { minX: 14.5, maxX: 15.7, minZ: 4, maxZ: 9, h: CASE_H, label: '飲料', sides: ['w'] },
  { minX: -14.5, maxX: -2, minZ: 10.5, maxZ: 11.7, h: CASE_H, label: '日配', sides: ['n'] },
  { minX: 2, maxX: 14.5, minZ: 10.5, maxZ: 11.7, h: CASE_H, label: '青果', sides: ['n'] },
  // ---- 奥（2Fの下）のゴンドラ ----
  { minX: -10, maxX: -1, minZ: -7.8, maxZ: -6.2, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: 1, maxX: 10, minZ: -7.8, maxZ: -6.2, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: -10, maxX: -1, minZ: -4.3, maxZ: -2.7, h: GONDOLA_H, label: '冷凍', sides: ['n', 's'] },
  { minX: 1, maxX: 10, minZ: -4.3, maxZ: -2.7, h: GONDOLA_H, label: '日配', sides: ['n', 's'] },
  // ---- 手前（吹き抜け側）のゴンドラ ----
  { minX: -10, maxX: -1, minZ: 1.2, maxZ: 2.8, h: GONDOLA_H, label: '飲料', sides: ['n', 's'] },
  { minX: 1, maxX: 10, minZ: 1.2, maxZ: 2.8, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: -10, maxX: -1, minZ: 5.2, maxZ: 6.8, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  { minX: 1, maxX: 10, minZ: 5.2, maxZ: 6.8, h: GONDOLA_H, label: '塩干', sides: ['n', 's'] },
];

const TWOFLOOR_1F_CAMS: CamDef[] = [
  { x: -14.5, z: -10.5, aimX: -6, aimZ: -4 }, // 1: 1F左上コーナー
  { x: 0, z: -11.2, aimX: 0, aimZ: -3 }, // 2: 出口上から店内向き
  { x: 12, z: -10.5, aimX: 4, aimZ: -4 }, // 3: 1F右上（スロープ上端の下）
  { x: -14.5, z: 0, aimX: -6, aimZ: 0 }, // 4: 左壁中央
  { x: 11.5, z: 4, aimX: 14, aimZ: -3 }, // 5: スロープの上り口を北向き
  { x: -14.5, z: 10.5, aimX: -6, aimZ: 5 }, // 6: 1F左下コーナー
  { x: 14.5, z: 10.5, aimX: 6, aimZ: 5 }, // 7: 1F右下コーナー
  { x: 0, z: 11.2, aimX: 0, aimZ: 3 }, // 8: 手前の壁から店内向き
];

const TWOFLOOR_2F_SHELVES: ShelfDef[] = [
  // ---- 壁面ケース ----
  { minX: -14.5, maxX: -2, minZ: -11.7, maxZ: -10.5, h: CASE_H, label: 'ベーカリー', sides: ['s'] },
  { minX: 2, maxX: 11, minZ: -11.7, maxZ: -10.5, h: CASE_H, label: '酒', sides: ['s'] },
  { minX: -15.7, maxX: -14.5, minZ: -9, maxZ: -2, h: CASE_H, label: '塩干', sides: ['e'] },
  // ---- ゴンドラ1列 ----
  { minX: -11, maxX: -3, minZ: -7.9, maxZ: -6.3, h: GONDOLA_H, label: '菓子', sides: ['n', 's'] },
  { minX: 0, maxX: 8, minZ: -7.9, maxZ: -6.3, h: GONDOLA_H, label: '加工食品', sides: ['n', 's'] },
  // ---- 平台 ----
  { minX: -11, maxX: -3, minZ: -3.7, maxZ: -2.1, h: ISLAND_H, label: '特売', sides: ['n', 's', 'e', 'w'] },
  { minX: 0, maxX: 8, minZ: -3.7, maxZ: -2.1, h: ISLAND_H, label: '青果平台', sides: ['n', 's', 'e', 'w'] },
];

const TWOFLOOR_2F_CAMS: CamDef[] = [
  { x: -14.5, z: -9.5, aimX: -5, aimZ: -4 }, // 9: 2F左奥コーナー
  { x: 11.5, z: -11.2, aimX: 3, aimZ: -5 }, // 10: 2F右奥（スロープ降り口）
  { x: -14.5, z: -0.5, aimX: -5, aimZ: -6 }, // 11: 2F左手前コーナー
  { x: 11, z: 0.4, aimX: 2, aimZ: -6 }, // 12: 2F右手前（吹き抜けの縁）
];

const TWOFLOOR: StageDef = {
  id: 'twofloor',
  name: '2フロア',
  desc: '奥半分が2階建て。東側のスロープで2Fへ。出口は1Fのみ',
  floors: [
    {
      name: '1F',
      y: 0,
      rect: { minX: -16, maxX: 16, minZ: -12, maxZ: 12 },
      shelves: TWOFLOOR_1F_SHELVES,
      cams: TWOFLOOR_1F_CAMS,
      exit: { x: 0, halfW: 1.5 },
    },
    {
      name: '2F',
      y: FLOOR2_Y,
      rect: { minX: -16, maxX: 16, minZ: -12, maxZ: 0.5 },
      shelves: TWOFLOOR_2F_SHELVES,
      cams: TWOFLOOR_2F_CAMS,
    },
  ],
  // 東側の壁沿いを北（奥）へ上る。上り口は吹き抜け側(z=1)、上端(z=-7.5)で2Fに出る
  ramps: [{ rect: { minX: 12.5, maxX: 15.5, minZ: -7.5, maxZ: 1 }, up: 'n', from: 0, to: 1 }],
  spawns: [
    { x: -7.5, z: 9 },
    { x: 7.5, z: 9 },
  ],
  npcCount: 55,
};

export const STAGES: readonly StageDef[] = [STANDARD, SIMPLE, TWOFLOOR];

export const DEFAULT_STAGE_ID: StageId = 'standard';

/** ステージエディタ製のステージ。ルームの試合構成（match.custom）やテストプレイから登録される */
const customStages = new Map<string, StageDef>();

/** ステージエディタ製のステージを登録する（同じIDは上書き） */
export function registerStage(def: StageDef): void {
  customStages.set(def.id, def);
}

/** IDからステージ定義を返す。不明・未指定ならスタンダード */
export function getStage(id: string | undefined | null): StageDef {
  return STAGES.find((s) => s.id === id) ?? customStages.get(id ?? '') ?? STAGES[0];
}
