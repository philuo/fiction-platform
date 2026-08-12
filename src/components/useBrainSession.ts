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
import { cachePutSession, cacheClearBook, cacheGetSession } from "./brainCache";
import { uuid } from "../shared/uuid";

export type ChatMessage = {
  id: string;
  role: "user" | "brain";
  text?: string;
  /** DeepSeek 思维链内容（思考模式开启时流式累积，与正文分离）；折叠展示 */
  thinking?: string;
  cards?: BrainCard[];
  /** 流式生成中（显示光标/停止按钮） */
  pending?: boolean;
  /** 被中断（可重新生成/编辑） */
  interrupted?: boolean;
  /** 系统事件消息（kind="system"）：系统状态变化自动注入，前端灰色系统条渲染 */
  kind?: "system";
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

export type BrainSyncSession = {
  id: string;
  sessionTitle: string;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  messages: BrainSessionDetail["messages"];
  completed?: string[];
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
    thinking?: string;
    cards?: BrainCard[];
    pending?: boolean;
    interrupted?: boolean;
    kind?: "system";
    at: number;
  }[];
  streaming: boolean;
  /** 已执行的卡片操作 key（`消息id:卡片下标[:列表项id]`）：刷新后恢复完成态（防重复提交） */
  completed?: string[];
};

type SSEEvents = {
  onIntent?: () => void;
  /** append=true：增量块（前端拼接）；缺省：替换（单次全量，如 plan/opinion 回复） */
  onDelta?: (messageId: string, text: string, append?: boolean) => void;
  /** 思维链增量（DeepSeek reasoning_content，思考模式开启时）：与正文 delta 分离，折叠展示 */
  onReasoning?: (messageId: string, text: string, append?: boolean) => void;
  onCard?: (messageId: string, card: BrainCard) => void;
  onDone?: (messageId: string) => void;
  onInterrupted?: (messageId: string) => void;
  /** text：服务端重放已生成文本（attach 恢复时携带，前端保留而非清空，避免已回复内容闪没） */
  onReset?: (messageId: string, text?: string, thinking?: string) => void;
  /** messageId：服务端 error 事件携带时精确落到对应消息；缺省回退会话最后一条消息 */
  onError?: (msg: string, messageId?: string) => void;
};

/** 会话内消息 → 展示消息（assistant → brain） */
function toDisplayMsg(m: BrainSessionDetail["messages"][number]): ChatMessage {
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "brain",
    text: m.text ?? "",
    thinking: m.thinking,
    cards: m.cards,
    pending: m.pending,
    interrupted: m.interrupted,
    kind: m.kind,
    at: new Date(m.at).toISOString(),
  };
}

