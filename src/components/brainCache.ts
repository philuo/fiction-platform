// 中枢聊天 indexeddb 缓存层（Phase 4：客户端缓存增强，服务端始终权威）
// 原则：
//  - 缓存只做「刷新秒开 / 离线回看」的体验增强，绝不作为数据真相；
//  - 打开会话时：先展示缓存（秒开）→ 后台拉服务端 detail 覆盖（服务端最新为准）→ 写回缓存；
//  - 缓存 key 含书名（用户目录隔离：不同书不串），value 带 savedAt（调试/清理用）；
//  - SSR/无 indexedDB 环境静默降级（get 返回 null，put no-op）。
import type { ChatMessage } from "../frontend/features/brain/types";

const DB_NAME = "fp-brain-cache";
const DB_VER = 1;
const STORE = "sessions";
/** 缓存 key：`书名::会话id`（书名即用户书目录 slug，天然按用户+书隔离） */
function keyOf(title: string, sessionId: string): string {
  return `${title}::${sessionId}`;
}

export type CachedSession = {
  msgs: ChatMessage[];
  completed: string[];
  savedAt: number;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 打开 indexeddb（惰性单例；失败/不支持返回 null） */
function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; resolve(null); };
    } catch { dbPromise = null; resolve(null); }
  });
  return dbPromise;
}

/** 读某会话缓存（无/异常 → null） */
export async function cacheGetSession(title: string, sessionId: string): Promise<CachedSession | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(keyOf(title, sessionId));
      req.onsuccess = () => resolve((req.result as CachedSession | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** 写某会话缓存（幂等覆盖；失败静默） */
export async function cachePutSession(title: string, sessionId: string, msgs: ChatMessage[], completed: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ msgs, completed, savedAt: Date.now() } satisfies CachedSession, keyOf(title, sessionId));
  } catch { /* 配额满/隐私模式：静默 */ }
}

/** 删除某书的全部缓存（换书/清理用；bookTitle 前缀匹配） */
export async function cacheClearBook(title: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (String(cur.key).startsWith(`${title}::`)) cur.delete();
      cur.continue();
    };
  } catch { /* 静默 */ }
}
