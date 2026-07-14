import { CONFIG } from '../config';
import { mulberry32 } from './rng';
import type { NavGrid } from './nav';

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
 * 移動は歩行グリッド（NavGrid）上のBFS経路に沿うため、棚を貫通しない。
 */
export class NpcSim {
  private rng: () => number;
  private nav: NavGrid;
  private speed: number;
  /** 立ち止まり時間の個体差（小さいほどせかせか動く） */
  private pauseScale: number;
  /** 小走りで移動する確率（個体差） */
  private scurryChance: number;
  private segs: Segment[] = [];
  private genUntil = 0;
  private searchIdx = 0;

  constructor(seed: number, nav: NavGrid) {
    this.rng = mulberry32(seed);
    this.nav = nav;
    this.speed =
      CONFIG.npcSpeedMin + this.rng() * (CONFIG.npcSpeedMax - CONFIG.npcSpeedMin);
    this.pauseScale = 0.5 + this.rng() * 1.2;
    this.scurryChance = 0.05 + this.rng() * 0.25;
    // 初期位置に少し立ち止まってから動き出す
    const start = this.nav.randomNode(this.rng);
    this.segs.push({
      t0: 0,
      t1: 0.5 + this.rng() * 2,
      x0: start.x,
      z0: start.z,
      x1: start.x,
      z1: start.z,
    });
    this.genUntil = this.segs[0].t1;
  }

  private lastPos(): { x: number; z: number } {
    const s = this.segs[this.segs.length - 1];
    return { x: s.x1, z: s.z1 };
  }

  private walkTo(x: number, z: number, speedMult = 1): void {
    const from = this.lastPos();
    const dist = Math.hypot(x - from.x, z - from.z);
    if (dist < 0.01) return;
    const dur = dist / (this.speed * speedMult);
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

  /** 目的地まで経路に沿って歩く。中継点に少しゆらぎを入れてロボットっぽさを消す */
  private walkPath(destX: number, destZ: number, speedMult: number): void {
    const from = this.lastPos();
    const pts = this.nav.path(from.x, from.z, destX, destZ);
    for (const p of pts) {
      const jx = (this.rng() - 0.5) * 0.3;
      const jz = (this.rng() - 0.5) * 0.3;
      this.walkTo(p.x + jx, p.z + jz, speedMult);
    }
  }

  /** 次の行動を1つ生成。行動パターンを確率で選ぶ */
  private genNextTrip(): void {
    const r = this.rng();
    if (r < 0.3) {
      this.genBrowse();
    } else if (r < 0.3 + this.scurryChance) {
      this.genTrip(CONFIG.npcScurryMult); // 小走りで別の棚へ
    } else {
      this.genTrip(0.85 + this.rng() * 0.3); // 歩幅にも毎回ゆらぎを入れる
    }
  }

  /** 近くの棚をゆっくり眺めて回る */
  private genBrowse(): void {
    const steps = 1 + Math.floor(this.rng() * 2);
    for (let i = 0; i < steps; i++) {
      const cur = this.lastPos();
      const dest = this.nav.randomNodeNear(cur.x, cur.z, 6, this.rng);
      this.walkPath(dest.x, dest.z, 0.6 + this.rng() * 0.25);
      this.pause((0.5 + this.rng() * 2) * this.pauseScale);
    }
  }

  /** 別の売り場を見に行く */
  private genTrip(speedMult: number): void {
    const dest = this.nav.randomNode(this.rng);
    this.walkPath(dest.x, dest.z, speedMult);
    this.pause((1 + this.rng() * 4) * this.pauseScale); // 棚の前で品定め
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
export function createNpcSims(seed: number, count: number, nav: NavGrid): NpcSim[] {
  const sims: NpcSim[] = [];
  for (let i = 0; i < count; i++) {
    sims.push(new NpcSim((seed ^ (i * 0x9e3779b9)) >>> 0, nav));
  }
  return sims;
}