export function useBrainSession(title: string) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false); // active 会话是否在生成
  const [thinking, setThinking] = useState(false);   // intent 阶段 loading
  const [reconnecting, setReconnecting] = useState(false); // SSE 断线自动重连中（UI 显示重连徽章）
  const cacheRef = useRef<Map<string, ChatMessage[]>>(new Map());
  // 各会话独立 AbortController：切换 tab 不打断（仅「停止」/卸载/删除 abort）
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const loadedTitleRef = useRef("");
  // 最新 activeId 镜像：async 流程（newSession→send 首次对话）中旧渲染闭包也能读到当前值
  const activeIdRef = useRef("");
  /** 各会话已执行的卡片操作 key（`消息id:卡片下标[:列表项id]`）——服务端持久化，刷新后恢复完成态 */
  const completedRef = useRef<Map<string, Set<string>>>(new Map());
  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());

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
  const send = useCallback(async (opts: { prompt: string; sessionId: string; resume?: boolean; thinking?: boolean; ctx?: {
    chapterIndex?: number | null;
    chapterTitle?: string | null;
    chapterStatus?: string | null;
    chapterWords?: number | null;
    versionCount?: number | null;
    systemStatus?: string | null;
    writingRunning?: boolean;
    presence?: string | null;
    activity?: string | null;
    autoRunning?: boolean;
    server?: Record<string, unknown>;
  } }) => {
    const { prompt, sessionId, resume } = opts;
    if (!prompt.trim() || abortRef.current.has(sessionId)) return; // 该会话正在生成
    const ctrl = new AbortController();
    abortRef.current.set(sessionId, ctrl);
    patchStreaming(sessionId, true);
    setThinkingFor(sessionId, true);
    if (sessionId === activeIdRef.current) setReconnecting(false); // 新回合起步清重连态

    if (!resume) {
      const userMsg: ChatMessage = { id: uuid(), role: "user", text: prompt, at: new Date().toISOString() };
      const brainMsg: ChatMessage = { id: uuid(), role: "brain", text: "", cards: [], pending: true, at: new Date().toISOString() };
      const arr = cacheRef.current.get(sessionId) ?? [];
      arr.push(userMsg, brainMsg);
      cacheRef.current.set(sessionId, arr);
      // 用 ref 判断：首次对话 newSession 后才 setActive，此处闭包可能仍是旧渲染，必须读最新值
      if (sessionId === activeIdRef.current) setMessages([...arr]);
    }

    const events: SSEEvents = {
      onIntent: () => setThinkingFor(sessionId, false),
      onDelta: (messageId, text, append) => {
        setThinkingFor(sessionId, false);
        const mid = alignMsgId(sessionId, messageId);
        const arr = cacheRef.current.get(sessionId);
        if (!arr) return;
        const next = arr.map((m) => (m.id === mid ? { ...m, text: append ? (m.text ?? "") + text : text, interrupted: false } : m));
        cacheRef.current.set(sessionId, next);
        if (sessionId === activeIdRef.current) setMessages(next);
      },
      onReasoning: (messageId, text, append) => {
        const mid = alignMsgId(sessionId, messageId);
        const arr = cacheRef.current.get(sessionId);
        if (!arr) return;
        const next = arr.map((m) => (m.id === mid ? { ...m, thinking: append ? (m.thinking ?? "") + text : text } : m));
        cacheRef.current.set(sessionId, next);
        if (sessionId === activeIdRef.current) setMessages(next);
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
      onReset: (messageId, text, thinking) => {
        setThinkingFor(sessionId, false);
        patchMsg(sessionId, alignMsgId(sessionId, messageId), { text: text ?? "", thinking: thinking ?? "", cards: [], interrupted: false, pending: true });
      },
      // error 优先按服务端 messageId 精确定位（并发/attach 多连接场景不错标到别的消息）；缺省回退最后一条
      onError: (msg, messageId) => {
        if (messageId) {
          patchMsg(sessionId, alignMsgId(sessionId, messageId), { text: `（${msg}）`, pending: false, interrupted: true });
          return;
        }
        const last = lastMsgOf(sessionId);
        if (last) patchMsg(sessionId, last.id, { text: `（${msg}）`, pending: false, interrupted: true });
      },
    };

    /** 单次连接：POST /api/brain/chat 并读完整条 SSE 流；正常读到 EOF 返回 true */
    const connectOnce = async (attempt: number): Promise<{ events: number }> => {
      // attempt>0 为断线重连：attach-only（只挂已运行任务，任务结束则快速 EOF），绝不发起新回合（防重复生成）
      const isRetry = attempt > 0;
      if (isRetry && sessionId === activeIdRef.current) setReconnecting(true);
      let eventCount = 0; // 收到的事件数：attach 若 0 事件即 EOF = 服务端无运行中任务
      const res = await apiFetch("/api/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, prompt, sessionId, resume: resume ?? false, attach: isRetry, thinking: opts.thinking ?? false, ctx: opts.ctx }),
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
            let obj: { type?: string; messageId?: string; text?: string; thinking?: string; card?: BrainCard; error?: string; append?: boolean };
            try { obj = JSON.parse(line.slice(6)); } catch { continue; }
            eventCount++;
            if (obj.error) { events.onError?.(obj.error, obj.messageId); continue; }
            if (sessionId === activeIdRef.current) setReconnecting(false); // 收到任意事件 = 连接恢复
            switch (obj.type) {
              case "intent": events.onIntent?.(); break;
              case "delta": if (obj.messageId && obj.text != null) events.onDelta?.(obj.messageId, obj.text, obj.append === true); break;
              case "reasoning": if (obj.messageId && obj.text != null) events.onReasoning?.(obj.messageId, obj.text, obj.append === true); break;
              case "card": if (obj.messageId && obj.card) events.onCard?.(obj.messageId, obj.card); break;
              case "done": if (obj.messageId) events.onDone?.(obj.messageId); break;
              case "interrupted": if (obj.messageId) events.onInterrupted?.(obj.messageId); break;
              case "reset": if (obj.messageId) events.onReset?.(obj.messageId, obj.text, obj.thinking); break;
              default: /* ping 忽略 */
            }
          }
        }
        return { events: eventCount };
      } finally {
        clearInterval(idleTimer);
        reader.cancel().catch(() => {});
      }
    };

    // 断线自动重连（网络瞬时抖动）：非用户中断的错误 → 以 attach 模式重试（最多 MAX_ATTACH_RETRY 次，间隔递增）。
    // 服务端任务不因连接断开而终止，重连即续收剩余 delta；任务已结束则 attach 快速 EOF → finally 查 detail 兜底同步
    const MAX_ATTACH_RETRY = 2;
    try {
      let attempt = 0;
      for (;;) {
        try {
          const r = await connectOnce(attempt);
          // attach 连接成功但服务端无运行中任务（0 事件即 EOF）且最后消息仍 pending：
          // 首连很可能在请求到达服务端前就失败、任务从未创建 → 明确回显错误，避免永久 loading
          if (attempt > 0 && r.events === 0) {
            const last = lastMsgOf(sessionId);
            if (last && last.pending) patchMsg(sessionId, last.id, { text: "（连接中断，未完成恢复，请重试）", pending: false, interrupted: true });
          }
          break; // 正常读完（含 attach EOF）：交给 finally 兜底核对最终状态
        } catch (e) {
          const aborted = ctrl.signal.aborted || (e as Error).name === "AbortError";
          if (aborted) {
            // 用户停止 / 空闲超时：标记中断（保留已生成文本）
            const last = lastMsgOf(sessionId);
            if (last) patchMsg(sessionId, last.id, { pending: false, interrupted: true });
            break;
          }
          if (attempt >= MAX_ATTACH_RETRY) {
            // 重试耗尽：保留已生成文本并标记中断，回显错误
            const last = lastMsgOf(sessionId);
            if (last) patchMsg(sessionId, last.id, { text: `（${(e as Error).message}）`, pending: false, interrupted: true });
            break;
          }
          attempt++;
          if (ctrl.signal.aborted) break; // 等待退避期间用户停止：立即退出
          await new Promise<void>((r) => setTimeout(r, 800 * attempt)); // 1s、2s 递增退避
        }
      }
    } finally {
      abortRef.current.delete(sessionId);
      patchStreaming(sessionId, false);
      setThinkingFor(sessionId, false);
      if (sessionId === activeIdRef.current) setReconnecting(false);
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
      // Phase 4：回合结束把最终消息快照写回 indexeddb 缓存（服务端持久化 + 客户端缓存双写）
      const arr = cacheRef.current.get(sessionId);
      if (arr?.length) {
        const comp = completedRef.current.get(sessionId);
        void cachePutSession(title, sessionId, arr, comp ? [...comp] : []);
      }
      void refreshList(); // 更新会话列表（标题/时间/streaming 标记）
    }
  }, [title, patchMsg, patchStreaming, setThinkingFor, refreshList, alignMsgId]);

  /** 展示某会话（缓存命中即时；未命中从服务端拉详情；streaming 会话自动 resume 续流）。
   *  ctx：resume 续流时透传前端上下文（选中章），供服务端意图识别参数提取兜底（需求 1/2）。
   *  force=true：强制重拉详情并覆盖缓存（系统事件注入/外部状态变化后同步最新消息，跳过缓存短路）。 */
  const openSession = useCallback(async (id: string, ctx?: {
    chapterIndex?: number | null;
    chapterTitle?: string | null;
    chapterStatus?: string | null;
    chapterWords?: number | null;
    versionCount?: number | null;
    systemStatus?: string | null;
    writingRunning?: boolean;
    presence?: string | null;
    activity?: string | null;
    autoRunning?: boolean;
    server?: Record<string, unknown>;
  }, force?: boolean) => {
    setActive(id);
    setMessages(cacheRef.current.get(id) ?? []);
    setStreaming(abortRef.current.has(id));
    setCompleted(completedRef.current.get(id) ?? new Set()); // 本会话已有完成记录：立即恢复
    if (!force && cacheRef.current.has(id)) return; // 已有内存缓存：即时展示，不重复拉取/续流
    // C5 修复：内存缓存未命中时，并行读 indexeddb 缓存（首屏秒开）+ 拉服务端 detail（权威覆盖）。
    // 不 await 缓存读取——网络请求立即发起不被阻塞；缓存先到先渲染，网络回来后无条件覆盖（服务端最新为准，
    // 旧缓存不会永久覆盖新数据）。切换会话/网络已抢先填充内存缓存时放弃本次缓存渲染。
    if (!force) {
      void cacheGetSession(title, id).then((cached) => {
        if (!cached || cacheRef.current.has(id) || activeIdRef.current !== id) return;
        cacheRef.current.set(id, cached.msgs);
        completedRef.current.set(id, new Set(cached.completed));
        setMessages(cached.msgs);
        setCompleted(new Set(cached.completed));
      });
    }
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
      // 刷新恢复：completed 来自服务端持久化（卡片操作完成态跨刷新保持）
      completedRef.current.set(id, new Set(data.session.completed ?? []));
      setCompleted(completedRef.current.get(id) ?? new Set());
      setMessages(msgs);
      // Phase 4：服务端权威快照写回 indexeddb 缓存（下次打开秒开；服务端始终最新，覆盖即一致）
      void cachePutSession(title, id, msgs, [...(completedRef.current.get(id) ?? [])]);
      const running = data.session.streaming || abortRef.current.has(id);
      setStreaming(running);
      // 刷新恢复：该会话仍在生成（最后消息 pending，刷新前未完成）→ 自动 resume 续流至完成
      // 注意：interrupted（用户主动中断）不自动续流——重新生成应由用户点「重新生成」按钮触发，
      // 否则每次打开弹窗/切换会话都会意外发起聊天请求。
      const last = msgs[msgs.length - 1];
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (!force && last && last.role === "brain" && last.pending && lastUser && !abortRef.current.has(id)) {
        void send({ prompt: lastUser.text ?? "", sessionId: id, resume: true, ctx });
      }
    } catch { /* 静默 */ }
  }, [title, send]);

  /** 强制重拉当前 active 会话详情（系统事件注入到最近会话后，聊天舱实时同步显示） */
  const reloadActive = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    await openSession(id, undefined, true);
  }, [openSession]);

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
      setCompleted(new Set());
      return "";
    }
    const id = uuid();
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
    completedRef.current.delete(id);
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
      setCompleted(new Set());
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

  /** 追加一条卡片消息（preview/result 卡等）并持久化到服务端会话：
   *  本地即时展示 + POST /api/brain/sessions/append 落盘（刷新后卡片消息不丢失，会话记录完整）；
   *  服务端广播 brain-append → 其他 tab 重拉会话（多 tab 一致）。POST 失败静默——仅影响刷新恢复，不阻塞操作。 */
  const appendCard = useCallback(async (sessionId: string, msg: ChatMessage) => {
    appendMsg(sessionId, msg);
    try {
      await apiFetch("/api/brain/sessions/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sessionId, message: msg }),
      });
    } catch { /* 静默：持久化失败仅影响刷新恢复 */ }
  }, [title, appendMsg]);

  /** 就地更新某消息内指定卡片（阶段 3a）：按 cardId 替换卡片对象，不重拉会话。
   *  由 useSyncChannel 的 card-update 事件驱动（多 tab 一致）；命中返回 true。 */
  const patchCard = useCallback((sessionId: string, messageId: string, cardId: string, patch: Record<string, unknown>): boolean => {
    const arr = cacheRef.current.get(sessionId);
    if (!arr) return false;
    let hit = false;
    const next = arr.map((m) => {
      if (m.id !== messageId || !m.cards?.length) return m;
      const cards = m.cards.map((c) => {
        if (hit || (c as { cardId?: string }).cardId !== cardId) return c;
        hit = true;
        return { ...c, ...patch, cardId } as typeof c; // 保留 cardId
      });
      return { ...m, cards };
    });
    if (!hit) return false;
    cacheRef.current.set(sessionId, next);
    if (sessionId === activeIdRef.current) setMessages(next);
    return true;
  }, []);

  /** 就地替换某消息内指定下标的卡片（阶段 3b：媒体生成 form→preview 单面板流转）。
   *  按「消息内下标」整体替换（含 kind/action 变更——patchCard 只能合并字段，无法改变卡片类型）。
   *  本地即时替换 + POST /api/brain/sessions/replace-card 落盘（刷新后保持单面板状态）；
   *  POST 失败静默——仅影响刷新恢复，不阻塞操作。
   *  persist=false（如「分镜中」这类同步请求的中间态）：仅本地替换不落盘——分镜无服务端任务记录，
   *  落盘后刷新/断线无恢复机制会永久悬死（与 patchMediaTaskStatus 对 running 中间态不落盘的原则一致）。 */
  const replaceCard = useCallback(async (sessionId: string, messageId: string, cardIndex: number, card: BrainCard, persist = true) => {
    const arr = cacheRef.current.get(sessionId);
    if (!arr) return;
    let hit = false;
    const next = arr.map((m) => {
      if (m.id !== messageId || !m.cards?.length) return m;
      if (cardIndex < 0 || cardIndex >= m.cards.length) return m;
      hit = true;
      const cards = m.cards.map((c, i) => (i === cardIndex ? card : c));
      return { ...m, cards };
    });
    if (!hit) return;
    cacheRef.current.set(sessionId, next);
    if (sessionId === activeIdRef.current) setMessages(next);
    if (!persist) return;
    try {
      await apiFetch("/api/brain/sessions/replace-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sessionId, messageId, cardIndex, card }),
      });
    } catch { /* 静默：持久化失败仅影响刷新恢复 */ }
  }, [title]);

  /** 标记当前会话某卡片操作已完成（key：`消息id:卡片下标[:列表项id]`）。
   *  本地乐观更新（按钮即时反馈）+ 服务端持久化（刷新后恢复完成态）；POST 失败静默——仅影响刷新恢复，不阻塞操作。 */
  const markCompleted = useCallback(async (key: string) => {
    const sid = activeIdRef.current;
    if (!sid || !key) return;
    const cur = completedRef.current.get(sid) ?? new Set<string>();
    if (cur.has(key)) return; // 幂等：重复标记不重复发请求
    const next = new Set(cur);
    next.add(key);
    completedRef.current.set(sid, next);
    setCompleted(next);
    try {
      await apiFetch("/api/brain/sessions/completed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, id: sid, key }),
      });
    } catch { /* 静默：下次标记/打开会话时从服务端补齐 */ }
  }, [title]);

  /** 停止 active 会话生成 */
  const stop = useCallback(() => {
    abortRef.current.get(activeIdRef.current)?.abort();
  }, []);

  /** 只读访问某会话的展示消息缓存（跨会话 WS 事件匹配 / 后台会话任务清理用） */
  const getSessionMessages = useCallback((sessionId: string): ChatMessage[] | undefined => {
    return cacheRef.current.get(sessionId);
  }, []);

  /** 应用 sync WS 的服务端权威会话快照。正在由本 Tab 接收 SSE 的会话保留本地流，避免跨通道乱序回退文本。 */
  const applySyncSnapshot = useCallback((snapshot: BrainSyncSession[]) => {
    const authoritativeIds = new Set(snapshot.map((s) => s.id));
    const metas: SessionMeta[] = snapshot.map((s) => ({
      id: s.id,
      title: s.sessionTitle,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      streaming: s.streaming,
      messageCount: s.messages.length,
    }));
    setSessions(metas);
    // 快照中不存在的会话已被其它 Tab 删除：清掉消息/completed/SSE，不能只更新历史列表
    // 而让当前活动区继续展示已删除的旧会话。
    for (const id of [...cacheRef.current.keys()]) {
      if (authoritativeIds.has(id)) continue;
      abortRef.current.get(id)?.abort();
      abortRef.current.delete(id);
      cacheRef.current.delete(id);
      completedRef.current.delete(id);
    }
    const activeRemoved = !!activeIdRef.current && !authoritativeIds.has(activeIdRef.current);
    if (activeRemoved) {
      setActive("");
      setMessages([]);
      setStreaming(false);
      setThinking(false);
      setCompleted(new Set());
    }
    for (const s of snapshot) {
      // 本 Tab 正在接 SSE 且服务端也仍运行时，保留更细粒度的本地 delta；服务端已终态则必须覆盖，确保清 loading。
      if (abortRef.current.has(s.id) && s.streaming) continue;
      const next = s.messages.map(toDisplayMsg);
      cacheRef.current.set(s.id, next);
      completedRef.current.set(s.id, new Set(s.completed ?? []));
      void cachePutSession(title, s.id, next, s.completed ?? []);
      if (s.id === activeIdRef.current) {
        setMessages(next);
        setStreaming(s.streaming);
        setCompleted(completedRef.current.get(s.id) ?? new Set());
      }
    }
  }, [title]);

  /** 挂载/切换书时恢复：清缓存 → 拉列表 → 打开最近会话（streaming 会话由 openSession 自动续流） */
  useEffect(() => {
    if (loadedTitleRef.current === title) return;
    // C5 修复：先捕获旧 title 再更新 ref，cacheClearBook 清的是旧书而非新书
    const oldTitle = loadedTitleRef.current;
    loadedTitleRef.current = title;
    cacheRef.current.clear();
    completedRef.current.clear();
    // C6 修复：切书时先逐个 abort 各会话 SSE（触发其 finally 清 idleTimer），再清空 map
    for (const ctrl of abortRef.current.values()) ctrl.abort();
    abortRef.current.clear();
    setActive("");
    setMessages([]);
    setStreaming(false);
    setCompleted(new Set());
    // Phase 4：切书时清上一本书的 indexeddb 缓存（防跨书串扰；当前书缓存由 openSession 拉 detail 时写回）
    if (oldTitle) void cacheClearBook(oldTitle);
    void (async () => {
      const list = await refreshList();
      const latest = list[0];
      if (latest) await openSession(latest.id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  // C6 修复：卸载时 abort 所有 SSE 连接（各 connectOnce 的 finally 随之 clearInterval(idleTimer)），
  // 避免 BrainCabin 卸载/切书后 SSE 悬挂、空闲定时器泄漏
  useEffect(() => {
    return () => {
      for (const ctrl of abortRef.current.values()) ctrl.abort();
      abortRef.current.clear();
    };
  }, []);

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
    appendCard,
    patchCard,
    replaceCard,
    send,
    stop,
    refreshList,
    reconnecting,
    completed,
    markCompleted,
    reloadActive,
    isStreaming: (id: string) => abortRef.current.has(id),
    getSessionMessages,
    applySyncSnapshot,
  };
}
