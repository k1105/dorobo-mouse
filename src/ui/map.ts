import type { MapData } from '../game/world';
import { castRay } from '../game/world';

/** 1フロアあたりの表示幅（CSSピクセル）。複数フロアは横に並べるので合計幅はフロア数に応じて広がる */
const CANVAS_W = 480;
const MINI_W = 240;
/** 文字サイズ・マーカーの基準スケール（px/m）。スタンダードのマップを480pxで描いたときの値 */
const BASE_SCALE = 480 / 43.6;
/** フロア同士の間隔（ワールド単位） */
const FLOOR_GAP = 1.2;
const RAYS_PER_CAM = 72;

/** 店内レイアウトと各カメラの視野を俯瞰で描く。猫のモーダルとネズミのミニマップで共有する */
interface MapCanvas {
  canvas: HTMLCanvasElement;
  /** ワールド座標 → キャンバス座標（CSSピクセル）。floor はどのフロアの枠に描くか */
  tx: (x: number, floor: number) => number;
  tz: (z: number, floor: number) => number;
  cssW: number;
  cssH: number;
}

/** フロア数に応じたマップの表示幅。2フロアなら1フロアの1.6倍程度に抑える */
function widthFor(perFloor: number, floors: number): number {
  return Math.round(perFloor * (1 + (floors - 1) * 0.6));
}

/** 猫の操作用マップで、誰がどのカメラをオンラインにしているか */
interface CamOnline {
  /** 自分がオンラインにしているカメラ（赤で描く） */
  mine: ReadonlySet<number>;
  /** 相方（他の猫プレイヤー）がオンラインにしているカメラ（青で描く） */
  others: ReadonlySet<number>;
}

/**
 * 店内マップを描画したキャンバスを作る。
 * 視野は棚・壁で遮蔽された実効範囲を2Dレイキャストで求めて扇形に描く。塗られていない床が「死角」。
 * online を渡すと、自分がオンラインにしたカメラを赤、相方がオンラインにしたカメラを青の視野で描き、
 * 誰もオンにしていないカメラは薄い輪郭のみにする（猫の操作用）。
 */
