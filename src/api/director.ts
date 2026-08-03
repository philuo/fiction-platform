// 导演编排：新故事初始化 + 回合循环（写 → 对抗审查 → 重写 → 更新状态 → 存档）
import { applyCards, autoPick, generateCardPool, type CardType } from "./cards";
import { reviewChapter } from "./critic";
import { chatJson } from "./jsonutil";
import * as anysearch from "./anysearch";
import { saveWorld } from "./storage";
import { activeForeshadows, emptyWorld, genOf, worldSummary, DEFAULT_GEN, type Card, type Character, type Chapter, type GenProfile, type ReviewResult, type WorldState } from "./world";
import { writeChapter, type WriterOutput } from "./writer";

export type StepPhase = "writing" | "reviewing" | "saving" | "done";
export type StepEvent =
  | { phase: "writing"; round: number }
  | { phase: "reviewing"; round: number }
  | { phase: "saving" }
  | { phase: "done"; result: StepResult };

export type StepResult = {
  chapter: Chapter;
  review: ReviewResult;
  rounds: number; // 写作轮数（1 = 一次通过）
  instructions: string[];
  appliedCards: Card[];
  world: WorldState;
};

const INIT_SYSTEM = `你是小说立项导演。根据用户的一句话灵感，生成世界设定与核心人物。
输出必须是合法 JSON（不要 markdown 围栏）：
{"title":"书名","genre":"题材","premise":"一句话梗概","setting":{"time":"时代","place":"主要地点","rules":["世界规则/约束 2-4条"],"tone":"文风基调"},"characters":[{"name":"名字","role":"主角/反派/配角","traits":["特质"],"motivation":"动机","secret":"秘密或没有","status":"初始状态","relations":{},"voice":"说话风格（如：简短冷峻，爱用反问句；或：温婉绵长，常用比喻）"}]}
要求：人物 2-4 个，性格鲜明有冲突；设定规则具体（能力体系/社会规则/禁忌）。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export async function newStory(idea: string, genre?: string): Promise<WorldState> {
  const out = await chatJson<{
    title?: string;
    genre?: string;
    premise?: string;
    setting?: { time?: string; place?: string; rules?: string[]; tone?: string };
    characters?: { name?: string; role?: string; traits?: string[]; motivation?: string; secret?: string; status?: string; relations?: Record<string, string>; voice?: string }[];
  }>(
    [
      { role: "system", content: INIT_SYSTEM },
      { role: "user", content: `灵感：${idea}${genre ? `\n题材方向：${genre}` : ""}` },
    ],
    { temperature: 0.9, maxTokens: 2048 },
  );

  const w = emptyWorld();
  w.title = String(out.title ?? "未命名").trim();
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
    role: String(c.role ?? "配角").trim(),
    traits: Array.isArray(c.traits) ? c.traits.map(String) : [],
    motivation: String(c.motivation ?? "").trim(),
    secret: c.secret ? String(c.secret).trim() : undefined,
    status: String(c.status ?? "登场").trim(),
    relations: c.relations ?? {},
    voice: c.voice ? String(c.voice).trim().slice(0, 80) : undefined,
    introducedAt: 0,
  }));
  saveWorld(w);
  return w;
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
    saveWorld(world);
  } catch {
    /* 考据失败不阻塞写作 */
  }
}

function applyWriterOutput(w: WorldState, out: WriterOutput, chapterIndex: number) {
  // 新伏笔（数量受 M1 参数 maxForeshadowPerChapter 控制，含章节覆盖）
  const fsLimit = Math.max(0, genOf(w, chapterIndex).maxForeshadowPerChapter);
  for (const f of out.new_foreshadowing.slice(0, fsLimit)) {
    if (!f.text?.trim()) continue;
    w.foreshadowing.push({
      id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
      text: String(f.text).trim(),
      plantedAt: chapterIndex,
      status: "planted",
      note: f.note,
    });
  }
  // 回收伏笔
  for (const r of out.resolved_foreshadowing) {
    const target = w.foreshadowing.find((f) => f.id === r.id || f.text.includes(r.id));
    if (target && target.status !== "resolved") {
      target.status = "resolved";
      target.resolvedAt = chapterIndex;
      target.note = `第${chapterIndex}章回收：${r.how ?? ""}`.trim();
    }
  }
  // 人物状态（精确匹配优先，避免子串误伤：如角色"阿青"与"青"）+ 登场记录
  for (const u of out.character_updates) {
    const c = u.name ? w.characters.find((x) => x.name === u.name) : undefined;
    if (!c) continue;
    if (u.status?.trim()) c.status = u.status.trim();
    // 角色-章节对应：在本章出现过的角色记录 appearedIn（禁止移除依据）
    if (!c.appearedIn?.includes(chapterIndex)) {
      c.appearedIn = [...(c.appearedIn ?? []), chapterIndex];
    }
  }
  // 角色离场/死亡记录（同样补录登场章节，保证「已登场禁止移除」保护对死亡角色生效）
  for (const ex of out.character_exits ?? []) {
    const c = ex?.name ? w.characters.find((x) => x.name === ex.name) : undefined;
    if (!c) continue;
    if (!c.appearedIn?.includes(chapterIndex)) {
      c.appearedIn = [...(c.appearedIn ?? []), chapterIndex];
    }
    if (!c.exit) c.exit = { chapter: chapterIndex, reason: String(ex.reason ?? "").trim().slice(0, 100) };
  }
  // 时间线
  if (out.timeline_summary?.trim()) {
    w.timeline.push({ chapter: chapterIndex, summary: out.timeline_summary.trim() });
  }
  // M4 弧线更新（合并同名弧线，上限 12 条）
  if (Array.isArray(out.arcs)) {
    const existing = w.arcs ?? [];
    for (const a of out.arcs) {
      if (!a?.name?.trim()) continue;
      const target = existing.find((x) => x.name === a.name);
      if (target) {
        target.status = a.status === "已解决" ? "已解决" : "进行中";
        if (a.note?.trim()) target.note = a.note.trim().slice(0, 120);
      } else {
        existing.push({
          id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
          name: a.name.trim().slice(0, 40),
          status: a.status === "已解决" ? "已解决" : "进行中",
          note: (a.note ?? "").trim().slice(0, 120),
        });
      }
    }
    w.arcs = existing.slice(0, 12);
  }
}

/** 重算全体角色的登场章节（appearedIn）：以「正文中是否出现角色名」为准，确定性且不依赖 LLM 输出。
 * 在保存章节/编辑/重写/回滚/重命名后调用，保证「出场角色」始终跟随正文变化。返回是否有变更（供按需存档）。 */
export function recomputeAppearedIn(w: WorldState): boolean {
  let changed = false;
  for (const c of w.characters) {
    const appears: number[] = [];
    if (c.name) {
      for (const ch of w.chapters) {
        if (ch.text.includes(c.name)) appears.push(ch.index);
      }
    }
    const next = appears.length ? appears : undefined;
    const prev = c.appearedIn;
    const same =
      (prev === undefined && next === undefined) ||
      (Array.isArray(prev) && next !== undefined && prev.length === next.length && prev.every((v, i) => v === next[i]));
    if (!same) {
      c.appearedIn = next;
      changed = true;
    }
  }
  return changed;
}

// —— 回合执行（修正版）：写作时保留 WriterOutput，审查后统一应用状态更新 ——
/**
 * 执行一个回合：写 → 对抗审查 →（不通过则带意见重写）→ 更新状态 → 存档。
 * 重写次数由审查严格度决定：宽松 1 次 / 标准 2 次 / 严格 3 次（总写作稿数 2/3/4）。
 * onEvent 用于 SSE 阶段推送。
 */
export async function step(world: WorldState, instruction: string, onEvent?: (e: StepEvent) => void): Promise<StepResult> {
  const strictness = genOf(world, world.nextChapter).reviewStrictness;
  // M1 审查严格度 → 重写次数（宽松 1 次 / 标准 2 次 / 严格 3 次）
  const maxWrites = strictness === "宽松" ? 2 : strictness === "严格" ? 4 : 3;
  let chapter: Chapter | null = null;
  let review: ReviewResult | null = null;
  let rounds = 0;
  let lastOut: WriterOutput | null = null;
  let appliedCards: Card[] = [];

  // M1 自动抽卡：每节推进前自动抽 1 张并应用
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

  // 历史真实模式：自动考据（AnySearch 查证设定 → 入世界书）
  await ensureResearch(world);

  for (let attempt = 0; attempt < maxWrites; attempt++) {
    rounds++;
    onEvent?.({ phase: "writing", round: rounds });
    const revisionNotes =
      review && review.verdict === "revise"
        ? review.findings.map((f) => `[${f.lens}/${f.severity}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`).join("\n")
        : undefined;

    const out = await writeChapter(world, instruction, revisionNotes, world.nextChapter);
    lastOut = out;
    chapter = { index: world.nextChapter, title: out.title || `第${world.nextChapter}节`, text: out.text, review: null };

    onEvent?.({ phase: "reviewing", round: rounds });
    review = await reviewChapter(world, chapter.text, chapter.title, world.nextChapter);
    review.round = rounds;
    if (review.verdict === "pass") break;
  }

  chapter!.review = review!;
  world.chapters.push(chapter!);
  if (lastOut) applyWriterOutput(world, lastOut, chapter!.index);
  recomputeAppearedIn(world); // 出场角色以正文为准（不依赖 LLM 的 character_updates）
  world.nextChapter++;
  onEvent?.({ phase: "saving" });
  saveWorld(world);
  const result: StepResult = {
    chapter: chapter!,
    review: review!,
    rounds,
    instructions: [],
    appliedCards,
    world,
  };
  onEvent?.({ phase: "done", result });
  return result;
}

/** 抽卡·生成卡池（仅生成，不应用）：存入 world.pendingCards 供后续 apply 使用 */
export async function gachaGenerate(
  world: WorldState,
  opts: { count?: number; types?: CardType[] },
): Promise<{ pool: Card[] }> {
  const pool = await generateCardPool(world, { count: opts.count ?? 4, types: opts.types });
  world.pendingCards = pool;
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
  saveWorld(world);
  return { instructions, applied };
}

// —— 大纲生成：基于世界状态 + 活跃伏笔 + 用户意图，产出后续 3-6 个情节要点 ——
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
    `\n当前已写到第 ${world.chapters.length} 节。`,
    userHint ? `\n[你的意图] ${userHint.slice(0, 500)}` : "", // 长度 clamp（安全 LOW）
    "\n请输出接下来 3-6 个情节要点（只输出 JSON）。",
  ].join("\n");
  const out = await chatJson<{ outline?: string[] }>(
    [
      { role: "system", content: OUTLINE_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.8, maxTokens: 1024 },
  );
  const list = (Array.isArray(out.outline) ? out.outline : []).map(String).filter((s) => s.trim()).slice(0, 6);
  world.outline = list;
  saveWorld(world);
  return list;
}

/** 手动编辑世界：设定/梗概/角色/大纲/生成参数/章节覆盖（浅合并 + 类型守卫） */
export function editWorld(world: WorldState, patch: {
  premise?: string;
  setting?: Partial<WorldState["setting"]>;
  characters?: Partial<Character>[];
  outline?: string[];
  gen?: Partial<GenProfile>;
  chapterGen?: Record<number, Partial<GenProfile>>;
  removeCharacterIds?: string[]; // 角色移除（已登场角色禁止移除）
}): WorldState {
  if (typeof patch.premise === "string" && patch.premise.trim()) world.premise = patch.premise.trim();
  if (patch.setting) {
    if (typeof patch.setting.time === "string") world.setting.time = patch.setting.time;
    if (typeof patch.setting.place === "string") world.setting.place = patch.setting.place;
    if (typeof patch.setting.tone === "string") world.setting.tone = patch.setting.tone;
    if (Array.isArray(patch.setting.rules)) world.setting.rules = patch.setting.rules.map(String).filter((s) => s.trim());
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
      if (!target) continue;
      if (typeof pc.name === "string" && pc.name.trim()) {
        const newName = pc.name.trim();
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
        throw new Error(`角色「${c.name}」已在第 ${c.appearedIn.join("、")} 节登场，禁止移除`);
      }
    }
    world.characters = world.characters.filter((x) => !ids.includes(x.id));
  }
  saveWorld(world);
  return world;
}

/**
 * 角色重命名全局传播：保证改名后全书各处同步一致。
 * 1) 所有角色关系表键（兼容旧格式 value 为目标名）；
 * 2) 梗概/规则/大纲/世界书/伏笔/弧线/时间线 等 guiding AI 的元数据；
 * 3) 已发布章节标题与正文（自动存版本快照，可回滚；审查记录保留，引用可能随改写失效）。
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
  w.arcs = (w.arcs ?? []).map((a) => ({
    ...a,
    name: a.name.includes(from) ? rep(a.name) : a.name,
    note: a.note.includes(from) ? rep(a.note) : a.note,
  }));
  w.timeline = w.timeline.map((t) => ({ ...t, summary: t.summary.includes(from) ? rep(t.summary) : t.summary }));
  for (const ch of w.chapters) {
    if (!ch.text.includes(from) && !ch.title.includes(from)) continue;
    snapshotVersion(ch, `角色重命名：${from}→${to}`);
    ch.text = rep(ch.text);
    ch.title = rep(ch.title);
  }
  recomputeAppearedIn(w); // 重命名后按新角色名重算登场记录
}

/** 章节版本快照：变更前保存当前版本（上限 10） */
function snapshotVersion(ch: Chapter, reason?: string): void {
  const versions = ch.versions ?? [];
  versions.push({ title: ch.title, text: ch.text, review: ch.review, at: new Date().toISOString(), reason });
  ch.versions = versions.slice(-10);
}

/** 手动编辑章节文本（段落级修正，自动留版本）+ 自动审查（不自动重写） */
export async function editChapter(world: WorldState, index: number, text: string): Promise<{ world: WorldState; review: ReviewResult | null }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  if (!text.trim()) throw new Error("章节内容不能为空");
  snapshotVersion(ch, "手动编辑");
  ch.text = text;
  ch.review = null;
  recomputeAppearedIn(world); // 正文变更后同步出场角色
  saveWorld(world);
  // 人工编辑后自动审查，但不自动重写
  let review: ReviewResult | null = null;
  try {
    review = await reviewChapter(world, ch.text, ch.title, index);
    ch.review = review;
    saveWorld(world);
  } catch {
    /* 审查失败不阻塞保存 */
  }
  return { world, review };
}

/** 章节回滚到历史版本。
 * 注意：回滚还原章节文本/标题/审查；出场角色（appearedIn）会按回滚后的正文重算以跟随变化，离场（exit）记录与时间线不随回滚还原。 */
export function rollbackChapter(world: WorldState, index: number, versionIndex: number): WorldState {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  const versions = ch.versions ?? [];
  const v = versions[versionIndex];
  if (!v) throw new Error(`版本不存在: ${versionIndex}`);
  snapshotVersion(ch, `回滚到版本 ${versionIndex + 1}`);
  ch.title = v.title;
  ch.text = v.text;
  ch.review = v.review;
  recomputeAppearedIn(world); // 版本切换后出场角色跟随新正文
  saveWorld(world);
  return world;
}

// —— M6 单章重生成（AI 重写 + 自动审查 + 自动重写循环，最多 4 稿） ——
export async function regenerateChapter(
  world: WorldState,
  index: number,
  instruction?: string,
  onEvent?: (e: StepEvent) => void,
): Promise<{ chapter: Chapter; review: ReviewResult; rounds: number; world: WorldState }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);

  const maxRewrites = 3; // 最多连续自动重写 3 次（初稿 + 3 次 = 4 稿）
  let review: ReviewResult | null = null;
  let rounds = 0;

  for (let attempt = 0; attempt <= maxRewrites; attempt++) {
    rounds++;
    onEvent?.({ phase: "writing", round: rounds });
    const revisionNotes =
      review && review.verdict === "revise"
        ? review.findings.map((f) => `[${f.lens}/${f.severity}] ${f.issue}（原文：${f.evidence}）建议：${f.suggestion}`).join("\n")
        : undefined;

    const out = await writeChapter(
      world,
      attempt === 0
        ? `重写第 ${index} 节《${ch.title}》：保持已有剧情方向与既定事实，` +
          (instruction ? `按此要求重写：${instruction}。` : "整体提升文笔、张力与细节。")
        : `根据审查意见修正第 ${index} 节《${ch.title}》。`,
      revisionNotes,
      index,
    );

    if (attempt === 0) snapshotVersion(ch, "AI 重写");
    ch.title = out.title || ch.title;
    ch.text = out.text;

    onEvent?.({ phase: "reviewing", round: rounds });
    review = await reviewChapter(world, ch.text, ch.title, index);
    review.round = rounds;
    ch.review = review;
    saveWorld(world);

    if (review.verdict === "pass") break;
    // 达到上限后停止重写，保留最后一稿
    if (attempt >= maxRewrites) break;
  }

  onEvent?.({ phase: "saving" });
  recomputeAppearedIn(world); // 重写后出场角色跟随新正文
  saveWorld(world);
  return { chapter: ch, review: review!, rounds, world };
}

/** 手动触发审查（不重写，仅审查当前章节文本） */
export async function reReviewChapter(
  world: WorldState,
  index: number,
): Promise<{ chapter: Chapter; review: ReviewResult; world: WorldState }> {
  const ch = world.chapters.find((c) => c.index === index);
  if (!ch) throw new Error(`章节不存在: ${index}`);
  const review = await reviewChapter(world, ch.text, ch.title, index);
  ch.review = review;
  saveWorld(world);
  return { chapter: ch, review, world };
}

export { activeForeshadows };
