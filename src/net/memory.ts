import type { NetAdapter } from './adapter';
import { getIn, setIn, type Tree } from './local';

/**
 * どこにも繋がらないメモリ内アダプタ。ステージエディタの1人テストプレイ用で、
 * 本物のルーム（Firebase・他のタブ）には何も書かない。
 */
export class MemoryAdapter implements NetAdapter {
  readonly clientId = 'solo';
  readonly mode = 'local' as const;
  private tree: Tree = {};
  private subs: { path: string; cb: (val: unknown) => void }[] = [];
  private pushCounter = 0;

  private notify(changedPath: string): void {
    // 通知中に購読が解除されても安全なようコピーを回す
    for (const s of this.subs.slice()) {
      if (changedPath.startsWith(s.path) || s.path.startsWith(changedPath)) {
        s.cb(getIn(this.tree, s.path.split('/')));
      }
    }
  }

  async ready(): Promise<void> {
    // 準備不要
  }

  set(path: string, value: unknown): void {
    setIn(this.tree, path.split('/'), value);
    this.notify(path);
  }

  push(path: string, value: unknown): void {
    this.set(`${path}/k${Date.now().toString(36)}_${this.pushCounter++}`, value);
  }

  remove(path: string): void {
    setIn(this.tree, path.split('/'), null);
    this.notify(path);
  }

  subscribe(path: string, cb: (val: unknown) => void): () => void {
    const sub = { path, cb };
    this.subs.push(sub);
    cb(getIn(this.tree, path.split('/')));
    return () => {
      const i = this.subs.indexOf(sub);
      if (i >= 0) this.subs.splice(i, 1);
    };
  }

  onDisconnectRemove(): void {
    // 切断という概念がない
  }
}
