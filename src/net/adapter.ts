/**
 * ネットワーク同期の抽象インターフェース。
 * Firebase Realtime Database と ローカル（BroadcastChannel）の2実装がある。
 * パスは 'rooms/{room}/players/{pid}' のようなスラッシュ区切り。
 */
export interface NetAdapter {
  readonly clientId: string;
  readonly mode: 'firebase' | 'local';
  /** 接続・初期同期の完了を待つ */
  ready(): Promise<void>;
  set(path: string, value: unknown): void;
  /** 一意キーを生成して子として追加する */
  push(path: string, value: unknown): void;
  remove(path: string): void;
  /** パス以下の値を購読。初回と変更のたびに呼ばれる。返り値は解除関数 */
  subscribe(path: string, cb: (val: unknown) => void): () => void;
  /** 切断時（タブを閉じた時）に自動削除するパスを登録 */
  onDisconnectRemove(path: string): void;
}

/** タブごとに一意なプレイヤーIDを返す（リロードしても維持） */
export function getClientId(): string {
  const key = 'dorobo-mouse-pid';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `p${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
}
