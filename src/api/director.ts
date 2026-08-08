// 导演编排 P2 重构：writeOneChapter 统一管线（step / regenerate / autorun 共用）
// 管线：[抽卡?] → [考据?] → 写作(流式) → 自检 → 对抗审查(动态准则) → patch/重写(≤1轮)
//        → 记账结算(chronicler) → 质量债务登记 → 存档 + checkpoint
// 阶段边界可被 steering 打断（未 commit 零污染）
import { applyCards, autoPick, generateCardPool, type CardType } from "./cards";
import { reviewChapter, type CriticVerdict } from "./critic";
import { chatJson } from "./jsonutil";
import * as anysearch from "./anysearch";
import { allocateTitle, appendCheckpoint, clearPendingChapter, loadPendingChapter, savePendingChapter, saveWorld } from "./storage";
import { checkInterrupt, logChange } from "./steering";
import { patchChapter } from "./patch";
import { ensureChapterPlan, handleArcBoundary, healLegacyStory, markChapterDone, buildBlueprint, confirmBlueprint } from "./planner";
import { recomputeAppearedIn, settleChapter } from "./chronicler";
import { markOrphanMedia } from "./media";
import { deleteMediaFile } from "./images";
import { auditWorld, deleteChapterCascade } from "./integrity";
import { buildAutoLore, sanitizeLore } from "./lore";
import { formatChapterRange } from "../shared/chapterRange";
import {
  activeForeshadows, emptyWorld, genOf, worldSummary, DEFAULT_GEN,
  type Card, type Character, type Chapter, type ChapterPlan, type ChapterVersion, type ConsistencyReport, type GenProfile,
  type LoreEntry, type PendingChapter, type ReviewResult, type SteeringItem, type WorldState,
} from "./world";
import { isTitleLike, writeChapter } from "./writer";
import { applyBrainReview, brainGateEnabled, brainReviewAfterCommit, computeDisposition } from "./brain";

// —— SSE v2 事件协议（保留旧 writing/reviewing/saving/result 字段向后兼容） ——
export type StepPhase = "writing" | "delta" | "selfcheck" | "reviewing" | "patching" | "settling" | "saving" | "interrupted" | "done";
export type StepEvent =
  | { phase: "writing"; round: number }
  | { phase: "delta"; delta: string }
  | { phase: "selfcheck"; aiToneHits: string[]; guard: "ok" | "short" | "long" }
  | { phase: "reviewing"; round: number }
  | { phase: "patching"; paragraphs: number }
  | { phase: "settling"; newForeshadows: number; resolvedForeshadows: number; newProposals: number }
  | { phase: "saving" }
  | { phase: "interrupted"; item: SteeringItem }
  | { phase: "done"; result: StepResult };

export type StepResult = {
  chapter: Chapter;
  review: ReviewResult;
  critic: CriticVerdict;
  rounds: number; // 写作轮数（1 = 一次通过）
  instructions: string[];
  appliedCards: Card[];
  world: WorldState;
};

/** 打断异常：管线阶段边界检测到 steering 打断时抛出（草稿未 commit，零污染） */
export class InterruptedError extends Error {
  item: SteeringItem;
  constructor(item: SteeringItem) {
    super("写作被干预打断");
    this.item = item;
  }
}

/** 审查未通过（requirePass 模式）：章节未 commit（git commit 被拒），草稿进暂存区待重试/跳过 */
export class ReviewFailedError extends Error {
  chapterIndex: number;
  title: string;
  text: string;
  review: ReviewResult;
  constructor(p: { chapterIndex: number; title: string; text: string; review: ReviewResult }) {
    super(`第 ${p.chapterIndex} 章审查未通过（${p.review.verdict}）`);
    this.chapterIndex = p.chapterIndex;
    this.title = p.title;
    this.text = p.text;
    this.review = p.review;
  }
}

/** CriticVerdict → 旧 ReviewResult 兼容映射（前端/版本历史契约不变） */
export function toReviewResult(v: CriticVerdict): ReviewResult {
  return {
    verdict: v.action === "pass" ? "pass" : "revise",
    scores: v.scores,
    findings: v.findings,
    round: v.round,
  };
}

