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
}

export interface PhaseState {
  phase: 'lobby' | 'playing' | 'ended';
  startAt?: number;
  seed?: number;
  round?: Round;
  /** 前ラウンドの終了理由（ラウンド開始時のバナー表示用） */
  note?: string;
  winner?: Team | 'draw';
  reason?: string;
  scoreA?: number;
  scoreB?: number;
}

export interface PosMsg {
  x: number;
  z: number;
  ry: number;
  t: number;
}

export type GameEvent =
  | { type: 'steal'; by: string; spotIdx: number; round: Round; at: number }
  /** valueは持ち出した商品の合計金額（円）。この値がチームスコアに加算される */
  | { type: 'escape'; by: string; value: number; round: Round; at: number }
  | { type: 'miss'; by: string; npcIdx: number; round: Round; at: number }
  | { type: 'caught'; by: string; mouseId: string; round: Round; at: number };
