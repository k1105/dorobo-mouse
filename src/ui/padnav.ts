import { activePad, PAD, padStick } from '../game/gamepad';

/** 方向入力を押しっぱなしにしたときの連続移動（最初の待ち → 以降の間隔。ミリ秒） */
const REPEAT_FIRST_MS = 380;
const REPEAT_MS = 140;
/** 左スティックを方向入力とみなす傾き */
const STICK_DIR = 0.6;
/** 右スティックでのスクロール速度（px/秒） */
const SCROLL_SPEED = 900;

type Dir = 'up' | 'down' | 'left' | 'right';

interface Point {
  x: number;
  y: number;
}

/**
 * ゲームパッドでのメニュー操作（タイトル・名前・ルーム一覧・ルーム・着せ替え・試合終了のリザルト）。
 * 十字キー/左スティックで選択枠（.pad-focus）を上下左右の近いボタンへ動かし、×で決定、○で戻る
 * （data-pad-back の付いたボタンを押す）、右スティック上下でスクロール。
 * ゲーム中（ロビーが隠れている間）とステージエディタでは何もしない。
 *
 * ロビーは状態が変わるたびに innerHTML で描き直すので、選択中の要素は消えることがある。
 * 毎フレーム確かめ、消えていたら同じ項目（keyOf が同じもの）を選び直す。
 */
export class PadNav {
  private raf = 0;
  private lastFrame = 0;
  /** 前フレームのボタン状態（押した瞬間の検出用） */
  private down: boolean[] = [];
  private dir: Dir | null = null;
  private dirNextAt = 0;
  /** 選択枠を出しているか。マウスを動かすと消え、ゲームパッドを触ると戻る */
  private shown = false;
  private current: HTMLElement | null = null;
  /** 描き直しのあと同じ項目を選び直すための手がかり（画面・項目・画面上の位置） */
  private currentSig = '';
  private currentKey = '';
  private lastCenter: Point = { x: 0, y: 0 };

  constructor() {
    window.addEventListener('gamepadconnected', this.start);
    window.addEventListener('mousemove', this.onMouse);
    window.addEventListener('mousedown', this.onMouse);
    this.start();
  }

  /** ゲームパッドが繋がっている間だけ毎フレーム読む（最初のボタン入力で gamepadconnected が届く） */
  private start = (): void => {
    const pad = activePad();
    if (this.raf || !pad) return;
    // 繋がった時点で押されているボタンは「押した瞬間」として扱わない
    this.down = pad.buttons.map((b) => b.pressed);
    this.dir = null;
    this.shown = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  };

  private onMouse = (e: MouseEvent): void => {
    if (!this.shown) return;
    // レイアウトが変わるだけでも、動いていない mousemove が届くことがある
    if (e.type === 'mousemove' && e.movementX === 0 && e.movementY === 0) return;
    this.shown = false;
    this.highlight(null);
  };

