import * as THREE from 'three';
import { CONFIG } from '../config';

const GRID_COLS = 2;
const GRID_ROWS = 2;
/**
 * モニタのレイアウト。モニタは画面端まで広げ、左右の列の間に画面幅 CENTER_GAP 分の空きを作り、
 * そこに画面中央のカメラマップ（style.css の .cam-map、幅30vw）を置く。
 */
const OUTER_PX = 6; // 画面端の余白
const ROW_GAP_PX = 6; // 上下のモニタの間
const CENTER_GAP = 0.32; // 左右のモニタの間（画面幅に対する割合）

/** モニタ1枚の描画範囲（CSSピクセル、左上原点） */
interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function cellRect(slot: number, w: number, h: number): CellRect {
  const col = slot % GRID_COLS;
  const row = Math.floor(slot / GRID_COLS);
  const gapX = w * CENTER_GAP;
  const cw = (w - 2 * OUTER_PX - gapX * (GRID_COLS - 1)) / GRID_COLS;
  const ch = (h - 2 * OUTER_PX - ROW_GAP_PX * (GRID_ROWS - 1)) / GRID_ROWS;
  return {
    x: OUTER_PX + col * (cw + gapX),
    y: OUTER_PX + row * (ch + ROW_GAP_PX),
    w: cw,
    h: ch,
  };
}

/**
 * 猫チーム用の防犯カメラビュー。
 * 店内カメラ（12台）のオン/オフはカメラマップ（CamMapView）のクリック or 数字キーで切り替える純粋なトグルで、
 * 同時にオンラインにできるのは CONFIG.maxViewCams 台まで（満杯時は先にどれかをオフにする）。
 * オンラインのカメラは2x2グリッドの固定スロットに表示される（モニタは画面端まで広げ、
 * 左右の列の間の空きスペースにカメラマップ CamMapView を重ねる）。
 * 映像内のキャラクターをクリックするとダウト（Game側でレイキャスト判定）。
 */
export class CctvView {
  /** スロットごとのカメラID（オフラインのスロットはnull。位置は固定） */
  slots: (number | null)[] = [];
  /** オンライン状態が変わったときに呼ばれる（ネットワークへの共有・マップ更新用） */
  onChange: (() => void) | null = null;
  /** 満杯でオンにできなかったときに呼ばれる */
  onDeny: ((camId: number) => void) | null = null;
  private overlay: HTMLDivElement;
  private grid: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private camCount: number;
  /** グリッドの余白を最後に計算したときの画面サイズ（リサイズ時のみ更新する） */
  private lastW = 0;
  private lastH = 0;

  constructor(parent: HTMLElement, camCount: number) {
    this.camCount = camCount;
    const slotCount = GRID_COLS * GRID_ROWS;
    for (let i = 0; i < slotCount; i++) {
      this.slots.push(i < Math.min(CONFIG.maxViewCams, camCount) ? i : null);
    }

    this.overlay = document.createElement('div');
    this.overlay.className = 'cctv-overlay';
    parent.appendChild(this.overlay);

    // グリッドの各セル（ラベルのみ。クリックはキャンバスに透過させてダウト判定に使う）
    const grid = document.createElement('div');
    grid.className = 'cctv-grid';
    this.overlay.appendChild(grid);
    this.grid = grid;
    for (let i = 0; i < slotCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'cctv-cell';
      cell.innerHTML = `<span class="cctv-label"></span>`;
      grid.appendChild(cell);
      this.cells.push(cell);
    }

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

  /**
   * キャンバス上の座標から、その位置に表示中のカメラとNDC座標を返す（ダウトのレイキャスト用）。
   * オフラインのスロットやモニタの外（余白・マップ）はnull。
   */
  pick(
    px: number,
    py: number,
    w: number,
    h: number,
    cams: THREE.PerspectiveCamera[],
  ): { cam: THREE.PerspectiveCamera; ndc: THREE.Vector2 } | null {
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      const r = cellRect(i, w, h);
      if (px < r.x || px >= r.x + r.w || py < r.y || py >= r.y + r.h) continue;
      const camId = this.slots[i];
      if (camId === null) return null;
      const ndc = new THREE.Vector2(
        ((px - r.x) / r.w) * 2 - 1,
        -(((py - r.y) / r.h) * 2 - 1),
      );
      return { cam: cams[camId], ndc };
    }
    return null;
  }

  /** DOMのグリッド（枠線・ラベル）の余白を描画範囲と一致させる */
  private syncGridLayout(w: number, h: number): void {
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.grid.style.padding = `${OUTER_PX}px`;
    this.grid.style.columnGap = `${w * CENTER_GAP}px`;
    this.grid.style.rowGap = `${ROW_GAP_PX}px`;
  }

  /**
   * オンラインカメラの映像を2x2モニタにscissorで分割描画。
   * モニタの間は暗い背景、オフラインスロットはさらに暗く塗る
   */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    cams: THREE.PerspectiveCamera[],
  ): void {
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    this.syncGridLayout(w, h);
    // 全面を背景色で塗ってからモニタを描く
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(0x1a1a20);
    renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      const r = cellRect(i, w, h);
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
    this.overlay.remove();
  }
}
