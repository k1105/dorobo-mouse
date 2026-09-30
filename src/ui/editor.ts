import { CONFIG, PRICE_TIERS } from '../config';
import {
  cleanText,
  loadStages,
  newStageData,
  newStageId,
  normalizeStageData,
  npcNodes,
  occluderCells,
  saveStages,
  spotCells,
  STAGE_LIMITS,
  TIER_RANDOM,
  validateStage,
  type CustomCam,
  type CustomStageData,
} from '../game/customStage';
import { TestPlay, type TestRole } from '../game/testplay';
import { CAM_HFOV_DEG, CAM_RANGE, castRay, WALL_T } from '../game/world';

type Tool = 'select' | 'shelf' | 'cam' | 'erase';

type Sel = { kind: 'shelf' | 'cam' | 'spawn'; i: number } | { kind: 'exit' };

/** マス座標（小数）。左上が原点 */
interface Pt {
  x: number;
  y: number;
}

interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ポインタの下にある、つかめるもの */
type Grab =
  | { kind: 'aim'; i: number }
  | { kind: 'cam'; i: number }
  | { kind: 'spawn'; i: number }
  /** 棚の四隅のハンドル。(fx, fy) は動かない側（対角）のマス */
  | { kind: 'handle'; i: number; fx: number; fy: number }
  | { kind: 'shelf'; i: number }
  | { kind: 'exit' };

/** ドラッグ中の操作。before は開始時点のステージ（取り消し・元に戻す用のJSON） */
type Drag = (
  | { kind: 'new-shelf'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'move-shelf'; i: number; dx: number; dy: number }
  | { kind: 'resize-shelf'; i: number; fx: number; fy: number }
  | { kind: 'new-cam'; cam: CustomCam }
  | { kind: 'move-cam'; i: number; dx: number; dy: number }
  | { kind: 'aim-cam'; i: number }
  | { kind: 'spawn'; i: number }
  | { kind: 'exit'; dx: number }
  | { kind: 'erase' }
) & { before: string };

/** マス目の外側の余白（マス単位）。上は出口の表示がある分だけ広い */
const PAD = 1.2;
const PAD_TOP = 1.9;
const FOV_RAYS = 72;
const UNDO_MAX = 100;

