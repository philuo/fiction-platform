// 记账者（Chronicler）P2 新增（修 E1-E4、B4、F2）：
// 章节定稿后独立 LLM 调用，从正文提取 7 类状态 delta（Observer 式过度提取）+ 章摘要，
// 字段级类型守卫逐项丢弃坏数据（Reflector 式，不抛错）；写作不再夹带状态 JSON。
import { chatJson } from "./jsonutil";
import { activeForeshadows, genOf, type Chapter, type ChapterDelta, type ChapterPlan, type ChapterSummary, type CharacterFieldDelta, type WorldState } from "./world";
import { upsertSummary } from "./memory";
import { logChange } from "./steering";
import { appearedInChapter, normCharName } from "../shared/appearance";
import { findRelationshipTarget } from "../shared/relationships";

export type SettleOutput = {
  summary: string;
  events: string[];
  appeared: string[];
  stateChanges: string[];
  hook: string;
  new_foreshadowing: { text: string; note?: string; dueHint?: string }[];
  resolved_foreshadowing: { id: string; how: string }[];
  character_updates: { name: string; status: string; look?: string }[];
  character_relations: { name: string; relations: Record<string, string> }[];
  character_exits: { name: string; reason: string }[];
  timeline_summary: string;
  world_current: string;
  plot_threads: { id: string; status: string; note: string }[];
  new_characters: { name: string; role: string; gender?: string; age?: string; identity?: string; traits: string[]; motivation: string; voice?: string; reason?: string }[];
  setting_rules: string[];
};

export type SettleReport = {
  summary: ChapterSummary;
  newForeshadows: number;
  resolvedForeshadows: number;
  characterUpdates: number;
  relationUpdates: number; // 本章增量更新的角色关系对数
  addedSettingRules: number; // 本章新增设定规则数
  newProposals: number;
  droppedFields: number; // 类型守卫丢弃的坏数据计数（调试可见）
  /** 本章结算变更快照（含旧值）：由调用方落盘到 world.chapterDeltas，删除章节时逆操作恢复 */
  delta: ChapterDelta;
};

