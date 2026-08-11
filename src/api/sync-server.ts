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
import { currentUser, runAsUser, slugify, storyExists } from "./storage";
import { subscribeSync, worldVersion, type SyncEvent } from "./sync";

/** WS 端点路径（dev/prod 共用） */
export const SYNC_WS_PATH = "/api/sync";

/** 频道 key：用户 + 书名 slug（跨账号隔离；同一账号同一书的所有连接同一频道） */
export function syncChannelKey(user: string, title: string): string {
  return `sync::${user}::${slugify(title)}`;
}

/** WS 连接附加数据：登录用户 + 已订阅的频道集合（close 时退订） */
type SyncWsData = {
  user: AuthUser;
  channels: Set<string>;
};

/** 订阅消息体校验 */
type SubscribeMsg = { type?: string; title?: unknown };

/** websocket 配置（dev/prod 的 Bun.serve 共用） */
export const syncWebsocket = {
  open(ws: ServerWebSocket<SyncWsData>) {
    // 等客户端首条 subscribe；连接建立即注册可 ping
  },
  message(ws: ServerWebSocket<SyncWsData>, message: string | Buffer) {
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
    ws.subscribe(key);
    ws.data.channels.add(key);
    ws.send(JSON.stringify({ type: "subscribed", title, version: worldVersion(title) }));
  },
  close(ws: ServerWebSocket<SyncWsData>) {
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
  const ok = server.upgrade(req, { data: { user, channels: new Set<string>() } satisfies SyncWsData });
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
  return subscribeSync((e: SyncEvent) => {
    if (!e.user) return; // 无 user 的事件（测试/遗留路径）无法定位频道，不推
    const msg = JSON.stringify(e);
    server.publish(syncChannelKey(e.user, e.title), msg);
  });
}

// 供测试/调试：当前用户名兜底（部分调用点未显式传 user 时事件总线仍可工作，但 WS 不推）
export function syncCurrentUser(): string | null {
  return currentUser();
}
