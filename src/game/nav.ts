import type { Rect } from './world';

/** ノード判定時に障害物から取るクリアランス（キャラ半径0.35+余裕） */
const NODE_CLEAR = 0.6;
/** 経路の直線化（ショートカット）判定時のクリアランス */
const LOS_CLEAR = 0.55;

/**
 * 障害物の配置から自動生成する歩行グリッド（1m間隔の格子）。
 * レイアウトを変えてもNPCの経路が壊れないよう、world.tsの障害物リストだけから作る。
 * 全クライアントで同一の障害物から作るため決定論的（NPC同期の前提）。
 */
export class NavGrid {
  private minX: number;
  private minZ: number;
  private cols: number;
  private rows: number;
  private walk: Uint8Array;
  private obstacles: Rect[];
  /** 最大連結成分に属する歩行可能ノードのインデックス一覧 */
  private nodeList: number[] = [];

  constructor(
    obstacles: Rect[],
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ) {
    this.obstacles = obstacles;
    this.minX = Math.ceil(minX);
    this.minZ = Math.ceil(minZ);
    this.cols = Math.floor(maxX) - this.minX + 1;
    this.rows = Math.floor(maxZ) - this.minZ + 1;
    this.walk = new Uint8Array(this.cols * this.rows);
    for (let iz = 0; iz < this.rows; iz++) {
      for (let ix = 0; ix < this.cols; ix++) {
        if (this.isClear(this.minX + ix, this.minZ + iz, NODE_CLEAR)) {
          this.walk[iz * this.cols + ix] = 1;
        }
      }
    }
    this.keepLargestComponent();
  }

  /** 点(x,z)が全障害物からmargin以上離れているか */
  isClear(x: number, z: number, margin: number): boolean {
    for (const o of this.obstacles) {
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

  /** 孤立した小部屋にNPCが湧かないよう、最大の連結成分だけを残す */
  private keepLargestComponent(): void {
    const comp = new Int32Array(this.cols * this.rows).fill(-1);
    const sizes: number[] = [];
    const queue: number[] = [];
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
        const ix = cur % this.cols;
        const iz = Math.floor(cur / this.cols);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nx >= this.cols || nz < 0 || nz >= this.rows) continue;
          const ni = nz * this.cols + nx;
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

  private toXZ(idx: number): { x: number; z: number } {
    return {
      x: this.minX + (idx % this.cols),
      z: this.minZ + Math.floor(idx / this.cols),
    };
  }

  /** ランダムな歩行可能ノードを返す */
  randomNode(rng: () => number): { x: number; z: number } {
    return this.toXZ(this.nodeList[Math.floor(rng() * this.nodeList.length)]);
  }

  /** (x,z)からおよそradius以内のランダムなノードを返す。見つからなければ全域から */
  randomNodeNear(
    x: number,
    z: number,
    radius: number,
    rng: () => number,
  ): { x: number; z: number } {
    for (let tries = 0; tries < 12; tries++) {
      const nx = Math.round(x + (rng() - 0.5) * 2 * radius);
      const nz = Math.round(z + (rng() - 0.5) * 2 * radius);
      const ix = nx - this.minX;
      const iz = nz - this.minZ;
      if (ix < 0 || ix >= this.cols || iz < 0 || iz >= this.rows) continue;
      if (this.walk[iz * this.cols + ix]) return { x: nx, z: nz };
    }
    return this.randomNode(rng);
  }

  /** (x,z)に最も近い歩行可能ノードのインデックス（近傍を螺旋探索） */
  private nearestIdx(x: number, z: number): number {
    const cx = Math.round(x) - this.minX;
    const cz = Math.round(z) - this.minZ;
    for (let r = 0; r < Math.max(this.cols, this.rows); r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx;
          const iz = cz + dz;
          if (ix < 0 || ix >= this.cols || iz < 0 || iz >= this.rows) continue;
          const i = iz * this.cols + ix;
          if (this.walk[i]) return i;
        }
      }
    }
    return this.nodeList[0];
  }

  /** 2点間に障害物がないか（経路の直線化用） */
  private los(x0: number, z0: number, x1: number, z1: number): boolean {
    const dist = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(dist / 0.4);
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      if (!this.isClear(x0 + (x1 - x0) * k, z0 + (z1 - z0) * k, LOS_CLEAR)) {
        return false;
      }
    }
    return true;
  }

  /**
   * BFS最短経路 + 直線化した中継点リストを返す（始点は含まない）。
   * 到達不能なら目的地への直行（保険。最大成分内なら起きない）。
   */
  path(x0: number, z0: number, x1: number, z1: number): { x: number; z: number }[] {
    const start = this.nearestIdx(x0, z0);
    const goal = this.nearestIdx(x1, z1);
    const prev = new Int32Array(this.cols * this.rows).fill(-2);
    prev[start] = -1;
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === goal) break;
      const ix = cur % this.cols;
      const iz = Math.floor(cur / this.cols);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = ix + dx;
        const nz = iz + dz;
        if (nx < 0 || nx >= this.cols || nz < 0 || nz >= this.rows) continue;
        const ni = nz * this.cols + nx;
        if (this.walk[ni] && prev[ni] === -2) {
          prev[ni] = cur;
          queue.push(ni);
        }
      }
    }
    if (prev[goal] === -2) return [{ x: x1, z: z1 }];
    const raw: { x: number; z: number }[] = [];
    for (let cur = goal; cur !== -1; cur = prev[cur]) raw.push(this.toXZ(cur));
    raw.reverse();
    // 直線で見通せる限り中継点をスキップして自然な歩行ラインにする
    const out: { x: number; z: number }[] = [];
    let ax = x0;
    let az = z0;
    let i = 0;
    while (i < raw.length) {
      let far = i;
      for (let j = raw.length - 1; j > i; j--) {
        if (this.los(ax, az, raw[j].x, raw[j].z)) {
          far = j;
          break;
        }
      }
      out.push(raw[far]);
      ax = raw[far].x;
      az = raw[far].z;
      i = far + 1;
    }
    return out;
  }
}