const SETTLE_SYSTEM = `你是小说的"记账者"（Chronicler）。给定一章定稿正文与现有世界状态，提取本章的事实档案与状态变化。只提取正文中真实发生的内容，不得臆测。
输出必须是合法 JSON（不要 markdown 围栏）：
{"summary":"150-300字剧情摘要","events":["关键事件"],"appeared":["本章被提及或出场的角色名"],"stateChanges":["角色/世界状态变化"],"hook":"章末钩子一句话（无则空串）",
"new_foreshadowing":[{"text":"新埋伏笔","note":"如何呼应","dueHint":"建议回收时机"}],
"resolved_foreshadowing":[{"id":"伏笔ID","how":"如何回收"}],
"character_updates":[{"name":"角色名","status":"最新状态","look":"当前形象（容貌/装扮/伤情变化，无变化则不填）"}],
"character_relations":[{"name":"角色名","relations":{"对方角色名":"关系描述（如：生死之交/互为仇敌/师徒/夫妻）"}}],
"character_exits":[{"name":"角色名","reason":"离场/死亡方式"}],
"timeline_summary":"本章事件一句话",
"world_current":"本章结束后的全局状态一句话（季节/天气/昼夜/局势/关键人物处境，覆盖全书当前动态）",
"plot_threads":[{"id":"弧线ID","status":"进行中或已解决","note":"本章进展"}],
"new_characters":[{"name":"名字","role":"定位","gender":"男或女","age":"年龄（如二十出头）","identity":"社会身份/职业","traits":["特质"],"motivation":"动机","voice":"说话风格（可空）","reason":"一句话推荐原因（为什么建议让该角色登场，如：与主角身份成反差，推动悬疑线）"}],
"setting_rules":["正文明确体现的世界规则/约束/禁忌，无则留空数组"]}
规则：
- resolved_foreshadowing 的 id 必须严格引用[伏笔账本]中方括号内的 ID；plot_threads 的 id 必须引用[弧线列表]中的 ID，不得自造
- new_foreshadowing 只登记正文确实埋下的悬念；new_characters 只登记正文确实登场（有台词或行动）的新角色，gender/age/identity 必须给出，reason 给出一句话推荐原因（为什么值得让该角色登场，可空）
- character_relations 只登记正文明确展现的关系（互动/称呼/立场），仅记录本章出现或变化的关系；relations 的键必须且只能是与现有角色名完全一致的名字（如"林墨"），严禁写成"与林墨""同林墨""和林墨"等带介词前缀的形式
- setting_rules 只提取正文明确确立的新规则/禁忌/限制（如"入梦需在月圆之夜"），每条一句话，≤3 条
- look 只记正文中明确的容貌/装扮/伤情变化（如受伤、换装、易容），无变化不填；world_current 必须给出一句话
- appeared 中的名字必须与现有角色名完全一致；新角色除外。appeared 指本章正文中被提及或出场的所有角色（有台词/行动/被旁白或他人提及/回忆均算），名单宁全勿漏
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

// —— 类型守卫工具 ——
const strArr = (v: unknown, cap = 12): string[] =>
  Array.isArray(v) ? v.map(String).filter((s) => s.trim()).slice(0, cap) : [];

/** 角色名别名归一（修 E3）：去「阿/小/老」前缀与空白，便于宽松匹配 —— 实现见 shared/appearance.ts（与出场角色判定同源） */
export { normCharName };

function findCharacter(w: WorldState, rawName: string) {
  const name = String(rawName ?? "").trim();
  if (!name) return undefined;
  return (
    w.characters.find((c) => c.name === name) ??
    w.characters.find((c) => normCharName(c.name) === normCharName(name))
  );
}

function isLocked(w: WorldState, characterId: string, field: string): boolean {
  return (w.lockedFields ?? []).some((l) => l.characterId === characterId && l.field === field);
}

/** 重算全体角色登场章节（appearedIn）：与「本章出场角色」同源双轨判定（LLM 记账名单优先，名单空回退正文匹配+别名归一）
 * —— 修「角色卡登场章节与出场角色统计不一致」：正文只写代词/称呼（名单判定出场）或别名（小飞侠→飞侠）时不再漏章 */
export function recomputeAppearedIn(w: WorldState): boolean {
  let changed = false;
  for (const c of w.characters) {
    const appears: number[] = [];
    if (c.name) {
      for (const ch of w.chapters) {
        if (appearedInChapter(w, c, ch.index)) appears.push(ch.index);
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

/** 把记账输出应用到世界状态（全部经类型守卫；坏字段丢弃计数不抛错）
 * 同时收集本章变更快照（ChapterDelta，含旧值）：删除章节时按此逆操作恢复账本 */
function applySettle(w: WorldState, out: Partial<SettleOutput>, chapterIndex: number): SettleReport {
  let dropped = 0;
  const g = genOf(w, chapterIndex);
  // 本章变更快照收集（git 式，含旧值）
  const delta: ChapterDelta = {
    chapter: chapterIndex,
    at: new Date().toISOString(),
    plantedForeshadowIds: [],
    resolvedForeshadows: [],
    characterUpdates: [],
    exitIds: [],
    plotThreadUpdates: [],
    relationUpdates: [],
    addedSettingRules: [],
    proposalIds: [],
  };

  // 新伏笔（数量受参数控制；文本去重：未回收的相同伏笔不重复埋设，防反复结算/重算重复入账）
  const fsLimit = Math.max(0, g.maxForeshadowPerChapter);
  const newFs = Array.isArray(out.new_foreshadowing) ? out.new_foreshadowing : [];
  const fsKey = (t: string) => t.replace(/\s+/g, "");
  const existingFs = new Set(w.foreshadowing.filter((f) => f.status !== "resolved").map((f) => fsKey(f.text)));
  let added = 0;
  for (const f of newFs.slice(0, fsLimit)) {
    if (!f || typeof f.text !== "string" || !f.text.trim()) { dropped++; continue; }
    const key = fsKey(f.text.trim());
    if (existingFs.has(key)) { dropped++; continue; } // 已存在未回收的相同伏笔（重复提取/重复结算）
    existingFs.add(key);
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    w.foreshadowing.push({
      id,
      text: String(f.text).trim(),
      plantedAt: chapterIndex,
      status: "planted",
      note: typeof f.note === "string" ? f.note.trim() || undefined : undefined,
      dueHint: typeof f.dueHint === "string" ? f.dueHint.trim() || undefined : undefined,
    });
    delta.plantedForeshadowIds.push(id);
    added++;
  }

  // 回收伏笔：仅按 ID 精确匹配（修 E2，废除 text.includes）
  let resolved = 0;
  for (const r of Array.isArray(out.resolved_foreshadowing) ? out.resolved_foreshadowing : []) {
    const id = String(r?.id ?? "").trim();
    const how = String(r?.how ?? "").trim();
    if (!id) { dropped++; continue; }
    const target = w.foreshadowing.find((f) => f.id === id);
    if (target && target.status !== "resolved") {
      delta.resolvedForeshadows.push({ id, prevStatus: target.status, prevResolvedAt: target.resolvedAt, prevNote: target.note });
      target.status = "resolved";
      target.resolvedAt = chapterIndex;
      target.note = `第${chapterIndex}章回收：${how}`.trim();
      resolved++;
    }
  }

  // 角色状态（别名归一，修 E3；锁定字段跳过，用户决策④）
  let updates = 0;
  const charUpdates: CharacterFieldDelta[] = [];
  for (const u of Array.isArray(out.character_updates) ? out.character_updates : []) {
    const c = findCharacter(w, u?.name ?? "");
    if (!c) { dropped++; continue; }
    let changed = false;
    const rec: CharacterFieldDelta = { id: c.id, name: c.name };
    const status = String(u?.status ?? "").trim();
    if (status && status !== c.status && !isLocked(w, c.id, "status")) {
      rec.status = { old: c.status, neu: status };
      c.status = status;
      updates++;
      changed = true;
    }
    const look = String(u?.look ?? "").trim();
    if (look && look !== (c.look ?? "") && !isLocked(w, c.id, "look")) {
      rec.look = { old: c.look, neu: look.slice(0, 120) };
      c.look = look.slice(0, 120);
      updates++;
      changed = true;
    }
    if (changed) charUpdates.push(rec);
  }
  delta.characterUpdates = charUpdates;
  // 角色关系（增量合并：只写 LLM 明确提到的对向，手动编辑的未提及关系保留；含旧值快照）
  // 目标键归一（修「与伊芙琳」脏键）：把 LLM 自由格式的键解析为真实角色名，解析不到丢弃——否则关系图匹配不到连线
  let relUpdates = 0;
  const relationUpdates: ChapterDelta["relationUpdates"] = [];
  for (const rr of Array.isArray(out.character_relations) ? out.character_relations : []) {
    const c = findCharacter(w, rr?.name ?? "");
    if (!c) { dropped++; continue; }
    const rels = (rr?.relations ?? {}) as Record<string, unknown>;
    for (const [target, val] of Object.entries(rels)) {
      const desc = String(val ?? "").trim().slice(0, 40);
      if (!desc) continue;
      const ref = findRelationshipTarget(w.characters, target);
      if (!ref || ref.id === c.id) { dropped++; continue; }
      const key = ref.name; // 统一用真实角色名作键
      const old = c.relations?.[key];
      if (old === desc) continue;
      relationUpdates.push({ id: c.id, name: c.name, target: key, old, neu: desc });
      c.relations = { ...(c.relations ?? {}), [key]: desc };
      relUpdates++;
    }
  }
  delta.relationUpdates = relationUpdates;
  // 新设定规则（正文体现的世界规则：去重追加，总量上限 12 条、单章 ≤3）
  let addedRules = 0;
  const addedSettingRules: string[] = [];
  const rules = w.setting?.rules ?? [];
  const ruleSet = new Set(rules.map((r) => String(r).trim()));
  for (const r of Array.isArray(out.setting_rules) ? out.setting_rules : []) {
    if (addedRules >= 3 || rules.length + addedRules >= 12) { dropped++; continue; }
    const txt = String(r ?? "").trim().slice(0, 80);
    if (!txt || ruleSet.has(txt)) continue;
    ruleSet.add(txt);
    addedSettingRules.push(txt);
    addedRules++;
  }
  if (addedRules) w.setting.rules = [...rules, ...addedSettingRules];
  delta.addedSettingRules = addedSettingRules;
  // 离场/死亡
  for (const ex of Array.isArray(out.character_exits) ? out.character_exits : []) {
    const c = findCharacter(w, ex?.name ?? "");
    if (!c) { dropped++; continue; }
    if (!c.exit) {
      c.exit = { chapter: chapterIndex, reason: String(ex?.reason ?? "").trim().slice(0, 100) };
      delta.exitIds.push(c.id);
    }
  }

  // 时间线：覆盖式写入本章条目（修 B4：重写/回滚后重算不失配）；仅接受 string（number/对象等脏数据丢弃）
  const tl = typeof out.timeline_summary === "string" ? out.timeline_summary.trim() : "";
  if (tl) {
    w.timeline = w.timeline.filter((t) => t.chapter !== chapterIndex);
    w.timeline.push({ chapter: chapterIndex, summary: tl });
    w.timeline.sort((a, b) => a.chapter - b.chapter);
  }

  // 全局当前状态：滚动更新（跨章连续）
  const wc = String(out.world_current ?? "").trim();
  if (wc && wc !== w.current) {
    delta.worldCurrent = { old: w.current, neu: wc.slice(0, 200) };
    w.current = wc.slice(0, 200);
  }

  // 弧线（plotThreads）：仅按稳定 id 更新 status/note，不自造（修 E4）
  for (const t of Array.isArray(out.plot_threads) ? out.plot_threads : []) {
    const id = String(t?.id ?? "").trim();
    const target = (w.plotThreads ?? []).find((x) => x.id === id);
    if (!target) continue; // LLM 自造 id 丢弃
    const newStatus = t?.status === "已解决" ? "已解决" : "进行中";
    const newNote = String(t?.note ?? "").trim().slice(0, 120);
    if (target.status !== newStatus || (newNote && target.note !== newNote)) {
      delta.plotThreadUpdates.push({ id, oldStatus: target.status, newStatus, oldNote: target.note ?? "", newNote });
      target.status = newStatus;
      if (newNote) target.note = newNote;
    }
  }

  // 新角色 → 提案区（pending），不直接入册（修 F2）
  let proposals = 0;
  for (const nc of Array.isArray(out.new_characters) ? out.new_characters : []) {
    const name = String(nc?.name ?? "").trim();
    if (!name || w.characters.some((c) => c.name === name)) continue;
    const pend = w.characterProposals ?? [];
    if (pend.some((p) => p.name === name && p.status === "pending")) continue;
    const id = `cp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
    pend.push({
      id,
      name,
      role: String(nc?.role ?? "配角").trim().slice(0, 20),
      gender: typeof nc?.gender === "string" ? nc.gender.trim().slice(0, 8) || undefined : undefined,
      age: typeof nc?.age === "string" ? nc.age.trim().slice(0, 20) || undefined : undefined,
      identity: typeof nc?.identity === "string" ? nc.identity.trim().slice(0, 30) || undefined : undefined,
      traits: strArr(nc?.traits, 6),
      motivation: String(nc?.motivation ?? "").trim().slice(0, 120),
      voice: typeof nc?.voice === "string" ? nc.voice.trim().slice(0, 80) || undefined : undefined,
      reason: typeof nc?.reason === "string" ? nc.reason.trim().slice(0, 80) || undefined : undefined,
      source: "writer",
      status: "pending",
    });
    delta.proposalIds.push(id);
    w.characterProposals = pend;
    proposals++;
  }

  // 章摘要回写（L2 记忆）
  const summary: ChapterSummary = {
    index: chapterIndex,
    // 仅接受 string；number/对象等脏数据丢弃回退章号（summary: 12345 不得写入 "12345"）
    summary: typeof out.summary === "string" && out.summary.trim() ? out.summary.trim() : `第${chapterIndex}章`,
    events: strArr(out.events),
    appeared: strArr(out.appeared),
    stateChanges: strArr(out.stateChanges),
    hook: typeof out.hook === "string" && out.hook.trim() ? out.hook.trim() : undefined,
  };
  upsertSummary(w, summary);

  recomputeAppearedIn(w);

  logChange(w, { chapter: chapterIndex, actor: "ai", kind: "ledger-apply", detail: `应用第${chapterIndex}章账本 delta（新伏笔 ${added}/回收 ${resolved}/角色 ${updates}/关系 ${relUpdates}/规则 ${addedRules}）`, commandId: "CMD-L02" });
  return {
    summary,
    newForeshadows: added,
    resolvedForeshadows: resolved,
    characterUpdates: updates,
    relationUpdates: relUpdates,
    addedSettingRules: addedRules,
    newProposals: proposals,
    droppedFields: dropped,
    delta,
  };
}