const INIT_SYSTEM = `你是小说立项导演。根据用户的一句话灵感，生成世界设定与核心人物。
输出必须是合法 JSON（不要 markdown 围栏）：
{"title":"书名","genre":"题材","premise":"一句话梗概","setting":{"time":"时代","place":"主要地点","rules":["世界规则/约束 2-4条"],"tone":"文风基调"},"characters":[{"name":"名字","gender":"男或女","age":"年龄（如：二十出头）","identity":"社会身份/职业","role":"主角/反派/配角","traits":["特质"],"motivation":"动机","secret":"秘密或没有","status":"初始状态","relations":{},"voice":"说话风格（如：简短冷峻，爱用反问句；或：温婉绵长，常用比喻）"}]}
要求：人物 2-4 个，性格鲜明有冲突；性别必须且只能是「男」或「女」，不得留空、不得写「未知」；age（年龄）与 identity（社会身份/职业）必须具体明确、不得省略（后续头像/立绘生成依赖这三项）；设定规则具体（能力体系/社会规则/禁忌）。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function newStory(idea: string, genre?: string): Promise<WorldState> {
  const out = await chatJson<{
    title?: string;
    genre?: string;
    premise?: string;
    setting?: { time?: string; place?: string; rules?: string[]; tone?: string };
    characters?: { name?: string; gender?: string; age?: string; identity?: string; role?: string; traits?: string[]; motivation?: string; secret?: string; status?: string; relations?: Record<string, string>; voice?: string }[];
  }>(
    [
      { role: "system", content: INIT_SYSTEM },
      { role: "user", content: `灵感：${idea}${genre ? `\n题材方向：${genre}` : ""}` },
    ],
    {
      temperature: 0.9,
      maxTokens: 60000,
      // jsonschema：立项输出结构化约束（角色性别强制 男/女 枚举）
      schema: {
        type: "object",
        required: ["title", "genre", "premise", "setting", "characters"],
        properties: {
          title: { type: "string" },
          genre: { type: "string" },
          premise: { type: "string" },
          setting: { type: "object", required: ["time", "place"], properties: { time: { type: "string" }, place: { type: "string" }, rules: { type: "array", items: { type: "string" } }, tone: { type: "string" } } },
          characters: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "gender", "age", "identity", "role", "traits", "motivation"],
              properties: {
                name: { type: "string" },
                gender: { type: "string", enum: ["男", "女"] },
                age: { type: "string" },
                identity: { type: "string" },
                role: { type: "string", enum: ["主角", "反派", "配角", "关键人物"] },
                traits: { type: "array", items: { type: "string" } },
                motivation: { type: "string" },
                secret: { type: "string" },
                status: { type: "string" },
                voice: { type: "string" },
              },
            },
          },
        },
      },
    },
  );

  const w = emptyWorld();
  // 同名冲突保护（修 G1）：LLM 起的书名若已有存档则自动追加 -2/-3
  w.title = allocateTitle(String(out.title ?? "未命名").trim());
  w.genre = String(out.genre ?? genre ?? "未分类").trim();
  w.premise = String(out.premise ?? idea).trim();
  w.setting = {
    time: String(out.setting?.time ?? "").trim(),
    place: String(out.setting?.place ?? "").trim(),
    rules: Array.isArray(out.setting?.rules) ? out.setting.rules.map(String) : [],
    tone: String(out.setting?.tone ?? "").trim(),
  };
  w.characters = (Array.isArray(out.characters) ? out.characters : []).map((c, i) => ({
    id: `c${i + 1}`,
    name: String(c.name ?? `角色${i + 1}`).trim(),
    // 性别只接受「男/女」：非法值（空/未知/AI 推断）一律丢弃，保证立项角色性别明确
    gender: c.gender === "男" || c.gender === "女" ? c.gender : undefined,
    age: c.age ? String(c.age).trim().slice(0, 20) : undefined,
    identity: c.identity ? String(c.identity).trim().slice(0, 40) : undefined,
    role: String(c.role ?? "配角").trim(),
    traits: Array.isArray(c.traits) ? c.traits.map(String) : [],
    motivation: String(c.motivation ?? "").trim(),
    secret: c.secret ? String(c.secret).trim() : undefined,
    status: String(c.status ?? "登场").trim(),
    relations: c.relations ?? {},
    voice: c.voice ? String(c.voice).trim().slice(0, 80) : undefined,
    introducedAt: 0,
  }));
  logChange(w, { chapter: w.nextChapter, actor: "user", kind: "newStory", detail: `立项建世界《${w.title}》（${w.genre}）：${w.premise.slice(0, 60)}${w.premise.length > 60 ? "…" : ""}，初始角色 ${w.characters.length} 名（头像/立绘自动生成中）`, commandId: "CMD-N01" });
  // 性别/年龄/身份缺失兜底推断（弱模型 schema required 仍可能漏字段；缺失会导致头像 prompt 写「性别未知」画出默认脸）——失败不阻塞立项
  try { await fillMissingCharacterFields(w); } catch (e) { console.warn("[director] 角色字段兜底推断失败（不阻塞）:", (e as Error).message); }
  saveWorld(w);
  // 立项即自动导演（P3）：生成蓝图候选并默认确认第一套（失败不阻塞，写作时自愈）
  try {
    const options = await buildBlueprint(w, idea);
    if (options.length) {
      w.blueprintOptions = options; // 落盘候选，供前端重新选择/重生
      await confirmBlueprint(w, options[0]);
    }
  } catch {
    /* 蓝图生成失败：保留基础世界，后续可由 /api/novel/blueprint 手动重试 */
  }
  return w;
}

/** 角色性别/年龄/身份缺失兜底推断（导出供存量迁移脚本复用）：
 * 缺任一项的角色按「书名/梗概/时代地点 + 角色已知信息 + 正文提及片段（如有）」让 LLM 补齐；
 * 性别只接受「男/女」，非法值丢弃；仅写空字段，不覆盖已有值；返回补全的角色数（无缺失返 0）。 */
export async function fillMissingCharacterFields(w: WorldState): Promise<number> {
  const needy = w.characters.filter((c) => !(c.gender === "男" || c.gender === "女") || !c.age || !c.identity);
  if (!needy.length) return 0;
  // 正文证据：每个缺字段角色取其名字首次出现的段落片段（≤200 字，最多 2 段），帮助推断性别/年龄/身份
  const evidence = needy.map((c) => {
    const hits: string[] = [];
    for (const ch of w.chapters) {
      const idx = ch.text.indexOf(c.name);
      if (idx >= 0) hits.push(ch.text.slice(Math.max(0, idx - 60), idx + 140).replace(/\s+/g, ""));
      if (hits.length >= 2) break;
    }
    return `- ${c.name}（定位 ${c.role}，特质 ${c.traits.slice(0, 3).join("、") || "—"}，动机 ${c.motivation.slice(0, 40) || "—"}）${hits.length ? `；正文片段：${hits.join(" / ")}` : ""}`;
  }).join("\n");
  const out = await chatJson<{ characters?: { name?: string; gender?: string; age?: string; identity?: string }[] }>(
    [
      { role: "system", content: "你是小说角色档案补全助手。根据故事背景与正文线索，为缺失字段的角色推断性别/年龄/社会身份。性别只能是「男」或「女」；年龄用简短词（如：三十许人）；身份用具体职业/社会地位（如：刑房书吏）。推断须与故事背景一致、角色之间不得雷同。只输出 JSON。" },
      { role: "user", content: `《${w.title}》（${w.genre}）：${w.premise.slice(0, 120)}；时代 ${w.setting.time || "—"}，地点 ${w.setting.place || "—"}。\n请为以下角色补齐缺失字段：\n${evidence}\n输出：{"characters":[{"name":"角色名","gender":"男或女","age":"年龄","identity":"社会身份/职业"}]}` },
    ],
    {
      temperature: 0.3,
      maxTokens: 2000,
      schema: {
        type: "object",
        required: ["characters"],
        properties: {
          characters: {
            type: "array",
            items: {
              type: "object", required: ["name"],
              properties: { name: { type: "string" }, gender: { type: "string", enum: ["男", "女"] }, age: { type: "string" }, identity: { type: "string" } },
            },
          },
        },
      },
    },
  );
  let filled = 0;
  for (const c of needy) {
    const f = (out.characters ?? []).find((x) => x?.name === c.name);
    if (!f) continue;
    let touched = false;
    if (!(c.gender === "男" || c.gender === "女") && (f.gender === "男" || f.gender === "女")) { c.gender = f.gender; touched = true; }
    if (!c.age && f.age) { c.age = String(f.age).trim().slice(0, 20); touched = true; }
    if (!c.identity && f.identity) { c.identity = String(f.identity).trim().slice(0, 40); touched = true; }
    if (touched) filled++;
  }
  if (filled) console.log(`[director] 角色字段兜底补全：《${w.title}》${filled} 个角色（${needy.map((c) => c.name).join("、")}）`);
  return filled;
}

function clampNum(n: unknown, lo: number, hi: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, v));
}

/** 历史真实模式自动考据：AnySearch 查证时代/地点设定 → 世界书「考据」条目（只查一次） */
async function ensureResearch(world: WorldState): Promise<void> {
  if (genOf(world).settingMode !== "历史真实") return;
  if ((world.lore ?? []).some((e) => e.keywords.includes("考据"))) return; // 已考据过
  try {
    const q = `${world.setting.time} ${world.setting.place} 官职 制度 风俗`.trim().slice(0, 80);
    const text = await anysearch.search({ query: q, max_results: 3 });
    const content = text.replace(/\s+/g, " ").slice(0, 900);
    world.lore = [
      ...(world.lore ?? []),
      { id: `lore-r${Date.now().toString(36)}`, keywords: ["考据"], content: `历史考据（${q}）：${content}`, enabled: true, auto: true },
    ];
    logChange(world, { chapter: world.nextChapter, actor: "ai", kind: "lore-research", detail: `历史考据：${q} → 世界书「考据」条目（${content.slice(0, 40)}…）`, commandId: "CMD-W15" });
    saveWorld(world);
  } catch {
    /* 考据失败不阻塞写作 */
  }
}

/** 登记质量债务（minor findings 不阻塞但留痕，修 D4）；includeMajor=true 时 major 也登记（连载审查未过时记账联动） */
function registerDebt(w: WorldState, chapterIndex: number, v: CriticVerdict, includeMajor = false): void {
  registerDebtFindings(w, chapterIndex, v.findings, includeMajor);
}

/** 按审查结果登记质量债务（ReviewResult 版，供连载审查未过时记账联动；落盘由调用方负责） */
export function registerReviewDebt(w: WorldState, chapterIndex: number, review: ReviewResult, includeMajor = true): void {
  registerDebtFindings(w, chapterIndex, review.findings, includeMajor);
}

function registerDebtFindings(w: WorldState, chapterIndex: number, findings: { severity: "major" | "minor"; lens: string; issue: string }[], includeMajor: boolean): void {
  const list = w.qualityDebt ?? [];
  for (const f of findings) {
    if (f.severity !== "minor" && !includeMajor) continue;
    // 去重：同章同 lens 同问题只记一条
    if (list.some((d) => d.chapterIndex === chapterIndex && d.lens === f.lens && d.issue === f.issue)) continue;
    list.push({
      id: `qd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      chapterIndex,
      lens: f.lens,
      issue: f.issue,
      severity: f.severity,
      status: "open",
    });
  }
  w.qualityDebt = list.slice(-200);
}

/**
 * 统一章节管线（P2 核心）：写 → 自检 → 审 → patch/重写(≤1轮) → 记账 → 存档。
 * plan 为本章计划（P3 planner 供给，当前可为 null）；onEvent 透传 SSE v2 事件。
 * 阶段边界检测 steering 打断：命中即抛 InterruptedError（草稿未 commit，零污染）。
 */
