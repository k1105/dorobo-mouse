import * as THREE from 'three';
import { CONFIG } from '../config';

const SLOT_COUNT = 3;
/**
 * 画面のレイアウト。画面の一番上にHUDバーがあり、その下を 2×2 の4区画に等分する。
 * 左上＝カメラマップ（CamMapView）、右上＝モニタ①、左下＝モニタ②、右下＝モニタ③。
 * モニタは区画いっぱいに映す（縦横比は区画に合わせる）。
 * 描画範囲・枠・クリック判定はすべて同じ矩形（cellRect）から計算する。
 */
const OUTER_PX = 12; // 画面の左右・下端の余白
const GAP_PX = 8; // 隣り合う区画の間
const TOP_MARGIN_PX = 8; // HUDバーと上段の区画の間の余白

/** 区画1つの範囲（CSSピクセル、左上原点） */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 4分割のレイアウト（左上の区画の原点と、区画1つのサイズ） */
interface Layout {
  x0: number;
  y0: number;
  cw: number;
  ch: number;
}

/**
 * 監視サイド用の防犯カメラビュー。
 * 店内カメラ（12台）のオン/オフはカメラマップ（CamMapView）のクリック or 数字キーで切り替える純粋なトグルで、
 * 同時にオンラインにできるのは CONFIG.maxViewCams 台まで（満杯時は先にどれかをオフにする）。
 * オンラインのカメラは4分割した画面の右上・左下・右下の3枚のモニタ（固定スロット）に表示される（左上はカメラマップ）。
 * 映像内のキャラクターをクリックするとダウト（Game側でレイキャスト判定）。
 * ゲームパッドでは左スティックで照準カーソルを動かし、その位置をマウスカーソルの代わりにする。
 */
export class CctvView {
  /** スロットごとのカメラID（オフラインのスロットはnull。位置は固定） */
  slots: (number | null)[] = [];
  /** オンライン状態が変わったときに呼ばれる（ネットワークへの共有・マップ更新用） */
  onChange: (() => void) | null = null;
  /** 満杯でオンにできなかったときに呼ばれる */
  onDeny: ((camId: number) => void) | null = null;
  /** 画面の上でHUDバーが使っている高さ（HUDバーの下端のY、CSSピクセル）を返す。4分割はその下に置く */
  getTop: (() => number) | null = null;
  /** レイアウトが変わったときに、左上の区画（カメラマップを置く範囲）を知らせる */
  onLayout: ((mapRect: CellRect) => void) | null = null;
  private parent: HTMLElement;
  private overlay: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private camCount: number;
  /** レイアウトを最後に計算したときの画面サイズ（リサイズ時のみ更新する） */
  private lastW = 0;
  private lastH = 0;
  private layout: Layout = { x0: 0, y0: 0, cw: 1, ch: 1 };
  private layoutDirty = true;
  /** カーソルが乗っているスロット（なければ-1） */
  private hoverSlot = -1;
  /** ゲームパッドの照準カーソル。スティックを動かすと出て、マウスを動かすと消える */
  private aim: HTMLDivElement;
  private aimShown = false;
  /** 照準の位置（親要素内のCSSピクセル）。初めて出すときに画面中央へ置く */
  private aimX = -1;
  private aimY = -1;

  constructor(parent: HTMLElement, camCount: number) {
    this.parent = parent;
    this.camCount = camCount;
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.slots.push(i < Math.min(CONFIG.maxViewCams, camCount) ? i : null);
    }

    this.overlay = document.createElement('div');
    this.overlay.className = 'cctv-overlay';
    parent.appendChild(this.overlay);

    // 各モニタの枠（ラベルのみ。クリックはキャンバスに透過させてダウト判定に使う）。位置はレイアウトが変わるたびに cellRect に合わせる
    for (let i = 0; i < SLOT_COUNT; i++) {
      const cell = document.createElement('div');
      cell.className = 'cctv-cell';
      cell.innerHTML = `<span class="cctv-label"></span>`;
      this.overlay.appendChild(cell);
      this.cells.push(cell);
    }

    // 照準はカメラマップの上にも動かすので、モニタ枠とは別に手前へ置く
    this.aim = document.createElement('div');
    this.aim.className = 'pad-aim hidden';
    parent.appendChild(this.aim);

