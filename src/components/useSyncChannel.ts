// 状态同步 WebSocket 客户端 hook（阶段 1b）
// - 打开书时连接 /api/sync，订阅该书频道；服务端经事件总线推送 world-changed/auto-status/task-status/brain-note
// - 鉴权：浏览器 WebSocket 不能自定义 header，握手走 httpOnly cookie（登录/注册已下发，自动携带）
// - 断线自动重连（指数退避 1s→2s→4s，上限 8s），重连成功后自动重新订阅并触发 onReconnected（前端全量补偿一次）
// - world-changed 版本去重：服务端事件已按 1s 窗口节流合并，version 单调递增；客户端只处理 version 更新的事件
// - 断线通过 cursor resume 与权威 snapshot 收敛，不回退到 HTTP 状态轮询
import { useCallback, useEffect, useRef, useState } from "react";
import { acceptServerInstance, applyProjectionPatch, getBrainSyncState, getSystemSyncState, setBrainSyncState, setLibrarySyncState, setSystemSyncState, type SystemSyncState } from "./syncStateStore";
import type { JsonPatchOperation } from "../shared/json-patch";

/** 事件类型（与 src/api/sync.ts SyncEvent 一致；服务端透传原样 JSON） */
export type SyncChannelEvent =
  | { type: "hello"; serverInstanceId: string; ready: boolean }
  | { type: "library-snapshot"; scope: "user"; document: "library"; revision: number; hash: string; cursor?: number; data: { stories: { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string }[]; tasks: { id: string; idea: string; genre: string; status: string; title?: string; stage?: string; error?: string; createdAt: string; updatedAt: string }[] } }
  | { type: "system-snapshot"; title: string; world: Record<string, unknown>; worldRevision?: number; visual: { running: boolean; pending: { id: string; name: string }[]; failed: { id: string; name: string; reason?: string }[] }; autoSession: Record<string, unknown> | null; autoPending: Record<string, unknown> | null; advanceTask: Record<string, unknown> | null; proposalClosed: boolean; at: number; revision?: number; hash?: string; cursor?: number }
  | { type: "system-invalidated"; title: string; at: number }
  | { type: "world-changed"; title: string; version: number; reason?: string; regions?: string[]; at: number }
  | { type: "auto-status"; title: string; status: string; phase?: string; written?: number; updatedAt?: string; at: number }
  | { type: "task-status"; title: string; kind: "build" | "advance" | "media" | "visual"; id?: string; sub?: "plan"; scenes?: { anchor: string; scene: string; caption?: string }[]; status: string; error?: string; at: number }
  | { type: "brain-note"; title: string; eventId: string; text: string; at: number }
  | { type: "card-update"; title: string; sessionId: string; messageId: string; cardId: string; patch: Record<string, unknown>; at: number }
  | { type: "card-replaced"; title: string; sessionId: string; messageId: string; cardIndex: number; card: Record<string, unknown>; at: number }
  | { type: "brain-append"; title: string; sessionId: string; messageId: string; at: number }
  | { type: "brain-status"; title: string; full?: boolean; sessions: { id: string; sessionTitle: string; createdAt: number; streaming: boolean; updatedAt: number; messages?: Record<string, unknown>[]; messageStates?: Record<string, unknown>[]; messageCount?: number; completed?: string[] }[]; tasks: { id: string; status: string; sub?: "plan"; error?: string; scenes?: { anchor: string; scene: string; caption?: string }[] }[]; at: number; revision?: number; hash?: string; cursor?: number }
  | { type: "subscribed"; title: string; version: number }
  | { type: "pong" }
  | { type: "document-changed"; scope: string; document: string; baseRevision: number; revision: number; hash: string; cursor: number }
  | { type: "patch"; scope: string; document: string; baseRevision: number; revision: number; hash: string; ops: JsonPatchOperation[]; cursor: number }
  | { type: "resync-required"; cursor: number }
  | { type: "error"; error: string };

