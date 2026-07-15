import type { Team } from '../types';

/** ゲーム中のHUD（DOMオーバーレイ） */
export class Hud {
  private root: HTMLDivElement;
  private roleEl: HTMLSpanElement;
  private timerEl: HTMLSpanElement;
  private scoreEl: HTMLSpanElement;
  private infoEl: HTMLSpanElement;
  private stealBtn: HTMLButtonElement;
  private progressWrap: HTMLDivElement;
  private progressBar: HTMLDivElement;
  private bannerWrap: HTMLDivElement;
  private centerEl: HTMLDivElement;
  private endEl: HTMLDivElement | null = null;

  constructor(parent: HTMLElement, roleLabel: string) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <span class="hud-role"></span>
        <span class="hud-timer">--:--</span>
        <span class="hud-score"></span>
        <span class="hud-info"></span>
      </div>
      <button class="hud-steal-btn hidden">🫳 盗む</button>
      <div class="hud-progress hidden"><div class="hud-progress-bar"></div><span class="hud-progress-label">盗み中…</span></div>
      <div class="hud-banners"></div>
      <div class="hud-center"></div>
    `;
    parent.appendChild(this.root);
    this.roleEl = this.root.querySelector('.hud-role')!;
    this.timerEl = this.root.querySelector('.hud-timer')!;
    this.scoreEl = this.root.querySelector('.hud-score')!;
    this.infoEl = this.root.querySelector('.hud-info')!;
    this.stealBtn = this.root.querySelector('.hud-steal-btn')!;
    this.progressWrap = this.root.querySelector('.hud-progress')!;
    this.progressBar = this.root.querySelector('.hud-progress-bar')!;
    this.bannerWrap = this.root.querySelector('.hud-banners')!;
    this.centerEl = this.root.querySelector('.hud-center')!;
    this.roleEl.textContent = roleLabel;
  }

  setTimer(remainSec: number): void {
    const s = Math.max(0, Math.ceil(remainSec));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this.timerEl.textContent = `${mm}:${ss}`;
    this.timerEl.classList.toggle('urgent', s <= 10);
  }

  /** ラウンドとチームスコア（盗んだ商品の累計金額）の表示 */
  setScore(round: number, scoreA: number, scoreB: number): void {
    this.scoreEl.textContent = `${round === 1 ? '前半' : '後半'}  A ${scoreA}円 - ${scoreB}円 B`;
  }

  /** 役割ごとの補助情報（ネズミ: 所持数 / 猫: ダウト残数） */
  setInfo(text: string): void {
    this.infoEl.textContent = text;
  }

  /** ネズミ専用: 盗むボタンを表示する */
  showStealButton(onSteal: () => void): void {
    this.stealBtn.classList.remove('hidden');
    this.stealBtn.onclick = () => {
      // フォーカスを残すとSpace/Enterでボタンが再発火して移動キーと干渉するため外す
      this.stealBtn.blur();
      onSteal();
    };
  }

  /** 盗み中はボタンを押せなくする */
  setStealActive(active: boolean): void {
    this.stealBtn.disabled = active;
  }

  /** 盗み進捗（0..1）。nullで非表示 */
  setProgress(p: number | null): void {
    if (p === null) {
      this.progressWrap.classList.add('hidden');
    } else {
      this.progressWrap.classList.remove('hidden');
      this.progressBar.style.width = `${Math.min(100, p * 100)}%`;
    }
  }

  /** 数秒で消える通知バナー */
  banner(text: string, kind: 'alert' | 'info' = 'info'): void {
    const el = document.createElement('div');
    el.className = `hud-banner ${kind}`;
    el.textContent = text;
    this.bannerWrap.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  /** 画面中央の大きい文字（カウントダウンなど）。空文字で消す。small=trueで控えめサイズ */
  setCenter(text: string, small = false): void {
    this.centerEl.textContent = text;
    this.centerEl.classList.toggle('small', small);
  }

  /** ダウト成功時の全画面演出。durationMs後に自動で消える */
  showDoubtSuccess(durationMs: number): void {
    const el = document.createElement('div');
    el.className = 'doubt-overlay';
    el.innerHTML = '<div class="doubt-text">ダウト成功！</div>';
    this.root.appendChild(el);
    setTimeout(() => el.remove(), durationMs);
  }

  showEnd(
    winner: Team | 'draw',
    reason: string,
    scoreA: number,
    scoreB: number,
    onLobby: () => void,
  ): void {
    if (this.endEl) return;
    this.endEl = document.createElement('div');
    this.endEl.className = 'end-overlay';
    const title = winner === 'draw' ? '🤝 引き分け！' : `🏆 チーム${winner}の勝ち！`;
    this.endEl.innerHTML = `
      <div class="end-panel">
        <h1>${title}</h1>
        <p class="end-score">A ${scoreA}円 - ${scoreB}円 B</p>
        <p>${reason}</p>
        <button class="btn primary" id="btn-lobby">ロビーに戻る</button>
      </div>
    `;
    this.root.appendChild(this.endEl);
    this.endEl.querySelector<HTMLButtonElement>('#btn-lobby')!.onclick = onLobby;
  }

  dispose(): void {
    this.root.remove();
  }
}
