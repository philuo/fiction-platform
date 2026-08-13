// 世界状态：设定 / 人物 / 伏笔 / 时间线 / 章节 / 卡牌（JSON 持久化 data/<title>/）
import { formatChapterRange } from "../shared/chapterRange";

export type Rarity = "N" | "R" | "SR" | "SSR";

export type Character = {
  id: string;
  name: string;
  role: string; // 主角 / 反派 / 配角 / 关键人物
  gender?: string; // 性别（男/女），立绘头像与分镜容貌刻画直接使用
  age?: string; // 年龄（自由文本，如「二十出头」「中年」）
  identity?: string; // 社会身份/职业（如「东厂提督」「仵作」），区别于叙事定位 role
  traits: string[];
  motivation: string;
  secret?: string;
  status: string; // 当前状态（动态更新）
  /** 当前形象：容貌/装扮/伤情的动态状态（如「右臂缠绷带，换了夜行衣」）；chronicler 结算更新，手改即锁 */
  look?: string;
  relations: Record<string, string>;
  voice?: string; // M4 声线：说话风格（对话生成遵循）
  appearedIn?: number[]; // 出现过的章节号（出现过即禁止移除）
  /** 全局立绘：角色视觉唯一基准（缺失时首次生成媒体自动补）；插画图生图参考图/视频 i2v 首帧均优先取它，保证跨章跨媒介样貌一致 */
  portrait?: { mediaId: string; path: string; prompt: string; looks?: string };
  exit?: { chapter: number; reason: string }; // 离场/死亡记录
  image?: string; // 角色图像（相对 data/<story>/ 的路径）
  /** 上次自动视觉生成尝试的时间戳（无论成败；读时自愈据此做冷却重试：未尝试过或失败超过冷却期才补，避免反复烧配额；手动生成不受影响） */
  visualTriedAt?: number;
  introducedAt: number;
};

export type Foreshadow = {
  id: string;
  text: string;
  /** 埋设章号。若章节尚未创作（plantedAt >= nextChapter）则为「待埋设」预登记态（抽卡/手动预埋），见 isPendingForeshadow */
  plantedAt: number;
  /** planted=已埋设待回收（含待埋设预登记）｜active=后续章节推进中仍未兑现｜resolved=已回收 */
  status: "planted" | "active" | "resolved";
  resolvedAt?: number;
  note?: string;
  dueHint?: string; // 建议回收时机（抽卡伏笔卡/记账产出）
};

export type TimelineEvent = {
  chapter: number;
  summary: string;
};

export type ReviewFinding = {
  severity: "major" | "minor";
  lens: string; // continuity / logic / prose / pacing / dialogue / foreshadow
  issue: string;
  evidence: string; // 原文引用
  suggestion: string;
};

export type ReviewResult = {
  verdict: "pass" | "revise";
  scores: { coherence: number; tension: number; prose: number; pacing: number; dialogue: number };
  findings: ReviewFinding[];
  round: number;
};

/** 连载暂存区草稿（git 工作区语义）：审查不通过的章节草稿，供重试/跳过 */
export type PendingChapter = {
  chapterIndex: number;
  title: string;
  text: string;
  review: ReviewResult; // 最近一次审查结果（findings 供展示与重试意见）
  savedAt: string;
  /** true = 推进剧情 commitPolicy=confirm 的"待确认入册"草稿（审查已通过，等人工确认 commit） */
  pendingCommit?: boolean;
  /** CriticVerdict 序列化（confirm 通道专用：确认入册时重建 verdict 走完整 commit 记账） */
  verdictJson?: string;
};

export type Card = {
  id: string;
  type: "角色" | "发展方向" | "伏笔" | "章节" | "道具" | "场景";
  rarity: Rarity;
  title: string;
  description: string;
  effect: string; // 注入写作指令的文本
  dueHint?: string; // 伏笔卡专用：建议回收时机
  character?: { name: string; role: string; gender?: string; age?: string; identity?: string; traits: string[]; motivation: string; voice?: string }; // 角色卡结构化人物（提案化，修正则猜名；性别/年龄/身份供头像/立绘生成使用）
};

// M1 生成参数（用户可调，存 WorldState.gen）
export type FidelityRule = {
  content: string; // 设定条目
  follow: "史实" | "架空"; // 该条目遵循史实还是架空处理
};