export type UseSyncChannelOpts = {
  /** 当前书 title；null/空 时不连接 */
  title: string | null;
  enabled?: boolean;
  onWorldChanged?: (e: Extract<SyncChannelEvent, { type: "world-changed" }>) => void;
  onSystemSnapshot?: (e: Extract<SyncChannelEvent, { type: "system-snapshot" }>) => void;
  onAutoStatus?: (e: Extract<SyncChannelEvent, { type: "auto-status" }>) => void;
  onTaskStatus?: (e: Extract<SyncChannelEvent, { type: "task-status" }>) => void;
  /** 系统事件注入聊天成功（brain-note）：其他 tab/入口收到后重拉会话显示系统条 */
  onBrainNote?: (e: Extract<SyncChannelEvent, { type: "brain-note" }>) => void;
  /** 卡片就地更新（card-update）：按 messageId+cardId 就地替换卡片对象，不重拉会话 */
  onCardUpdate?: (e: Extract<SyncChannelEvent, { type: "card-update" }>) => void;
  /** 卡片整体替换（card-replaced）：服务端权威翻卡（form→分镜中→完成→生成中→done/failed），按 messageId+cardIndex 整卡替换，不重拉会话 */
  onCardReplaced?: (e: Extract<SyncChannelEvent, { type: "card-replaced" }>) => void;
  /** 卡片消息追加（brain-append）：其他 tab 在会话中追加了卡片消息（preview/result 卡），重拉会话显示 */
  onBrainAppend?: (e: Extract<SyncChannelEvent, { type: "brain-append" }>) => void;
  onBrainStatus?: (e: Extract<SyncChannelEvent, { type: "brain-status" }>) => void;
  /** 连接状态变化：true=已连接，false=断线（供 UI 状态与流式 attach 恢复使用） */
  onStatusChange?: (connected: boolean) => void;
  /** 重连成功后触发（前端应做一次全量补偿 refreshAllStates） */
  onReconnected?: () => void;
};

/** 重连退避上限（ms） */
const MAX_RETRY_MS = 8000;

