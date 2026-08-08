// 中枢对话舱（BrainCabin）：常驻侧边抽屉，卡片式浏览 + 智能控制入口
// 顶部：印灵大图 + 四维状态脉象 + 右上角无边框 icon 操作组（新建/历史/关闭）；会话横滑栏；
// 中部：对话流（富文本 Markdown + 卡片 + loading 骨架）或历史会话视图（可删除/切换）；底部：输入条 + 发送/中断（上边界可拖高）
// 直接输入即开启首次对话（无需先点新建）；历史 icon 切换下方为历史列表
// 接入 /api/brain/chat SSE（协议 v2）：intent/delta/card/done/interrupted/reset
// 多会话：useBrainSession（服务端持久化 + 独立 SSE 连接，切换 tab 不打断；刷新自动续流）
import { useEffect, useMemo, useRef, useState } from "react";
import { BrainCore } from "./BrainCore";
import { History, Plus, Send, Square, X } from "./icons";
import { BrainCardView, type BrainCard, type PreviewCard, type ChoiceOption, type FormCard, type FormField } from "./brain-cards";
import { MarkdownView } from "./MarkdownView";
import { useBrainSession, type ChatMessage } from "./useBrainSession";
import { apiFetch } from "../api/client";
import {
  PRESENCE_LABEL, ACTIVITY_LABEL, GOVERNANCE_LABEL,
  type BrainState,
} from "../api/brain-state";
import type { WorldState } from "../api/world";

/** 从消息卡片中找 PreviewCard 的 action（供 ConfirmCard 确认时执行） */
function findPreviewAction(cards?: BrainCard[]): PreviewCard["action"] | undefined {
  const p = cards?.find((c): c is PreviewCard => c.kind === "preview");
  return p?.action;
}

