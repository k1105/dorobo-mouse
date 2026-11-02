import { CONFIG } from './config';

export type Role = 'a1' | 'a2' | 'b1' | 'b2' | 'none';
/** チーム。A = TEAM PINK、B = TEAM BLUE（色は固定。どちらが先にまんびきするかは試合ごとに決める） */
export type Team = 'A' | 'B';
/** ターン（1ラウンド = 第1ターン＋第2ターン。攻守を入れ替える） */
export type Round = 1 | 2;

export const ROLE_LABELS: Record<Role, string> = {
  a1: 'PINK - 1',
  a2: 'PINK - 2',
  b1: 'BLUE - 1',
  b2: 'BLUE - 2',
  none: '未選択',
};

/** チームの短い名前（PINK / BLUE） */
export const TEAM_NAMES: Record<Team, string> = {
  A: 'PINK',
  B: 'BLUE',
};

/** チームの表示名（TEAM PINK / TEAM BLUE） */
export const TEAM_LABELS: Record<Team, string> = {
  A: 'TEAM PINK',
  B: 'TEAM BLUE',
};

/** チームのテーマ色（CSS） */
export const TEAM_COLORS: Record<Team, string> = {
  A: '#ff6fae',
  B: '#4fb3ff',
};

/** ロビーで選ぶ先攻（どちらのチームが第1ターンにまんびきするか）。random は START 時に決める */
export type FirstPick = Team | 'random';

export function otherTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A';
}

/** 陣営に属する枠（先着順に埋める） */
export function rolesOfTeam(team: Team): Role[] {
  return team === 'A' ? ['a1', 'a2'] : ['b1', 'b2'];
}

export function teamOf(role: Role): Team | null {
  if (role === 'a1' || role === 'a2') return 'A';
  if (role === 'b1' || role === 'b2') return 'B';
  return null;
}

/** そのターンでまんびきサイド（攻撃側）になるチーム。firstMice は第1ターンにまんびきするチーム */
export function miceTeamOf(round: Round, firstMice: Team): Team {
  return round === 1 ? firstMice : otherTeam(firstMice);
}

/** role がそのターンでまんびきサイドかどうか */
export function isMouseInRound(role: Role, round: Round, firstMice: Team): boolean {
  return teamOf(role) === miceTeamOf(round, firstMice);
}

export interface PlayerInfo {
  name: string;
  role: Role;
  joinedAt: number;
  /** 変装（カプセル）の色（config.AVATAR_PALETTE の hex。入室時と各ターンの作戦会議でランダムに決まる） */
  color?: number;
}

/** 1セット（第1ターン＋第2ターン）の結果 */
export interface SetResult {
  scoreA: number;
  scoreB: number;
}

/** ルーム作成時にホストが決める試合構成 */
export interface MatchConfig {
  /** セット数（1セット = 第1ターン＋第2ターンの攻守交代1回） */
  sets: number;
  /** セットごとのステージID */
  stages: string[];
  /**
   * stages で使うステージエディタ製ステージのデータ（ID → game/customStage.ts の CustomStageData）。
   * ルーム作成者のブラウザにしか無いので、ルームに書いて全員に配る
   */
  custom?: Record<string, unknown>;
}

/** 各セットの勝敗から獲得セット数を数える（同点は両者に入れない） */
export function setsWon(results: readonly SetResult[]): { a: number; b: number } {
  let a = 0;
  let b = 0;
  for (const r of results) {
    if (r.scoreA > r.scoreB) a++;
    else if (r.scoreB > r.scoreA) b++;
  }
  return { a, b };
}

export interface PhaseState {
  /**
   * lobby: ロビー / planning: 作戦会議タイム（until まで。各ターンの前） /
   * playing: ターン進行中（startAt から。開始前にフィールドインサート＋カウントダウン） /
   * setEnd: セット終了のリザルト表示（until まで。次のセットがある場合） / ended: 試合終了（最終成績 → セレモニー）
   */
  phase: 'lobby' | 'planning' | 'playing' | 'setEnd' | 'ended';
  startAt?: number;
  /** planning / setEnd フェーズの終了時刻 */
  until?: number;
  /** 商品配置・NPC の seed。作戦会議の時点で決まっている（作戦会議のマップに値段を出すため） */
  seed?: number;
  round?: Round;
  /** 第1ターンにまんびきサイドになるチーム（START 時に確定。試合中持ち回る） */
  firstMice?: Team;
  /** 現在のセット番号（1始まり）と総セット数 */
  set?: number;
  sets?: number;
  /** セットごとのステージID（ルーム作成時の設定を持ち回る） */
  stages?: string[];
  /** 終了したセットの結果（進行中のセットは含まない） */
  results?: SetResult[];
  /** 現在のセットのステージID（game/stages.ts）。未指定ならスタンダード */
  stage?: string;
  /** 前ターンの終了理由（ターン開始時のバナー表示用） */
  note?: string;
  winner?: Team | 'draw';
  reason?: string;
  scoreA?: number;
  scoreB?: number;
  /** 移動ログのID（logIndex/{logId}・logs/{logId}）。START 時に発行し、試合中持ち回る。無ければ記録しない */
  logId?: string;
}

