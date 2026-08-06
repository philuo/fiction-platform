// 记忆层（P1）：章节摘要（L2）+ 相关章节检索（L3）+ 自适应上下文档位 + 带预算的上下文组装
// 修复：B1 critic 前缀截断假摘要 / B2 无预算膨胀 / B5 衔接窗口过短
import { chatJson } from "./jsonutil";
import type { Chapter, ChapterPlan, ChapterSummary, WorldState } from "./world";
import { activeForeshadows, genOf } from "./world";

/** CJK token 估算：中文字数×1.5 + 其余字符/4（ainovel-cli 经验值） */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch)) cjk++;
  return Math.ceil(cjk * 1.5 + (s.length - cjk) / 4);
}

// —— 章摘要（L2 记忆） ——

const SUMMARY_SYSTEM = `你是小说的"随场书记员"。给定一章正文与世界状态，产出该章的结构化档案。
输出必须是合法 JSON（不要 markdown 围栏）：
{"summary":"150-300字剧情摘要（含起因/经过/结果）","events":["关键事件1","关键事件2"],"appeared":["本章被提及或出场的角色名"],"stateChanges":["角色或世界的状态变化"],"hook":"章末钩子一句话（没有则空字符串）"}
要求：summary 只陈述已发生的事实，不评价文笔；appeared 必须与设定角色名完全一致，指本章正文中被提及或出场的所有角色（有台词/行动/被旁白或他人提及/回忆均算），名单宁全勿漏。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** 生成章节摘要（失败时降级为正文前 300 字，不阻塞主管线） */
export async function summarizeChapter(w: WorldState, ch: Chapter): Promise<ChapterSummary> {
  const fallback = (): ChapterSummary => ({
    index: ch.index,
    summary: `第${ch.index}章《${ch.title}》：${ch.text.slice(0, 300)}`,
    events: [],
    appeared: [],
    stateChanges: [],
    hook: "",
  });
  try {
    const out = await chatJson<{ summary?: string; events?: unknown; appeared?: unknown; stateChanges?: unknown; hook?: string }>(
      [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: `已知角色：${w.characters.map((c) => c.name).join("、")}\n\n第${ch.index}章《${ch.title}》全文：\n${ch.text}` },
      ],
      { temperature: 0.3, maxTokens: 60000 },
    );
    const strArr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((s) => s.trim()).slice(0, 12) : []);
    return {
      index: ch.index,
      summary: String(out.summary ?? "").trim() || `第${ch.index}章《${ch.title}》：${ch.text.slice(0, 300)}`,
      events: strArr(out.events),
      appeared: strArr(out.appeared),
      stateChanges: strArr(out.stateChanges),
      hook: String(out.hook ?? "").trim(),
    };
  } catch {
    return fallback();
  }
}

/** 把摘要回写进 world（去重按 index 覆盖） */
export function upsertSummary(w: WorldState, s: ChapterSummary): void {
  const list = w.chapterSummaries ?? [];
  const i = list.findIndex((x) => x.index === s.index);
  if (i >= 0) list[i] = s;
  else list.push(s);
  list.sort((a, b) => a.index - b.index);
  w.chapterSummaries = list;
}

// —— 弧/卷摘要归并（P3 弧边界与 P5 使用） ——

export async function summarizeRange(w: WorldState, from: number, to: number): Promise<string> {
  const ss = (w.chapterSummaries ?? []).filter((s) => s.index >= from && s.index <= to);
  if (!ss.length) return "";
  try {
    const out = await chatJson<{ summary?: string }>(
      [
        { role: "system", content: "你是小说档案员。把多个章节摘要归并为一段 200-400 字的阶段摘要：保留主线推进、关键转折、角色变化与未决线索。只输出 JSON：{\"summary\":\"…\"}。字符串值内部一律使用中文引号「」/『』，禁止英文双引号。" },
        { role: "user", content: ss.map((s) => `第${s.index}章：${s.summary}`).join("\n") },
      ],
      { temperature: 0.3, maxTokens: 60000 },
    );
    return String(out.summary ?? "").trim();
  } catch {
    return ss.map((s) => s.summary).join("；").slice(0, 400);
  }
}

// —— 相关章节检索（L3，确定性评分，无向量库） ——

function bigrams(s: string): Set<string> {
  const norm = s.replace(/\s+/g, "");
  const set = new Set<string>();
  for (let i = 0; i + 2 <= norm.length; i++) set.add(norm.slice(i, i + 2));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 以章纲 beats+角色名+活跃伏笔为查询，对历史章摘要评分，返回 Top-k 相关章节摘要 */
export function retrieveRelevant(w: WorldState, plan: ChapterPlan | null, k = 3): ChapterSummary[] {
  const summaries = (w.chapterSummaries ?? []).filter((s) => s.index < w.nextChapter);
  if (!summaries.length) return [];
  const queryParts: string[] = [];
  if (plan) {
    queryParts.push(plan.goal, ...plan.beats);
  } else {
    queryParts.push(...(w.outline ?? []));
  }
  for (const f of activeForeshadows(w)) queryParts.push(f.text);
  const query = queryParts.join(" ");
  const qb = bigrams(query);
  // 精确命中词（角色名 + 伏笔关键段）：命中一次 +0.4
  const exactTerms = [
    ...w.characters.map((c) => c.name),
    ...activeForeshadows(w).map((f) => f.text.slice(0, 12)),
  ].filter((t) => t.length >= 2);

  const scored = summaries.map((s) => {
    const text = `${s.summary} ${s.events.join(" ")} ${s.appeared.join(" ")} ${s.stateChanges.join(" ")}`;
    let score = jaccard(qb, bigrams(text));
    for (const t of exactTerms) if (text.includes(t)) score += 0.4;
    // 近期轻微加权（避免只召回远古章节）
    score += Math.max(0, 0.05 - (w.nextChapter - s.index) * 0.002);
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0.08)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.s);
}

// —— 自适应上下文档位（Hybrid Context：短书吃满长窗口，长书分层压缩） ——

function totalWords(w: WorldState): number {
  return w.chapters.reduce((n, c) => n + c.text.length, 0);
}

export type ContextTier = "full" | "window" | "tiered";

export function contextTier(w: WorldState): ContextTier {
  const mode = genOf(w).contextMode ?? "auto";
  if (mode !== "auto") return mode;
  const words = totalWords(w);
  if (words < 60_000) return "full"; // <6 万字：近 10 章全文直塞（512K 红利档）
  if (words < 200_000) return "window"; // 6-20 万字：近 3 章全文 + 其余摘要
  return "tiered"; // >20 万字：三级摘要 + 检索
}

// —— 上下文分段构建 ——

function settingBlock(w: WorldState, participants: string[]): string {
  const parts: string[] = [];
  parts.push(`《${w.title}》 ${w.genre}${w.blueprint ? `｜全书方向（指南针）：${w.blueprint.compass}` : ""}`);
  parts.push(`时代地点: ${w.setting.time} / ${w.setting.place}｜基调: ${w.setting.tone}`);
  if (w.current) parts.push(`当前全局状态: ${w.current}`);
  if (w.setting.rules.length) parts.push(`规则: ${w.setting.rules.join("；")}`);
  // 参与者筛选（资源账本思路）：只注入本章相关角色 + 活跃关系角色；无章纲时退化为全量（上限 12）
  const pool = participants.length
    ? w.characters.filter((c) => participants.includes(c.name) || Object.keys(c.relations ?? {}).some((k) => participants.includes(k)))
    : w.characters.slice(0, 12);
  const list = pool.length ? pool : w.characters.slice(0, 12);
  parts.push(`人物(${list.length}/${w.characters.length}):`);
  for (const c of list) {
    const exit = c.exit ? `（已于第${c.exit.chapter}章离场：${c.exit.reason}）` : "";
    const rel = Object.entries(c.relations ?? {});
    const relText = rel.length ? ` 关系:${rel.slice(0, 5).map(([k, v]) => `${k}→${v}`).join("；")}` : "";
    parts.push(`- ${c.name}(${c.role})${exit} 性别:${c.gender || "未知"} 年龄:${c.age || "未知"} 身份:${c.identity || "—"} 特质[${c.traits.join(",")}] 动机:${c.motivation} 现状:${c.status}${c.look ? ` 形象:${c.look}` : ""}${c.voice ? ` 声线:${c.voice}` : ""}${relText}`);
  }
  return parts.join("\n");
}

function foreshadowBlock(w: WorldState, maxChars: number): string {
  const fs = activeForeshadows(w);
  if (!fs.length) return "";
  const lines: string[] = [`活跃伏笔(${fs.length}):`];
  let used = 0;
  for (const f of fs) {
    const plant = f.plantedAt >= w.nextChapter ? `计划埋设于第${f.plantedAt}章（尚未创作）` : `埋于第${f.plantedAt}章`;
    const line = `- [${f.id}] ${f.text}（${plant}${f.dueHint ? `，建议：${f.dueHint}` : ""}）`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n");
}

function summaryText(s: ChapterSummary): string {
  return `第${s.index}章：${s.summary}${s.hook ? `（钩子：${s.hook}）` : ""}`;
}

export type WriterContext = {
  segments: { label: string; text: string }[];
  tier: ContextTier;
  tokens: number;
};

/**
 * 组装 writer 上下文（带预算，超预算按 检索层→世界书→伏笔 顺序确定性截断）。
 * 章纲/风格/指令段由 director 另行拼接（它们不属于记忆层）。
 */
export function buildWriterContext(w: WorldState, plan: ChapterPlan | null, budget = 6000): WriterContext {
  const tier = contextTier(w);
  // 章纲 beats 里出现的角色名即参与者（资源账本筛选）
  const pNames: string[] = [];
  if (plan) {
    const beatText = `${plan.goal} ${plan.beats.join(" ")}`;
    for (const c of w.characters) if (beatText.includes(c.name)) pNames.push(c.name);
  }

  const segments: { label: string; text: string; cuttable: number }[] = [];
  // ① 设定层（不可截断核心）
  segments.push({ label: "setting", text: settingBlock(w, pNames), cuttable: 0 });
  // ② 近况层（按档位）
  const prev = w.chapters.filter((c) => c.index < w.nextChapter);
  if (tier === "full") {
    const recent = prev.slice(-10);
    segments.push({ label: "recent", text: recent.length ? `[近文全文（近${recent.length}章）]\n${recent.map((c) => `——第${c.index}章《${c.title}》——\n${c.text}`).join("\n")}` : "", cuttable: 0 });
  } else {
    const recentFull = prev.slice(tier === "window" ? -3 : -1);
    const parts: string[] = [];
    if (recentFull.length) parts.push(recentFull.map((c) => `——第${c.index}章《${c.title}》全文——\n${c.text}`).join("\n"));
    const summarized = (w.chapterSummaries ?? []).filter((s) => s.index < (recentFull[0]?.index ?? w.nextChapter));
    const mid = summarized.slice(-6);
    if (mid.length) parts.push(`[前文摘要]\n${mid.map(summaryText).join("\n")}`);
    segments.push({ label: "recent", text: parts.join("\n"), cuttable: 1 });
  }
  // 上一章结尾窗口（400 字，修 B5）
  const last = prev[prev.length - 1];
  if (last) segments.push({ label: "tail", text: `上一章结尾：…${last.text.trim().slice(-400)}`, cuttable: 0 });
  // ③ 检索层（可截断）
  const relevant = retrieveRelevant(w, plan, 3).filter((s) => !prev.slice(-3).some((c) => c.index === s.index));
  if (relevant.length) segments.push({ label: "retrieval", text: `[相关章节回顾]\n${relevant.map(summaryText).join("\n")}`, cuttable: 2 });
  // ④ 伏笔 + 弧线（可截断）
  const fs = foreshadowBlock(w, 800);
  const threads = (w.plotThreads ?? []).filter((a) => a.status !== "已解决");
  const threadText = threads.length ? `进行中弧线:\n${threads.map((a) => `- ${a.name}：${a.note}`).join("\n")}` : "";
  segments.push({ label: "foreshadow", text: [fs, threadText].filter(Boolean).join("\n"), cuttable: 3 });

  // 预算裁减：按 cuttable 值大的先砍
  let tokens = segments.reduce((n, s) => n + estimateTokens(s.text), 0);
  const order = [...segments].filter((s) => s.cuttable > 0).sort((a, b) => b.cuttable - a.cuttable);
  for (const s of order) {
    if (tokens <= budget) break;
    tokens -= estimateTokens(s.text);
    s.text = "";
  }

  const out = segments.filter((s) => s.text.trim()).map((s) => ({ label: s.label, text: s.text }));
  return { segments: out, tier, tokens: out.reduce((n, s) => n + estimateTokens(s.text), 0) };
}

/** critic 专用全局上下文（替换 buildGlobalContext 的 slice(0,120) 假摘要，修 B1） */
export function buildCriticContext(w: WorldState, chapterIndex: number): string {
  const parts: string[] = [];
  parts.push("[全书角色当前状态]");
  for (const c of w.characters) {
    parts.push(`- ${c.name}（${c.role}）：${c.status}｜性格: ${c.traits.join("、")}｜动机: ${c.motivation}${c.exit ? `｜已于第${c.exit.chapter}章离场` : ""}`);
  }
  parts.push("\n[全书伏笔账本]");
  for (const f of w.foreshadowing) {
    parts.push(`- [${f.id}] ${f.text}（第${f.plantedAt}章埋设，状态: ${f.status}${f.note ? `，备注: ${f.note}` : ""}）`);
  }
  if (w.timeline?.length) {
    parts.push("\n[时间线]");
    for (const t of w.timeline.slice(-10)) parts.push(`- 第${t.chapter}章: ${t.summary}`);
  }
  // 前文：真实摘要（无摘要时降级首 120 字，仅旧存档首次审查会触发）
  const prevChapters = w.chapters.filter((c) => c.index < chapterIndex);
  if (prevChapters.length) {
    parts.push("\n[前文摘要]");
    for (const ch of prevChapters.slice(-8)) {
      const s = (w.chapterSummaries ?? []).find((x) => x.index === ch.index);
      parts.push(s ? `- ${summaryText(s)}` : `- 第${ch.index}章《${ch.title}》: ${ch.text.slice(0, 120)}…`);
    }
  }
  const gen = genOf(w, chapterIndex);
  parts.push(`\n[当前设定参数] POV: ${gen.pov}｜温度: ${gen.temperature}｜风格: ${gen.styleOverride || "默认"}｜审查严格度: ${gen.reviewStrictness}`);
  return parts.join("\n");
}

// 记忆层不转导出评分工具；critic 自行从 jsonutil 引入 clampScore
