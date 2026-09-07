import type { Rect } from './stages';

/** ノード判定時に障害物から取るクリアランス（キャラ半径0.35+余裕） */
const NODE_CLEAR = 0.6;
/** 経路の直線化（ショートカット）判定時のクリアランス */
const LOS_CLEAR = 0.55;

/** 歩行グリッド上の点。layer はフロア番号（floors のインデックス） */
export interface NavNode {
  x: number;
  z: number;
  layer: number;
}

/** 1フロア分の歩行領域 */
export interface NavLayer {
  obstacles: Rect[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** フロア間の接続（スロープの上端など）。a と b に最も近いノード同士を双方向に繋ぐ */
export interface NavLink {
  a: NavNode;
  b: NavNode;
}

interface LayerGrid {
  obstacles: Rect[];
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** このレイヤの先頭ノードのグローバルインデックス */
  base: number;
}

/**
 * 障害物の配置から自動生成する歩行グリッド（1m間隔の格子）。フロアごとにレイヤを持ち、
 * links でレイヤ間を繋ぐ（スロープ）。
 * レイアウトを変えてもNPCの経路が壊れないよう、world.tsの障害物リストだけから作る。
 * 全クライアントで同一の障害物から作るため決定論的（NPC同期の前提）。
 */
export class NavGrid {
  private layers: LayerGrid[] = [];
  private walk: Uint8Array;
  /** レイヤ間リンク（グローバルインデックス → 接続先）。同一レイヤの4近傍は別途計算する */
  private links = new Map<number, number[]>();
  /** 最大連結成分に属する歩行可能ノードのインデックス一覧 */
  private nodeList: number[] = [];

  constructor(layers: NavLayer[], links: NavLink[] = []) {
    let base = 0;
    for (const l of layers) {
      const minX = Math.ceil(l.minX);
      const minZ = Math.ceil(l.minZ);
      const cols = Math.floor(l.maxX) - minX + 1;
      const rows = Math.floor(l.maxZ) - minZ + 1;
      this.layers.push({ obstacles: l.obstacles, minX, minZ, cols, rows, base });
      base += cols * rows;
    }
    this.walk = new Uint8Array(base);
    this.layers.forEach((g, layer) => {
      for (let iz = 0; iz < g.rows; iz++) {
        for (let ix = 0; ix < g.cols; ix++) {
          if (this.isClear(g.minX + ix, g.minZ + iz, NODE_CLEAR, layer)) {
            this.walk[g.base + iz * g.cols + ix] = 1;
          }
        }
      }
    });
    for (const link of links) {
      const a = this.nearestIdx(link.a);
      const b = this.nearestIdx(link.b);
      if (a === b) continue;
      this.links.set(a, [...(this.links.get(a) ?? []), b]);
      this.links.set(b, [...(this.links.get(b) ?? []), a]);
    }
    this.keepLargestComponent();
  }

  /** 点(x,z)がそのレイヤの全障害物からmargin以上離れているか */
  isClear(x: number, z: number, margin: number, layer: number): boolean {
    for (const o of this.layers[layer].obstacles) {
      if (
        x > o.minX - margin &&
        x < o.maxX + margin &&
        z > o.minZ - margin &&
        z < o.maxZ + margin
      ) {
        return false;
      }
    }
    return true;
  }

  private layerOf(idx: number): number {
    for (let l = this.layers.length - 1; l >= 0; l--) {
      if (idx >= this.layers[l].base) return l;
    }
    return 0;
  }

  /** 隣接ノード（同一レイヤの4近傍 + レイヤ間リンク） */
  private neighbors(idx: number, out: number[]): void {
    out.length = 0;
    const g = this.layers[this.layerOf(idx)];
    const local = idx - g.base;
    const ix = local % g.cols;
    const iz = Math.floor(local / g.cols);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = ix + dx;
      const nz = iz + dz;
      if (nx < 0 || nx >= g.cols || nz < 0 || nz >= g.rows) continue;
      out.push(g.base + nz * g.cols + nx);
    }
    const linked = this.links.get(idx);
    if (linked) for (const n of linked) out.push(n);
  }

  /** 孤立した小部屋にNPCが湧かないよう、最大の連結成分だけを残す */
  private keepLargestComponent(): void {
    const comp = new Int32Array(this.walk.length).fill(-1);
    const sizes: number[] = [];
    const queue: number[] = [];
    const nb: number[] = [];
    for (let start = 0; start < this.walk.length; start++) {
      if (!this.walk[start] || comp[start] >= 0) continue;
      const id = sizes.length;
      sizes.push(0);
      comp[start] = id;
      queue.length = 0;
      queue.push(start);
      while (queue.length > 0) {
        const cur = queue.pop()!;
        sizes[id]++;
        this.neighbors(cur, nb);
        for (const ni of nb) {
          if (this.walk[ni] && comp[ni] < 0) {
            comp[ni] = id;
            queue.push(ni);
          }
        }
      }
    }
    let best = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i;
    for (let i = 0; i < this.walk.length; i++) {
      if (this.walk[i] && comp[i] !== best) this.walk[i] = 0;
      if (this.walk[i]) this.nodeList.push(i);
    }
  }

  private toNode(idx: number): NavNode {
    const layer = this.layerOf(idx);
    const g = this.layers[layer];
    const local = idx - g.base;
    return { x: g.minX + (local % g.cols), z: g.minZ + Math.floor(local / g.cols), layer };
  }

  /** ランダムな歩行可能ノードを返す */
  randomNode(rng: () => number): NavNode {
    return this.toNode(this.nodeList[Math.floor(rng() * this.nodeList.length)]);
  }

  /** from と同じフロアで、およそradius以内のランダムなノードを返す。見つからなければ全域から */
  randomNodeNear(from: NavNode, radius: number, rng: () => number): NavNode {
    const g = this.layers[from.layer];
    for (let tries = 0; tries < 12; tries++) {
      const nx = Math.round(from.x + (rng() - 0.5) * 2 * radius);
      const nz = Math.round(from.z + (rng() - 0.5) * 2 * radius);
      const ix = nx - g.minX;
      const iz = nz - g.minZ;
      if (ix < 0 || ix >= g.cols || iz < 0 || iz >= g.rows) continue;
      if (this.walk[g.base + iz * g.cols + ix]) return { x: nx, z: nz, layer: from.layer };
    }
    return this.randomNode(rng);
  }

  /** 同じフロアで(x,z)に最も近い歩行可能ノードのインデックス（近傍を螺旋探索） */
  private nearestIdx(p: NavNode): number {
    const g = this.layers[p.layer];
    const cx = Math.round(p.x) - g.minX;
    const cz = Math.round(p.z) - g.minZ;
    for (let r = 0; r < Math.max(g.cols, g.rows); r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx;
          const iz = cz + dz;
          if (ix < 0 || ix >= g.cols || iz < 0 || iz >= g.rows) continue;
          const i = g.base + iz * g.cols + ix;
          if (this.walk[i]) return i;
        }
      }
    }
    return this.nodeList[0] ?? g.base;
  }

  /** 同一フロアの2点間に障害物がないか（経路の直線化用） */
  private los(x0: number, z0: number, x1: number, z1: number, layer: number): boolean {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(dist / 0.4);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      if (!this.isClear(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, LOS_CLEAR, layer)) {
        return false;
      }
    }
    return true;
  }

  /**
   * BFS最短経路 + 直線化した中継点リストを返す（始点は含まない）。
   * 直線化は同じフロアの点同士でのみ行う（スロープの接続点は必ず経由する）。
   * 到達不能なら目的地への直行（保険。最大成分内なら起きない）。
   */
  path(from: NavNode, to: NavNode): NavNode[] {
    const start = this.nearestIdx(from);
    const goal = this.nearestIdx(to);
    const prev = new Int32Array(this.walk.length).fill(-2);
    prev[start] = -1;
    const queue = [start];
    let head = 0;
    const nb: number[] = [];
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === goal) break;
      this.neighbors(cur, nb);
      for (const ni of nb) {
        if (this.walk[ni] && prev[ni] === -2) {
          prev[ni] = cur;
          queue.push(ni);
        }
      }
    }
    if (prev[goal] === -2) return [{ x: to.x, z: to.z, layer: to.layer }];
    const raw: NavNode[] = [];
    for (let cur = goal; cur !== -1; cur = prev[cur]) raw.push(this.toNode(cur));
    raw.reverse();
    // 直線で見通せる限り中継点をスキップして自然な歩行ラインにする
    const out: NavNode[] = [];
    let ax = from.x;
    let az = from.z;
    let al = from.layer;
    let i = 0;
    while (i < raw.length) {
      let far = i;
      for (let j = raw.length - 1; j > i; j--) {
        if (raw[j].layer === al && this.los(ax, az, raw[j].x, raw[j].z, al)) {
          far = j;
          break;
        }
      }
      out.push(raw[far]);
      ax = raw[far].x;
      az = raw[far].z;
      al = raw[far].layer;
      i = far + 1;
    }
    return out;
  }
}
