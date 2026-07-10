import type { NetAdapter } from './adapter';
import { getClientId } from './adapter';

type Op =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'hello'; from: string }
  | { op: 'snap'; to: string; tree: unknown };

type Tree = Record<string, unknown>;

function getIn(tree: unknown, parts: string[]): unknown {
  let cur: unknown = tree;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Tree)[p];
  }
  return cur ?? null;
}

function setIn(tree: Tree, parts: string[], value: unknown): void {
  let cur: Tree = tree;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Tree;
  }
  if (value === null || value === undefined) {
    delete cur[parts[parts.length - 1]];
  } else {
    cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(value));
  }
}

/**
 * 同一マシンの複数タブ間で同期するローカルアダプタ（BroadcastChannel使用）。
 * Firebase設定なしでのプロトタイプ動作確認用。
 */
export class LocalAdapter implements NetAdapter {
  readonly clientId = getClientId();
  readonly mode = 'local' as const;
  private tree: Tree = {};
  private bc = new BroadcastChannel('dorobo-mouse-net');
  private subs: { path: string; cb: (val: unknown) => void }[] = [];
  private cleanupPaths: string[] = [];
  private pushCounter = 0;
  private readyPromise: Promise<void>;

  constructor() {
    this.bc.onmessage = (ev: MessageEvent<Op>) => this.handle(ev.data);
    // 既存タブから状態のスナップショットをもらう（300ms待って来なければ空のまま）
    this.readyPromise = new Promise((resolve) => {
      this.bc.postMessage({ op: 'hello', from: this.clientId } satisfies Op);
      setTimeout(resolve, 300);
    });
    window.addEventListener('beforeunload', this.handleUnload);
  }

  private handleUnload = () => {
    for (const path of this.cleanupPaths) this.remove(path);
  };

  private handle(op: Op): void {
    switch (op.op) {
      case 'hello':
        this.bc.postMessage({ op: 'snap', to: op.from, tree: this.tree } satisfies Op);
        break;
      case 'snap':
        if (op.to === this.clientId) {
          this.tree = (op.tree as Tree) ?? {};
          for (const s of this.subs) this.notifyOne(s);
        }
        break;
      case 'set':
        setIn(this.tree, op.path.split('/'), op.value);
        this.notify(op.path);
        break;
      case 'remove':
        setIn(this.tree, op.path.split('/'), null);
        this.notify(op.path);
        break;
    }
  }

  private notify(changedPath: string): void {
    for (const s of this.subs) {
      // 変更パスと購読パスのどちらかが他方の接頭辞なら影響あり
      if (changedPath.startsWith(s.path) || s.path.startsWith(changedPath)) {
        this.notifyOne(s);
      }
    }
  }

  private notifyOne(s: { path: string; cb: (val: unknown) => void }): void {
    s.cb(getIn(this.tree, s.path.split('/')));
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  set(path: string, value: unknown): void {
    setIn(this.tree, path.split('/'), value);
    this.bc.postMessage({ op: 'set', path, value } satisfies Op);
    this.notify(path);
  }

  push(path: string, value: unknown): void {
    const key = `k${Date.now().toString(36)}_${this.clientId}_${this.pushCounter++}`;
    this.set(`${path}/${key}`, value);
  }

  remove(path: string): void {
    setIn(this.tree, path.split('/'), null);
    this.bc.postMessage({ op: 'remove', path } satisfies Op);
    this.notify(path);
  }

  subscribe(path: string, cb: (val: unknown) => void): () => void {
    const sub = { path, cb };
    this.subs.push(sub);
    this.notifyOne(sub);
    return () => {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  onDisconnectRemove(path: string): void {
    this.cleanupPaths.push(path);
  }
}
