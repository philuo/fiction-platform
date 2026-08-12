// 中枢对话舱卡片组件库：卡片式浏览 + 智能控制的视觉载体
// 四类卡片：PreviewCard（操作预览）/ ConfirmCard（L2/L3 确认）/ ResultCard（执行结果）/ BrowseCard（浏览）
// 卡片类型定义同时供 PHASE 4 意图识别编排器产出
// 可选 image 字段：任意卡片可携带一张图（角色立绘/章节插画等），渲染在卡片内容上方
import { useEffect, useRef, useState, type ReactNode } from "react";
import { lensCn } from "../terms";
import { formatChapterRange } from "../shared/chapterRange";
import { RelationshipGraphCanvas, type RelationshipSubgraph } from "./RelationshipGraphCanvas";

// ============ 卡片数据类型 ============

/** 卡片附图（src 可为 data URI 或相对/绝对 URL） */
export type CardImage = { src: string; alt?: string };

export type BrainCardLevel = "L0" | "L1" | "L2" | "L3";
export type CardExecutionState = "idle" | "submitting" | "running" | "waiting_confirmation" | "succeeded" | "failed" | "interrupted" | "cancelled";

/** 卡片公共字段（新增字段向后兼容——旧卡片无 cardId 时跳过就地更新） */
export type BrainCardBase = {
  /** 卡片稳定标识（阶段 3a）：系统事件可就地更新该卡（如任务完成翻转状态）；未产出则跳过更新 */
  cardId?: string;
  executionState?: CardExecutionState;
  detail?: string;
  settledAt?: number;
};

export type PanelIntent = {
  intentId: string;
  target: string;
  opts?: Record<string, unknown>;
  consumedAt?: number;
  consumedBy?: string;
};

export type PreviewCard = BrainCardBase & {
  kind: "preview";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  summary: string;
  confirmRequired?: boolean;
  /** 客户端执行信息：点击「执行」时 fetch 对应 /api/novel/* 端点 */
  action?: { endpoint: string; method?: string; body: Record<string, unknown> };
  /** 附图（如写操作影响章节的主插画预览） */
  image?: CardImage;
  /** 异步任务状态（插画/视频生成：由 sync WS 就地更新，呈现在被操作的预览卡上） */
  status?: "running" | "done" | "failed";
  /** 任务状态详情（进度/错误信息） */
  detail?: string;
  /** running 态状态徽章文案（缺省「生成中」；分镜阶段用「分镜中」等） */
  statusLabel?: string;
  /** 操作按钮文案（缺省「执行」；媒体确认生成用「确认并生成」） */
  actionLabel?: string;
  /** 分镜任务 id（分镜中 running 卡：sync WS 快照用于刷新/多 Tab 恢复） */
  planId?: string;
  /** 分镜场景列表（分镜完成后呈现给用户；倒计时期间展示，确认后生成） */
  scenes?: { anchor: string; scene: string; caption?: string }[];
  /** 自动生成倒计时截止时间戳（ms）：3s 无手动操作自动生成；落盘跨刷新恢复对齐 */
  countdownAt?: number;
  /** 生成任务 mediaIds（生成中 running 卡：sync WS 快照用于刷新/多 Tab 恢复） */
  mediaIds?: string[];
  /** 目标章节（生成完成跳转左侧章节用） */
  chapterIndex?: number;
  /** 生成完成主 mediaId（跳转定位插画用） */
  mediaId?: string;
  /** 媒体类型（分镜中卡落盘供恢复扫描构建生成卡） */
  mediaKind?: "image" | "video";
};

export type ConfirmCard = BrainCardBase & {
  kind: "confirm";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  impact?: string;
  verdict?: string; // 闸门裁决 allow/reject
  options: ("merge" | "rewrite" | "abort")[];
  action?: { endpoint: string; method?: string; body: Record<string, unknown> };
};

export type ResultCard = BrainCardBase & {
  kind: "result";
  title: string;
  success: boolean;
  detail: string;
  image?: CardImage;
  /** open_* 意图 result 卡：打开面板/弹窗的显式协议（target + 定位 opts） */
  open?: { target: string; opts?: Record<string, unknown> };
  panelIntent?: PanelIntent;
};

export type BrowseCardAction = {
  label: string;
  danger?: boolean;
  action: { endpoint: string; method?: string; body: Record<string, unknown> };
};

export type BrowseCard = BrainCardBase & {
  kind: "browse";
  title: string;
  browseType:
    | "chapter" | "character" | "foreshadow" | "review" | "eval" | "proposal" | "gacha"
    // —— 查询扩展（Phase 1）：列表/进度/统计可视化 ——
    | "chapters" | "characters" | "plans" | "tasks" | "logs" | "worldbook" | "media"
    | "appearances" | "relationships" | "outline" | "timeline";
  data: unknown;
  /** 列表级可选操作（proposal 列表项内嵌 actions 由渲染层读取，此字段暂为列表级扩展） */
  actions?: BrowseCardAction[];
  /** 附图（如角色立绘/章节插画） */
  image?: CardImage;
};

/**
 * 可视化 data 约定（后端 executeQuery 产出，渲染层按 browseType 读取）：
 * - 通用进度字段：data.done / data.target（target 为 null 时不显示进度条）、data.pct 可选覆盖
 * - 统计网格：data.stats = Record<string, number>（chapters/characters/media/tasks 用）
 * - 列表：data.list = { 标题键, 元信息键, status?, score?, actions? }[]
 * - 内嵌操作：列表项 actions = { label, danger?, action: { endpoint, method, body } }[]
 */

/** 计划/意见选项卡（plan/opinion 共用）：中枢给出多个方向，用户点击遵循其意见 */
export type ChoiceOption = {
  label: string;
  description?: string;
  /** 可执行动作（点击后 fetch 端点） */
  action?: { endpoint: string; method?: string; body: Record<string, unknown> };
};

export type ChoiceCard = BrainCardBase & {
  kind: "plan" | "opinion";
  title: string;
  summary?: string;
  options: ChoiceOption[];
  selectedOption?: string;
  image?: CardImage;
};

// ============ 表单卡（FormCard）：结构化字段 → 填写 → 提交 ============

/** 媒体生成 form 卡（/api/novel/media/plan）当前选择的推导：章节 label + 张数（与后端 buildMediaCard 上限一致 clamp 3）。
 *  供卡片 summary（liveSummary）与消息正文（BrainCabin.mediaGuideText）共用，避免两处推导不一致。 */
export function mediaPlanDerived(card: { action?: { body?: Record<string, unknown> }; fields?: FormField[] }, values?: Record<string, unknown>): {
  kind: string;
  chapterLabel?: string;
  count: number;
} {
  const kind = String(card.action?.body?.kind ?? "image");
  const chapterField = card.fields?.[0];
  const countField = card.fields?.[1];
  const chapterValue = values?.[chapterField?.key ?? ""] ?? chapterField?.value;
  const chapterLabel = chapterField?.type === "select"
    ? chapterField.options?.find((o) => String(o.value) === String(chapterValue))?.label
    : undefined;
  const count = Math.max(1, Math.min(3, Number(values?.[countField?.key ?? ""] ?? countField?.value ?? 1) || 1)); // 与 buildMediaCard Math.min(3, count) 一致
  return { kind, chapterLabel, count };
}

/** 表单字段定义（与后端 brain-chat.ts FormFieldDef 结构一致） */
export type FormField = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "multiselect";
  value?: string | number | string[];
  options?: { label: string; value: string }[];
  placeholder?: string;
  required?: boolean;
  /** textarea 按行拆分数组提交 */
  array?: boolean;
  /** "bool"：开/关 → boolean */
  transform?: "bool";
};

export type FormCard = BrainCardBase & {
  kind: "form";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  summary?: string;
  fields: FormField[];
  action: { endpoint: string; method?: string; body: Record<string, unknown> };
  submitLabel?: string;
  /** L2/L3 提示：提交可能触发干预确认 */
  confirmRequired?: boolean;
  image?: CardImage;
};

