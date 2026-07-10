/** キーボード入力。WASD/矢印で移動、その他のキーはonKeyコールバックで通知 */
export class Controls {
  private keys = new Set<string>();
  onKey: ((code: string) => void) | null = null;

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

  /** 正規化済みの移動ベクトル（画面上: W=奥(-z), S=手前(+z)） */
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
    }
    return { x, z };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.kd);
    window.removeEventListener('keyup', this.ku);
    window.removeEventListener('blur', this.blur);
  }
}
