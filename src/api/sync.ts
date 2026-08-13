// 状态同步事件总线（阶段 0：打点 + 订阅注册，零行为变化）
// 目标：把「谁写状态」与「何时广播」解耦——所有写路径收敛到统一事件，供推送通道（WebSocket）消费。
//
// 设计（对应 docs/STATUS_SYNC.md §5.5 广播点分级）：
// - A 级：saveWorld 后（storage.ts 钩子 notifyWorldSaved）→ world-changed（单点覆盖全部 state.json 写路径，
//   含中枢直改 / 媒体 / 视觉等盲区；无 actor/字段语义，先发通用 reason）
// - C 级：autorun touchSession → auto-status（连载会话状态转移）
// - D 级：内存任务表完成翻转点 → task-status（媒体/视觉任务完成，无需等落盘）
//
// 关键保证：
// 1. 无订阅者时 publish 直接 return（零开销，不启动定时器）——埋点对现有行为零影响；
// 2. 同 key 事件 1s 合并窗口节流（连载每章多次 saveWorld / 媒体每张一次 → 合并为一条广播）；
// 3. world-changed 带版本戳（per-title 递增），客户端按版本去重（防旧 tab 用旧快照覆盖）。
import { slugify } from "../shared/slug";
import type { SyncEvent } from "../contracts/sync";

export type { SyncEvent } from "../contracts/sync";

// Event protocol types live in contracts/sync.ts; this module only implements the bus.

// ============ 订阅注册 ============

type SyncListener = (e: SyncEvent) => void;
const listeners = new Set<SyncListener>();

/** 注册事件订阅（阶段 1 的 WebSocket 连接、测试断言用）；返回退订函数 */
export function subscribeSync(fn: SyncListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ============ 节流合并（同 key 窗口内取最新一条） ============

/** 合并窗口：连载/媒体高频 saveWorld 在窗口内合并为一条广播（防广播风暴） */
export const SYNC_THROTTLE_MS = 1000;

type Pending = { event: SyncEvent; timer: ReturnType<typeof setTimeout> | null };
const pendingByKey = new Map<string, Pending>();

/** 节流 key：用户 + 事件类型 + 书名 + 任务/卡片维度（同用户同书高频写合并；不同用户同名书不互相吞）。
 *  card-update/card-replaced 按「消息内卡片」分桶：同卡连续更新合并为最新，不同卡互不吞。 */
function throttleKey(e: SyncEvent): string {
  const taskDim = "kind" in e && e.kind ? `::${e.kind}${e.id ? `::${e.id}` : ""}` : "";
  let cardDim = "";
  if (e.type === "card-update") cardDim = `::${e.sessionId}::${e.messageId}::${e.cardId}`;
  else if (e.type === "card-replaced") cardDim = `::${e.sessionId}::${e.messageId}::${e.cardIndex}`;
  return `${e.user ?? ""}::${e.type}::${slugify(e.title)}${taskDim}${cardDim}`;
}

/** 用户级书架/立项投影发生变化；具体快照由 sync-server 在用户频道构建。 */
export function notifyLibraryChanged(user?: string): void {
  if (!user || listeners.size === 0) return;
  publishSyncImmediate({ type: "library-changed", title: "", at: Date.now(), user });
}

/** A non-world story projection field changed and must be rebuilt for subscribed clients. */
export function notifySystemInvalidated(title: string, user?: string): void {
  if (!user || listeners.size === 0) return;
  publishSyncImmediate({ type: "system-invalidated", title, at: Date.now(), user });
}

function flushPending(key: string, p: Pending): void {
  pendingByKey.delete(key);
  if (p.timer) clearTimeout(p.timer);
  dispatchSync(p.event);
}

function dispatchSync(e: SyncEvent): void {
  for (const fn of [...listeners]) {
    try { fn(e); } catch { /* 订阅者异常不阻塞其他订阅者/写路径 */ }
  }
}

/** 发布事件（节流合并；无订阅者时零开销直接返回） */
export function publishSync(e: SyncEvent): void {
  if (listeners.size === 0) return;
  const key = throttleKey(e);
  const existing = pendingByKey.get(key);
  if (existing) {
    // 窗口内已有同 key 事件：更新为最新（不重启定时器，保证窗口边界稳定）
    existing.event = e;
    return;
  }
  const p: Pending = { event: e, timer: null };
  p.timer = setTimeout(() => flushPending(key, p), SYNC_THROTTLE_MS);
  pendingByKey.set(key, p);
}

/** 立即发布不可丢的权威快照（会话删除/截断等瞬时变更不等待节流窗口）。 */
export function publishSyncImmediate(e: SyncEvent): void {
  if (listeners.size === 0) return;
  const key = throttleKey(e);
  const pending = pendingByKey.get(key);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingByKey.delete(key);
  }
  dispatchSync(e);
}

