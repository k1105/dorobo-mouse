import { activePad, padAxis, padStick } from './gamepad';

/** 一人称で左スティックを前後移動・旋回に振り分けるときの軸ごとの遊び（斜めの混ざりを抑えるため広め） */
const FPS_AXIS_DEADZONE = 0.3;

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * キーボードとゲームパッドの入力。WASD/矢印・左スティックで移動、その他のキーはonKeyコールバックで通知。
 * ゲームパッドはイベントが無いので、毎フレーム pollPad() を呼んで読む（ボタンは onPadButton で通知）
 */
export class Controls {
  private keys = new Set<string>();
  onKey: ((code: string) => void) | null = null;
  /** ゲームパッドのボタンが押された(down=true)／離された(false)瞬間に呼ばれる。button は PAD の番号 */
  onPadButton: ((button: number, down: boolean) => void) | null = null;
  private pad: Gamepad | null = null;
  /** 前フレームのボタン状態。作った時点で押されているボタンは「押した瞬間」として扱わない */
  private padDown: boolean[] = (activePad()?.buttons ?? []).map((b) => b.pressed);

  private kd = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keys.add(e.code);
    this.onKey?.(e.code);
  };
  private ku = (e: KeyboardEvent) => this.keys.delete(e.code);
  private blur = () => this.keys.clear();

  constructor() {
    window.addEventListener('keydown', this.kd);
    window.addEventListener('keyup', this.ku);
    window.addEventListener('blur', this.blur);
  }

  /** 毎フレーム呼ぶ。ゲームパッドの状態を読み直し、ボタンの押下・解放を onPadButton で通知する */
  pollPad(): void {
    this.pad = activePad();
    // 切断されたときは全ボタンが離された扱いになる
    const buttons = this.pad?.buttons ?? [];
    const n = Math.max(buttons.length, this.padDown.length);
    for (let i = 0; i < n; i++) {
      const down = buttons[i]?.pressed ?? false;
      if (down === (this.padDown[i] ?? false)) continue;
      this.padDown[i] = down;
      this.onPadButton?.(i, down);
    }
  }

  /**
   * 移動ベクトル（画面上: W=奥(-z), S=手前(+z)）。キーボードは正規化済み、
   * 左スティックは倒した向きで、倒し具合（長さ0〜1）がそのまま速さになる
   */
  moveVec(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) {
      x /= len;
      z /= len;
    } else {
      const s = padStick(this.pad, 'left');
      x = s.x;
      z = s.y;
    }
    return { x, z };
  }

  /**
   * 一人称用の入力。turn: 右旋回=+1/左旋回=-1、forward: 前進=+1/後退=-1。
   * ゲームパッドは左スティック上下で前進/後退、右スティック左右（と左スティック左右）で旋回
   */
  fpsInput(): { turn: number; forward: number } {
    let turn = 0;
    let forward = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) turn -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) turn += 1;
    forward -= padAxis(this.pad, 1, FPS_AXIS_DEADZONE);
    turn += padAxis(this.pad, 0, FPS_AXIS_DEADZONE) + padAxis(this.pad, 2);
    return { turn: clamp1(turn), forward: clamp1(forward) };
  }

  /**
   * 猫の照準カーソル用の入力（左スティック。x: 右が+、y: 下が+）。
   * 小さく倒したときに細かく狙えるよう、倒し具合の2乗で効かせる
   */
  aimVec(): { x: number; y: number } {
    const s = padStick(this.pad, 'left');
    const len = Math.hypot(s.x, s.y);
    return { x: s.x * len, y: s.y * len };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.kd);
    window.removeEventListener('keyup', this.ku);
    window.removeEventListener('blur', this.blur);
  }
}
