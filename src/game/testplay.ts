import { AVATAR_PALETTE, CONFIG } from '../config';
import { MemoryAdapter } from '../net/memory';
import type { PhaseState, PlayerInfo } from '../types';
import { toStageDef, type CustomStageData } from './customStage';
import { Game } from './game';
import { registerStage } from './stages';

export type TestRole = 'mouse' | 'cat';

/** テストプレイ中のステージを登録するID（保存済みのステージと混ざらないよう専用にする） */
const TEST_STAGE_ID = '__test';
const ROOM = 'test';

/**
 * ステージエディタからの1人テストプレイ。
 * メモリ内アダプタで1人だけの第1ターンを回し、まんびきサイド（NPC入りの店内を歩く・盗む・出口から出る）か
 * 監視サイド（CCTV画面でカメラの映りを見る）で確認する。ターンが終わる（時間切れ・脱出）たびに自動でやり直す。
 */
export class TestPlay {
  private game: Game | null = null;
  private unsub: (() => void) | null = null;
  private restartTimer = 0;
  private bar: HTMLDivElement;
  private role: TestRole;

  constructor(
    private container: HTMLElement,
    data: CustomStageData,
    role: TestRole,
    onExit: () => void,
  ) {
    this.role = role;
    registerStage(toStageDef(data, TEST_STAGE_ID));
    this.bar = document.createElement('div');
    this.bar.className = 'test-bar';
    this.bar.innerHTML = `
      <span class="test-bar-title">テストプレイ</span>
      <button class="btn" data-role="mouse">🐭 まんびきサイド</button>
      <button class="btn" data-role="cat">📹 監視サイド</button>
      <button class="btn" data-exit>✏️ エディタに戻る</button>
    `;
    this.bar.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => {
      b.onclick = () => {
        b.blur(); // フォーカスが残ると Space/Enter で再発火して移動キーと干渉する
        this.role = b.dataset.role as TestRole;
        this.start();
      };
    });
    this.bar.querySelector<HTMLButtonElement>('[data-exit]')!.onclick = onExit;
    container.appendChild(this.bar);
    this.start();
  }

  private start(): void {
    this.stop();
    this.bar.querySelectorAll<HTMLButtonElement>('[data-role]').forEach((b) => {
      b.classList.toggle('active', b.dataset.role === this.role);
    });
    const net = new MemoryAdapter();
    const players: Record<string, PlayerInfo> = {
      [net.clientId]: {
        name: 'テスト',
        // firstMice='A' なので第1ターンは a1 がまんびきサイド、b1 が監視サイド
        role: this.role === 'mouse' ? 'a1' : 'b1',
        joinedAt: 0,
        color: AVATAR_PALETTE[0].hex,
      },
    };
    // フィールドインサートは飛ばしてカウントダウンから
    const phase: PhaseState = {
      phase: 'playing',
      round: 1,
      set: 1,
      sets: 1,
      firstMice: 'A',
      stage: TEST_STAGE_ID,
      startAt: Date.now() + CONFIG.countdownSec * 1000,
      seed: Math.floor(Math.random() * 2 ** 31),
    };
    net.set(`rooms/${ROOM}/phase`, phase);
    this.game = new Game(this.container, net, ROOM, players, phase);
    // ターンが終わると Game が次のフェーズを書く。それを合図にやり直す
    // （Game のフレーム処理の途中で呼ばれるので、作り直しは次のタスクに回す）
    this.unsub = net.subscribe(`rooms/${ROOM}/phase`, (val) => {
      const p = val as PhaseState | null;
      if (!p || p.phase === 'playing' || this.restartTimer) return;
      this.restartTimer = window.setTimeout(() => this.start(), 0);
    });
  }

  private stop(): void {
    window.clearTimeout(this.restartTimer);
    this.restartTimer = 0;
    this.unsub?.();
    this.unsub = null;
    this.game?.dispose();
    this.game = null;
  }

  dispose(): void {
    this.stop();
    this.bar.remove();
  }
}
