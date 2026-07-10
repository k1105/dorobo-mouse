export type Role = 'mouse1' | 'mouse2' | 'catSeeker' | 'catCamera' | 'none';

export const ROLE_LABELS: Record<Role, string> = {
  mouse1: 'ネズミ 1',
  mouse2: 'ネズミ 2',
  catSeeker: '猫（鬼）',
  catCamera: '猫（カメラ監視）',
  none: '未選択',
};

export function isMouse(role: Role): boolean {
  return role === 'mouse1' || role === 'mouse2';
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
  winner?: 'mice' | 'cats';
  reason?: string;
}

export interface PosMsg {
  x: number;
  z: number;
  ry: number;
  t: number;
}

export type GameEvent =
  | { type: 'steal'; by: string; spotIdx: number; at: number }
  | { type: 'alert'; by: string; camId: number; at: number }
  | { type: 'miss'; by: string; npcIdx: number; at: number }
  | { type: 'caught'; by: string; mouseId: string; at: number }
  | { type: 'escape'; by: string; at: number };
