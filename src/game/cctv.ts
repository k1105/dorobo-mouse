import * as THREE from 'three';
import { CONFIG } from '../config';

const GRID_COLS = 2;
const GRID_ROWS = 2;

/**
 * 猫チーム用の防犯カメラビュー。
 * 店内カメラ（12台）の各ボタンはオンライン/オフラインの純粋なトグルで、
 * 同時にオンラインにできるのは CONFIG.maxViewCams 台まで（満杯時は先にどれかをオフにする）。
 * オンラインのカメラは2x2グリッドの固定スロットに表示される。
 * 映像内のキャラクターをクリックするとダウト（Game側でレイキャスト判定）。
 */
export class CctvView {
  /** スロットごとのカメラID（オフラインのスロットはnull。位置は固定） */
  slots: (number | null)[] = [];
  /** オンライン状態が変わったときに呼ばれる（ネットワークへの共有用） */
  onChange: (() => void) | null = null;
  private overlay: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private camButtons: HTMLButtonElement[] = [];
  private camCount: number;

  constructor(parent: HTMLElement, camCount: number, onMapToggle?: () => void) {
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
    for (let i = 0; i < slotCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'cctv-cell';
      cell.innerHTML = `<span class="cctv-label"></span>`;
      grid.appendChild(cell);
      this.cells.push(cell);
    }

    // 下部バー: カメラのオン/オフトグル + マップボタン
    const bar = document.createElement('div');
    bar.className = 'cctv-bar';
    for (let i = 0; i < camCount; i++) {
      const b = document.createElement('button');
      b.className = 'btn cam-switch';
      b.textContent = `CAM ${i + 1}`;
      b.onclick = () => this.toggleCam(i);
      bar.appendChild(b);
      this.camButtons.push(b);
    }
    if (onMapToggle) {
      const m = document.createElement('button');
      m.className = 'btn';
      m.textContent = '🗺 マップ (M)';
      m.onclick = onMapToggle;
      bar.appendChild(m);
    }
    this.overlay.appendChild(bar);
    this.updateUi();
  }

  /** 現在オンラインのカメラID一覧 */
  onlineIds(): number[] {
    return this.slots.filter((s): s is number => s !== null);
  }

  /**
   * オンライン⇔オフラインのトグル。スロット位置は固定で、
   * 空きがない状態でオンにしようとした場合は拒否（ボタンを振って知らせる）。
   */
  toggleCam(camId: number): void {
    const at = this.slots.indexOf(camId);
    if (at >= 0) {
      this.slots[at] = null;
    } else {
      const empty = this.slots.indexOf(null);
      if (empty === -1) {
        this.denyFeedback(camId);
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

  private denyFeedback(camId: number): void {
    const b = this.camButtons[camId];
    b.classList.remove('deny');
    void b.offsetWidth; // アニメーション再生のためのリフロー
    b.classList.add('deny');
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
    this.camButtons.forEach((b, i) => {
      b.classList.toggle('active', this.slots.includes(i));
    });
  }

  /**
   * キャンバス上の座標から、その位置に表示中のカメラとNDC座標を返す（ダウトのレイキャスト用）。
   * オフラインのスロットや下部バーの上はnull。
   */
  pick(
    px: number,
    py: number,
    w: number,
    h: number,
    cams: THREE.PerspectiveCamera[],
  ): { cam: THREE.PerspectiveCamera; ndc: THREE.Vector2 } | null {
    const cw = w / GRID_COLS;
    const ch = h / GRID_ROWS;
    const col = Math.min(GRID_COLS - 1, Math.floor(px / cw));
    const row = Math.min(GRID_ROWS - 1, Math.floor(py / ch));
    const camId = this.slots[row * GRID_COLS + col];
    if (camId === null) return null;
    const ndc = new THREE.Vector2(
      ((px - col * cw) / cw) * 2 - 1,
      -(((py - row * ch) / ch) * 2 - 1),
    );
    return { cam: cams[camId], ndc };
  }

  /** オンラインカメラの映像をscissorで2x2に分割描画。オフラインスロットは暗転 */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    cams: THREE.PerspectiveCamera[],
  ): void {
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const cw = w / GRID_COLS;
    const ch = h / GRID_ROWS;
    renderer.setScissorTest(true);
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const x = col * cw;
      const y = h - (row + 1) * ch; // WebGLのビューポートは左下原点
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      const camId = this.slots[i];
      if (camId === null) {
        renderer.setClearColor(0x0d0d12);
        renderer.clear();
        continue;
      }
      const cam = cams[camId];
      cam.aspect = cw / ch;
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