/** 立即冲刷所有挂起事件（测试收尾 / 断线前尽量派发） */
export function flushSyncPending(): void {
  for (const [key, p] of [...pendingByKey]) flushPending(key, p);
}

/** 清除全部挂起（测试收尾防定时器泄漏；不派发） */
export function clearSyncPending(): void {
  for (const [, p] of pendingByKey) {
    if (p.timer) clearTimeout(p.timer);
  }
  pendingByKey.clear();
}

/** 重置全部总线状态（测试隔离 / 热重载用）：清订阅者、挂起、版本戳 */
export function resetSyncState(): void {
  clearSyncPending();
  listeners.clear();
  worldVersions.clear();
}

// ============ A 级钩子：saveWorld 后 ============

/** per-title 版本戳（客户端按版本去重） */
const worldVersions = new Map<string, number>();

function worldVersionKey(title: string, user?: string): string {
  return `${user?.trim() || "__legacy__"}\u0000${slugify(title)}`;
}

/** 读取某书当前版本（阶段 1 新连接初始同步用）；无记录返回 0 */
export function worldVersion(title: string, user?: string): number {
  return worldVersions.get(worldVersionKey(title, user)) ?? 0;
}

/** A 级：saveWorld 落盘后调用（storage.ts 钩子）。无订阅者时零开销。
 *  user：所属用户名（频道隔离用），由调用方从 currentUser() 传入。
 *  regions：受影响 UI 区域（COUPLING §2 U01-U19；缺省=全部，前端全量刷新）。
 *  ——注意：storage.saveWorld 是通用落盘，不感知业务上下文，默认不传 regions（全量）；
 *    业务写点（routes/director 等）如需区域级刷新，可显式调用 publishSync 带 regions。 */
export function notifyWorldSaved(title: string, reason = "save", user?: string, regions?: string[], committedRevision?: number): void {
  const key = worldVersionKey(title, user);
  const version = committedRevision ?? (worldVersions.get(key) ?? 0) + 1;
  worldVersions.set(key, version);
  if (listeners.size === 0) return;
  publishSync({ type: "world-changed", title, version, reason, regions, at: Date.now(), user });
}

/** 卡片就地更新事件发布（阶段 3a）：updateMessageCard 命中后调用。
 *  按 sessionId+messageId+cardId 节流（同卡连续更新合并为最新 patch）。 */
export function publishCardUpdate(
  title: string,
  sessionId: string,
  messageId: string,
  cardId: string,
  patch: Record<string, unknown>,
  user?: string,
): void {
  if (listeners.size === 0) return;
  publishSync({ type: "card-update", title, sessionId, messageId, cardId, patch, at: Date.now(), user });
}

/** 卡片整体替换事件发布：服务端权威落盘整卡（form→分镜中→分镜完成→生成中→done/failed）后调用。
 *  前端按 messageId+cardIndex 就地整卡替换（不重拉会话、不回写 HTTP）；按卡节流（同卡连续替换取最新）。 */
export function publishCardReplaced(
  title: string,
  sessionId: string,
  messageId: string,
  cardIndex: number,
  card: Record<string, unknown>,
  user?: string,
): void {
  if (listeners.size === 0) return;
  publishSync({ type: "card-replaced", title, sessionId, messageId, cardIndex, card, at: Date.now(), user });
}
