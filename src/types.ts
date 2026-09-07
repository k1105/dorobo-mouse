import { CONFIG } from './config';

export type Role = 'a1' | 'a2' | 'b1' | 'b2' | 'none';
export type Team = 'A' | 'B';
export type Round = 1 | 2;

export const ROLE_LABELS: Record<Role, string> = {
  a1: 'チームA - 1',
  a2: 'チームA - 2',
  b1: 'チームB - 1',
  b2: 'チームB - 2',
  none: '未選択',
};

/** 陣営の表示名。先攻=前半にネズミ（チームA）、後攻=前半に猫（チームB） */
export const TEAM_LABELS: Record<Team, string> = {
  A: '先攻陣営',
  B: '後攻陣営',
};

/** 陣営に属する枠（先着順に埋める） */
export function rolesOfTeam(team: Team): Role[] {
  return team === 'A' ? ['a1', 'a2'] : ['b1', 'b2'];
}

export function teamOf(role: Role): Team | null {
  if (role === 'a1' || role === 'a2') return 'A';
  if (role === 'b1' || role === 'b2') return 'B';
  return null;
}

/** そのラウンドでネズミ（攻撃側）になるチーム。前半=A、後半=B */
export function miceTeamOf(round: Round): Team {
  return round === 1 ? 'A' : 'B';
}

/** roleがそのラウンドでネズミかどうか */
export function isMouseInRound(role: Role, round: Round): boolean {
  return teamOf(role) === miceTeamOf(round);
}

export interface PlayerInfo {
  name: string;
  role: Role;
  joinedAt: number;
  /** アバター（カプセル）の色（着せ替えで選ぶ。config.AVATAR_PALETTE の hex） */
  color?: number;
}

/** 1セット（前半＋後半）の結果 */
export interface SetResult {
  scoreA: number;
  scoreB: number;
}

/** ルーム作成時にホストが決める試合構成 */
export interface MatchConfig {
  /** セット数（1セット = 前半＋後半の攻守交代1回） */
  sets: number;
  /** セットごとのステージID */
  stages: string[];
}

/** 各セットの勝敗から獲得セット数を数える（同額は両者に入れない） */
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
   * lobby: ロビー / costume: 着せ替え・作戦会議（until まで。各ラウンドの前） /
   * playing: ラウンド進行中（startAt から。前半は開始前にステージ紹介＋カウントダウン） /
   * setEnd: セット終了のリザルト表示（until まで。次のセットがある場合） / ended: 試合終了（最終成績）
   */
  phase: 'lobby' | 'costume' | 'playing' | 'setEnd' | 'ended';
  startAt?: number;
  /** costume / setEnd フェーズの終了時刻 */
  until?: number;
  seed?: number;
  round?: Round;
  /** 現在のセット番号（1始まり）と総セット数 */
  set?: number;
  sets?: number;
  /** セットごとのステージID（ルーム作成時の設定を持ち回る） */
  stages?: string[];
  /** 終了したセットの結果（進行中のセットは含まない） */
  results?: SetResult[];
  /** 現在のセットのステージID（game/stages.ts）。未指定ならスタンダード */
  stage?: string;
  /** 前ラウンドの終了理由（ラウンド開始時のバナー表示用） */
  note?: string;
  winner?: Team | 'draw';
  reason?: string;
  scoreA?: number;
  scoreB?: number;
}

/**
 * 誰もいなくなった部屋に残った試合の残骸かどうか。
 * 進行中の試合なら1ラウンドの時間内に必ず phase が書き換わる（startAt が更新される）ので、
 * それより十分古い startAt の 'playing' は途中で全員が抜けた試合とみなしてロビー扱いにする
 */
export function isStalePhase(phase: PhaseState): boolean {
  if (phase.phase === 'costume' || phase.phase === 'setEnd') {
    return !!phase.until && Date.now() - phase.until > 30 * 1000;
  }
  if (phase.phase !== 'playing' || !phase.startAt) return false;
  return Date.now() - phase.startAt > (CONFIG.countdownSec + CONFIG.roundTimeSec + 30) * 1000;
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

/** イベント共通: どのセット・ラウンドのものか（set は省略時1） */
interface EventBase {
  by: string;
  round: Round;
  set?: number;
  at: number;
}

export type GameEvent =
  | ({ type: 'steal'; spotIdx: number } & EventBase)
  /** valueは持ち出した商品の合計金額（円）。この値がチームスコアに加算される */
  | ({ type: 'escape'; value: number } & EventBase)
  | ({ type: 'miss'; npcIdx: number } & EventBase)
  | ({ type: 'caught'; mouseId: string } & EventBase);