    parent.addEventListener('mousemove', this.onMouseMove);
    parent.addEventListener('mouseleave', this.onMouseLeave);

    this.updateUi();
  }

  /** 現在オンラインのカメラID一覧 */
  onlineIds(): number[] {
    return this.slots.filter((s): s is number => s !== null);
  }

  /**
   * オンライン⇔オフラインのトグル。スロット位置は固定で、
   * 空きがない状態でオンにしようとした場合は拒否（onDenyで知らせる）。
   */
  toggleCam(camId: number): void {
    const at = this.slots.indexOf(camId);
    if (at >= 0) {
      this.slots[at] = null;
    } else {
      const empty = this.slots.indexOf(null);
      if (empty === -1) {
        this.onDeny?.(camId);
        return;
      }
      this.slots[empty] = camId;
      this.flashCell(empty);
    }
    this.updateUi();
    this.onChange?.();
  }

  /** 1〜9キー・0キー(=CAM10)でオン/オフ切り替え */
  handleKey(code: string): void {
    if (/^Digit[1-9]$/.test(code)) {
      const n = Number(code.slice(5)) - 1;
      if (n < this.camCount) this.toggleCam(n);
    } else if (code === 'Digit0' && this.camCount >= 10) {
      this.toggleCam(9);
    }
  }

  /** モニタ枠の表示/非表示（ステージ紹介中は全画面の映像に切り替えるため隠す） */
  setVisible(visible: boolean): void {
    this.overlay.classList.toggle('hidden', !visible);
    this.layoutDirty = true;
    this.syncAim();
  }

  // ---- ゲームパッドの照準 ----

  /**
   * 照準カーソルを (dx, dy) ピクセル動かす（画面内に収める）。隠れていれば表示する。
   * 照準が乗ったモニタはマウスカーソルと同じく枠を強調する
   */
  moveAim(dx: number, dy: number): void {
    if (this.overlay.classList.contains('hidden')) return;
    const w = this.parent.clientWidth;
    const h = this.parent.clientHeight;
    if (this.aimX < 0) {
      this.aimX = w / 2;
      this.aimY = h / 2;
    }
    this.aimX = Math.max(0, Math.min(w, this.aimX + dx));
    this.aimY = Math.max(0, Math.min(h, this.aimY + dy));
    this.aimShown = true;
    this.syncAim();
    this.setHover(this.slotAt(this.aimX, this.aimY));
  }

  /** 照準の位置（clientX/clientY と同じビューポート座標）。照準が出ていなければ null */
  aimPoint(): { x: number; y: number } | null {
    if (!this.aimShown || this.overlay.classList.contains('hidden')) return null;
    const rect = this.parent.getBoundingClientRect();
    return { x: rect.left + this.aimX, y: rect.top + this.aimY };
  }

  private syncAim(): void {
    this.aim.classList.toggle('hidden', !this.aimShown || this.overlay.classList.contains('hidden'));
    this.aim.style.transform = `translate(${this.aimX}px, ${this.aimY}px)`;
  }

  /** HUDバーの高さや画面サイズが変わったときに次フレームでレイアウトし直す */
  relayout(): void {
    this.layoutDirty = true;
  }

  private flashCell(slot: number): void {
    const cell = this.cells[slot];
    cell.classList.remove('flash');
    void cell.offsetWidth;
    cell.classList.add('flash');
  }

  private updateUi(): void {
    this.cells.forEach((cell, i) => {
      const camId = this.slots[i];
      cell.querySelector('.cctv-label')!.textContent =
        camId !== null ? `CAM ${camId + 1} ● ONLINE` : 'OFFLINE';
      cell.classList.toggle('offline', camId === null);
      cell.classList.toggle('hover', i === this.hoverSlot && camId !== null);
    });
  }

  // ---- レイアウト ----

  /** 区画の範囲。q: 0=左上（カメラマップ）、1=右上、2=左下、3=右下 */
  private quadRect(q: number): CellRect {
    const { x0, y0, cw, ch } = this.layout;
    return { x: x0 + (q % 2) * (cw + GAP_PX), y: y0 + (q >> 1) * (ch + GAP_PX), w: cw, h: ch };
  }

  /** モニタの範囲。スロット0=右上、1=左下、2=右下（左上はカメラマップ） */
  private cellRect(slot: number): CellRect {
    return this.quadRect(slot + 1);
  }

  /** カーソル（照準）が乗っているスロットを更新し、枠の強調に反映する */
  private setHover(slot: number): void {
    if (slot === this.hoverSlot) return;
    this.hoverSlot = slot;
    this.updateUi();
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.aimShown) {
      // 照準の表示中は、実際にマウスが動いたときだけマウス操作へ戻す
      // （レイアウトが変わるだけでも、動いていない mousemove が届くため）
      if (e.movementX === 0 && e.movementY === 0) return;
      this.aimShown = false;
      this.syncAim();
    }
    const rect = this.parent.getBoundingClientRect();
    this.setHover(this.slotAt(e.clientX - rect.left, e.clientY - rect.top));
  };

  private onMouseLeave = (): void => {
    if (this.aimShown) return;
    this.setHover(-1);
  };

  /** 座標にあるオンラインのスロット。なければ-1 */
  private slotAt(px: number, py: number): number {
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (this.slots[i] === null) continue;
      const r = this.cellRect(i);
      if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return i;
    }
    return -1;
  }

  /** DOMの枠（ラベル・枠線）を描画範囲と一致させる */
  private applyCells(): void {
    this.cells.forEach((cell, i) => {
      const r = this.cellRect(i);
      cell.style.left = `${r.x}px`;
      cell.style.top = `${r.y}px`;
      cell.style.width = `${r.w}px`;
      cell.style.height = `${r.h}px`;
    });
  }

  /**
   * キャンバス上の座標から、その位置に表示中のカメラとNDC座標を返す（ダウトのレイキャスト用）。
   * オフラインのスロットやモニタの外（余白・マップの区画）はnull。
   */
  pick(
    px: number,
    py: number,
    _w: number,
    _h: number,
    cams: THREE.PerspectiveCamera[],
  ): { cam: THREE.PerspectiveCamera; ndc: THREE.Vector2 } | null {
    const i = this.slotAt(px, py);
    if (i < 0) return null;
    const camId = this.slots[i];
    if (camId === null) return null;
    const r = this.cellRect(i);
    const ndc = new THREE.Vector2(((px - r.x) / r.w) * 2 - 1, -(((py - r.y) / r.h) * 2 - 1));
    return { cam: cams[camId], ndc };
  }

  /** 画面サイズとHUDバーの高さから4分割の区画を決める。変化があれば true */
  private syncLayout(w: number, h: number): boolean {
    if (!this.layoutDirty && w === this.lastW && h === this.lastH) return false;
    this.layoutDirty = false;
    this.lastW = w;
    this.lastH = h;
    const y0 = (this.getTop?.() ?? 0) + TOP_MARGIN_PX;
    const cw = Math.max(40, Math.floor((w - 2 * OUTER_PX - GAP_PX) / 2));
    const ch = Math.max(40, Math.floor((h - y0 - OUTER_PX - GAP_PX) / 2));
    this.layout = { x0: OUTER_PX, y0, cw, ch };
    return true;
  }

  /**
   * オンラインカメラの映像を3枚のモニタにscissorで分割描画。
   * モニタの外は暗い背景、オフラインスロットはさらに暗く塗る
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    cams: THREE.PerspectiveCamera[],
  ): void {
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    if (this.syncLayout(w, h)) {
      this.applyCells();
      this.onLayout?.(this.quadRect(0));
    }
    // 全面を背景色で塗ってからモニタを描く
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(0x1a1a20);
    renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const r = this.cellRect(i);
      const y = h - (r.y + r.h); // WebGLのビューポートは左下原点
      renderer.setViewport(r.x, y, r.w, r.h);
      renderer.setScissor(r.x, y, r.w, r.h);
      const camId = this.slots[i];
      if (camId === null) {
        renderer.setClearColor(0x0d0d12);
        renderer.clear();
        continue;
      }
      const cam = cams[camId];
      cam.aspect = r.w / r.h;
      cam.updateProjectionMatrix();
      renderer.render(scene, cam);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }

  dispose(): void {
    this.parent.removeEventListener('mousemove', this.onMouseMove);
    this.parent.removeEventListener('mouseleave', this.onMouseLeave);
    this.overlay.remove();
    this.aim.remove();
  }
}
