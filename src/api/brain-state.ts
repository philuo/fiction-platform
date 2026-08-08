// 中枢四维状态机（brain state machine）：从世界状态 + 运行时信号确定性派生中枢的
// ① presence 存在态（驱动印灵神态）② activity 动作态 ③ governance 治理裁决态 ④ vitals 全书健康脉象。
// 零 LLM、纯函数，SSR 与客户端共用。中枢"有状态可表现、有作用可感知"的数据基础。
// 注意：本文件禁止 import brain.ts / planner.ts / eval.ts / jsonutil.ts / agnes.ts / limiter.ts 等服务端模块——
// 它们含 process.env / node:fs 副作用，被打包进客户端 bundle 会在浏览器抛 ReferenceError: process is not defined，
// 导致 React hydrate 中断、整页事件失效。所需逻辑在此内联。
import type { ChangeLogEntry, ConsistencyFinding, WorldState } from "./world";
import { isPendingForeshadow } from "./world";

// ============ 内联类型（避免 import eval.ts 拖入 node:fs / jsonutil / agnes / limiter） ============

/** 整书评估报告（仅取 vitals 用到的字段；与 eval.ts EvalReport 结构兼容） */
type EvalReportLike = {
  overall: number;
  dimensions: { name: string; score: number }[];
};

// ============ 内联 disposition（避免 import brain.ts → jsonutil → agnes → limiter） ============

export type BrainDisposition = "continue" | "complete" | "blocked";

/** 结构完结：全卷 done + 伏笔全回收（内联自 planner.ts isBookComplete） */
function isBookComplete(w: WorldState): boolean {
  const vols = w.blueprint?.volumes ?? [];
  if (!vols.length) return false;
  if (!vols.every((v) => v.status === "done")) return false;
  return (w.foreshadowing ?? []).every((f) => f.status === "resolved");
}

/** 目标处置三态（内联自 brain.ts computeDisposition，纯函数无 LLM） */
function computeDisposition(w: WorldState): BrainDisposition {
  if (isBookComplete(w)) return "complete";
  const targetChapters = w.goal?.structure?.targetChapters;
  if (targetChapters != null && w.nextChapter > targetChapters) return "blocked";
  return "continue";
}

// ============ 四维状态类型 ============

/** ① presence 存在态：驱动中枢之眼「印灵」的神态/色相/粒子 */
export type Presence =
  | "dormant" // 休眠：无内容/未开始
  | "standby" // 待命：有内容、无运行任务
  | "awake" // 觉醒：运行轻量任务（存档/分镜/插画）
  | "focused" // 专注：深度写作/连载写作中
  | "pondering" // 深思：审查/评估/巡检中
  | "alert" // 警觉：有未处理严重问题（闸门驳回/完整性危险/审查失败停滞）
  | "weary"; // 疲倦：评估低分或质量债堆积（无运行任务时）

/** ② activity 动作态：中枢当前正在做的事（映射 busyPhase/autoSession.phase/visualGen） */
export type Activity =
  | "idle" // 待命
  | "directing" // 导演写作
  | "reviewing" // 对抗审查
  | "settling" // 章末记账
  | "gating" // 一致性把关/干预
  | "gacha" // 抽卡拟题
  | "researching" // 考据搜索
  | "illustrating" // 绘图造像
  | "auditing" // 巡检自愈
  | "evaluating" // 质量评估
  | "foreshadowing" // 伏笔管理
  | "housekeeping"; // 立项/存档/加载等一般事务

/** ③ governance 治理裁决态：中枢最近的治理结论 */
export type GovernanceState =
  | "passthrough" // 放行（无治理记录或闸门 allow）
  | "approved" // 认可（章末审查 approve）
  | "revise" // 建议修正（章末审查 revise，含弥合建议）
  | "rejected" // 驳回（章末审查 reject / 闸门 reject）
  | "pendingIntervention" // 干预待决（有重写队列/待确认草稿）
  | "degraded"; // 降级放行（brain_unavailable）

/** governance 简要条目（最近 N 条 brain 日志，供对话舱治理卡片展示） */
export type GovernanceBrief = {
  at: string;
  kind: string; // brain-review / brain-gate
  state: GovernanceState;
  detail: string;
  chapter?: number;
};

