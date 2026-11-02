import type { NetAdapter } from '../net';
import {
  TRACK_HIDDEN,
  TRACK_SWAY,
  type GameEvent,
  type LogTurnEnd,
  type LogTurnInfo,
} from '../types';

/** 軌跡をまとめて書く間隔（ミリ秒）。10Hz のサンプルを1秒分ずつ1回の書き込みにする */
const FLUSH_MS = 1000;

/**
 * 1ターン分の移動ログの書き込み。
 * 自分の位置（まんびきサイド）はサンプルをバッファして1秒ごとに logs/{logId}/{turnKey}/tracks/{pid} へ追記し、
 * イベント・カメラ切替はその場で追記する。ターンのメタ情報は logIndex/{logId}/turns/{turnKey} に置く。
 * ログモニター（ui/monitor.ts）がこれを読んで再生する
 */
export class TurnLogger {
  private buf: number[] = [];
  private lastFlush = performance.now();

  constructor(
    private net: NetAdapter,
    private logId: string,
    private turnKey: string,
    private pid: string,
  ) {}

  private base(): string {
    return `logs/${this.logId}/${this.turnKey}`;
  }

  /** ターン開始時の情報（ホストが書く） */
  writeInfo(info: LogTurnInfo): void {
    this.net.set(`logIndex/${this.logId}/turns/${this.turnKey}/info`, info);
  }

  /** ターン終了の情報（ターンを終わらせたクライアントが書く） */
  writeEnd(end: LogTurnEnd): void {
    this.net.set(`logIndex/${this.logId}/turns/${this.turnKey}/end`, end);
  }

  /** 自分の位置を1サンプル記録する。tSec はターン開始からの秒 */
  sample(tSec: number, x: number, z: number, ry: number, floor: number, hidden: boolean, sway: boolean): void {
    const flags = (hidden ? TRACK_HIDDEN : 0) | (sway ? TRACK_SWAY : 0);
    this.buf.push(Math.round(tSec * 1000), r2(x), r2(z), r2(ry), floor, flags);
    if (performance.now() - this.lastFlush >= FLUSH_MS) this.flush();
  }

  /** イベント（盗み・脱出・ダウト）。rooms/{room}/events はロビーに戻ると消えるのでログにも残す */
  event(ev: GameEvent): void {
    this.net.push(`${this.base()}/events`, ev);
  }

  /** 監視サイドのオンラインカメラの切替 */
  cams(tSec: number, ids: number[]): void {
    this.net.push(`${this.base()}/cams/${this.pid}`, { t: Math.round(tSec * 1000), ids });
  }

  /** バッファしたサンプルを1チャンクとして書く（キーは push で一意。再生側は t で並べ直す） */
  flush(): void {
    this.lastFlush = performance.now();
    if (this.buf.length === 0) return;
    this.net.push(`${this.base()}/tracks/${this.pid}`, this.buf);
    this.buf = [];
  }

  dispose(): void {
    this.flush();
  }
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}