/** 审查已通过但 commitPolicy=confirm：章节暂存待人工确认（未 commit，草稿进暂存区） */
export class PendingCommitError extends Error {
  chapterIndex: number;
  title: string;
  text: string;
  review: ReviewResult;
  constructor(p: { chapterIndex: number; title: string; text: string; review: ReviewResult }) {
    super(`第 ${p.chapterIndex} 章审查通过，待人工确认入册`);
    this.chapterIndex = p.chapterIndex;
    this.title = p.title;
    this.text = p.text;
    this.review = p.review;
  }
}

export async function writeOneChapter(
  world: WorldState,
  instruction: string,
  onEvent?: (e: StepEvent) => void,
  overridePlan?: ChapterPlan | null,
  opts: { requirePass?: boolean; commitPolicy?: "auto" | "confirm" } = {},
): Promise<StepResult> {
  const idx = world.nextChapter;
  let rounds = 0;
  let appliedCards: Card[] = [];
  const chapterIndex = idx;

  // ① 自动抽卡（保留游戏化亮点；效果作为 L0 章节级指令注入）
  if (genOf(world).autoGacha) {
    try {
      const pool = await generateCardPool(world, { count: 3, types: ["发展方向", "伏笔", "章节"] });
      const picked = autoPick(pool, 1);
      const r = applyCards(world, picked);
      appliedCards = r.applied;
      if (r.instructions.length) instruction = [instruction, ...r.instructions].filter(Boolean).join("\n");
    } catch {
      /* 自动抽卡失败不阻塞回合 */
    }
  }
  await ensureResearch(world);

  // 旧故事自愈：无蓝图时补最小蓝图（P3，使新管线可接管存量作品）
  if (!world.blueprint) {
    try {
      await healLegacyStory(world);
    } catch {
      /* 自愈失败则走无本章计划模式 */
    }
  }

  // ①' 取本章计划（外部指定优先；缺失 → 滚动展开当前弧）
  let plan: ChapterPlan | null = overridePlan ?? null;
  if (!plan) {
    try {
      plan = await ensureChapterPlan(world, idx);
    } catch {
      /* 展开失败不阻塞写作（降级无本章计划模式） */
    }
  }

  // 打断检查（写作前）
  let it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }

  // ② 写作（流式）
  rounds++;
  onEvent?.({ phase: "writing", round: rounds });
  const draft = await writeChapter({
    world,
    instruction,
    chapterIndex,
    plan,
    onDelta: (delta) => onEvent?.({ phase: "delta", delta }),
  });
  let title = draft.title;
  let text = draft.text;

  // ③ 确定性自检（零 LLM）
  onEvent?.({ phase: "selfcheck", aiToneHits: draft.aiToneHits, guard: draft.guard });

  // 打断检查（写作后 / 审查前）
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }

  // ④⑤ 对抗审查（动态准则 + 摘要层上下文）+ 修复循环（≤2 轮：patch 段落修补 / rewrite 整章重写，均复审）
  const fixed = await reviewFixLoop(world, { title, text }, chapterIndex, plan, onEvent, { instruction });
  title = fixed.title;
  text = fixed.text;
  rounds = Math.max(rounds, fixed.rounds);
  const verdict = fixed.verdict;

  // 打断检查（审查后 / 提交前）：仍未 commit，丢弃安全
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }

  // ⑥ commit（git 语义）：requirePass 模式下审查未通过 = commit 被拒，零污染停下（草稿进暂存区）
  if (opts.requirePass && verdict.action !== "pass") {
    // 记账联动：major findings 登记质量债务，供跳过/重试后处置
    registerDebt(world, chapterIndex, verdict, true);
    throw new ReviewFailedError({ chapterIndex, title, text, review: toReviewResult(verdict) });
  }
  // 人工确认通道（commitPolicy=confirm）：审查通过后暂存草稿（含 verdict 序列化），等确认才走完整 commit 记账
  if (opts.commitPolicy === "confirm" && verdict.action === "pass") {
    const review = toReviewResult(verdict);
    savePendingChapter(world.title, {
      chapterIndex, title, text, review,
      savedAt: new Date().toISOString(),
      pendingCommit: true,
      verdictJson: JSON.stringify(verdict),
    });
    world.nextChapter = chapterIndex; // 未 commit：nextChapter 不推进，确认后由 commitChapter 推进
    saveWorld(world);
    throw new PendingCommitError({ chapterIndex, title, text, review });
  }
  const chapter = await commitChapter(
    world,
    { index: chapterIndex, title, text, verdict, plan, rounds, instructions: [], appliedCards },
    onEvent,
  );

  const result: StepResult = {
    chapter,
    review: toReviewResult(verdict),
    critic: verdict,
    rounds,
    instructions: [],
    appliedCards,
    world,
  };
  return result;
}

/** 审查 + 修复循环（≤2 轮）：pass → 返回；patch → 段落修补后复审；rewrite → 整章重写后复审。复用 于新章写入与暂存区重试 */
async function reviewFixLoop(
  world: WorldState,
  init: { title: string; text: string },
  chapterIndex: number,
  plan: ChapterPlan | null,
  onEvent: ((e: StepEvent) => void) | undefined,
  opts: { instruction: string },
): Promise<{ title: string; text: string; verdict: CriticVerdict; rounds: number }> {
  let { title, text } = init;
  let rounds = 0;
  onEvent?.({ phase: "reviewing", round: rounds });
  let verdict = await reviewChapter(world, text, title, chapterIndex, plan);
  verdict.round = rounds;
  let fixRounds = 0;
  while (verdict.action !== "pass" && fixRounds < 2) {
    fixRounds++;
    if (verdict.action === "patch") {
      onEvent?.({ phase: "patching", paragraphs: verdict.findings.filter((f) => f.severity === "major").length });
      const pr = await patchChapter(world, { index: chapterIndex, title, text, review: null }, verdict);
      if (pr.patched) {
        text = pr.text;
        // 修补后复审一次（修复闭环，修 C4）
        onEvent?.({ phase: "reviewing", round: rounds });
        verdict = await reviewChapter(world, text, title, chapterIndex, plan);
        verdict.round = rounds;
      }
    } else if (verdict.action === "rewrite") {
      rounds++;
      onEvent?.({ phase: "writing", round: rounds });
      const revisionNotes = verdict.findings
        .map((f) => `[${f.lens}/${f.severity}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`)
        .join("\n");
      const redo = await writeChapter({
        world,
        instruction: opts.instruction,
        revisionNotes,
        draft: text,
        chapterIndex,
        plan,
        onDelta: (delta) => onEvent?.({ phase: "delta", delta }),
      });
      // 健全闸门：rewrite 产出目标句/垃圾标题时保留进入修复循环前的标题（比降级「第N章」更贴近章节）
      title = isTitleLike(redo.title) ? redo.title : title;
      text = redo.text;
      onEvent?.({ phase: "reviewing", round: rounds });
      verdict = await reviewChapter(world, text, title, chapterIndex, plan);
      verdict.round = rounds;
    }
  }
  // 出口健全闸门（writeOneChapter/retryChapter 共用）：目标句永不能成为章名，兜底「第N章」
  return { title: isTitleLike(title) ? title : `第${chapterIndex}章`, text, verdict, rounds };
}

/**
 * 章节提交（git commit 语义）：入册 + 版本快照基线 + 记账结算 + 质量债务 + 本章计划核销/弧边界 + nextChapter + 存档 + checkpoint。
 * 供新章写入（writeOneChapter）与暂存区重试（retryChapter）复用。
 */
