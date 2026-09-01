import type { MapData } from '../game/world';
import { castRay } from '../game/world';

const CANVAS_W = 480;
const MINI_W = 240;
const RAYS_PER_CAM = 72;

/** 店内レイアウトと各カメラの視野を俯瞰で描く。猫のモーダルとネズミのミニマップで共有する */
interface MapCanvas {
  canvas: HTMLCanvasElement;
  /** ワールド座標 → キャンバス座標（CSSピクセル） */
  tx: (x: number) => number;
  tz: (z: number) => number;
  cssW: number;
  cssH: number;
}

/**
 * 店内マップを描画したキャンバスを作る。
 * 視野は棚・壁で遮蔽された実効範囲を2Dレイキャストで求めて扇形に描く。赤く塗られていない床が「死角」。
 */
function drawMap(canvas: HTMLCanvasElement, data: MapData, cssW: number): MapCanvas {
  const pad = 0.8;
  const worldW = data.halfX * 2 + pad * 2;
  const worldH = data.halfZ * 2 + pad * 2;
  const scale = cssW / worldW;
  const cssH = Math.round(worldH * scale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const tx = (x: number) => (x + data.halfX + pad) * scale;
  const tz = (z: number) => (z + data.halfZ + pad) * scale;
  // 文字サイズはマップ幅に比例させる（ミニマップでは小さく）
  const fs = (px: number) => Math.max(5, Math.round((px * cssW) / CANVAS_W));

  // 床
  ctx.fillStyle = '#2b2e34';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = '#454a52';
  ctx.fillRect(tx(-data.halfX), tz(-data.halfZ), data.halfX * 2 * scale, data.halfZ * 2 * scale);

  // カメラ視野（遮蔽を考慮した扇形）。重なった場所ほど濃くなる
  for (const cam of data.cams) {
    const half = ((cam.hfovDeg / 2) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(tx(cam.x), tz(cam.z));
    for (let i = 0; i <= RAYS_PER_CAM; i++) {
      const a = cam.angle - half + (2 * half * i) / RAYS_PER_CAM;
      const d = castRay(cam.x, cam.z, Math.cos(a), Math.sin(a), cam.range, data.occluders);
      ctx.lineTo(tx(cam.x + Math.cos(a) * d), tz(cam.z + Math.sin(a) * d));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 82, 82, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 棚（売り場ごとに色分け + ラベル）
  for (const s of data.shelves) {
    const w = (s.rect.maxX - s.rect.minX) * scale;
    const h = (s.rect.maxZ - s.rect.minZ) * scale;
    const x = tx(s.rect.minX);
    const y = tz(s.rect.minZ);
    ctx.fillStyle = `#${s.color.toString(16).padStart(6, '0')}`;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#1c1c22';
    ctx.font = `bold ${fs(9)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (w >= h) {
      ctx.fillText(s.label, x + w / 2, y + h / 2, w - 2);
    } else {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(s.label, 0, 0, h - 2);
      ctx.restore();
    }
  }

  // 外周の壁と出口
  ctx.strokeStyle = '#9a968f';
  ctx.lineWidth = 3;
  ctx.strokeRect(tx(-data.halfX), tz(-data.halfZ), data.halfX * 2 * scale, data.halfZ * 2 * scale);
  ctx.strokeStyle = '#43a047';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(tx(-data.exitHalfW), tz(-data.halfZ));
  ctx.lineTo(tx(data.exitHalfW), tz(-data.halfZ));
  ctx.stroke();
  ctx.fillStyle = '#43a047';
  ctx.font = `bold ${fs(9)}px sans-serif`;
  ctx.fillText('出口', tx(0), tz(-data.halfZ) - fs(8));

  // カメラ本体と番号
  for (const cam of data.cams) {
    const x = tx(cam.x);
    const y = tz(cam.z);
    ctx.beginPath();
    ctx.arc(x, y, fs(5), 0, Math.PI * 2);
    ctx.fillStyle = '#d32f2f';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${fs(7)}px sans-serif`;
    ctx.fillText(String(cam.id + 1), x, y);
  }

  return { canvas, tx, tz, cssW, cssH };
}

/**
 * 猫チーム用のカメラマップ。デフォルトは非表示で、Mキーで画面中央にモーダル表示する。
 */
export class CamMapView {
  private root: HTMLDivElement;

  constructor(parent: HTMLElement, data: MapData) {
    this.root = document.createElement('div');
    this.root.className = 'cam-map-modal hidden';
    this.root.innerHTML = `
      <div class="cam-map-panel">
        <div class="cam-map-head">
          <span>📷 カメラマップ</span>
          <span class="cam-map-hint">赤=視野 / 無色=死角</span>
          <button class="btn" id="cam-map-close">閉じる (M)</button>
        </div>
      </div>
    `;
    const panel = this.root.querySelector<HTMLDivElement>('.cam-map-panel')!;
    const canvas = document.createElement('canvas');
    panel.appendChild(canvas);
    this.root.querySelector<HTMLButtonElement>('#cam-map-close')!.onclick = () => this.toggle();
    // 背景クリックでも閉じる（パネル内クリックは無視）
    this.root.onclick = (e) => {
      if (e.target === this.root) this.toggle();
    };
    parent.appendChild(this.root);
    drawMap(canvas, data, CANVAS_W);
  }

  toggle(): void {
    this.root.classList.toggle('hidden');
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * ネズミ用のミニマップ。猫のカメラマップと同じ図を画面左下に常時表示し、
 * 自分の位置と向きを毎フレーム重ねて描く（静止画は一度だけ描いてコピーする）。
 */
export class MiniMapView {
  private root: HTMLDivElement;
  private base: MapCanvas;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr: number;

  constructor(parent: HTMLElement, data: MapData) {
    this.root = document.createElement('div');
    this.root.className = 'mini-map';
    this.base = drawMap(document.createElement('canvas'), data, MINI_W);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.base.canvas.width;
    this.canvas.height = this.base.canvas.height;
    this.canvas.style.width = this.base.canvas.style.width;
    this.canvas.style.height = this.base.canvas.style.height;
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.dpr = this.base.canvas.width / this.base.cssW;
  }

  /** 自分の位置・向き（ry: Three.jsのY回転、前方=(sin ry, cos ry)）を描く。hidden=リスポーン待ち中 */
  update(x: number, z: number, ry: number, hidden: boolean): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base.canvas, 0, 0);
    if (hidden) return;
    ctx.scale(this.dpr, this.dpr);
    const px = this.base.tx(x);
    const py = this.base.tz(z);
    // 向きの矢印（進行方向の小さな三角）
    ctx.save();
    ctx.translate(px, py);
    // 画面座標では前方=(sin ry, cos ry)。三角は上向き(-y)基準なので+90°回す
    ctx.rotate(Math.atan2(Math.cos(ry), Math.sin(ry)) + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(-5, -4);
    ctx.lineTo(5, -4);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();
    // 自分の位置（白い縁取りの黄色い点）
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffb300';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  dispose(): void {
    this.root.remove();
  }
}
