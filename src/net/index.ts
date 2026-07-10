import type { NetAdapter } from './adapter';
import { LocalAdapter } from './local';
import { FirebaseAdapter, hasFirebaseConfig } from './firebase';

/** .env に Firebase 設定があれば Firebase、なければローカル（同一PC複数タブ）モード */
export function createNet(): NetAdapter {
  if (hasFirebaseConfig()) {
    return new FirebaseAdapter();
  }
  return new LocalAdapter();
}

export type { NetAdapter };
