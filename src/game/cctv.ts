import * as THREE from 'three';
import { CONFIG } from '../config';

const SLOT_COUNT = 3;
/**
 * モニタのレイアウト。画面の一番上にHUDバー、一番下にカメラマップ（CamMapView）があり、
 * その間の帯の上寄り（ROW_POS）に3枚のモニタを横に隣接して並べる（16:9。帯に収まらなければ縮める）。
 * カーソルを乗せたモニタは HOVER_SCALE 倍に拡大し、代わりに他のモニタが OTHER_SCALE 倍に縮む。
 * 拡大率の合計は常に SLOT_COUNT なので行の幅は変わらず、モニタ同士・マップと重ならない。
 * 描画範囲・枠・クリック判定はすべて同じ矩形（cellRect）から計算する。
 */
const OUTER_PX = 24; // 画面左右端の余白
const COL_GAP_PX = 8; // 隣り合うモニタの間
const BAND_MARGIN_PX = 12; // HUDバー・マップとモニタの間の余白
const MONITOR_ASPECT = 9 / 16; // モニタの縦横比（高さ/幅）
const HOVER_SCALE = 1.3; // ホバー中のモニタの拡大率
const OTHER_SCALE = (SLOT_COUNT - HOVER_SCALE) / (SLOT_COUNT - 1); // ホバー中、他のモニタの縮小率
const HOVER_LERP = 0.2; // 拡大・縮小アニメーションの追従率（1フレームあたり）
/** 帯の中でモニタ行（拡大時の高さ分）を置く位置。0=帯の一番上、0.5=中央 */
const ROW_POS = 0.15;

/** モニタ1枚の描画範囲（CSSピクセル、左上原点） */
interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** モニタの並びのレイアウト（拡大率1のときの1枚のサイズと、行の中心線） */
interface Layout {
  cw: number;
  ch: number;
  /** 行の中心線のY。各モニタは拡大率に応じた高さでこの線を中心に置く */
  cy: number;
  /** 画面幅（行を中央揃えにするため） */
  w: number;
}

/**
 * 猫チーム用の防犯カメラビュー。
 * 店内カメラ（12台）のオン/オフはカメラマップ（CamMapView）のクリック or 数字キーで切り替える純粋なトグルで、
 * 同時にオンラインにできるのは CONFIG.maxViewCams 台まで（満杯時は先にどれかをオフにする）。
 * オンラインのカメラは画面中央上寄りに横並びの3枚のモニタ（固定スロット）に表示される。
 * 映像内のキャラクターをクリックするとダウト（Game側でレイキャスト判定）。
 */
export class CctvView {
  /** スロットごとのカメラID（オフラインのスロットはnull。位置は固定） */
  slots: (number | null)[] = [];
  /** オンライン状態が変わったときに呼ばれる（ネットワークへの共有・マップ更新用） */
  onChange: (() => void) | null = null;
  /** 満杯でオンにできなかったときに呼ばれる */
  onDeny: ((camId: number) => void) | null = null;
  /**
   * 画面の上下でモニタ以外に使われている高さ（CSSピクセル）を返す。
   * top=HUDバーの下端、bottom=カメラマップの高さ＋余白。モニタはその間の帯に置く
   */
  getReserved: (() => { top: number; bottom: number }) | null = null;
  private parent: HTMLElement;
  private overlay: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private camCount: number;
  /** レイアウトを最後に計算したときの画面サイズ（リサイズ時のみ更新する） */
  private lastW = 0;
  private lastH = 0;
  private layout: Layout = { cw: 1, ch: 1, cy: 0, w: 1 };
  private layoutDirty = true;
  /** カーソルが乗っているスロット（なければ-1） */
  private hoverSlot = -1;
  /** スロットごとの現在の拡大率（目標へ向かって毎フレーム補間） */
  private scales: number[] = [];