/** 章节定稿结算：1 次 LLM 调用（摘要+记账合并，省额度）→ 应用到世界状态 */
export async function settleChapter(w: WorldState, ch: Chapter, plan?: ChapterPlan | null): Promise<SettleReport> {
  const active = activeForeshadows(w);
  const threads = (w.plotThreads ?? []).filter((a) => a.status !== "已解决");
  const userMsg = [
    `[角色名册] ${w.characters.map((c) => c.name).join("、") || "（空）"}`,
    `[伏笔账本] ${active.length ? active.map((f) => `[${f.id}] ${f.text}（埋于第${f.plantedAt}章）`).join("\n") : "（无活跃伏笔）"}`,
    `[弧线列表] ${threads.length ? threads.map((a) => `[${a.id}] ${a.name}：${a.note}`).join("\n") : "（无进行中弧线）"}`,
    plan ? `[本章任务] ${plan.goal}｜节拍：${plan.beats.join("；")}` : "",
    `\n第${ch.index}章《${ch.title}》定稿正文：\n${ch.text}`,
    "\n请输出本章结算档案（只输出 JSON）。",
  ].filter(Boolean).join("\n");

  let out: Partial<SettleOutput> = {};
  try {
    out = await chatJson<Partial<SettleOutput>>(
      [
        { role: "system", content: SETTLE_SYSTEM },
        { role: "user", content: userMsg },
      ],
      {
        temperature: 0.2,
        maxTokens: 60000,
        // jsonschema：关键字段类型约束（summary 必须 string、各数组项结构），字段级守卫兜底丢弃
        schema: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
            events: { type: "array", items: { type: "string" } },
            appeared: { type: "array", items: { type: "string" } },
            stateChanges: { type: "array", items: { type: "string" } },
            hook: { type: "string" },
            new_foreshadowing: { type: "array", items: { type: "object", required: ["text"], properties: { text: { type: "string" }, note: { type: "string" }, dueHint: { type: "string" } } } },
            resolved_foreshadowing: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" }, how: { type: "string" } } } },
            character_updates: { type: "array", items: { type: "object", required: ["name", "status"], properties: { name: { type: "string" }, status: { type: "string" }, look: { type: "string" } } } },
            character_exits: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, reason: { type: "string" } } } },
            timeline_summary: { type: "string" },
            world_current: { type: "string" },
            new_characters: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, role: { type: "string" }, gender: { type: "string" }, age: { type: "string" }, identity: { type: "string" }, traits: { type: "array", items: { type: "string" } }, motivation: { type: "string" }, reason: { type: "string" } } } },
            plot_threads: { type: "array", items: { type: "object", required: ["id", "status"], properties: { id: { type: "string" }, status: { type: "string" }, note: { type: "string" } } } },
            setting_rules: { type: "array", items: { type: "string" } },
          },
        },
      },
    );
  } catch {
    /* 记账失败不阻塞：降级为纯文本摘要，状态不更新 */
    out = { summary: `第${ch.index}章《${ch.title}》：${ch.text.slice(0, 300)}`, timeline_summary: ch.title };
  }
  const report = applySettle(w, out, ch.index);
  logChange(w, { chapter: ch.index, actor: "ai", kind: "ledger-settle", detail: `第${ch.index}章记账结算（新伏笔 ${report.newForeshadows}/回收 ${report.resolvedForeshadows}/角色 ${report.characterUpdates}/丢弃 ${report.droppedFields}）`, commandId: "CMD-L01" });
  return report;
}