export async function commitChapter(
  world: WorldState,
  args: {
    index: number;
    title: string;
    text: string;
    verdict: CriticVerdict;
    plan: ChapterPlan | null;
    rounds?: number;
    instructions?: string[];
    appliedCards?: Card[];
    checkpointStep?: string;
    /** 审计：提交触发方（user=人工确认/连载，ai=自动管线，system=重试） */
    actor?: "user" | "ai" | "system";
  },
  onEvent?: (e: StepEvent) => void,
): Promise<Chapter> {
  const { index, title, text, verdict, plan } = args;
  const chapter: Chapter = { index, title, text, review: toReviewResult(verdict), updatedAt: new Date().toISOString() };
  // 版本联动：入册基线留快照（后续编辑/重写/回滚可还原到连载版本）
  snapshotVersion(chapter, "连载入册");
  world.chapters.push(chapter);
  onEvent?.({ phase: "settling", newForeshadows: 0, resolvedForeshadows: 0, newProposals: 0 });
  const report = await settleChapter(world, chapter, plan);
  // git 式变更快照：记录本章结算产生的覆盖式变更（含旧值），删除章节时逆操作恢复账本
  world.chapterDeltas = { ...(world.chapterDeltas ?? {}), [index]: report.delta };
  onEvent?.({
    phase: "settling",
    newForeshadows: report.newForeshadows,
    resolvedForeshadows: report.resolvedForeshadows,
    newProposals: report.newProposals,
  });
  // 中枢章末一致性审查（P1 窗口：settleChapter 后、registerDebt 前；BRAIN §5.1 / DEEP-DIVE §1.1）
  // 仅 AGNES_BRAIN_GATE=on 时执行 LLM 审查（revise→注入 mergeTasks 通道；reject→记录不强制回滚）；
  // off 时仅记确定性 goal disposition（零 LLM、零行为变化，BRAIN §3.3 P1 确定性版本）
  const disposition = computeDisposition(world);
  if (brainGateEnabled()) {
    const brainOut = await brainReviewAfterCommit(world, index, {
      text,
      settleSummary: report.summary.summary,
      planGoal: plan?.goal,
    });
    applyBrainReview(world, index, brainOut, `章末一致性审查（${brainOut.verdict}）：${brainOut.reason ?? "放行"}；goal=${disposition}`);
  } else {
    logChange(world, {
      chapter: index,
      actor: "brain",
      kind: "brain-disposition",
      detail: `goal disposition: ${disposition}（第 ${index} 章《${title}》提交后）`,
      commandId: "CMD-L01",
      meta: { goal: world.goal ?? null },
    });
  }
  // 质量债务登记（minor 不阻塞）
  registerDebt(world, index, verdict);
  // 下一章号先递增：弧/卷边界处理内 expandArc 的 startIdx 依赖已递增的 nextChapter，
  // 若后置会与刚完成的本章章号重叠（弧计划残留 planned、弧/卷永不 done）
  world.nextChapter++;
  // 本章计划核销 + 弧/卷边界（滚动规划：弧摘要→展开下一弧；卷边界→指南针校准）
  const boundary = markChapterDone(world, index);
  if (boundary) {
    try {
      await handleArcBoundary(world, boundary.arcId);
    } catch {
      /* 弧边界处理失败不阻塞存档，下回合重试 */
    }
  }
  onEvent?.({ phase: "saving" });
  // 审计：每章提交本体落一条审计条目（谁触发、第几章、账本影响），与 brain-disposition 旁路记录互补
  logChange(world, {
    chapter: index,
    actor: args.actor ?? "ai",
    kind: "chapter-commit",
    detail: `第 ${index} 章《${title}》提交入册（审查 ${verdict.action}，记账：新伏笔 ${report.newForeshadows}/回收 ${report.resolvedForeshadows}/新角色提案 ${report.newProposals}/角色状态更新 ${report.characterUpdates}）`,
    commandId: "CMD-N02",
    level: "L2",
  });
  saveWorld(world);
  appendCheckpoint(world.title, args.checkpointStep ?? "commit", index);
  onEvent?.({
    phase: "done",
    result: {
      chapter,
      review: toReviewResult(verdict),
      critic: verdict,
      rounds: args.rounds ?? 0,
      instructions: args.instructions ?? [],
      appliedCards: args.appliedCards ?? [],
      world,
    },
  });
  return chapter;
}

/**
 * 重试暂存区草稿（连载审查未通过的章节）：以上一稿 + 审查意见重写 → 修复循环 → 通过则 commit（git amend）；
 * 仍不通过 → 更新暂存区并抛 ReviewFailedError（再次停下，零污染）。
 */
export async function retryChapter(
  world: WorldState,
  pending: PendingChapter,
  onEvent?: (e: StepEvent) => void,
): Promise<StepResult> {
  const chapterIndex = pending.chapterIndex;
  // 取本章计划（缺失时滚动展开；失败降级无本章计划模式）
  let plan: ChapterPlan | null = null;
  try {
    plan = await ensureChapterPlan(world, chapterIndex);
  } catch {
    /* 展开失败不阻塞写作 */
  }
  // 打断检查（写作前）
  let it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }
  const revisionNotes = pending.review.findings
    .map((f) => `[${f.lens}/${f.severity}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`)
    .join("\n");
  const instruction = `重写第 ${chapterIndex} 章：基于上一稿与审查意见逐条修正（保持剧情方向与既定事实）。`;
  let rounds = 1;
  onEvent?.({ phase: "writing", round: rounds });
  const draft = await writeChapter({
    world,
    instruction,
    revisionNotes,
    draft: pending.text,
    chapterIndex,
    plan,
    onDelta: (delta) => onEvent?.({ phase: "delta", delta }),
  });
  // 健全闸门：writeChapter 已兜底（非空），pending.title 仅作极端空值兜底，仍须过 isTitleLike
  let title = draft.title || (isTitleLike(pending.title) ? pending.title : `第${chapterIndex}章`);
  let text = draft.text;
  onEvent?.({ phase: "selfcheck", aiToneHits: draft.aiToneHits, guard: draft.guard });
  // 打断检查（写作后 / 审查前）
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }
  // 审查 + 修复循环（≤2 轮）
  const fixed = await reviewFixLoop(world, { title, text }, chapterIndex, plan, onEvent, { instruction });
  title = fixed.title;
  text = fixed.text;
  rounds = Math.max(rounds, fixed.rounds);
  const verdict = fixed.verdict;
  // 打断检查（审查后 / 提交前）
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }
  // 仍不通过：更新暂存区（git：工作区继续保留，等待下一次重试/跳过）
  if (verdict.action !== "pass") {
    registerDebt(world, chapterIndex, verdict, true);
    throw new ReviewFailedError({ chapterIndex, title, text, review: toReviewResult(verdict) });
  }
  const chapter = await commitChapter(
    world,
    { index: chapterIndex, title, text, verdict, plan, rounds, instructions: [], appliedCards: [], checkpointStep: "retry" },
    onEvent,
  );
  return { chapter, review: toReviewResult(verdict), critic: verdict, rounds, instructions: [], appliedCards: [], world };
}

/** 兼容旧路由：单回合推进（内部走 writeOneChapter） */
export async function step(
  world: WorldState,
  instruction: string,
  onEvent?: (e: StepEvent) => void,
  opts: { commitPolicy?: "auto" | "confirm" } = {},
): Promise<StepResult> {
  return writeOneChapter(world, instruction, onEvent, null, { commitPolicy: opts.commitPolicy });
}

