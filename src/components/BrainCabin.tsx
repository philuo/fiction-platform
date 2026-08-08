// 中枢对话舱（BrainCabin）：常驻侧边抽屉，卡片式浏览 + 智能控制入口
// 顶部：印灵大图 + 四维状态脉象 + 右上角无边框 icon 操作组（新建/历史/关闭）；会话横滑栏；
// 中部：对话流（富文本 Markdown + 卡片 + loading 骨架）或历史会话视图（可删除/切换）；底部：输入条 + 停止生成
// 直接输入即开启首次对话（无需先点新建）；历史 icon 切换下方为历史列表
// 接入 /api/brain/chat SSE（协议 v2）：intent/delta/card/done/interrupted/reset
// 多会话：useBrainSession（服务端持久化 + 独立 SSE 连接，切换 tab 不打断；刷新自动续流）
import { useEffect, useMemo, useRef, useState } from "react";
import { BrainCore } from "./BrainCore";
import { History, Plus, X } from "./icons";
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
      <span className="bc-thinking-label">中枢正在思考…</span>
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
}> = ({ open, onClose, world, brainState, onWorldUpdate, onProposalTalk }) => {
  const {
    sessions, activeId, messages, streaming, thinking,
    openSession, newSession, removeSession, truncate, appendMsg, send, stop, isStreaming,
  } = useBrainSession(world.title);

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
      if (next) void openSession(next.id);
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
                  onClick={() => { setShowHistory(false); void openSession(s.id); }}
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
                  onClick={() => { setShowHistory(false); setClosedTabs((prev) => { const n = new Set(prev); n.delete(s.id); return n; }); void openSession(s.id); }}
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
              <p className="bc-hint">直接输入即可开始对话；试试：「再写一章」「这本书质量怎么样」「给第三章配张插画」</p>
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
                  <button className="bc-link-btn" onClick={() => editPrompt(msg)} disabled={streaming} title="编辑并重发（截断后续对话）">✎ 编辑</button>
                </div>
              )}
            </div>
          ))}
        </div>
        )}

        {/* 底部：输入条 + 停止生成（历史视图隐藏） */}
        {!showHistory && (
        <div className="brain-cabin-input">
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
            <button className="btn btn-danger bc-stop" onClick={stop} title="停止生成（保留已输出内容）">■ 停止</button>
          ) : (
            <button className="btn btn-primary bc-send" onClick={() => void doSend()} disabled={!input.trim()}>
              发送
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  );

  // —— 以下为组件内操作函数（依赖上方 JSX 引用的状态） ——

  /** 发送：无 activeId 时自动新建会话（直接输入即首次对话） */
  async function doSend() {
    const prompt = input.trim();
    if (!prompt || streaming) return;
    setInput("");
    let sid = activeId;
    if (!sid) sid = await newSession(prompt);
    await send({ prompt, sessionId: sid });
  }

  /** 重新生成：resume 当前会话最后一条未完成消息 */
  function regenerate() {
    if (!activeId || streaming) return;
    const lastBrain = [...messages].reverse().find((m) => m.role === "brain" && m.interrupted);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastBrain || !lastUser) return;
    void send({ prompt: lastUser.text ?? "", sessionId: activeId, resume: true });
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
      const r = await fetchAction(act.endpoint, act.method ?? "POST", act.body);
      appendBrainMsg([{ kind: "result", title: card.title, success: r.success, detail: r.detail }]);
      if (r.success) onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
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
    const body = { ...(card.action.body ?? {}), ...flat, title: world.title };
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