export type GenProfile = {
  minWords: number; // 章节字数范围下限
  maxWords: number; // 上限
  targetChapterWords?: number; // 目标字数（默认 1200，±40% 治理区间）
  settingMode: "历史真实" | "架空" | "混合"; // 设定遵循模式（历史真实→考据）
  fidelityRules: FidelityRule[]; // 遵循设定条目列表：逐条指定遵循史实/架空
  pov: "第一人称" | "第三人称" | "第二人称";
  styleOverride: string; // 文风覆盖（空 = 用 setting.tone）
  styleSample?: string; // 风格仿写样章（用户提供）
  styleFingerprint?: string; // 样章提取的风格指纹（≤400字描述，注入 writer）
  contextMode?: "auto" | "full" | "window" | "tiered"; // 上下文档位（auto 按书写长度自适应）
  temperature: number; // 模型温度 0-2
  reviewStrictness: "宽松" | "标准" | "严格"; // 审查地板阈值 + 重写轮数
  maxForeshadowPerChapter: number; // 每章新伏笔上限
  forceHook: boolean; // 强制章节结尾钩子
  autoGacha: boolean; // 每章推进前自动抽 1 张
  /** 推进剧情完成策略：auto=审查通过直接入册（默认，现状行为）；confirm=审查通过后暂存待人工确认才 commit 新版本 */
  commitPolicy?: "auto" | "confirm";
};

export const DEFAULT_GEN: GenProfile = {
  minWords: 800,
  maxWords: 1600,
  targetChapterWords: 1200,
  settingMode: "架空",
  fidelityRules: [],
  pov: "第三人称",
  styleOverride: "",
  contextMode: "auto",
  temperature: 0.9,
  reviewStrictness: "标准",
  maxForeshadowPerChapter: 2,
  forceHook: true,
  autoGacha: false,
};

/** 读取生效参数：全局 gen + 章节覆盖 chapterGen[index]（M6 章节级设置） */
export function genOf(w: WorldState, chapterIndex?: number): GenProfile {
  const base = { ...DEFAULT_GEN, ...(w.gen ?? {}) };
  const override = chapterIndex != null ? w.chapterGen?.[chapterIndex] : undefined;
  return override ? { ...base, ...override } : base;
}

export type ChapterVersion = {
  title: string;
  text: string;
  review: ReviewResult | null;
  at: string;
  reason?: string;
};

// 段落锚定媒体（插画/视频）：渲染在 anchor 所在段落前方
export type SceneType = "人物" | "场景" | "事件";

export type ChapterMedia = {
  id: string;
  kind: "image" | "video";
  anchor: string; // 所描绘段落的原文片段（仅用于渲染定位，不进媒体 prompt）
  prompt?: string; // 分镜 LLM 转写的英文视觉描述（生成用，非原文摘抄）
  caption?: string; // 中文图注：这张图/视频描绘了什么情节（面向用户）
  sceneType?: SceneType; // 画面类型：人物形象 / 环境场景 / 情节事件
  /** 画面主体角色名（分镜 LLM 判定）：参考图选择/图生图主体控制用，避免多角色场景参考图错配 */
  subject?: string;
  path?: string; // 就绪后的相对路径（image 立即；video 轮询完成后）
  videoId?: string; // video 异步任务 id
  status?: "pending" | "ready" | "failed";
  error?: string; // 生成失败原因（异步生成时供轮询展示）
  createdAt?: number; // 创建时间戳（视频异步任务超时回收用，毫秒）
  orphan?: boolean; // anchor 失配标记：正文变更后锚定段落已不存在（可逆，重新命中即清除）
};

// —— 一致性治理（章节变更后的确定性审计结果，API 返回结构不落盘） ——
export type ConsistencyFinding = {
  id: string; // 稳定签名（kind+target），供幂等去重
  level: "info" | "warning" | "danger";
  kind: string; // orphan-summary / dangling-foreshadow / planted-foreshadow-lost / …
  chapterIndex?: number;
  issue: string;
  suggestion: string;
};

export type ConsistencyReport = {
  autoFixed: string[]; // 已自动修复项描述
  findings: ConsistencyFinding[];
  orphanMedia: { chapterIndex: number; mediaId: string; kind: "image" | "video"; anchor: string }[];
};

