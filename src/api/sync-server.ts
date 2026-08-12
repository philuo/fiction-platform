// 状态同步 WebSocket 端点（阶段 1a）：事件总线的推送出口
// - 升级鉴权：userFromRequest(req)（Bearer token 或 httpOnly cookie——浏览器 WS 握手自动带 cookie，
//   故前端无需自定义 header，token/cookie 两种凭证均可用，零鉴权改造）
// - 频道模型：Bun 原生 pub-sub（ws.subscribe / server.publish），channel = `sync::<user>::<slug>`，
//   按用户 + 书名隔离（不同账号同名书不互串），无需手写 Set 管理
// - 协议（服务端 → 客户端）：
//     { type:"subscribed", title, version }          # 订阅成功（version=当前 world 版本戳，前端比对去重）
//     { type:"pong" }                                # 心跳回应
//     <SyncEvent 透传>                                # world-changed / auto-status / task-status / brain-note
//   （客户端 → 服务端）：
//     { type:"subscribe", title }                    # 订阅某书频道
//     { type:"ping" }                                # 心跳保活（前端定时发送）
import type { Server, ServerWebSocket } from "bun";
import { userFromRequest, type AuthUser } from "./auth";
import { currentUser, loadWorld, runAsUser, slugify, storyExists } from "./storage";
import { publishSyncImmediate, subscribeSync, worldVersion, type SyncEvent } from "./sync";
import { getSystemSyncSnapshot, listMediaTaskStates, listPendingMediaTasks } from "./routes";
import { listSyncSessionSnapshots, sessionHasAsyncState, updateMediaFormCardValues } from "./brain-sessions";
import { MAX_IMAGES_PER_CHAPTER, imageOccupiesQuota } from "../shared/media-const";
import { runtimeReadiness } from "./runtime-readiness";
import { listStoriesMeta } from "./storage";
import { loadNewStoryTasks } from "./newtask";
import { recordProjectionSnapshot } from "./control-plane";

/** WS 端点路径（dev/prod 共用） */
export const SYNC_WS_PATH = "/api/sync";

/** 频道 key：用户 + 书名 slug（跨账号隔离；同一账号同一书的所有连接同一频道） */
export function syncChannelKey(user: string, title: string): string {
  return `sync::${user}::${slugify(title)}`;
}

function userChannelKey(user: string): string {
  return `sync::${user}::user`;
}

function sendLibrarySnapshot(ws: ServerWebSocket<SyncWsData>): void {
  const data = runAsUser(ws.data.user.username, () => ({
    stories: listStoriesMeta(),
    tasks: loadNewStoryTasks().map((t) => ({
      id: t.id, idea: t.idea, genre: t.genre ?? "", status: t.status, title: t.title,
      stage: t.stage, error: t.error, createdAt: t.startedAt, updatedAt: t.updatedAt,
    })),
  }));
  const version = recordProjectionSnapshot(ws.data.user.username, "user", "library", data);
  ws.send(JSON.stringify({ type: "library-snapshot", scope: "user", document: "library", ...version, data }));
}

/** WS 连接附加数据：登录用户 + 已订阅的频道集合 + 心跳时间戳 */
type SyncWsData = {
  user: AuthUser;
  channels: Set<string>;
  /** 最近一次收到消息（含 ping）的时间戳；open 时置位 */
  lastSeen: number;
  brainTimer?: ReturnType<typeof setInterval>;
};

/** 心跳超时（ms）：超过此间隔未收到任何消息视为僵尸连接，主动断开 */
const WS_IDLE_TIMEOUT_MS = 60_000;
/** 心跳检测周期（ms）：定期扫描所有连接 */
const WS_SWEEP_INTERVAL_MS = 30_000;

/** 全局心跳扫描定时器（单例；dev/prod 共用） */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** 启动心跳扫描（attachSyncPublish 时调用一次；幂等） */
function ensureHeartbeatSweep(server: Server<SyncWsData>): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    // 遍历所有连接的 socket——Bun 未暴露全局枚举，靠 pub-sub 频道推不动；
    // 改用服务端消息处理器：open 时注册到本模块集合，close 摘除
    for (const ws of allSockets) {
      if (ws.data.lastSeen && now - ws.data.lastSeen > WS_IDLE_TIMEOUT_MS) {
        try {
          ws.close(1001, "心跳超时");
        } catch {
          /* 已关闭 */
        }
      }
    }
  }, WS_SWEEP_INTERVAL_MS);
}