/**
 * 誰もいなくなった部屋に残った試合の残骸かどうか。
 * 進行中の試合なら1ターンの時間内に必ず phase が書き換わる（startAt が更新される）ので、
 * それより十分古い startAt の 'playing' は途中で全員が抜けた試合とみなしてロビー扱いにする
 */
export function isStalePhase(phase: PhaseState): boolean {
  if (phase.phase === 'planning' || phase.phase === 'setEnd') {
    return !!phase.until && Date.now() - phase.until > 30 * 1000;
  }
  if (phase.phase !== 'playing' || !phase.startAt) return false;
  return (
    Date.now() - phase.startAt > (CONFIG.introSec + CONFIG.countdownSec + CONFIG.roundTimeSec + 30) * 1000
  );
}

export interface PosMsg {
  x: number;
  z: number;
  ry: number;
  t: number;
  /** フロア番号（複数フロアのステージ用。省略時は1F） */
  f?: number;
  /** リスポーン待ち中は姿を消す（他クライアントは表示しない） */
  hidden?: boolean;
  /** 盗みモーション中。受信側が揺れをローカルで再生する（低頻度送信+補間だと揺れが潰れるため） */
  sway?: boolean;
}

/** イベント共通: どのセット・ターンのものか（set は省略時1） */
interface EventBase {
  by: string;
  round: Round;
  set?: number;
  at: number;
}

export type GameEvent =
  | ({ type: 'steal'; spotIdx: number } & EventBase)
  /** valueは持ち出した商品の合計ポイント。この値がチームスコアに加算される */
  | ({ type: 'escape'; value: number } & EventBase)
  | ({ type: 'miss'; npcIdx: number } & EventBase)
  | ({ type: 'caught'; mouseId: string } & EventBase);

// ---- 移動ログ（後から再生するための記録） ----
// 軽い情報（試合・ターンのメタ）は logIndex/{logId}、重い情報（軌跡・イベント・カメラ）は logs/{logId}/{turnKey} に分けて、
// ログモニターが一覧表示のときに軌跡まで読み込まなくて済むようにしている

/** ログに残すプレイヤー情報（ターン開始時点のスナップショット。color はそのターンの変装） */
export interface LogPlayer {
  name: string;
  role: Role;
  color?: number;
}

/** 1ターンの情報（logIndex/{logId}/turns/{turnKey}/info。ターン開始時にホストが書く） */
export interface LogTurnInfo {
  set: number;
  round: Round;
  stage: string;
  seed: number;
  /** ターン開始時刻（カウントダウン後。軌跡の t はここからのミリ秒） */
  startAt: number;
  firstMice: Team;
  players: Record<string, LogPlayer>;
}

/** ターン終了の情報（logIndex/{logId}/turns/{turnKey}/end。ターンを終わらせたクライアントが書く） */
export interface LogTurnEnd {
  at: number;
  reason: string;
  scoreA: number;
  scoreB: number;
}

/** 試合のメタ情報（logIndex/{logId}。START 時にホストが書き、turns はターンごとに増える） */
export interface LogMeta {
  room: string;
  createdAt: number;
  sets: number;
  stages: string[];
  firstMice: Team;
  /** 使った自作ステージのデータ（ID → CustomStageData）。再生時に登録してから getStage で引く */
  custom?: Record<string, unknown>;
  turns?: Record<string, { info?: LogTurnInfo; end?: LogTurnEnd }>;
}

/** 監視サイドのカメラ切替の記録（t はターン開始からのミリ秒） */
export interface LogCamEntry {
  t: number;
  ids: number[];
}

/** 1ターンの重いログ（logs/{logId}/{turnKey}）。tracks の各チャンクは TRACK_STRIDE 個ずつの数値列 */
export interface TurnLog {
  tracks?: Record<string, Record<string, number[]>>;
  events?: Record<string, GameEvent>;
  cams?: Record<string, Record<string, LogCamEntry>>;
}

/** 軌跡1サンプルの要素数: t(ms), x, z, ry, floor, flags */
export const TRACK_STRIDE = 6;
/** flags: 退場して姿を消している */
export const TRACK_HIDDEN = 1;
/** flags: 盗みモーション中 */
export const TRACK_SWAY = 2;

/** ターンのログのキー（例: s1r2 = 1st ROUND 第2ターン） */
export function logTurnKey(set: number, round: number): string {
  return `s${set}r${round}`;
}
