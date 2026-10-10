import { TEAM_LABELS, TEAM_NAMES, type SetResult, type Team } from '../types';
import { roundLabel } from './text';

/** リザルト表示の内容（ラウンド終了 / 最終結果）。資料の「PINK vs BLUE / 1st ROUND … / TOTAL」の表 */
export interface EndOptions {
  heading: string;
  /** 終了したセット（ラウンド）の結果。最後の要素が今終わったセット */
  results: SetResult[];
  totalSets: number;
  /** ここまでの獲得セット数 */
  tally: { a: number; b: number };
  /** 最終結果か。false ならラウンド終了で、勝敗は出さずに next の案内だけ出す */
  final: boolean;
  /** 最終結果の勝者（final のときだけ） */
  winner?: Team | 'draw';
  reason?: string;
  next?: string;
  /** 最終結果の「つぎへ」（セレモニーへ進む） */
  onNext?: () => void;
}

/** セレモニー（勝ったチームをお祝いする画面）の内容 */
export interface CeremonyOptions {
  winner: Team | 'draw';
  scoreA: number;
  scoreB: number;
  onNext: () => void;
}

/** ネクスト選択画面の選択肢 */
export type NextChoice = 'rematch' | 'other' | 'quit';

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
  private startEl: HTMLDivElement;
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
      <div class="hud-start hidden"><div class="hud-start-role"></div><div class="hud-start-sub"></div></div>
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
    this.startEl = this.root.querySelector('.hud-start')!;
    this.roleEl.textContent = roleLabel;
  }

  setTimer(remainSec: number): void {
    const s = Math.max(0, Math.ceil(remainSec));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    this.timerEl.textContent = `${mm}:${ss}`;
    this.timerEl.classList.toggle('urgent', s <= 10);
  }

  /** ラウンド・ターンとチームスコア（持ち出した商品の累計ポイント）の表示 */
  setScore(label: string, scoreA: number, scoreB: number): void {
    this.scoreEl.textContent = `${label}  ${TEAM_NAMES.A} ${scoreA}pt - ${scoreB}pt ${TEAM_NAMES.B}`;
  }

  /** 役割ごとの補助情報（まんびきサイド: 所持数 / 監視サイド: ダウト残数） */
  setInfo(text: string): void {
    this.infoEl.textContent = text;
  }

  /**
   * まんびきサイド専用: 盗むボタンを表示する。
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

  /** まんびきサイド専用: 視点切替ボタン（追従カメラ ⇔ 一人称）を表示する。fps は初期モード */
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

  /** フィールドインサート中は操作UI（盗む・視点切替）を隠して映像だけにする */
  setIntroMode(on: boolean): void {
    this.root.classList.toggle('intro', on);
  }

  /** 役割表示を差し替える（退場→観戦など） */
  setRole(label: string): void {
    this.roleEl.textContent = label;
  }

  /** まんびきサイド用の操作UI（盗むボタン・視点切替・進捗）をまとめて隠す。退場時に使う */
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

  /**
   * 攻守それぞれのスタート画面（カウントダウンの上に出す役割カード）。
   * role に null を渡すと消す。カードは一度だけ作って、同じ内容なら触らない
   */
  setStartCard(role: string | null, sub = ''): void {
    if (role === null) {
      this.startEl.classList.add('hidden');
      return;
    }
    const roleEl = this.startEl.querySelector<HTMLDivElement>('.hud-start-role')!;
    const subEl = this.startEl.querySelector<HTMLDivElement>('.hud-start-sub')!;
    if (roleEl.textContent !== role) roleEl.textContent = role;
    if (subEl.textContent !== sub) subEl.textContent = sub;
    this.startEl.classList.remove('hidden');
  }

  /** ダウト成功・まんびき成功などの全画面演出。durationMs後に自動で消える */
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

  /**
   * ラウンド終了・最終結果の表。見出し → 「PINK vs BLUE」と各ラウンドの得点（今終わったラウンドはカウントアップ）→ TOTAL。
   * ラウンド終了では勝敗を出さず、次のラウンドの案内だけ出す。最終結果では「つぎへ」でセレモニーに進む
   */
  showEnd(o: EndOptions): void {
    if (this.endEl) return;
    this.endEl = document.createElement('div');
    this.endEl.className = 'end-overlay';
    const current = o.results.length - 1;
    const totalA = o.results.reduce((n, r) => n + r.scoreA, 0);
    const totalB = o.results.reduce((n, r) => n + r.scoreB, 0);
    const rows: string[] = [];
    for (let i = 0; i < o.totalSets; i++) {
      const r = o.results[i];
      const w = !r ? '' : r.scoreA > r.scoreB ? 'a' : r.scoreB > r.scoreA ? 'b' : '';
      const cls = i === current ? 'now' : r ? 'done' : 'todo';
      const a = !r ? '-' : i === current ? `<span data-count="${r.scoreA}">0</span>` : String(r.scoreA);
      const b = !r ? '-' : i === current ? `<span data-count="${r.scoreB}">0</span>` : String(r.scoreB);
      rows.push(
        `<div class="end-row ${w} ${cls}"><span class="end-row-name">${roundLabel(i + 1)}</span><b class="ra">${a}</b><b class="rb">${b}</b></div>`,
      );
    }
    const multi = o.totalSets > 1;
    this.endEl.innerHTML = `
      <div class="end-panel">
        <div class="end-title">${o.heading}</div>
        <div class="end-table">
          <div class="end-head"><span></span><b class="ha">${TEAM_NAMES.A}</b><span class="end-vs">vs</span><b class="hb">${TEAM_NAMES.B}</b></div>
          <div class="end-rows">${rows.join('')}</div>
          <div class="end-row total"><span class="end-row-name">TOTAL</span><b class="ra"><span data-count="${totalA}">${totalA - (o.results[current]?.scoreA ?? 0)}</span></b><b class="rb"><span data-count="${totalB}">${totalB - (o.results[current]?.scoreB ?? 0)}</span></b></div>
          ${multi ? `<div class="end-tally">セット <b class="ta">${o.tally.a}</b> - <b class="tb">${o.tally.b}</b> <small>（全${o.totalSets}ラウンド）</small></div>` : ''}
        </div>
        <div class="end-foot">
          ${o.reason ? `<div class="end-reason">${o.reason}</div>` : ''}
          ${o.final ? '<button class="btn end-next-btn" id="btn-end-next">つぎへ ▶</button>' : `<div class="end-next">${o.next ?? ''}</div>`}
        </div>
      </div>
    `;
    this.root.appendChild(this.endEl);
    const panel = this.endEl.querySelector<HTMLDivElement>('.end-panel')!;
    const nextBtn = this.endEl.querySelector<HTMLButtonElement>('#btn-end-next');
    if (nextBtn && o.onNext) nextBtn.onclick = o.onNext;

    // 段階的に見せる: 見出し → 表（今のラウンドと TOTAL をカウントアップ）→ 案内
    window.setTimeout(() => panel.classList.add('s1'), 100);
    window.setTimeout(() => {
      panel.classList.add('s2');
      const nums = panel.querySelectorAll<HTMLSpanElement>('[data-count]');
      const base = Array.from(nums).map((el) => Number(el.textContent) || 0);
      const t0 = performance.now();
      const dur = 1400;
      const tick = () => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        nums.forEach((el, i) => {
          const target = Number(el.dataset.count);
          el.textContent = String(Math.round(base[i] + (target - base[i]) * e));
        });
        if (k < 1 && this.endEl) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, 900);
    window.setTimeout(() => panel.classList.add('s3'), 2700);
  }

  /**
   * セレモニー。勝ったチームを大きく表示して喜ばせ、負けたチームは小さく項垂れる。
   * 「つぎへ」でネクスト選択画面へ
   */
  showCeremony(o: CeremonyOptions): void {
    this.endEl?.remove();
    this.endEl = document.createElement('div');
    this.endEl.className = 'end-overlay ceremony';
    const { winner } = o;
    const cls = (t: Team) => (winner === 'draw' ? 'draw' : winner === t ? 'win' : 'lose');
    const face = (t: Team) => (winner === 'draw' ? '😐' : winner === t ? '🎉' : '😞');
    const title =
      winner === 'draw' ? 'DRAW' : `WINNER <span class="cer-quote">“${TEAM_NAMES[winner]} TEAM”</span> !!`;
    this.endEl.innerHTML = `
      <div class="end-panel cer-panel">
        <h1 class="cer-title ${winner === 'draw' ? 'draw' : winner.toLowerCase()}">${title}</h1>
        <div class="cer-teams">
          <div class="cer-team a ${cls('A')}">
            <div class="cer-face">${face('A')}</div>
            <div class="cer-name">${TEAM_LABELS.A}</div>
            <div class="cer-score">${o.scoreA}<small>pt</small></div>
          </div>
          <div class="cer-team b ${cls('B')}">
            <div class="cer-face">${face('B')}</div>
            <div class="cer-name">${TEAM_LABELS.B}</div>
            <div class="cer-score">${o.scoreB}<small>pt</small></div>
          </div>
        </div>
        <div class="end-foot"><button class="btn end-next-btn" id="btn-cer-next">つぎへ ▶</button></div>
      </div>
    `;
    this.root.appendChild(this.endEl);
    this.endEl.querySelector<HTMLButtonElement>('#btn-cer-next')!.onclick = o.onNext;
    const overlay = this.endEl;
    const panel = this.endEl.querySelector<HTMLDivElement>('.end-panel')!;
    window.setTimeout(() => panel.classList.add('s1', 's2', 's3'), 80);
    if (winner !== 'draw') {
      const colors =
        winner === 'A' ? ['#ff9fcb', '#ff6fae', '#ffb300', '#fff'] : ['#8fd2ff', '#4fb3ff', '#ffb300', '#fff'];
      for (let i = 0; i < 70; i++) {
        const c = document.createElement('span');
        c.className = 'confetti';
        c.style.left = `${Math.random() * 100}%`;
        c.style.background = colors[i % colors.length];
        c.style.animationDuration = `${2.4 + Math.random() * 2}s`;
        c.style.animationDelay = `${Math.random() * 1.2}s`;
        c.style.transform = `rotate(${Math.random() * 360}deg)`;
        overlay.appendChild(c);
      }
    }
  }

  /**
   * ネクスト選択画面。もう一度勝負する / 別のエリアで勝負する / ゲームを止める。
   * 「ゲームを止める」はゲーム中止警告（いまいるエリアから抜けます。よろしいですか？）で確認してから
   */
  showNextChoice(onChoose: (choice: NextChoice) => void): void {
    this.endEl?.remove();
    this.endEl = document.createElement('div');
    this.endEl.className = 'end-overlay';
    this.endEl.innerHTML = `
      <div class="end-panel s1 s2 s3">
        <div class="end-title">NEXT</div>
        <div class="next-choices">
          <button class="btn next-choice" data-choice="rematch">🔁 もう一度 勝負する</button>
          <button class="btn next-choice" data-choice="other">🚪 別のエリアで勝負する</button>
          <button class="btn next-choice quit" data-choice="quit">⏹ ゲームを止める</button>
        </div>
      </div>
      <div class="modal-backdrop hidden" id="quit-confirm">
        <div class="modal quit-modal">
          <h2>いまいるエリアから抜けます</h2>
          <p>よろしいですか？</p>
          <div class="btn-row modal-actions">
            <button class="btn big" id="btn-quit-yes">はい</button>
            <button class="btn" id="btn-quit-no" data-pad-back>いいえ</button>
          </div>
        </div>
      </div>
    `;
    this.root.appendChild(this.endEl);
    const confirm = this.endEl.querySelector<HTMLDivElement>('#quit-confirm')!;
    this.endEl.querySelectorAll<HTMLButtonElement>('.next-choice').forEach((b) => {
      b.onclick = () => {
        const choice = b.dataset.choice as NextChoice;
        if (choice === 'quit') confirm.classList.remove('hidden');
        else onChoose(choice);
      };
    });
    this.endEl.querySelector<HTMLButtonElement>('#btn-quit-yes')!.onclick = () => onChoose('quit');
    this.endEl.querySelector<HTMLButtonElement>('#btn-quit-no')!.onclick = () => confirm.classList.add('hidden');
  }

  dispose(): void {
    this.root.remove();
  }
}
