// 中枢对话舱（BrainCabin）：常驻侧边抽屉，卡片式浏览 + 智能控制入口
// 顶部：印灵大图 + 四维状态脉象 + 右上角无边框 icon 操作组（新建/历史/关闭）；会话横滑栏；
// 中部：对话流（富文本 Markdown + 卡片 + loading 骨架）或历史会话视图（可删除/切换）；底部：输入条 + 发送/中断（上边界可拖高）
// 直接输入即开启首次对话（无需先点新建）；历史 icon 切换下方为历史列表
// 接入 /api/brain/chat SSE（协议 v2）：intent/delta/card/done/interrupted/reset
// 多会话：useBrainSession（服务端持久化 + 独立 SSE 连接，切换 tab 不打断；刷新自动续流）
import { useEffect, useRef, useState } from "react";
import { BrainCore } from "./BrainCore";
import { History, Plus, Send, Square, X } from "./icons";
import { BrainCardView, mediaPlanDerived, type BrainCard, type PreviewCard, type ChoiceOption, type FormCard, type FormField, type AskCard, type PanelIntent } from "./brain-cards";
import { MarkdownView } from "./MarkdownView";
import { useBrainSession, type BrainSyncSession, type ChatMessage } from "./useBrainSession";
import { useBrainSyncState } from "./syncStateStore";
import { apiFetch } from "../api/client";
import { uuid } from "../shared/uuid";
import { MAX_IMAGES_PER_CHAPTER, imageOccupiesQuota } from "../shared/media-const";
import {
  PRESENCE_LABEL, ACTIVITY_LABEL, GOVERNANCE_LABEL,
  type BrainState, type Presence, type Activity,
} from "../api/brain-state";
import type { WorldState } from "../api/world";

/** 从消息卡片中找 PreviewCard 的 action（供 ConfirmCard 确认时执行） */
function findPreviewAction(cards?: BrainCard[]): PreviewCard["action"] | undefined {
  const confirm = cards?.find((c) => c.kind === "confirm" && c.action);
  if (confirm?.kind === "confirm") return confirm.action;
  const p = cards?.find((c): c is PreviewCard => c.kind === "preview");
  return p?.action;
}

/** 消息中是否有媒体生成 form 卡（/api/novel/media/plan） */
export function mediaCardOf(msg: ChatMessage): FormCard | undefined {
  return msg.cards?.find((c): c is FormCard => c.kind === "form" && c.action?.endpoint === "/api/novel/media/plan");
}

/** 媒体生成 form 卡消息的提示性正文：跟随卡片当前选择的章节/张数动态生成（去「正在…生成」的误导——
 *  此时仅收集参数，尚未开始生成）。推导复用 brain-cards.mediaPlanDerived（与卡内 summary 同源、同 clamp）；
 *  章节未选（异常）时退化为提示语。 */
