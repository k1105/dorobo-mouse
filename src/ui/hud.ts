import type { Team } from '../types';

/** ゲーム中のHUD（DOMオーバーレイ） */
export class Hud {
  private root: HTMLDivElement;
  private roleEl: HTMLSpanElement;
  private timerEl: HTMLSpanElement;
  private scoreEl: HTMLSpanElement;
  private infoEl: HTMLSpanElement;
  private stealBtn: HTMLButtonElement;
  private camToggleBtn: HTMLButtonElement;
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
      <button class="hud-cam-toggle hidden"></button>
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
    this.camToggleBtn = this.root.querySelector('.hud-cam-toggle')!;
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

  /**
   * ネズミ専用: 盗むボタンを表示する。
   * 盗みは「ボタンを押している間だけ」続き、指/マウスを離す（or ボタンの外に出る）と onRelease で中断する。
   */
  showStealButton(onHold: () => void, onRelease: () => void): void {
    this.stealBtn.classList.remove('hidden');
    let holding = false;
    const release = () => {
      if (!holding) return;
      holding = false;
      this.stealBtn.classList.remove('holding');
      onRelease();
    };
    this.stealBtn.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // 長押しでのテキスト選択・フォーカス移動を防ぐ
      holding = true;
      this.stealBtn.classList.add('holding');
      // ボタンの外で離してもpointerupを受け取れるようにする
      try {
        this.stealBtn.setPointerCapture(e.pointerId);
      } catch {
        // 一部環境でpointerIdが無効な場合は捕捉なしで続ける
      }
      onHold();
    };
    this.stealBtn.onpointerup = release;
    this.stealBtn.onpointercancel = release;
    this.stealBtn.onlostpointercapture = release;
    // クリック確定時のフォーカスを残すとSpace/Enterで再発火して移動キーと干渉するため外す
    this.stealBtn.onclick = () => this.stealBtn.blur();
    // 長押しのコンテキストメニュー（タッチ端末）を抑止
    this.stealBtn.oncontextmenu = (e) => e.preventDefault();
  }

  /** 盗むボタンを外部から「離した」状態に戻す（盗みが完了・中断されたとき） */
  releaseStealButton(): void {
    this.stealBtn.classList.remove('holding');
  }

  /** ネズミ専用: 視点切替ボタン（追従カメラ ⇔ 一人称）を表示する。fps は初期モード */
  showCamToggle(onToggle: () => void, fps: boolean): void {
    this.camToggleBtn.classList.remove('hidden');
    this.setCamMode(fps);
    this.camToggleBtn.onclick = () => {
      // 盗むボタンと同様、フォーカスを残すとSpace/Enterで再発火するため外す
      this.camToggleBtn.blur();
      onToggle();
    };
  }

  /** 上部バー（役割・タイマー・スコア）の下端のY（CSSピクセル）。CCTVのモニタ配置が上側の余白として使う */
  topBarBottom(): number {
    const bar = this.root.querySelector<HTMLDivElement>('.hud-top')!;
    return bar.offsetTop + bar.offsetHeight;
  }

  /** 視点切替ボタンの表示を現在のモードに合わせる */
  setCamMode(fps: boolean): void {
    this.camToggleBtn.textContent = fps ? '👁 視点: 一人称' : '🎥 視点: 追従';
    this.camToggleBtn.classList.toggle('active', fps);
  }

  /** 役割表示を差し替える（退場→観戦など） */
  setRole(label: string): void {
    this.roleEl.textContent = label;
  }

  /** ネズミ用の操作UI（盗むボタン・視点切替・進捗）をまとめて隠す。退場時に使う */
  hideMouseControls(): void {
    this.stealBtn.classList.add('hidden');
    this.camToggleBtn.classList.add('hidden');
    this.setProgress(null);
  }

  /** 盗み中（ホールド中）のボタン表示 */
  setStealActive(active: boolean): void {
    this.stealBtn.classList.toggle('stealing', active);
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

  /** ダウト成功・万引き成功などの全画面演出。durationMs後に自動で消える */
  showBigText(text: string, durationMs: number): void {
    const el = document.createElement('div');
    el.className = 'doubt-overlay';
    const inner = document.createElement('div');
    inner.className = 'doubt-text';
    inner.textContent = text;
    el.appendChild(inner);
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