/** ④ vitals 全书健康脉象 */
export type Vitals = {
  /** 连贯度 0-10（有 eval 取「设定一致」维度；否则取最近 N 章审查 coherence 均值；无数据 null） */
  coherence: number | null;
  /** 伏笔回收率 0-1（resolved / total；无伏笔 null） */
  foreshadowResolution: number | null;
  /** 待回收活跃伏笔数（planted+active，排除待埋设预登记） */
  activeForeshadowCount: number;
  /** 开放质量债数 */
  qualityDebtOpen: number;
  /** 严重（major）质量债数 */
  qualityDebtMajor: number;
  /** 完整性 danger 级 findings 数（需 integrityReport；无报告 null） */
  integrityDanger: number | null;
  /** 整书评估 overall（无 eval null） */
  evalOverall: number | null;
  /** 已写章数 */
  chapterCount: number;
  /** 目标章数（goal.structure.targetChapters；无 null） */
  targetChapters: number | null;
  /** 目标处置三态 */
  disposition: BrainDisposition;
};

/** 中枢四维状态（整体） */
export type BrainState = {
  presence: Presence;
  activity: Activity;
  governance: GovernanceState;
  governanceRecent: GovernanceBrief[];
  vitals: Vitals;
};

// ============ 前端共用的中文标签常量 ============

export const PRESENCE_LABEL: Record<Presence, string> = {
  dormant: "休眠",
  standby: "待命",
  awake: "觉醒",
  focused: "专注",
  pondering: "深思",
  alert: "警觉",
  weary: "疲倦",
};

/** presence → 印灵主色相（沿用报纸美学变量名，CSS 侧映射到实际色值） */
export const PRESENCE_HUE: Record<Presence, string> = {
  dormant: "ink-soft",
  standby: "ink",
  awake: "seal",
  focused: "indigo",
  pondering: "azure",
  alert: "gold",
  weary: "muted",
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: "待命",
  directing: "导演写作",
  reviewing: "对抗审查",
  settling: "章末记账",
  gating: "一致性把关",
  gacha: "抽卡拟题",
  researching: "考据搜索",
  illustrating: "绘图造像",
  auditing: "巡检自愈",
  evaluating: "质量评估",
  foreshadowing: "伏笔管理",
  housekeeping: "事务处理",
};

export const GOVERNANCE_LABEL: Record<GovernanceState, string> = {
  passthrough: "放行",
  approved: "认可",
  revise: "建议修正",
  rejected: "驳回",
  pendingIntervention: "干预待决",
  degraded: "降级放行",
};

export const DISPOSITION_LABEL: Record<BrainDisposition, string> = {
  continue: "进行中",
  complete: "已完结",
  blocked: "已受阻",
};

// ============ 运行时输入 ============

/** 运行时信号（前端 busyPhase/autoSession/visualGen 等映射而来；均可选） */
export type BrainRuntimeInput = {
  /** 是否有运行中的写章/推进/编辑任务（busyPhase 非空） */
  busy?: boolean;
  /** busyPhase 文本或连载 phase 文本（用于 activity 匹配） */
  phase?: string;
  /** 视觉生成中（角色头像/立绘后台生成） */
  visualGen?: boolean;
  /** 连载是否运行中 */
  autoRunning?: boolean;
  /** 最近 eval 报告（可选；vitals.evalOverall/coherence 优先取此） */
  evalReport?: EvalReportLike | null;
  /** 最近 integrity findings（可选；auditWorld 返回的 ConsistencyFinding[]；vitals.integrityDanger 取此） */
  integrityReport?: ConsistencyFinding[] | null;
  /** 最近一次治理裁决（PHASE 4 编排器注入精确值；不传则从 changeLog 启发式派生） */
  latestVerdict?: { kind: "review" | "gate"; verdict: "approve" | "revise" | "reject" | "allow"; reason?: string } | null;
};

// ============ 派生实现 ============

