import * as THREE from 'three';

const GRID_COLS = 3;
const GRID_ROWS = 2;

/**
 * 猫（カメラ監視役）用の防犯カメラビュー。
 * グリッド表示（全カメラ一覧）と単一表示（1台をフルスクリーン）を切り替えられる。
 * 各カメラにアラートボタンがあり、押すと鬼猫に通知が飛ぶ。
 */
export class CctvView {
  mode: 'grid' | 'single' = 'grid';
  selected = 0;
  private overlay: HTMLDivElement;
  private cells: HTMLDivElement[] = [];
  private singleBar: HTMLDivElement;
  private camCount: number;

  constructor(parent: HTMLElement, camCount: number, onAlert: (camId: number) => void) {
    this.camCount = camCount;
    this.overlay = document.createElement('div');
    this.overlay.className = 'cctv-overlay';
    parent.appendChild(this.overlay);

    // グリッドの各セル（ラベル + アラートボタン + クリックで単一表示へ）
    const grid = document.createElement('div');
    grid.className = 'cctv-grid';
    this.overlay.appendChild(grid);
    for (let i = 0; i < camCount; i++) {
      const cell = document.createElement('div');
      cell.className = 'cctv-cell';
      cell.innerHTML = `
        <span class="cctv-label">CAM ${i + 1}</span>
        <button class="btn alert-btn">🚨 アラート</button>
      `;
      cell.querySelector<HTMLButtonElement>('.alert-btn')!.onclick = (e) => {
        e.stopPropagation();
        onAlert(i);
      };
      cell.onclick = () => {
        this.selected = i;
        this.setMode('single');
      };
      grid.appendChild(cell);
      this.cells.push(cell);
    }

    // 単一表示時の下部バー
    this.singleBar = document.createElement('div');
    this.singleBar.className = 'cctv-single-bar hidden';
    const switches = Array.from(
      { length: camCount },
      (_, i) => `<button class="btn cam-switch" data-cam="${i}">CAM ${i + 1}</button>`,
    ).join('');
    this.singleBar.innerHTML = `
      ${switches}
      <button class="btn alert-btn single-alert">🚨 アラート</button>
      <button class="btn" id="btn-grid">グリッド表示 (G)</button>
    `;
    this.overlay.appendChild(this.singleBar);
    this.singleBar.querySelectorAll<HTMLButtonElement>('.cam-switch').forEach((b) => {
      b.onclick = () => {
        this.selected = Number(b.dataset.cam);
        this.updateBar();
      };
    });
    this.singleBar.querySelector<HTMLButtonElement>('.single-alert')!.onclick = () =>
      onAlert(this.selected);
    this.singleBar.querySelector<HTMLButtonElement>('#btn-grid')!.onclick = () =>
      this.setMode('grid');
  }

  setMode(mode: 'grid' | 'single'): void {
    this.mode = mode;
    this.overlay.querySelector('.cctv-grid')!.classList.toggle('hidden', mode === 'single');
    this.singleBar.classList.toggle('hidden', mode === 'grid');
    this.updateBar();
  }

  private updateBar(): void {
    this.singleBar.querySelectorAll<HTMLButtonElement>('.cam-switch').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.cam) === this.selected);
    });
  }

  /** G: グリッド切替、←→/1-6: カメラ切替 */
  handleKey(code: string): void {
    if (code === 'KeyG') {
      this.setMode(this.mode === 'grid' ? 'single' : 'grid');
      return;
    }
    if (code === 'ArrowLeft')
      this.selected = (this.selected + this.camCount - 1) % this.camCount;
    else if (code === 'ArrowRight') this.selected = (this.selected + 1) % this.camCount;
    else if (/^Digit[1-9]$/.test(code)) {
      const n = Number(code.slice(5)) - 1;
      if (n < this.camCount) this.selected = n;
    } else return;
    if (this.mode === 'single') this.updateBar();
  }

  /** 防犯カメラ映像を描画（グリッド: scissorで分割 / 単一: フルスクリーン） */
  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    cams: THREE.PerspectiveCamera[],
  ): void {
    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    if (this.mode === 'single') {
      const cam = cams[this.selected];
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
      renderer.render(scene, cam);
      return;
    }
    const cw = w / GRID_COLS;
    const ch = h / GRID_ROWS;
    renderer.setScissorTest(true);
    for (let i = 0; i < cams.length; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const x = col * cw;
      const y = h - (row + 1) * ch; // WebGLのビューポートは左下原点
      renderer.setViewport(x, y, cw, ch);
      renderer.setScissor(x, y, cw, ch);
      const cam = cams[i];
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