/** 确认入册（commitPolicy=confirm 通道）：消费暂存区待确认草稿 → 重建 verdict → 走完整 commitChapter（记账/存档/nextChapter） */
export async function confirmPendingChapter(world: WorldState): Promise<StepResult> {
  const pending = loadPendingChapter(world.title);
  if (!pending || !pending.pendingCommit) throw new Error("暂存区没有待确认入册的章节");
  if (!pending.verdictJson) throw new Error("待确认章节缺少审查记录，无法入册");
  const verdict = JSON.parse(pending.verdictJson) as CriticVerdict;
  const plan = (world.chapterPlans ?? []).find((p) => p.index === pending.chapterIndex) ?? null;
  // 健全闸门：消费旧暂存草稿标题时仍须过 isTitleLike（兼容修复前落盘的脏标题）
  const safeTitle = isTitleLike(pending.title) ? pending.title : `第${pending.chapterIndex}章`;
  const chapter = await commitChapter(
    world,
    { index: pending.chapterIndex, title: safeTitle, text: pending.text, verdict, plan, rounds: verdict.round, instructions: [], appliedCards: [], checkpointStep: "confirm-commit" },
  );
  clearPendingChapter(world.title);
  logChange(world, { chapter: pending.chapterIndex, actor: "user", kind: "chapter-confirm", detail: `人工确认第 ${pending.chapterIndex} 章《${pending.title}》入册（审查通过后待确认模式）`, commandId: "CMD-N04" });
  saveWorld(world);
  return { chapter, review: toReviewResult(verdict), critic: verdict, rounds: verdict.round, instructions: [], appliedCards: [], world };
}

/** 抽卡·生成卡池（仅生成，不应用）：存入 world.pendingCards 供后续 apply 使用 */
export async function gachaGenerate(
  world: WorldState,
  opts: { count?: number; types?: CardType[] },
): Promise<{ pool: Card[] }> {
  const pool = await generateCardPool(world, { count: opts.count ?? 4, types: opts.types });
  world.pendingCards = pool;
  logChange(world, { chapter: world.nextChapter, actor: "user", kind: "gacha-generate", detail: `生成卡池 ${pool.length} 张：${pool.map((c) => `「${c.title}」(${c.rarity}/${c.type})`).join("、").slice(0, 200)}`, commandId: "CMD-W17" });
  saveWorld(world);
  return { pool };
}

/** 抽卡·应用（从 pendingCards 中抽取）：auto 自动选 / pick 按 ID 选 */
export function gachaApply(
  world: WorldState,
  opts: { auto?: boolean; pick?: string[] },
): { instructions: string[]; applied: Card[] } {
  const pool = world.pendingCards ?? [];
  if (!pool.length) throw new Error("卡池为空，请先生成卡池");
  const picked = opts.auto
    ? autoPick(pool)
    : (opts.pick ?? []).map((id) => pool.find((c) => c.id === id)).filter(Boolean) as Card[];
  if (!picked.length) throw new Error("未选中任何卡牌");
  const { instructions, applied } = applyCards(world, picked);
  world.pendingCards = []; // 清空已用卡池
  logChange(world, { chapter: world.nextChapter, actor: "user", kind: "gacha-apply", detail: `抽卡应用 ${applied.length} 张：${applied.map((c) => `「${c.title}」(${c.type})`).join("、").slice(0, 200)}`, commandId: "CMD-W18" });
  saveWorld(world);
  return { instructions, applied };
}

