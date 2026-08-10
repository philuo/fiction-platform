// 中枢对话舱（BrainCabin）：常驻侧边抽屉，卡片式浏览 + 智能控制入口
// 顶部：印灵大图 + 四维状态脉象 + 右上角无边框 icon 操作组（新建/历史/关闭）；会话横滑栏；
// 中部：对话流（富文本 Markdown + 卡片 + loading 骨架）或历史会话视图（可删除/切换）；底部：输入条 + 发送/中断（上边界可拖高）
// 直接输入即开启首次对话（无需先点新建）；历史 icon 切换下方为历史列表
// 接入 /api/brain/chat SSE（协议 v2）：intent/delta/card/done/interrupted/reset
// 多会话：useBrainSession（服务端持久化 + 独立 SSE 连接，切换 tab 不打断；刷新自动续流）
import { useEffect, useRef, useState } from "react";
import { BrainCore } from "./BrainCore";
import { History, Plus, Send, Square, X } from "./icons";
import { BrainCardView, type BrainCard, type PreviewCard, type ChoiceOption, type FormCard, type FormField, type AskCard } from "./brain-cards";
import { MarkdownView } from "./MarkdownView";
import { useBrainSession, type ChatMessage } from "./useBrainSession";
import { apiFetch } from "../api/client";
import { uuid } from "../shared/uuid";
import {
  PRESENCE_LABEL, ACTIVITY_LABEL, GOVERNANCE_LABEL,
  type BrainState, type Presence, type Activity,
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

// —— Phase 3：中枢本地偏好（localStorage，纯用户体验增强；服务端始终权威） ——
const CABIN_PREFS_KEY = "fp_cabin_prefs";
type CabinPrefs = { mediaCount?: number; inputHeight?: number; panelWidth?: number };

function readCabinPrefs(): CabinPrefs {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CABIN_PREFS_KEY);
    return raw ? (JSON.parse(raw) as CabinPrefs) : {};
  } catch { return {}; }
}
function writeCabinPrefs(patch: CabinPrefs) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CABIN_PREFS_KEY, JSON.stringify({ ...readCabinPrefs(), ...patch }));
  } catch { /* 配额满/隐私模式：静默 */ }
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
/** 从 completedCards 提取某卡已完成的 itemId 集合（key 形如 "msgId:cardIndex:itemId"） */
export function completedItemIdsOf(completed: ReadonlySet<string>, msgId: string, cardIndex: number): ReadonlySet<string> {
  const prefix = `${msgId}:${cardIndex}:`;
  const out = new Set<string>();
  for (const k of completed) if (k.startsWith(prefix)) out.add(k.slice(prefix.length));
  return out;
}

/** browse 卡 item 操作的 body → itemId（proposal: proposalId；tasks: id；gacha 单卡: pick[0]；gacha 全部应用等无 item） */
export function actionItemId(body: Record<string, unknown>): string | undefined {
  if (typeof body.proposalId === "string") return body.proposalId;
  if (typeof body.id === "string") return body.id;
  if (Array.isArray(body.pick) && body.pick.length === 1 && typeof body.pick[0] === "string") return body.pick[0];
  return undefined;
}

/** 操作前置校验（纯前端只读）：返回不可执行原因字符串，null = 可执行。
 *  服务端仍是权威（world 可能过期）；此处拦截「系统忙 / 写作运行中 / 目标资源已消耗」的点击，
 *  给出即时反馈而不发请求——绝不改变系统状态，稳定性由服务端校验兜底。
 *  act：待执行端点；ctx：组件运行时快照（executing/streaming/writingRunning/world）。
 *  body 约定（与 brain-chat.ts 卡片生成一致）：proposalId / id(debt) / pick(gacha) / action */
export function guardAction(
  act: { endpoint: string; body?: Record<string, unknown> },
  ctx: {
    executing?: boolean;
    streaming?: boolean;
    writingRunning?: boolean;
    world?: { characterProposals?: { id: string; status: string }[]; pendingCards?: { id: string }[]; qualityDebt?: { id: string; status: string }[] };
  },
): string | null {
  // 系统忙：对话流式生成中或已有操作执行中 → 禁止并发写操作（防重复生成/双跑）
  if (ctx.executing || ctx.streaming) return "当前有对话或任务正在运行，请稍候再试";
  // 写作流式进行中（progress 卡运行）：任何写操作均拦截（服务端任务锁兜底，前端先行避免误触）
  if (ctx.writingRunning) return "写作任务进行中，请等待完成或先中断";
  const body = act.body ?? {};
  const ep = act.endpoint;
  // 新角色提案：目标项必须仍为 pending（已确认/拒绝/删除 → 不可再操作）
  if (ep === "/api/novel/proposal") {
    const pid = String(body.proposalId ?? "");
    const p = ctx.world?.characterProposals?.find((x) => x.id === pid);
    if (!p || p.status !== "pending") return pid ? "该提案已处理或不存在" : "缺少提案标识";
  }
  // 抽卡应用：单卡须仍在 pendingCards；全部应用须卡池非空
  if (ep === "/api/novel/gacha" && body.action === "apply") {
    const pick = Array.isArray(body.pick) ? body.pick : [];
    const pool = ctx.world?.pendingCards ?? [];
    if (body.auto === true) {
      if (pool.length === 0) return "卡池已空，无待应用卡牌";
    } else if (pick.length === 1) {
      if (!pool.some((c) => c.id === String(pick[0]))) return "该卡已应用或不在卡池";
    }
  }
  // 质量债处理：目标项须仍为 open（已修复/忽略 → 不可再操作）
  if (ep === "/api/novel/debt") {
    const did = String(body.id ?? "");
    const d = ctx.world?.qualityDebt?.find((x) => x.id === did);
    if (!d || d.status !== "open") return did ? "该质量债已处理或不存在" : "缺少质量债标识";
  }
  return null;
}

