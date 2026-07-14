import type { MapData, Rect } from '../game/world';

const CANVAS_W = 480;
const RAYS_PER_CAM = 72;

/**
 * 猫チーム用のカメラマップ。店内レイアウトと各カメラの視野（FOV）を俯瞰で表示する。
 * 視野は棚・壁で遮蔽された実効範囲を2Dレイキャストで求めて扇形に描く。
 * 赤く塗られていない床が「死角」。レイアウトは静的なので初期化時に1度だけ描画する。
 */
export class CamMapView {
  private root: HTMLDivElement;

  constructor(parent: HTMLElement, data: MapData) {
    this.root = document.createElement('div');
    this.root.className = 'cam-map';
    this.root.innerHTML = `
      <div class="cam-map-head">
        <span>📷 カメラマップ</span>
        <span class="cam-map-hint">赤=視野 / 無色=死角 (M)</span>
      </div>
    `;
    const canvas = document.createElement('canvas');
    this.root.appendChild(canvas);
    this.root.querySelector<HTMLDivElement>('.cam-map-head')!.onclick = () =>
      this.toggle();
    parent.appendChild(this.root);
    this.draw(canvas, data);
  }

  toggle(): void {
    this.root.classList.toggle('collapsed');
  }

  private draw(canvas: HTMLCanvasElement, data: MapData): void {
    const pad = 0.8;
    const worldW = data.halfX * 2 + pad * 2;
    const worldH = data.halfZ * 2 + pad * 2;
    const scale = CANVAS_W / worldW;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = CANVAS_W * dpr;
    canvas.height = Math.round(worldH * scale) * dpr;
    canvas.style.width = `${CANVAS_W}px`;
    canvas.style.height = `${Math.round(worldH * scale)}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const tx = (x: number) => (x + data.halfX + pad) * scale;
    const tz = (z: number) => (z + data.halfZ + pad) * scale;

    // 床
    ctx.fillStyle = '#2b2e34';
    ctx.fillRect(0, 0, CANVAS_W, worldH * scale);
    ctx.fillStyle = '#454a52';
    ctx.fillRect(
      tx(-data.halfX),
      tz(-data.halfZ),
      data.halfX * 2 * scale,
      data.halfZ * 2 * scale,
    );

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
      ctx.font = 'bold 9px sans-serif';
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
    ctx.strokeRect(
      tx(-data.halfX),
      tz(-data.halfZ),
      data.halfX * 2 * scale,
      data.halfZ * 2 * scale,
    );
    ctx.strokeStyle = '#43a047';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(tx(-data.exitHalfW), tz(-data.halfZ));
    ctx.lineTo(tx(data.exitHalfW), tz(-data.halfZ));
    ctx.stroke();
    ctx.fillStyle = '#43a047';
    ctx.font = 'bold 9px sans-serif';
    ctx.fillText('出口', tx(0), tz(-data.halfZ) - 8);

    // カメラ本体と番号
    for (const cam of data.cams) {
      const x = tx(cam.x);
      const y = tz(cam.z);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#d32f2f';
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 7px sans-serif';
      ctx.fillText(String(cam.id + 1), x, y);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** 2Dレイと矩形群の最近傍交点までの距離（なければmaxDist） */
function castRay(
  px: number,
  pz: number,
  dx: number,
  dz: number,
  maxDist: number,
  rects: Rect[],
): number {
  let best = maxDist;
  for (const r of rects) {
    // slab法によるレイ-AABB交差
    let tmin = -Infinity;
    let tmax = Infinity;
    if (Math.abs(dx) < 1e-9) {
      if (px < r.minX || px > r.maxX) continue;
    } else {
      const t1 = (r.minX - px) / dx;
      const t2 = (r.maxX - px) / dx;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (Math.abs(dz) < 1e-9) {
      if (pz < r.minZ || pz > r.maxZ) continue;
    } else {
      const t1 = (r.minZ - pz) / dz;
      const t2 = (r.maxZ - pz) / dz;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    if (tmax >= tmin && tmax > 0 && tmin < best) {
      best = Math.max(0, tmin);
    }
  }
  return best;
}
