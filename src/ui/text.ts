import { TEAM_LABELS, TEAM_NAMES, type Team } from '../types';

/**
 * 画面に出す用語をここに集約する（共同制作資料の「フロー」章に合わせる）。
 * - サイド: まんびきサイド（攻撃） / 監視サイド（守備）
 * - ターン: 1分の攻守どちらか（コード上の round）。ラウンド: 第1ターン＋第2ターン（コード上の set）
 * - 得点: pt
 */

export const SIDE_MICE = 'まんびきサイド';
export const SIDE_WATCH = '監視サイド';

/** サイド名（アイコン付き） */
export function sideLabel(mice: boolean): string {
  return mice ? `🐭 ${SIDE_MICE}` : `📹 ${SIDE_WATCH}`;
}

/** 第1ターン / 第2ターン */
export function turnLabel(round: number): string {
  return `第${round}ターン`;
}

/** 1st ROUND / 2nd ROUND / 3rd ROUND … */
export function roundLabel(set: number): string {
  return `${ordinal(set)} ROUND`;
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** 得点の表記（例: 150pt） */
export function pt(n: number): string {
  return `${n}pt`;
}

/** TEAM PINK / TEAM BLUE */
export function teamLabel(team: Team): string {
  return TEAM_LABELS[team];
}

/** PINK / BLUE */
export function teamName(team: Team): string {
  return TEAM_NAMES[team];
}
