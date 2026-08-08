// useBrainSession：中枢聊天多会话状态 hook
// - 会话列表（服务端持久化 data/<slug>/brain-sessions.json，title/时间/streaming 标记）
// - 多会话独立 SSE 连接：切换 tab 只改展示，不中断各自流式生成（abort 仅由「停止」/卸载触发）
// - 消息缓存 per-session：切换 tab 即时展示，回看不重复拉取
// - 挂载恢复：拉列表；打开 streaming 会话（刷新前仍在生成）自动 resume 续流至完成
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrainCard } from "./brain-cards";
import { apiFetch } from "../api/client";

export type ChatMessage = {
  id: string;
  role: "user" | "brain";
  text?: string;
  cards?: BrainCard[];
  /** 流式生成中（显示光标/停止按钮） */
  pending?: boolean;
  /** 被中断（可重新生成/编辑） */
  interrupted?: boolean;
  at: string;
};

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  messageCount: number;
};

/** 服务端会话（含消息） */
export type BrainSessionDetail = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: {
    id: string;
    role: "user" | "assistant";
    text?: string;
    cards?: BrainCard[];
    pending?: boolean;
    interrupted?: boolean;
    at: number;
  }[];
  streaming: boolean;
};

type SSEEvents = {
  onIntent?: () => void;
  onDelta?: (messageId: string, text: string) => void;
  onCard?: (messageId: string, card: BrainCard) => void;
  onDone?: (messageId: string) => void;
  onInterrupted?: (messageId: string) => void;
  onReset?: (messageId: string) => void;
  onError?: (msg: string) => void;
};

/** 会话内消息 → 展示消息（assistant → brain） */
function toDisplayMsg(m: BrainSessionDetail["messages"][number]): ChatMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "brain",
    text: m.text ?? "",
    cards: m.cards,
    pending: m.pending,
    interrupted: m.interrupted,
    at: new Date(m.at).toISOString(),
  };
}