export function useSyncChannel(opts: UseSyncChannelOpts): {
  connected: boolean;
  requestSnapshot: () => boolean;
  syncMediaFormValues: (payload: { sessionId: string; messageId: string; cardIndex: number; values: Record<string, unknown> }) => boolean;
} {
  const { title } = opts;
  const [connected, setConnected] = useState(false);

  // 最新回调镜像：避免 effect 重建（title 变化时重连，但回调引用每次都变）
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // 每本书的 lastVersion 去重（title 切换时重置）
  const lastVersionRef = useRef<number>(0);
  const wsRef = useRef<WebSocket | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryMsRef = useRef(1000);
  const cursorRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // 登录后立即建立用户级连接；title 只控制故事订阅，不控制 socket 生命周期。
    if (typeof window === "undefined" || optsRef.current.enabled === false) {
      setConnected(false);
      return;
    }

    let closedByEffect = false;
    retryMsRef.current = 1000;

    const connect = () => {
      if (!mountedRef.current || closedByEffect) return;
      // M10 修复：换书/重连建新连接时立即重置版本基线为 0——不要等收到 subscribed 才重置。
      // 否则上一本书的高 version 会让新书 subscribed 到达前的 world-changed 事件被误判为旧版本而丢弃。
      lastVersionRef.current = 0;
      // 协议相对：wss:// over https，ws:// over http
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/sync`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleRetry();
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        // 旧连接的晚到回调不得覆盖新连接或创建第二条重连链。
        if (!mountedRef.current || closedByEffect || wsRef.current !== ws) return;
        setConnected(true);
        optsRef.current.onStatusChange?.(true);
        if (cursorRef.current > 0) ws.send(JSON.stringify({ type: "resume", cursor: cursorRef.current }));
        const selectedTitle = optsRef.current.title;
        if (selectedTitle) ws.send(JSON.stringify({ type: "subscribe", title: selectedTitle }));
        // 心跳：周期 ping 保活（服务端 60s 无消息断开，30s ping 间隔留有裕量）
        pingTimerRef.current = setInterval(() => {
          const cur = wsRef.current;
          if (cur && cur.readyState === WebSocket.OPEN) {
            try {
              cur.send(JSON.stringify({ type: "ping" }));
            } catch { /* 连接已断，onclose 处理 */ }
          }
        }, 30_000);
      };
      ws.onmessage = async (ev) => {
        if (wsRef.current !== ws) return;
        let obj: SyncChannelEvent;
        try {
          obj = JSON.parse(String(ev.data)) as SyncChannelEvent;
        } catch {
          return;
        }
        if (obj.type === "subscribed") {
          // 订阅确认：记录服务端当前版本（跳过已消费的旧版本）
          lastVersionRef.current = obj.version;
          return;
        }
        if (obj.type === "hello") {
          acceptServerInstance(obj.serverInstanceId);
          return;
        }
        if (obj.type === "library-snapshot") {
          if (typeof obj.cursor === "number") cursorRef.current = Math.max(cursorRef.current, obj.cursor);
          if (setLibrarySyncState({ ...obj.data, revision: obj.revision, hash: obj.hash }) === "conflict") requestCurrentSnapshot();
          return;
        }
        if (obj.type === "system-snapshot") {
          if (typeof obj.cursor === "number") cursorRef.current = Math.max(cursorRef.current, obj.cursor);
          const state: SystemSyncState = {
            title: obj.title, world: obj.world as SystemSyncState["world"], worldRevision: obj.worldRevision, visual: obj.visual,
            autoSession: obj.autoSession, autoPending: obj.autoPending, advanceTask: obj.advanceTask,
            proposalClosed: obj.proposalClosed ?? false,
            at: obj.at, revision: obj.revision, hash: obj.hash,
          };
          if (setSystemSyncState(state) === "conflict") { requestCurrentSnapshot(); return; }
          optsRef.current.onSystemSnapshot?.(obj);
          return;
        }
        if (obj.type === "system-invalidated") {
          // 非 world 字段（例如提案偏好）变化只发送轻量失效通知；客户端重新请求权威投影。
          requestCurrentSnapshot(obj.title);
          return;
        }
        if (obj.type === "world-changed") {
          // 版本去重：只处理比已见更新的（节流合并后 version 单调）
          if (obj.version <= lastVersionRef.current) return;
          lastVersionRef.current = obj.version;
          optsRef.current.onWorldChanged?.(obj);
          return;
        }
        if (obj.type === "auto-status") {
          optsRef.current.onAutoStatus?.(obj);
          return;
        }
        if (obj.type === "task-status") {
          optsRef.current.onTaskStatus?.(obj);
          return;
        }
        if (obj.type === "brain-note") {
          optsRef.current.onBrainNote?.(obj);
          return;
        }
        if (obj.type === "card-update") {
          optsRef.current.onCardUpdate?.(obj);
          return;
        }
        if (obj.type === "card-replaced") {
          optsRef.current.onCardReplaced?.(obj);
          return;
        }
        if (obj.type === "brain-append") {
          optsRef.current.onBrainAppend?.(obj);
          return;
        }
        if (obj.type === "brain-status") {
          if (typeof obj.cursor === "number") cursorRef.current = Math.max(cursorRef.current, obj.cursor);
          if (setBrainSyncState({ title: obj.title, sessions: obj.sessions, tasks: obj.tasks, at: obj.at, revision: obj.revision, hash: obj.hash }) === "conflict") { requestCurrentSnapshot(); return; }
          optsRef.current.onBrainStatus?.(obj);
          return;
        }
        if (obj.type === "patch") {
          if (obj.scope.startsWith("story/") && obj.scope.slice("story/".length) !== optsRef.current.title) {
            cursorRef.current = Math.max(cursorRef.current, obj.cursor);
            return;
          }
          const result = await applyProjectionPatch(obj);
          if (wsRef.current !== ws) return;
          if (result !== "accepted" && result !== "stale") {
            requestCurrentSnapshot(obj.scope === "user" ? "" : obj.scope.slice("story/".length));
            return;
          }
          cursorRef.current = Math.max(cursorRef.current, obj.cursor);
          if (result === "accepted" && obj.scope.startsWith("story/")) {
            const patchedTitle = obj.scope.slice("story/".length);
            if (obj.document === "system") {
              const state = getSystemSyncState(patchedTitle);
              if (state) optsRef.current.onSystemSnapshot?.({ type: "system-snapshot", ...state } as Extract<SyncChannelEvent, { type: "system-snapshot" }>);
            } else if (obj.document === "brain") {
              const state = getBrainSyncState(patchedTitle);
              if (state) optsRef.current.onBrainStatus?.({ type: "brain-status", ...state, full: true } as Extract<SyncChannelEvent, { type: "brain-status" }>);
            }
          }
          return;
        }
        if (obj.type === "document-changed" || obj.type === "resync-required") {
          cursorRef.current = Math.max(cursorRef.current, obj.cursor);
          requestCurrentSnapshot();
          return;
        }
        // pong / error：心跳无需处理 / 订阅失败等静默（onopen 重订阅会处理）
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
        if (closedByEffect) return;
        setConnected(false);
        optsRef.current.onStatusChange?.(false);
        scheduleRetry();
      };
      ws.onerror = () => {
        // 触发 onclose（浏览器规范）；此处无需额外处理
      };
    };

    const scheduleRetry = () => {
      if (!mountedRef.current || closedByEffect) return;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        if (!mountedRef.current || closedByEffect) return;
        connect();
        // 指数退避，上限 8s
        retryMsRef.current = Math.min(retryMsRef.current * 2, MAX_RETRY_MS);
      }, retryMsRef.current);
    };

    const requestCurrentSnapshot = (snapshotTitle = optsRef.current.title ?? "") => {
      const cur = wsRef.current;
      if (cur?.readyState === WebSocket.OPEN) cur.send(JSON.stringify({ type: "snapshot", title: snapshotTitle }));
    };

    connect();

    return () => {
      closedByEffect = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      }
      // 重连成功补偿：由 onReconnected 回调触发（若重连发生在下一次 effect 里）
    };
  }, [opts.enabled]);

  // 切书只切换同一 socket 上的故事订阅，不重建登录级连接。
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    lastVersionRef.current = 0;
    ws.send(JSON.stringify(title ? { type: "subscribe", title } : { type: "unsubscribe-story" }));
  }, [title]);

  // 监听 onReconnected 的稳定调用：重连成功由 ws.onopen 判断「是否初次连接」——
  // 初次连接(connected 由 false→true)不补偿；断线重连(connected 由 false→true 且此前连接过)才补偿。
  const hadConnectedRef = useRef(false);
  useEffect(() => {
    if (connected) {
      if (hadConnectedRef.current) {
        // 重连成功：全量补偿一次
        optsRef.current.onReconnected?.();
      }
      hadConnectedRef.current = true;
    }
  }, [connected]);

  const syncMediaFormValues = useCallback((payload: { sessionId: string; messageId: string; cardIndex: number; values: Record<string, unknown> }): boolean => {
    const ws = wsRef.current;
    if (!title || !ws || ws.readyState !== 1) return false; // 1 = WebSocket.OPEN（浏览器/Bun 标准值）
    try {
      ws.send(JSON.stringify({ type: "media-form-values", title, ...payload }));
      return true;
    } catch {
      return false;
    }
  }, [title]);

  const requestSnapshot = useCallback((): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "snapshot", title: title ?? "" }));
    return true;
  }, [title]);

  return { connected, requestSnapshot, syncMediaFormValues };
}