export function findProposalCardMessageId(messages: ChatMessage[]): string | undefined {
  return messages.find((m) =>
    (m.cards ?? []).some((c) =>
      (c.kind === "browse" && c.browseType === "proposal") || // 提案浏览卡（read_proposals 查询）
      (c.kind === "result" && c.title === "新角色提案"), // 「打开新角色提案」已打开 result 卡（open_proposals 意图，兼容旧协议）
    ),
  )?.id;
}

/** 追问选择面板恢复：返回最后一条含未答 ask 卡的中枢消息（ask 卡不渲染进聊天流，显示在输入框上方；
 *  刷新后从消息历史恢复未选择的面板；已选择（answeredIds）不再恢复） */
export function findPendingAskCard(messages: ChatMessage[], answeredIds?: ReadonlySet<string>): { msgId: string; ask: AskCard } | null {
  if (!messages.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "brain") continue;
    const ask = (m.cards ?? []).find((c) => c.kind === "ask") as AskCard | undefined;
    if (ask && !(answeredIds?.has(m.id))) return { msgId: m.id, ask };
  }
  return null;
}

/** 打开面板卡（open_* 意图 result 卡带 open 字段，显式协议）：返回面板目标与定位参数 */
export function findOpenPanelCard(messages: ChatMessage[]): { messageId: string; target: string; opts?: Record<string, unknown> } | null {
  for (const m of messages) {
    const card = (m.cards ?? []).find((c) => {
      const o = (c as { open?: { target?: unknown } }).open;
      return !!o && typeof o.target === "string";
    });
    if (card) {
      const open = (card as { open: { target: string; opts?: Record<string, unknown> } }).open;
      return { messageId: m.id, target: open.target, opts: open.opts };
    }
  }
  return null;
}

/** 任务/指令类卡片 kind：含这类卡的消息支持折叠（预览/确认/表单/计划/意见/进度/结果） */
const COLLAPSIBLE_KINDS = new Set(["preview", "confirm", "form", "plan", "opinion", "progress", "result"]);

/** 消息是否可折叠：中枢消息且含任务/指令类卡片（纯文本/纯浏览消息不折叠） */
export function isCollapsibleMsg(msg: ChatMessage): boolean {
  if (msg.role !== "brain") return false;
  return (msg.cards ?? []).some((c) => COLLAPSIBLE_KINDS.has(c.kind));
}

/** 折叠摘要：优先取第一条卡 title，缺省回退卡片 kind / 文本首行 */
export function msgCollapseSummary(msg: ChatMessage): string {
  const card = (msg.cards ?? [])[0];
  if (card) {
    const t = (card as { title?: unknown }).title;
    if (typeof t === "string" && t.trim()) return t.trim();
    return card.kind;
  }
  return longTextSummary(msg.text ?? "", 40) || "任务消息";
}

/** 长文本折叠阈值（字符）：中枢纯文本回复超过该长度默认折叠为摘要行 */
export const FOLD_TEXT_THRESHOLD = 320;

/** 纯文本长回复是否折叠：中枢消息、无卡片、文本超阈值、且非生成中/中断 */
export function shouldFoldLongText(msg: ChatMessage, threshold = FOLD_TEXT_THRESHOLD): boolean {
  return msg.role === "brain"
    && !msg.pending
    && !msg.interrupted
    && (msg.cards ?? []).length === 0
    && (msg.text ?? "").length > threshold;
}