const TOOL_HINTS: Record<Tool, string> = {
  select:
    'クリックで選択、ドラッグで移動。棚は四隅の□で大きさ、カメラは注視点の○で向きを変える。出口（緑）とスポーン（S1・S2）もドラッグで動く。Delete で削除',
  shelf: '空いているマスをドラッグして棚を描く（料金帯と高さは右のパネルで選ぶ）。描いた棚はクリックで選択でき、ドラッグで移動、四隅の□で大きさを変えられる',
  cam: '置きたい場所から、映したい場所（注視点）までドラッグ。置いたカメラはドラッグで移動、注視点の○で向きを変えられる',
  erase: '棚・カメラをクリック（またはなぞる）と消える',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snapHalf = (v: number) => Math.round(v * 2) / 2;

/** 料金帯の値段の範囲（例: 300〜499円） */
function tierRange(i: number): string {
  const min = PRICE_TIERS[i].min;
  if (i === 0) return `${min}円〜`;
  const upper = PRICE_TIERS[i - 1].min - 1;
  return min <= 0 ? `〜${upper}円` : `${min}〜${upper}円`;
}

/**
 * ステージエディタ。マス目の上をドラッグ・クリックして、棚（料金帯・高さ）・カメラ（位置と向き）・
 * 出口・スポーン地点を配置し、広さとNPC人数を決める。編集内容はブラウザに自動保存され、
 * その場で1人テストプレイできる。保存したステージはルーム作成のステージ選択に出る。
 */
export class StageEditor {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stages: CustomStageData[];
  private cur: CustomStageData;
  private tool: Tool = 'shelf';
  /** これから描く棚の料金帯と高さ（棚を選択するとその棚の値に合わせる） */
  private brushTier = PRICE_TIERS.length - 1;
  private brushLow = false;
  private sel: Sel | null = null;
  private drag: Drag | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private showFov = true;
  private showNpc = false;
  /** 1マスの表示サイズ（CSSピクセル） */
  private cell = 20;
  private dpr = 1;
  private hover: Pt | null = null;
  private testPlay: TestPlay | null = null;
  private deleteArmTimer = 0;
  private disposed = false;

  constructor(
    private parent: HTMLElement,
    private onExit: () => void,
  ) {
    this.stages = loadStages();
    if (this.stages.length === 0) this.stages.push(newStageData('ステージ1'));
    this.cur = this.stages[0];

    this.root = document.createElement('div');
    this.root.className = 'editor';
    this.root.innerHTML = `
      <div class="ed-top">
        <button class="btn" id="ed-back">← タイトルへ</button>
        <h1>ステージエディタ</h1>
        <div class="ed-tools" id="ed-tools">
          <button class="ed-tool" data-tool="select">↖ 選択・移動</button>
          <button class="ed-tool" data-tool="shelf">▦ 棚を描く</button>
          <button class="ed-tool" data-tool="cam">📷 カメラを置く</button>
          <button class="ed-tool" data-tool="erase">⌫ 消す</button>
        </div>
        <div class="ed-tools">
          <button class="ed-tool" id="ed-undo" title="元に戻す（Ctrl/⌘+Z）">↶</button>
          <button class="ed-tool" id="ed-redo" title="やり直す（Ctrl/⌘+Shift+Z）">↷</button>
        </div>
        <label class="ed-check"><input type="checkbox" id="ed-fov" checked /> カメラの視野</label>
        <label class="ed-check"><input type="checkbox" id="ed-npc" /> NPCが歩ける場所</label>
        <span class="ed-saved" id="ed-saved"></span>
      </div>
      <div class="ed-body">
        <aside class="ed-side ed-left">
          <h3 class="section-title">自作ステージ</h3>
          <div class="ed-list" id="ed-list"></div>
          <div class="ed-list-actions">
            <button class="btn" id="ed-new">＋ 新規</button>
            <button class="btn" id="ed-dup">複製</button>
            <button class="btn" id="ed-export">JSON書き出し</button>
            <button class="btn" id="ed-import">JSON読み込み</button>
            <button class="btn ed-danger" id="ed-delete">削除</button>
            <input type="file" id="ed-file" accept=".json,application/json" hidden />
          </div>
          <p class="lobby-note dim" id="ed-msg">ステージはこのブラウザに自動保存されます。別のPCに渡すときはJSONで書き出してください</p>
        </aside>
        <main class="ed-stage" id="ed-stage">
          <canvas id="ed-canvas"></canvas>
          <p class="ed-hint" id="ed-hint"></p>
        </main>
        <aside class="ed-side ed-right">
          <div class="ed-sec" id="ed-stage-panel"></div>
          <div class="ed-sec" id="ed-sel-panel"></div>
          <div class="ed-sec" id="ed-info-panel"></div>
        </aside>
      </div>
    `;
    parent.appendChild(this.root);
    this.canvas = this.q<HTMLCanvasElement>('#ed-canvas');
    this.ctx = this.canvas.getContext('2d')!;

    this.q<HTMLButtonElement>('#ed-back').onclick = () => this.onExit();
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.onclick = () => this.setTool(b.dataset.tool as Tool);
    });
    this.q<HTMLButtonElement>('#ed-undo').onclick = () => this.undo();
    this.q<HTMLButtonElement>('#ed-redo').onclick = () => this.redo();
    const fov = this.q<HTMLInputElement>('#ed-fov');
    fov.onchange = () => {
      this.showFov = fov.checked;
      this.draw();
    };
    const npc = this.q<HTMLInputElement>('#ed-npc');
    npc.onchange = () => {
      this.showNpc = npc.checked;
      this.draw();
    };
    this.q<HTMLButtonElement>('#ed-new').onclick = () => this.addStage(newStageData(this.freshName()));
    this.q<HTMLButtonElement>('#ed-dup').onclick = () => this.duplicateStage();
    this.q<HTMLButtonElement>('#ed-export').onclick = () => this.exportStage();
    const file = this.q<HTMLInputElement>('#ed-file');
    this.q<HTMLButtonElement>('#ed-import').onclick = () => file.click();
    file.onchange = () => void this.importStage(file);
    this.q<HTMLButtonElement>('#ed-delete').onclick = () => this.deleteStage();

    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.canvas.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);

    this.setTool(this.tool);
    this.openStage(this.cur);
  }

  private q<T extends HTMLElement>(selector: string): T {
    return this.root.querySelector<T>(selector)!;
  }

  // ---- ステージ一覧（新規・複製・書き出し・読み込み・削除） ----

  private freshName(): string {
    for (let n = this.stages.length + 1; ; n++) {
      const name = `ステージ${n}`;
      if (!this.stages.some((s) => s.name === name)) return name;
    }
  }

  /** 編集するステージを切り替える */
  private openStage(stage: CustomStageData): void {
    this.cur = stage;
    this.sel = null;
    this.drag = null;
    this.undoStack = [];
    this.redoStack = [];
    this.disarmDelete();
    this.renderStagePanel();
    this.renderSelPanel();
    this.changed();
  }

  private addStage(stage: CustomStageData): void {
    this.stages.push(stage);
    this.openStage(stage);
  }

  private duplicateStage(): void {
    const copy = JSON.parse(JSON.stringify(this.cur)) as CustomStageData;
    copy.id = newStageId();
    copy.name = `${this.cur.name}のコピー`.slice(0, STAGE_LIMITS.maxName);
    this.addStage(copy);
  }

  private exportStage(): void {
    const blob = new Blob([JSON.stringify(this.cur, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dorobo-stage-${this.cur.name.replace(/[\\/:*?"<>|\s]+/g, '_')}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message(`「${this.cur.name}」をJSONで書き出しました`);
  }

  private async importStage(input: HTMLInputElement): Promise<void> {
    const f = input.files?.[0];
    input.value = ''; // 同じファイルをもう一度選べるようにする
    if (!f) return;
    let data: CustomStageData | null = null;
    try {
      data = normalizeStageData(JSON.parse(await f.text()));
    } catch {
      // JSONとして読めない
    }
    if (this.disposed) return;
    if (!data) {
      this.message('読み込めませんでした（ステージのJSONではありません）');
      return;
    }
    // 手元のステージを上書きしないよう、常に別のステージとして追加する
    data.id = newStageId();
    this.addStage(data);
    this.message(`「${data.name}」を読み込みました`);
  }

  /** 削除は2回押しで確定（1回目は確認の表示に変わるだけ） */
  private deleteStage(): void {
    const btn = this.q<HTMLButtonElement>('#ed-delete');
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'もう一度押すと削除';
      this.deleteArmTimer = window.setTimeout(() => this.disarmDelete(), 3000);
      return;
    }
    const name = this.cur.name;
    this.stages.splice(this.stages.indexOf(this.cur), 1);
    if (this.stages.length === 0) this.stages.push(newStageData('ステージ1'));
    this.openStage(this.stages[0]);
    this.message(`「${name}」を削除しました`);
  }

  private disarmDelete(): void {
    window.clearTimeout(this.deleteArmTimer);
    const btn = this.q<HTMLButtonElement>('#ed-delete');
    btn.classList.remove('armed');
    btn.textContent = '削除';
  }

  private message(text: string): void {
    this.q<HTMLParagraphElement>('#ed-msg').textContent = text;
  }

  private renderList(): void {
    const el = this.q<HTMLDivElement>('#ed-list');
    el.innerHTML = this.stages
      .map((s, i) => {
        const bad = validateStage(s).errors.length > 0;
        return `
          <button class="ed-item ${s === this.cur ? 'selected' : ''}" data-i="${i}">
            <span class="ed-item-name">${bad ? '⛔ ' : ''}${esc(s.name)}</span>
            <span class="ed-item-meta">${s.w}×${s.h}マス・カメラ${s.cams.length}台・NPC${s.npcCount}人</span>
          </button>`;
      })
      .join('');
    el.querySelectorAll<HTMLButtonElement>('.ed-item').forEach((b) => {
      b.onclick = () => {
        const stage = this.stages[Number(b.dataset.i)];
        if (stage && stage !== this.cur) this.openStage(stage);
      };
    });
  }

  // ---- 編集の確定・保存・元に戻す ----

  /** 編集が一区切りついたときの共通処理（保存・再描画・集計とチェックの更新） */
  private changed(): void {
    this.save();
    this.layout();
    this.draw();
    this.renderInfoPanel();
    this.renderList();
    this.updateUndoButtons();
  }

  private save(): void {
    const ok = saveStages(this.stages);
    this.q<HTMLSpanElement>('#ed-saved').textContent = ok
      ? '✓ 自動保存済み'
      : '⚠ 保存できません（ブラウザの保存領域が使えません）';
  }

  /** fn でステージを書き換える（元に戻せるよう、変わっていれば履歴に積む） */
  private commit(fn: () => void): void {
    const before = JSON.stringify(this.cur);
    fn();
    if (JSON.stringify(this.cur) !== before) this.pushUndo(before);
    this.changed();
  }

  private pushUndo(before: string): void {
    this.undoStack.push(before);
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }

  private updateUndoButtons(): void {
    this.q<HTMLButtonElement>('#ed-undo').disabled = this.undoStack.length === 0;
    this.q<HTMLButtonElement>('#ed-redo').disabled = this.redoStack.length === 0;
  }

  private restore(json: string): void {
    const data = JSON.parse(json) as CustomStageData;
    this.stages[this.stages.indexOf(this.cur)] = data;
    this.cur = data;
    this.sel = null;
    this.drag = null;
    this.renderStagePanel();
    this.renderSelPanel();
    this.changed();
  }

  private undo(): void {
    const json = this.undoStack.pop();
    if (!json) return;
    this.redoStack.push(JSON.stringify(this.cur));
    this.restore(json);
  }

  private redo(): void {
    const json = this.redoStack.pop();
    if (!json) return;
    this.undoStack.push(JSON.stringify(this.cur));
    this.restore(json);
  }

  // ---- 右パネル ----

  /** 文字入力: 打つたびに反映し、確定（フォーカスが外れる・Enter）で履歴に積む */
  private bindText(input: HTMLInputElement, apply: (v: string) => void): void {
    let before = '';
    input.onfocus = () => {
      before = JSON.stringify(this.cur);
    };
    input.oninput = () => {
      apply(input.value);
      this.save();
      this.draw();
      this.renderList();
    };
    input.onchange = () => {
      if (before && JSON.stringify(this.cur) !== before) this.pushUndo(before);
      before = JSON.stringify(this.cur);
      this.changed();
    };
  }

  /** 数値入力: 確定時に範囲へ丸めて反映する */
  private bindNumber(selector: string, lo: number, hi: number, get: () => number, set: (v: number) => void): void {
    const input = this.q<HTMLInputElement>(selector);
    input.onchange = () => {
      const raw = Number(input.value);
      const v = clamp(Math.round(Number.isFinite(raw) ? raw : get()), lo, hi);
      input.value = String(v);
      if (v !== get()) this.commit(() => set(v));
    };
  }

  private renderStagePanel(): void {
    const d = this.cur;
    const L = STAGE_LIMITS;
    this.q<HTMLDivElement>('#ed-stage-panel').innerHTML = `
      <h3 class="section-title">ステージ設定</h3>
      <label class="ed-field"><span>名前</span><input id="ed-name" maxlength="${L.maxName}" value="${esc(d.name)}" /></label>
      <div class="ed-field"><span>広さ <small>壁の内側</small></span>
        <span class="ed-inline">横 <input type="number" id="ed-w" min="${L.minW}" max="${L.maxW}" value="${d.w}" /> × 縦 <input type="number" id="ed-h" min="${L.minH}" max="${L.maxH}" value="${d.h}" /> マス</span>
      </div>
      <label class="ed-field"><span>ダミーNPC</span>
        <span class="ed-inline"><input type="number" id="ed-npcn" min="0" max="${L.maxNpc}" value="${d.npcCount}" /> 人</span>
      </label>
      <label class="ed-field"><span>出口の幅</span>
        <span class="ed-inline"><input type="number" id="ed-exitw" min="${L.minExitW}" max="${L.maxExitW}" value="${d.exit.w}" /> マス</span>
      </label>
    `;
    this.bindText(this.q<HTMLInputElement>('#ed-name'), (v) => {
      this.cur.name = cleanText(v, L.maxName) || '名称未設定';
    });
    this.bindNumber('#ed-w', L.minW, L.maxW, () => this.cur.w, (v) => this.resize(v, this.cur.h));
    this.bindNumber('#ed-h', L.minH, L.maxH, () => this.cur.h, (v) => this.resize(this.cur.w, v));
    this.bindNumber('#ed-npcn', 0, L.maxNpc, () => this.cur.npcCount, (v) => {
      this.cur.npcCount = v;
    });
    this.bindNumber('#ed-exitw', L.minExitW, L.maxExitW, () => this.cur.exit.w, (v) => {
      this.cur.exit.w = v;
      this.cur.exit.x = clamp(this.cur.exit.x, 0, this.cur.w - v);
    });
  }

  /** 広さを変える。左上（奥の壁の左端）を基準に、はみ出した棚は切り落とし、カメラ・スポーン・出口は内側へ寄せる */
  private resize(w: number, h: number): void {
    const next = normalizeStageData({ ...this.cur, w, h });
    if (!next) return;
    Object.assign(this.cur, next);
    this.sel = null;
    this.renderSelPanel();
  }

  private renderSelPanel(): void {
    const el = this.q<HTMLDivElement>('#ed-sel-panel');
    const d = this.cur;
    const sel = this.sel;
    if (sel?.kind === 'cam' && d.cams[sel.i]) {
      const c = d.cams[sel.i];
      el.innerHTML = `
        <h3 class="section-title">カメラ ${sel.i + 1}</h3>
        <p class="lobby-note dim">位置 (${c.x}, ${c.y}) → 注視点 (${c.ax}, ${c.ay})。本体をドラッグで移動、注視点の○をドラッグで向きを変える。注視点が映像の中心になる</p>
        <button class="btn ed-danger" id="ed-del-sel">このカメラを削除</button>
      `;
      this.q<HTMLButtonElement>('#ed-del-sel').onclick = () => this.deleteSelection();
      return;
    }
    if (sel?.kind === 'spawn') {
      el.innerHTML = `
        <h3 class="section-title">スポーン地点 ${sel.i + 1}</h3>
        <p class="lobby-note dim">ネズミ陣営の${sel.i + 1}人目がラウンド開始時に立つ場所。ドラッグで動かせる</p>
      `;
      return;
    }
    if (sel?.kind === 'exit') {
      el.innerHTML = `
        <h3 class="section-title">出口</h3>
        <p class="lobby-note dim">奥の壁に沿って左右にドラッグで動かせる。幅は「ステージ設定」で変える</p>
      `;
      return;
    }
    const shelf = sel?.kind === 'shelf' ? d.shelves[sel.i] : undefined;
    const tier = shelf ? shelf.tier : this.brushTier;
    const low = shelf ? shelf.low : this.brushLow;
    const tierBtn = (i: number, name: string, range: string, swatch: string) => `
      <button class="ed-tier ${tier === i ? 'selected' : ''}" data-tier="${i}">
        <i ${swatch}></i><b>${name}</b><small>${range}</small>
      </button>`;
    el.innerHTML = `
      <h3 class="section-title">${shelf ? `選択中の棚 <small>${shelf.w}×${shelf.h}マス</small>` : '棚ブラシ <small>これから描く棚</small>'}</h3>
      <div class="ed-tiers">
        ${PRICE_TIERS.map((t, i) => tierBtn(i, t.name, tierRange(i), `style="background:${hex(t.color)}"`)).join('')}
        ${tierBtn(TIER_RANDOM, 'おまかせ', '毎回ランダム', 'class="rnd"')}
      </div>
      <div class="ed-kinds">
        <button class="ed-kind ${low ? '' : 'selected'}" data-low="0"><b>高い棚</b><small>カメラの視線を遮る</small></button>
        <button class="ed-kind ${low ? 'selected' : ''}" data-low="1"><b>平台</b><small>低い。視線は通る</small></button>
      </div>
      ${
        shelf
          ? `<label class="ed-field"><span>ラベル <small>マップに表示（省略可）</small></span><input id="ed-label" maxlength="${STAGE_LIMITS.maxLabel}" placeholder="例: 精肉" value="${esc(shelf.label)}" /></label>
             <button class="btn ed-danger" id="ed-del-sel">この棚を削除</button>`
          : ''
      }
    `;
    el.querySelectorAll<HTMLButtonElement>('.ed-tier').forEach((b) => {
      b.onclick = () => {
        this.brushTier = Number(b.dataset.tier);
        if (shelf) this.commit(() => (shelf.tier = this.brushTier));
        this.renderSelPanel();
      };
    });
    el.querySelectorAll<HTMLButtonElement>('.ed-kind').forEach((b) => {
      b.onclick = () => {
        this.brushLow = b.dataset.low === '1';
        if (shelf) this.commit(() => (shelf.low = this.brushLow));
        this.renderSelPanel();
      };
    });
    if (shelf) {
      this.bindText(this.q<HTMLInputElement>('#ed-label'), (v) => {
        shelf.label = cleanText(v, STAGE_LIMITS.maxLabel);
      });
      this.q<HTMLButtonElement>('#ed-del-sel').onclick = () => this.deleteSelection();
    }
  }

  private renderInfoPanel(): void {
    const d = this.cur;
    const check = validateStage(d);
    const chips =
      PRICE_TIERS.map(
        (t, i) =>
          `<span class="ed-chip"><i style="background:${hex(t.color)}"></i>${t.name} ${d.shelves.filter((s) => s.tier === i).length}</span>`,
      ).join('') +
      `<span class="ed-chip"><i class="rnd"></i>おまかせ ${d.shelves.filter((s) => s.tier < 0).length}</span>`;
    const issues = [
      ...check.errors.map((e) => `<p class="ed-issue err">⛔ ${esc(e)}</p>`),
      ...check.warnings.map((w) => `<p class="ed-issue warn">⚠️ ${esc(w)}</p>`),
    ].join('');
    const blocked = check.errors.length > 0;
    this.q<HTMLDivElement>('#ed-info-panel').innerHTML = `
      <h3 class="section-title">チェックとテスト</h3>
      <p class="ed-stats">棚 <b>${d.shelves.length}</b>個（盗みスポット <b>${spotCells(d).length}</b>か所）・カメラ <b>${d.cams.length}</b>台・NPC <b>${d.npcCount}</b>人</p>
      <div class="ed-chips">${chips}</div>
      ${issues}
      <p class="ed-issue ${blocked ? 'err' : 'ok'}">${
        blocked ? '⛔ の項目を直すと遊べるようになります' : '✅ 遊べます。ルーム作成のステージ選択に出ます'
      }</p>
      <div class="ed-test">
        <button class="ed-play" data-test="mouse" ${blocked ? 'disabled' : ''}>▶ ネズミで歩く</button>
        <button class="ed-play" data-test="cat" ${blocked ? 'disabled' : ''}>▶ 猫カメラで見る</button>
      </div>
      <p class="lobby-note dim">テストプレイは1人用（NPCあり。${CONFIG.roundTimeSec}秒のラウンドが終わると自動でやり直し）。対戦で使うときは、タイトル →「スタート」→ ルームを新規作成 でこのステージを選ぶ</p>
    `;
    this.root.querySelectorAll<HTMLButtonElement>('.ed-play').forEach((b) => {
      b.onclick = () => this.startTest(b.dataset.test as TestRole);
    });
  }

  // ---- ツール・選択 ----

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.classList.toggle('selected', b.dataset.tool === tool);
    });
    this.updateHint();
    this.updateCursor();
  }

  private deleteSelection(): void {
    const sel = this.sel;
    if (!sel || (sel.kind !== 'shelf' && sel.kind !== 'cam')) return;
    this.sel = null;
    this.commit(() => {
      if (sel.kind === 'shelf') this.cur.shelves.splice(sel.i, 1);
      else this.cur.cams.splice(sel.i, 1);
    });
    this.renderSelPanel();
  }

  /** 棚を選択したら、ブラシもその棚の料金帯・高さに合わせる（続けて同じ棚を描けるように） */
  private select(sel: Sel | null): void {
    this.sel = sel;
    const shelf = sel?.kind === 'shelf' ? this.cur.shelves[sel.i] : undefined;
    if (shelf) {
      this.brushTier = shelf.tier;
      this.brushLow = shelf.low;
    }
  }

  // ---- 座標と当たり判定（マス単位） ----

  private toCell(e: PointerEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.cell - PAD, y: (e.clientY - r.top) / this.cell - PAD_TOP };
  }

  /** 点が乗っているマス（範囲内に丸める） */
  private cellOf(g: Pt): Pt {
    return {
      x: clamp(Math.floor(g.x), 0, this.cur.w - 1),
      y: clamp(Math.floor(g.y), 0, this.cur.h - 1),
    };
  }

  private inside(g: Pt, margin = 0): boolean {
    return g.x >= -margin && g.x <= this.cur.w + margin && g.y >= -margin && g.y <= this.cur.h + margin;
  }

  /** カメラの位置・注視点に使う点（0.5マス刻み、範囲内） */
  private camPoint(g: Pt): Pt {
    return { x: clamp(snapHalf(g.x), 0, this.cur.w), y: clamp(snapHalf(g.y), 0, this.cur.h) };
  }

  /** 他の棚と重なるか（except は自分自身） */
  private overlaps(r: CellRect, except: number): boolean {
    return this.cur.shelves.some(
      (s, i) => i !== except && r.x < s.x + s.w && r.x + r.w > s.x && r.y < s.y + s.h && r.y + r.h > s.y,
    );
  }

  private shelfAt(g: Pt): number {
    return this.cur.shelves.findIndex((s) => g.x >= s.x && g.x < s.x + s.w && g.y >= s.y && g.y < s.y + s.h);
  }

  private camAt(g: Pt): number {
    let best = -1;
    let bestD = Math.max(0.55, 11 / this.cell);
    this.cur.cams.forEach((c, i) => {
      const dist = Math.hypot(g.x - c.x, g.y - c.y);
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  }

  /** ポインタの下にある、いまのツールでつかめるもの（選択ツールは全部、棚・カメラのツールは同じ種類だけ） */
  private grabAt(g: Pt): Grab | null {
    const d = this.cur;
    const sel = this.sel;
    const canCam = this.tool === 'select' || this.tool === 'cam';
    const canShelf = this.tool === 'select' || this.tool === 'shelf';
    if (canCam) {
      if (sel?.kind === 'cam' && d.cams[sel.i]) {
        const c = d.cams[sel.i];
        if (Math.hypot(g.x - c.ax, g.y - c.ay) < Math.max(0.45, 9 / this.cell)) return { kind: 'aim', i: sel.i };
      }
      const ci = this.camAt(g);
      if (ci >= 0) return { kind: 'cam', i: ci };
    }
    if (this.tool === 'select') {
      const si = d.spawns.findIndex((p) => Math.floor(g.x) === p.x && Math.floor(g.y) === p.y);
      if (si >= 0) return { kind: 'spawn', i: si };
    }
    if (canShelf) {
      if (sel?.kind === 'shelf' && d.shelves[sel.i]) {
        const s = d.shelves[sel.i];
        const tol = Math.max(0.35, 7 / this.cell);
        // [ハンドルの位置, 動かない側（対角）のマス]
        const corners: [number, number, number, number][] = [
          [s.x, s.y, s.x + s.w - 1, s.y + s.h - 1],
          [s.x + s.w, s.y, s.x, s.y + s.h - 1],
          [s.x, s.y + s.h, s.x + s.w - 1, s.y],
          [s.x + s.w, s.y + s.h, s.x, s.y],
        ];
        for (const [hx, hy, fx, fy] of corners) {
          if (Math.abs(g.x - hx) < tol && Math.abs(g.y - hy) < tol) return { kind: 'handle', i: sel.i, fx, fy };
        }
      }
      const shi = this.shelfAt(g);
      if (shi >= 0) return { kind: 'shelf', i: shi };
    }
    if (this.tool === 'select' && g.y >= -PAD_TOP && g.y < 0.2 && g.x >= d.exit.x && g.x <= d.exit.x + d.exit.w) {
      return { kind: 'exit' };
    }
    return null;
  }

  private eraseAt(g: Pt): void {
    const d = this.cur;
    const ci = this.camAt(g);
    if (ci >= 0) {
      d.cams.splice(ci, 1);
      this.sel = null;
      return;
    }
    const si = this.shelfAt(g);
    if (si >= 0) {
      d.shelves.splice(si, 1);
      this.sel = null;
    }
  }

  // ---- ポインタ操作 ----

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    // 入力欄にフォーカスが残っていると Delete などのキー操作が効かないので外す
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.canvas.setPointerCapture(e.pointerId);
    const d = this.cur;
    const g = this.toCell(e);
    const cell = this.cellOf(g);
    const before = JSON.stringify(d);
    if (this.tool === 'erase') {
      this.drag = { kind: 'erase', before };
      this.eraseAt(g);
    } else {
      const grab = this.grabAt(g);
      if (grab?.kind === 'aim') {
        this.drag = { kind: 'aim-cam', i: grab.i, before };
      } else if (grab?.kind === 'cam') {
        const c = d.cams[grab.i];
        this.select({ kind: 'cam', i: grab.i });
        this.drag = { kind: 'move-cam', i: grab.i, dx: g.x - c.x, dy: g.y - c.y, before };
      } else if (grab?.kind === 'spawn') {
        this.select({ kind: 'spawn', i: grab.i });
        this.drag = { kind: 'spawn', i: grab.i, before };
      } else if (grab?.kind === 'handle') {
        this.drag = { kind: 'resize-shelf', i: grab.i, fx: grab.fx, fy: grab.fy, before };
      } else if (grab?.kind === 'shelf') {
        const s = d.shelves[grab.i];
        this.select({ kind: 'shelf', i: grab.i });
        this.drag = { kind: 'move-shelf', i: grab.i, dx: cell.x - s.x, dy: cell.y - s.y, before };
      } else if (grab?.kind === 'exit') {
        this.select({ kind: 'exit' });
        this.drag = { kind: 'exit', dx: g.x - d.exit.x, before };
      } else if (this.tool === 'shelf' && this.inside(g)) {
        this.select(null);
        this.drag = { kind: 'new-shelf', x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y, before };
      } else if (this.tool === 'cam' && this.inside(g, 0.4)) {
        this.select(null);
        const p = this.camPoint(g);
        this.drag = { kind: 'new-cam', cam: { x: p.x, y: p.y, ax: p.x, ay: p.y }, before };
      } else {
        this.select(null);
      }
    }
    this.renderSelPanel();
    this.draw();
  };

  private onMove = (e: PointerEvent): void => {
    const g = this.toCell(e);
    this.hover = g;
    this.updateHint();
    const drag = this.drag;
    if (!drag) {
      this.updateCursor();
      return;
    }
    const d = this.cur;
    const cell = this.cellOf(g);
    switch (drag.kind) {
      case 'new-shelf':
        drag.x1 = cell.x;
        drag.y1 = cell.y;
        break;
      case 'move-shelf': {
        // 他の棚と重なる位置には動かさない（直前の位置で止まる）
        const s = d.shelves[drag.i];
        const r = {
          x: clamp(cell.x - drag.dx, 0, d.w - s.w),
          y: clamp(cell.y - drag.dy, 0, d.h - s.h),
          w: s.w,
          h: s.h,
        };
        if (!this.overlaps(r, drag.i)) Object.assign(s, r);
        break;
      }
      case 'resize-shelf': {
        const r = {
          x: Math.min(drag.fx, cell.x),
          y: Math.min(drag.fy, cell.y),
          w: Math.abs(cell.x - drag.fx) + 1,
          h: Math.abs(cell.y - drag.fy) + 1,
        };
        if (!this.overlaps(r, drag.i)) Object.assign(d.shelves[drag.i], r);
        break;
      }
      case 'new-cam': {
        const p = this.camPoint(g);
        drag.cam.ax = p.x;
        drag.cam.ay = p.y;
        break;
      }
      case 'move-cam': {
        // 向き（位置→注視点）を保ったまま動かす
        const c = d.cams[drag.i];
        const p = this.camPoint({ x: g.x - drag.dx, y: g.y - drag.dy });
        const a = this.camPoint({ x: c.ax + p.x - c.x, y: c.ay + p.y - c.y });
        if (a.x !== p.x || a.y !== p.y) Object.assign(c, { x: p.x, y: p.y, ax: a.x, ay: a.y });
        break;
      }
      case 'aim-cam': {
        const c = d.cams[drag.i];
        const p = this.camPoint(g);
        if (p.x !== c.x || p.y !== c.y) Object.assign(c, { ax: p.x, ay: p.y });
        break;
      }
      case 'spawn':
        Object.assign(d.spawns[drag.i], cell);
        break;
      case 'exit':
        d.exit.x = clamp(Math.round(g.x - drag.dx), 0, d.w - d.exit.w);
        break;
      case 'erase':
        this.eraseAt(g);
        break;
    }
    this.draw();
  };

  private onUp = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    const d = this.cur;
    if (drag.kind === 'new-shelf') {
      const r = this.dragRect(drag);
      if (!this.overlaps(r, -1)) {
        // 描いた棚は選択しない（続けて料金帯を選び直して次の棚を描けるように、右パネルはブラシのままにする）
        d.shelves.push({ ...r, tier: this.brushTier, low: this.brushLow, label: '' });
      }
    } else if (drag.kind === 'new-cam') {
      const c = drag.cam;
      if (Math.hypot(c.ax - c.x, c.ay - c.y) < 1) {
        // クリックだけで置いたときは店の中央へ向ける
        let vx = d.w / 2 - c.x;
        let vy = d.h / 2 - c.y;
        const len = Math.hypot(vx, vy);
        if (len < 0.5) {
          vx = 0;
          vy = 1;
        } else {
          vx /= len;
          vy /= len;
        }
        const a = this.camPoint({ x: c.x + vx * 6, y: c.y + vy * 6 });
        c.ax = a.x;
        c.ay = a.y;
      }
      d.cams.push(c);
      this.select({ kind: 'cam', i: d.cams.length - 1 });
    }
    if (JSON.stringify(d) !== drag.before) this.pushUndo(drag.before);
    this.renderSelPanel();
    this.changed();
  };

  /** ドラッグの取り消し（Esc・ポインタのキャンセル）。開始時点に戻す */
  private onCancel = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.restoreSilently(drag.before);
  };

  private restoreSilently(json: string): void {
    const data = JSON.parse(json) as CustomStageData;
    this.stages[this.stages.indexOf(this.cur)] = data;
    this.cur = data;
    this.sel = null;
    this.renderSelPanel();
    this.changed();
  }

  private onLeave = (): void => {
    this.hover = null;
    this.updateHint();
  };

  private dragRect(drag: { x0: number; y0: number; x1: number; y1: number }): CellRect {
    return {
      x: Math.min(drag.x0, drag.x1),
      y: Math.min(drag.y0, drag.y1),
      w: Math.abs(drag.x1 - drag.x0) + 1,
      h: Math.abs(drag.y1 - drag.y0) + 1,
    };
  }

  private updateCursor(): void {
    let cursor = 'default';
    const g = this.hover;
    if (g) {
      const grab = this.tool === 'erase' ? null : this.grabAt(g);
      if (grab?.kind === 'handle') cursor = 'nwse-resize';
      else if (grab?.kind === 'exit') cursor = 'ew-resize';
      else if (grab) cursor = 'move';
      else if (this.tool === 'shelf' || this.tool === 'cam') cursor = 'crosshair';
      else if (this.tool === 'erase') cursor = 'pointer';
    }
    this.canvas.style.cursor = cursor;
  }

  private updateHint(): void {
    const g = this.hover;
    const pos = g && this.inside(g) ? `（左から${this.cellOf(g).x + 1}・奥から${this.cellOf(g).y + 1}マス目）` : '';
    this.q<HTMLParagraphElement>('#ed-hint').textContent = `${TOOL_HINTS[this.tool]}${pos}`;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.testPlay) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (this.drag) return;
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (e.code === 'Delete' || e.code === 'Backspace') {
      if (!this.drag) this.deleteSelection();
    } else if (e.code === 'Escape') {
      if (this.drag) {
        this.onCancel();
      } else if (this.sel) {
        this.select(null);
        this.renderSelPanel();
        this.draw();
      }
    }
  };

  private onResize = (): void => {
    if (this.testPlay) return;
    this.layout();
    this.draw();
  };

  // ---- 描画 ----

  /** 表示領域に収まるよう1マスの大きさを決め、キャンバスのサイズを合わせる */
  private layout(): void {
    const d = this.cur;
    const host = this.q<HTMLElement>('#ed-stage');
    const cols = d.w + PAD * 2;
    const rows = d.h + PAD_TOP + PAD;
    const availW = host.clientWidth - 16;
    const availH = host.clientHeight - 56; // ヒント行の分
    this.cell = clamp(Math.floor(Math.min(availW / cols, availH / rows)), 8, 40);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(cols * this.cell);
    const h = Math.round(rows * this.cell);
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private draw(): void {
    const d = this.cur;
    const c = this.cell;
    const ctx = this.ctx;
    const drag = this.drag;
    const sel = this.sel;
    const X = (x: number) => (x + PAD) * c;
    const Y = (y: number) => (y + PAD_TOP) * c;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#2b2e34';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const label = (text: string, x: number, y: number, px: number, color: string, maxW?: number) => {
      ctx.fillStyle = color;
      ctx.font = `bold ${px}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y, maxW);
    };

    // 床
    ctx.fillStyle = '#454a52';
    ctx.fillRect(X(0), Y(0), d.w * c, d.h * c);

    // カメラの視野（棚・壁で遮られた実効範囲。塗られていない床が死角）。置いている途中のカメラも含める
    const cams = drag?.kind === 'new-cam' ? [...d.cams, drag.cam] : d.cams;
    if (this.showFov) {
      const occluders = occluderCells(d);
      const half = ((CAM_HFOV_DEG / 2) * Math.PI) / 180;
      for (const cam of cams) {
        if (cam.ax === cam.x && cam.ay === cam.y) continue;
        const angle = Math.atan2(cam.ay - cam.y, cam.ax - cam.x);
        ctx.beginPath();
        ctx.moveTo(X(cam.x), Y(cam.y));
        for (let r = 0; r <= FOV_RAYS; r++) {
          const a = angle - half + (2 * half * r) / FOV_RAYS;
          const dist = castRay(cam.x, cam.y, Math.cos(a), Math.sin(a), CAM_RANGE, occluders);
          ctx.lineTo(X(cam.x + Math.cos(a) * dist), Y(cam.y + Math.sin(a) * dist));
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(255, 82, 82, 0.14)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 82, 82, 0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // マス目（5マスごとに濃くして数えやすくする）
    ctx.lineWidth = 1;
    for (let x = 0; x <= d.w; x++) {
      ctx.strokeStyle = x % 5 === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(X(x) + 0.5, Y(0));
      ctx.lineTo(X(x) + 0.5, Y(d.h));
      ctx.stroke();
    }
    for (let y = 0; y <= d.h; y++) {
      ctx.strokeStyle = y % 5 === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(X(0), Y(y) + 0.5);
      ctx.lineTo(X(d.w), Y(y) + 0.5);
      ctx.stroke();
    }

    // NPCが歩ける格子点
    if (this.showNpc) {
      const nodes = npcNodes(d);
      const stride = d.w + 1;
      ctx.fillStyle = 'rgba(120, 220, 255, 0.7)';
      for (let j = 1; j < d.h; j++) {
        for (let i = 1; i < d.w; i++) {
          if (!nodes.walk[j * stride + i]) continue;
          ctx.beginPath();
          ctx.arc(X(i), Y(j), Math.max(1.5, c * 0.1), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 棚（料金帯の色。平台は薄く＋破線、おまかせは灰色に「?」）
    const fontPx = clamp(Math.round(c * 0.55), 8, 13);
    d.shelves.forEach((s) => {
      const x = X(s.x) + 1;
      const y = Y(s.y) + 1;
      const w = s.w * c - 2;
      const h = s.h * c - 2;
      ctx.globalAlpha = s.low ? 0.6 : 1;
      ctx.fillStyle = s.tier >= 0 ? hex(PRICE_TIERS[s.tier].color) : '#8f96a3';
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      if (s.low) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(28, 28, 34, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
        ctx.setLineDash([]);
      }
      const text = s.label || (s.tier < 0 ? '?' : '');
      if (text) {
        if (w >= h) {
          label(text, x + w / 2, y + h / 2, fontPx, '#1c1c22', w - 2);
        } else {
          ctx.save();
          ctx.translate(x + w / 2, y + h / 2);
          ctx.rotate(-Math.PI / 2);
          label(text, 0, 0, fontPx, '#1c1c22', h - 2);
          ctx.restore();
        }
      }
    });

    // 盗みスポット（棚の前の、ネズミが盗める位置）
    for (const p of spotCells(d)) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), Math.max(2, c * 0.13), 0, Math.PI * 2);
      ctx.fillStyle = '#ffb300';
      ctx.fill();
      ctx.strokeStyle = '#1c1c22';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 外周の壁と出口
    const wallPx = WALL_T * c;
    ctx.strokeStyle = '#9a968f';
    ctx.lineWidth = wallPx;
    ctx.strokeRect(X(0) - wallPx / 2, Y(0) - wallPx / 2, d.w * c + wallPx, d.h * c + wallPx);
    ctx.strokeStyle = sel?.kind === 'exit' ? '#7be07f' : '#43a047';
    ctx.lineWidth = wallPx + 2;
    ctx.beginPath();
    ctx.moveTo(X(d.exit.x), Y(0) - wallPx / 2);
    ctx.lineTo(X(d.exit.x + d.exit.w), Y(0) - wallPx / 2);
    ctx.stroke();
    label('出口', X(d.exit.x + d.exit.w / 2), Y(0) - wallPx - 9, 12, sel?.kind === 'exit' ? '#7be07f' : '#43a047');

    // 5マスごとの目盛り
    for (let x = 5; x < d.w; x += 5) label(String(x), X(x), Y(d.h) + wallPx + 8, 9, '#8a93a3');
    for (let y = 5; y < d.h; y += 5) label(String(y), X(0) - wallPx - 9, Y(y), 9, '#8a93a3');

    // スポーン地点
    d.spawns.forEach((p, i) => {
      const on = sel?.kind === 'spawn' && sel.i === i;
      ctx.beginPath();
      ctx.arc(X(p.x + 0.5), Y(p.y + 0.5), c * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = '#4fc3f7';
      ctx.fill();
      ctx.strokeStyle = on ? '#ffb300' : '#fff';
      ctx.lineWidth = on ? 3 : 1.5;
      ctx.stroke();
      label(`S${i + 1}`, X(p.x + 0.5), Y(p.y + 0.5), clamp(Math.round(c * 0.45), 8, 12), '#10131a');
    });

    // 選択中の棚の枠と、大きさを変えるハンドル
    if (sel?.kind === 'shelf' && d.shelves[sel.i]) {
      const s = d.shelves[sel.i];
      ctx.strokeStyle = '#ffb300';
      ctx.lineWidth = 2;
      ctx.strokeRect(X(s.x), Y(s.y), s.w * c, s.h * c);
      for (const [hx, hy] of [
        [s.x, s.y],
        [s.x + s.w, s.y],
        [s.x, s.y + s.h],
        [s.x + s.w, s.y + s.h],
      ]) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(X(hx) - 4, Y(hy) - 4, 8, 8);
        ctx.strokeStyle = '#1c1c22';
        ctx.lineWidth = 1;
        ctx.strokeRect(X(hx) - 4, Y(hy) - 4, 8, 8);
      }
    }

    // 描いている途中の棚
    if (drag?.kind === 'new-shelf') {
      const r = this.dragRect(drag);
      const bad = this.overlaps(r, -1);
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = this.brushTier >= 0 ? hex(PRICE_TIERS[this.brushTier].color) : '#8f96a3';
      ctx.fillRect(X(r.x), Y(r.y), r.w * c, r.h * c);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = bad ? '#ff5252' : '#ffb300';
      ctx.lineWidth = 2;
      ctx.strokeRect(X(r.x), Y(r.y), r.w * c, r.h * c);
      label(bad ? '重なっています' : `${r.w}×${r.h}`, X(r.x + r.w / 2), Y(r.y) - 9, 11, bad ? '#ff5252' : '#ffb300');
    }

    // カメラ本体・番号・向き。選択中（と置いている途中）は注視点までの線とハンドルを出す
    const camR = Math.max(7, c * 0.42);
    cams.forEach((cam, i) => {
      const on = (sel?.kind === 'cam' && sel.i === i) || i >= d.cams.length;
      const x = X(cam.x);
      const y = Y(cam.y);
      const len = Math.hypot(cam.ax - cam.x, cam.ay - cam.y);
      if (on && len > 0) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(X(cam.ax), Y(cam.ay));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(X(cam.ax), Y(cam.ay), 6, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#ffb300';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (len > 0) {
        // 向きを示す短い線
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + ((cam.ax - cam.x) / len) * (camR + c * 0.45), y + ((cam.ay - cam.y) / len) * (camR + c * 0.45));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, camR, 0, Math.PI * 2);
      ctx.fillStyle = '#d32f2f';
      ctx.fill();
      ctx.strokeStyle = on ? '#ffb300' : '#fff';
      ctx.lineWidth = on ? 3 : 1.5;
      ctx.stroke();
      label(String(i + 1), x, y, clamp(Math.round(camR * 1.1), 8, 13), '#fff');
    });
  }

  // ---- テストプレイ ----

  private startTest(role: TestRole): void {
    if (this.testPlay || validateStage(this.cur).errors.length > 0) return;
    this.root.classList.add('hidden');
    this.testPlay = new TestPlay(this.parent, this.cur, role, () => this.endTest());
  }

  private endTest(): void {
    this.testPlay?.dispose();
    this.testPlay = null;
    this.root.classList.remove('hidden');
    this.layout();
    this.draw();
  }

  /** リソース解放（テストプレイ中のゲーム・イベントリスナ・タイマー・DOM） */
  dispose(): void {
    this.disposed = true;
    this.testPlay?.dispose();
    this.testPlay = null;
    window.clearTimeout(this.deleteArmTimer);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}
