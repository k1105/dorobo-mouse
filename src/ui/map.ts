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
 * online を渡すと、オンラインのカメラだけ赤い視野で描き、オフラインのカメラは薄い輪郭のみにする（猫の操作用）。
 */
function drawMap(
  canvas: HTMLCanvasElement,
  data: MapData,
  cssW: number,
  online?: ReadonlySet<number>,
): MapCanvas {
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
  const isOn = (id: number) => !online || online.has(id);
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
    if (isOn(cam.id)) {
      ctx.fillStyle = 'rgba(255, 82, 82, 0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 82, 82, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // オフライン: 起動したときの視野が分かるよう薄い点線の輪郭だけ描く
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 棚（料金帯ごとに色分け + 売り場ラベル）
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

  // カメラ本体と番号（猫の操作用マップでは大きく描いてクリックしやすくし、オフラインは灰色にする）
  const camR = online ? fs(14) : fs(5);
  for (const cam of data.cams) {
    const x = tx(cam.x);
    const y = tz(cam.z);
    const on = isOn(cam.id);
    ctx.beginPath();
    ctx.arc(x, y, camR, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#d32f2f' : '#5a5f68';
    ctx.fill();
    ctx.strokeStyle = on ? '#fff' : '#aaa';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = on ? '#fff' : '#ddd';
    ctx.font = `bold ${fs(online ? 13 : 7)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(cam.id + 1), x, y);
  }

  return { canvas, tx, tz, cssW, cssH };
}

/** カメラマーカーのクリック判定半径（CSSピクセル） */
const CAM_HIT_R = 20;

/**
 * 猫チーム用のカメラ操作マップ。CCTV画面の中央（4つのモニタの間の空き）に常時表示し、
 * マップ上のカメラ番号をクリックするとそのカメラをオンライン⇔オフラインする。
 * オンラインのカメラは赤い視野つき、オフラインは灰色。Mキーで表示/非表示。
 */
export class CamMapView {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private status: HTMLSpanElement;
  private data: MapData;
  private map: MapCanvas;
  private online = new Set<number>();

  constructor(parent: HTMLElement, data: MapData, onCamClick: (camId: number) => void) {
    this.data = data;
    this.root = document.createElement('div');
    this.root.className = 'cam-map';
    this.root.innerHTML = `
      <div class="cam-map-head">
        <span>📷 カメラ <span class="cam-map-status"></span></span>
        <span class="cam-map-hint">番号クリックで ON/OFF・赤=視野</span>
      </div>
    `;
    this.status = this.root.querySelector<HTMLSpanElement>('.cam-map-status')!;
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    this.map = drawMap(this.canvas, data, CANVAS_W, this.online);

    this.canvas.addEventListener('click', (e) => {
      const id = this.camAt(e);
      if (id !== null) onCamClick(id);
    });
    // カメラの上ではカーソルをポインタにする
    this.canvas.addEventListener('mousemove', (e) => {
      this.canvas.style.cursor = this.camAt(e) !== null ? 'pointer' : 'default';
    });
  }

  /** オンラインのカメラID一覧を反映して描き直す */
  setOnline(ids: number[], max: number): void {
    this.online = new Set(ids);
    this.map = drawMap(this.canvas, this.data, CANVAS_W, this.online);
    this.status.textContent = `${ids.length}/${max} ONLINE`;
  }

  /** 満杯でオンにできなかったときにパネルを揺らして知らせる */
  deny(): void {
    this.root.classList.remove('deny');
    void this.root.offsetWidth; // アニメーション再生のためのリフロー
    this.root.classList.add('deny');
  }

  /** クリック位置に一番近いカメラ（判定半径内）のID */
  private camAt(e: MouseEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    // CSS上の表示サイズが描画サイズと異なる場合（縮小表示）に備えて換算する
    const sx = this.map.cssW / rect.width;
    const sy = this.map.cssH / rect.height;
    const px = (e.clientX - rect.left) * sx;
    const py = (e.clientY - rect.top) * sy;
    let best: number | null = null;
    let bestD = CAM_HIT_R;
    for (const cam of this.data.cams) {
      const d = Math.hypot(this.map.tx(cam.x) - px, this.map.tz(cam.z) - py);
      if (d < bestD) {
        bestD = d;
        best = cam.id;
      }
    }
    return best;
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
