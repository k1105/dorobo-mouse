import { CONFIG } from '../config';
import { mulberry32 } from './rng';
import { CORRIDOR_XS, LANE_ZS } from './world';

interface Segment {
  t0: number;
  t1: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * NPCネズミの決定論的シミュレーション。
 * 同じseedなら全クライアントで posAt(t) が同じ値を返すため、位置の通信同期が不要。
 * 移動は「通路（縦レーン）内の移動」と「両端の横道(z=±10)経由の通路替え」のみで、棚を貫通しない。
 */
export class NpcSim {
  private rng: () => number;
  private speed: number;
  private segs: Segment[] = [];
  private genUntil = 0;
  private curCorridor: number;
  private curLane: number;
  private searchIdx = 0;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
    this.speed =
      CONFIG.npcSpeedMin + this.rng() * (CONFIG.npcSpeedMax - CONFIG.npcSpeedMin);
    this.curCorridor = Math.floor(this.rng() * CORRIDOR_XS.length);
    this.curLane = Math.floor(this.rng() * LANE_ZS.length);
    // 初期位置に少し立ち止まってから動き出す
    const x = this.jitterX(this.curCorridor);
    const z = LANE_ZS[this.curLane];
    this.segs.push({ t0: 0, t1: 0.5 + this.rng() * 2, x0: x, z0: z, x1: x, z1: z });
    this.genUntil = this.segs[0].t1;
  }

  /** 通路の中でロボットっぽくならないよう横に少しずらす */
  private jitterX(corridorIdx: number): number {
    return CORRIDOR_XS[corridorIdx] + (this.rng() - 0.5) * 1.2;
  }

  private lastPos(): { x: number; z: number } {
    const s = this.segs[this.segs.length - 1];
    return { x: s.x1, z: s.z1 };
  }

  private walkTo(x: number, z: number): void {
    const from = this.lastPos();
    const dist = Math.hypot(x - from.x, z - from.z);
    if (dist < 0.01) return;
    const dur = dist / this.speed;
    this.segs.push({
      t0: this.genUntil,
      t1: this.genUntil + dur,
      x0: from.x,
      z0: from.z,
      x1: x,
      z1: z,
    });
    this.genUntil += dur;
  }

  private pause(sec: number): void {
    const p = this.lastPos();
    this.segs.push({
      t0: this.genUntil,
      t1: this.genUntil + sec,
      x0: p.x,
      z0: p.z,
      x1: p.x,
      z1: p.z,
    });
    this.genUntil += sec;
  }

  /** 次の行動（別の棚を見に行く）を1つ生成 */
  private genNextTrip(): void {
    const targetCorridor = Math.floor(this.rng() * CORRIDOR_XS.length);
    const targetLane = Math.floor(this.rng() * LANE_ZS.length);
    if (targetCorridor !== this.curCorridor) {
      // 通路替えは横道（LANE_ZSの両端）を経由する
      const rowLane = this.rng() < 0.5 ? 0 : LANE_ZS.length - 1;
      const rowZ = LANE_ZS[rowLane];
      const exitX = this.jitterX(this.curCorridor);
      this.walkTo(exitX, rowZ);
      this.walkTo(this.jitterX(targetCorridor), rowZ);
    }
    const destX = this.jitterX(targetCorridor);
    const destZ = LANE_ZS[targetLane] + (this.rng() - 0.5) * 1.5;
    this.walkTo(destX, destZ);
    this.pause(1 + this.rng() * 4); // 棚の前で品定め
    this.curCorridor = targetCorridor;
    this.curLane = targetLane;
  }

  private ensure(t: number): void {
    while (this.genUntil < t + 5) this.genNextTrip();
  }

  /** 経過時間 t 秒での位置と向きを返す */
  posAt(t: number): { x: number; z: number; ry: number } {
    this.ensure(t);
    // 前回のインデックスから前方に探す（tは単調増加なのでO(1)）
    if (this.searchIdx >= this.segs.length || this.segs[this.searchIdx].t0 > t) {
      this.searchIdx = 0;
    }
    while (
      this.searchIdx < this.segs.length - 1 &&
      this.segs[this.searchIdx].t1 < t
    ) {
      this.searchIdx++;
    }
    const s = this.segs[this.searchIdx];
    const dur = s.t1 - s.t0;
    const k = dur <= 0 ? 1 : Math.min(1, Math.max(0, (t - s.t0) / dur));
    const x = s.x0 + (s.x1 - s.x0) * k;
    const z = s.z0 + (s.z1 - s.z0) * k;
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;
    const ry = dx * dx + dz * dz > 0.0001 ? Math.atan2(dx, dz) : 0;
    return { x, z, ry };
  }
}

/** ゲームseedからNPC群を作る */
export function createNpcSims(seed: number, count: number): NpcSim[] {
  const sims: NpcSim[] = [];
  for (let i = 0; i < count; i++) {
    sims.push(new NpcSim((seed ^ (i * 0x9e3779b9)) >>> 0));
  }
  return sims;
}
