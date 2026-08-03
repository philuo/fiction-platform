// 世界状态：设定 / 人物 / 伏笔 / 时间线 / 章节 / 卡牌（JSON 持久化 data/<title>/）

export type Rarity = "N" | "R" | "SR" | "SSR";

export type Character = {
  id: string;
  name: string;
  role: string; // 主角 / 反派 / 配角 / 关键人物
  traits: string[];
  motivation: string;
  secret?: string;
  status: string; // 当前状态（动态更新）
  relations: Record<string, string>;
  voice?: string; // M4 声线：说话风格（对话生成遵循）
  appearedIn?: number[]; // 出现过的章节号（出现过即禁止移除）
  exit?: { chapter: number; reason: string }; // 离场/死亡记录
  image?: string; // 角色图像（相对 data/<story>/ 的路径）
  introducedAt: number;
};

export type Foreshadow = {
  id: string;
  text: string;
  plantedAt: number;
  status: "planted" | "active" | "resolved";
  resolvedAt?: number;
  note?: string;
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

export type Card = {
  id: string;
  type: "角色" | "发展方向" | "伏笔" | "章节" | "道具" | "场景";
  rarity: Rarity;
  title: string;
  description: string;
  effect: string; // 注入写作指令的文本
};

// M1 生成参数（用户可调，存 WorldState.gen）
export type FidelityRule = {
  content: string; // 设定条目
  follow: "史实" | "架空"; // 该条目遵循史实还是架空处理
};

export type GenProfile = {
  minWords: number; // 章节字数范围下限
  maxWords: number; // 上限
  settingMode: "历史真实" | "架空" | "混合"; // 设定遵循模式（历史真实→考据）
  fidelityRules: FidelityRule[]; // 遵循设定条目列表：逐条指定遵循史实/架空
  pov: "第一人称" | "第三人称" | "第二人称";
  styleOverride: string; // 文风覆盖（空 = 用 setting.tone）
  temperature: number; // 模型温度 0-2
  reviewStrictness: "宽松" | "标准" | "严格"; // 审查地板阈值 + 重写轮数
  maxForeshadowPerChapter: number; // 每节新伏笔上限
  forceHook: boolean; // 强制章节结尾钩子
  autoGacha: boolean; // 每节推进前自动抽 1 张
};

export const DEFAULT_GEN: GenProfile = {
  minWords: 300,
  maxWords: 500,
  settingMode: "架空",
  fidelityRules: [],
  pov: "第三人称",
  styleOverride: "",
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
export type ChapterMedia = {
  id: string;
  kind: "image" | "video";
  anchor: string; // 所描绘段落的原文片段（渲染时按归一化子串匹配定位）
  prompt?: string; // 场景描述（生成用）
  path?: string; // 就绪后的相对路径（image 立即；video 轮询完成后）
  videoId?: string; // video 异步任务 id
  status?: "pending" | "ready" | "failed";
};

export type Chapter = {
  index: number;
  title: string;
  text: string;
  review: ReviewResult | null;
  media?: ChapterMedia[]; // 段落锚定媒体（插画/视频）
  image?: string; // 【旧】章节主插画（仅待迁移）
  images?: string[]; // 【旧】章节插画集（仅待迁移）
  video?: string; // 【旧】章节视频（仅待迁移）
  versions?: ChapterVersion[]; // 版本历史（支持回滚）
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

export type WorldState = {
  title: string;
  genre: string;
  premise: string;
  setting: { time: string; place: string; rules: string[]; tone: string };
  characters: Character[];
  foreshadowing: Foreshadow[];
  timeline: TimelineEvent[];
  chapters: Chapter[];
  cards: Card[]; // 已抽中并应用的卡
  outline: string[]; // 大纲：接下来要推进的情节要点
  gen?: Partial<GenProfile>; // 生成参数（M1，可选以兼容旧存档）
  chapterGen?: Record<number, Partial<GenProfile>>; // 章节级参数覆盖（M6）
  lore?: LoreEntry[]; // 世界书条目（M3）
  arcs?: Arc[]; // 情节弧线（M4）
  cover?: string; // 书籍封面（相对 data/<story>/ 的路径）
  nextChapter: number;
  updatedAt: string;
  pendingCards?: Card[]; // 当前未抽取的候选卡池
};

// 左栏 / 设置面板共用的世界保存补丁（统一由 Home.saveWorld 提交）
export type WorldPatch = {
  premise?: string;
  setting?: Partial<WorldState["setting"]>;
  characters?: Partial<Character>[];
  outline?: string[];
  gen?: Partial<GenProfile>;
  chapterGen?: Record<number, Partial<GenProfile> | null>;
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
  if (w.setting.rules.length) parts.push(`规则: ${w.setting.rules.join("；")}`);
  parts.push(`人物(${w.characters.length}):`);
  for (const c of w.characters) {
    const appear = c.appearedIn?.length ? `（登场于第${c.appearedIn.join("、")}节）` : "（未登场）";
    const exit = c.exit ? `（已于第${c.exit.chapter}节离场：${c.exit.reason}）` : "";
    const rel = Object.entries(c.relations ?? {});
    const relText = rel.length ? ` 关系:${rel.map(([k, v]) => `${k}→${v}`).join("；")}` : "";
    parts.push(`- ${c.name}(${c.role})${appear}${exit} 特质[${c.traits.join(",")}] 动机:${c.motivation} 现状:${c.status}${relText}`);
  }
  parts.push(`活跃伏笔(${activeForeshadows(w).length}):`);
  for (const f of activeForeshadows(w)) {
    parts.push(`- [${f.id}] ${f.text}（埋于第${f.plantedAt}章）`);
  }
  if (w.timeline.length) {
    const last = w.timeline.slice(-5); // 分层摘要·工作记忆：最近 5 节
    parts.push(`最近事件: ${last.map((t) => `第${t.chapter}章 ${t.summary}`).join(" → ")}`);
  }
  if (w.chapters.length) {
    const prev = w.chapters[w.chapters.length - 1];
    const tail = prev.text.trim().slice(-120);
    parts.push(`上一节结尾: …${tail}`);
  }
  return parts.join("\n");
}