/** 写作进度卡（推进剧情/自动连载聊天内流式展示）：阶段步骤条 + 流式正文 + 状态 */
export type ProgressCard = BrainCardBase & {
  kind: "progress";
  title: string;
  /** 当前阶段（start/writing/reviewing/settling/saving/result/pending-commit/auto-status/auto-done…） */
  phase?: string;
  /** 流式正文（写作 delta 累积；运行中实时更新） */
  text?: string;
  status: "running" | "done" | "failed";
  detail?: string;
};

/** 追问选择卡（ask）：中枢信息不足时向用户询问（不渲染进聊天流，显示在输入框上方询问面板；刷新后恢复） */
export type AskCard = BrainCardBase & {
  kind: "ask";
  question: string;
  options: { label: string; description?: string }[];
};

export type BrainCard = PreviewCard | ConfirmCard | ResultCard | BrowseCard | ChoiceCard | FormCard | ProgressCard | AskCard;

// ============ 级别徽章 ============

const LEVEL_LABEL: Record<BrainCardLevel, string> = {
  L0: "L0·只读", L1: "L1·前瞻", L2: "L2·回溯", L3: "L3·不可逆",
};

function LevelBadge({ level }: { level?: BrainCardLevel }) {
  if (!level) return null;
  return <span className={`bc-level bc-level-${level}`}>{LEVEL_LABEL[level]}</span>;
}

function CommandBadge({ commandId }: { commandId?: string }) {
  if (!commandId) return null;
  return <span className="bc-cmd" title={`指令 ${commandId}`}>{commandId}</span>;
}

const EXECUTION_LABEL: Record<CardExecutionState, string> = {
  idle: "待执行", submitting: "提交中", running: "运行中", waiting_confirmation: "等待确认",
  succeeded: "已完成", failed: "失败", interrupted: "已中断", cancelled: "已取消",
};

function ExecutionBadge({ state }: { state?: CardExecutionState }) {
  if (!state || state === "idle") return null;
  return <span className={`bc-execution-badge bc-execution-${state}`}>{EXECUTION_LABEL[state]}</span>;
}

function isExecutionBusy(state?: CardExecutionState): boolean {
  return state === "submitting" || state === "running";
}

function isExecutionDone(state?: CardExecutionState): boolean {
  // Interrupted/cancelled/failed are terminal outcomes, but remain retryable.
  // Only a durable success should remove the action affordance.
  return state === "succeeded";
}

// ============ PreviewCard 操作预览卡 ============