/** 长文本摘要：首 max 字 + 省略号 + （总字数） */
export function longTextSummary(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 按问答段分组消息：每条用户提问开启一个新段，段内含其后所有中枢回复，直到下一条提问。
 *  分段后每段（.bc-msg-group）成为其内部 sticky 用户消息的 containing block，吸附范围被限定在
 *  「该问答段」内——当前段滚到底（即下一条提问到达顶部）时，本段提问自然释放、下一条接续吸附，
 *  避免多条用户消息同时吸附在面板顶部时，较高的前序提问从较低的后序提问下方露出下半截。 */
function groupMessages(msgs: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let cur: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === "user" && cur.length) {
      groups.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** 空态快捷提问（点击即发送，降低首次使用门槛） */
const QUICK_PROMPTS: { label: string; prompt: string }[] = [
  { label: "再写一章", prompt: "再写一章" },
  { label: "整书质量", prompt: "这本书整体质量怎么样？" },
  { label: "生成插画", prompt: "给当前章节配张插画" },
  { label: "查看任务", prompt: "看看有哪些待处理任务" },
  { label: "检查一致性", prompt: "检查一下设定一致性" },
  { label: "新角色提案", prompt: "看看有什么新角色提案" },
];

/** 复制文本到剪贴板（无权限/旧浏览器降级 textarea + execCommand，失败静默） */
async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 降级 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch {
    /* 忽略 */
  }
}

/** 消息绝对时间（hover title 用）：MM-DD HH:MM */
function fmtAbsTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const BrainCabin: React.FC<{
  open: boolean;
  onClose: () => void;
  world: WorldState;
  brainState: BrainState | null;
  onWorldUpdate?: () => void;
  /** 用户与中枢沟通「新角色提案」相关话题（返回提案浏览卡）→ 通知 Home 恢复底部提案区显示 */
  onProposalTalk?: () => void;
  /** 中枢打开系统面板/弹窗（open_* 意图 result 卡带 open 字段）：target 为面板键，opts 为定位参数（如 settings tab / 角色 id） */
  onOpenPanel?: (target: string, opts?: Record<string, unknown>) => void;
  /** 左侧栏当前选中章节详情（未指定章的操作（如生成插画）默认用此章；供中枢感知选中章上下文） */
  currentChapter?: {
    index: number;
    title?: string;
    /** 审查状态（pass/revise/…，null=未审查） */
    status?: string | null;
    words?: number;
    versionCount?: number;
  } | null;
  /** 自动连载是否运行中（服务端定时任务；中枢感知系统时机，冲突时拒绝写操作） */
  autoRunning?: boolean;
  /** 世界构建中阶段文案（壳就绪进页面后后台仍在增强蓝图/章节；非空时中枢显示"世界构建中"而非待命） */
  buildingStage?: string | null;
}> = ({ open, onClose, world, brainState, onWorldUpdate, onProposalTalk, onOpenPanel, currentChapter, autoRunning, buildingStage }) => {
  const {
    sessions, activeId, messages, streaming, thinking, reconnecting,
    openSession, newSession, removeSession, truncate, appendMsg, send, stop, isStreaming,
    completed, markCompleted,
  } = useBrainSession(world.title);

  const [input, setInput] = useState("");
  const [executing, setExecuting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  /** 已关闭窗口的会话（仅从 tab 栏隐藏，不删除会话记录；历史中可重新打开） */
  const [closedTabs, setClosedTabs] = useState<Set<string>>(new Set());
  /** 历史会话删除二次确认：pendingDelete 为等待确认的会话 id（3s 未确认自动恢复） */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** 已执行完成的卡片 key（`消息id:卡片下标[:列表项id]`）：useBrainSession 管理，服务端持久化（刷新后恢复） */
  // completed / markCompleted 来自 useBrainSession
  /** 媒体生成输入条：所选章节 / 张数（默认当前选中章 / 1 张；张数偏好持久化到 localStorage） */
  const [mediaChapter, setMediaChapter] = useState<string>("");
  const [mediaCount, setMediaCount] = useState<number>(() => {
    const p = readCabinPrefs().mediaCount;
    return p && Number.isInteger(p) ? Math.min(4, Math.max(1, p)) : 1;
  });
  /** 服务端系统状态快照（/api/brain/context 按需拉取）：自动连载/写作任务/媒体生成/视觉任务/待办——中枢全知的服务端权威部分 */
  const [serverCtx, setServerCtx] = useState<{
    autoRunning?: boolean; autoPhase?: string; pendingCommit?: { index: number | null; title: string } | null;
    advanceTaskRunning?: boolean; advancePhase?: string; mediaGenerating?: boolean; visualRunning?: boolean;
    pendingProposals?: number; pendingCards?: number; openDebt?: number; reviseChapters?: number[];
  }>({});
  // 打开面板时拉取服务端状态快照（索引式全知：按需，不每轮注入 LLM）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/brain/context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: world.title }),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { context?: typeof serverCtx };
        if (!cancelled && data.context) setServerCtx(data.context);
      } catch { /* 静默：快照拉取失败不阻塞聊天 */ }
    })();
    return () => { cancelled = true; };
  }, [open, world.title]);
  /** 已手动展开的任务/指令类消息（默认折叠为摘要行，点击展开） */
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
  /** 聊天内写作进度（推进剧情/连载）：流式显示阶段与正文，结束后追加结果卡 */
  const [writing, setWriting] = useState<{ title: string; phase: string; text: string; status: "running" | "done" | "failed"; detail?: string } | null>(null);
  const writingAbortRef = useRef<AbortController | null>(null);
  const writingTimerRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 面板宽度：左侧边缘可拖拽改宽（localStorage 记住；窄屏忽略存储宽度强制全宽）
  const MIN_PANEL_W = 320, MAX_PANEL_W = 760;
  const [panelWidth, setPanelWidth] = useState<number | null>(() => {
    const v = readCabinPrefs().panelWidth;
    return v != null && v >= MIN_PANEL_W && v <= MAX_PANEL_W ? v : null;
  });
  const panelWidthRef = useRef<number | null>(panelWidth);
  const resizeStartRef = useRef<{ x: number; w: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    if (typeof window !== "undefined" && window.innerWidth <= 640) return;
    resizeStartRef.current = { x: e.clientX, w: panelWidthRef.current ?? 440 };
    setResizing(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const s = resizeStartRef.current;
    if (!s) return;
    const w = Math.min(MAX_PANEL_W, Math.max(MIN_PANEL_W, s.w + (s.x - e.clientX)));
    panelWidthRef.current = w;
    setPanelWidth(w);
  }
  function onResizeEnd() {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setResizing(false);
    writeCabinPrefs({ panelWidth: panelWidthRef.current ?? undefined });
  }
  // 挂载后恢复上次拖拽的输入区高度（localStorage 偏好；CSS min/max 已钳制）
  useEffect(() => {
    const h = readCabinPrefs().inputHeight;
    if (h && inputRef.current) {
      const MIN = 48, MAX = 176;
      inputRef.current.style.height = `${Math.min(MAX, Math.max(MIN, h))}px`;
    }
  }, []);
  /** 是否停留在消息流底部（用户上翻查看历史时不强制拉回） */
  const stickBottomRef = useRef(true);
  const delTimerRef = useRef<number | null>(null);

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

  /** 历史会话删除二次确认：首次点击进入确认态（3s 自动恢复），再点才删除 */
  function confirmDeleteSession(id: string) {
    if (pendingDelete === id) {
      if (delTimerRef.current) window.clearTimeout(delTimerRef.current);
      setPendingDelete(null);
      setClosedTabs((prev) => { const n = new Set(prev); n.delete(id); return n; });
      void removeSession(id);
      return;
    }
    setPendingDelete(id);
    if (delTimerRef.current) window.clearTimeout(delTimerRef.current);
    delTimerRef.current = window.setTimeout(() => setPendingDelete(null), 3000);
  }

  // 打开面板卡（open_* 显式协议）→ onOpenPanel 统一分发触发对应弹窗；
  // 用户与中枢聊「新角色提案」话题（返回提案浏览卡）→ 通知 Home 恢复底部提案区显示（无 onOpenPanel 时兼容旧回调）；
  // 同一消息只通知一次（历史会话加载旧卡片也视为已浏览，可接受）
  const panelNotifiedRef = useRef<string>("");
  useEffect(() => {
    if (!onOpenPanel && !onProposalTalk) return;
    const open = findOpenPanelCard(messages);
    const key = open ? `${open.messageId}:${open.target}` : "";
    if (open && key && key !== panelNotifiedRef.current) {
      panelNotifiedRef.current = key;
      if (onOpenPanel) onOpenPanel(open.target, open.opts);
      else if (open.target === "proposals" && onProposalTalk) onProposalTalk();
      return;
    }
    // 兼容旧协议：open_proposals 老卡（无 open 字段，仅 title 约定）
    if (!open && onProposalTalk) {
      const id = findProposalCardMessageId(messages);
      if (id && id !== panelNotifiedRef.current) {
        panelNotifiedRef.current = id;
        onProposalTalk();
      }
    }
  }, [messages, onOpenPanel, onProposalTalk]);

  // 智能滚动：仅当用户停留在底部时才跟随新内容（上翻查看历史不被打断）；发送/切换会话强制回到底部
  const stickToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const onStreamScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const lastScrollKeyRef = useRef("");
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const key = `${messages.length}:${messages[messages.length - 1]?.text?.length ?? 0}:${thinking}`;
    if (key === lastScrollKeyRef.current) return;
    lastScrollKeyRef.current = key;
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);
  useEffect(() => { if (open) stickToBottom(); }, [open, activeId]);

  function appendBrainMsg(cards: BrainCard[]) {
    if (!activeId) return;
    appendMsg(activeId, { id: uuid(), role: "brain", cards, at: new Date().toISOString() });
  }

  if (!open) return null;

  // presence/activity：服务端轮询有延迟，前端在生成/思考/写作/重连/世界构建时即时覆盖（与运行状态同步，避免「正在生成却显示待命」）
  const liveActivity: Activity = buildingStage
    ? "housekeeping" // 世界构建中（后台增强蓝图/章节）→ 事务处理
    : streaming || thinking || writing?.status === "running"
      ? "directing"
      : (brainState?.activity ?? "idle");
  const livePresence: Presence = reconnecting ? "alert"
    : buildingStage ? "awake" // 世界构建中 → 觉醒（区别于待命/休眠）
    : (streaming || thinking || writing?.status === "running") ? "focused"
    : (brainState?.presence ?? "standby");
  const presence = livePresence;
  const activity = liveActivity;
  const governance = brainState?.governance ?? "passthrough";

  // —— 输入框上方上下文操作区：当前会话话题 + 未决交互（二次确认/意见征询/待执行）+ 连载进度 ——
  const activeSessionTitle = sessions.find((s) => s.id === activeId)?.title ?? "";
  const lastBrainMsg = [...messages].reverse().find((m) => m.role === "brain");
  const lastCards = lastBrainMsg?.cards ?? [];
  const ctxCard = lastCards.find(
    (c) => c.kind === "confirm" || c.kind === "plan" || c.kind === "opinion" || (c.kind === "preview" && (c as PreviewCard).confirmRequired)
  ) as (BrainCard & { options?: ChoiceOption[] }) | undefined;
  const ctxCardIdx = ctxCard ? lastCards.indexOf(ctxCard) : -1;
  /** ctx-bar 对应卡片是否已完成（confirm 已处理 / preview 已执行）：完成则禁用，防重复触发后端操作 */
  const ctxCardDone = ctxCardIdx >= 0 && !!lastBrainMsg && completed.has(`${lastBrainMsg.id}:${ctxCardIdx}`);
  /** 媒体生成输入条：识别最后一条消息中的媒体 form 卡（「帮我生成插画」→ 输入区上方出现章节/张数选择） */
  const mediaCtxCard = (() => {
    if (!lastBrainMsg) return undefined;
    const c = lastBrainMsg.cards?.[lastBrainMsg.cards.length - 1];
    if (c?.kind === "form" && c.action.endpoint === "/api/novel/media/plan") return c as FormCard;
    return undefined;
  })();
  const mediaCtxIdx = mediaCtxCard && lastBrainMsg ? lastBrainMsg.cards!.indexOf(mediaCtxCard) : -1;
  const mediaCtxDone = mediaCtxIdx >= 0 && !!lastBrainMsg && completed.has(`${lastBrainMsg.id}:${mediaCtxIdx}`);
  // 新卡出现（或默认值变化）时重置选择为默认（默认当前选中章 / 1 张；服务端 buildMediaCard 已兜底）
  useEffect(() => {
    if (mediaCtxCard) {
      setMediaChapter(String(mediaCtxCard.fields[0]?.value ?? ""));
      setMediaCount(Number(mediaCtxCard.fields[1]?.value ?? 1));
    }
  }, [mediaCtxCard?.title, mediaCtxCard?.fields?.[0]?.value, mediaCtxCard?.fields?.[1]?.value]);
  const ctxBusy = streaming || executing;
  /** 追问选择面板：最后一条含 ask 卡（未选择）的中枢消息 → 输入框上方询问；选择后作为新输入继续（sessionStorage 持久化已答，刷新恢复未答） */
  const [askAnswered, setAskAnswered] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(`brain-ask-answered-${activeId ?? ""}`) ?? "[]")); } catch { return new Set(); }
  });
  const pendingAsk = findPendingAskCard(messages, askAnswered);
  /** 选择 ask 选项：记入已答（sessionStorage，刷新不恢复）并以选项文本继续对话 */
  function answerAsk(label: string, msgId: string) {
    const next = new Set(askAnswered);
    next.add(msgId);
    setAskAnswered(next);
    try { sessionStorage.setItem(`brain-ask-answered-${activeId ?? ""}`, JSON.stringify([...next])); } catch { /* 隐私模式等忽略 */ }
    void doSend(label);
  }
  const runningStatus = (() => {
    if (reconnecting) return "连接已断开，正在重连…";
    if (buildingStage) return `世界构建中：${buildingStage}`;
    if (streaming) return "中枢正在生成回复…";
    if (thinking) return "中枢正在思考…";
    if (activity !== "idle") return `中枢正在${ACTIVITY_LABEL[activity]}`;
    return "";
  })();

  /** 前端系统快照（注入 /api/brain/chat ctx）：选中章详情 + 系统时机 + presence/activity + 自动连载。
   *  中枢据此感知「系统正在做什么/处于什么时机/是否冲突」，生成更准确的操作。 */
  const chatCtx = {
    chapterIndex: currentChapter?.index ?? null,
    chapterTitle: currentChapter?.title ?? null,
    chapterStatus: currentChapter?.status ?? null,
    chapterWords: currentChapter?.words ?? null,
    versionCount: currentChapter?.versionCount ?? null,
    systemStatus: runningStatus || null,
    writingRunning: writing?.status === "running",
    presence: brainState?.presence ?? null,
    activity: brainState?.activity ?? null,
    autoRunning: autoRunning ?? false,
    server: serverCtx,
  };

  return (
    <div className="brain-cabin-mask" onClick={onClose}>
      <div
        className="brain-cabin"
        style={panelWidth != null && (typeof window === "undefined" || window.innerWidth > 640) ? { width: panelWidth } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧拖拽改宽手柄（pointer capture 持续跟踪，浏览器记住宽度） */}
        <div
          className={`bc-resize-handle${resizing ? " dragging" : ""}`}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title="拖拽调整面板宽度"
        />
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
                    className={`bc-history-del${pendingDelete === s.id ? " confirm" : ""}`}
                    title={pendingDelete === s.id ? "再次点击确认删除" : "删除会话"}
                    onClick={(e) => { e.stopPropagation(); confirmDeleteSession(s.id); }}
                  >{pendingDelete === s.id ? "确认删除？" : "删除"}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 中部：对话流 */}
        {!showHistory && (
        <div className="brain-cabin-stream" ref={scrollRef} onScroll={onStreamScroll}>
          {messages.length === 0 && (
            <div className="brain-cabin-empty">
              <p className="bc-empty-title">直接输入，开启与中枢的对话</p>
              <div className="bc-quick-row">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q.label} className="bc-quick-chip" disabled={streaming} onClick={() => void doSend(q.prompt)} title={q.prompt}>
                    {q.label}
                  </button>
                ))}
              </div>
              <p className="bc-hint">也可以直接输入，如：「再写一章」「这本书质量怎么样」「给第三章配张插画」</p>
            </div>
          )}
          {groupMessages(messages).map((group) => (
            <div className="bc-msg-group" key={group[0]?.id ?? "group"}>
            {group.map((msg) => {
            // 任务/指令类消息默认折叠为摘要行；纯文本超长回复（>FOLD_TEXT_THRESHOLD）也折叠；未决确认（confirm 卡）与生成中强制展开
            const collapsible = isCollapsibleMsg(msg);
            const longText = shouldFoldLongText(msg);
            const hasConfirm = (msg.cards ?? []).some((c) => c.kind === "confirm");
            const folded = (collapsible || longText) && !msg.pending && !hasConfirm && !expandedMsgs.has(msg.id);
            // 滚动吸附：每条用户提问 sticky 吸顶（CSS 处理），当前视口内 AI 回复对应的提问自然吸附在顶部
            return (
            <div key={msg.id} className={`bc-msg bc-msg-${msg.role}`}>
              {msg.role === "brain" && <BrainCore presence={presence} activity={activity} size="mini" animated={false} />}
              <div className="bc-msg-content">
                {folded ? (
                  <button className="bc-msg-fold" onClick={() => setExpandedMsgs((prev) => { const n = new Set(prev); n.add(msg.id); return n; })} title="展开查看详情">
                    <span className="bc-fold-caret">▸</span>
                    <span className="bc-fold-text">{msgCollapseSummary(msg)}</span>
                    <span className="bc-fold-meta">{(msg.cards?.length ?? 0) > 1 ? `卡片 ×${msg.cards?.length}` : ""}</span>
                  </button>
                ) : (
                  <>
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
                {msg.cards?.filter((c) => c.kind !== "ask").map((card, i) => (
                  <BrainCardView
                    key={i}
                    card={card}
                    busy={streaming || executing}
                    completed={completed.has(`${msg.id}:${i}`)}
                    completedItems={card.kind === "browse" ? completedItemIdsOf(completed, msg.id, i) : undefined}
                    onExecute={(card2, action) => executeCard(card2, action, msg.id, i)}
                    onConfirmChoose={(opt) => confirmChoose(opt, msg, i)}
                    onOption={handleOption}
                    onFormSubmit={(card2, values) => submitForm(card2, values, msg.id, i)}
                  />
                ))}
                {/* 消息操作区：时间戳 + 收起（可折叠消息展开态，位于时间之后、功能按钮之前）+ 复制（user 额外编辑）；pending 时不显示 */}
                {!msg.pending && (msg.text || (msg.cards?.length ?? 0) > 0) && (
                  <div className="bc-msg-ops">
                    <span className="bc-msg-time" title={fmtAbsTime(msg.at)}>{fmtTime(new Date(msg.at).getTime())}</span>
                    {(collapsible || longText) && !hasConfirm && (
                      <button className="bc-msg-op" onClick={() => setExpandedMsgs((prev) => { const n = new Set(prev); n.delete(msg.id); return n; })} title="折叠此消息">▾ 收起</button>
                    )}
                    {msg.role === "user" && (
                      <button className="bc-msg-op" onClick={() => editPrompt(msg)} disabled={streaming || thinking} title="编辑并重发（截断后续对话）">✎ 编辑</button>
                    )}
                    <button className="bc-msg-op" onClick={() => void copyText(msg.text ?? "")} disabled={!msg.text} title="复制消息内容">⧉ 复制</button>
                  </div>
                )}
                  </>
                )}
              </div>
            </div>);
            })}
            </div>
          ))}
          {/* 聊天内写作进度（推进剧情/连载）：流式显示阶段与正文 */}
          {writing && (
            <BrainCardView
              card={{ kind: "progress", title: writing.title, phase: writing.phase, text: writing.text, status: writing.status, detail: writing.detail }}
              onCancelProgress={writing.status === "running" ? stopWriting : undefined}
            />
          )}
        </div>
        )}

        {/* 输入框上方上下文操作区：会话话题 + 媒体生成输入条 + 二次确认/意见征询按钮；无内容时整条隐藏 */}
        {!showHistory && (activeSessionTitle || ctxCard || mediaCtxCard || runningStatus) && (
          <div className="bc-context-bar">
            <div className="bc-context-main">
              {activeSessionTitle && <span className="bc-context-session" title="当前会话">{activeSessionTitle}</span>}
              {runningStatus && <span className={`bc-context-status${reconnecting ? " bc-status-warn" : ""}`}>{runningStatus}</span>}
            </div>
            {mediaCtxCard && (
              <div className="bc-media-bar">
                <span className="bc-context-label">{mediaCtxDone ? "✓ 已生成" : "生成插画"}</span>
                <label className="bc-media-field">章节
                  <select
                    value={mediaChapter}
                    disabled={ctxBusy || mediaCtxDone}
                    onChange={(e) => setMediaChapter(e.target.value)}
                    title="选择要生成插画的章节"
                  >
                    {(mediaCtxCard.fields[0]?.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label className="bc-media-field">张数
                  <input
                    type="number" min={1} max={4} value={mediaCount}
                    disabled={ctxBusy || mediaCtxDone}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(4, Number(e.target.value) || 1));
                      setMediaCount(v);
                      writeCabinPrefs({ mediaCount: v }); // 偏好持久化（纯本地，服务端不受影响）
                    }}
                    title="生成张数（1-4）"
                  />
                </label>
                <button
                  className="bc-ctx-btn primary"
                  disabled={ctxBusy || mediaCtxDone || !lastBrainMsg || mediaCtxIdx < 0}
                  onClick={() => lastBrainMsg && mediaCtxIdx >= 0 && submitForm(mediaCtxCard, { chapterIndex: mediaChapter, count: mediaCount }, lastBrainMsg.id, mediaCtxIdx)}
                  title="按所选章节与张数生成插画（生成前校验时机，中断不影响系统）"
                >
                  生成
                </button>
              </div>
            )}
            {pendingAsk && (
              <div className="bc-ask-bar">
                <span className="bc-context-label">需要确认</span>
                <span className="bc-ask-question">{pendingAsk.ask.question}</span>
                <div className="bc-ask-options">
                  {pendingAsk.ask.options?.map((o, i) => (
                    <button key={i} className="bc-ctx-btn" disabled={ctxBusy} onClick={() => answerAsk(o.label, pendingAsk.msgId)} title={o.description}>{o.label}</button>
                  ))}
                </div>
              </div>
            )}
            {ctxCard && (
              <div className="bc-context-actions">
                {ctxCard.kind === "confirm" && (
                  <>
                    <span className="bc-context-label">{ctxCardDone ? "已处理" : "待确认"}</span>
                    <button className="bc-ctx-btn" disabled={ctxBusy || ctxCardDone} onClick={() => confirmChoose("merge", lastBrainMsg)} title="合并本次改动">合并</button>
                    <button className="bc-ctx-btn" disabled={ctxBusy || ctxCardDone} onClick={() => confirmChoose("rewrite", lastBrainMsg)} title="按计划重写受影响章节">重写</button>
                    <button className="bc-ctx-btn danger" disabled={ctxBusy || ctxCardDone} onClick={() => confirmChoose("abort", lastBrainMsg)} title="放弃本次操作">放弃</button>
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
                  <button className="bc-ctx-btn primary" disabled={ctxBusy || ctxCardDone} onClick={() => executeCard(ctxCard, undefined, lastBrainMsg?.id, ctxCardIdx >= 0 ? ctxCardIdx : undefined)} title="执行此操作">{ctxCardDone ? "✓ 已执行" : "执行操作"}</button>
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
            placeholder={streaming ? "中枢正在回复…（可继续输入，生成结束后发送）" : "对中枢说点什么…（Enter 发送，Shift+Enter 换行）"}
            rows={2}
          />
          {streaming ? (
            <button className="bc-send bc-send-stop" onClick={stop} title="中断生成（保留已输出内容）" aria-label="中断生成">
              <Square size={16} />
            </button>
          ) : (
            <button className="bc-send bc-send-go" onClick={() => void doSend()} disabled={!input.trim() || executing} title="发送" aria-label="发送">
              <Send size={16} />
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
      // 拖拽结束：保存输入区高度偏好（纯本地；服务端不感知，无一致性风险）
      const h = ta.getBoundingClientRect().height;
      writeCabinPrefs({ inputHeight: Math.round(h) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }

  /** 发送：无 activeId 时自动新建会话（直接输入即首次对话）；text 参数供空态快捷提问复用 */
  async function doSend(text?: string) {
    const prompt = (text ?? input).trim();
    if (!prompt || streaming || executing) return;
    // 用户直接输入新消息（而非点选 ask 选项）→ 视为已回答待决追问，避免面板永久残留
    if (!text && pendingAsk) {
      const next = new Set(askAnswered);
      next.add(pendingAsk.msgId);
      setAskAnswered(next);
      try { sessionStorage.setItem(`brain-ask-answered-${activeId ?? ""}`, JSON.stringify([...next])); } catch { /* 忽略 */ }
    }
    setInput("");
    stickToBottom(); // 发送后新消息滚动跟随
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

  /** 操作被前置校验拦截时的反馈：追加失败结果卡；若最后一条消息已是同标题+原因的失败卡则不重复（防刷屏） */
  function notifyBlocked(title: string, reason: string) {
    const last = messages[messages.length - 1];
    const lastCard = last?.cards?.[last.cards.length - 1];
    if (lastCard?.kind === "result" && lastCard.title === title && lastCard.detail === reason) return;
    appendBrainMsg([{ kind: "result", title, success: false, detail: reason }]);
  }

  /** 统一操作守卫：不可执行时反馈原因并返回 true（调用方直接 return，不发请求、不标记完成） */
  function guardBlocked(act: { endpoint: string; body?: Record<string, unknown> }, title: string): boolean {
    const reason = guardAction(act, {
      executing, streaming,
      writingRunning: writing?.status === "running",
      world,
    });
    if (reason) {
      notifyBlocked(title, reason);
      return true;
    }
    return false;
  }

  /** 计划/意见选项卡点击：有动作则执行并回执；纯说明则记录选择 */
  async function handleOption(option: ChoiceOption) {
    if (!option.action) {
      appendBrainMsg([{ kind: "result", title: option.label, success: true, detail: option.description ?? "已选择，中枢将据此继续" }]);
      return;
    }
    if (guardBlocked(option.action, option.label)) return;
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

  /** 标记消息内某张卡片已执行完成（preview/form/confirm：按钮替换为完成标记；browse 卡按 itemId 标记列表项）。
   *  经 useBrainSession.markCompleted 持久化到服务端——刷新页面后完成态不丢失。 */
  function markCardDone(msgId?: string, cardIndex?: number, itemId?: string) {
    if (!msgId || cardIndex == null) return;
    const key = itemId ? `${msgId}:${cardIndex}:${itemId}` : `${msgId}:${cardIndex}`;
    void markCompleted(key);
  }

  /** 中断聊天内写作任务（abort SSE，服务端经 req.signal 在阶段边界丢弃草稿） */
  function stopWriting() {
    writingAbortRef.current?.abort();
  }

  /**
   * 推进剧情 / 自动连载聊天内流式执行：POST SSE 读取写作过程，实时更新 progress 卡
   * （阶段步骤 + delta 正文），终态（result/pending-commit/auto-done/interrupted）落定后
   * 追加 result 卡到会话并刷新世界。
   */
  /** 返回是否成功：中断/失败为 false（调用方不标记卡片完成态，用户可重试） */
  async function streamWritingTask(title: string, act: { endpoint: string; method?: string; body: Record<string, unknown> }, cardTitle: string): Promise<boolean> {
    const ctrl = new AbortController();
    writingAbortRef.current = ctrl;
    // 清掉上一次任务的收起定时器，避免任务 A 结束后 2.5s 内启动任务 B 时把 B 的进度卡提前收起
    if (writingTimerRef.current) window.clearTimeout(writingTimerRef.current);
    setWriting({ title: cardTitle, phase: "start", text: "", status: "running" });
    let finalText = "";
    let ended: "done" | "failed" | "running" = "running"; // 流式终态跟踪
    type W = { title: string; phase: string; text: string; status: "running" | "done" | "failed"; detail?: string };
    const patch = (p: Partial<W> | ((w: W) => Partial<W>)) =>
      setWriting((w) => (w ? { ...w, ...(typeof p === "function" ? p(w) : p) } : w));
    try {
      const res = await apiFetch(act.endpoint, {
        method: act.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...act.body, title }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = String(err.error ?? `HTTP ${res.status}`);
        ended = "failed";
        patch({ status: "failed", detail: msg });
        appendBrainMsg([{ kind: "result", title: cardTitle, success: false, detail: msg }]);
        return false;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(line.slice(6)); } catch { continue; }
          const phase = String(obj.phase ?? "");
          if (phase === "delta") {
            finalText += String(obj.delta ?? "");
            patch({ phase, text: finalText });
          } else if (phase === "result") {
            ended = "done";
            const r = (obj.result ?? {}) as { chapter?: { index?: number; title?: string } };
            patch({ phase, status: "done", text: finalText, detail: `第 ${r.chapter?.index ?? ""} 章《${r.chapter?.title ?? ""}》已完成` });
          } else if (phase === "auto-done") {
            ended = "done";
            const r = (obj.report ?? {}) as { written?: number; target?: number; reason?: string };
            patch({ phase, status: "done", text: finalText, detail: `连载完成：${r.written ?? 0}/${r.target ?? 0} 章（${String(r.reason ?? "")}）` });
          } else if (phase === "pending-commit") {
            ended = "done";
            patch({ phase, status: "done", text: finalText, detail: `第 ${String(obj.chapterIndex ?? "")} 章审查已通过，等待确认入册` });
          } else if (phase === "interrupted") {
            ended = "failed";
            patch({ phase, status: "failed", text: finalText, detail: "写作已中断（阶段边界丢弃草稿）" });
          } else if (phase === "start" || phase === "writing" || phase === "selfcheck" || phase === "reviewing" || phase === "patching" || phase === "settling" || phase === "saving" || phase === "auto-status") {
            patch({ phase, text: finalText });
          }
        }
      }
      // 流正常关闭但未收到终态：任务已完成（SSE 在 result 后关闭）；兜底收尾
      if (ended === "running") ended = "done";
      patch((w) => (w!.status === "running" ? { status: "done", detail: "任务已结束" } : {}));
      appendBrainMsg([{ kind: "result", title: cardTitle, success: ended === "done", detail: ended === "done" ? "写作已完成，正文已更新" : "写作未完成" }]);
      return ended === "done";
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      ended = "failed";
      patch(aborted ? { status: "failed", detail: "写作已中断" } : { status: "failed", detail: (e as Error).message });
      if (!aborted) appendBrainMsg([{ kind: "result", title: cardTitle, success: false, detail: (e as Error).message }]);
      return false;
    } finally {
      writingAbortRef.current = null;
      // 保留 progress 卡 2.5s 展示终态后收起（result 卡已入会话）
      writingTimerRef.current = window.setTimeout(() => setWriting(null), 2500);
    }
  }

  /** 执行卡片操作（msgId/cardIndex 供成功后标记完成态） */
  async function executeCard(card: BrainCard, action?: { endpoint: string; method?: string; body: Record<string, unknown> }, msgId?: string, cardIndex?: number) {
    const act = action ?? (card.kind === "preview" ? card.action : undefined);
    if (!act) return;
    const cardTitle = card.kind === "ask" ? "" : card.title; // AskCard 无 title（且无 action 走不到这里，收窄用）
    if (guardBlocked(act, cardTitle)) return; // 前置校验：不可执行时反馈原因，不发请求（服务端仍兜底权威）
    setExecuting(true);
    try {
      // 推进剧情 / 自动连载：聊天内流式显示写作过程（progress 卡实时阶段+正文），结束后 result 卡回执；
      // 仅成功才标记卡片完成（中断/失败保留按钮，用户可重试）
      if (act.endpoint === "/api/novel/step" || act.endpoint === "/api/novel/auto/start") {
        const ok = await streamWritingTask(world.title, act, cardTitle);
        if (ok) markCardDone(msgId, cardIndex);
        onWorldUpdate?.();
        return;
      }
      // 媒体生成（插画/视频）：image 为异步任务，提交后轮询 /media/status，完成后刷新世界并回执
      if (act.endpoint === "/api/novel/media/generate") {
        const res = await apiFetch(act.endpoint, {
          method: act.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(act.body),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; mediaIds?: string[]; mediaId?: string; error?: string };
        if (!res.ok || data.error) {
          appendBrainMsg([{ kind: "result", title: cardTitle, success: false, detail: String(data.error ?? `HTTP ${res.status}`) }]);
          return;
        }
        const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
        const chapterIndex = Number(act.body.chapterIndex);
        if (ids.length) {
          appendBrainMsg([{ kind: "result", title: cardTitle, success: true, detail: `生成任务已提交（${ids.length} 项），完成后自动显示` }]);
          pollMediaGen(world.title, chapterIndex, ids, cardTitle);
        } else {
          appendBrainMsg([{ kind: "result", title: cardTitle, success: true, detail: "已提交生成任务" }]);
        }
        markCardDone(msgId, cardIndex);
        onWorldUpdate?.();
        return;
      }
      const r = await fetchAction(act.endpoint, act.method ?? "POST", act.body);
      appendBrainMsg([{ kind: "result", title: cardTitle, success: r.success, detail: r.detail }]);
      if (r.success) {
        // gacha 全部应用（auto:true）：pendingCards 一次性消耗，标记本卡全部列表项完成（刷新后保持「已处理」）
        if (act.endpoint === "/api/novel/gacha" && act.body.action === "apply" && act.body.auto === true && card.kind === "browse") {
          const list = (card.data as { list?: { id?: unknown }[] } | null)?.list ?? [];
          for (const c of list) if (c?.id) markCardDone(msgId, cardIndex, String(c.id));
        }
        markCardDone(msgId, cardIndex, card.kind === "browse" ? actionItemId(act.body) : undefined);
        onWorldUpdate?.();
      }
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: cardTitle, success: false, detail: (e as Error).message }]);
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

  /** ConfirmCard 确认（L2/L3 三选一；msg/cardIndex 供成功后标记 confirm 与 preview 卡完成态） */
  async function confirmChoose(opt: "merge" | "rewrite" | "abort", msg?: ChatMessage, cardIndex?: number) {
    if (opt === "abort") {
      appendBrainMsg([{ kind: "result", title: "已放弃", success: true, detail: "用户选择放弃本次操作" }]);
      // 放弃同样标记 confirm/preview 卡完成，防 ctx-bar 与消息内按钮重复触发
      const cards = msg?.cards ?? [];
      const confirmIdx = cardIndex ?? cards.findIndex((c) => c.kind === "confirm");
      if (msg && confirmIdx >= 0) markCardDone(msg.id, confirmIdx);
      const pIdx = cards.findIndex((c) => c.kind === "preview");
      if (pIdx >= 0) markCardDone(msg?.id, pIdx);
      return;
    }
    const cards = msg?.cards;
    const action = findPreviewAction(cards);
    if (!action) {
      appendBrainMsg([{ kind: "result", title: "无法执行", success: false, detail: "未找到操作端点" }]);
      return;
    }
    if (guardBlocked(action, `已执行（${opt}）`)) return; // 前置校验：系统忙/写作运行中/资源已消耗时拦截
    setExecuting(true);
    try {
      const body = { ...action.body, strategy: opt };
      const r = await fetchAction(action.endpoint, action.method ?? "POST", body);
      appendBrainMsg([{ kind: "result", title: `已执行（${opt}）`, success: r.success, detail: r.detail }]);
      if (r.success) {
        // 自动定位 confirm 卡下标（ctx-bar 调用未传 cardIndex 时也能标记完成态，防重复提交）
        const confirmIdx = cardIndex ?? (cards ?? []).findIndex((c) => c.kind === "confirm");
        if (confirmIdx >= 0) markCardDone(msg?.id, confirmIdx); // confirm 卡完成
        const pIdx = (cards ?? []).findIndex((c) => c.kind === "preview");
        if (pIdx >= 0) markCardDone(msg?.id, pIdx); // 连带 preview 卡完成（防重复执行）
        onWorldUpdate?.();
      }
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
  async function submitForm(card: FormCard, values: Record<string, unknown>, msgId?: string, cardIndex?: number) {
    if (guardBlocked(card.action, card.title)) return; // 前置校验：系统忙/写作运行中拦截
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
        markCardDone(msgId, cardIndex); // 表单已完成，追加 preview 卡
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
        markCardDone(msgId, cardIndex); // 表单已完成，进入确认阶段
        appendBrainMsg([preview, confirm]);
        return;
      }
      markCardDone(msgId, cardIndex);
      appendBrainMsg([{ kind: "result", title: card.title, success: true, detail: "已保存" }]);
      onWorldUpdate?.();
    } catch (e) {
      appendBrainMsg([{ kind: "result", title: card.title, success: false, detail: (e as Error).message }]);
    } finally {
      setExecuting(false);
    }
  }
};