/** 所有活动连接集合（供心跳扫描） */
const allSockets = new Set<ServerWebSocket<SyncWsData>>();

function brainStatusPayload(ws: ServerWebSocket<SyncWsData>, title: string, full: boolean) {
  const sessions = runAsUser(ws.data.user.username, () => listSyncSessionSnapshots(title));
  const tasks = runAsUser(ws.data.user.username, () => listMediaTaskStates(ws.data.user.username, title));
  return {
    type: "brain-status", title, full,
    sessions: sessions.map((s) => ({
      id: s.id, sessionTitle: s.title, createdAt: s.createdAt, streaming: s.streaming,
      updatedAt: s.updatedAt, messageCount: s.messages.length,
      ...(full
        ? { messages: s.messages as unknown as Record<string, unknown>[], completed: s.completed }
        : { messageStates: s.messages.map((m) => ({ id: m.id, pending: m.pending, interrupted: m.interrupted, cards: m.cards })) }),
    })),
    tasks,
    at: Date.now(),
    active: sessions.some(sessionHasAsyncState) || tasks.some((t) => t.status === "pending" || t.status === "running"),
  };
}

function sendBrainStatus(ws: ServerWebSocket<SyncWsData>, title: string): boolean {
  const payload = brainStatusPayload(ws, title, true);
  const { at: _at, ...stable } = payload;
  const version = recordProjectionSnapshot(ws.data.user.username, `story/${title}`, "brain", stable);
  ws.send(JSON.stringify({ ...payload, ...version }));
  return payload.active;
}

function sendBrainStatusFrame(ws: ServerWebSocket<SyncWsData>, payload: ReturnType<typeof brainStatusPayload>): void {
  const { at: _at, ...stable } = payload;
  const version = recordProjectionSnapshot(ws.data.user.username, `story/${payload.title}`, "brain", stable);
  ws.send(JSON.stringify({ ...payload, ...version }));
}

function sendSystemSnapshot(ws: ServerWebSocket<SyncWsData>, title: string, heal = false): void {
  const snapshot = runAsUser(ws.data.user.username, () => getSystemSyncSnapshot(title, heal));
  if (snapshot) {
    const version = recordProjectionSnapshot(ws.data.user.username, `story/${title}`, "system", snapshot);
    ws.send(JSON.stringify({ type: "system-snapshot", scope: `story/${title}`, document: "system", ...version, ...snapshot, at: Date.now() }));
  }
}

/** 订阅消息体校验 */
type SubscribeMsg = {
  type?: string;
  title?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  cardIndex?: unknown;
  values?: { chapterIndex?: unknown; count?: unknown };
};

function unsubscribeStoryChannels(ws: ServerWebSocket<SyncWsData>): void {
  const userChannel = userChannelKey(ws.data.user.username);
  for (const channel of [...ws.data.channels]) {
    if (channel === userChannel) continue;
    ws.unsubscribe(channel);
    ws.data.channels.delete(channel);
  }
  if (ws.data.brainTimer) {
    clearInterval(ws.data.brainTimer);
    ws.data.brainTimer = undefined;
  }
}