export type Chapter = {
  index: number;
  title: string;
  text: string;
  review: ReviewResult | null;
  /** 章节最后一次更新时间（正文编辑/重写/媒体增删改/版本切换均刷新，见 touchChapter） */
  updatedAt?: string;
  media?: ChapterMedia[]; // 段落锚定媒体（插画/视频）
  image?: string; // 【旧】章节主插画（仅待迁移）
  images?: string[]; // 【旧】章节插画集（仅待迁移）
  video?: string; // 【旧】章节视频（仅待迁移）
  versions?: ChapterVersion[]; // 版本历史（支持回滚；运行时形态，落盘时外置到 versions/ 目录）
  versionFiles?: string[]; // 外置版本文件名（与 versions 互斥存储，loadWorld 时 hydrate）
};

// M3 世界书条目（SillyTavern Lorebook 式：关键词 + 内容 + 开关）
export type LoreEntry = {
  id: string;
  keywords: string[]; // 关键词（匹配与展示用）
  content: string; // 条目内容
  enabled: boolean;
  auto: boolean; // 是否自动生成（手动条目不受自动重建影响）
};

// M4 情节弧线（plot arc 追踪）
export type Arc = {
  id: string;
  name: string;
  status: "进行中" | "已解决";
  note: string; // 最近进展
};

// —— 长篇分层规划（卷/弧/章纲）与记忆层类型 ——
export type Volume = {
  id: string;
  title: string;
  goal: string;
  chapterRange?: [number, number];
  status: "planned" | "writing" | "done";
  summary?: string;
};

export type StoryArc = {
  id: string;
  volumeId: string;
  title: string;
  goal: string;
  arcType: "成长突破" | "竞技对抗" | "探索发现" | "恩怨冲突" | "日常过渡";
  status: "skeleton" | "expanded" | "writing" | "done";
  estChapters: number;
  summary?: string;
};

export type ChapterPlan = {
  index: number;
  arcId: string;
  goal: string;
  beats: string[];
  hookType: "悬念" | "反转" | "危机" | "情感" | "承诺" | "无";
  status: "planned" | "done";
  mergeTasks?: string[]; // 干预弥合任务（steering merge 策略注入）
};

export type ChapterSummary = {
  index: number;
  summary: string;
  events: string[];
  appeared: string[];
  stateChanges: string[];
  hook?: string;
};

/** 角色字段级变更记录（结算覆盖式更新前的旧值快照，供删除章节时逆操作恢复） */
export type CharacterFieldDelta = {
  id: string;
  name: string;
  status?: { old?: string; neu: string };
  look?: { old?: string; neu: string };
};

/**
 * 章节结算变更快照（git commit 语义）：记录本章结算对世界账本产生的全部覆盖式变更（含旧值），
 * 删除章节时按此逆操作恢复；后续章对同一字段的变更视作冲突（保留后续值并报告）。
 */
export type ChapterDelta = {
  chapter: number;
  at: string;
  /** 本章埋设且未回收的伏笔 id（删除章节时移除） */
  plantedForeshadowIds: string[];
  /** 本章回收的伏笔（删除章节时回退为回收前的状态） */
  resolvedForeshadows: { id: string; prevStatus: "planted" | "active" | "resolved"; prevResolvedAt?: number; prevNote?: string }[];
  /** 本章结算变更过的角色字段（status/look 旧值） */
  characterUpdates: CharacterFieldDelta[];
  /** 本章登记离场的角色 id */
  exitIds: string[];
  /** 本章结算覆盖前的全局当前状态 */
  worldCurrent?: { old?: string; neu: string };
  /** 本章结算变更过的弧线（status/note 旧值） */
  plotThreadUpdates: { id: string; oldStatus: string; newStatus: string; oldNote: string; newNote: string }[];
  /** 本章结算变更过的角色关系（增量合并：对方角色名 → 关系描述；含旧值） */
  relationUpdates: { id: string; name: string; target: string; old?: string; neu: string }[];
  /** 本章新增的设定规则（去重追加；删除章节时移除） */
  addedSettingRules: string[];
  /** 本章产生的角色提案 id */
  proposalIds: string[];
};

export type Blueprint = {
  theme: string;
  mainPlot: string;
  ending: string;
  compass: string; // 指南针：终局方向一句话，卷边界可更新
  progressContract: string; // 进度承诺（前 N 章节奏约定，防失控）
  volumes: Volume[];
};