export const PreviewCardView: React.FC<{
  card: PreviewCard;
  onExecute?: () => void;
  busy?: boolean;
  completed?: boolean;
  /** 生成完成跳转（done 态「查看插画」按钮） */
  onGoToMedia?: (chapterIndex: number, mediaId: string) => void;
}> = ({ card, onExecute, busy, completed, onGoToMedia }) => {
  const running = card.status === "running" || isExecutionBusy(card.executionState);
  const failed = card.status === "failed" || card.executionState === "failed" || card.executionState === "interrupted";
  // failed 覆盖 completed 展示（任务失败时优先显示失败态，按钮保留可重试）
  const done = card.status === "done" || isExecutionDone(card.executionState) || (completed && !failed);
  // 分镜完成待自动生成（scenes + countdownAt，无 status）：展示场景 + 倒计时 + 立即生成按钮
  const awaitingAuto = !!card.scenes?.length && !!card.countdownAt && !running && !failed && !done;
  // 倒计时剩余秒：本地每秒刷新（countdownAt 为截止时间戳，跨刷新恢复后自动对齐）
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil(((card.countdownAt ?? 0) - Date.now()) / 1000)));
  useEffect(() => {
    if (!card.countdownAt) return;
    const t = window.setInterval(() => {
      const n = Math.max(0, Math.ceil(((card.countdownAt ?? 0) - Date.now()) / 1000));
      setLeft(n);
      if (n <= 0) window.clearInterval(t);
    }, 500);
    return () => window.clearInterval(t);
  }, [card.countdownAt]);
  return (
    <div className={`brain-card brain-card-preview${done ? " bc-card-done" : ""}${card.status ? ` bc-preview-${card.status}` : ""}`}>
      <div className="brain-card-head">
        <span className="brain-card-title">{done ? "✓ " : ""}{card.title}</span>
        <CommandBadge commandId={card.commandId} />
        <LevelBadge level={card.level} />
        <ExecutionBadge state={card.executionState} />
        {card.confirmRequired && !done && <span className="bc-confirm-tag">需确认</span>}
      </div>
      <p className="brain-card-body">{card.summary}</p>
      {card.scenes?.length ? (
        <div className="bc-scenes">
          {card.scenes.map((sc, i) => (
            <div className="bc-scene" key={i}>
              <span className="bc-scene-idx">{i + 1}</span>
              <div className="bc-scene-body">
                <div className="bc-scene-caption">{sc.caption || sc.anchor}</div>
                {sc.caption && sc.anchor ? <div className="bc-scene-anchor">「{sc.anchor}」</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {running && (
        <p className="bc-task-status bc-task-running">
          <span className="bc-progress-pill bc-progress-pill-running">{card.statusLabel ?? "生成中"}</span>
          {card.detail ? `：${card.detail}` : "…"}
        </p>
      )}
      {failed && (
        <p className="bc-task-status bc-task-failed">
          <span className="bc-progress-pill bc-progress-pill-failed">{card.executionState === "interrupted" ? "已中断" : card.executionState === "cancelled" ? "已取消" : "生成失败"}</span>
          {card.detail ? `：${card.detail}` : ""}
        </p>
      )}
      {!running && !failed && card.detail && <p className="bc-task-status">{card.detail}</p>}
      {awaitingAuto && (
        <p className="bc-task-status bc-task-countdown">
          <span className="bc-progress-pill bc-progress-pill-running">倒计时 {left}s</span>
          ：{left > 0 ? "无操作将自动生成" : "即将自动生成…"}
        </p>
      )}
      {(card.action && onExecute) || (done && card.mediaId && onGoToMedia) ? (
        <div className="brain-card-actions">
          {done && card.mediaId && onGoToMedia ? (
            <button className="btn-save btn-xs" onClick={() => onGoToMedia(card.chapterIndex ?? 1, card.mediaId as string)}>{card.mediaKind === "video" ? "🎬 查看视频" : "🖼 查看插画"}</button>
          ) : done ? (
            <span className="bc-done-tag">{completed ? "✓ 已执行" : "✓ 已完成"}</span>
          ) : (
            <button className="btn-save btn-xs" disabled={busy || running} onClick={onExecute}>{running ? "处理中…" : failed ? "重试" : (card.actionLabel ?? "执行")}</button>
          )}
        </div>
      ) : null}
    </div>
  );
};

// ============ ConfirmCard 确认卡（L2/L3 三选一） ============

export const ConfirmCardView: React.FC<{
  card: ConfirmCard;
  onChoose?: (opt: "merge" | "rewrite" | "abort") => void;
  busy?: boolean;
  completed?: boolean;
}> = ({ card, onChoose, busy, completed }) => {
  const optLabel: Record<string, string> = { merge: "① 正向弥合", rewrite: "② 回溯重写", abort: "③ 放弃" };
  const stateDone = isExecutionDone(card.executionState);
  const stateBusy = isExecutionBusy(card.executionState);
  return (
    <div className={`brain-card brain-card-confirm${completed || stateDone ? " bc-card-done" : ""}`}>
      <div className="brain-card-head">
        <span className="brain-card-title">{completed ? "✓ " : ""}{card.title}</span>
        <CommandBadge commandId={card.commandId} />
        <LevelBadge level={card.level} />
        <ExecutionBadge state={card.executionState} />
      </div>
      {card.impact && <p className="brain-card-impact">{card.impact}</p>}
      {card.verdict && <p className="brain-card-verdict">闸门裁决：{card.verdict === "allow" ? "放行" : card.verdict === "reject" ? "驳回" : String(card.verdict)}</p>}
      {card.detail && <p className={`brain-card-body${card.executionState === "failed" ? " bc-task-failed" : ""}`}>{card.detail}</p>}
      <div className="brain-card-actions">
        {completed || stateDone ? (
          <span className="bc-done-tag">✓ 已处理</span>
        ) : (
          card.options.map((opt) => (
            <button key={opt} className="btn-save btn-xs" disabled={busy || stateBusy} onClick={() => onChoose?.(opt)}>
              {optLabel[opt]}
            </button>
          ))
        )}
      </div>
    </div>
  );
};

// ============ 台账·日志中文标签（与 MemoryAuditModal 一致） ============
const ACTOR_TEXT: Record<string, string> = { user: "用户", ai: "AI", brain: "中枢", system: "系统", integrity: "自检", auto: "连载", critic: "审查" };
/** 指令级别徽章文本（L0-L3，对已完成叙事/账本的破坏性） */
const LEVEL_TEXT: Record<string, string> = { L0: "L0·只读", L1: "L1·前瞻", L2: "L2·回溯", L3: "L3·不可逆" };

/** 列表默认显示条数上限：超过则截断 + 「展开全部」（长列表可折叠） */
const MAX_LIST_ITEMS = 6;

/** 时间戳 → MM-DD HH:MM（logs 卡台账时间，替代 ISO 原始串） */
function fmtCardTime(at: unknown): string {
  const ts = typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(ts)) return String(at ?? "");
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return d.getMonth() + 1 + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** 列表截断按钮（超过 MAX_LIST_ITEMS 时显示） */
function ListMoreButton({ total, shown, onToggle }: { total: number; shown: boolean; onToggle: () => void }) {
  if (total <= MAX_LIST_ITEMS) return null;
  return (
    <button className="bc-list-more" onClick={onToggle}>
      {shown ? "收起" : "还有 " + (total - MAX_LIST_ITEMS) + " 条 · 展开全部"}
    </button>
  );
}

// ============ ResultCard 结果卡 ============

export const ResultCardView: React.FC<{ card: ResultCard }> = ({ card }) => (
  <div className={`brain-card brain-card-result ${card.success ? "ok" : "fail"}`}>
    <div className="brain-card-head">
      <span className="brain-card-title">{card.success ? "✓ " : "✗ "}{card.title}</span>
    </div>
    <p className="brain-card-body">{card.detail}</p>
  </div>
);

// ============ BrowseCard 浏览卡 ============

type ProposalListItem = Record<string, unknown> & {
  actions?: { label?: string; danger?: boolean; action?: BrowseCardAction["action"] }[];
};

// ============ 可视化辅助组件（Phase 1 查询卡共用） ============

/** 进度条：done/target；target 为 null/0 时不渲染 */
function CardProgressBar({ done, target }: { done?: unknown; target?: unknown }) {
  const d = Number(done ?? 0);
  const t = Number(target ?? 0);
  if (!(t > 0)) return null;
  const pct = Math.min(100, Math.round((d / t) * 100));
  return (
    <div className="bc-progress">
      <div className="bc-progress-bar"><span className="bc-progress-fill" style={{ width: `${pct}%` }} /></div>
      <span className="bc-progress-label">{d} / {t}（{pct}%）</span>
    </div>
  );
}

/** 统计网格：stats = Record<标签, 数值> */
function CardStats({ stats }: { stats?: unknown }) {
  const s = stats as Record<string, unknown> | null | undefined;
  if (!s) return null;
  const entries = Object.entries(s).filter(([, v]) => v != null);
  if (!entries.length) return null;
  return (
    <div className="bc-stats">
      {entries.map(([k, v]) => (
        <span className="bc-stat" key={k}><b>{String(v)}</b>{k}</span>
      ))}
    </div>
  );
}

/** 状态徽章（level 决定配色：ok=绿 / warn=琥珀 / danger=红 / info=灰） */
function CardStatusBadge({ status, level }: { status?: unknown; level?: "ok" | "warn" | "danger" | "info" }) {
  if (status == null || status === "") return null;
  return <span className={`bc-badge ${level ? `bc-badge-${level}` : "bc-badge-info"}`}>{String(status)}</span>;
}

/** 分数徽章（如审查 coherence 分） */
function CardScore({ score }: { score?: unknown }) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const cls = s >= 8 ? "bc-badge-ok" : s >= 6 ? "bc-badge-warn" : "bc-badge-danger";
  return <span className={`bc-badge ${cls}`}>分 {s}</span>;
}

/** 列表项内嵌操作按钮（proposal/tasks 共用） */
function CardItemActions({
  item, busy, onAction, completed,
}: {
  item: Record<string, unknown>;
  busy?: boolean;
  onAction?: (action: BrowseCardAction["action"]) => void;
  /** 该列表项操作已成功执行：按钮替换为完成标记（防重复提交 + 就地反馈） */
  completed?: boolean;
}) {
  const actions = item.actions as ProposalListItem["actions"] | undefined;
  if (!Array.isArray(actions) || actions.length === 0 || !onAction) return null;
  return (
    <div className="bc-browse-actions">
      {completed ? (
        <span className="bc-done-tag">✓ 已处理</span>
      ) : (
        actions.map((a, j) =>
          a.action ? (
            <button
              key={j}
              className={`btn-save btn-xs${a.danger ? " btn-danger-sm" : ""}`}
              disabled={busy}
              onClick={() => onAction(a.action!)}
            >
              {a.label ?? "执行"}
            </button>
          ) : null,
        )
      )}
    </div>
  );
}

/** 列表项包装：主文本 + 元信息 + 徽章 + 操作 */
function CardListItem({ item, title, meta, status, statusLevel, score }: {
  item: Record<string, unknown>;
  title: ReactNode;
  meta?: ReactNode;
  status?: unknown;
  statusLevel?: "ok" | "warn" | "danger" | "info";
  score?: unknown;
}) {
  return (
    <div className="bc-browse-item">
      <div className="bc-browse-item-head">
        <span className="bc-browse-item-title">{title}</span>
        <span className="bc-browse-item-badges">
          <CardScore score={score} />
          <CardStatusBadge status={status} level={statusLevel} />
        </span>
      </div>
      {meta && <div className="bc-browse-meta">{meta}</div>}
    </div>
  );
}

/** 内嵌操作注入：给已渲染列表项追加操作按钮（与渲染体共享 item 数据） */
function WithItemActions({ item, busy, onAction, completed, children }: {
  item: Record<string, unknown>;
  busy?: boolean;
  onAction?: (action: BrowseCardAction["action"]) => void;
  completed?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <CardItemActions item={item} busy={busy} onAction={onAction} completed={completed} />
    </>
  );
}

/** 列表型浏览卡（长内容）默认折叠为标题行，点击展开——避免任务/查询消息淹没对话流 */
const FOLD_BROWSE_TYPES = new Set(["chapters", "characters", "plans", "tasks", "logs", "worldbook", "media", "review", "gacha", "proposal"]);

export const BrowseCardView: React.FC<{
  card: BrowseCard;
  onAction?: (action: BrowseCardAction["action"]) => void;
  busy?: boolean;
  /** 已成功执行操作的列表项 id 集合（对应项按钮替换为完成标记） */
  completedItems?: ReadonlySet<string>;
}> = ({ card, onAction, busy, completedItems }) => {
  const [open, setOpen] = useState(() => !FOLD_BROWSE_TYPES.has(card.browseType));
  /** 长列表是否显示全部（截断状态：默认前 MAX_LIST_ITEMS 条 + 展开全部） */
  const [showAllList, setShowAllList] = useState(false);
  /** 章节正文是否显示全文（默认截断预览 + 展开全文交互，正文长内容可看全貌） */
  const [showFullText, setShowFullText] = useState(false);
  const [showArrangement, setShowArrangement] = useState(false);
  let body: ReactNode = null;
  const d = card.data as Record<string, unknown> | null;
  if (card.browseType === "chapter" && d) {
    // 章节正文：默认截断预览，可「展开全文」查看全貌（长正文不淹没对话流，且不会只看半截）
    const fullText = String(d.text ?? "");
    const CHAP_PREVIEW = 200;
    const chapTruncated = fullText.length > CHAP_PREVIEW;
    body = (
      <>
        <p className="bc-browse-text">{showFullText || !chapTruncated ? fullText : fullText.slice(0, CHAP_PREVIEW) + "…"}</p>
        {chapTruncated && (
          <button className="bc-list-more" onClick={() => setShowFullText((v) => !v)}>
            {showFullText ? "收起全文" : `展开全文（共 ${fullText.length} 字）`}
          </button>
        )}
      </>
    );
  } else if (card.browseType === "character" && d) {
    // 角色卡：紧凑事实行 + 短段落 + 关系标签；后续安排默认折叠。
    const relations = (Array.isArray(d.relations) ? d.relations : []) as Record<string, unknown>[];
    const appeared = (Array.isArray(d.appeared) ? d.appeared : []) as number[];
    const arrangement = (Array.isArray(d.arrangement) ? d.arrangement : []) as string[];
    // 标题已是「{name} · {role}」（定位由标题 label 表达），网格不再重复展示定位
    const attrRows: [string, unknown][] = [["状态", d.status], ["年龄", d.age], ["身份", d.identity], ["声线", d.voice]];
    const facts = attrRows.filter(([, value]) => value != null && value !== "");
    body = (
      <>
        {facts.length > 0 && (
          <div className="bc-character-facts">
            {facts.map(([key, value]) => (
              <span className="bc-character-fact" key={key}><b>{key}</b>{String(value)}</span>
            ))}
          </div>
        )}
        {d.look ? <p className="bc-character-copy"><b>形象</b>{String(d.look)}</p> : null}
        {d.motivation ? <p className="bc-character-copy"><b>动机</b>{String(d.motivation)}</p> : null}
        {d.exit ? <p className="bc-character-copy bc-character-exit"><b>离场</b>第 {String((d.exit as Record<string, unknown>).chapter)} 章 · {String((d.exit as Record<string, unknown>).reason ?? "")}</p> : null}
        {relations.length > 0 && (
          <div className="bc-character-relations" aria-label={`关系 ${relations.length} 条`}>
            {relations.map((r, i) => (
              <span key={i} className="bc-character-relation"><b>{String(r.name ?? "")}</b>{String(r.relation ?? "")}</span>
            ))}
          </div>
        )}
        <div className="bc-character-meta">
          <span className="bc-badge bc-badge-info">出场 {String(d.appearedCount ?? appeared.length)} 次</span>
          {appeared.length > 0 && <span>第 {formatChapterRange(appeared)} 章</span>}
        </div>
        {arrangement.length > 0 && (
          <div className="bc-character-arrangement">
            <button className="bc-list-more" onClick={() => setShowArrangement((value) => !value)} aria-expanded={showArrangement}>
              {showArrangement ? "收起后续安排" : `后续安排 ${arrangement.length} 项`}
            </button>
            {showArrangement && <div className="bc-character-arrangement-list">{arrangement.map((item, index) => <p key={index}>{item}</p>)}</div>}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "appearances" && d) {
    // 某章出场角色：章标题 + 角色列表（立绘标记）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <div className="bc-browse-list">
          {list.map((c, i) => (
            <div key={i} className="bc-browse-item">
              <span className="bc-browse-item-title">{String(c.name ?? "")}</span>
              <span className="bc-browse-meta">{String(c.role ?? "")}{c.portrait ? " · 有立绘" : ""}{c.status ? ` · ${String(c.status)}` : ""}</span>
            </div>
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "relationships" && d) {
    // 人物关系：轻量摘要 + 只读一跳子图；无边时不渲染空画布。
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    const subgraph = d.subgraph as RelationshipSubgraph | undefined;
    body = (
      <>
        {list.length === 0 && <div className="bc-empty-state">暂未记录人物关系</div>}
        <div className="bc-browse-list">
          {list.map((r, i) => (
            <div key={i} className="bc-browse-item bc-rel-item">
              <span className="bc-browse-item-title">{String(r.a ?? "")}</span>
              <span className="bc-rel-arrow">-({String(r.relation ?? "")})-</span>
              <span className="bc-browse-item-title">{String(r.b ?? "")}</span>
            </div>
          ))}
        </div>
        {subgraph && subgraph.nodes.length > 0 && subgraph.edges.length > 0 && (
          <div className="bc-relationship-graph">
            <RelationshipGraphCanvas graph={subgraph} ariaLabel={`${card.title}只读关系子图`} />
          </div>
        )}
      </>
    );
  } else if (card.browseType === "outline" && d) {
    // 全书大纲：主题 + 指南针 + 卷 + 弧线 + 进度
    const volumes = (Array.isArray(d.volumes) ? d.volumes : []) as Record<string, unknown>[];
    const arcs = (Array.isArray(d.arcs) ? d.arcs : []) as Record<string, unknown>[];
    body = (
      <>
        {d.premise ? <p className="bc-browse-text">{String(d.premise)}</p> : null}
        <div className="bc-stats">
          <span className="bc-stat"><b>{String(d.done ?? "")}</b>已写章</span>
          <span className="bc-stat"><b>{String(d.target ?? "")}</b>目标章</span>
          {d.compass ? <span className="bc-stat"><b>{String(d.compass)}</b>指南针</span> : null}
        </div>
        {volumes.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">卷</div>
            {volumes.map((v, i) => (
              <div key={i} className="bc-browse-item">
                <span className="bc-browse-item-title">{String(v.title ?? "")}</span>
                <span className="bc-browse-meta">{String(v.status ?? "")}{v.range ? ` · 第 ${String((v.range as number[])[0])}-${String((v.range as number[])[1])} 章` : ""}</span>
                {v.goal ? <p className="bc-browse-text">{String(v.goal)}</p> : null}
              </div>
            ))}
          </div>
        )}
        {arcs.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">弧线</div>
            {arcs.map((a, i) => (
              <div key={i} className="bc-browse-item">
                <span className="bc-browse-item-title">{String(a.title ?? "")}</span>
                <span className="bc-browse-meta">{String(a.status ?? "")}{a.estChapters ? ` · 约 ${String(a.estChapters)} 章` : ""}</span>
                {a.goal ? <p className="bc-browse-text">{String(a.goal)}</p> : null}
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "timeline" && d) {
    // 故事脉络：卷 → 弧 → 章 进展链
    const volumes = (Array.isArray(d.volumes) ? d.volumes : []) as Record<string, unknown>[];
    body = (
      <>
        <div className="bc-stats">
          <span className="bc-stat"><b>下一章</b>第 {String(d.next ?? "")} 章</span>
          {d.target ? <span className="bc-stat"><b>{String(d.target)}</b>目标章</span> : null}
        </div>
        {volumes.map((v, i) => (
          <div key={i} className="bc-browse-list">
            <div className="bc-browse-sec">{String(v.title ?? "")} · {String(v.status ?? "")}</div>
            {(Array.isArray(v.arcs) ? v.arcs : []).map((a, j) => (
              <div key={`a${j}`} className="bc-browse-item">
                <span className="bc-browse-item-title">弧：{String((a as Record<string, unknown>).title ?? "")}</span>
                <span className="bc-browse-meta">{String((a as Record<string, unknown>).status ?? "")}</span>
              </div>
            ))}
            {(Array.isArray(v.chapters) ? v.chapters : []).map((ch, j) => (
              <div key={`c${j}`} className="bc-browse-item">
                <span className="bc-browse-item-id">第 {String((ch as Record<string, unknown>).index ?? "")} 章</span>
                <span className="bc-browse-item-title">{String((ch as Record<string, unknown>).title ?? "")}</span>
                <span className="bc-browse-meta">{String((ch as Record<string, unknown>).status ?? "")}</span>
              </div>
            ))}
          </div>
        ))}
      </>
    );
  } else if (card.browseType === "foreshadow" && d) {
    const list = (Array.isArray(d.list) ? d.list : [d]) as Record<string, unknown>[];
    body = (
      <div className="bc-browse-list">
        {list.map((f, i) => (
          <div key={i} className="bc-browse-item">
            <span className="bc-browse-item-id">伏笔 · {String(f.id ?? "")}</span>
            <p className="bc-browse-text">{String(f.text ?? "")}</p>
            <span className="bc-browse-meta">状态：{String(f.status ?? "")}｜埋于第 {String(f.plantedAt ?? "")} 章</span>
          </div>
        ))}
      </div>
    );
  } else if (card.browseType === "proposal" && d) {
    // 新角色提案：推荐原因 + 动机 + 确认/拒绝操作（卡片可交互，允许操作）
    const list = (Array.isArray(d.list) ? d.list : [d]) as ProposalListItem[];
    body = (
      <div className="bc-browse-list">
        {list.map((p, i) => (
          <div key={String(p.id ?? i)} className="bc-browse-item bc-proposal-item">
            <div className="bc-proposal-head">
              <span className="bc-browse-item-id">角色提案 · {String(p.source === "gacha" ? "抽卡" : "剧情")}</span>
              <span className="bc-proposal-name">「{String(p.name ?? "")}」{String(p.role ?? "")}</span>
            </div>
            {p.reason ? <p className="bc-proposal-reason">推荐原因：{String(p.reason)}</p> : null}
            {p.motivation ? <p className="bc-browse-meta">动机：{String(p.motivation)}</p> : null}
            <CardItemActions item={p} busy={busy} onAction={onAction} completed={completedItems?.has(String(p.id ?? i))} />
          </div>
        ))}
      </div>
    );
  } else if (card.browseType === "gacha" && d) {
    // 抽卡卡池：稀有度色标 + 类型标签 + 卡牌信息 + 逐张应用；顶部全部应用（AI 优选）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardItemActions item={{ actions: card.actions }} busy={busy} onAction={onAction} />
        <div className="bc-gacha-grid">
          {list.map((c) => (
            <div key={String(c.id ?? "")} className={`bc-gacha-card bc-gacha-${String(c.rarity ?? "N").toLowerCase()}`}>
              <div className="bc-gacha-head">
                <span className="bc-gacha-rarity">{String(c.rarity ?? "N")}</span>
                <span className="bc-gacha-type">{String(c.type ?? "")}</span>
              </div>
              <div className="bc-gacha-title">{String(c.title ?? "")}</div>
              {c.description ? <p className="bc-browse-text">{String(c.description)}</p> : null}
              {c.effect ? <p className="bc-gacha-effect">效果：{String(c.effect)}</p> : null}
              {c.dueHint ? <p className="bc-browse-meta">回收时机：{String(c.dueHint)}</p> : null}
              {(c.character as Record<string, unknown> | null) && (
                <p className="bc-browse-meta">
                  人物：{String((c.character as Record<string, unknown>).name)} · {String((c.character as Record<string, unknown>).role)}
                  {((c.character as Record<string, unknown>).traits as unknown[])?.length ? ` · ${((c.character as Record<string, unknown>).traits as unknown[]).map(String).join("/")}` : ""}
                </p>
              )}
              <CardItemActions item={c} busy={busy} onAction={onAction} completed={completedItems?.has(String(c.id ?? ""))} />
            </div>
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "chapters" && d) {
    // 章节目录：进度条 + 每章（状态徽章/分数/字数/媒体数）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardProgressBar done={d.done} target={d.target} />
        <div className="bc-browse-list">
          {list.map((c) => (
            <CardListItem
              key={String(c.index ?? "")}
              item={c}
              title={<span className="bc-browse-item-id">第 {String(c.index ?? "")} 章 · {String(c.title ?? "")}</span>}
              meta={<>{String(c.words ?? 0)} 字 · {String(c.media ?? 0)} 媒体</>}
              status={c.status}
              statusLevel={c.status === "需修订" ? "warn" : "ok"}
              score={c.score}
            />
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "characters" && d) {
    // 角色列表：统计网格 + 每角色（定位/身份/状态/出场/立绘）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    // 统计网格键名中文化（后端/历史数据存 total/withPortrait/appeared，展示层统一映射为中文）
    const CHARACTERS_STATS_CN: Record<string, string> = { total: "角色总数", withPortrait: "有立绘", appeared: "已出场" };
    const statsCn = (d.stats as Record<string, unknown> | null | undefined)
      ? Object.fromEntries(Object.entries(d.stats as Record<string, unknown>).map(([k, v]) => [CHARACTERS_STATS_CN[k] ?? k, v]))
      : undefined;
    body = (
      <>
        <CardStats stats={statsCn} />
        <div className="bc-browse-list">
          {list.map((c) => (
            <CardListItem
              key={String(c.name ?? "")}
              item={c}
              title={<span className="bc-browse-item-title">「{String(c.name ?? "")}」· {String(c.role ?? "")}</span>}
              meta={<>{[c.gender, c.age, c.identity].filter(Boolean).map(String).join(" · ")}｜出场 {String(c.appeared ?? 0)} 章{c.portrait ? "｜立绘✓" : ""}</>}
              status={c.status}
              statusLevel={c.portrait ? "ok" : "info"}
            />
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "plans" && d) {
    // 计划/章纲：章纲进度条 + 指南针 + 卷 + 弧 + 章纲（next 高亮）
    const volumes = (Array.isArray(d.volumes) ? d.volumes : []) as Record<string, unknown>[];
    const arcs = (Array.isArray(d.arcs) ? d.arcs : []) as Record<string, unknown>[];
    const plans = (Array.isArray(d.plans) ? d.plans : []) as Record<string, unknown>[];
    const next = d.next as Record<string, unknown> | null | undefined;
    body = (
      <>
        <CardProgressBar done={d.done} target={d.target} />
        {d.compass ? <p className="bc-browse-quote">指南针：{String(d.compass)}</p> : null}
        {d.progressContract ? <p className="bc-browse-meta">进度承诺：{String(d.progressContract)}</p> : null}
        {volumes.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">卷</div>
            {volumes.map((v) => (
              <CardListItem
                key={String(v.title ?? "")}
                item={v}
                title={<span className="bc-browse-item-title">{String(v.title ?? "")}</span>}
                meta={v.goal ? <>{String(v.goal)}</> : null}
                status={v.status === "done" ? "完成" : v.status === "writing" ? "写作中" : v.status === "planned" ? "已规划" : String(v.status ?? "")}
                statusLevel={v.status === "done" ? "ok" : v.status === "writing" ? "warn" : "info"}
              />
            ))}
          </div>
        )}
        {arcs.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">故事弧</div>
            {arcs.map((a) => (
              <CardListItem
                key={String(a.title ?? "")}
                item={a}
                title={<span className="bc-browse-item-title">{String(a.title ?? "")}</span>}
                meta={a.goal ? <>{String(a.goal)}｜约 {String(a.estChapters ?? "?")} 章</> : null}
                status={a.status === "done" ? "完成" : a.status === "expanded" ? "已展开" : a.status === "skeleton" ? "骨架" : a.status === "writing" ? "写作中" : String(a.status ?? "")}
                statusLevel={a.status === "done" ? "ok" : a.status === "writing" || a.status === "expanded" ? "warn" : "info"}
              />
            ))}
          </div>
        )}
        {plans.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">章纲</div>
            {plans.map((p) => (
              <div key={String(p.index ?? "")} className={`bc-browse-item${next && p.index === next.index ? " bc-next" : ""}`}>
                <span className="bc-browse-item-title">第 {String(p.index ?? "")} 章 · {String(p.goal ?? "")}</span>
                <span className="bc-browse-item-badges"><CardStatusBadge status={p.status === "done" ? "完成" : "待写"} level={p.status === "done" ? "ok" : "warn"} /></span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "tasks" && d) {
    // 任务中心：统计 + 质量债（内嵌 fix/ignore）+ 重写队列 + 弥合任务（质量债超长默认截断，可展开全部）
    const debt = (Array.isArray(d.debt) ? d.debt : []) as Record<string, unknown>[];
    const shownDebt = showAllList ? debt : debt.slice(0, MAX_LIST_ITEMS);
    const rewriteQueue = (Array.isArray(d.rewriteQueue) ? d.rewriteQueue : []) as number[];
    const mergeTasks = (Array.isArray(d.mergeTasks) ? d.mergeTasks : []) as string[];
    body = (
      <>
        <CardStats stats={{ 质量债: debt.length, 严重: d.major ?? 0, 重写队列: rewriteQueue.length, 弥合任务: mergeTasks.length }} />
        {debt.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">质量债</div>
            {shownDebt.map((t) => (
              <WithItemActions key={String(t.id ?? "")} item={t} busy={busy} onAction={onAction} completed={completedItems?.has(String(t.id ?? ""))}>
                <div className="bc-browse-item">
                  <div className="bc-browse-item-head">
                    <span className="bc-browse-item-title">第 {String(t.chapterIndex ?? "")} 章 · {lensCn(String(t.lens ?? ""))}</span>
                    <span className="bc-browse-item-badges"><CardStatusBadge status={t.severity === "major" ? "严重" : "轻微"} level={t.severity === "major" ? "danger" : "info"} /></span>
                  </div>
                  <p className="bc-browse-text">{String(t.issue ?? "")}</p>
                </div>
              </WithItemActions>
            ))}
            <ListMoreButton total={debt.length} shown={showAllList} onToggle={() => setShowAllList((v) => !v)} />
          </div>
        )}
        {rewriteQueue.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">回溯重写队列</div>
            <div className="bc-chip-row">{rewriteQueue.map((i) => <span key={i} className="bc-chip">第 {i} 章</span>)}</div>
            <p className="bc-browse-meta">可通过「重写章节」消费或清空队列</p>
          </div>
        )}
        {mergeTasks.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">弥合任务</div>
            {mergeTasks.map((t, i) => <p key={i} className="bc-browse-text">· {t}</p>)}
          </div>
        )}
        {debt.length === 0 && rewriteQueue.length === 0 && mergeTasks.length === 0 && (
          <p className="bc-browse-text">当前没有待处理任务 🎉</p>
        )}
      </>
    );
  } else if (card.browseType === "logs" && d) {
    // 台账·操作日志：时间（MM-DD HH:MM）+ actor + kind + commandId + detail（超长默认截断）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    const shownLogs = showAllList ? list : list.slice(0, MAX_LIST_ITEMS);
    body = (
      <div className="bc-browse-list">
        {shownLogs.map((e, i) => (
          <div key={i} className="bc-browse-item bc-log-item">
            <div className="bc-browse-item-head">
              <span className="bc-browse-item-id">{String(e.kind ?? "")}{e.commandId ? ` · ${String(e.commandId)}` : ""}</span>
              {e.level ? <CardStatusBadge status={LEVEL_TEXT[e.level as string] ?? String(e.level)} level={e.level === "L3" ? "danger" : e.level === "L2" ? "warn" : "info"} /> : null}
            </div>
            <p className="bc-browse-text">{String(e.detail ?? "")}</p>
            <span className="bc-browse-meta">{fmtCardTime(e.at)} · {ACTOR_TEXT[String(e.actor ?? "")] ?? String(e.actor ?? "")}{e.chapter ? ` · 第 ${e.chapter} 章` : ""}</span>
          </div>
        ))}
        <ListMoreButton total={list.length} shown={showAllList} onToggle={() => setShowAllList((v) => !v)} />
      </div>
    );
  } else if (card.browseType === "worldbook" && d) {
    // 设定·世界书：setting 摘要 + lore 条目
    const setting = d.setting as Record<string, unknown> | null | undefined;
    const rules = (Array.isArray(setting?.rules) ? setting.rules : []) as string[];
    const lore = (Array.isArray(d.lore) ? d.lore : []) as Record<string, unknown>[];
    body = (
      <>
        {setting && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">设定</div>
            <div className="bc-browse-item">
              <p className="bc-browse-text">时代 {String(setting.time ?? "—")}｜地点 {String(setting.place ?? "—")}｜基调 {String(setting.tone ?? "—")}</p>
              {rules.length > 0 && <div className="bc-chip-row">{rules.map((r, i) => <span key={i} className="bc-chip">{r}</span>)}</div>}
            </div>
          </div>
        )}
        {lore.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">世界书（{lore.length} 条）</div>
            {lore.map((l, i) => (
              <div key={i} className="bc-browse-item">
                <div className="bc-browse-item-head">
                  <span className="bc-browse-item-title">{String((l.keywords as string[] | undefined)?.join("、") ?? "")}</span>
                  <CardStatusBadge status={l.enabled === false ? "关闭" : "启用"} level={l.enabled === false ? "info" : "ok"} />
                </div>
                <p className="bc-browse-text">{String(l.content ?? "")}</p>
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "media" && d) {
    // 媒体资源：统计 + 列表（类型/章节/图注/状态）
    const list = (Array.isArray(d.list) ? d.list : []) as Record<string, unknown>[];
    body = (
      <>
        <CardStats stats={{ 插画: d.stats ? (d.stats as Record<string, unknown>).images ?? 0 : 0, 视频: d.stats ? (d.stats as Record<string, unknown>).videos ?? 0 : 0, 角色立绘: d.stats ? (d.stats as Record<string, unknown>).characters ?? 0 : 0 }} />
        <div className="bc-browse-list">
          {list.map((m, i) => (
            <div key={i} className="bc-browse-item">
              <div className="bc-browse-item-head">
                <span className="bc-browse-item-title">{m.kind === "video" ? "🎬" : "🖼"} 第 {String(m.chapter ?? "")} 章{m.caption ? ` · ${String(m.caption)}` : ""}</span>
                <CardStatusBadge status={m.status === "ready" ? "就绪" : m.status === "pending" ? "生成中" : "失败"} level={m.status === "ready" ? "ok" : m.status === "pending" ? "warn" : "danger"} />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  } else if (card.browseType === "review" && d) {
    // 审查报告：verdict + 5 维分数（中文维度名，固定顺序）+ findings（lens 中文化）
    const scores = d.scores as Record<string, unknown> | null | undefined;
    const findings = (Array.isArray(d.findings) ? d.findings : []) as Record<string, unknown>[];
    const SCORE_CN: Record<string, string> = { coherence: "连贯", tension: "张力", prose: "文笔", pacing: "节奏", dialogue: "对话" };
    const SCORE_ORDER = ["coherence", "tension", "prose", "pacing", "dialogue"];
    const scoreEntries = scores
      ? SCORE_ORDER.filter((k) => k in (scores as Record<string, unknown>)).map((k) => [k, (scores as Record<string, unknown>)[k]] as const)
      : [];
    body = (
      <>
        <CardStatusBadge status={d.verdict === "pass" ? "通过" : "需修订"} level={d.verdict === "pass" ? "ok" : "warn"} />
        {scoreEntries.length > 0 && (
          <div className="bc-stats">
            {scoreEntries.map(([k, v]) => (
              <span className="bc-stat" key={k}><b>{String(v)}</b>{SCORE_CN[k] ?? lensCn(k)}</span>
            ))}
          </div>
        )}
        {findings.length > 0 && (
          <div className="bc-browse-list">
            {findings.map((f, i) => (
              <div key={i} className="bc-browse-item">
                <div className="bc-browse-item-head">
                  <span className="bc-browse-item-title">{lensCn(String(f.lens ?? ""))}</span>
                  <CardStatusBadge status={f.severity === "major" ? "严重" : "轻微"} level={f.severity === "major" ? "danger" : "info"} />
                </div>
                <p className="bc-browse-text">{String(f.issue ?? "")}</p>
                {f.suggestion ? <p className="bc-browse-meta">建议：{String(f.suggestion)}</p> : null}
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else if (card.browseType === "eval" && d) {
    const dims = (Array.isArray(d.dimensions) ? d.dimensions : []) as Record<string, unknown>[];
    body = (
      <>
        <CardStatusBadge status={d.overall != null ? "已评估" : "未评估"} level={d.overall != null ? "ok" : "info"} />
        {d.overall != null && (
          <div className="bc-stats">
            <span className="bc-stat"><b>{String(d.overall)}</b>综合评分</span>
          </div>
        )}
        {dims.length > 0 && (
          <div className="bc-browse-list">
            <div className="bc-browse-sec">分维度</div>
            {dims.map((dim, i) => (
              <div key={i} className="bc-browse-item">
                <span className="bc-browse-item-title">{lensCn(String(dim.name ?? ""))}</span>
                <span className="bc-browse-item-badges">{dim.score != null ? <CardStatusBadge status={`${String(dim.score)} 分`} level={Number(dim.score) >= 7 ? "ok" : Number(dim.score) >= 5 ? "warn" : "danger"} /> : <CardStatusBadge status="未评分" level="info" />}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  } else {
    body = <p className="bc-browse-text">{JSON.stringify(d ?? {}).slice(0, 300)}</p>;
  }
  return (
    <div className="brain-card brain-card-browse">
      <div className="brain-card-head">
        <span className="brain-card-title">{card.title}</span>
        {FOLD_BROWSE_TYPES.has(card.browseType) && (
          <button className="bc-fold-toggle" onClick={() => setOpen((v) => !v)} title={open ? "折叠内容" : "展开内容"}>
            <span className={`bc-fold-caret${open ? " open" : ""}`}>▸</span>{open ? " 收起" : " 展开"}
          </button>
        )}
      </div>
      {open ? body : (
        <p className="bc-browse-meta">已折叠 · 点击「展开」查看 {card.browseType === "gacha" ? "卡池" : card.browseType === "proposal" ? "提案" : "详情"}</p>
      )}
    </div>
  );
};

// ============ ChoiceCard 计划/意见选项卡（plan/opinion 共用） ============

export const ChoiceCardView: React.FC<{
  card: ChoiceCard;
  onOption?: (option: ChoiceOption) => void;
  busy?: boolean;
}> = ({ card, onOption, busy }) => (
  <div className={`brain-card brain-card-choice brain-card-${card.kind}${isExecutionDone(card.executionState) ? " bc-card-done" : ""}`}>
    <div className="brain-card-head">
      <span className="brain-card-title">{card.kind === "plan" ? "🗺 " : "💬 "}{card.title}</span>
      {card.kind === "opinion" && <span className="bc-confirm-tag">请选择</span>}
      <ExecutionBadge state={card.executionState} />
    </div>
    {card.summary && <p className="brain-card-body">{card.summary}</p>}
    <div className="bc-choice-options">
      {card.options.map((o, i) => (
        <button
          key={i}
          className="bc-choice-option"
          disabled={busy || isExecutionBusy(card.executionState) || isExecutionDone(card.executionState)}
          onClick={() => onOption?.(o)}
          title={o.description ?? o.label}
        >
          <span className="bc-choice-label">{o.label}</span>
          {o.description && <span className="bc-choice-desc">{o.description}</span>}
          {o.action && <span className="bc-choice-go">→</span>}
        </button>
      ))}
    </div>
    {card.detail && <p className="bc-task-status">{card.detail}</p>}
  </div>
);

// ============ ProgressCard 写作进度卡（推进剧情/自动连载聊天内流式展示） ============

/** 阶段 → 步骤名（与 TaskCenterModal 的 STEP_NAMES 对齐；未匹配显示原始 phase） */
const PROGRESS_STEPS: [RegExp, string][] = [
  [/考据/, "考据"],
  [/计划|大纲/, "本章计划"],
  [/写作|writing|delta/i, "写作"],
  [/自查|selfcheck/i, "自查"],
  [/审查|review/i, "审查"],
  [/修补|patch/i, "修补"],
  [/结算|settle/i, "结算"],
  [/存档|saving/i, "存档"],
  [/result|完成/, "完成"],
];

function progressStepName(phase?: string): string {
  if (!phase) return "准备";
  for (const [re, name] of PROGRESS_STEPS) if (re.test(phase)) return name;
  return phase;
}

export const ProgressCardView: React.FC<{
  card: ProgressCard;
  onCancel?: () => void;
}> = ({ card, onCancel }) => {
  const running = card.status === "running";
  const step = progressStepName(card.phase);
  return (
    <div className={`brain-card brain-card-progress bc-progress-${card.status}`}>
      <div className="brain-card-head">
        <span className="brain-card-title">{running ? "⚙ " : card.status === "done" ? "✓ " : "✗ "}{card.title}</span>
        <span className={`bc-progress-pill bc-progress-pill-${card.status}`}>
          {running ? (card.phase === "delta" ? "写作中…" : progressStepName(card.phase)) : card.status === "done" ? "已完成" : "失败"}
        </span>
      </div>
      <div className="bc-progress-steps">
        {["准备", "考据", "本章计划", "写作", "自查", "审查", "修补", "结算", "存档"].map((s) => (
          <span key={s} className={`bc-progress-step${s === step ? " active" : ""}`}>{s}</span>
        ))}
      </div>
      {running && card.phase === "delta" && card.text ? (
        <pre className="bc-progress-text">{card.text}</pre>
      ) : null}
      {card.detail && <p className="brain-card-body">{card.detail}</p>}
      {running && onCancel && (
        <div className="brain-card-actions">
          <button className="btn btn-danger-sm btn-xs" onClick={onCancel} title="中断本次写作（阶段边界丢弃草稿）">中断写作</button>
        </div>
      )}
    </div>
  );
};

// ============ 卡片分发器 ============

/** 卡片附图：渲染在卡片内容上方（data URI / URL 均可） */
function CardFigure({ image }: { image?: CardImage }) {
  if (!image?.src) return null;
  return <img className="brain-card-image" src={image.src} alt={image.alt ?? ""} loading="lazy" />;
}

// ============ 表单卡（FormCard）：结构化字段 → 填写 → 提交 ============

export const FormCardView: React.FC<{
  card: FormCard;
  onSubmit?: (card: FormCard, values: Record<string, unknown>) => void;
  busy?: boolean;
  completed?: boolean;
  /** 值变化上报（供父组件动态正文跟随卡片选项；初始挂载也上报默认值） */
  onValuesChange?: (values: Record<string, unknown>, source?: "user" | "sync") => void;
  /** 媒体插画 form 卡：张数下拉的剩余额度回调（按所选章节动态计算，切换章节后 options 跟随） */
  mediaQuota?: (chapterIndex: number) => number;
}> = ({ card, onSubmit, busy, completed, onValuesChange, mediaQuota }) => {
  const stateDone = isExecutionDone(card.executionState);
  const stateBusy = isExecutionBusy(card.executionState);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of card.fields ?? []) init[f.key] = f.value ?? (f.type === "number" ? "" : f.type === "multiselect" ? [] : "");
    return init;
  });
  // 值变化同步上报（ref 存最新回调）：驱动父组件消息正文跟随卡片选项；
  // 初始值不上报（父组件用卡字段默认值兜底，避免 effect 时序依赖）
  const onValuesChangeRef = useRef(onValuesChange);
  onValuesChangeRef.current = onValuesChange;
  const set = (key: string, v: unknown) => {
    const next = { ...values, [key]: v };
    setValues(next);
    onValuesChangeRef.current?.(next, "user");
  };

  // 生成插画/视频表单（action 指向 /api/novel/media/plan）：切换「章节/张数」选项后提示文案实时更新
  const isMediaForm = card.action?.endpoint === "/api/novel/media/plan";
  const isImageMediaForm = isMediaForm && (card.action?.body?.kind ?? "image") === "image";
  const mediaCountQuota = isImageMediaForm && mediaQuota
    ? Math.max(0, mediaQuota(Number(values.chapterIndex) || 0))
    : null;
  // world-changed / brain-status 会令额度实时变化。旧表单实例不会重新 mount，需主动
  // 把已失效的 count 收敛到新额度，并上报父层更新聊天正文与后续提交值。
  useEffect(() => {
    if (mediaCountQuota == null) return;
    const current = Number(values.count);
    const next = mediaCountQuota === 0 ? 0 : Math.max(1, Math.min(mediaCountQuota, current || 1));
    if (current === next) return;
    const nextValues = { ...values, count: next };
    setValues(nextValues);
    onValuesChangeRef.current?.(nextValues, "sync");
  }, [mediaCountQuota, values]);
  useEffect(() => {
    const next: Record<string, unknown> = {};
    for (const f of card.fields ?? []) next[f.key] = f.value ?? (f.type === "number" ? "" : f.type === "multiselect" ? [] : "");
    if (JSON.stringify(next) === JSON.stringify(values)) return;
    setValues(next);
    onValuesChangeRef.current?.(next, "sync");
  }, [card.fields]);
  const liveSummary = isMediaForm ? (() => {
    const { kind, chapterLabel, count } = mediaPlanDerived(card, values);
    const target = chapterLabel ?? "所选章节";
    return kind === "video"
      ? `为「${target}」生成 1 段视频：提交后 AI 先从正文挑选关键场景，确认后开始生成。`
      : `为「${target}」生成 ${count} 张插画：提交后 AI 先从正文挑选关键场景，确认后开始生成。`;
  })() : card.summary;

  const submit = () => {
    // required 校验：空字符串 / null 视为未填
    const missing = (card.fields ?? []).find((f) => f.required && (values[f.key] == null || String(values[f.key]).trim() === ""));
    if (missing) {
      const el = document.getElementById(`fld-${card.title}-${missing.key}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.focus();
      return;
    }
    onSubmit?.(card, values);
  };

  return (
    <div className={`brain-card brain-card-form${card.confirmRequired ? " bc-form-confirm" : ""}${completed || stateDone ? " bc-card-done" : ""}`}>
      <div className="brain-card-head">
        <span className="brain-card-title">{card.title}</span>
        <CommandBadge commandId={card.commandId} />
        <LevelBadge level={card.level} />
        <ExecutionBadge state={card.executionState} />
        {card.confirmRequired && <span className="bc-confirm-tag">需确认</span>}
      </div>
      {liveSummary && <p className="brain-card-body">{liveSummary}</p>}
      {card.detail && card.executionState !== "idle" && <p className="bc-task-status">{card.detail}</p>}
      {(card.fields ?? []).length === 0 ? (
        <p className="bc-browse-meta">无需填写字段，直接提交执行。</p>
      ) : (
        <div className="bc-form-fields">
          {(card.fields ?? []).map((f) => {
            const id = `fld-${card.title}-${f.key}`;
            // 媒体插画 form 卡：张数下拉按所选章节剩余额度动态生成（章节切换后 options 跟随；已满时禁用）
            const isCountQuota = isImageMediaForm && f.key === "count" && !!mediaQuota;
            const quota = isCountQuota ? mediaCountQuota : null;
            const fieldLabel = quota != null ? `张数（还可生成 ${quota} 张）` : f.label;
            const selectOptions = quota != null
              ? (quota > 0
                ? Array.from({ length: quota }, (_, i) => ({ label: `${i + 1} 张`, value: String(i + 1) }))
                : [{ label: "本章插画已满（上限 3 张）", value: "0" }])
              : (f.options ?? []);
            return (
              <label className="bc-form-field" key={f.key} htmlFor={id}>
                <span className="bc-form-label">{fieldLabel}{f.required ? " *" : ""}</span>
                {f.type === "textarea" ? (
                  <textarea
                    id={id} rows={2} className="bc-form-input" placeholder={f.placeholder}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : f.type === "select" ? (
                  <select id={id} className="bc-form-input" value={String(values[f.key] ?? "")} disabled={quota === 0} onChange={(e) => set(f.key, e.target.value)}>
                    {selectOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === "multiselect" ? (
                  <div className="bc-form-checkgroup" id={id}>
                    {(f.options ?? []).map((o) => {
                      const arr = Array.isArray(values[f.key]) ? (values[f.key] as string[]) : [];
                      const checked = arr.includes(o.value);
                      return (
                        <label className="bc-form-check" key={o.value}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value);
                              set(f.key, next);
                            }}
                          />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <input
                    id={id} type={f.type === "number" ? "number" : "text"} className="bc-form-input" placeholder={f.placeholder}
                    value={String(values[f.key] ?? "")}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="brain-card-actions">
        {onSubmit && (
          completed || stateDone ? (
            <span className="bc-done-tag">{card.executionState === "cancelled" ? "已取消" : card.executionState === "interrupted" ? "已中断" : "✓ 已执行"}</span>
          ) : (
            <button className="btn-save btn-xs" disabled={busy || stateBusy || mediaCountQuota === 0} onClick={submit}>
              {stateBusy ? "提交中…" : (card.submitLabel ?? "提交")}
            </button>
          )
        )}
      </div>
    </div>
  );
};

export const BrainCardView: React.FC<{
  card: BrainCard;
  onExecute?: (card: BrainCard, action?: BrowseCardAction["action"]) => void;
  onConfirmChoose?: (opt: "merge" | "rewrite" | "abort") => void;
  onOption?: (option: ChoiceOption) => void;
  onFormSubmit?: (card: FormCard, values: Record<string, unknown>) => void;
  /** form 卡值变化上报（供父组件动态正文跟随选项） */
  onFormValuesChange?: (values: Record<string, unknown>, source?: "user" | "sync") => void;
  busy?: boolean;
  /** 已执行完成（preview/form 卡：按钮替换为完成标记，防重复提交） */
  completed?: boolean;
  /** browse 卡：已成功执行操作的列表项 id 集合 */
  completedItems?: ReadonlySet<string>;
  /** 写作进度卡运行中取消（仅 kind=progress 使用） */
  onCancelProgress?: () => void;
  /** 生成完成跳转（preview 卡 done 态「查看插画」） */
  onGoToMedia?: (chapterIndex: number, mediaId: string) => void;
  /** 媒体 form 卡张数下拉的剩余额度回调（按所选章节动态计算 options） */
  mediaQuota?: (chapterIndex: number) => number;
}> = ({ card, onExecute, onConfirmChoose, onOption, onFormSubmit, onFormValuesChange, busy, completed, completedItems, onCancelProgress, onGoToMedia, mediaQuota }) => {
  const inner = (() => {
    switch (card.kind) {
      case "preview": return <PreviewCardView card={card} onExecute={onExecute ? () => onExecute(card) : undefined} busy={busy} completed={completed} onGoToMedia={onGoToMedia} />;
      case "confirm": return <ConfirmCardView card={card} onChoose={onConfirmChoose} busy={busy} completed={completed} />;
      case "result": return <ResultCardView card={card} />;
      case "browse": return <BrowseCardView card={card} onAction={onExecute ? (action) => onExecute(card, action) : undefined} busy={busy} completedItems={completedItems} />;
      case "plan":
      case "opinion": return <ChoiceCardView card={card} onOption={onOption} busy={busy} />;
      case "form": return <FormCardView card={card} onSubmit={onFormSubmit} onValuesChange={onFormValuesChange} busy={busy} completed={completed} mediaQuota={mediaQuota} />;
      case "progress": return <ProgressCardView card={card} onCancel={onCancelProgress} />;
      case "ask": return null; // 追问选择卡不渲染进聊天流（显示在输入框上方询问面板）
    }
  })();
  const image = (card as { image?: CardImage }).image;
  if (!image?.src) return inner;
  return (
    <>
      <div className="brain-card-image-wrap"><CardFigure image={image} /></div>
      {inner}
    </>
  );
};