/** websocket 配置（dev/prod 的 Bun.serve 共用） */
export const syncWebsocket = {
  open(ws: ServerWebSocket<SyncWsData>) {
    ws.data.lastSeen = Date.now();
    allSockets.add(ws);
    const userChannel = userChannelKey(ws.data.user.username);
    ws.subscribe(userChannel);
    ws.data.channels.add(userChannel);
    const runtime = runtimeReadiness();
    ws.send(JSON.stringify({ type: "hello", serverInstanceId: runtime.serverInstanceId, ready: runtime.ready }));
    sendLibrarySnapshot(ws);
  },
  message(ws: ServerWebSocket<SyncWsData>, message: string | Buffer) {
    ws.data.lastSeen = Date.now(); // 任何消息（含 ping）都视为活跃
    let msg: SubscribeMsg;
    try {
      msg = JSON.parse(String(message)) as SubscribeMsg;
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "非法消息（须为 JSON）" }));
      return;
    }
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (msg.type === "media-form-values") {
      const title = String(msg.title ?? "").trim();
      const sessionId = String(msg.sessionId ?? "").trim();
      const messageId = String(msg.messageId ?? "").trim();
      const cardIndex = Number(msg.cardIndex);
      const chapterIndex = Number(msg.values?.chapterIndex);
      const count = Number(msg.values?.count);
      const key = syncChannelKey(ws.data.user.username, title);
      if (!title || !sessionId || !messageId || !Number.isInteger(cardIndex) || cardIndex < 0 || !ws.data.channels.has(key)) {
        ws.send(JSON.stringify({ type: "error", error: "媒体参数同步请求无效或尚未订阅该书" }));
        return;
      }
      const result = runAsUser(ws.data.user.username, () => {
        const world = loadWorld(title);
        const chapter = world?.chapters.find((c) => c.index === chapterIndex);
        if (!world || !chapter) return null;
        const quota = Math.max(0, MAX_IMAGES_PER_CHAPTER - (chapter.media ?? []).filter(imageOccupiesQuota).length);
        const normalizedCount = Number.isInteger(count) ? Math.max(0, Math.min(quota, count)) : undefined;
        return updateMediaFormCardValues(title, sessionId, messageId, cardIndex, {
          chapterIndex,
          count: normalizedCount,
        });
      });
      if (!result) {
        ws.send(JSON.stringify({ type: "error", error: "媒体参数卡不存在或已进入下一阶段" }));
        return;
      }
      const event: SyncEvent = {
        type: "card-replaced", title, sessionId, messageId, cardIndex,
        card: result, at: Date.now(), user: ws.data.user.username,
      };
      publishSyncImmediate(event);
      return;
    }
    if (msg.type === "snapshot") {
      const title = String(msg.title ?? "").trim();
      if (!title) {
        sendLibrarySnapshot(ws);
        return;
      }
      if (!ws.data.channels.has(syncChannelKey(ws.data.user.username, title))) {
        ws.send(JSON.stringify({ type: "error", error: "尚未订阅该书" }));
        return;
      }
      sendSystemSnapshot(ws, title);
      sendBrainStatus(ws, title);
      return;
    }
    if (msg.type === "unsubscribe-story") {
      unsubscribeStoryChannels(ws);
      return;
    }
    if (msg.type !== "subscribe") return; // 未知消息忽略
    const title = String(msg.title ?? "").trim();
    if (!title) {
      ws.send(JSON.stringify({ type: "error", error: "缺少 title" }));
      return;
    }
    // 校验书属于该用户（runAsUser 账号隔离；不存在 → 拒绝订阅）
    const exists = runAsUser(ws.data.user.username, () => storyExists(title));
    if (!exists) {
      ws.send(JSON.stringify({ type: "error", error: "故事不存在: " + title }));
      return;
    }
    const key = syncChannelKey(ws.data.user.username, title);
    unsubscribeStoryChannels(ws);
    ws.subscribe(key);
    ws.data.channels.add(key);
    ws.send(JSON.stringify({ type: "subscribed", title, version: worldVersion(title) }));
    // 建连订阅立即推权威世界/运行态；连接生命周期与中枢弹窗完全无关。
    sendSystemSnapshot(ws, title, true);
    let hadActive = sendBrainStatus(ws, title);
    let hadPendingTasks = false;
    if (ws.data.brainTimer) clearInterval(ws.data.brainTimer);
    ws.data.brainTimer = setInterval(() => {
      try {
        let payload = brainStatusPayload(ws, title, false);
        const pending = runAsUser(ws.data.user.username, () => listPendingMediaTasks(ws.data.user.username, title));
        const hasPendingTasks = pending.length > 0;
        // 进行中定时推；刚进入终态时再推最后一帧，确保 UI 清 loading。
        if (payload.active || hadActive || hasPendingTasks || hadPendingTasks) {
          // 活跃期只发轻量状态；从 active 转入终态时补一帧完整消息，其他 Tab 同时拿到最终正文。
          if (hadActive && !payload.active) payload = brainStatusPayload(ws, title, true);
          sendBrainStatusFrame(ws, payload);
          // 任务快照也经同一条 WS 周期复推，避免页面休眠/事件丢失后 UI 无法确认仍在运行。
          for (const e of pending) ws.send(JSON.stringify(e));
        }
        hadActive = payload.active;
        hadPendingTasks = hasPendingTasks;
      } catch { /* closed socket */ }
    }, 3000);
    // 订阅快照：推送该书当前「进行中」媒体任务（分镜 pending / 插画生成中 / state.json pending），
    // 刷新/重开后前端据此把对应卡标 loading——纯事件驱动，无需 HTTP 轮询。
    // runAsUser 包裹：快照新增的 state.json 扫描依赖 currentUser() 做账号目录隔离。
    const pending = runAsUser(ws.data.user.username, () => listPendingMediaTasks(ws.data.user.username, title));
    hadPendingTasks = pending.length > 0;
    for (const e of pending) {
      ws.send(JSON.stringify(e));
    }
  },
  close(ws: ServerWebSocket<SyncWsData>) {
    if (ws.data.brainTimer) clearInterval(ws.data.brainTimer);
    allSockets.delete(ws);
    // 手动退订（Bun close 时 socket 销毁，频道订阅可能残留；显式清理防内存泄漏）
    for (const ch of ws.data.channels) {
      try {
        ws.unsubscribe(ch);
      } catch {
        /* socket 已销毁 */
      }
    }
    ws.data.channels.clear();
  },
};