/** busyPhase/autoSession.phase 文本 → activity 枚举 */
export function matchActivity(phase: string | undefined, visualGen: boolean | undefined): Activity {
  if (!phase && !visualGen) return "idle";
  const p = phase ?? "";
  if (visualGen && !p) return "illustrating"; // 后台生成角色视觉
  // 写作类
  if (/写作|连载.*写作|重写|导演/.test(p)) return "directing";
  // 审查类
  if (/审查|修补|保存并审查/.test(p)) return "reviewing";
  // 结算类
  if (/结算|重算.*账本|记账/.test(p)) return "settling";
  // 分镜/插画/视觉
  if (/分镜|插画|生成.*图|立绘|视觉/.test(p)) return "illustrating";
  // 巡检/修复/删章影响
  if (/巡检|修复|删章|一致性/.test(p)) return "auditing";
  // 干预
  if (/干预/.test(p)) return "gating";
  // 立项/存档/加载/评估
  if (/立项|加载|存档/.test(p)) return "housekeeping";
  if (/评估/.test(p)) return "evaluating";
  if (/抽卡|卡池/.test(p)) return "gacha";
  if (/考据|搜索/.test(p)) return "researching";
  if (/伏笔/.test(p)) return "foreshadowing";
  // 连载 phase 原始值兜底
  if (/writing/.test(p)) return "directing";
  if (/reviewing|patching|review-failed/.test(p)) return "reviewing";
  if (/settling/.test(p)) return "settling";
  return "housekeeping"; // 其余运行中文本归为一般事务
}

/** 是否深度写作/专注任务（用于 presence focused 判定） */
function isDeepWork(activity: Activity): boolean {
  return activity === "directing";
}

/** 是否深思类任务（审查/评估/巡检） */
function isPondering(activity: Activity): boolean {
  return activity === "reviewing" || activity === "evaluating" || activity === "auditing" || activity === "gating";
}

/** governance 启发式派生：从 changeLog 提取最近 brain 条目（latestVerdict 优先） */
function deriveGovernance(
  w: WorldState,
  latestVerdict: BrainRuntimeInput["latestVerdict"],
): { state: GovernanceState; recent: GovernanceBrief[] } {
  // 运行时精确覆写优先
  if (latestVerdict) {
    let s: GovernanceState = "passthrough";
    if (latestVerdict.kind === "review") {
      s = latestVerdict.verdict === "approve" ? "approved" : latestVerdict.verdict === "revise" ? "revise" : latestVerdict.verdict === "reject" ? "rejected" : "approved";
    } else {
      s = latestVerdict.verdict === "reject" ? "rejected" : "passthrough";
    }
    if ((w.rewriteQueue ?? []).length > 0) s = "pendingIntervention";
    return { state: s, recent: governanceBriefs(w) };
  }

  const recent = governanceBriefs(w);
  // 待处理干预最高优先
  if ((w.rewriteQueue ?? []).length > 0) return { state: "pendingIntervention", recent };

  if (!recent.length) return { state: "passthrough", recent };

  const latest = recent[0];
  return { state: latest.state, recent };
}

/** 提取 changeLog 中 brain 条目简要（最近 5 条，倒序） */
function governanceBriefs(w: WorldState): GovernanceBrief[] {
  const brainLogs = (w.changeLog ?? []).filter((e) => e.actor === "brain");
  return brainLogs.slice(-5).reverse().map((e) => ({
    at: e.at,
    kind: e.kind,
    chapter: e.chapter,
    detail: e.detail,
    state: classifyBrainLog(e),
  }));
}

/** 单条 brain 日志 → governance 状态（启发式，基于 kind/detail/reason/meta） */
function classifyBrainLog(e: ChangeLogEntry): GovernanceState {
  if (e.reason === "brain_unavailable" || /不可用|降级/.test(e.detail)) return "degraded";
  if (e.kind === "brain-review") {
    const meta = e.meta as Record<string, unknown> | undefined;
    if (meta && Array.isArray(meta.suggestions) && meta.suggestions.length) return "revise";
    if (/修正|弥合|revise/.test(e.detail)) return "revise";
    if (/驳回|reject|矛盾/.test(e.detail)) return "rejected";
    return "approved";
  }
  if (e.kind === "brain-gate") {
    if (/reject|驳回|推翻/.test(e.detail)) return "rejected";
    return "passthrough";
  }
  return "passthrough";
}