  private loop = (): void => {
    const pad = activePad();
    if (!pad) {
      // 切断された。次の gamepadconnected まで止める
      this.raf = 0;
      this.highlight(null);
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // ボタン・方向の状態は、メニューが出ていない間も追い続ける（出た瞬間に押しっぱなしを拾わないため）
    const was = this.down;
    this.down = pad.buttons.map((b) => b.pressed);
    const hit = (i: number): boolean => this.down[i] && !was[i];
    const ok = hit(PAD.cross);
    const back = hit(PAD.circle);
    const dir = this.readDir(pad);
    let step: Dir | null = null;
    if (dir !== this.dir) {
      this.dir = dir;
      if (dir) {
        step = dir;
        this.dirNextAt = now + REPEAT_FIRST_MS;
      }
    } else if (dir && now >= this.dirNextAt) {
      step = dir;
      this.dirNextAt = now + REPEAT_MS;
    }

    const scope = scopeRoot();
    if (!scope) {
      this.highlight(null);
      return;
    }
    const scroll = padStick(pad, 'right').y;
    if (scroll !== 0) scrollTarget(scope).scrollTop += scroll * SCROLL_SPEED * dt;

    if (!this.shown) {
      // マウスで操作していた。ゲームパッドを触ったら選択枠を出す（この入力では移動・決定しない）
      if (!step && !ok && !back) return;
      this.shown = true;
      this.resolve(scope);
      return;
    }
    const items = this.resolve(scope);
    if (step) {
      const from = this.current?.getBoundingClientRect();
      const next = from ? pickInDirection(from, items.filter((el) => el !== this.current), step) : null;
      if (next) this.highlight(next);
    } else if (ok) {
      // 入力欄はキーボードで打つ（選択枠が乗った時点でフォーカス済み）
      if (!(this.current instanceof HTMLInputElement)) this.current?.click();
    } else if (back) {
      items.find((el) => el.dataset.padBack !== undefined)?.click();
    }
  };

  private readDir(pad: Gamepad): Dir | null {
    if (this.down[PAD.up]) return 'up';
    if (this.down[PAD.down]) return 'down';
    if (this.down[PAD.left]) return 'left';
    if (this.down[PAD.right]) return 'right';
    const s = padStick(pad, 'left');
    if (Math.abs(s.x) > Math.abs(s.y)) {
      if (Math.abs(s.x) > STICK_DIR) return s.x > 0 ? 'right' : 'left';
    } else if (Math.abs(s.y) > STICK_DIR) {
      return s.y > 0 ? 'down' : 'up';
    }
    return null;
  }

  /**
   * 選択中の要素がまだ有効か確かめ、無効（描き直された・画面が変わった・押せなくなった）なら選び直す。
   * 選べる要素の一覧を返す
   */
  private resolve(scope: HTMLElement): HTMLElement[] {
    const items = selectable(scope);
    const sig = signature(scope);
    if (this.current && sig === this.currentSig && items.includes(this.current)) {
      this.lastCenter = centerOf(this.current.getBoundingClientRect());
      return items;
    }
    let next: HTMLElement | null = null;
    if (sig === this.currentSig && this.currentKey) {
      // 同じ画面の描き直し: 同じ項目（同じ種類が複数あれば元の位置に近いもの）を選び直す
      const same = items.filter((el) => keyOf(el) === this.currentKey);
      next = nearest(same, this.lastCenter);
    }
    next ??= defaultPick(items);
    this.currentSig = sig;
    this.highlight(next);
    return items;
  }

  /** 選択枠を el に移す（null で消す）。入力欄ならそのままキーボードで打てるようフォーカスも移す */
  private highlight(el: HTMLElement | null): void {
    if (el === this.current) return;
    this.current?.classList.remove('pad-focus');
    // 別の項目へ移るときだけ入力欄のフォーカスを外す（枠を消すだけのときは打ちかけの入力を邪魔しない）
    if (el && this.current instanceof HTMLInputElement) this.current.blur();
    this.current = el;
    if (!el) return;
    el.classList.add('pad-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
    this.currentKey = keyOf(el);
    this.lastCenter = centerOf(el.getBoundingClientRect());
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.highlight(null);
    window.removeEventListener('gamepadconnected', this.start);
    window.removeEventListener('mousemove', this.onMouse);
    window.removeEventListener('mousedown', this.onMouse);
  }
}

/** いま操作対象になっているメニュー。開いているモーダル > ロビーの画面 > 試合終了のリザルト。無ければ null */
function scopeRoot(): HTMLElement | null {
  const lobby = document.querySelector<HTMLElement>('.lobby:not(.hidden)');
  if (lobby) return lobby.querySelector<HTMLElement>('.modal-backdrop:not(.hidden)') ?? lobby;
  return document.querySelector<HTMLElement>('.end-overlay');
}

/** 右スティックでスクロールさせる要素（モーダルは中の箱、ロビーは画面全体） */
function scrollTarget(scope: HTMLElement): HTMLElement {
  return scope.querySelector<HTMLElement>(':scope > .modal') ?? scope;
}

/** 選択枠を置ける要素（表示されていて押せるボタン・入力欄）。まだ透明な演出中のボタンは含めない */
function selectable(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')].filter(
    (el) => !el.disabled && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
  );
}

/** 画面の識別（見出しが変われば別の画面とみなす） */
function signature(scope: HTMLElement): string {
  return `${scope.id}|${scope.className}|${scope.querySelector('h1, h2')?.textContent ?? ''}`;
}

/** 描き直されても変わらない項目の識別（id、無ければ先頭のクラスと data 属性） */
function keyOf(el: HTMLElement): string {
  if (el.id) return `#${el.id}`;
  const data = Object.entries(el.dataset).map(([k, v]) => `${k}=${v}`);
  return [el.classList[0] ?? el.tagName, ...data].join('|');
}

function centerOf(r: DOMRect): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function nearest(items: HTMLElement[], to: Point): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const el of items) {
    const c = centerOf(el.getBoundingClientRect());
    const d = Math.hypot(c.x - to.x, c.y - to.y);
    if (d < bestD) {
      bestD = d;
      best = el;
    }
  }
  return best;
}

/** 画面を開いたときの最初の選択: フォーカス中の入力欄 > 主ボタン（.btn.big）> 画面中央に近いもの */
function defaultPick(items: HTMLElement[]): HTMLElement | null {
  const focused = items.find((el) => el === document.activeElement);
  if (focused) return focused;
  const primary = items.find((el) => el.matches('.btn.big'));
  if (primary) return primary;
  return nearest(items, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
}

/**
 * from から dir の向きにある一番近い要素。
 * 進行方向の隙間が小さく、横ずれ（進行方向と直交する向きのはみ出し）が小さいものを選ぶ
 */
function pickInDirection(from: DOMRect, items: HTMLElement[], dir: Dir): HTMLElement | null {
  const horizontal = dir === 'left' || dir === 'right';
  const sign = dir === 'right' || dir === 'down' ? 1 : -1;
  const fc = centerOf(from);
  // まずは中心が from の端より先にあり、同じ行・列に並んでいるか、完全に先へ離れているもの
  // （斜め上の横長の入力欄などを左右で拾わない）。
  // 無ければ（重なって置かれたボタンなど）、中心同士で比べて押した向きのほぼ正面にあるもの
  for (const strict of [true, false]) {
    let best: HTMLElement | null = null;
    let bestCost = Infinity;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const c = centerOf(r);
      const gap = horizontal
        ? Math.max(0, sign > 0 ? r.left - from.right : from.left - r.right)
        : Math.max(0, sign > 0 ? r.top - from.bottom : from.top - r.bottom);
      const off = horizontal
        ? Math.max(0, r.top - from.bottom, from.top - r.bottom)
        : Math.max(0, r.left - from.right, from.left - r.right);
      if (strict) {
        const edge = horizontal ? (sign > 0 ? from.right : from.left) : sign > 0 ? from.bottom : from.top;
        if (((horizontal ? c.x : c.y) - edge) * sign < 1) continue;
        if (off > 0 && gap === 0) continue;
      } else {
        const along = (horizontal ? c.x - fc.x : c.y - fc.y) * sign;
        if (along < 1 || along < 2 * Math.abs(horizontal ? c.y - fc.y : c.x - fc.x)) continue;
      }
      const cost = gap + off * 3 + Math.hypot(c.x - fc.x, c.y - fc.y) * 0.01;
      if (cost < bestCost) {
        bestCost = cost;
        best = el;
      }
    }
    if (best) return best;
  }
  return null;
}