/** 表单值扁平化（与后端 brain-chat.ts flattenFormValues 一致：点路径 + array 拆分 + number/bool 转换） */
function flattenFormValues(fields: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    let v = values[f.key];
    if (v == null) continue;
    if (f.array && typeof v === "string") {
      v = v.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    }
    if (f.transform === "bool") v = v === true || v === "开" || v === "true";
    if (f.type === "number" && typeof v === "string") {
      const n = Number(v);
      v = Number.isFinite(n) ? n : v;
    }
    const parts = f.key.split(".");
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] ?? {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/** 统一 fetch 执行：检测 SSE 响应（推进/连载等长任务）与 JSON 响应，返回结果摘要 */
async function fetchAction(endpoint: string, method: string, body: Record<string, unknown>): Promise<{ success: boolean; detail: string }> {
  const res = await apiFetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { success: false, detail: String(errData.error ?? `HTTP ${res.status}`) };
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    res.body?.cancel().catch(() => {});
    return { success: true, detail: "操作已启动，请查看页面进度" };
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { success: !data.error, detail: data.error ? String(data.error) : "执行成功" };
}

/** 生成中 loading 骨架（intent 阶段/等待首块） */
function ThinkingSkeleton() {
  return (
    <div className="bc-thinking">
      <span className="bc-dot" /><span className="bc-dot" /><span className="bc-dot" />
    </div>
  );
}

/** 历史时间简短格式化 */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 检测 messages 中第一条含「新角色提案」浏览卡的消息 id（供 onProposalTalk 触发；纯函数便于单测） */
export function findProposalCardMessageId(messages: ChatMessage[]): string | undefined {
  return messages.find((m) => (m.cards ?? []).some((c) => c.kind === "browse" && c.browseType === "proposal"))?.id;
}

export const BrainCabin: React.FC<{
  open: boolean;
  onClose: () => void;
  world: WorldState;
  brainState: BrainState | null;
  onWorldUpdate?: () => void;
  /** 用户与中枢沟通「新角色提案」相关话题（返回提案浏览卡）→ 通知 Home 恢复底部提案区显示 */
  onProposalTalk?: () => void;
  /** 左侧栏当前选中章节（未指定章的操作（如生成插画）默认用此章；null=未选中） */
  currentChapter?: { index: number } | null;
}> = ({ open, onClose, world, brainState, onWorldUpdate, onProposalTalk, currentChapter }) => {
  const {
    sessions, activeId, messages, streaming, thinking,
    openSession, newSession, removeSession, truncate, appendMsg, send, stop, isStreaming,
  } = useBrainSession(world.title);

  /** 前端上下文：当前选中章（供服务端意图识别参数提取兜底，需求 1/2） */
  const chatCtx = { chapterIndex: currentChapter?.index ?? null };

  const [input, setInput] = useState("");
  const [executing, setExecuting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** 已关闭窗口的会话（仅从 tab 栏隐藏，不删除会话记录；历史中可重新打开） */
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** tab 栏可见会话（过滤已关闭窗口的） */
  const visibleSessions = sessions.filter((s) => !closedTabs.has(s.id));

  /** 关闭会话窗口：从 tab 栏隐藏；若关闭的是当前会话，切到下一个可见会话（无则回到空态） */
  function closeTab(id: string) {
    setClosedTabs((prev) => new Set(prev).add(id));
    if (id === activeId) {
      const next = visibleSessions.find((s) => s.id !== id);
      if (next) void openSession(next.id, chatCtx);
      else setShowHistory(false);
    }
  }

  // 用户与中枢聊「新角色提案」话题（返回提案浏览卡）→ 通知 Home 恢复底部提案区显示；
  // 同一消息只通知一次（历史会话加载旧提案卡也视为浏览过提案，可接受）
  const proposalNotifiedRef = useRef<string>("");
  useEffect(() => {
    if (!onProposalTalk) return;
    const id = findProposalCardMessageId(messages);
    if (id && id !== proposalNotifiedRef.current) {
      proposalNotifiedRef.current = id;
      onProposalTalk();
    }
  }, [messages, onProposalTalk]);

  // 滚动到底部（消息/thinking 变化时）
  const scrollKey = useMemo(() => `${messages.length}:${messages[messages.length - 1]?.text?.length ?? 0}`, [messages]);
  useMemo(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [scrollKey, thinking, open]);

  function appendBrainMsg(cards: BrainCard[]) {
    if (!activeId) return;
    appendMsg(activeId, { id: crypto.randomUUID(), role: "brain", cards, at: new Date().toISOString() });
  }

  if (!open) return null;

  const presence = brainState?.presence ?? "standby";
  const activity = brainState?.activity ?? "idle";
  const governance = brainState?.governance ?? "passthrough";

  // —— 输入框上方上下文操作区：当前会话话题 + 未决交互（二次确认/意见征询/待执行）+ 连载进度 ——
  const activeSessionTitle = sessions.find((s) => s.id === activeId)?.title ?? "";
  const lastBrainMsg = [...messages].reverse().find((m) => m.role === "brain");
  const lastCards = lastBrainMsg?.cards ?? [];
  const ctxCard = lastCards.find(
    (c) => c.kind === "confirm" || c.kind === "plan" || c.kind === "opinion" || (c.kind === "preview" && (c as PreviewCard).confirmRequired)
  ) as (BrainCard & { options?: ChoiceOption[] }) | undefined;
  const ctxBusy = streaming || executing;
  const runningStatus = (() => {
    if (streaming) return "中枢正在生成回复…";
    if (thinking) return "中枢正在思考…";
    if (activity !== "idle") return `中枢正在${ACTIVITY_LABEL[activity]}`;
    return "";
  })();

  return (
    <div className="brain-cabin-mask" onClick={onClose}>
      <div className="brain-cabin" onClick={(e) => e.stopPropagation()}>
        {/* 顶部：大脑 + 状态区 + 右上角操作（新建/历史）；关闭按钮独立于右上角角落 */}
        <div className="brain-cabin-head">
          <button className="modal-close bc-head-close" onClick={onClose} title="关闭对话舱">
            <X size={16} />
          </button>
          <div className="brain-cabin-head-row">
            <BrainCore presence={presence} activity={activity} size="full" px={72} />
            <div className="brain-cabin-status">
              <div className="brain-cabin-title">
                中枢
                <b className={`bc-presence bc-presence-${presence}`}>{PRESENCE_LABEL[presence]}</b>
              </div>
              <div className="brain-cabin-sub">
                <span className="bc-activity">{ACTIVITY_LABEL[activity]}</span>
                {governance !== "passthrough" && governance !== "approved" && (
                  <span className={`bc-gov-tag bc-gov-tag-${governance}`}>{GOVERNANCE_LABEL[governance]}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 会话横滑栏（独立区域）：直接输入即开启/继续对话，点击 tab 切换，悬浮 ✕ 关闭窗口（不删除会话） */}
        <div className="bc-tabs">
          <div className="bc-tabs-scroll">
            {visibleSessions.length === 0 && <span className="bc-tabs-empty">直接输入，开启首次对话</span>}
            {visibleSessions.map((s) => (
              <div key={s.id} className={`bc-tab-wrap${activeId === s.id ? " active" : ""}`}>
                <button
                  className="bc-tab"
                  onClick={() => { setShowHistory(false); void openSession(s.id, chatCtx); }}
                  title={s.title}
                >
                  <span className="bc-tab-title">{s.title}</span>
                  {isStreaming(s.id) && <span className="bc-live-dot" title="生成中" />}
                </button>
                <button
                  className="bc-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeTab(s.id); }}
                  title="关闭窗口（不删除会话）"
                >✕</button>
              </div>
            ))}
          </div>
          {/* 右侧操作：添加对话 + 查看历史对话 */}
          <div className="bc-tabs-actions">
            <button className="bc-head-icon-btn" onClick={() => { void newSession(); setShowHistory(false); inputRef.current?.focus(); }} title="新建会话">
              <Plus size={15} />
            </button>
            <button
              className={`bc-head-icon-btn${showHistory ? " active" : ""}`}
              onClick={() => setShowHistory((v) => !v)}
              title={showHistory ? "返回对话" : "查看历史对话"}
            >
              <History size={15} />
            </button>
          </div>
        </div>

        {/* 中部：历史会话视图（点击 icon 切换；允许删除会话、点击切换会话） */}
        {showHistory && (
          <div className="bc-history-panel">
            <div className="bc-history-panel-head">
              <span>历史会话</span>
              <button className="bc-link-btn" onClick={() => setShowHistory(false)}>← 返回对话</button>
            </div>
            <div className="bc-history-list">
              {sessions.length === 0 && <p className="bc-history-empty">暂无历史会话</p>}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`bc-history-item${activeId === s.id ? " active" : ""}`}
                  onClick={() => { setShowHistory(false); setClosedTabs((prev) => { const n = new Set(prev); n.delete(s.id); return n; }); void openSession(s.id, chatCtx); }}
                >
                  <div className="bc-history-main">
                    <span className="bc-history-title">{s.title}{isStreaming(s.id) && <span className="bc-live-dot" title="生成中" />}</span>
                    <span className="bc-history-meta">{fmtTime(s.updatedAt)} · {s.messageCount} 条消息</span>
                  </div>
                  <button
                    className="bc-history-del"
                    title="删除会话"
                    onClick={(e) => { e.stopPropagation(); setClosedTabs((prev) => { const n = new Set(prev); n.delete(s.id); return n; }); void removeSession(s.id); }}
                  >删除</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 中部：对话流 */}
        {!showHistory && (
        <div className="brain-cabin-stream" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="brain-cabin-empty">
              <p className="bc-hint">试一试：「再写一章」「这本书质量怎么样」「给第三章配张插画」</p>
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id} className={`bc-msg bc-msg-${msg.role}`}>
              {msg.role === "brain" && <BrainCore presence={presence} activity={activity} size="mini" />}
              <div className="bc-msg-content">
                {msg.role === "brain" && msg.pending && !msg.text && (
                  <ThinkingSkeleton />
                )}
                {msg.text ? (
                  <div className={`bc-msg-text${msg.pending ? " bc-typing" : ""}`}>
                    <MarkdownView text={msg.text} />
                    {msg.pending && <span className="bc-cursor">▋</span>}
                  </div>
                ) : null}
                {msg.interrupted && (
                  <div className="bc-interrupted-bar">
                    <span className="bc-interrupted-tag">已停止</span>
                    <button className="bc-link-btn" onClick={regenerate} disabled={streaming}>重新生成</button>
                    <button className="bc-link-btn" onClick={retryInInput} disabled={streaming} title="把最后一个问题移到底部输入框，并从记录中移除本回合">移至输入 · 移除本回合</button>
                  </div>
                )}
                {msg.cards?.map((card, i) => (
                  <BrainCardView
                    key={i}
                    card={card}
                    busy={streaming || executing}
                    onExecute={executeCard}
                    onConfirmChoose={(opt) => confirmChoose(opt, msg.cards)}
                    onOption={handleOption}
                    onFormSubmit={submitForm}
                  />
                ))}
              </div>
              {msg.role === "user" && (
                <div className="bc-user-actions">
                  <button className="bc-link-btn" onClick={() => editPrompt(msg)} disabled={streaming || thinking} title="编辑并重发（截断后续对话）">✎ 编辑</button>
                </div>
              )}
            </div>
          ))}
        </div>
        )}

        {/* 输入框上方上下文操作区：会话话题 + 二次确认/意见征询按钮；无内容时整条隐藏 */}
        {!showHistory && (activeSessionTitle || ctxCard || runningStatus) && (
          <div className="bc-context-bar">
            <div className="bc-context-main">
              {activeSessionTitle && <span className="bc-context-session" title="当前会话">{activeSessionTitle}</span>}
              {runningStatus && <span className="bc-context-status">{runningStatus}</span>}
            </div>
            {ctxCard && (
              <div className="bc-context-actions">
                {ctxCard.kind === "confirm" && (
                  <>
                    <span className="bc-context-label">待确认</span>
                    <button className="bc-ctx-btn" disabled={ctxBusy} onClick={() => confirmChoose("merge", lastBrainMsg?.cards)} title="合并本次改动">合并</button>
                    <button className="bc-ctx-btn" disabled={ctxBusy} onClick={() => confirmChoose("rewrite", lastBrainMsg?.cards)} title="按计划重写受影响章节">重写</button>
                    <button className="bc-ctx-btn danger" disabled={ctxBusy} onClick={() => confirmChoose("abort")} title="放弃本次操作">放弃</button>
                  </>
                )}
                {(ctxCard.kind === "plan" || ctxCard.kind === "opinion") && (
                  <>
                    <span className="bc-context-label">{ctxCard.kind === "plan" ? "计划选项" : "意见征询"}</span>
                    {ctxCard.options?.map((o, i) => (
                      <button key={i} className="bc-ctx-btn" disabled={ctxBusy} onClick={() => handleOption(o)} title={o.description}>{o.label}</button>
                    ))}
                  </>
                )}
                {ctxCard.kind === "preview" && (
                  <button className="bc-ctx-btn primary" disabled={ctxBusy} onClick={() => executeCard(ctxCard)} title="执行此操作">执行操作</button>
                )}
              </div>
            )}
          </div>
        )}

        {/* 底部：输入条 + 发送/中断（历史视图隐藏）；上边界可拖动调整输入区高度 */}
        {!showHistory && (
        <div className="brain-cabin-input">
          <div className="bc-input-resize" onPointerDown={startInputResize} title="拖动调整输入区高度" />
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void doSend(); }
            }}
            placeholder="对中枢说点什么…（Enter 发送，Shift+Enter 换行）"
            rows={2}
            disabled={streaming}
          />
          {streaming ? (
            <button className="btn btn-danger bc-send" onClick={stop} title="中断生成（保留已输出内容）">
              <Square size={15} /> 中断
            </button>
          ) : (
            <button className="btn btn-primary bc-send" onClick={() => void doSend()} disabled={!input.trim()} title="发送">
              <Send size={15} /> 发送
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );

  // —— 以下为组件内操作函数（依赖上方 JSX 引用的状态） ——

  /**
   * 输入区上边界拖拽：以 textarea 当前高度为基准，随指针垂直位移实时调整高度
   * （钳制在 CSS min-height:3rem / max-height:11rem 对应像素值内）
   */
  function startInputResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const ta = inputRef.current;
    if (!ta) return;
    const startY = e.clientY;
    const startH = ta.getBoundingClientRect().height;
    const MIN = 48, MAX = 176;
    const onMove = (ev: PointerEvent) => {
      const h = Math.min(MAX, Math.max(MIN, startH + (startY - ev.clientY)));
      ta.style.height = `${h}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }

  /** 发送：无 activeId 时自动新建会话（直接输入即首次对话） */
  async function doSend() {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setInput("");
    let sid = activeId;
    if (!sid) sid = await newSession(prompt);
    await send({ prompt, sessionId: sid, ctx: chatCtx });
  }

  /** 重新生成：resume 当前会话最后一条未完成消息 */
  function regenerate() {
    if (!activeId || streaming) return;
    const lastBrain = [...messages].reverse().find((m) => m.role === "brain" && m.interrupted);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastBrain || !lastUser) return;
    void send({ prompt: lastUser.text ?? "", sessionId: activeId, resume: true, ctx: chatCtx });
  }

  /**
   * 中断轮次移至输入框：把最后一个问题回填到底部输入框，
   * 并从聊天记录中移除被中断的最后一轮（truncate 删除最后一条 user 消息及其后的 brain 消息）。
   */
  async function retryInInput() {
    if (!activeId || streaming) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const last = messages[messages.length - 1];
    // 移除对象：最后一条 user 消息（连带其后的被中断回复）；若仅剩 brain 消息则移除该条
    const target = lastUser ?? (last?.role === "brain" ? last : undefined);
    if (!target) return;
    setInput(lastUser?.text ?? "");
    await truncate(activeId, target.id);
    inputRef.current?.focus();
  }

  /** 编辑用户消息：截断该消息及其后（服务端+本地），回填输入框 */
  async function editPrompt(userMsg: ChatMessage) {
    if (!activeId) return;
    setInput(userMsg.text ?? "");
    await truncate(activeId, userMsg.id);
    inputRef.current?.focus();
  }

  /** 计划/意见选项卡点击：有动作则执行并回执；纯说明则记录选择 */
  async function handleOption(option: ChoiceOption) {
    if (executing || streaming) return;
    if (!option.action) {
      appendBrainMsg([{ kind: "result", title: option.label, success: true, detail: option.description ?? "已选择，中枢将据此继续" }]);
      return;
    }
    setExecuting(true);
    try {
      const r = await fetchAction(option.action.endpoint, option.action.method ?? "POST", option.action.body);
      appendBrainMsg([{ kind: "result", title: option.label, success: r.success, detail: r.detail }]);
      if (r.success) onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: option.label, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
  }

  /** 执行卡片操作 */
  async function executeCard(card: BrainCard, action?: { endpoint: string; method?: string; body: Record<string, unknown> }) {
    if (executing || streaming) return;
    const act = action ?? (card.kind === "preview" ? card.action : undefined);
    if (!act) return;
    setExecuting(true);
    try {
      // 媒体生成（插画/视频）：image 为异步任务，提交后轮询 /media/status，完成后刷新世界并回执
      if (act.endpoint === "/api/novel/media/generate") {
        const res = await apiFetch(act.endpoint, {
          method: act.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(act.body),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; mediaIds?: string[]; mediaId?: string; error?: string };
        if (!res.ok || data.error) {
          appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: String(data.error ?? `HTTP ${res.status}`) }]);
          return;
        }
        const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
        const chapterIndex = Number(act.body.chapterIndex);
        if (ids.length) {
          appendBrainMsg([{ kind: "result", title: card.title, success: true, detail: `生成任务已提交（${ids.length} 项），完成后自动显示` }]);
          pollMediaGen(world.title, chapterIndex, ids, card.title);
        } else {
          appendBrainMsg([{ kind: "result", title: card.title, success: true, detail: "已提交生成任务" }]);
        }
        onWorldUpdate?.();
        return;
      }
      const r = await fetchAction(act.endpoint, act.method ?? "POST", act.body);
      appendBrainMsg([{ kind: "result", title: card.title, success: r.success, detail: r.detail }]);
      if (r.success) onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
  }

  /** 媒体生成进度轮询：全部 ready/failed 后刷新世界并追加结果卡（聊天内生成插画的进度闭环）。
   *  非 2xx / 解析失败视为该项失败并结束轮询，防 setInterval 永久泄漏。 */
  function pollMediaGen(title: string, chapterIndex: number, mediaIds: string[], label: string) {
    const timer = window.setInterval(async () => {
      try {
        const sts = await Promise.all(mediaIds.map(async (id) => {
          const r = await apiFetch("/api/novel/media/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, chapterIndex, mediaId: id }),
          });
          if (!r.ok) return "failed"; // 媒体不存在/参数错误：按失败收尾，不再无限轮询
          const d = (await r.json().catch(() => ({}))) as { status?: string };
          return d.status === "ready" || d.status === "failed" ? d.status : "pending";
        }));
        const done = sts.filter((s) => s === "ready").length;
        const failed = sts.filter((s) => s === "failed").length;
        if (done + failed === mediaIds.length) {
          window.clearInterval(timer);
          appendBrainMsg([{ kind: "result", title: label, success: failed === 0, detail: failed === 0 ? `已完成（${done} 项）` : `${done} 项成功，${failed} 项失败` }]);
          onWorldUpdate?.();
        }
      } catch { /* 网络抖动：继续轮询 */ }
    }, 3000);
  }

  /** ConfirmCard 确认（L2/L3 三选一） */
  async function confirmChoose(opt: "merge" | "rewrite" | "abort", cards?: BrainCard[]) {
    if (opt === "abort") {
      appendBrainMsg([{ kind: "result", title: "已放弃", success: true, detail: "用户选择放弃本次操作" }]);
      return;
    }
    if (executing || streaming) return;
    const action = findPreviewAction(cards);
    if (!action) {
      appendBrainMsg([{ kind: "result", title: "无法执行", success: false, detail: "未找到操作端点" }]);
      return;
    }
    setExecuting(true);
    try {
      const body = { ...action.body, strategy: opt };
      const r = await fetchAction(action.endpoint, action.method ?? "POST", body);
      appendBrainMsg([{ kind: "result", title: `已执行（${opt}）`, success: r.success, detail: r.detail }]);
      if (r.success) onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: `执行失败（${opt}）`, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
  }

  /**
   * 表单卡提交（FormCard）：扁平化字段 → 执行端点 →
   * 端点返回 needIntervention（L2 干预）时本地追加 preview+confirm 卡（三选一），
   * 否则结果回执 + 刷新世界。confirmRequired 卡（如删除伏笔）由按钮文案承担确认语义。
   */
  async function submitForm(card: FormCard, values: Record<string, unknown>) {
    if (executing || streaming) return;
    const flat = flattenFormValues(card.fields ?? [], values);
    const body: Record<string, unknown> = { ...(card.action.body ?? {}), ...flat, title: world.title };
    setExecuting(true);
    try {
      const res = await apiFetch(card.action.endpoint, {
        method: card.action.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok || data.error) {
        appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: String(data.error ?? `HTTP ${res.status}`) }]);
        return;
      }
      // 媒体生成表单（/api/novel/media/plan）：分镜 → 本地追加 preview 卡（确认场景后生成，聊天内闭环）
      if (card.action.endpoint === "/api/novel/media/plan") {
        const scenes = data.scenes as { anchor?: string; scene?: string; caption?: string; type?: string; subject?: string }[] | undefined;
        if (!data.ok || !Array.isArray(scenes) || !scenes.length) {
          appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: String(data.error ?? "场景规划失败，请重试") }]);
          return;
        }
        const chapterIndex = Number(body.chapterIndex);
        const kind = String(body.kind ?? "image");
        // 视频后端只取第一个场景（valid[0]）生成 1 段，文案据 kind 区分
        const preview: PreviewCard = {
          kind: "preview",
          title: kind === "image" ? `生成第 ${chapterIndex} 章插画（${scenes.length} 张）` : `生成第 ${chapterIndex} 章视频`,
          commandId: card.commandId,
          level: card.level ?? "L0",
          summary: kind === "image"
            ? `已从第 ${chapterIndex} 章正文挑选 ${scenes.length} 个关键场景，确认后开始生成。`
            : `已从第 ${chapterIndex} 章正文挑选 1 个关键场景，确认后开始生成视频。`,
          action: { endpoint: "/api/novel/media/generate", method: "POST", body: { title: world.title, chapterIndex, kind, scenes } },
        };
        appendBrainMsg([preview]);
        return;
      }
      if (data.needIntervention && data.report) {
        // L2 干预：预览影响面 + 三选一确认（复用 confirmChoose 的 preview 查找逻辑）
        const rp = data.report as { summary?: string; affectedChapters?: unknown[] };
        const preview: PreviewCard = {
          kind: "preview",
          title: card.title,
          commandId: card.commandId,
          level: card.level ?? "L2",
          summary: rp.summary ?? "此修改为 L2 回溯变更，将影响已写内容",
          confirmRequired: true,
          action: { endpoint: card.action.endpoint, method: card.action.method ?? "POST", body },
        };
        const confirm: BrainCard = {
          kind: "confirm",
          title: `${card.title} · 确认`,
          commandId: card.commandId,
          level: card.level ?? "L2",
          impact: `影响 ${(rp.affectedChapters ?? []).length} 个已写章节，请选择处理策略`,
          options: ["merge", "rewrite", "abort"],
        };
        appendBrainMsg([preview, confirm]);
        return;
      }
      appendBrainMsg([{ kind: "result", title: card.title, success: true, detail: "已保存" }]);
      onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
  }
};