export function useBrainSession(title: string) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false); // active 会话是否在生成
  const [thinking, setThinking] = useState(false);   // intent 阶段 loading
  const cacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // 各会话独立 AbortController：切换 tab 不打断（仅「停止」/卸载/删除 abort）
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const loadedTitleRef = useRef("");

  /** 拉取会话列表（挂载/新建/删除/回合结束后刷新） */
  const refreshList = useCallback(async () => {
    try {
      const res = await apiFetch("/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { sessions?: SessionMeta[] };
      setSessions(data.sessions ?? []);
    } catch { /* 网络异常静默 */ }
  }, [title]);

  /** 更新某会话消息缓存；active 会话同步展示 */
  const patchMsg = useCallback((sessionId: string, messageId: string, patch: Partial<ChatMessage>) => {
    const arr = cacheRef.current.get(sessionId);
    if (!arr) return;
    const next = arr.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
    cacheRef.current.set(sessionId, next);
    if (sessionId === activeId) setMessages(next);
  }, [activeId]);

  const patchStreaming = useCallback((sessionId: string, on: boolean) => {
    if (sessionId === activeId) setStreaming(on);
  }, [activeId]);

  const setThinkingFor = useCallback((sessionId: string, on: boolean) => {
    if (sessionId === activeId) setThinking(on);
  }, [activeId]);

  /** 会话最后一条 assistant 消息（按展示缓存取） */
  function lastMsgOf(sessionId: string): ChatMessage | undefined {
    const arr = cacheRef.current.get(sessionId);
    return arr && arr.length ? arr[arr.length - 1] : undefined;
  }

  /**
   * 向会话发起一轮生成（或 resume 续流）：
   * - 各会话独立连接：切换 tab 后 onDelta 仍更新缓存（后台继续跑，不打断）
   * - resume：本地不追加消息（服务端复用未完成消息，先 reset 再重新流式）
   */
  const send = useCallback(async (opts: { prompt: string; sessionId: string; resume?: boolean }) => {
    const { prompt, sessionId, resume } = opts;
    if (!prompt.trim() || abortRef.current.has(sessionId)) return; // 该会话正在生成
    const ctrl = new AbortController();
    abortRef.current.set(sessionId, ctrl);
    patchStreaming(sessionId, true);
    setThinkingFor(sessionId, true);

    if (!resume) {
      const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", text: prompt, at: new Date().toISOString() };
      const brainMsg: ChatMessage = { id: crypto.randomUUID(), role: "brain", text: "", cards: [], pending: true, at: new Date().toISOString() };
      const arr = cacheRef.current.get(sessionId) ?? [];
      arr.push(userMsg, brainMsg);
      cacheRef.current.set(sessionId, arr);
      if (sessionId === activeId) setMessages([...arr]);
    }

    const events: SSEEvents = {
      onIntent: () => setThinkingFor(sessionId, false),
      onDelta: (messageId, text) => {
        setThinkingFor(sessionId, false);
        patchMsg(sessionId, messageId, { text, interrupted: false });
      },
      onCard: (messageId, card) => {
        setThinkingFor(sessionId, false);
        const arr = cacheRef.current.get(sessionId);
        if (!arr) return;
        const next = arr.map((m) => (m.id === messageId ? { ...m, cards: [...(m.cards ?? []), card] } : m));
        cacheRef.current.set(sessionId, next);
        if (sessionId === activeId) setMessages(next);
      },
      onDone: (messageId) => patchMsg(sessionId, messageId, { pending: false, interrupted: false }),
      onInterrupted: (messageId) => patchMsg(sessionId, messageId, { pending: false, interrupted: true }),
      onReset: (messageId) => patchMsg(sessionId, messageId, { text: "", cards: [], interrupted: false, pending: true }),
      onError: (msg) => {
        const last = lastMsgOf(sessionId);
        if (last) patchMsg(sessionId, last.id, { text: `（${msg}）`, pending: false, interrupted: true });
      },
    };

    try {
      const res = await apiFetch("/api/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, sessionId, resume: resume ?? false }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("对话失败");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let obj: { type?: string; messageId?: string; text?: string; card?: BrainCard; error?: string };
            try { obj = JSON.parse(line.slice(6)); } catch { continue; }
            if (obj.error) { events.onError?.(obj.error); continue; }
            switch (obj.type) {
              case "intent": events.onIntent?.(); break;
              case "delta": if (obj.messageId && obj.text != null) events.onDelta?.(obj.messageId, obj.text); break;
              case "card": if (obj.messageId && obj.card) events.onCard?.(obj.messageId, obj.card); break;
              case "done": if (obj.messageId) events.onDone?.(obj.messageId); break;
              case "interrupted": if (obj.messageId) events.onInterrupted?.(obj.messageId); break;
              case "reset": if (obj.messageId) events.onReset?.(obj.messageId); break;
              default: /* ping 忽略 */
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (e) {
      const last = lastMsgOf(sessionId);
      if (last) {
        if ((e as Error).name === "AbortError") patchMsg(sessionId, last.id, { pending: false, interrupted: true });
        else patchMsg(sessionId, last.id, { text: `（${(e as Error).message}）`, pending: false, interrupted: true });
      }
    } finally {
      abortRef.current.delete(sessionId);
      patchStreaming(sessionId, false);
      setThinkingFor(sessionId, false);
      void refreshList(); // 更新会话列表（标题/时间/streaming 标记）
    }
  }, [title, activeId, patchMsg, patchStreaming, setThinkingFor, refreshList]);

  /** 展示某会话（缓存命中即时；未命中从服务端拉详情；streaming 会话自动 resume 续流） */
  const openSession = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages(cacheRef.current.get(id) ?? []);
    setStreaming(abortRef.current.has(id));
    if (cacheRef.current.has(id)) return; // 已有缓存：即时展示，不重复拉取/续流
    try {
      const res = await apiFetch("/api/brain/sessions/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { session?: BrainSessionDetail };
      if (!data.session) return;
      const msgs = data.session.messages.map(toDisplayMsg);
      cacheRef.current.set(id, msgs);
      setMessages(msgs);
      const running = data.session.streaming || abortRef.current.has(id);
      setStreaming(running);
      // 刷新恢复：该会话仍在生成（或最后消息未完成）→ 自动 resume 续流至完成
      const last = msgs[msgs.length - 1];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (last && last.role === "brain" && (last.pending || last.interrupted) && lastUser && !abortRef.current.has(id)) {
        void send({ prompt: lastUser.text ?? "", sessionId: id, resume: true });
      }
    } catch { /* 静默 */ }
  }, [title, send]);

  /** 新建会话（前端预生成 id，服务端按 id 创建；可带首条 prompt） */
  const newSession = useCallback(async (firstPrompt?: string) => {
    const id = crypto.randomUUID();
    try {
      const res = await apiFetch("/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id, prompt: firstPrompt ?? "" }),
      });
      if (!res.ok) return id;
      await refreshList();
    } catch { /* 静默 */ }
    await openSession(id);
    return id;
  }, [title, refreshList, openSession]);

  /** 删除会话（含运行中的：先 abort 其 SSE） */
  const removeSession = useCallback(async (id: string) => {
    abortRef.current.get(id)?.abort();
    abortRef.current.delete(id);
    cacheRef.current.delete(id);
    try {
      await apiFetch("/api/brain/sessions/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id }),
      });
    } catch { /* 静默 */ }
    await refreshList();
    if (activeId === id) {
      setActiveId("");
      setMessages([]);
      setStreaming(false);
    }
  }, [title, activeId, refreshList]);

  /** 截断会话到指定消息（编辑重发前置）：服务端 + 本地缓存同步删该消息及其后 */
  const truncate = useCallback(async (id: string, messageId: string) => {
    abortRef.current.get(id)?.abort(); // 截断前停掉该会话进行中的生成
    abortRef.current.delete(id);
    try {
      await apiFetch("/api/brain/sessions/truncate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id, messageId }),
      });
    } catch { /* 静默 */ }
    const arr = cacheRef.current.get(id);
    if (arr) {
      const idx = arr.findIndex((m) => m.id === messageId);
      if (idx >= 0) {
        const next = arr.slice(0, idx);
        cacheRef.current.set(id, next);
        if (id === activeId) setMessages(next);
      }
    }
    void refreshList();
  }, [title, activeId, refreshList]);

  /** 纯追加一条展示消息（卡片执行结果等，不触发 SSE） */
  const appendMsg = useCallback((id: string, msg: ChatMessage) => {
    const arr = cacheRef.current.get(id) ?? [];
    arr.push(msg);
    cacheRef.current.set(id, arr);
    if (id === activeId) setMessages([...arr]);
  }, [activeId]);

  /** 停止 active 会话生成 */
  const stop = useCallback(() => {
    abortRef.current.get(activeId)?.abort();
  }, [activeId]);

  /** 挂载/切换书时恢复：清缓存 → 拉列表 → 打开最近会话（streaming 会话由 openSession 自动续流） */
  useEffect(() => {
    if (loadedTitleRef.current === title) return;
    loadedTitleRef.current = title;
    cacheRef.current.clear();
    abortRef.current.clear();
    setActiveId("");
    setMessages([]);
    setStreaming(false);
    void (async () => {
      await refreshList();
      const list = (await apiFetch("/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) as { sessions?: SessionMeta[] } | null;
      const latest = list?.sessions?.[0];
      if (latest) await openSession(latest.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  return {
    sessions,
    activeId,
    messages,
    streaming,
    thinking,
    openSession,
    newSession,
    removeSession,
    truncate,
    appendMsg,
    send,
    stop,
    refreshList,
    isStreaming: (id: string) => abortRef.current.has(id),
  };
}