// —— 大纲生成（兼容端点：新架构下映射为"重新展开当前弧"，P3 planner 接入后升级） ——
const OUTLINE_SYSTEM = `你是小说"大纲规划师"。根据世界状态、已发生章节与活跃伏笔，规划接下来 3-6 个情节要点（每个一句话，含"做什么/发生什么/伏笔如何推进"）。
要求：
- 要点之间要有因果递进，构成一个小的故事弧
- 必须推进至少 1 条活跃伏笔，允许提出新的悬念
- 风格与世界观基调一致
- 输出必须是合法 JSON（不要 markdown 围栏）：{"outline":["要点1","要点2",...]}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function generateOutline(world: WorldState, userHint?: string): Promise<string[]> {
  const userMsg = [
    worldSummary(world),
    `\n当前已写到第 ${world.chapters.length} 章。`,
    userHint ? `\n[你的意图] ${userHint.slice(0, 500)}` : "", // 长度 clamp（安全 LOW）
    "\n请输出接下来 3-6 个情节要点（只输出 JSON）。",
  ].join("\n");
  const out = await chatJson<{ outline?: string[] }>(
    [
      { role: "system", content: OUTLINE_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.8, maxTokens: 60000, schema: { type: "object", required: ["outline"], properties: { outline: { type: "array", items: { type: "string" } } } } },
  );
  const list = (Array.isArray(out.outline) ? out.outline : []).map(String).filter((s) => s.trim()).slice(0, 6);
  world.outline = list;
  logChange(world, { chapter: world.nextChapter, actor: "user", kind: "outline-generate", detail: `生成大纲 ${list.length} 条：${list.map((s) => s.slice(0, 30)).join("；").slice(0, 200)}`, commandId: "CMD-W01" });
  saveWorld(world);
  return list;
}

/** 手动编辑世界：书名/作者/设定/梗概/角色/大纲/生成参数/章节覆盖/章节标题（浅合并 + 类型守卫） */
export function editWorld(world: WorldState, patch: {
  author?: string;
  premise?: string;
  setting?: Partial<WorldState["setting"]>;
  current?: string; // 全局当前状态（单行自然语言）
  characters?: Partial<Character>[];
  outline?: string[];
  gen?: Partial<GenProfile>;
  chapterGen?: Record<number, Partial<GenProfile>>;
  chapterTitle?: { index: number; title: string }[]; // 章节标题修改（留版本快照，回滚可还原）
  removeCharacterIds?: string[]; // 角色移除（已登场角色禁止移除）
  lore?: LoreEntry[]; // 世界书条目（M3，合并保存：sanitizeLore 清洗）
}): WorldState {
  if (typeof patch.author === "string") world.author = patch.author.trim();
  if (typeof patch.premise === "string" && patch.premise.trim()) world.premise = patch.premise.trim();
  if (patch.setting) {
    if (typeof patch.setting.time === "string") world.setting.time = patch.setting.time;
    if (typeof patch.setting.place === "string") world.setting.place = patch.setting.place;
    if (typeof patch.setting.tone === "string") world.setting.tone = patch.setting.tone;
    if (Array.isArray(patch.setting.rules)) world.setting.rules = patch.setting.rules.map(String).filter((s) => s.trim());
  }
  if (typeof patch.current === "string") world.current = patch.current.trim().slice(0, 200) || undefined;
  // 章节标题修改：校验章节存在/标题非空，留版本快照（回滚可还原标题）并刷新 updatedAt
  if (Array.isArray(patch.chapterTitle)) {
    for (const item of patch.chapterTitle) {
      const index = Number(item?.index);
      const t = String(item?.title ?? "").trim().slice(0, 60);
      if (!Number.isInteger(index) || !t) continue;
      const ch = world.chapters.find((c) => c.index === index);
      if (!ch || ch.title === t) continue;
      snapshotVersion(ch, "修改章节标题");
      ch.title = t;
      ch.updatedAt = new Date().toISOString();
    }
  }
  if (Array.isArray(patch.outline)) {
    // 数量/长度上限：防止超大 outline 撑爆写作 prompt（review should-fix）
    world.outline = patch.outline
      .map((s) => String(s).trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 10);
  }
  // M1 生成参数（浅合并 + 数字范围钳制）
  if (patch.gen && typeof patch.gen === "object") {
    const g = { ...DEFAULT_GEN, ...world.gen, ...(patch.gen as Partial<GenProfile>) };
    g.minWords = clampNum(g.minWords, 100, 20000);
    g.maxWords = clampNum(g.maxWords, 100, 20000);
    if (g.minWords > g.maxWords) [g.minWords, g.maxWords] = [g.maxWords, g.minWords];
    g.temperature = clampNum(g.temperature, 0, 2);
    g.maxForeshadowPerChapter = clampNum(g.maxForeshadowPerChapter, 0, 4);
    g.styleOverride = String(g.styleOverride ?? "").slice(0, 200); // 长度 clamp（安全 LOW）
    if (g.targetChapterWords != null) g.targetChapterWords = clampNum(g.targetChapterWords, 200, 20000);
    // 遵循设定细则（逐条校验）
    const rulesIn = (patch.gen as Partial<GenProfile>).fidelityRules;
    if (Array.isArray(rulesIn)) {
      g.fidelityRules = rulesIn
        .filter((r) => !!r && typeof r === "object" && typeof r.content === "string")
        .map((r) => ({
          content: (r.content as string).trim().slice(0, 100),
          follow: r.follow === "史实" ? ("史实" as const) : ("架空" as const),
        }))
        .filter((r) => r.content)
        .slice(0, 20);
    } else {
      g.fidelityRules = g.fidelityRules ?? [];
    }
    world.gen = g;
  }
  // M6 章节级参数覆盖（按章节号合并；null = 删除覆盖；undefined 字段 = 保留）
  if (patch.chapterGen && typeof patch.chapterGen === "object") {
    const incoming = patch.chapterGen as Record<string, Partial<GenProfile> | null>;
    world.chapterGen = world.chapterGen ?? {};
    for (const [k, v] of Object.entries(incoming)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 1) continue;
      if (v === null) {
        delete world.chapterGen[idx]; // 清除覆盖
        continue;
      }
      if (!v || typeof v !== "object") continue;
      const prev = world.chapterGen[idx] ?? {};
      // clean：显式字段；removeKeys：显式删除（null = per-key 清除）
      const clean: Record<string, unknown> = {};
      const removeKeys: string[] = [];
      for (const [fk, fv] of Object.entries(v)) {
        if (fv === null) removeKeys.push(fk);
        else if (fv !== undefined) clean[fk] = fv;
      }
      if (Object.keys(clean).length === 0 && removeKeys.length === 0) {
        // 全部字段留空 = 清除该章节覆盖（否则旧覆盖残留，归零=跟随全局失效）
        delete world.chapterGen[idx];
        continue;
      }
      const merged: Record<string, unknown> = { ...prev, ...clean };
      for (const k of removeKeys) delete merged[k];
      const m = merged as unknown as Partial<GenProfile>;
      if (m.minWords != null) m.minWords = clampNum(m.minWords, 100, 20000);
      if (m.maxWords != null) m.maxWords = clampNum(m.maxWords, 100, 20000);
      if (m.temperature != null) m.temperature = clampNum(m.temperature, 0, 2);
      if (m.maxForeshadowPerChapter != null) m.maxForeshadowPerChapter = clampNum(m.maxForeshadowPerChapter, 0, 4);
      if (m.styleOverride != null) m.styleOverride = String(m.styleOverride).slice(0, 200);
      if (m.targetChapterWords != null) m.targetChapterWords = clampNum(m.targetChapterWords, 200, 20000);
      // 章节级遵循设定细则（与 gen 同校验）
      if (Array.isArray(clean.fidelityRules)) {
        m.fidelityRules = (clean.fidelityRules as unknown[])
          .filter((r): r is { content?: unknown; follow?: unknown } => !!r && typeof r === "object")
          .map((r) => ({
            content: String(r.content ?? "").trim().slice(0, 100),
            follow: r.follow === "史实" ? ("史实" as const) : ("架空" as const),
          }))
          .filter((r) => r.content)
          .slice(0, 20);
      }
      if (m.minWords != null && m.maxWords != null && m.minWords > m.maxWords) {
        [m.minWords, m.maxWords] = [m.maxWords, m.minWords];
      }
      world.chapterGen[idx] = m;
    }
  }
  if (Array.isArray(patch.characters)) {
    const renames: { from: string; to: string }[] = [];
    for (const pc of patch.characters) {
      if (!pc || typeof pc !== "object") continue;
      const target = pc.id ? world.characters.find((c) => c.id === pc.id) : undefined;
      if (!target) {
        // 手动新增角色：id 与姓名均有效且不与既有角色重名时创建（性别仅接受男/女，与立项/提案一致）
        const name = typeof pc.name === "string" ? pc.name.trim() : "";
        if (!pc.id || !name) continue;
        const id = String(pc.id).slice(0, 64);
        if (world.characters.some((c) => c.id === id)) {
          throw new Error(`角色 id 冲突：${id} 已存在`);
        }
        if (world.characters.some((c) => c.name === name)) {
          throw new Error(`角色「${name}」已存在`);
        }
        world.characters.push({
          id,
          name: name.slice(0, 40),
          role: typeof pc.role === "string" && pc.role.trim() ? pc.role.trim().slice(0, 20) : "配角",
          gender: pc.gender === "男" || pc.gender === "女" ? pc.gender : undefined,
          age: typeof pc.age === "string" ? pc.age.trim().slice(0, 20) || undefined : undefined,
          identity: typeof pc.identity === "string" ? pc.identity.trim().slice(0, 30) || undefined : undefined,
          traits: Array.isArray(pc.traits) ? pc.traits.map(String).filter((s) => s.trim()) : [],
          motivation: typeof pc.motivation === "string" ? pc.motivation : "",
          voice: typeof pc.voice === "string" ? pc.voice.trim().slice(0, 80) || undefined : undefined,
          status: typeof pc.status === "string" && pc.status.trim() ? pc.status.trim() : "待登场",
          look: typeof pc.look === "string" ? pc.look.trim().slice(0, 120) || undefined : undefined,
          relations: {},
          introducedAt: world.nextChapter,
        });
        continue;
      }
      if (typeof pc.name === "string" && pc.name.trim()) {
        const newName = pc.name.trim();
        // 重命名撞名拦截：目标名已属于其他角色时拒绝（含同一 patch 内先新增后改名的组合）
        if (newName !== target.name) {
          const clash = world.characters.find((c) => c.id !== target.id && c.name === newName);
          if (clash) throw new Error(`角色「${newName}」已存在`);
        }
        // 角色重命名：先记录，字段合并完成后全局传播（关系键/章节/大纲/世界书/伏笔/弧线/时间线）
        if (newName !== target.name && target.name.length >= 2) {
          renames.push({ from: target.name, to: newName });
        }
        target.name = newName;
      }
      if (typeof pc.role === "string" && pc.role.trim()) target.role = pc.role.trim();
      if (Array.isArray(pc.traits)) target.traits = pc.traits.map(String).filter((s) => s.trim());
      if (typeof pc.motivation === "string") target.motivation = pc.motivation;
      if (typeof pc.voice === "string") target.voice = pc.voice.trim().slice(0, 80) || undefined;
      if (typeof pc.status === "string") target.status = pc.status;
      if (typeof pc.gender === "string") target.gender = pc.gender === "男" || pc.gender === "女" ? pc.gender : target.gender;
      if (typeof pc.age === "string") target.age = pc.age.trim().slice(0, 20) || undefined;
      if (typeof pc.identity === "string") target.identity = pc.identity.trim().slice(0, 30) || undefined;
      if (typeof pc.look === "string") target.look = pc.look.trim().slice(0, 120) || undefined;
      // 关系图保存：整体替换该角色的关系表（键=对方姓名，值=关系描述）——持久化后注入写作/审查 prompt
      if (pc.relations && typeof pc.relations === "object" && !Array.isArray(pc.relations)) {
        const rel: Record<string, string> = {};
        for (const [k, v] of Object.entries(pc.relations as Record<string, unknown>)) {
          const key = String(k).trim().slice(0, 40);
          const val = String(v ?? "").trim().slice(0, 60);
          if (key && val) rel[key] = val;
        }
        target.relations = rel;
      }
    }
    for (const r of renames) applyRename(world, r.from, r.to);
  }
  // 角色移除保护：已登场（appearedIn 非空）的角色禁止移除
  if (Array.isArray(patch.removeCharacterIds)) {
    const ids = patch.removeCharacterIds.map(String);
    for (const id of ids) {
      const c = world.characters.find((x) => x.id === id);
      if (!c) continue;
      if (c.appearedIn?.length) {
        throw new Error(`角色「${c.name}」已在第 ${formatChapterRange(c.appearedIn)} 章登场，禁止移除`);
      }
    }
    // 移除角色同步删盘其立绘/头像文件（best-effort，引用守卫在 deleteMediaFile 内）：
    // 立绘/头像文件仅该角色独占引用，移除后无任何引用，避免本地残留无用媒体
    const removed = world.characters.filter((x) => ids.includes(x.id));
    world.characters = world.characters.filter((x) => !ids.includes(x.id));
    for (const c of removed) {
      if (c.portrait?.path) deleteMediaFile(world.title, c.portrait.path);
      if (c.image) deleteMediaFile(world.title, c.image);
    }
  }
  // M3 世界书（合并保存：随世界观补丁一并写入）
  // auto 条目不固化——按最新世界观/人物重建（buildAutoLore，须在 characters/removeCharacterIds 之后，保证基于最终角色状态），
  // 手动条目经 sanitizeLore 落盘
  if (Array.isArray(patch.lore)) {
    const manual = sanitizeLore(patch.lore).filter((e) => !e.auto);
    world.lore = [...buildAutoLore(world), ...manual];
  }
  // 注：不在此落盘——由调用方（/api/novel/world 路由）在锁内统一 saveWorld，
  // 避免 editWorld 内落盘 + 路由 L2 策略 applyStrategy 落盘 + 路由最终落盘三重全量序列化（路径缩短）
  return world;
}

/**
 * 角色重命名全局传播：保证改名后全书各处同步一致。
 */
function applyRename(w: WorldState, from: string, to: string): void {
  const rep = (s: string) => s.split(from).join(to);
  for (const c of w.characters) {
    const rel: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.relations ?? {})) {
      rel[k === from ? to : k] = v === from ? to : v;
    }
    c.relations = rel;
  }
  if (w.premise.includes(from)) w.premise = rep(w.premise);
  w.setting.rules = w.setting.rules.map((r) => (r.includes(from) ? rep(r) : r));
  if (w.setting.tone.includes(from)) w.setting.tone = rep(w.setting.tone);
  w.outline = w.outline.map((o) => (o.includes(from) ? rep(o) : o));
  w.lore = (w.lore ?? []).map((e) => ({
    ...e,
    keywords: e.keywords.map((k) => (k.includes(from) ? rep(k) : k)),
    content: e.content.includes(from) ? rep(e.content) : e.content,
  }));
  w.foreshadowing = w.foreshadowing.map((f) => ({
    ...f,
    text: f.text.includes(from) ? rep(f.text) : f.text,
    note: f.note && f.note.includes(from) ? rep(f.note) : f.note,
  }));
  w.plotThreads = (w.plotThreads ?? []).map((a) => ({
    ...a,
    name: a.name.includes(from) ? rep(a.name) : a.name,
    note: a.note.includes(from) ? rep(a.note) : a.note,
  }));
  w.timeline = w.timeline.map((t) => ({ ...t, summary: t.summary.includes(from) ? rep(t.summary) : t.summary }));
  // 本章计划与摘要同步（长篇架构新字段）
  w.chapterPlans = (w.chapterPlans ?? []).map((p) => ({
    ...p,
    goal: p.goal.includes(from) ? rep(p.goal) : p.goal,
    beats: p.beats.map((b) => (b.includes(from) ? rep(b) : b)),
  }));
  w.chapterSummaries = (w.chapterSummaries ?? []).map((s) => ({
    ...s,
    summary: s.summary.includes(from) ? rep(s.summary) : s.summary,
    events: s.events.map((e) => (e.includes(from) ? rep(e) : e)),
  }));
  for (const ch of w.chapters) {
    if (!ch.text.includes(from) && !ch.title.includes(from)) continue;
    snapshotVersion(ch, `角色重命名：${from}→${to}`);
    ch.text = rep(ch.text);
    ch.title = rep(ch.title);
  }
  recomputeAppearedIn(w); // 重命名后按新角色名重算登场记录
}

/** 版本内容与当前章节内容是否完全一致（标题/正文/审查）——快照去重与无意义回滚判定共用 */
function versionMatchesCurrent(ch: Chapter, v: ChapterVersion): boolean {
  return v.title === ch.title && v.text === ch.text && JSON.stringify(v.review ?? null) === JSON.stringify(ch.review ?? null);
}

/** 章节版本快照：变更前保存当前版本（上限 10）。
 * 内容与任一已有版本完全一致时不重复快照——避免来回回滚/自我回滚让版本表塞满重复项、挤掉真实历史。 */
function snapshotVersion(ch: Chapter, reason?: string): void {
  const versions = ch.versions ?? [];
  if (versions.some((v) => versionMatchesCurrent(ch, v))) return;
  versions.push({ title: ch.title, text: ch.text, review: ch.review, at: new Date().toISOString(), reason });
  ch.versions = versions.slice(-10);
}

/** 章节正文变更统一善后：媒体 anchor 失配检测 + 全书确定性审计（零 LLM，不阻塞主流程） */
function chapterChangeReport(world: WorldState, ch: Chapter): ConsistencyReport {
  markOrphanMedia(ch);
  const orphanMedia: ConsistencyReport["orphanMedia"] = [];
  for (const c of world.chapters) {
    for (const m of c.media ?? []) {
      if (m.orphan) orphanMedia.push({ chapterIndex: c.index, mediaId: m.id, kind: m.kind, anchor: m.anchor });
    }
  }
  return { autoFixed: [], findings: auditWorld(world), orphanMedia };
}

/** 手动编辑章节文本（段落级修正，自动留版本）+ 自动审查（不自动重写）+ 一致性善后（媒体失配/审计） */
export async function editChapter(world: WorldState, index: number, text: string): Promise<{ world: WorldState; review: ReviewResult | null; report: ConsistencyReport }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  if (!text.trim()) throw new Error("章节内容不能为空");
  snapshotVersion(ch, "手动编辑");
  ch.text = text;
  ch.review = null;
  ch.updatedAt = new Date().toISOString();
  recomputeAppearedIn(world); // 正文变更后同步出场角色
  markOrphanMedia(ch); // 媒体锚定失配检测（落盘前，orphan 标记随存档持久化）
  logChange(world, { chapter: index, actor: "user", kind: "chapter-edit", detail: `手动编辑第 ${index} 章《${ch.title}》正文（自动留版本快照）`, commandId: "CMD-N06" });
  saveWorld(world); // ① 编辑保底：编辑本身立即落盘，后续审查/记账失败不丢失
  // 人工编辑后自动审查，但不自动重写
  let review: ReviewResult | null = null;
  try {
    const v = await reviewChapter(world, ch.text, ch.title, index, null);
    review = toReviewResult(v);
    ch.review = review; // 不立即落盘，随记账后最终落盘（合并 saveWorld，路径缩短）
  } catch {
    /* 审查失败不阻塞保存 */
  }
  // 记账重算（编辑后账本跟随新正文：摘要/伏笔/角色状态/时间线；失败降级不阻塞保存）
  try {
    const settleReport = await settleChapter(world, ch, (world.chapterPlans ?? []).find((p) => p.index === index) ?? null);
    world.chapterDeltas = { ...(world.chapterDeltas ?? {}), [index]: settleReport.delta };
  } catch {
    // 记账失败不阻塞编辑保存：降级该章摘要为正文开头并清空出场名单，
    // 前端「脉络/人物」回退实时正文匹配，避免展示旧章节的梗概与角色——修「内容变更后脉络未更新」
    const s = (world.chapterSummaries ?? []).find((x) => x.index === index);
    if (s) {
      s.summary = `第${index}章《${ch.title}》：${ch.text.slice(0, 300)}`;
      s.events = [];
      s.stateChanges = [];
      s.appeared = [];
    }
  }
  saveWorld(world); // ② 最终落盘：审查结果 + 记账 delta（或降级摘要）一次写入
  return { world, review, report: chapterChangeReport(world, ch) };
}

/** 章节回滚到历史版本。
 * 注意：回滚还原章节文本/标题/审查；出场角色（appearedIn）会按回滚后的正文重算以跟随变化，离场（exit）记录不随回滚还原。
 * 时间线该章条目与章摘要标记为待重算（settleChapter 成功即覆盖；失败保留降级摘要，修 B4）。 */
export async function rollbackChapter(world: WorldState, index: number, versionIndex: number): Promise<{ world: WorldState; report: ConsistencyReport }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  const versions = ch.versions ?? [];
  const v = versions[versionIndex];
  if (!v) throw new Error(`版本不存在: ${versionIndex}`);
  // 目标版本与当前内容完全一致（标题/正文/审查）→ 拒绝无意义回滚，避免"自己回滚自己"产生重复快照
  if (versionMatchesCurrent(ch, v)) throw new Error("当前内容已与该版本一致，无需回滚");
  snapshotVersion(ch, `回滚到版本 ${versionIndex + 1}`);
  ch.title = v.title;
  ch.text = v.text;
  ch.review = v.review;
  ch.updatedAt = new Date().toISOString();
  recomputeAppearedIn(world); // 版本切换后出场角色跟随新正文
  // 摘要降级：标记为正文前 300 字并清空出场名单（待 settleChapter 覆盖；结算失败时兜底，
  // 名单清空使前端回退实时正文匹配，避免两栏沿用旧章节的角色名单——修「版本切换后脉络未更新」）
  const s = (world.chapterSummaries ?? []).find((x) => x.index === index);
  if (s) {
    s.summary = `第${index}章《${ch.title}》：${ch.text.slice(0, 300)}`;
    s.events = [];
    s.stateChanges = [];
    s.appeared = [];
  }
  // 记账重算（回滚后账本跟随新正文：摘要/伏笔/角色状态/时间线；失败降级不阻塞回滚）
  try {
    const settleReport = await settleChapter(world, ch, (world.chapterPlans ?? []).find((p) => p.index === index) ?? null);
    world.chapterDeltas = { ...(world.chapterDeltas ?? {}), [index]: settleReport.delta };
  } catch {
    /* 记账失败不阻塞回滚（降级摘要已在上面写入） */
  }
  const report = chapterChangeReport(world, ch);
  logChange(world, { chapter: index, actor: "user", kind: "chapter-rollback", detail: `回滚第 ${index} 章《${ch.title}》到版本 ${versionIndex + 1}（账本已重算）`, commandId: "CMD-N07" });
  saveWorld(world); // 单次最终落盘：文本/审查/摘要/delta/日志一次写入（路径缩短）
  return { world, report };
}

// —— 单章重生成（走 writeOneChapter 同款审查/修补循环） ——
export async function regenerateChapter(
  world: WorldState,
  index: number,
  instruction?: string,
  onEvent?: (e: StepEvent) => void,
): Promise<{ chapter: Chapter; review: ReviewResult; rounds: number; world: WorldState; report: ConsistencyReport }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);

  snapshotVersion(ch, "AI 重写");
  const baseInstruction =
    `重写第 ${index} 章《${ch.title}》：保持已有剧情方向与既定事实，` +
    (instruction ? `按此要求重写：${instruction}。` : "整体提升文笔、张力与细节。");

  // 打断检查（写作前）
  let it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }

  // 重写 = 在原位跑写作+审查+修补（不新增章节号）
  let rounds = 0;
  onEvent?.({ phase: "writing", round: ++rounds });
  const draft = await writeChapter({
    world,
    instruction: baseInstruction,
    chapterIndex: index,
    plan: (world.chapterPlans ?? []).find((p) => p.index === index) ?? null,
    onDelta: (delta) => onEvent?.({ phase: "delta", delta }),
  });
  let text = draft.text;
  // 健全闸门：writeChapter 内部已兜底，但「第N章」对重写是降级——既成短标题优先保留
  let title = isTitleLike(draft.title) ? draft.title : isTitleLike(ch.title) ? ch.title : `第${index}章`;

  // 打断检查（写作后 / 审查前）
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }

  onEvent?.({ phase: "reviewing", round: rounds });
  let verdict = await reviewChapter(world, text, title, index, null);
  verdict.round = rounds;

  if (verdict.action === "patch") {
    const pr = await patchChapter(world, { index, title, text, review: null }, verdict);
    if (pr.patched) {
      text = pr.text;
      verdict = await reviewChapter(world, text, title, index, null);
      verdict.round = rounds;
    }
  } else if (verdict.action === "rewrite") {
    rounds++;
    onEvent?.({ phase: "writing", round: rounds });
    const revisionNotes = verdict.findings.map((f) => `[${f.lens}/${f.severity}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`).join("\n");
    const redo = await writeChapter({ world, instruction: baseInstruction, revisionNotes, draft: text, chapterIndex: index, plan: null });
    text = redo.text;
    title = isTitleLike(redo.title) ? redo.title : title;
    verdict = await reviewChapter(world, text, title, index, null);
    verdict.round = rounds;
  }

  ch.title = title;
  ch.text = text;
  ch.review = toReviewResult(verdict);
  ch.updatedAt = new Date().toISOString();
  // 打断检查（审查后 / 结算前）：仍未 saveWorld，未落盘零污染
  it = checkInterrupt(world.title);
  if (it) {
    onEvent?.({ phase: "interrupted", item: it });
    throw new InterruptedError(it);
  }
  // 重算该章状态（记账覆盖式，修 B4 时间线失配）
  const settleReport = await settleChapter(world, ch, (world.chapterPlans ?? []).find((p) => p.index === index) ?? null);
  world.chapterDeltas = { ...(world.chapterDeltas ?? {}), [index]: settleReport.delta }; // 重写后覆盖该章变更快照
  registerDebt(world, index, verdict);
  onEvent?.({ phase: "saving" });
  recomputeAppearedIn(world);
  const report = chapterChangeReport(world, ch); // 重写后媒体 anchor 大概率失配：检测并标记
  logChange(world, { chapter: index, actor: "user", kind: "chapter-regenerate", detail: `AI 重写第 ${index} 章《${ch.title}》（第 ${rounds} 轮通过审查，账本已重算）`, commandId: "CMD-N05" });
  saveWorld(world);
  appendCheckpoint(world.title, "regenerate", index);
  return { chapter: ch, review: toReviewResult(verdict), rounds, world, report };
}

/**
 * 删除章节（允许空洞、绝不重排 index）：级联清理账本（integrity.deleteChapterCascade）+
 * 审计留痕；返回待锁外删盘的媒体路径与一致性报告（伏笔危险项等交前端呈现）。
 */
export function deleteChapter(world: WorldState, index: number): { world: WorldState; mediaPaths: string[]; versionFilePaths: string[]; report: ConsistencyReport } {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  const cascade = deleteChapterCascade(world, index);
  logChange(world, {
    chapter: index,
    actor: "user",
    kind: "chapter-delete",
    detail: `删除第 ${index} 章《${ch.title}》（随删 ${cascade.removedForeshadows} 条活跃伏笔、${cascade.mediaPaths.length} 个媒体文件、${cascade.versionFilePaths.length} 个版本快照）`,
    commandId: "CMD-N08",
  });
  appendCheckpoint(world.title, "delete", index);
  // 级联 findings + 残留审计（按稳定 id 去重）
  const seen = new Set<string>();
  const findings = [...cascade.findings, ...auditWorld(world)].filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  return { world, mediaPaths: cascade.mediaPaths, versionFilePaths: cascade.versionFilePaths, report: { autoFixed: [], findings, orphanMedia: [] } };
}

/** 手动触发审查（不重写，仅审查当前章节文本） */
export async function reReviewChapter(
  world: WorldState,
  index: number,
): Promise<{ chapter: Chapter; review: ReviewResult; world: WorldState }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  const v = await reviewChapter(world, ch.text, ch.title, index, null);
  const review = toReviewResult(v);
  ch.review = review;
  logChange(world, { chapter: index, actor: "user", kind: "chapter-rereview", detail: `单章重审第 ${index} 章《${ch.title}》：${v.action === "pass" ? "通过" : `需修改（${v.action}）`}`, commandId: "CMD-N09" });
  saveWorld(world);
  return { chapter: ch, review, world };
}

export { activeForeshadows, recomputeAppearedIn };
