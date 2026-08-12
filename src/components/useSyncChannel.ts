// 状态同步 WebSocket 客户端 hook（阶段 1b）
// - 打开书时连接 /api/sync，订阅该书频道；服务端经事件总线推送 world-changed/auto-status/task-status/brain-note
// - 鉴权：浏览器 WebSocket 不能自定义 header，握手走 httpOnly cookie（登录/注册已下发，自动携带）
// - 断线自动重连（指数退避 1s→2s→4s，上限 8s），重连成功后自动重新订阅并触发 onReconnected（前端全量补偿一次）
// - world-changed 版本去重：服务端事件已按 1s 窗口节流合并，version 单调递增；客户端只处理 version 更新的事件
// - 与 sysPoll 双跑（阶段 1 策略）：事件驱动即时刷新 + 轮询兜底校验；断线时 onStatusChange(false) 通知可启用降级
import { useCallback, useEffect, useRef, useState } from "react";

/** 事件类型（与 src/api/sync.ts SyncEvent 一致；服务端透传原样 JSON） */
export type SyncChannelEvent =
  | { type: "world-changed"; title: string; version: number; reason?: string; regions?: string[]; at: number }
  | { type: "auto-status"; title: string; status: string; phase?: string; written?: number; updatedAt?: string; at: number }
  | { type: "task-status"; title: string; kind: "build" | "advance" | "media" | "visual"; id?: string; sub?: "plan"; scenes?: { anchor: string; scene: string; caption?: string }[]; status: string; error?: string; at: number }
  | { type: "brain-note"; title: string; eventId: string; text: string; at: number }
  | { type: "card-update"; title: string; sessionId: string; messageId: string; cardId: string; patch: Record<string, unknown>; at: number }
  | { type: "card-replaced"; title: string; sessionId: string; messageId: string; cardIndex: number; card: Record<string, unknown>; at: number }
  | { type: "brain-append"; title: string; sessionId: string; messageId: string; at: number }
  | { type: "brain-status"; title: string; sessions: { id: string; sessionTitle: string; createdAt: number; streaming: boolean; updatedAt: number; messages: Record<string, unknown>[]; completed?: string[] }[]; tasks: { id: string; status: string; sub?: "plan"; error?: string; scenes?: { anchor: string; scene: string; caption?: string }[] }[]; at: number }
  | { type: "subscribed"; title: string; version: number }
  | { type: "pong" }
  | { type: "error"; error: string };

export type UseSyncChannelOpts = {
  /** 当前书 title；null/空 时不连接 */
  title: string | null;
  onWorldChanged?: (e: Extract<SyncChannelEvent, { type: "world-changed" }>) => void;
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
  /** 连接状态变化：true=已连接，false=断线（前端可据此决定降级轮询策略） */
  onStatusChange?: (connected: boolean) => void;
  /** 重连成功后触发（前端应做一次全量补偿 refreshAllStates） */
  onReconnected?: () => void;
};

/** 重连退避上限（ms） */
const MAX_RETRY_MS = 8000;

export function useSyncChannel(opts: UseSyncChannelOpts): {
  connected: boolean;
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // SSR / 无 window / 无 title：不连接
    if (typeof window === "undefined" || !title) {
      setConnected(false);
      return;
    }

    const t = title;
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
        if (!mountedRef.current || closedByEffect) return;
        setConnected(true);
        optsRef.current.onStatusChange?.(true);
        // 订阅当前书
        ws.send(JSON.stringify({ type: "subscribe", title: t }));
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
      ws.onmessage = (ev) => {
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
          optsRef.current.onBrainStatus?.(obj);
          return;
        }
        // pong / error：心跳无需处理 / 订阅失败等静默（onopen 重订阅会处理）
      };
      ws.onclose = () => {
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
  }, [title]); // 仅 title 变化重连；回调走 ref

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

  return { connected, syncMediaFormValues };
}
