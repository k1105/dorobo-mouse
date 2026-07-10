import type { Role } from '../types';
import { ROLE_LABELS } from '../types';

/** ゲーム中のHUD（DOMオーバーレイ） */
export class Hud {
  private root: HTMLDivElement;
  private timerEl: HTMLSpanElement;
  private stealsEl: HTMLSpanElement;
  private targetEl: HTMLDivElement;
  private progressWrap: HTMLDivElement;
  private progressBar: HTMLDivElement;
  private bannerWrap: HTMLDivElement;
  private centerEl: HTMLDivElement;
  private endEl: HTMLDivElement | null = null;

  constructor(parent: HTMLElement, role: Role) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <span class="hud-role">${ROLE_LABELS[role]}</span>
        <span class="hud-timer">--:--</span>
        <span class="hud-steals">盗み: 0</span>
      </div>
      <div class="hud-target hidden"></div>
      <div class="hud-progress hidden"><div class="hud-progress-bar"></div><span class="hud-progress-label">盗み中…</span></div>
      <div class="hud-banners"></div>
      <div class="hud-center"></div>
    `;
    parent.appendChild(this.root);
    this.timerEl = this.root.querySelector('.hud-timer')!;
    this.stealsEl = this.root.querySelector('.hud-steals')!;
    this.targetEl = this.root.querySelector('.hud-target')!;
    this.progressWrap = this.root.querySelector('.hud-progress')!;
    this.progressBar = this.root.querySelector('.hud-progress-bar')!;
    this.bannerWrap = this.root.querySelector('.hud-banners')!;
    this.centerEl = this.root.querySelector('.hud-center')!;
  }

  setTimer(remainSec: number): void {
    const s = Math.max(0, Math.ceil(remainSec));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this.timerEl.textContent = `${mm}:${ss}`;
    this.timerEl.classList.toggle('urgent', s <= 30);
  }

  setSteals(count: number, carrying: number): void {
    this.stealsEl.textContent = `チーム盗み: ${count} / 所持: ${carrying}`;
  }

  /** ネズミ専用: 現在のお題を表示 */
  setTarget(item: string | null): void {
    if (item === null) {
      this.targetEl.classList.add('hidden');
    } else {
      this.targetEl.classList.remove('hidden');
      this.targetEl.textContent = `お題: ${item} を取ってきてください`;
    }
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

  /** 画面中央の大きい文字（カウントダウン・硬直表示など）。空文字で消す */
  setCenter(text: string): void {
    this.centerEl.textContent = text;
  }

  showEnd(winner: 'mice' | 'cats', reason: string, onLobby: () => void): void {
    if (this.endEl) return;
    this.endEl = document.createElement('div');
    this.endEl.className = 'end-overlay';
    const title = winner === 'mice' ? '🐭 ネズミチームの勝ち！' : '🐱 猫チームの勝ち！';
    this.endEl.innerHTML = `
      <div class="end-panel ${winner}">
        <h1>${title}</h1>
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
