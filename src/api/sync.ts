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
import { slugify } from "./storage";

// ============ 事件类型（与前端 useSyncChannel 协议一致） ============

export type SyncEvent = {
  /** 所属用户（频道隔离维度；无 user 的事件不推 WS，测试/遗留路径可省略） */
  user?: string;
} & (
  | {
      type: "world-changed";
      /** 书名（原始 title，非 slug） */
      title: string;
      /** per-title 递增版本戳：客户端据此丢弃旧事件 */
      version: number;
      /** 触发语义（阶段 0 统一 "save"；后续可扩展 actor/field 语义） */
      reason?: string;
      /** 受影响 UI 区域（COUPLING §2 U01-U19；缺省=全部区域，前端全量刷新） */
      regions?: string[];
      at: number;
    }
  | {
      type: "auto-status";
      title: string;
      status: string;
      phase?: string;
      written?: number;
      updatedAt?: string;
      at: number;
    }
  | {
      type: "task-status";
      title: string;
      kind: "build" | "advance" | "media" | "visual";
      id?: string;
      /** 子类型（media 分支）：plan=分镜任务完成广播（前端据此就地翻「分镜完成」卡，免轮询）；缺省=媒体生成任务 */
      sub?: "plan";
      /** 分镜完成场景列表（sub:"plan" ready 时携带，前端就地翻卡直接可用） */
      scenes?: { anchor: string; scene: string; caption?: string }[];
      status: string;
      error?: string;
      at: number;
    }
  | {
      type: "brain-note";
      title: string;
      eventId: string;
      text: string;
      at: number;
    }
  | {
      type: "card-update";
      title: string;
      sessionId: string;
      messageId: string;
      cardId: string;
      patch: Record<string, unknown>;
      at: number;
    }
  | {
      type: "card-replaced";
      title: string;
      sessionId: string;
      messageId: string;
      cardIndex: number;
      card: Record<string, unknown>;
      at: number;
    }
  | {
      type: "brain-append";
      title: string;
      sessionId: string;
      messageId: string;
      at: number;
    }
  | {
      type: "brain-status";
      title: string;
      sessions: {
        id: string;
        sessionTitle: string;
        createdAt: number;
        streaming: boolean;
        updatedAt: number;
        /** 仅订阅/变更快照携带；周期状态帧省略正文，避免反复传输整段聊天。 */
        messages?: Record<string, unknown>[];
        /** 周期帧的轻量消息状态：不含 text/thinking，只用于清 pending 与翻卡。 */
        messageStates?: Record<string, unknown>[];
        messageCount?: number;
        completed?: string[];
      }[];
      tasks: {
        id: string;
        status: string;
        sub?: "plan";
        error?: string;
        scenes?: { anchor: string; scene: string; caption?: string }[];
      }[];
      at: number;
    }
);

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

/** 读取某书当前版本（阶段 1 新连接初始同步用）；无记录返回 0 */
export function worldVersion(title: string): number {
  return worldVersions.get(slugify(title)) ?? 0;
}

/** A 级：saveWorld 落盘后调用（storage.ts 钩子）。无订阅者时零开销。
 *  user：所属用户名（频道隔离用），由调用方从 currentUser() 传入。
 *  regions：受影响 UI 区域（COUPLING §2 U01-U19；缺省=全部，前端全量刷新）。
 *  ——注意：storage.saveWorld 是通用落盘，不感知业务上下文，默认不传 regions（全量）；
 *    业务写点（routes/director 等）如需区域级刷新，可显式调用 publishSync 带 regions。 */
export function notifyWorldSaved(title: string, reason = "save", user?: string, regions?: string[]): void {
  if (listeners.size === 0) return;
  const key = slugify(title);
  const version = (worldVersions.get(key) ?? 0) + 1;
  worldVersions.set(key, version);
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