  constructor(parent: HTMLElement, camCount: number) {
    this.parent = parent;
    this.camCount = camCount;
    for (let i = 0; i < SLOT_COUNT; i++) {
      this.slots.push(i < Math.min(CONFIG.maxViewCams, camCount) ? i : null);
      this.scales.push(1);
    }

    this.overlay = document.createElement('div');
    this.overlay.className = 'cctv-overlay';
    parent.appendChild(this.overlay);

    // 各モニタの枠（ラベルのみ。クリックはキャンバスに透過させてダウト判定に使う）。位置は毎フレーム cellRect に合わせる
    for (let i = 0; i < SLOT_COUNT; i++) {
      const cell = document.createElement('div');
      cell.className = 'cctv-cell';
      cell.innerHTML = `<span class="cctv-label"></span>`;
      this.overlay.appendChild(cell);
      this.cells.push(cell);
    }

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

  /** HUDバーやマップの高さが変わったとき（マップの表示切替など）に次フレームでレイアウトし直す */
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
    });
  }

  // ---- レイアウト ----

  /**
   * 現在の拡大率を反映したモニタ位置。幅は cw×拡大率で左から詰めて並べ、行全体を画面中央に揃える。
   * 高さは ch×拡大率で、行の中心線 cy を中心に置く
   */
  private cellRect(slot: number): CellRect {
    const { cw, ch, cy, w } = this.layout;
    const widths = this.scales.map((s) => cw * s);
    const total = widths.reduce((a, b) => a + b, 0) + COL_GAP_PX * (SLOT_COUNT - 1);
    let x = (w - total) / 2;
    for (let i = 0; i < slot; i++) x += widths[i] + COL_GAP_PX;
    const h = ch * this.scales[slot];
    return { x, y: cy - h / 2, w: widths[slot], h };
  }

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.parent.getBoundingClientRect();
    this.hoverSlot = this.slotAt(e.clientX - rect.left, e.clientY - rect.top);
  };

  private onMouseLeave = (): void => {
    this.hoverSlot = -1;
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

  /** 拡大率をホバー状態へ向けて補間する。変化があれば true */
  private animateHover(): boolean {
    const hovering = this.hoverSlot >= 0 && this.slots[this.hoverSlot] !== null;
    let changed = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const target = !hovering ? 1 : i === this.hoverSlot ? HOVER_SCALE : OTHER_SCALE;
      let s = this.scales[i] + (target - this.scales[i]) * HOVER_LERP;
      if (Math.abs(s - target) < 0.001) s = target;
      if (s === this.scales[i]) continue;
      this.scales[i] = s;
      this.cells[i].classList.toggle('hover', hovering && i === this.hoverSlot);
      changed = true;
    }
    return changed;
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
   * オフラインのスロットやモニタの外（余白・マップ）はnull。
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

  /** 画面サイズと上下の予約領域からモニタ行のサイズと中心線を決める。変化があれば true */
  private syncLayout(w: number, h: number): boolean {
    if (!this.layoutDirty && w === this.lastW && h === this.lastH) return false;
    this.layoutDirty = false;
    this.lastW = w;
    this.lastH = h;
    const reserved = this.getReserved?.() ?? { top: 0, bottom: 0 };
    const bandTop = reserved.top + BAND_MARGIN_PX;
    const bandH = Math.max(80, h - reserved.bottom - BAND_MARGIN_PX - bandTop);
    const cw = (w - 2 * OUTER_PX - COL_GAP_PX * (SLOT_COUNT - 1)) / SLOT_COUNT;
    // ホバーで最大まで拡大しても帯（HUDバー〜マップ）からはみ出さない高さに収める
    const ch = Math.min(cw * MONITOR_ASPECT, bandH / HOVER_SCALE);
    const maxH = ch * HOVER_SCALE;
    const cy = bandTop + (bandH - maxH) * ROW_POS + maxH / 2;
    this.layout = { cw, ch, cy, w };
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
    const layoutChanged = this.syncLayout(w, h);
    const hoverChanged = this.animateHover();
    if (layoutChanged || hoverChanged) this.applyCells();
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
  }
}
