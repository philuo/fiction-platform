// useBrainSession：中枢聊天多会话状态 hook
// - 会话列表（服务端持久化 data/<slug>/brain-sessions.json，title/时间/streaming 标记）
// - 多会话独立 SSE 连接：切换 tab 只改展示，不中断各自流式生成（abort 仅由「停止」/卸载触发）
// - 消息缓存 per-session：切换 tab 即时展示，回看不重复拉取
// - 挂载恢复：拉列表；打开 streaming 会话（刷新前仍在生成）自动 resume 续流至完成
// - activeIdRef：修复 stale closure——async 流程（newSession→send）内用旧渲染闭包时，
//   「是否当前会话」判断读 ref 而非闭包捕获的 state，保证首次发送立即展示
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
  /** text：服务端重放已生成文本（attach 恢复时携带，前端保留而非清空，避免已回复内容闪没） */
  onReset?: (messageId: string, text?: string) => void;
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
  // 最新 activeId 镜像：async 流程（newSession→send 首次对话）中旧渲染闭包也能读到当前值
  const activeIdRef = useRef("");

  /** 设置当前会话：同步 state + ref（ref 供陈旧闭包内的「是否当前」判断） */
  function setActive(id: string) {
    activeIdRef.current = id;
    setActiveId(id);
  }

  /** 拉取会话列表（挂载/新建/删除/回合结束后刷新） */
  const refreshList = useCallback(async (): Promise<SessionMeta[]> => {
    try {
      const res = await apiFetch("/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { sessions?: SessionMeta[] };
      const list = data.sessions ?? [];
      setSessions(list);
      return list;
    } catch { /* 网络异常静默 */ return []; }
  }, [title]);

  /** 更新某会话消息缓存；active 会话同步展示 */
  const patchMsg = useCallback((sessionId: string, messageId: string, patch: Partial<ChatMessage>) => {
    const arr = cacheRef.current.get(sessionId);
    if (!arr) return;
    const next = arr.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
    cacheRef.current.set(sessionId, next);
    if (sessionId === activeIdRef.current) setMessages(next);
  }, []);

  const patchStreaming = useCallback((sessionId: string, on: boolean) => {
    if (sessionId === activeIdRef.current) setStreaming(on);
  }, []);

  const setThinkingFor = useCallback((sessionId: string, on: boolean) => {
    if (sessionId === activeIdRef.current) setThinking(on);
  }, []);

  /** 会话最后一条 assistant 消息（按展示缓存取） */
  function lastMsgOf(sessionId: string): ChatMessage | undefined {
    const arr = cacheRef.current.get(sessionId);
    return arr && arr.length ? arr[arr.length - 1] : undefined;
  }

  /**
   * 对齐消息 id（需求 3 根因修复）：非 resume 首发时，前端预创建的 brain 槽位 id 用前端 randomUUID，
   * 而服务端广播的 delta/card/done 携带服务端生成的 messageId——两者不一致会导致 delta 全部不匹配、
   * 消息永久 pending 空文本（"AI 已回复但一直 loading，刷新才可见"）。
   * 收到带服务端 messageId 的事件时，若缓存无此 id 且存在 pending 的 brain 槽位，则将该槽位重命名为
   * 服务端 messageId（后续 delta/done 即可命中）；resume/回看场景缓存里已有服务端 id，直接命中不重命名。
   */
  const alignMsgId = useCallback((sessionId: string, messageId: string): string => {
    const arr = cacheRef.current.get(sessionId);
    if (!arr || arr.some((m) => m.id === messageId)) return messageId;
    const slot = [...arr].reverse().find((m) => m.role === "brain" && m.pending);
    if (slot && !slot.interrupted) {
      slot.id = messageId;
      cacheRef.current.set(sessionId, arr);
      if (sessionId === activeIdRef.current) setMessages([...arr]);
    }
    return messageId;
  }, []);

  /**
   * 向会话发起一轮生成（或 resume 续流）：
   * - 各会话独立连接：切换 tab 后 onDelta 仍更新缓存（后台继续跑，不打断）
   * - resume：本地不追加消息（服务端复用未完成消息，先 reset 再重新流式）
   * - ctx：前端上下文（左侧栏选中章等），供服务端意图识别参数提取兜底（需求 1/2）
   */
  const send = useCallback(async (opts: { prompt: string; sessionId: string; resume?: boolean; ctx?: { chapterIndex?: number | null } }) => {
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
      // 用 ref 判断：首次对话 newSession 后才 setActive，此处闭包可能仍是旧渲染，必须读最新值
      if (sessionId === activeIdRef.current) setMessages([...arr]);
    }

    const events: SSEEvents = {
      onIntent: () => setThinkingFor(sessionId, false),
      onDelta: (messageId, text) => {
        setThinkingFor(sessionId, false);
        patchMsg(sessionId, alignMsgId(sessionId, messageId), { text, interrupted: false });
      },
      onCard: (messageId, card) => {
        setThinkingFor(sessionId, false);
        const mid = alignMsgId(sessionId, messageId);
        const arr = cacheRef.current.get(sessionId);
        if (!arr) return;
        const next = arr.map((m) => (m.id === mid ? { ...m, cards: [...(m.cards ?? []), card] } : m));
        cacheRef.current.set(sessionId, next);
        if (sessionId === activeIdRef.current) setMessages(next);
      },
      onDone: (messageId) => { setThinkingFor(sessionId, false); patchMsg(sessionId, alignMsgId(sessionId, messageId), { pending: false, interrupted: false }); },
      onInterrupted: (messageId) => { setThinkingFor(sessionId, false); patchMsg(sessionId, alignMsgId(sessionId, messageId), { pending: false, interrupted: true }); },
      // 保留服务端重放文本：attach 恢复/resume 重放时不闪没已生成内容，后续 delta 在其上继续累积
      onReset: (messageId, text) => {
        setThinkingFor(sessionId, false);
        patchMsg(sessionId, alignMsgId(sessionId, messageId), { text: text ?? "", cards: [], interrupted: false, pending: true });
      },
      onError: (msg) => {
        const last = lastMsgOf(sessionId);
        if (last) patchMsg(sessionId, last.id, { text: `（${msg}）`, pending: false, interrupted: true });
      },
    };

    try {
      const res = await apiFetch("/api/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, sessionId, resume: resume ?? false, ctx: opts.ctx }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("对话失败");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // 空闲兜底：长时间（360s）无任何 SSE 事件 → 视为连接悬挂，主动中止（服务端任务经 req.signal abort 停止）
      let lastEventAt = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastEventAt > 360_000) ctrl.abort();
      }, 30_000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            lastEventAt = Date.now(); // ping 等任意事件均视为连接存活
            let obj: { type?: string; messageId?: string; text?: string; card?: BrainCard; error?: string };
            try { obj = JSON.parse(line.slice(6)); } catch { continue; }
            if (obj.error) { events.onError?.(obj.error); continue; }
            switch (obj.type) {
              case "intent": events.onIntent?.(); break;
              case "delta": if (obj.messageId && obj.text != null) events.onDelta?.(obj.messageId, obj.text); break;
              case "card": if (obj.messageId && obj.card) events.onCard?.(obj.messageId, obj.card); break;
              case "done": if (obj.messageId) events.onDone?.(obj.messageId); break;
              case "interrupted": if (obj.messageId) events.onInterrupted?.(obj.messageId); break;
              case "reset": if (obj.messageId) events.onReset?.(obj.messageId, obj.text); break;
              default: /* ping 忽略 */
            }
          }
        }
      } finally {
        clearInterval(idleTimer);
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
      // 兜底：流已结束但本地缓存仍 pending（done 事件在连接收尾期丢失/未送达）
      // → 查服务端最终状态并同步，避免"AI 已回复但一直 loading，需刷新才可见"（需求 3）
      const last = lastMsgOf(sessionId);
      if (last && last.pending) {
        void (async () => {
          try {
            const r = await apiFetch("/api/brain/sessions/detail", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, id: sessionId }),
            });
            if (!r.ok) return;
            const d = (await r.json()) as { session?: BrainSessionDetail };
            const serverLast = d.session?.messages[d.session.messages.length - 1];
            if (serverLast && serverLast.id === last.id && !serverLast.pending) {
              patchMsg(sessionId, last.id, serverLast.interrupted
                ? { pending: false, interrupted: true }
                : { pending: false, interrupted: false });
            }
          } catch { /* 网络异常：保持现状，下次打开会话会从服务端拉取最新状态 */ }
        })();
      }
      void refreshList(); // 更新会话列表（标题/时间/streaming 标记）
    }
  }, [title, patchMsg, patchStreaming, setThinkingFor, refreshList, alignMsgId]);

  /** 展示某会话（缓存命中即时；未命中从服务端拉详情；streaming 会话自动 resume 续流）。
   *  ctx：resume 续流时透传前端上下文（选中章），供服务端意图识别参数提取兜底（需求 1/2）。 */
  const openSession = useCallback(async (id: string, ctx?: { chapterIndex?: number | null }) => {
    setActive(id);
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
      // 刷新恢复：该会话仍在生成（最后消息 pending，刷新前未完成）→ 自动 resume 续流至完成
      // 注意：interrupted（用户主动中断）不自动续流——重新生成应由用户点「重新生成」按钮触发，
      // 否则每次打开弹窗/切换会话都会意外发起聊天请求。
      const last = msgs[msgs.length - 1];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (last && last.role === "brain" && last.pending && lastUser && !abortRef.current.has(id)) {
        void send({ prompt: lastUser.text ?? "", sessionId: id, resume: true, ctx });
      }
    } catch { /* 静默 */ }
  }, [title, send]);

  /**
   * 新建会话（前端预生成 id，服务端按 id 创建；可带首条 prompt）。
   * 无 prompt（如「+」新建按钮）→ 不创建会话，仅清空当前视图（空态），
   * 等用户发出第一条消息时 doSend 自动创建并绑定——符合「初始无会话，首条消息时创建」。
   */
  const newSession = useCallback(async (firstPrompt?: string) => {
    if (!firstPrompt?.trim()) {
      setActive("");
      setMessages([]);
      setStreaming(false);
      setThinking(false);
      return "";
    }
    const id = crypto.randomUUID();
    try {
      const res = await apiFetch("/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id, prompt: firstPrompt }),
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
    if (activeIdRef.current === id) {
      setActive("");
      setMessages([]);
      setStreaming(false);
    }
  }, [title, refreshList]);

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
        if (id === activeIdRef.current) setMessages(next);
      }
    }
    void refreshList();
  }, [title, refreshList]);

  /** 纯追加一条展示消息（卡片执行结果等，不触发 SSE） */
  const appendMsg = useCallback((id: string, msg: ChatMessage) => {
    const arr = cacheRef.current.get(id) ?? [];
    arr.push(msg);
    cacheRef.current.set(id, arr);
    if (id === activeIdRef.current) setMessages([...arr]);
  }, []);

  /** 停止 active 会话生成 */
  const stop = useCallback(() => {
    abortRef.current.get(activeIdRef.current)?.abort();
  }, []);

  /** 挂载/切换书时恢复：清缓存 → 拉列表 → 打开最近会话（streaming 会话由 openSession 自动续流） */
  useEffect(() => {
    if (loadedTitleRef.current === title) return;
    loadedTitleRef.current = title;
    cacheRef.current.clear();
    abortRef.current.clear();
    setActive("");
    setMessages([]);
    setStreaming(false);
    void (async () => {
      const list = await refreshList();
      const latest = list[0];
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