export type QualityDebt = {
  id: string;
  chapterIndex: number;
  lens: string;
  issue: string;
  severity: "minor" | "major";
  status: "open" | "fixed" | "ignored";
};

export type CharacterProposal = {
  id: string;
  name: string;
  role: string;
  gender?: string;
  age?: string;
  identity?: string;
  traits: string[];
  motivation: string;
  voice?: string;
  /** 推荐原因：为什么建议让该角色登场（一句话，来源为卡牌描述 / writer 记账） */
  reason?: string;
  source: "gacha" | "writer";
  status: "pending" | "confirmed" | "rejected";
};

export type LockedField = { characterId: string; field: string }; // 人工上锁字段，chronicler 跳过

/** 审计日志条目（中枢架构扩展：commandId/level/reason/meta 可选，旧存档向后兼容） */
export type ChangeLogEntry = {
  at: string;
  chapter: number;
  actor: "user" | "ai" | "brain" | "integrity" | "system";
  kind: string;
  detail: string;
  strategy?: "merge" | "rewrite" | "abort";
  /** HARNESS 指令 ID（如 CMD-N06），操作可追溯锚点 */
  commandId?: string;
  /** 指令破坏级别（L0-L3，对已完成叙事/账本的破坏性） */
  level?: "L0" | "L1" | "L2" | "L3";
  /** 中枢审查结论 / 降级原因（brain_unavailable 等） */
  reason?: string;
  /** 附加元数据（受影响字段/章集合等，供操作日志面板展示） */
  meta?: Record<string, unknown>;
};

export type SteeringItem = { id: string; kind: string; payload: unknown; at: string }; // 待处理干预

/** BookGoal 统一目标对象（BRAIN.md §3，可选字段向后兼容）：
 * 收编 progressContract/isBookComplete/autorun 停下策略/eval 地板，供中枢报告 goal disposition */
export type BookGoal = {
  /** 结构目标 */
  structure?: {
    targetChapters?: number; // 目标章数（缺省 = 蓝图 estChapters 汇总）
    targetVolumes?: number; // 目标卷数
    progressContract?: string; // 收编既有字段
  };
  /** 质量目标 */
  quality?: {
    minOverall?: number; // eval overall 下限
    floorDimensions?: { name: string; min: number }[]; // 单维地板（eval 8 维名）
    chapterFloor?: number; // 单章 critic 地板
  };
  /** 预算 */
  budget?: {
    maxChaptersPerRun?: number; // 收编 autorun maxChapters（≤30）
    quotaGuard?: boolean; // 配额熔断开关
  };
  /** 完结条件（complete = structure 达成 ∧ quality 达标；blocked = budget 耗尽或熔断） */
  completion?: "structure" | "structure+quality";
};

export type WorldState = {
  title: string;
  author?: string; // 作者署名（全局设置可改）
  genre: string;
  premise: string;
  setting: { time: string; place: string; rules: string[]; tone: string };
  characters: Character[];
  foreshadowing: Foreshadow[];
  timeline: TimelineEvent[];
  chapters: Chapter[];
  cards: Card[]; // 已抽中并应用的卡
  outline: string[]; // 大纲：接下来要推进的情节要点（兼容保留，新架构由章纲替代）
  gen?: Partial<GenProfile>; // 生成参数（M1，可选以兼容旧存档）
  chapterGen?: Record<number, Partial<GenProfile>>; // 章节级参数覆盖（M6）
  lore?: LoreEntry[]; // 世界书条目（M3）
  plotThreads?: Arc[]; // 情节弧线（原 arcs，migrateWorld 迁移）
  cover?: string; // 书籍封面（相对 data/<story>/ 的路径）
  /** 上次封面自动生成尝试时间戳（读时自愈冷却用，与 visualTriedAt 同策略，防每次打开页面重复尝试烧配额；手动生成不受影响） */
  coverTriedAt?: number;
  /** 全局当前状态：单行自然语言（季节/天气/昼夜/局势/关键处境），chronicler 结算滚动更新，用户可改 */
  current?: string;
  nextChapter: number;
  updatedAt: string;
  pendingCards?: Card[]; // 当前未抽取的候选卡池
  // —— 长篇架构新增（全部可选，旧存档兼容） ——
  blueprint?: Blueprint; // 全书蓝图（指南针+进度承诺+卷骨架）
  blueprintOptions?: unknown[]; // 蓝图候选（planner.BlueprintOption[]，确认后保留供重新选择）
  storyArcs?: StoryArc[]; // 故事弧（卷下属，滚动展开）
  chapterPlans?: ChapterPlan[]; // 章纲（写作目标，完成核销）
  chapterSummaries?: ChapterSummary[]; // 章节摘要（记忆层 L2）
  /** 章节结算变更快照（git 式）：按章索引记录覆盖式账本变更的旧值，删除章节时逆操作恢复；重结算时整体覆盖 */
  chapterDeltas?: Record<number, ChapterDelta>;
  qualityDebt?: QualityDebt[]; // 质量债务（minor 不阻塞，登记追踪）
  characterProposals?: CharacterProposal[]; // 新角色提案（确认前不入册）
  lockedFields?: LockedField[]; // 人工上锁字段
  changeLog?: ChangeLogEntry[]; // 干预审计日志
  rewriteQueue?: number[]; // 回溯重写队列（L2 策略 rewrite：受影响章节按序重写）
  /** BookGoal 统一目标对象（BRAIN.md §3，可选，未设置时各字段回落现状默认，行为零变化） */
  goal?: BookGoal;
};