function drawMap(
  canvas: HTMLCanvasElement,
  data: MapData,
  cssW: number,
  online?: CamOnline,
): MapCanvas {
  const pad = 0.8;
  const floors = data.floors;
  // フロアを横に並べる。各フロアの枠の左端（ワールド単位のオフセット）
  const offsets: number[] = [];
  let worldW = 0;
  let worldH = 0;
  floors.forEach((f, i) => {
    if (i > 0) worldW += FLOOR_GAP;
    offsets.push(worldW);
    worldW += f.rect.maxX - f.rect.minX + pad * 2;
    worldH = Math.max(worldH, f.rect.maxZ - f.rect.minZ + pad * 2);
  });
  const scale = cssW / worldW;
  const cssH = Math.round(worldH * scale);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const tx = (x: number, floor: number) =>
    (offsets[floor] + pad + x - floors[floor].rect.minX) * scale;
  const tz = (z: number, floor: number) => (pad + z - floors[floor].rect.minZ) * scale;
  // 文字サイズは描画スケールに比例させる（ミニマップでは小さく）
  const fs = (px: number) => Math.max(5, Math.round((px * scale) / BASE_SCALE));

  const isMine = (id: number) => !online || online.mine.has(id);
  const isOthers = (id: number) => !!online && online.others.has(id);
  const isOn = (id: number) => isMine(id) || isOthers(id);

  // 背景
  ctx.fillStyle = '#2b2e34';
  ctx.fillRect(0, 0, cssW, cssH);

  floors.forEach((floor, fi) => {
    const fw = (floor.rect.maxX - floor.rect.minX) * scale;
    const fh = (floor.rect.maxZ - floor.rect.minZ) * scale;
    const fx = tx(floor.rect.minX, fi);
    const fy = tz(floor.rect.minZ, fi);

    // 床
    ctx.fillStyle = '#454a52';
    ctx.fillRect(fx, fy, fw, fh);

    // スロープ（下のフロアでは坂、上のフロアでは吹き抜け）
    for (const ramp of data.ramps) {
      if (ramp.from !== fi && ramp.to !== fi) continue;
      const r = ramp.rect;
      const x0 = Math.max(r.minX, floor.rect.minX);
      const x1 = Math.min(r.maxX, floor.rect.maxX);
      const z0 = Math.max(r.minZ, floor.rect.minZ);
      const z1 = Math.min(r.maxZ, floor.rect.maxZ);
      if (x0 >= x1 || z0 >= z1) continue;
      const rx = tx(x0, fi);
      const ry = tz(z0, fi);
      const rw = (x1 - x0) * scale;
      const rh = (z1 - z0) * scale;
      ctx.fillStyle = ramp.to === fi ? '#2b2e34' : '#6b6f78';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#cfd3da';
      ctx.lineWidth = 1;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
      const other = floors[ramp.to === fi ? ramp.from : ramp.to];
      const arrow =
        ramp.to === fi
          ? { n: '↓', s: '↑', e: '←', w: '→' }[ramp.up]
          : { n: '↑', s: '↓', e: '→', w: '←' }[ramp.up];
      ctx.fillStyle = '#e8ebf0';
      ctx.font = `bold ${fs(9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.translate(rx + rw / 2, ry + rh / 2);
      if (rh > rw) ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${arrow}${other.name}`, 0, 0, Math.max(rw, rh) - 2);
      ctx.restore();
    }

    // カメラ視野（遮蔽を考慮した扇形）。重なった場所ほど濃くなる
    for (const cam of floor.cams) {
      const half = ((cam.hfovDeg / 2) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(tx(cam.x, fi), tz(cam.z, fi));
      for (let i = 0; i <= RAYS_PER_CAM; i++) {
        const a = cam.angle - half + (2 * half * i) / RAYS_PER_CAM;
        const d = castRay(cam.x, cam.z, Math.cos(a), Math.sin(a), cam.range, floor.occluders);
        ctx.lineTo(tx(cam.x + Math.cos(a) * d, fi), tz(cam.z + Math.sin(a) * d, fi));
      }
      ctx.closePath();
      if (isOn(cam.id)) {
        // 相方が見ている視野は青、自分の視野は赤。両方オンなら重ねて描く
        if (isOthers(cam.id)) {
          ctx.fillStyle = 'rgba(80, 170, 255, 0.16)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(80, 170, 255, 0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (isMine(cam.id)) {
          ctx.fillStyle = 'rgba(255, 82, 82, 0.16)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 82, 82, 0.45)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
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
    for (const s of floor.shelves) {
      const w = (s.rect.maxX - s.rect.minX) * scale;
      const h = (s.rect.maxZ - s.rect.minZ) * scale;
      const x = tx(s.rect.minX, fi);
      const y = tz(s.rect.minZ, fi);
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
    ctx.strokeRect(fx, fy, fw, fh);
    if (floor.exit) {
      ctx.strokeStyle = '#43a047';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(tx(floor.exit.x - floor.exit.halfW, fi), fy);
      ctx.lineTo(tx(floor.exit.x + floor.exit.halfW, fi), fy);
      ctx.stroke();
      ctx.fillStyle = '#43a047';
      ctx.font = `bold ${fs(9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('出口', tx(floor.exit.x, fi), fy - fs(8));
    }
    // フロア名（複数フロアのときだけ。枠の上の余白に描く）
    if (floors.length > 1) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${fs(8)}px sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(floor.name, fx + fs(16), fy - 2);
    }

    // カメラ本体と番号（猫の操作用マップでは大きく描いてクリックしやすくし、オフラインは灰色にする）。
    // 自分がオンにしたカメラは赤、相方だけがオンにしたカメラは青、両方なら赤い本体に青いリング
    const camR = online ? fs(14) : fs(5);
    for (const cam of floor.cams) {
      const x = tx(cam.x, fi);
      const y = tz(cam.z, fi);
      const on = isOn(cam.id);
      const mine = isMine(cam.id);
      const others = isOthers(cam.id);
      if (mine && others) {
        ctx.beginPath();
        ctx.arc(x, y, camR + 4, 0, Math.PI * 2);
        ctx.fillStyle = '#3d9be9';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, camR, 0, Math.PI * 2);
      ctx.fillStyle = mine ? '#d32f2f' : others ? '#3d9be9' : '#5a5f68';
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
  });

  return { canvas, tx, tz, cssW, cssH };
}

/** カメラマーカーのクリック判定半径（CSSピクセル） */
const CAM_HIT_R = 20;

/**
 * 猫チーム用のカメラ操作マップ。CCTV画面の一番下に常時表示し、
 * マップ上のカメラ番号をクリックするとそのカメラをオンライン⇔オフラインする。
 * 自分がオンにしたカメラは赤い視野、相方（他の猫）がオンにしたカメラは青い視野、オフラインは灰色。
 * Mキーで表示/非表示。
 */
export class CamMapView {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private status: HTMLSpanElement;
  private data: MapData;
  private map: MapCanvas;
  private online = new Set<number>();
  private others = new Set<number>();

  constructor(parent: HTMLElement, data: MapData, onCamClick: (camId: number) => void) {
    this.data = data;
    this.root = document.createElement('div');
    this.root.className = 'cam-map';
    this.root.innerHTML = `
      <div class="cam-map-head">
        <span>📷 カメラ <span class="cam-map-status"></span></span>
        <span class="cam-map-hint">番号クリックで ON/OFF・<span class="cam-map-mine">赤=自分</span>・<span class="cam-map-others">青=相方</span>の視野</span>
      </div>
    `;
    this.status = this.root.querySelector<HTMLSpanElement>('.cam-map-status')!;
    this.canvas = document.createElement('canvas');
    this.root.appendChild(this.canvas);
    parent.appendChild(this.root);
    this.map = this.redraw();

    this.canvas.addEventListener('click', (e) => {
      const id = this.camAt(e);
      if (id !== null) onCamClick(id);
    });
    // カメラの上ではカーソルをポインタにする
    this.canvas.addEventListener('mousemove', (e) => {
      this.canvas.style.cursor = this.camAt(e) !== null ? 'pointer' : 'default';
    });
  }

  private redraw(): MapCanvas {
    return drawMap(this.canvas, this.data, widthFor(CANVAS_W, this.data.floors.length), {
      mine: this.online,
      others: this.others,
    });
  }

  /** パネルの表示高さ（CSSピクセル）。非表示なら0。CCTVのモニタ配置が下側の余白として使う */
  panelHeight(): number {
    return this.root.offsetHeight;
  }

  /** 自分がオンラインにしているカメラID一覧を反映して描き直す */
  setOnline(ids: number[], max: number): void {
    this.online = new Set(ids);
    this.map = this.redraw();
    this.status.textContent = `${ids.length}/${max} ONLINE`;
  }

  /** 相方（他の猫プレイヤー）がオンラインにしているカメラを反映して描き直す */
  setOthers(ids: ReadonlySet<number>): void {
    if (ids.size === this.others.size && [...ids].every((id) => this.others.has(id))) return;
    this.others = new Set(ids);
    this.map = this.redraw();
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
    this.data.floors.forEach((floor, fi) => {
      for (const cam of floor.cams) {
        const d = Math.hypot(this.map.tx(cam.x, fi) - px, this.map.tz(cam.z, fi) - py);
        if (d < bestD) {
          bestD = d;
          best = cam.id;
        }
      }
    });
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
    this.base = drawMap(document.createElement('canvas'), data, widthFor(MINI_W, data.floors.length));
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

  /** 自分の位置・向き（ry: Three.jsのY回転、前方=(sin ry, cos ry)）とフロアを描く。hidden=リスポーン待ち中 */
  update(x: number, z: number, ry: number, hidden: boolean, floor: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.base.canvas, 0, 0);
    if (hidden) return;
    ctx.scale(this.dpr, this.dpr);
    const px = this.base.tx(x, floor);
    const py = this.base.tz(z, floor);
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