export function mediaGuideText(card: FormCard, values?: Record<string, unknown>): string {
  const { kind, chapterLabel, count } = mediaPlanDerived(card, values);
  if (!chapterLabel) {
    return kind === "video" ? "请选择生成视频的章节，确认后开始生成。" : "请选择生成插画的参数（章节与张数），确认后开始生成。";
  }
  return kind === "video"
    ? `为「${chapterLabel}」生成 1 段视频，确认后开始生成。`
    : `为「${chapterLabel}」生成 ${count} 张插画，确认后开始生成。`;
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
type CabinPrefs = { inputHeight?: number; panelWidth?: number };

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
export function findOpenPanelCard(messages: ChatMessage[]): { messageId: string; cardId: string; panelIntent: PanelIntent } | null {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const m = messages[mi];
    for (let ci = (m.cards?.length ?? 0) - 1; ci >= 0; ci--) {
      const card = m.cards![ci] as BrainCard & { open?: { target?: unknown; opts?: Record<string, unknown> }; panelIntent?: PanelIntent };
      if (card.panelIntent && !card.panelIntent.consumedAt && card.cardId) {
        return { messageId: m.id, cardId: card.cardId, panelIntent: card.panelIntent };
      }
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
  /** 系统事件信号：Home 注入系统消息到聊天会话后递增；聊天舱内实时重拉会话（显示最新【系统】条） */
  sysTick?: number;
  /** 卡片就地更新注册（阶段 3a）：挂载时注册 patch 处理器，Home 的 useSyncChannel 收到 card-update 后调用。
   *  @param fn 处理器（接收 card-update 事件）；卸载时传入空函数解绑。 */
  registerCardPatch?: (fn: (e: { sessionId: string; messageId: string; cardId: string; patch: Record<string, unknown> }) => void) => void;
  /** 卡片整体替换注册：Home 的 useSyncChannel 收到 card-replaced（服务端权威翻卡）后调用，
   *  按 messageId+cardIndex 就地整卡替换（persist=false，不回写 HTTP、不重拉会话）。 */
  registerCardReplace?: (fn: (e: { sessionId: string; messageId: string; cardIndex: number; card: Record<string, unknown> }) => void) => void;
  /** sync WS 权威会话快照：覆盖所有 Tab 的消息/pending/running 卡状态。 */
  registerBrainStatus?: (fn: (sessions: BrainSyncSession[]) => void) => void;
  /** 任务状态事件注册（阶段 3b+）：挂载时注册处理器，Home 的 useSyncChannel 收到 task-status 后调用。
   *  聊天舱内媒体生成据此收尾；sub:"plan" 分镜完成由服务端权威翻卡。
   *  @param fn 处理器（接收 task-status 事件）；卸载时传入空函数解绑。 */
  registerTaskStatus?: (fn: (e: { kind: string; id?: string; status: string; sub?: "plan"; error?: string; scenes?: { anchor: string; scene: string; caption?: string }[] }) => void) => void;
  /** 生成完成跳转（preview 卡 done 态「查看插画」→ 左侧对应章节滚动到插画位置） */
  onGoToMedia?: (chapterIndex: number, mediaId: string) => void;
  /** WS 连接状态注册：Home 的 useSyncChannel onStatusChange 转发。连接时纯事件驱动（零 HTTP 轮询，
   *  订阅快照 + task-status 事件同步 loading 卡）；断开时降级轮询兜底。卸载时传空函数解绑。 */
  registerWsStatus?: (fn: (connected: boolean) => void) => void;
  /** 注册「某会话是否正在 SSE 生成」查询：Home 的 brain-append 处理据此在流式期间跳过重拉（避免覆盖未完成正文）。 */
  registerIsStreaming?: (fn: (sessionId: string) => boolean) => void;
  /** 媒体参数选择经 sync WS 上行并由服务端持久化/广播到其它 Tab。 */
  syncMediaFormValues?: (payload: { sessionId: string; messageId: string; cardIndex: number; values: Record<string, unknown> }) => boolean;
}> = ({ open, onClose, world, brainState, onWorldUpdate, onProposalTalk, onOpenPanel, currentChapter, autoRunning, buildingStage, sysTick = 0, registerCardPatch, registerCardReplace, registerBrainStatus, registerTaskStatus, onGoToMedia, registerWsStatus, registerIsStreaming, syncMediaFormValues }) => {
  const storedBrainState = useBrainSyncState(world.title);
  const {
    sessions, activeId, messages, streaming, thinking, reconnecting,
    openSession, newSession, removeSession, truncate, appendCard, patchCard, replaceCard, send, stop, isStreaming,
    completed, markCompleted, reloadActive, getSessionMessages, applySyncSnapshot,
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
  // 媒体生成交互面板即聊天流中的 form 卡（切换章节/张数后文案实时更新），底部上方不再复刻选项区
  /** 媒体 form 卡当前选中值（按消息 id）：驱动消息正文（bc-msg-text）跟随章节/张数选项实时更新 */
  const [mediaFormValues, setMediaFormValues] = useState<Record<string, Record<string, unknown>>>({});
  /** 中枢系统上下文由常驻 sync 投影派生，弹窗开关不触发网络请求。 */
  const [serverCtx, setServerCtx] = useState<{
    autoRunning?: boolean; autoPhase?: string; pendingCommit?: { index: number | null; title: string } | null;
    advanceTaskRunning?: boolean; advancePhase?: string; mediaGenerating?: boolean; visualRunning?: boolean;
    pendingProposals?: number; pendingCards?: number; openDebt?: number; reviseChapters?: number[];
  }>({});
  useEffect(() => {
    setServerCtx({
      autoRunning,
      mediaGenerating: Boolean(storedBrainState?.tasks.some((t) => t.status === "pending" || t.status === "running")),
      pendingProposals: (world.characterProposals ?? []).filter((p) => p.status === "pending").length,
      pendingCards: (world.pendingCards ?? []).length,
      openDebt: (world.qualityDebt ?? []).filter((d) => d.status === "open").length,
      reviseChapters: world.chapters.filter((c) => c.review?.verdict === "revise").map((c) => c.index),
    });
  }, [autoRunning, storedBrainState, world]);
  /** 已手动展开的任务/指令类消息（默认折叠为摘要行，点击展开） */
  const [expandedMsgs, setExpandedMsgs] = useState<Set<string>>(new Set());
  /** 已展开思维链的消息（思考内容默认折叠，点击展开；无边框文字样式） */
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set());
  /** 中枢聊天思考模式开关（默认关：首字节提速 90%+；localStorage 持久化，会话间保持） */
  const [brainThinking, setBrainThinking] = useState<boolean>(() => {
    try { return localStorage.getItem("bc.thinking") === "1"; } catch { return false; }
  });
  function toggleBrainThinking() {
    setBrainThinking((v) => {
      const nv = !v;
      try { localStorage.setItem("bc.thinking", nv ? "1" : "0"); } catch { /* 隐私模式忽略 */ }
      return nv;
    });
  }
  /** 切换某条消息思维链的展开/折叠（默认折叠） */
  function toggleThinkingFold(id: string) {
    setExpandedThinking((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  /** 追问选择面板：最后一条含 ask 卡（未选择）的中枢消息 → 输入框上方询问；选择后作为新输入继续（sessionStorage 持久化已答，刷新恢复未答） */
  const [askAnswered, setAskAnswered] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(`brain-ask-answered-${activeId ?? ""}`) ?? "[]")); } catch { return new Set(); }
  });
  /** 聊天内写作进度（推进剧情/连载）：流式显示阶段与正文，结束后追加结果卡 */
  const [writing, setWriting] = useState<{ title: string; phase: string; text: string; status: "running" | "done" | "failed"; detail?: string } | null>(null);
  const writingAbortRef = useRef<AbortController | null>(null);
  const writingTimerRef = useRef<number | null>(null);
  // 媒体生成任务跟踪（纯 WS 事件驱动，无 HTTP 轮询）：task-status(media) 事件命中后消费 remaining，清空即收尾。
  // sid 记录任务所属会话（跨 tab 切换/关面板不变），事件到达时按 sid 写对应会话缓存，不依赖当前 activeId。
  const mediaPollJobsRef = useRef<Array<{
    sid: string; mediaIds: string[]; remaining: Set<string>; failedCount: number; msgId?: string; cardId?: string; chapterIndex?: number;
  }>>([]);
  /** 分镜任务跟踪登记（planId → 会话/卡片定位）：由 task-status(sub:plan) 事件就地翻卡，零轮询 */
  const planTrackRef = useRef<Map<string, {
    sid: string; msgId: string; cardIndex: number; cardId: string; kind: "image" | "video"; chapterIndex: number; commandId?: string;
  }>>(new Map());
  /** WS 连接状态：默认 true（页面加载后 WS 基本已连；连接时零 HTTP 轮询，靠订阅快照 + task-status 事件驱动） */
  /** 已处理「悬死」分镜中卡（running 但无 planId/mediaIds：提交后刷新丢失任务 id，无法恢复轮询）的 cardId 集合 */
  const stuckMediaRef = useRef<Set<string>>(new Set());
  /** 已做过一次性恢复核对的分镜 planId（每挂载周期核对一次，非轮询） */
  /** 已做过一次性媒体状态核对的卡片 key（`cardId::sortedMediaIds`；重试换 mediaIds 后可再次核对），非轮询 */
  /** 上一轮可跟踪 running 卡快照（cardId → 锚点）：卡片消失经「两次确认」后向服务端 POST /media/cancel */
  const trackedCardsRef = useRef<Map<string, { sid: string; msgId: string; cardIndex: number; planId?: string; mediaIds?: string[]; chapterIndex?: number }>>(new Map());
  /** 首次检测到消失的 cardId → 消失时的轮次（两次确认，避免切书/会话缓存瞬时空窗误取消） */
  const goneSuspectRef = useRef<Map<string, number>>(new Map());
  // L18：输入区拖拽进行中的清理函数（卸载时移除 window 监听 + 还原 body 样式）
  const inputResizeCleanupRef = useRef<(() => void) | null>(null);
  // L18：组件挂载态（BrainCabin 随弹窗开关挂载/卸载），异步回调写 state 前自检
  const cabinMountedRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // —— 打字机渲染（流式感）：上游推理模型思考期零输出、完成后一次性吐出，React 批处理会让文本
  // 一次性全部出现（无流式感）。此处对 pending 消息按固定节奏 reveal 文本，无论上游/批处理多快
  // 都保持平滑逐字显示；msg.text 数据层保持完整累积（刷新/复制/折叠等不受影响）。
  // 非 pending（done/interrupted）直接显示全文，不经过打字机。
  const TYPING_TICK_MS = 24;
  const TYPING_CHARS = 3; // 每 tick reveal 字符数（≈125 字/s，长回复 ~10-20s 显示完）
  const [reveal, setReveal] = useState<Record<string, number>>({});
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    const t = setInterval(() => {
      setReveal((prev) => {
        const next: Record<string, number> = {};
        let changed = false;
        for (const m of messagesRef.current) {
          if (m.role !== "brain") continue;
          if (!m.pending) { if (prev[m.id] != null) changed = true; continue; } // done 消息清理 reveal
          const len = m.text?.length ?? 0;
          if (!len) continue; // 思考期无文本：保持骨架
          const cur = prev[m.id] ?? 0;
          const nv = cur >= len ? len : Math.min(len, cur + TYPING_CHARS);
          next[m.id] = nv;
          if (nv !== cur) changed = true;
        }
        return changed ? next : prev;
      });
    }, TYPING_TICK_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const panelConsumingRef = useRef(new Set<string>());
  useEffect(() => {
    if (!onOpenPanel && !onProposalTalk) return;
    const open = findOpenPanelCard(messages);
    if (open && activeId && !panelConsumingRef.current.has(open.panelIntent.intentId)) {
      panelConsumingRef.current.add(open.panelIntent.intentId);
      void apiFetch("/api/brain/sessions/consume-panel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: world.title, sessionId: activeId, messageId: open.messageId,
          cardId: open.cardId, intentId: open.panelIntent.intentId,
        }),
      }).then(async (response) => {
        const data = await response.json().catch(() => ({})) as { consumed?: boolean };
        if (!response.ok || !data.consumed) return;
        if (onOpenPanel) onOpenPanel(open.panelIntent.target, open.panelIntent.opts);
        else if (open.panelIntent.target === "proposals" && onProposalTalk) onProposalTalk();
      }).finally(() => panelConsumingRef.current.delete(open.panelIntent.intentId));
      return;
    }
    // 兼容旧协议：open_proposals 老卡（无 open 字段，仅 title 约定）
    if (!open && onProposalTalk) {
      const id = findProposalCardMessageId(messages);
      if (id && !panelConsumingRef.current.has(id)) {
        panelConsumingRef.current.add(id);
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
    const last = messages[messages.length - 1];
    // reveal 纳入滚动 key：打字机逐字 reveal（独立 state，messages 不变）时滚动跟随文本生长
    const key = `${messages.length}:${last?.text?.length ?? 0}:${last?.id != null ? (reveal[last.id] ?? 0) : 0}:${thinking}`;
    if (key === lastScrollKeyRef.current) return;
    lastScrollKeyRef.current = key;
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, reveal]);
  useEffect(() => { if (open) stickToBottom(); }, [open, activeId]);
  // 系统事件注入信号：Home 轮询检测到系统状态变化并注入聊天会话后递增 → 重拉当前会话显示最新【系统】条
  useEffect(() => {
    if (sysTick > 0) void reloadActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sysTick]);

  // 卡片就地更新（阶段 3a）：card-update 事件 → 按 messageId+cardId 就地替换卡片（不重拉会话）。
  // patchCard 是 useCallback([]) 稳定引用；每次渲染把最新 patch 处理器写入 ref，
  // 挂载时经 registerCardPatch 注册给 Home（Home 的 useSyncChannel 收到 card-update 后调用）。
  const patchCardRef = useRef<((e: { sessionId: string; messageId: string; cardId: string; patch: Record<string, unknown> }) => void) | null>(null);
  patchCardRef.current = (e) => patchCard(e.sessionId, e.messageId, e.cardId, e.patch);
  useEffect(() => {
    if (registerCardPatch) registerCardPatch((e) => patchCardRef.current?.(e));
    return () => { if (registerCardPatch) registerCardPatch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCardPatch]);

  // 服务端权威翻卡（card-replaced）：按 messageId+cardIndex 就地整卡替换，persist=false 不回写 HTTP、不重拉会话。
  // 媒体卡 form→分镜中→分镜完成→生成中→done/failed 全部经此通道（含发起端与其他 tab）。
  const replaceCardRef = useRef<((e: { sessionId: string; messageId: string; cardIndex: number; card: Record<string, unknown> }) => void) | null>(null);
  replaceCardRef.current = (e) => { void replaceCard(e.sessionId, e.messageId, e.cardIndex, e.card as BrainCard, false); };
  useEffect(() => {
    if (registerCardReplace) registerCardReplace((e) => replaceCardRef.current?.(e));
    return () => { if (registerCardReplace) registerCardReplace(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCardReplace]);

  // 弹窗只订阅全局状态库；开关弹窗不创建、不关闭、不恢复 sync 连接。
  useEffect(() => {
    if (storedBrainState) applySyncSnapshot(storedBrainState.sessions as unknown as BrainSyncSession[]);
  }, [storedBrainState, applySyncSnapshot]);

  // 任务状态事件注册（阶段 3b+）：Home 的 useSyncChannel 收到 task-status(kind:media) 后转发，
  // 媒体任务据此收尾（WS 广播 + 周期快照保证多 Tab 收敛）
  const taskStatusRef = useRef<((e: { kind: string; id?: string; status: string; sub?: string }) => void) | null>(null);
  taskStatusRef.current = (e) => { if (e.kind === "media") handleMediaTaskStatus(e); };
  useEffect(() => {
    if (registerTaskStatus) registerTaskStatus((e) => taskStatusRef.current?.(e));
    return () => { if (registerTaskStatus) registerTaskStatus(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerTaskStatus]);

  // WS 连接状态镜像（纯事件驱动，无降级轮询；重连边沿主动跑一次恢复扫描，不依赖会话异步刷新时序）
  useEffect(() => {
    if (registerWsStatus) registerWsStatus(() => {});
    return () => { if (registerWsStatus) registerWsStatus(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerWsStatus]);

  // 向 Home 注册「会话是否 SSE 生成中」查询（brain-append 期间跳过重拉，避免覆盖流式正文）
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;
  useEffect(() => {
    if (registerIsStreaming) registerIsStreaming((sid) => isStreamingRef.current(sid));
    return () => { if (registerIsStreaming) registerIsStreaming(() => false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerIsStreaming]);

  // L18：卸载清理——媒体轮询 / 写作收起定时器 / 删除确认定时器 / 输入区拖拽监听，
  // 避免 BrainCabin 关闭（卸载）后定时器空转、window 监听与 body cursor/userSelect 残留、卸载后 setState
  useEffect(() => {
    cabinMountedRef.current = true;
    return () => {
      cabinMountedRef.current = false;
      mediaPollJobsRef.current = [];
      planTrackRef.current.clear();
      if (writingTimerRef.current) { window.clearTimeout(writingTimerRef.current); writingTimerRef.current = null; }
      if (delTimerRef.current) { window.clearTimeout(delTimerRef.current); delTimerRef.current = null; }
      inputResizeCleanupRef.current?.();
      inputResizeCleanupRef.current = null;
    };
  }, []);

  // 切书（world.title 变化，组件不卸载）：清空旧书的跟踪/核对/取消快照，避免跨书串扰
  useEffect(() => {
    mediaPollJobsRef.current = [];
    planTrackRef.current.clear();
    stuckMediaRef.current.clear();
    trackedCardsRef.current.clear();
    goneSuspectRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.title]);

  /** 追加卡片消息（preview/result 卡等）：本地即时展示 + 服务端持久化（刷新后卡片消息不丢失）。
   *  修复根因：preview 卡（如插画确认生成卡）此前只存前端内存，刷新即丢，用户无法确认生成 → 任务从未真正执行。 */
  function appendBrainMsg(cards: BrainCard[]) {
    if (!activeId) return;
    void appendCard(activeId, { id: uuid(), role: "brain", cards, at: new Date().toISOString() });
  }

  // 媒体任务恢复扫描：会话加载/消息变化后，对所有已加载会话的 preview 卡续接 WS 跟踪（分镜登记、
  // 生成登记、展示会话倒计时）。常驻挂载，面板关闭也运行（关面板期间完成的任务回来即正确）。
  useEffect(() => {
    resumeMediaScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeId, messages, sessions]);

  // 页面从后台切回可见时恢复本地倒计时/跟踪；权威状态由 sync WS 快照持续推送。
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") resumeMediaScan(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 任务对账：消息列表变化后，清理对应卡片已消失的异步跟踪任务（分镜登记 / 媒体生成 job / 自动倒计时），
  // 并经「两次确认」向服务端 POST /media/cancel 取消后台任务（删除会话/截断消息/卡片消失即取消，不再烧配额）。
  // 覆盖删除会话、截断消息（编辑重发/移至输入）、服务端翻卡替换等场景。遍历所有已加载会话的缓存。
  useEffect(() => {
    const liveJobs = new Set<string>();       // 仍在跑（running 带 mediaIds）的 cardId
    const livePlans = new Set<string>();      // 仍在分镜中（running 带 planId）的 planId
    // 当前所有已加载会话里仍存在的卡片（cardId → 取消所需锚点）；用于与上一轮快照 diff 出「消失的运行中卡」
    const liveCards = new Map<string, { sid: string; msgId: string; cardIndex: number; planId?: string; mediaIds?: string[]; chapterIndex?: number; running: boolean }>();
    for (const s of sessions) {
      const msgs = getSessionMessages(s.id) ?? [];
      for (const m of msgs) {
        (m.cards ?? []).forEach((c, i) => {
          if (c.kind !== "preview") return;
          const pc = c as PreviewCard;
          const cardId = pc.cardId;
          if (!cardId) return;
          liveCards.set(cardId, {
            sid: s.id, msgId: m.id, cardIndex: i,
            planId: pc.planId, mediaIds: pc.mediaIds, chapterIndex: pc.chapterIndex,
            running: pc.status === "running",
          });
          if (pc.status === "running" && pc.mediaIds?.length) liveJobs.add(cardId);
          if (pc.status === "running" && pc.planId) livePlans.add(pc.planId);
        });
      }
    }
    mediaPollJobsRef.current = mediaPollJobsRef.current.filter((j) => !!j.cardId && liveJobs.has(j.cardId));
    for (const [pid] of planTrackRef.current) {
      if (!livePlans.has(pid)) planTrackRef.current.delete(pid);
    }

    // 卡片消失 → 取消后台任务（两次确认：切书时快照已被 world.title effect 清空，不会误取消；
    // 会话列表瞬时空窗/重拉也需连续两轮缺席才取消，降低误判）。
    const prev = trackedCardsRef.current;
    const next = new Map<string, { sid: string; msgId: string; cardIndex: number; planId?: string; mediaIds?: string[]; chapterIndex?: number }>();
    for (const [cardId, info] of liveCards) {
      if (info.running && (info.planId || info.mediaIds?.length)) {
        next.set(cardId, { sid: info.sid, msgId: info.msgId, cardIndex: info.cardIndex, planId: info.planId, mediaIds: info.mediaIds, chapterIndex: info.chapterIndex });
      }
      goneSuspectRef.current.delete(cardId); // 仍存在（无论是否还在跑）：撤销嫌疑
    }
    for (const [cardId, anchor] of prev) {
      if (next.has(cardId)) continue; // 仍在跑：不取消
      if (liveCards.has(cardId)) continue; // 卡片仍在（已自然完成/失败翻为终态）：不取消，直接移出跟踪
      // 卡片在所有已加载会话中都找不到了 → 疑似删除：两次确认后取消后台任务
      if (goneSuspectRef.current.has(cardId)) {
        // 第二轮仍消失：确认取消（幂等，后端只取消在途任务、保留成品）
        goneSuspectRef.current.delete(cardId);
        const items = (anchor.mediaIds ?? []).map((id) => ({ chapterIndex: anchor.chapterIndex ?? 1, mediaId: id }));
        void apiFetch("/api/novel/media/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: world.title,
            reason: "对应消息卡片已删除，任务取消",
            planId: anchor.planId,
            items: items.length ? items : undefined,
            session: { sessionId: anchor.sid, messageId: anchor.msgId, cardIndex: anchor.cardIndex, cardId },
          }),
        }).catch(() => {});
      } else {
        goneSuspectRef.current.set(cardId, Date.now()); // 首次消失：记嫌疑，等下一轮确认
      }
    }
    trackedCardsRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeId, sessions, getSessionMessages, world.title]);

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
  const ctxBusy = streaming || executing;
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
            // 打字机显示：pending 消息按 reveal 节奏显示（流式感），非 pending 显示完整文本
            const shownText = msg.pending ? (msg.text ?? "").slice(0, reveal[msg.id] ?? 0) : (msg.text ?? "");
            // 媒体生成 form 卡消息：正文跟随卡片当前选择的章节/张数动态生成（去「正在…生成」的误导）
            const mediaCard = mediaCardOf(msg);
            const displayText = mediaCard ? mediaGuideText(mediaCard, mediaFormValues[msg.id]) : shownText;
            // 滚动吸附：每条用户提问 sticky 吸顶（CSS 处理），当前视口内 AI 回复对应的提问自然吸附在顶部
            const isSysNote = msg.kind === "system";
            return (
            <div key={msg.id} className={`bc-msg bc-msg-${msg.role}${isSysNote ? " bc-msg-system" : ""}`}>
              {msg.role === "brain" && !isSysNote && <BrainCore presence={presence} activity={activity} size="mini" animated={false} />}
              {isSysNote && <span className="bc-msg-system-ico" title="系统事件">⚙</span>}
              <div className="bc-msg-content">
                {isSysNote ? (
                  <div className="bc-msg-system-text">
                    <MarkdownView text={shownText || (msg.text ?? "")} />
                  </div>
                ) : folded ? (
                  <button className="bc-msg-fold" onClick={() => setExpandedMsgs((prev) => { const n = new Set(prev); n.add(msg.id); return n; })} title="展开查看详情">
                    <span className="bc-fold-caret">▸</span>
                    <span className="bc-fold-text">{msgCollapseSummary(msg)}</span>
                    <span className="bc-fold-meta">{(msg.cards?.length ?? 0) > 1 ? `卡片 ×${msg.cards?.length}` : ""}</span>
                  </button>
                ) : (
                  <>
                {msg.role === "brain" && msg.pending && !shownText && (
                  <ThinkingSkeleton />
                )}
                {/* 思维链（思考模式开启时流式累积）：默认折叠为一行摘要，点击展开显示 markdown（无边框文字样式） */}
                {msg.thinking ? (
                  <div className="bc-msg-thinking">
                    {expandedThinking.has(msg.id) ? (
                      <>
                        <button className="bc-thinking-toggle-row" onClick={() => toggleThinkingFold(msg.id)} title="折叠思维链">
                          <span className="bc-fold-caret">▾</span>
                          <span className="bc-thinking-ico">🧠</span> 收起思考
                        </button>
                        <div className="bc-thinking-body">
                          <MarkdownView text={msg.thinking} />
                        </div>
                      </>
                    ) : (
                      <button className="bc-thinking-toggle-row" onClick={() => toggleThinkingFold(msg.id)} title="展开思维链">
                        <span className="bc-fold-caret">▸</span>
                        <span className="bc-thinking-ico">🧠</span>
                        <span className="bc-thinking-summary">已深度思考（{msg.thinking.length} 字）</span>
                      </button>
                    )}
                  </div>
                ) : null}
                {displayText ? (
                  <div className={`bc-msg-text${msg.pending ? " bc-typing" : ""}`}>
                    <MarkdownView text={displayText} />
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
                {msg.cards?.map((card, i) => {
                  // L19 修复：ask 卡不进聊天流；用「未过滤数组的原始下标 i」作 completed 键，
                  // 与 ctx-bar/media-bar 的 lastCards.indexOf（原始下标）及 confirmChoose/executeCard
                  // 标记侧保持一致（过滤后下标在含 ask 卡时会错位，导致完成态不匹配）。
                  if (card.kind === "ask") return null;
                  return (
                  <BrainCardView
                    key={card.cardId ?? `${msg.id}::${i}`}
                    card={card}
                    busy={streaming || executing}
                    completed={completed.has(`${msg.id}:${i}`)}
                    completedItems={card.kind === "browse" ? completedItemIdsOf(completed, msg.id, i) : undefined}
                    onExecute={(card2, action) => executeCard(card2, action, msg.id, i)}
                    onConfirmChoose={(opt) => confirmChoose(opt, msg, i)}
                    onOption={(option) => handleOption(option, { messageId: msg.id, cardIndex: i, card })}
                    onFormSubmit={(card2, values) => submitForm(card2, values, msg.id, i)}
                    onFormValuesChange={(vals, source) => {
                      // 仅媒体 form 卡写入（非媒体卡如 settings/edit_world 不污染 state、不触发无谓重渲染）
                      if (mediaCardOf(msg)) {
                        setMediaFormValues((prev) => ({ ...prev, [msg.id]: vals }));
                        if (source === "user") syncMediaFormValues?.({ sessionId: activeId, messageId: msg.id, cardIndex: i, values: vals });
                      }
                    }}
                    onGoToMedia={onGoToMedia}
                    mediaQuota={mediaQuotaOf}
                  />
                  );
                })}
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
                    <button className="bc-msg-op" onClick={() => void copyText(displayText ?? msg.text ?? "")} disabled={!(displayText || msg.text)} title="复制消息内容">⧉ 复制</button>
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
        {!showHistory && (activeSessionTitle || ctxCard || runningStatus) && (
          <div className="bc-context-bar">
            <div className="bc-context-main">
              {activeSessionTitle && <span className="bc-context-session" title="当前会话">{activeSessionTitle}</span>}
              {runningStatus && <span className={`bc-context-status${reconnecting ? " bc-status-warn" : ""}`}>{runningStatus}</span>}
            </div>

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
              if (e.key === "Enter" && !e.shiftKey) {
                // M8 修复：中文输入法选词中的 Enter（isComposing/keyCode 229）不发送
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault(); void doSend();
              }
            }}
            placeholder={streaming ? "中枢正在回复…（可继续输入，生成结束后发送）" : "对中枢说点什么…（Enter 发送，Shift+Enter 换行）"}
            rows={2}
          />
          <div className="bc-send-col">
            {streaming ? (
              <button className="bc-send bc-send-stop" onClick={stop} title="中断生成（保留已输出内容）" aria-label="中断生成">
                <Square size={16} />
              </button>
            ) : (
              <button className="bc-send bc-send-go" onClick={() => void doSend()} disabled={!input.trim() || executing} title="发送" aria-label="发送">
                <Send size={16} />
              </button>
            )}
            {/* 思考模式开关：位于发送按钮下方，与发送按钮同尺寸圆形 icon，样式统一 */}
            <button
              className={`bc-send bc-think-toggle${brainThinking ? " active" : ""}`}
              onClick={toggleBrainThinking}
              title={brainThinking ? "思考模式：开（中枢输出思维链，回答更慢但更严谨）" : "思考模式：关（不输出思维链，响应更快；点击开启深度思考）"}
              aria-pressed={brainThinking}
            >
              <span className="bc-thinking-ico">🧠</span>
            </button>
          </div>
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
    // 清掉上一次拖拽的清理（防御 pointerup 未触发的残留）
    inputResizeCleanupRef.current?.();
    const startY = e.clientY;
    const startH = ta.getBoundingClientRect().height;
    const MIN = 48, MAX = 176;
    const onMove = (ev: PointerEvent) => {
      const h = Math.min(MAX, Math.max(MIN, startH + (startY - ev.clientY)));
      ta.style.height = `${h}px`;
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onUp = () => {
      cleanup();
      inputResizeCleanupRef.current = null;
      // 拖拽结束：保存输入区高度偏好（纯本地；服务端不感知，无一致性风险）
      const h = ta.getBoundingClientRect().height;
      writeCabinPrefs({ inputHeight: Math.round(h) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    // L18：记录清理函数，卸载时（拖拽中关弹窗）也能移除监听、还原 body 样式
    inputResizeCleanupRef.current = cleanup;
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
    await send({ prompt, sessionId: sid, ctx: chatCtx, thinking: brainThinking });
  }

  /** 重新生成：resume 当前会话最后一条未完成消息 */
  function regenerate() {
    if (!activeId || streaming) return;
    const lastBrain = [...messages].reverse().find((m) => m.role === "brain" && m.interrupted);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastBrain || !lastUser) return;
    void send({ prompt: lastUser.text ?? "", sessionId: activeId, resume: true, ctx: chatCtx, thinking: brainThinking });
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

  type CardLocation = { messageId?: string; cardIndex?: number; card?: BrainCard };

  /** Persist a card state transition before treating it as authoritative. The local patch is
   * immediate for feedback; a failed write is made visible on the same card. */
  async function settleCard(location: CardLocation, patch: Record<string, unknown>): Promise<boolean> {
    const { messageId, card } = location;
    const cardId = card?.cardId;
    if (!activeId || !messageId || !cardId) return false;
    patchCard(activeId, messageId, cardId, patch);
    try {
      const res = await apiFetch("/api/brain/sessions/update-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: world.title, sessionId: activeId, messageId, cardId, patch }),
      });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({})) as { error?: string };
      patchCard(activeId, messageId, cardId, { executionState: "failed", detail: data.error ?? `状态保存失败（HTTP ${res.status}）` });
      return false;
    } catch (error) {
      patchCard(activeId, messageId, cardId, { executionState: "failed", detail: `状态保存失败：${(error as Error).message}` });
      return false;
    }
  }

  /** 操作被前置校验拦截时在原卡反馈，不再追加结果卡。 */
  function notifyBlocked(title: string, reason: string, location?: CardLocation) {
    if (location?.card?.cardId) {
      void settleCard(location, { executionState: "failed", detail: reason, settledAt: Date.now() });
      return;
    }
    appendBrainMsg([{ kind: "result", title, success: false, detail: reason }]);
  }

  /** 统一操作守卫：不可执行时反馈原因并返回 true（调用方直接 return，不发请求、不标记完成） */
  function guardBlocked(act: { endpoint: string; body?: Record<string, unknown> }, title: string, location?: CardLocation): boolean {
    const reason = guardAction(act, {
      executing, streaming,
      writingRunning: writing?.status === "running",
      world,
    });
    if (reason) {
      notifyBlocked(title, reason, location);
      return true;
    }
    return false;
  }

  /** 计划/意见选项卡点击：有动作则执行并回执；纯说明则记录选择 */
  async function handleOption(option: ChoiceOption, location: CardLocation = {}) {
    if (!option.action) {
      await settleCard(location, { executionState: "succeeded", detail: option.description ?? `已选择：${option.label}`, selectedOption: option.label, settledAt: Date.now() });
      return;
    }
    if (guardBlocked(option.action, option.label, location)) return;
    if (!await settleCard(location, { executionState: "submitting", detail: `正在执行：${option.label}`, selectedOption: option.label })) return;
    setExecuting(true);
    try {
      const r = await fetchAction(option.action.endpoint, option.action.method ?? "POST", option.action.body);
      await settleCard(location, { executionState: r.success ? "succeeded" : "failed", detail: r.detail, settledAt: Date.now() });
      if (r.success) onWorldUpdate?.();
    } catch (e) {
      await settleCard(location, { executionState: "failed", detail: (e as Error).message, settledAt: Date.now() });
    } finally {
      setExecuting(false);
    }
  }

  /** 旧协议兼容：没有 executionState 的历史卡仍使用 completed key。
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
  async function streamWritingTask(title: string, act: { endpoint: string; method?: string; body: Record<string, unknown> }, cardTitle: string, location: CardLocation): Promise<boolean> {
    const ctrl = new AbortController();
    writingAbortRef.current = ctrl;
    // 清掉上一次任务的收起定时器，避免任务 A 结束后 2.5s 内启动任务 B 时把 B 的进度卡提前收起
    if (writingTimerRef.current) window.clearTimeout(writingTimerRef.current);
    setWriting({ title: cardTitle, phase: "start", text: "", status: "running" });

    const progressRef = activeId && location.messageId && location.card?.cardId
      ? { sessionId: activeId, messageId: location.messageId, cardId: location.card.cardId }
      : null;
    const patchProgressCard = (patch: Record<string, unknown>) => {
      if (progressRef) patchCard(progressRef.sessionId, progressRef.messageId, progressRef.cardId, patch);
    };
    const finalizeProgressCard = (patch: Record<string, unknown>) => settleCard(location, patch);

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
        await finalizeProgressCard({ status: "failed", executionState: "failed", phase: "failed", detail: msg, settledAt: Date.now() });
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
            patchProgressCard({ phase, text: finalText });
          } else if (phase === "result") {
            ended = "done";
            const r = (obj.result ?? {}) as { chapter?: { index?: number; title?: string } };
            patch({ phase, status: "done", text: finalText, detail: `第 ${r.chapter?.index ?? ""} 章《${r.chapter?.title ?? ""}》已完成` });
            patchProgressCard({ phase, status: "done", text: finalText, detail: `第 ${r.chapter?.index ?? ""} 章《${r.chapter?.title ?? ""}》已完成` });
          } else if (phase === "auto-done") {
            ended = "done";
            const r = (obj.report ?? {}) as { written?: number; target?: number; reason?: string };
            patch({ phase, status: "done", text: finalText, detail: `连载完成：${r.written ?? 0}/${r.target ?? 0} 章（${String(r.reason ?? "")}）` });
            patchProgressCard({ phase, status: "done", text: finalText, detail: `连载完成：${r.written ?? 0}/${r.target ?? 0} 章（${String(r.reason ?? "")}）` });
          } else if (phase === "pending-commit") {
            ended = "done";
            patch({ phase, status: "done", text: finalText, detail: `第 ${String(obj.chapterIndex ?? "")} 章审查已通过，等待确认入册` });
            patchProgressCard({ phase, status: "done", text: finalText, detail: `第 ${String(obj.chapterIndex ?? "")} 章审查已通过，等待确认入册` });
          } else if (phase === "interrupted") {
            ended = "failed";
            patch({ phase, status: "failed", text: finalText, detail: "写作已中断（阶段边界丢弃草稿）" });
            patchProgressCard({ phase, status: "failed", text: finalText, detail: "写作已中断（阶段边界丢弃草稿）" });
          } else if (phase === "start" || phase === "writing" || phase === "selfcheck" || phase === "reviewing" || phase === "patching" || phase === "settling" || phase === "saving" || phase === "auto-status") {
            patch({ phase, text: finalText });
            patchProgressCard({ phase, text: finalText });
          }
        }
      }
      // 流正常关闭但未收到终态：任务已完成（SSE 在 result 后关闭）；兜底收尾
      if (ended === "running") ended = "done";
      patch((w) => (w!.status === "running" ? { status: "done", detail: "任务已结束" } : {}));
      await finalizeProgressCard({ status: "done", executionState: "succeeded", detail: ended === "done" ? "写作已完成，正文已更新" : "写作未完成", settledAt: Date.now() });
      return ended === "done";
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      ended = "failed";
      patch(aborted ? { status: "failed", detail: "写作已中断" } : { status: "failed", detail: (e as Error).message });
      await finalizeProgressCard(aborted
        ? { status: "failed", executionState: "interrupted", phase: "failed", detail: "写作已中断", settledAt: Date.now() }
        : { status: "failed", executionState: "failed", phase: "failed", detail: (e as Error).message, settledAt: Date.now() });
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
    const location = { messageId: msgId, cardIndex, card };
    const cardTitle = card.kind === "ask" ? "" : card.title; // AskCard 无 title（且无 action 走不到这里，收窄用）
    if (guardBlocked(act, cardTitle, location)) return; // 前置校验：不可执行时反馈原因，不发请求（服务端仍兜底权威）
    if (!await settleCard(location, { executionState: "submitting", detail: "正在提交指令…" })) return;
    setExecuting(true);
    try {
      // 推进剧情 / 自动连载：聊天内流式显示写作过程（progress 卡实时阶段+正文），结束后 result 卡回执；
      // 仅成功才标记卡片完成（中断/失败保留按钮，用户可重试）
      if (act.endpoint === "/api/novel/step" || act.endpoint === "/api/novel/auto/start") {
        await settleCard(location, { executionState: "running", status: "running", detail: "写作任务运行中…" });
        const ok = await streamWritingTask(world.title, act, cardTitle, location);
        if (ok && !card.cardId) markCardDone(msgId, cardIndex);
        onWorldUpdate?.();
        return;
      }
      // 媒体生成（插画/视频）：「生成中」running 卡与终态卡均由【服务端】权威落盘并经 card-replaced WS 推下，
      // 前端不再乐观落盘/回写 HTTP（避免无锚点卡被误判中断）。此处仅：提交动作（HTTP）+ 登记内存跟踪以即时消费
      // 逐张 task-status 进度（pollMediaGen 为纯 WS 登记，无 HTTP）。提交按钮 busy 态覆盖在途 UX。
      if (act.endpoint === "/api/novel/media/generate") {
        const mediaCardId = (card as { cardId?: string }).cardId;
        // 自动调度由服务端持久 job 仲裁；手动点击会原子取消尚未到期的 queued job。
        const genSid = activeId;
        // 携带会话定位：服务端落盘「生成中」卡与终态卡并推 card-replaced（cardId 沿用当前卡）
        const genBody = (msgId != null && cardIndex != null && mediaCardId && genSid)
          ? { ...act.body, session: { sessionId: genSid, messageId: msgId, cardIndex, cardId: mediaCardId } }
          : act.body;
        const res = await apiFetch(act.endpoint, {
          method: act.method ?? "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(genBody),
        });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; mediaIds?: string[]; mediaId?: string; error?: string };
        if (!res.ok || data.error) {
          const msg = String(data.error ?? `HTTP ${res.status}`);
          await settleCard(location, { executionState: "failed", status: "failed", detail: msg, settledAt: Date.now() });
          return;
        }
        const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
        const chapterIndex = Number(act.body.chapterIndex);
        if (ids.length) {
          // 登记内存跟踪：逐张消费 task-status(media) WS 进度（无 HTTP 轮询）；终态由服务端 card-replaced 收敛
          pollMediaGen(world.title, chapterIndex, ids, cardTitle, msgId, mediaCardId, genSid);
        }
        onWorldUpdate?.();
        return;
      }
      const r = await fetchAction(act.endpoint, act.method ?? "POST", act.body);
      await settleCard(location, { executionState: r.success ? "succeeded" : "failed", detail: r.detail, settledAt: Date.now() });
      if (r.success) {
        // gacha 全部应用（auto:true）：pendingCards 一次性消耗，标记本卡全部列表项完成（刷新后保持「已处理」）
        if (act.endpoint === "/api/novel/gacha" && act.body.action === "apply" && act.body.auto === true && card.kind === "browse") {
          const list = (card.data as { list?: { id?: unknown }[] } | null)?.list ?? [];
          for (const c of list) if (c?.id) markCardDone(msgId, cardIndex, String(c.id));
        }
        if (!card.cardId || card.kind === "browse") markCardDone(msgId, cardIndex, card.kind === "browse" ? actionItemId(act.body) : undefined);
        onWorldUpdate?.();
      }
    } catch (e) {
      await settleCard(location, { executionState: "failed", status: "failed", detail: (e as Error).message, settledAt: Date.now() });
    } finally {
      setExecuting(false);
    }
  }

  /** 就地更新被操作预览卡的任务状态/附加字段：本地即时（patchCard）+ 服务端 update-card 持久化并广播（多 tab 一致、刷新可见）。
   *  无 cardId（旧卡/服务端未落 cardId）时跳过——退化为只追加 result 卡的原行为。
   *  sid 缺省取当前 active 会话；跨会话收尾（后台 tab 任务完成）传 job.sid。
   *  planId/mediaIds/chapterIndex/mediaId 为媒体状态机恢复依据：落盘后刷新/重开由恢复扫描续接。 */
  function patchMediaTaskStatus(msgId: string | undefined, cardId: string | undefined, patch: Partial<{
    status: "running" | "done" | "failed"; detail?: string; planId?: string; mediaIds?: string[]; chapterIndex?: number; mediaId?: string;
  }>, persist = true, sid?: string) {
    if (!msgId || !cardId) return;
    const targetSid = sid || activeId;
    if (!targetSid) return;
    patchCard(targetSid, msgId, cardId, patch as Record<string, unknown>);
    // running 中间态 detail 更新不落盘（每 3s 一次太频繁）；但携带恢复依据的落盘由调用方显式 persist=true
    if (!persist) return;
    void apiFetch("/api/brain/sessions/update-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: world.title, sessionId: targetSid, messageId: msgId, cardId, patch }),
    }).catch(() => {});
  }

  /** 媒体生成任务收尾：从跟踪表移除 + 就地翻转预览卡终态 + 刷新世界（单面板，不追加结果卡）。
   *  纯 WS 驱动：无定时器；按 job.sid 写对应会话（后台 tab 完成也能正确落卡）。
   *  终态卡由【服务端】card-replaced 权威落盘；此处 persist=false 仅做本地即时收敛，不回写 HTTP。 */
  function finalizeMediaJob(job: { sid: string; mediaIds: string[]; remaining: Set<string>; failedCount: number; msgId?: string; cardId?: string }) {
    const i = mediaPollJobsRef.current.indexOf(job);
    if (i >= 0) mediaPollJobsRef.current.splice(i, 1);
    const done = job.mediaIds.length - job.failedCount;
    if (job.msgId && job.cardId) {
      patchMediaTaskStatus(job.msgId, job.cardId, job.failedCount === 0
        ? { status: "done", detail: `已完成 ${done} 项`, mediaId: job.mediaIds[0] }
        : { status: "failed", detail: `${done} 项成功，${job.failedCount} 项失败` }, false, job.sid);
    }
    onWorldUpdate?.();
  }

  /** WS task-status(kind:media) 事件（纯事件驱动，无 HTTP 轮询）：
   *  sub:"plan" → 分镜完成广播：卡的「分镜完成/失败」翻转由【服务端】card-replaced 权威落盘并推下，
   *               此处仅清理本端 planTrack 跟踪；倒计时由 resumeMediaScan 见到 card-replaced 应用的
   *               countdownAt 后启动（不依赖此处翻卡）。
   *  缺省 → 媒体生成完成广播：从对应跟踪任务消费该 mediaId，全部 ready/failed 即收尾。
   *  跨会话：跟踪记录携带 sid，后台 tab/面板关闭期间完成也能写对会话（patchCard 写入缓存，切回即见）。 */
  function handleMediaTaskStatus(e: { id?: string; status: string; sub?: string; error?: string; scenes?: { anchor: string; scene: string; caption?: string }[] }) {
    if (!e.id) return;
    // 分镜任务事件：卡翻转由服务端 card-replaced 负责，这里只清理本端跟踪
    if (e.sub === "plan") {
      if (e.status === "ready" || e.status === "failed") planTrackRef.current.delete(e.id);
      return;
    }
    // 订阅快照的 pending 仅「确认任务在跑」（卡保持 running），不消费 remaining——仅 ready/failed 终态才收尾。
    if (e.status !== "ready" && e.status !== "failed") return;
    for (const job of mediaPollJobsRef.current) {
      if (job.remaining.has(e.id)) {
        consumeMediaTaskStatus(job, e.id, e.status, e.error);
        return;
      }
    }
  }

  /** 消费单个媒体终态（由 WS task-status 驱动）：
   *  从 remaining 移除该 mediaId，失败计数 +1；全部终态则收尾翻卡，否则更新中间进度（仅本地，不落盘）。 */
  function consumeMediaTaskStatus(job: { sid: string; mediaIds: string[]; remaining: Set<string>; failedCount: number; msgId?: string; cardId?: string; chapterIndex?: number }, mediaId: string, status: string, error?: string) {
    if (!job.remaining.has(mediaId)) return;
    job.remaining.delete(mediaId);
    if (status === "failed") {
      job.failedCount++;
    } else if (status === "ready" && error) {
      // ready 带错误信息不应出现；防御性忽略
    }
    if (job.remaining.size === 0) {
      finalizeMediaJob(job);
    } else if (job.msgId && job.cardId) {
      const done = job.mediaIds.length - job.remaining.size - job.failedCount;
      patchMediaTaskStatus(job.msgId, job.cardId, { status: "running", detail: `生成中 ${done}/${job.mediaIds.length}…` }, false, job.sid);
    }
  }

  /** 媒体生成任务跟踪（纯 WS 驱动，无 HTTP 轮询）：登记任务→等待 task-status(media) 事件逐个消费，
   *  全部 ready/failed 后由 handleMediaTaskStatus 收尾。跨面板/跨 tab 存活（组件常驻挂载，job 携带 sid）。 */
  function pollMediaGen(title: string, chapterIndex: number, mediaIds: string[], _label: string, msgId?: string, cardId?: string, sid?: string) {
    const targetSid = sid || activeId;
    if (!targetSid) return;
    // 幂等：同卡已在跟踪则不重复登记
    if (cardId && mediaPollJobsRef.current.some((j) => j.cardId === cardId)) return;
    const job = {
      sid: targetSid,
      mediaIds,
      remaining: new Set(mediaIds),
      failedCount: 0,
      msgId,
      cardId,
      chapterIndex,
    };
    mediaPollJobsRef.current.push(job);
  }

  /** ConfirmCard 确认（L2/L3 三选一；msg/cardIndex 供成功后标记 confirm 与 preview 卡完成态） */
  async function confirmChoose(opt: "merge" | "rewrite" | "abort", msg?: ChatMessage, cardIndex?: number) {
    const cards = msg?.cards ?? [];
    const confirmIdx = cardIndex ?? cards.findIndex((c) => c.kind === "confirm");
    const confirmCard = confirmIdx >= 0 ? cards[confirmIdx] : undefined;
    const location = { messageId: msg?.id, cardIndex: confirmIdx, card: confirmCard };
    if (opt === "abort") {
      await settleCard(location, { executionState: "cancelled", detail: "用户选择放弃本次操作", settledAt: Date.now() });
      if (msg && confirmIdx >= 0 && !confirmCard?.cardId) markCardDone(msg.id, confirmIdx);
      const pIdx = cards.findIndex((c) => c.kind === "preview");
      const preview = pIdx >= 0 ? cards[pIdx] : undefined;
      if (preview?.cardId) await settleCard({ messageId: msg?.id, cardIndex: pIdx, card: preview }, { executionState: "cancelled", detail: "用户选择放弃本次操作", settledAt: Date.now() });
      else if (pIdx >= 0) markCardDone(msg?.id, pIdx);
      return;
    }
    const action = findPreviewAction(cards);
    if (!action) {
      await settleCard(location, { executionState: "failed", detail: "未找到操作端点", settledAt: Date.now() });
      return;
    }
    if (guardBlocked(action, `执行（${opt}）`, location)) return;
    if (!await settleCard(location, { executionState: "submitting", detail: `正在执行：${opt}` })) return;
    setExecuting(true);
    try {
      const body = { ...action.body, strategy: opt };
      const r = await fetchAction(action.endpoint, action.method ?? "POST", body);
      await settleCard(location, { executionState: r.success ? "succeeded" : "failed", detail: r.detail, settledAt: Date.now() });
      if (r.success) {
        if (!confirmCard?.cardId && confirmIdx >= 0) markCardDone(msg?.id, confirmIdx);
        const pIdx = cards.findIndex((c) => c.kind === "preview");
        const preview = pIdx >= 0 ? cards[pIdx] : undefined;
        if (preview?.cardId) await settleCard({ messageId: msg?.id, cardIndex: pIdx, card: preview }, { executionState: "succeeded", detail: r.detail, settledAt: Date.now() });
        else if (pIdx >= 0) markCardDone(msg?.id, pIdx);
        onWorldUpdate?.();
      }
    } catch (e) {
      await settleCard(location, { executionState: "failed", detail: (e as Error).message, settledAt: Date.now() });
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
    const location = { messageId: msgId, cardIndex, card };
    if (guardBlocked(card.action, card.title, location)) return; // 前置校验：系统忙/写作运行中拦截
    const flat = flattenFormValues(card.fields ?? [], values);
    const body: Record<string, unknown> = { ...(card.action.body ?? {}), ...flat, title: world.title };
    const isMediaPlan = card.action.endpoint === "/api/novel/media/plan";
    const chapterIndex = Number(body.chapterIndex);
    const kind = String(body.kind ?? "image");
    // 媒体插画：提交前校验剩余额度（张数下拉已限制，此处双保险；0 = 已满）
    if (isMediaPlan && kind === "image") {
      const quota = mediaQuotaOf(chapterIndex);
      const count = Number(body.count);
      if (quota <= 0 || !Number.isInteger(count) || count < 1 || count > quota) {
        await settleCard(location, { executionState: "failed", detail: quota <= 0 ? "本章插画已满（上限 3 张），请先删除部分插画再生成" : "所选张数超出本章剩余可生成数量，请调整后重试", settledAt: Date.now() });
        return;
      }
    }
    if (!await settleCard(location, { executionState: "submitting", detail: "正在提交…" })) return;
    // 媒体分镜：中间态「分镜中」running 卡由【服务端】在 /media/plan 同步落盘并经 card-replaced WS 推下，
    // 前端不再乐观落盘（避免无 planId 的悬死卡被恢复扫描误判为「分镜已中断」）。提交按钮 busy 态已覆盖在途 UX。
    setExecuting(true);
    const formCtrl = new AbortController();
    const formTimer = window.setTimeout(() => formCtrl.abort(), 15_000); // 任务化后提交即返回，仅网络层兜底超时
    try {
      // 分镜提交携带会话定位（不带 cardId：由服务端生成）；服务端据此落盘翻卡并推 card-replaced
      const planBody = isMediaPlan && msgId != null && cardIndex != null
        ? { ...body, session: { sessionId: activeId, messageId: msgId, cardIndex } }
        : body;
      const res = await apiFetch(card.action.endpoint, {
        method: card.action.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planBody),
        signal: formCtrl.signal,
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok || data.error) {
        const msg = String(data.error ?? `HTTP ${res.status}`);
        await settleCard(location, { executionState: "failed", detail: msg, settledAt: Date.now() });
        return;
      }
      // 媒体生成表单（/api/novel/media/plan）：planId 由服务端写入 running 卡并随 card-replaced 到达；
      // resumeMediaScan 见到 running+planId 会自行 trackPlanTask，前端无需补记/回写。
      if (isMediaPlan) {
        return;
      }
      if (data.needIntervention && data.report) {
        // L2 干预：原表单就地转换为确认卡，保留 cardId/commandId，避免消息列表增长。
        const rp = data.report as { summary?: string; affectedChapters?: unknown[] };
        const confirm: BrainCard = {
          kind: "confirm",
          cardId: card.cardId,
          title: card.title,
          commandId: card.commandId,
          level: card.level ?? "L2",
          executionState: "waiting_confirmation",
          detail: rp.summary ?? "此修改为 L2 回溯变更，将影响已写内容",
          impact: `影响 ${(rp.affectedChapters ?? []).length} 个已写章节，请选择处理策略。${rp.summary ?? ""}`,
          options: ["merge", "rewrite", "abort"],
          action: { endpoint: card.action.endpoint, method: card.action.method ?? "POST", body },
        };
        if (activeId && msgId != null && cardIndex != null) await replaceCard(activeId, msgId, cardIndex, confirm, true);
        return;
      }
      await settleCard(location, { executionState: "succeeded", detail: "已保存", settledAt: Date.now() });
      if (!card.cardId) markCardDone(msgId, cardIndex);
      onWorldUpdate?.();
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      const msg = aborted ? "请求超时，请重试" : (e as Error).message;
      if (isMediaPlan && msgId != null && cardIndex != null) {
        // 分镜提交网络异常/超时：回退 form 卡（服务端任务可能已创建但无 planId 无法轮询，重试即可）
        void replaceCard(activeId, msgId, cardIndex, card, true);
      }
      await settleCard(location, { executionState: aborted ? "interrupted" : "failed", detail: msg, settledAt: Date.now() });
    } finally {
      window.clearTimeout(formTimer);
      setExecuting(false);
    }
  }

  /** 分镜任务跟踪登记（纯 WS 驱动，无轮询）：在 planTrackRef 记录会话/卡片定位，
   *  等 task-status(sub:plan) 事件到达时由 handleMediaTaskStatus 就地翻卡。
   *  跨面板/跨 tab 存活（携带 sid）；幂等（同一 planId 不重复登记）。 */
  function trackPlanTask(planId: string, msgId: string, cardIndex: number, cardId: string, kind: "image" | "video", chapterIndex: number, commandId?: string, sid?: string) {
    if (planTrackRef.current.has(planId)) return;
    planTrackRef.current.set(planId, { sid: sid || activeId, msgId, cardIndex, cardId, kind, chapterIndex, commandId });
  }

  /** 媒体插画剩余可生成张数（每章上限 MAX_IMAGES_PER_CHAPTER 与后端同源；扣已有含生成中 pending）：
   *  供张数下拉动态 options + 提交前校验 */
  function mediaQuotaOf(chapterIndex: number): number {
    const ch = world.chapters.find((c) => c.index === chapterIndex);
    const existing = (ch?.media ?? []).filter(imageOccupiesQuota).length;
    return Math.max(0, MAX_IMAGES_PER_CHAPTER - existing);
  }

  // 媒体状态恢复扫描：会话加载/消息变化/重连/页面重新可见时，对所有已加载会话的 preview 卡续接跟踪——
  // 分镜中（planId）→ 登记 WS 跟踪；分镜完成后的 deadline 由服务端持久调度；
  // 生成中（mediaIds）→ 登记 WS 跟踪（等 task-status 事件收尾）。纯事件驱动，无 interval 轮询。
  function resumeMediaScan() {
    for (const s of sessions) {
      const msgs = getSessionMessages(s.id);
      if (!msgs?.length) continue;
      for (const m of msgs) {
        (m.cards ?? []).forEach((c, i) => {
          if (c.kind !== "preview") return;
          const pc = c as PreviewCard;
          const cardId = pc.cardId;
          if (!cardId) return;
          if (pc.status === "running" && pc.planId && !planTrackRef.current.has(pc.planId)) {
            trackPlanTask(pc.planId, m.id, i, cardId, pc.mediaKind ?? "image", pc.chapterIndex ?? 1, pc.commandId, s.id);
          } else if (pc.status === "running" && pc.mediaIds?.length) {
            // 登记 WS 跟踪（幂等）；错过的终态由 brain-status 权威快照覆盖。
            const chIdx = pc.chapterIndex ?? 1;
            if (!mediaPollJobsRef.current.some((j) => j.cardId === cardId)) {
              pollMediaGen(world.title, chIdx, pc.mediaIds, pc.title, m.id, cardId, s.id);
            }
          } else if (pc.status === "running" && !pc.planId && !pc.mediaIds?.length && !pc.scenes?.length && !stuckMediaRef.current.has(cardId)) {
            // 分镜中卡但无 planId（提交后在补记前刷新，任务 id 丢失）且无 scenes（非生成提交中）：无法跟踪 → 标记失败提示重新提交。
            // 注意：生成提交中的卡（有 scenes、POST 未返回 mediaIds）不在此列——executeCard 会在 POST 返回后补记 mediaIds 续接跟踪。
            stuckMediaRef.current.add(cardId);
            void replaceCard(s.id, m.id, i, {
              kind: "preview", cardId,
              title: "分镜已中断",
              summary: "分镜任务提交未完成", status: "failed",
              detail: "刷新中断了分镜任务，请重新发起生成",
            }, true);
          }
        });
      }
    }
  }
};