// 左栏 / 设置面板共用的世界保存补丁（统一由 Home.saveWorld 提交）
export type WorldPatch = {
  bookTitle?: string; // 书名修改（服务端负责目录改名；不用 title 键以免与故事主键混淆）
  author?: string; // 作者署名
  current?: string; // 全局当前状态（单行自然语言）
  premise?: string;
  setting?: Partial<WorldState["setting"]>;
  lore?: LoreEntry[]; // 世界书条目（M3，随世界观合并保存）
  characters?: Partial<Character>[];
  outline?: string[];
  gen?: Partial<GenProfile>;
  chapterGen?: Record<number, Partial<GenProfile> | null>;
  chapterTitle?: { index: number; title: string }[]; // 章节标题修改（服务端同步版本快照标题）
  removeCharacterIds?: string[];
};

export function emptyWorld(): WorldState {
  return {
    title: "未命名",
    genre: "",
    premise: "",
    setting: { time: "", place: "", rules: [], tone: "" },
    characters: [],
    foreshadowing: [],
    timeline: [],
    chapters: [],
    cards: [],
    outline: [],
    nextChapter: 1,
    updatedAt: new Date().toISOString(),
  };
}

export function activeForeshadows(w: WorldState): Foreshadow[] {
  return w.foreshadowing.filter((f) => f.status !== "resolved");
}

/** 刷新章节最后更新时间：正文更新/重写/媒体增删改/版本切换统一入口（报头展示用） */
export function touchChapter(w: WorldState, index: number): void {
  const ch = w.chapters.find((c) => c.index === index);
  if (ch) ch.updatedAt = new Date().toISOString();
}

/** 「待埋设」判定：预登记的伏笔（抽卡/手动），埋设章尚未创作（plantedAt >= nextChapter）。
 * 属正常过渡态而非一致性异常：待该章创作时随正文落地；巡检不报冲突，UI 单列展示。 */
export function isPendingForeshadow(w: WorldState, f: Foreshadow): boolean {
  return f.status !== "resolved" && f.plantedAt >= w.nextChapter;
}

/** 目标章数（全书统一口径，worldSummary / executeQuery / brain-state vitals 共用）：
 * goal 显式 > 弧线估算合计 > 章纲总数；无则 null（前端不显示进度条/目标章数）。
 * 注意：goal.structure.targetChapters 常缺省，真实目标来自蓝图弧线 estChapters 汇总。 */
export function targetChapterCount(w: WorldState): number | null {
  const t = w.goal?.structure?.targetChapters;
  if (t != null && t > 0) return t;
  const est = (w.storyArcs ?? []).reduce((n, a) => n + (a.estChapters || 0), 0);
  if (est > 0) return est;
  const plans = (w.chapterPlans ?? []).length;
  return plans > 0 ? plans : null;
}

/** 迁移旧章节级媒体（image/images/video）为段落锚定 media[]，转换后清空旧字段。
 * 旧媒体无场景信息，按顺序分散锚定到章节不同段落（避免全堆在开头）；并对已迁移但全堆在首段的旧数据自愈重分布。返回是否有变更。 */
