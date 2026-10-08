/**
 * ゲームパッド入力の読み取り（PS4 の DualShock 4 を想定。Gamepad API の standard マッピング）。
 * Gamepad API にはボタンのイベントが無いので、使う側が毎フレーム activePad() を読んで前フレームと比べる。
 */

/** standard マッピングのボタン番号（DualShock 4 の刻印） */
export const PAD = {
  cross: 0,
  circle: 1,
  square: 2,
  triangle: 3,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;

/** スティックの遊び。これ未満の傾きは0として扱う（ドリフト対策） */
const DEADZONE = 0.2;

/** 接続中のゲームパッド（standard マッピングの最初の1台）。無ければ null */
export function activePad(): Gamepad | null {
  if (typeof navigator.getGamepads !== 'function') return null;
  let pads: (Gamepad | null)[];
  try {
    pads = navigator.getGamepads();
  } catch {
    // 権限ポリシーで禁止されているページでは例外になる
    return null;
  }
  for (const p of pads) {
    if (p?.connected && p.mapping === 'standard') return p;
  }
  return null;
}

/** スティックの傾き（x: 右が+、y: 下が+）。遊びを除いて長さ0〜1に直す */
export function padStick(pad: Gamepad | null, side: 'left' | 'right'): { x: number; y: number } {
  const i = side === 'left' ? 0 : 2;
  const x = pad?.axes[i] ?? 0;
  const y = pad?.axes[i + 1] ?? 0;
  const len = Math.hypot(x, y);
  if (len < DEADZONE) return { x: 0, y: 0 };
  const k = Math.min(1, (len - DEADZONE) / (1 - DEADZONE)) / len;
  return { x: x * k, y: y * k };
}

/**
 * スティックの1軸だけの値（-1〜1）。遊びを軸ごとに取るので、
 * 真上に倒したつもりの僅かな左右のずれが旋回になる、といった混ざりを防げる
 */
export function padAxis(pad: Gamepad | null, index: number, deadzone: number = DEADZONE): number {
  const v = pad?.axes[index] ?? 0;
  const a = Math.abs(v);
  if (a < deadzone) return 0;
  return Math.sign(v) * Math.min(1, (a - deadzone) / (1 - deadzone));
}