/** vitals 派生 */
function deriveVitals(w: WorldState, evalReport: EvalReportLike | null, integrityReport: ConsistencyFinding[] | null): Vitals {
  const fs = w.foreshadowing ?? [];
  const resolved = fs.filter((f) => f.status === "resolved").length;
  const active = fs.filter((f) => f.status !== "resolved" && !isPendingForeshadow(w, f)).length;
  const debt = (w.qualityDebt ?? []).filter((d) => d.status === "open");
  const debtMajor = debt.filter((d) => d.severity === "major").length;

  // 连贯度：优先 eval「设定一致」维度；否则最近 N 章审查 coherence 均值
  let coherence: number | null = null;
  if (evalReport) {
    const dim = evalReport.dimensions.find((d) => d.name === "设定一致");
    if (dim) coherence = dim.score;
  }
  if (coherence == null) {
    const recentReviews = w.chapters.slice(-8).map((c) => c.review).filter(Boolean) as NonNullable<WorldState["chapters"][number]["review"]>[];
    if (recentReviews.length) {
      coherence = Math.round((recentReviews.reduce((n, r) => n + (r.scores.coherence ?? 0), 0) / recentReviews.length) * 10) / 10;
    }
  }

  const integrityDanger = integrityReport ? integrityReport.filter((f) => f.level === "danger").length : null;
  const targetChapters = w.goal?.structure?.targetChapters ?? null;

  return {
    coherence,
    foreshadowResolution: fs.length ? resolved / fs.length : null,
    activeForeshadowCount: active,
    qualityDebtOpen: debt.length,
    qualityDebtMajor: debtMajor,
    integrityDanger,
    evalOverall: evalReport?.overall ?? null,
    chapterCount: w.chapters.length,
    targetChapters,
    disposition: computeDisposition(w),
  };
}

/** presence 派生：综合 activity/governance/vitals 确定中枢情绪态（优先级从高到低） */
function derivePresence(
  w: WorldState,
  activity: Activity,
  governance: GovernanceState,
  vitals: Vitals,
  busy: boolean,
): Presence {
  // 无内容且无任务 → 休眠
  if (w.chapters.length === 0 && !busy) return "dormant";

  // 警觉最高优先：闸门驳回/审查驳回待处理/完整性 danger/审查失败停滞
  const hasAlertSignal =
    governance === "rejected" ||
    (vitals.integrityDanger != null && vitals.integrityDanger > 0) ||
    vitals.qualityDebtMajor >= 3;
  if (hasAlertSignal) return "alert";

  // 深度写作 → 专注
  if (isDeepWork(activity)) return "focused";
  // 审查/评估/巡检 → 深思
  if (isPondering(activity)) return "pondering";
  // 其他运行任务 → 觉醒
  if (busy || activity !== "idle") return "awake";

  // 无运行任务：评估低分或大量质量债 → 疲倦
  const hasWearySignal =
    (vitals.evalOverall != null && vitals.evalOverall < 5) ||
    vitals.qualityDebtMajor >= 5 ||
    (vitals.qualityDebtOpen >= 8);
  if (hasWearySignal) return "weary";

  return "standby";
}

/**
 * 派生中枢四维状态（纯函数，零 LLM）。
 * SSR 与客户端共用：前端拉取 /api/brain/state 或 world 附带 brainState 后调用此函数。
 */
export function deriveBrainState(w: WorldState | null, runtime: BrainRuntimeInput = {}): BrainState | null {
  if (!w) return null;

  const busy = Boolean(runtime.busy || runtime.phase);
  const activity = matchActivity(runtime.phase, runtime.visualGen);
  const evalReport = runtime.evalReport ?? null;
  const integrityReport = runtime.integrityReport ?? null;

  const { state: governance, recent } = deriveGovernance(w, runtime.latestVerdict);
  const vitals = deriveVitals(w, evalReport, integrityReport);
  const presence = derivePresence(w, activity, governance, vitals, busy);

  return { presence, activity, governance, governanceRecent: recent, vitals };
}

/** 便捷：仅从 world 派生（无运行时信号，用于 SSR 初值 / 无任务态） */
export function deriveBrainStateStatic(w: WorldState | null, extra: Omit<BrainRuntimeInput, never> = {}): BrainState | null {
  return deriveBrainState(w, extra);
}

// isBookComplete 为内部函数（内联自 planner.ts，避免 import 拖入服务端依赖）