export function migrateChapterMedia(w: WorldState): boolean {
  const norm = (s: string) => s.replace(/[\s「」『』]/g, "");
  // 第 i/total 个媒体锚定到的段落原文片段（均匀分散）
  const anchorFor = (paras: string[], i: number, total: number): string => {
    if (!paras.length) return "";
    const idx = Math.min(paras.length - 1, Math.floor(((i + 0.5) * paras.length) / Math.max(1, total)));
    return paras[idx].slice(0, 40);
  };
  let changed = false;
  for (const ch of w.chapters) {
    const paras = ch.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    // 1) 旧字段迁移：分散锚定
    const legacy: { kind: "image" | "video"; path: string }[] = [];
    if (ch.images?.length) for (const p of ch.images) legacy.push({ kind: "image", path: p });
    else if (ch.image) legacy.push({ kind: "image", path: ch.image });
    if (ch.video) legacy.push({ kind: "video", path: ch.video });
    if (legacy.length) {
      const media = ch.media ?? [];
      legacy.forEach((item, i) => {
        media.push({
          id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          kind: item.kind,
          anchor: anchorFor(paras, i, legacy.length),
          path: item.path,
          status: "ready",
        });
      });
      ch.media = media;
      delete ch.image;
      delete ch.images;
      delete ch.video;
      changed = true;
    }
    // 2) 自愈：已迁移但多个旧媒体共用同一首段 anchor（旧迁移堆叠特征）→ 仅重分布该组
    const m = ch.media ?? [];
    const firstNorm = paras.length ? norm(paras[0]) : "";
    if (firstNorm.length >= 4) {
      const byAnchor = new Map<string, ChapterMedia[]>();
      for (const x of m) {
        if (!x.anchor) continue;
        const arr = byAnchor.get(x.anchor) ?? [];
        arr.push(x);
        byAnchor.set(x.anchor, arr);
      }
      for (const [anchor, group] of byAnchor) {
        if (group.length >= 2 && firstNorm.includes(norm(anchor))) {
          group.forEach((x, i) => { x.anchor = anchorFor(paras, i, group.length); });
          changed = true;
        }
      }
    }
  }
  return changed;
}

export function worldSummary(w: WorldState): string {
  const parts: string[] = [];
  parts.push(`《${w.title}》 ${w.genre}`);
  parts.push(`时代地点: ${w.setting.time} / ${w.setting.place}`);
  parts.push(`基调: ${w.setting.tone}`);
  if (w.current) parts.push(`当前全局状态: ${w.current}`);
  if (w.setting.rules.length) parts.push(`规则: ${w.setting.rules.join("；")}`);
  parts.push(`人物(${w.characters.length}):`);
  for (const c of w.characters) {
    const appear = c.appearedIn?.length ? `（登场于第${formatChapterRange(c.appearedIn)}章）` : "（未登场）";
    const exit = c.exit ? `（已于第${c.exit.chapter}章离场：${c.exit.reason}）` : "";
    const rel = Object.entries(c.relations ?? {});
    const relText = rel.length ? ` 关系:${rel.map(([k, v]) => `${k}→${v}`).join("；")}` : "";
    parts.push(`- ${c.name}(${c.role})${appear}${exit} 性别:${c.gender || "未知"} 年龄:${c.age || "未知"} 身份:${c.identity || "—"} 特质[${c.traits.join(",")}] 动机:${c.motivation} 现状:${c.status}${c.look ? ` 形象:${c.look}` : ""}${relText}`);
  }
  parts.push(`活跃伏笔(${activeForeshadows(w).length}):`);
  for (const f of activeForeshadows(w)) {
    const plant = f.plantedAt >= w.nextChapter ? `计划埋设于第${f.plantedAt}章` : `埋于第${f.plantedAt}章`;
    parts.push(`- [${f.id}] ${f.text}（${plant}）`);
  }
  if (w.timeline.length) {
    const last = w.timeline.slice(-5); // 分层摘要·工作记忆：最近 5 章
    parts.push(`最近事件: ${last.map((t) => `第${t.chapter}章 ${t.summary}`).join(" → ")}`);
  }
  if (w.chapters.length) {
    const prev = w.chapters[w.chapters.length - 1];
    const tail = prev.text.trim().slice(-120);
    parts.push(`上一章结尾: …${tail}`);
  }
  return parts.join("\n");
}
