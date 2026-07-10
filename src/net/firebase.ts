import { initializeApp } from 'firebase/app';
import {
  getDatabase,
  ref,
  set,
  remove,
  push,
  onValue,
  onDisconnect,
  type Database,
} from 'firebase/database';
import type { NetAdapter } from './adapter';
import { getClientId } from './adapter';

/** Firebase Realtime Database によるルーム同期 */
export class FirebaseAdapter implements NetAdapter {
  readonly clientId = getClientId();
  readonly mode = 'firebase' as const;
  private db: Database;

  constructor() {
    const app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    this.db = getDatabase(app);
  }

  async ready(): Promise<void> {
    // 初期化は同期的に完了する
  }

  set(path: string, value: unknown): void {
    void set(ref(this.db, path), value);
  }

  push(path: string, value: unknown): void {
    void push(ref(this.db, path), value);
  }

  remove(path: string): void {
    void remove(ref(this.db, path));
  }

  subscribe(path: string, cb: (val: unknown) => void): () => void {
    return onValue(ref(this.db, path), (snap) => cb(snap.val()));
  }

  onDisconnectRemove(path: string): void {
    void onDisconnect(ref(this.db, path)).remove();
  }
}

export function hasFirebaseConfig(): boolean {
  return Boolean(
    import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_DATABASE_URL,
  );
}