/**
 * 撤销本章记账（重结算前置，防伏笔重复埋设——applySettle 新伏笔是 push 无去重）：
 * 删本章埋设的伏笔；本章回收的伏笔回退为 planted；清本章时间线条目与本章离场记录。
 * 摘要不动（settleChapter 的 upsertSummary 会覆盖）。幂等。
 */
export function resetChapterLedger(w: WorldState, chapterIndex: number): void {
  // 本章埋设的伏笔直接移除（未回收）；本章回收的回退为 planted（不复活已删除的）
  w.foreshadowing = w.foreshadowing
    .filter((f) => !(f.plantedAt === chapterIndex && f.status !== "resolved"))
    .map((f) => {
      if (f.resolvedAt !== chapterIndex) return f;
      return { ...f, status: "planted" as const, resolvedAt: undefined, note: undefined };
    });
  // 本章时间线条目（settleChapter 覆盖式写入，重算前清空避免残留）
  w.timeline = w.timeline.filter((t) => t.chapter !== chapterIndex);
  // 本章离场记录（重算时若正文仍有离场会重新登记）
  for (const c of w.characters) {
    if (c.exit?.chapter === chapterIndex) delete c.exit;
  }
  logChange(w, { chapter: chapterIndex, actor: "ai", kind: "ledger-reset", detail: `撤销第${chapterIndex}章记账（伏笔/时间线/离场清理）`, commandId: "CMD-L05" });
}