/**
 * WS 升级入口：dev/prod 的 fetch 中调用。
 * 返回 null = 非 WS 路径（调用方继续处理）；返回 Response = 拒绝升级（401 等）；返回 undefined = 升级成功。
 */
export function handleSyncUpgrade(pathname: string, req: Request, server: Server<SyncWsData>): Response | null | undefined {
  if (pathname !== SYNC_WS_PATH) return null;
  const user = userFromRequest(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "未登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const runtime = runtimeReadiness();
  if (!runtime.ready) {
    return new Response(JSON.stringify({ error: "服务正在恢复持久状态", ready: false, serverInstanceId: runtime.serverInstanceId }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" },
    });
  }
  const ok = server.upgrade(req, { data: { user, channels: new Set<string>(), lastSeen: Date.now() } satisfies SyncWsData });
  if (!ok) {
    return new Response("WebSocket 升级失败", { status: 400 });
  }
  return undefined; // 升级成功：Bun 接管，不再返回 Response
}

/**
 * 事件总线 → WS 广播：注册订阅者，把 SyncEvent 按 user+title 路由到对应频道。
 * 返回退订函数（进程生命周期内通常不调用）。
 */
export function attachSyncPublish(server: Server<SyncWsData>): () => void {
  ensureHeartbeatSweep(server); // 启动心跳扫描（幂等）
  return subscribeSync((e: SyncEvent) => {
    if (!e.user) return; // 无 user 的事件（测试/遗留路径）无法定位频道，不推
    if (e.type === "library-changed") {
      for (const ws of allSockets) {
        if (ws.data.user.username === e.user) {
          try { sendLibrarySnapshot(ws); } catch { /* socket 已关闭 */ }
        }
      }
      return;
    }
    const msg = JSON.stringify(e);
    const channel = syncChannelKey(e.user, e.title);
    server.publish(channel, msg);
    // 世界/运行态变化后紧跟权威快照。这里直接发送到活跃 socket，避免再走 HTTP state/status。
    if (e.type === "world-changed" || e.type === "auto-status" || e.type === "task-status") {
      for (const ws of allSockets) {
        if (ws.data.user.username !== e.user || !ws.data.channels.has(channel)) continue;
        try { sendSystemSnapshot(ws, e.title); } catch { /* socket 已关闭 */ }
      }
    }
  });
}

// 供测试/调试：当前用户名兜底（部分调用点未显式传 user 时事件总线仍可工作，但 WS 不推）
export function syncCurrentUser(): string | null {
  return currentUser();
}
