// 分层滚动规划（P3，修 A1-A4）：蓝图（指南针+进度承诺+卷骨架）→ 弧（滚动展开）→ 本章计划（核销）
// 参考 ainovel-cli：初始只规划 2 卷骨架 + 第 1 弧详章；弧/卷边界触发摘要归并 + 展开下一弧
import { chatJson } from "./jsonutil";
import { saveWorld } from "./storage";
import { logCommandChange } from "./steering";
import { summarizeRange } from "./memory";
import type { Blueprint, ChapterPlan, StoryArc, Volume, WorldState } from "./world";

const ARC_TYPES = ["成长突破", "竞技对抗", "探索发现", "恩怨冲突", "日常过渡"] as const;
const HOOK_TYPES = ["悬念", "反转", "危机", "情感", "承诺", "无"] as const;

function uid(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

function clampArcType(v: unknown): StoryArc["arcType"] {
  return (ARC_TYPES as readonly string[]).includes(String(v)) ? (v as StoryArc["arcType"]) : "成长突破";
}
function clampHook(v: unknown): ChapterPlan["hookType"] {
  return (HOOK_TYPES as readonly string[]).includes(String(v)) ? (v as ChapterPlan["hookType"]) : "悬念";
}

// —— 蓝图（立项自动导演：2-3 套整本方向候选） ——

/** 蓝图候选（含弧骨架，可序列化落盘 world.blueprintOptions，跨请求保留） */
export type BlueprintOption = Blueprint & {
  arcs: { volumeId: string; title: string; goal: string; arcType: StoryArc["arcType"]; estChapters: number }[];
};

const BLUEPRINT_SYSTEM = `你是小说总编剧。基于世界设定与人物，为整本书设计 2-3 套不同的创作方向（蓝图）。
每套蓝图包含：主题、主线、终局方向、指南针（一句话创作方向锚，用于长篇不跑偏）、进度承诺（前 30 章的节奏约定，如"前 10 章立足世界观与首个悬念弧，中段推进主线反转，结尾收束"）、以及 2 卷骨架（每卷含标题/目标/1-2 个弧骨架）。
弧骨架只给 title/goal/arcType/estChapters（3-6），不展开细节。
输出必须是合法 JSON（不要 markdown 围栏）：
{"options":[{"theme":"…","mainPlot":"…","ending":"…","compass":"…","progressContract":"…",
"volumes":[{"title":"卷名","goal":"卷目标","arcs":[{"title":"弧名","goal":"弧目标","arcType":"成长突破|竞技对抗|探索发现|恩怨冲突|日常过渡","estChapters":4}]}]}]}
要求：各方案走向有明显差异（如稳健流/反转流/暗黑流）；卷 1 的弧总数预估 2-3 个。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function buildBlueprint(w: WorldState, hint?: string): Promise<BlueprintOption[]> {
  const userMsg = [
    `书名《${w.title}》（${w.genre}）`,
    `梗概：${w.premise}`,
    `设定：${w.setting.time} / ${w.setting.place}｜基调：${w.setting.tone}`,
    w.setting.rules.length ? `规则：${w.setting.rules.join("；")}` : "",
    `人物：${w.characters.map((c) => `${c.name}(${c.role}，${c.motivation})`).join("；")}`,
    hint ? `[用户倾向] ${hint.slice(0, 300)}` : "",
    "\n请输出 2-3 套蓝图（只输出 JSON）。",
  ].filter(Boolean).join("\n");

  const out = await chatJson<{ options?: { theme?: string; mainPlot?: string; ending?: string; compass?: string; progressContract?: string; volumes?: { title?: string; goal?: string; arcs?: { title?: string; goal?: string; arcType?: string; estChapters?: number }[] }[] }[] }>(
    [
      { role: "system", content: BLUEPRINT_SYSTEM },
      { role: "user", content: userMsg },
    ],
    {
      temperature: 0.9,
      maxTokens: 60000,
      schema: {
        type: "object",
        required: ["options"],
        properties: {
          options: {
            type: "array",
            items: {
              type: "object",
              required: ["theme", "mainPlot", "ending", "compass", "progressContract", "volumes"],
              properties: {
                theme: { type: "string" }, mainPlot: { type: "string" }, ending: { type: "string" },
                compass: { type: "string" }, progressContract: { type: "string" },
                volumes: {
                  type: "array",
                  items: {
                    type: "object", required: ["title", "goal"],
                    properties: {
                      title: { type: "string" }, goal: { type: "string" },
                      arcs: { type: "array", items: { type: "object", required: ["title", "goal", "arcType", "estChapters"], properties: { title: { type: "string" }, goal: { type: "string" }, arcType: { type: "string" }, estChapters: { type: "integer" } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  );

  const options: BlueprintOption[] = [];
  for (const o of Array.isArray(out.options) ? out.options.slice(0, 3) : []) {
    const volumes: Volume[] = [];
    const arcsBuf: BlueprintOption["arcs"] = [];
    for (const v of Array.isArray(o.volumes) ? o.volumes.slice(0, 3) : []) {
      const vol: Volume = { id: uid("vol"), title: String(v.title ?? "未名卷").slice(0, 30), goal: String(v.goal ?? "").slice(0, 200), status: "planned" };
      volumes.push(vol);
      for (const a of Array.isArray(v.arcs) ? v.arcs.slice(0, 4) : []) {
        arcsBuf.push({
          volumeId: vol.id,
          title: String(a.title ?? "未名弧").slice(0, 30),
          goal: String(a.goal ?? "").slice(0, 200),
          arcType: clampArcType(a.arcType),
          estChapters: Math.max(2, Math.min(8, Number(a.estChapters) || 4)),
        });
      }
    }
    if (!volumes.length) continue;
    options.push({
      theme: String(o.theme ?? "").slice(0, 100),
      mainPlot: String(o.mainPlot ?? "").slice(0, 400),
      ending: String(o.ending ?? "").slice(0, 300),
      compass: String(o.compass ?? "").slice(0, 200),
      progressContract: String(o.progressContract ?? "").slice(0, 300),
      volumes,
      arcs: arcsBuf,
    });
  }
  return options;
}

/** 确认蓝图：落盘 volumes + 弧骨架 + 立即展开首弧详纲 */
export async function confirmBlueprint(w: WorldState, opt: BlueprintOption): Promise<WorldState> {
  const { arcs: arcsBuf, ...bp } = opt;
  w.blueprint = { ...bp, volumes: bp.volumes.map((v) => ({ ...v })) };
  const arcs: StoryArc[] = arcsBuf.map((b) => ({
    id: uid("arc"),
    volumeId: b.volumeId,
    title: b.title,
    goal: b.goal,
    arcType: b.arcType,
    estChapters: b.estChapters,
    status: "skeleton",
  }));
  w.storyArcs = arcs;
  if (w.blueprint.volumes[0]) w.blueprint.volumes[0].status = "writing";
  // 展开第一个骨架弧
  const first = arcs.find((a) => a.status === "skeleton");
  if (first) await expandArc(w, first.id);
  logCommandChange(w, { chapter: w.nextChapter, actor: "user", kind: "blueprint-confirm", detail: `确认蓝图《${w.blueprint.theme?.slice(0, 30)}》（${volumesCount(w)} 卷 / ${arcs.length} 弧骨架，已展开首弧详纲）`, commandId: "CMD-W03" });
  saveWorld(w);
  return w;
}
function volumesCount(w: WorldState): number {
  return (w.blueprint?.volumes ?? []).length;
}

// —— 弧展开（滚动规划：只详展当前弧，3-6 章章节计划） ——

const EXPAND_SYSTEM = `你是小说分卷编辑。把一个故事弧展开为接下来 3-6 章的详细章节计划。
要求：章与章之间因果递进；每章有明确目标与 2-4 个节拍（beats，具体到"发生什么"）；钩子类型尽量与[近期钩子历史]错开，避免连续雷同；必须推进至少 1 条活跃伏笔（若有）。
输出必须是合法 JSON（不要 markdown 围栏）：
{"chapters":[{"goal":"本章目标","beats":["节拍1","节拍2"],"hookType":"悬念|反转|危机|情感|承诺|无"}]}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function expandArc(w: WorldState, arcId: string): Promise<ChapterPlan[]> {
  const arc = (w.storyArcs ?? []).find((a) => a.id === arcId);
  if (!arc) throw new Error("弧不存在: " + arcId);
  const startIdx = w.nextChapter + (w.chapterPlans ?? []).filter((p) => p.status === "planned").length;
  // 防御：跳过已被既有计划占用的章号（弧/卷边界展开时 nextChapter 可能已递增但与既有计划冲突，
  // 重叠计划会导致该弧永远无法全 done、卷边界卡死）
  let safeStart = startIdx;
  const usedIdx = new Set((w.chapterPlans ?? []).map((p) => p.index));
  while (usedIdx.has(safeStart)) safeStart++;

  const summaries = (w.chapterSummaries ?? []).slice(-3).map((s) => `第${s.index}章：${s.summary}`).join("\n");
  const fs = (w.foreshadowing ?? []).filter((f) => f.status !== "resolved").map((f) => `[${f.id}] ${f.text}`).join("\n");
  const hookHistory = (w.chapterPlans ?? []).slice(-5).map((p) => p.hookType).join("、") || "（无）";
  const guard = progressGuard(w);

  const userMsg = [
    `[指南针] ${w.blueprint?.compass ?? ""}`,
    `[进度承诺] ${w.blueprint?.progressContract ?? ""}`,
    `[弧目标] ${arc.title}：${arc.goal}（类型：${arc.arcType}，预估 ${arc.estChapters} 章）`,
    `[角色状态] ${w.characters.map((c) => `${c.name}:${c.status}`).join("；")}`,
    summaries ? `[近 3 章摘要]\n${summaries}` : "",
    fs ? `[活跃伏笔]\n${fs}` : "",
    `[近期钩子历史] ${hookHistory}（避免连续雷同）`,
    guard ? `[节奏警报] ${guard}` : "",
    `\n从第 ${startIdx} 章开始展开 ${Math.min(arc.estChapters, 6)} 章章节计划（只输出 JSON）。`,
  ].filter(Boolean).join("\n");

  const out = await chatJson<{ chapters?: { goal?: string; beats?: string[]; hookType?: string }[] }>(
    [
      { role: "system", content: EXPAND_SYSTEM },
      { role: "user", content: userMsg },
    ],
    {
      temperature: 0.8,
      maxTokens: 60000,
      schema: {
        type: "object",
        required: ["chapters"],
        properties: {
          chapters: {
            type: "array",
            items: { type: "object", required: ["goal"], properties: { goal: { type: "string" }, beats: { type: "array", items: { type: "string" } }, hookType: { type: "string" } } },
          },
        },
      },
    },
  );

  const plans: ChapterPlan[] = [];
  const list = Array.isArray(out.chapters) ? out.chapters : [];
  for (let i = 0; i < Math.min(list.length, 6); i++) {
    const c = list[i];
    if (!c?.goal) continue;
    plans.push({
      index: safeStart + i,
      arcId: arc.id,
      goal: String(c.goal).slice(0, 200),
      beats: (Array.isArray(c.beats) ? c.beats : []).map(String).filter(Boolean).slice(0, 4).map((b) => b.slice(0, 120)),
      hookType: clampHook(c.hookType),
      status: "planned",
    });
  }
  if (!plans.length) {
    // 兜底：至少生成 1 章泛用章节计划，保证管线不卡死
    plans.push({ index: safeStart, arcId: arc.id, goal: arc.goal, beats: ["推进弧目标"], hookType: "悬念", status: "planned" });
  }
  w.chapterPlans = [...(w.chapterPlans ?? []), ...plans];
  arc.status = "expanded";
  logCommandChange(w, { chapter: safeStart, actor: "ai", kind: "arc-expand", detail: `展开弧「${arc.title}」章节计划 ${plans.length} 章（第 ${safeStart} 章起）`, commandId: "CMD-W05" });
  saveWorld(w);
  return plans;
}

/** 确保某章有本章计划（缺失时自动展开当前写作弧） */
export async function ensureChapterPlan(w: WorldState, index: number): Promise<ChapterPlan | null> {
  const plans = w.chapterPlans ?? [];
  const existing = plans.find((p) => p.index === index);
  if (existing) return existing;
  // 找到当前应展开的弧：已展开/写作中的最后一个弧，否则第一个骨架弧
  const arcs = w.storyArcs ?? [];
  let target = arcs.find((a) => a.status === "expanded" || a.status === "writing") ?? arcs.find((a) => a.status === "skeleton");
  // 优先取覆盖 index 的预估范围的弧（按顺序消费）
  const pending = plans.filter((p) => p.status === "planned");
  if (!pending.length && target) {
    // 上一个弧的本章计划已耗尽 → 推进到下一个骨架弧
    const nextSkeleton = arcs.find((a) => a.status === "skeleton");
    if (nextSkeleton && target.status !== "skeleton") target = nextSkeleton;
  }
  if (!target) return null; // 无蓝图/弧（旧故事未自愈前）→ 走无本章计划模式
  const created = await expandArc(w, target.id);
  return created.find((p) => p.index === index) ?? created[0] ?? null;
}

/** 本章计划核销：置 done；弧内本章计划全部完成 → 返回弧边界事件 */
export function markChapterDone(w: WorldState, index: number): { arcId: string } | null {
  const plan = (w.chapterPlans ?? []).find((p) => p.index === index);
  if (plan) plan.status = "done";
  if (!plan) return null;
  const arc = (w.storyArcs ?? []).find((a) => a.id === plan.arcId);
  if (!arc || arc.status === "done") return null;
  const arcPlans = (w.chapterPlans ?? []).filter((p) => p.arcId === arc.id);
  const allDone = arcPlans.length > 0 && arcPlans.every((p) => p.status === "done");
  if (allDone) return { arcId: arc.id };
  return null;
}

/** 弧/卷边界处理：弧摘要 → 展开下一弧；卷内弧全部完成 → 卷摘要 + 更新指南针 + 新卷检查 */
export async function handleArcBoundary(w: WorldState, arcId: string): Promise<void> {
  const arcs = w.storyArcs ?? [];
  const arc = arcs.find((a) => a.id === arcId);
  if (!arc) return;
  const arcPlans = (w.chapterPlans ?? []).filter((p) => p.arcId === arcId);
  const from = Math.min(...arcPlans.map((p) => p.index));
  const to = Math.max(...arcPlans.map((p) => p.index));
  arc.summary = await summarizeRange(w, from, to);
  // arc.status 延迟到卷边界处理完成后置位（失败可重入：未 done 的弧下回合 markChapterDone 仍触发边界处理）

  // 卷边界检查：该卷所有弧完成（当前弧尚未置 done，排除自身判定）
  const vol = (w.blueprint?.volumes ?? []).find((v) => v.id === arc.volumeId);
  const volArcs = arcs.filter((a) => a.volumeId === arc.volumeId);
  if (vol && volArcs.every((a) => a.id === arcId || a.status === "done")) {
    vol.summary = await summarizeRange(w, from, Math.max(to, 1));
    vol.status = "done";
    await updateCompass(w);
    // 下一卷进入写作
    const nextVol = (w.blueprint?.volumes ?? []).find((v) => v.status === "planned");
    if (nextVol) nextVol.status = "writing";
  }

  // 全部卷边界工作完成 → 置 arc done（延迟置位确保卷摘要失败可重入）
  arc.status = "done";

  // 展开下一个骨架弧（滚动规划）
  const nextSkeleton = arcs.find((a) => a.status === "skeleton");
  if (nextSkeleton) await expandArc(w, nextSkeleton.id);
  logCommandChange(w, { chapter: to, actor: "ai", kind: "arc-boundary", detail: `弧「${arc.title}」完成（第 ${from}-${to} 章）${vol && volArcs.every((a) => a.id === arcId || a.status === "done") ? `；卷《${vol.title}》收束${w.blueprint?.compass ? "，指南针已更新" : ""}` : ""}`, commandId: "CMD-W09" });
  saveWorld(w);
}

// —— 指南针更新（卷边界校准方向，防长篇跑偏） ——

const COMPASS_SYSTEM = `你是小说总编剧。一卷已经写完，请基于已发生内容更新全书指南针（终局方向一句话）与进度状态。
输出合法 JSON：{"compass":"更新后的一句话方向锚","note":"本卷收束与下卷衔接说明（≤100字）"}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function updateCompass(w: WorldState): Promise<void> {
  if (!w.blueprint) return;
  try {
    const out = await chatJson<{ compass?: string; note?: string }>(
      [
        { role: "system", content: COMPASS_SYSTEM },
        {
          role: "user",
          content: [
            `原指南针：${w.blueprint.compass}`,
            `主线：${w.blueprint.mainPlot}`,
            `终局方向：${w.blueprint.ending}`,
            `已完成卷摘要：${(w.blueprint.volumes ?? []).filter((v) => v.summary).map((v) => `《${v.title}》${v.summary}`).join("\n")}`,
            `活跃伏笔数：${(w.foreshadowing ?? []).filter((f) => f.status !== "resolved").length}`,
          ].join("\n"),
        },
      ],
      { temperature: 0.5, maxTokens: 60000, schema: { type: "object", required: ["compass"], properties: { compass: { type: "string" }, note: { type: "string" } } } },
    );
    if (out.compass?.trim()) {
      const old = w.blueprint.compass;
      w.blueprint.compass = String(out.compass).trim().slice(0, 200);
      if (old !== w.blueprint.compass) {
        logCommandChange(w, { chapter: w.nextChapter, actor: "ai", kind: "compass-update", detail: `指南针校准：${old?.slice(0, 30) ?? "（无）"} → ${w.blueprint.compass.slice(0, 30)}`, commandId: "CMD-W10" });
      }
    }
  } catch {
    /* compass 更新失败不阻塞 */
  }
}

/** 进度守卫（修 A3 节奏失控）：当前弧实际章数超预估 1.5 倍 → 返回"放慢"约束文本 */
export function progressGuard(w: WorldState): string | null {
  const plans = w.chapterPlans ?? [];
  const current = plans.filter((p) => p.status === "planned")[0] ?? plans[plans.length - 1];
  if (!current) return null;
  const arc = (w.storyArcs ?? []).find((a) => a.id === current.arcId);
  if (!arc) return null;
  const used = plans.filter((p) => p.arcId === arc.id && p.status === "done").length;
  const remaining = plans.filter((p) => p.arcId === arc.id && p.status === "planned").length;
  if (used > arc.estChapters * 1.5 && remaining <= 1) {
    return `当前弧「${arc.title}」已用 ${used} 章（预估 ${arc.estChapters} 章），节奏超前：下一弧应收束本弧冲突、减少新开支线，向主线靠拢。`;
  }
  return null;
}

/** 全书是否完结（最后一卷 done 且伏笔全回收 → autorun 停止条件） */
export function isBookComplete(w: WorldState): boolean {
  const vols = w.blueprint?.volumes ?? [];
  if (!vols.length) return false;
  if (!vols.every((v) => v.status === "done")) return false;
  return (w.foreshadowing ?? []).every((f) => f.status === "resolved");
}

/** 旧故事自愈：无蓝图时按已写内容补一个最小蓝图（单卷+当前弧），使新管线可接管 */
export async function healLegacyStory(w: WorldState): Promise<boolean> {
  if (w.blueprint) return false;
  const vol: Volume = { id: uid("vol"), title: "第一卷", goal: "承接已有内容推进主线", status: "writing" };
  w.blueprint = {
    theme: w.genre || "未定",
    mainPlot: w.premise,
    ending: "（待规划）",
    compass: w.premise.slice(0, 100),
    progressContract: "以既有内容为准平稳推进",
    volumes: [vol],
  };
  const arc: StoryArc = {
    id: uid("arc"),
    volumeId: vol.id,
    title: "当前弧",
    goal: w.outline?.[0] ?? "推进主线",
    arcType: "成长突破",
    status: "skeleton",
    estChapters: 4,
  };
  w.storyArcs = [arc];
  // 已写章节回填 done 本章计划（无细节，仅作核销基线）
  const plans: ChapterPlan[] = w.chapters.map((c) => ({
    index: c.index,
    arcId: arc.id,
    goal: c.title,
    beats: [],
    hookType: "无",
    status: "done",
  }));
  w.chapterPlans = plans;
  await expandArc(w, arc.id);
  logCommandChange(w, { chapter: w.nextChapter, actor: "ai", kind: "story-heal", detail: `旧故事自愈：补最小蓝图 + 回填 ${plans.length} 条已写章计划 + 展开首弧`, commandId: "CMD-W11" });
  saveWorld(w);
  return true;
}
