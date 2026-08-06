// 干预治理中枢（P3.5，修 F4-F6）：变更分级 L0-L3 + 影响评估 + 三选一策略 + 打断 + 日志
// 用户决策：L2 每次弹影响报告三选一；写作中干预立即打断；字段锁（status 手改即锁）
import { chatJson } from "./jsonutil";
import { saveWorld } from "./storage";
import { getCommand } from "./harness";
import type { ChangeLogEntry, SteeringItem, WorldState } from "./world";

// —— 立即打断（用户决策②）：内存态信号，writeOneChapter 每阶段边界轮询 ——
const interrupts = new Map<string, SteeringItem>();

/** 请求打断指定故事的当前写作（写作中提交干预时调用） */
export function requestInterrupt(title: string, item: Omit<SteeringItem, "id" | "at">): SteeringItem {
  const full: SteeringItem = {
    id: `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    ...item,
  };
  interrupts.set(title, full);
  return full;
}

/** 管线阶段边界检查：命中则取出（消费）并返回 */
export function checkInterrupt(title: string): SteeringItem | null {
  const item = interrupts.get(title);
  if (item) interrupts.delete(title);
  return item ?? null;
}

/** 打断后未消费的项可由调用方重新入队（如 commit 后阶段命中 → 章末消费） */
export function requeueInterrupt(title: string, item: SteeringItem): void {
  interrupts.set(title, item);
}

// —— 变更日志（审计：谁、第几章、改了什么、选了哪种传播策略） ——
export function logChange(w: WorldState, entry: Omit<ChangeLogEntry, "at">): void {
  const list = w.changeLog ?? [];
  list.push({ at: new Date().toISOString(), ...entry });
  // 上限 500 条，防无限增长
  w.changeLog = list.slice(-500);
}

/** 带 HARNESS 指令元数据的日志（中枢架构：所有写操作落 commandId/level，实现「所有操作可追溯」） */
export function logCommandChange(
  w: WorldState,
  entry: Omit<ChangeLogEntry, "at" | "commandId" | "level"> & { commandId?: string; level?: ChangeLogEntry["level"] },
): void {
  const cmd = entry.commandId ? getCommand(entry.commandId) : undefined;
  logChange(w, {
    ...entry,
    commandId: entry.commandId ?? cmd?.id,
    level: entry.level ?? cmd?.level,
  });
}

// —— 变更分级（决定是否需要影响评估） ——
export type ChangeLevel = "L0" | "L1" | "L2" | "L3";

/** 已编辑的角色/伏笔是否构成 L2（回溯相关）：已登场角色字段改 / 已埋伏笔改 / 设定规则改 */
export function isRetroactivePatch(w: WorldState, patch: {
  characters?: { id?: string }[];
  setting?: { rules?: string[] };
}): boolean {
  // 已登场角色（appearedIn 非空）的任何字段修改 → L2
  if (Array.isArray(patch.characters)) {
    for (const pc of patch.characters) {
      const target = pc?.id ? w.characters.find((c) => c.id === pc.id) : undefined;
      if (target?.appearedIn?.length) return true;
    }
  }
  // 世界观规则改写（已确立的设定）→ 有章节后才算回溯
  if (patch.setting?.rules && w.chapters.length > 0) return true;
  return false;
}

export function classifyWorldPatch(w: WorldState, patch: { characters?: { id?: string }[]; setting?: { rules?: string[] } }): ChangeLevel {
  return isRetroactivePatch(w, patch) ? "L2" : "L0";
}

// —— 字段锁（用户决策④：角色 status 手改即锁，chronicler 不再覆盖） ——
export function setFieldLock(w: WorldState, characterId: string, field: string, locked: boolean): void {
  const list = w.lockedFields ?? [];
  const idx = list.findIndex((l) => l.characterId === characterId && l.field === field);
  if (locked && idx === -1) list.push({ characterId, field });
  if (!locked && idx >= 0) list.splice(idx, 1);
  w.lockedFields = list;
}

// —— L2 影响评估：确定性检查 + 1 次 LLM 冲突评估 ——
export type ImpactReport = {
  affectedChapters: number[];
  conflicts: string[];
  reverseRelationHint?: string; // 关系双边联动建议（改 A→B 时给出 B→A 建议文案）
  options: ("merge" | "rewrite" | "abort")[];
};

export async function impactReport(w: WorldState, change: { kind: string; detail: string; characterIds?: string[]; foreshadowIds?: string[] }): Promise<ImpactReport> {
  // 确定性部分：appearedIn / 伏笔位置（零成本）
  const affected = new Set<number>();
  for (const id of change.characterIds ?? []) {
    const c = w.characters.find((x) => x.id === id);
    for (const ch of c?.appearedIn ?? []) affected.add(ch);
  }
  for (const id of change.foreshadowIds ?? []) {
    const f = w.foreshadowing.find((x) => x.id === id);
    if (f) affected.add(f.plantedAt);
    if (f?.resolvedAt) affected.add(f.resolvedAt);
  }

  // LLM 冲突评估（1 次；失败降级为空）
  let conflicts: string[] = [];
  let reverseRelationHint: string | undefined;
  try {
    const facts = [
      `梗概：${w.premise}`,
      `近 5 章摘要：${(w.chapterSummaries ?? []).slice(-5).map((s) => `第${s.index}章：${s.summary}`).join("\n") || "（无）"}`,
      `时间线：${w.timeline.slice(-5).map((t) => `第${t.chapter}章 ${t.summary}`).join("；")}`,
      `活跃伏笔：${w.foreshadowing.filter((f) => f.status !== "resolved").map((f) => f.text).join("；") || "（无）"}`,
    ].join("\n");
    const out = await chatJson<{ conflicts?: string[]; reverseRelationHint?: string }>(
      [
        { role: "system", content: "你是小说连续性顾问。给定一项即将应用到已写小说的变更，判断它与哪些既成事实冲突（每条一句话，含章节号），若是人物关系变更再给出反向关系建议。输出合法 JSON：{\"conflicts\":[\"…\"],\"reverseRelationHint\":\"…或空\"}。字符串值内部一律使用中文引号「」/『』，禁止英文双引号。" },
        { role: "user", content: `[拟变更] ${change.kind}：${change.detail}\n\n[既成事实]\n${facts}` },
      ],
      { temperature: 0.2, maxTokens: 60000 },
    );
    conflicts = (Array.isArray(out.conflicts) ? out.conflicts : []).map(String).filter(Boolean).slice(0, 6);
    reverseRelationHint = typeof out.reverseRelationHint === "string" && out.reverseRelationHint.trim() ? out.reverseRelationHint.trim() : undefined;
  } catch {
    /* 评估失败降级：仅确定性部分 */
  }

  return {
    affectedChapters: [...affected].sort((a, b) => a - b),
    conflicts,
    reverseRelationHint,
    options: ["merge", "rewrite", "abort"],
  };
}

// —— 三选一策略执行 ——
export async function applyStrategy(
  w: WorldState,
  change: { kind: string; detail: string },
  strategy: "merge" | "rewrite" | "abort",
  affectedChapters: number[] = [],
): Promise<{ rewriteQueue?: number[] }> {
  if (strategy === "abort") {
    logChange(w, { chapter: w.nextChapter, actor: "user", kind: change.kind, detail: change.detail, strategy: "abort" });
    saveWorld(w);
    return {};
  }
  if (strategy === "merge") {
    // 弥合：注入弥合任务到后续 1-2 章本章计划（没有本章计划则挂到 outline 提示）
    const task = `自然弥合人工变更（${change.kind}）：${change.detail}——需在剧情中给出合理铺垫/解释，不得生硬提及「设定修改」字样`;
    const plans = (w.chapterPlans ?? []).filter((p) => p.status === "planned").slice(0, 2);
    if (plans.length) {
      for (const p of plans) p.mergeTasks = [...(p.mergeTasks ?? []), task].slice(0, 3);
    } else {
      w.outline = [task, ...(w.outline ?? [])].slice(0, 10);
    }
    logChange(w, { chapter: w.nextChapter, actor: "user", kind: change.kind, detail: change.detail, strategy: "merge" });
    saveWorld(w);
    return {};
  }
  // rewrite：最小章节集入队（由调用方逐章执行 regenerate，可暂停/取消）
  const queue = affectedChapters.filter((i) => i >= 1 && i < w.nextChapter);
  w.rewriteQueue = queue;
  logChange(w, { chapter: w.nextChapter, actor: "user", kind: change.kind, detail: change.detail, strategy: "rewrite" });
  saveWorld(w);
  return { rewriteQueue: queue };
}
