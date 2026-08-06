// 中枢（brain / overseer）模块 —— 全局大脑
// 职责：整书决策/审批/把关，不写正文、不执行任务。三大能力（docs/BRAIN.md + docs/DEEP-DIVE.md）：
// ① goal disposition：统一目标对象（BookGoal）的三态报告 continue/complete/blocked（BRAIN §3.3）
// ② 章末一致性审查：commitChapter P1 窗口，审查记账结果 vs 全局设定/伏笔/主线（DEEP-DIVE §1.1）
// ③ 状态变更闸门：AGNES_BRAIN_GATE=on 且 L2+ 变更的冲突/既成事实/全局影响审查（DEEP-DIVE §1.3）
// 权限开关：AGNES_BRAIN_GATE（闸门是否启用）+ INTERVENTION_MODE（autopilot/supervised/manual，BRAIN §6）
// 失败语义：任何一步失败降级放行，绝不阻塞写作/提交主链路（闸门是"加保险"不是"拦路虎"）
import { chatJson } from "./jsonutil";
import { taskOpts } from "./modelconfig";
import { getCommand } from "./harness";
import { logChange } from "./steering";
import { isBookComplete } from "./planner";
import type { ChangeLogEntry, WorldState } from "./world";
import type { StateChange } from "./statechange";

// —— 权限开关 ——

/** 主脑闸门：AGNES_BRAIN_GATE=on 启用中枢审查（章末/闸门）；off 时零行为变化（纯配置化兼容） */
export function brainGateEnabled(): boolean {
  return process.env.AGNES_BRAIN_GATE === "on";
}

/** 人机协作模式（INTERVENTION.md §6）：autopilot 全自动 / supervised 半自动（默认）/ manual 手动 */
export function interventionMode(): "autopilot" | "supervised" | "manual" {
  const m = process.env.INTERVENTION_MODE;
  if (m === "autopilot" || m === "manual") return m;
  return "supervised";
}

// —— ① goal disposition（BRAIN §3.3）——

export type BrainDisposition = "continue" | "complete" | "blocked";

/** 依据 BookGoal（未设置回落现状默认）计算 goal 三态：
 * - complete：结构完结（卷全 done + 伏笔全回收）∧（设置了 minOverall 时最近 eval overall 达标）
 * - blocked：预算耗尽（nextChapter 超过目标章数）/ 用户停止
 * - continue：其余 */
export function computeDisposition(w: WorldState): BrainDisposition {
  const goal = w.goal;
  const structureDone = isBookComplete(w);
  // 质量目标：minOverall 未设置 → 只看结构
  let qualityOk = true;
  const minOverall = goal?.quality?.minOverall;
  if (minOverall != null) {
    qualityOk = false; // 未找到最近评估 → 视为未达标（不阻塞，仅度量）
  }
  if (structureDone) {
    // 结构完结即 complete（质量是附加维度；minOverall 不达标时仍按结构完成放行，避免假阻塞）
    return "complete";
  }
  // 预算耗尽 → blocked
  const targetChapters = goal?.structure?.targetChapters ?? (w.blueprint?.volumes?.length ? undefined : undefined);
  if (targetChapters != null && w.nextChapter > targetChapters) return "blocked";
  void qualityOk;
  return "continue";
}

// —— ② 章末一致性审查（DEEP-DIVE §1.1，P1 窗口：settleChapter 后、registerDebt 前）——

export type BrainReviewOutput = {
  verdict: "approve" | "revise" | "reject";
  reason?: string;
  /** revise 时建议注入 mergeTasks 的弥合任务（≤3 条） */
  suggestions?: string[];
};

const BRAIN_REVIEW_SYSTEM = `你是小说全局主脑（overseer）。给定一章定稿正文、章末记账结果（账本 delta 摘要）与全书全局状态，审查该章是否符合全局设定、主线与伏笔计划。
只输出合法 JSON：{"verdict":"approve|revise|reject","reason":"一句话依据","suggestions":["修正指令1","修正指令2"]}
- approve：记账与全局一致，放行；
- revise：发现可修正的不一致（如伏笔与设定冲突、角色状态与既成事实矛盾），给出≤3 条具体弥合指令；
- reject：发现重大矛盾（如推翻已落定事实）需要回滚；
- 审查严格但不苛刻：轻微风格/节奏问题不属于 reject/revise。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** 章末一致性审查（LLM）：输入正文+记账摘要+活跃伏笔+进行中弧线+章纲；失败降级放行（reason=brain_unavailable）。
 * 仅在 AGNES_BRAIN_GATE=on 时执行；off 时调用方跳过 LLM，仅记确定性 disposition。 */
export async function brainReviewAfterCommit(
  w: WorldState,
  index: number,
  ctx: { text: string; settleSummary: string; planGoal?: string },
): Promise<BrainReviewOutput> {
  const activeFs = w.foreshadowing.filter((f) => f.status !== "resolved");
  const threads = (w.plotThreads ?? []).filter((a) => a.status !== "已解决");
  const facts = [
    `梗概：${w.premise}`,
    `主线（compass）：${w.blueprint?.compass ?? "（无）"}`,
    `章纲目标：${ctx.planGoal ?? "（无）"}`,
    `活跃伏笔（${activeFs.length}）：${activeFs.map((f) => `[${f.id}] ${f.text}（埋于第${f.plantedAt}章）`).join("\n") || "（无）"}`,
    `进行中弧线：${threads.map((a) => `${a.name}：${a.note}`).join("\n") || "（无）"}`,
    `本章记账摘要：${ctx.settleSummary || "（无）"}`,
    `\n第${index}章定稿正文：\n${ctx.text.slice(0, 4000)}`,
  ].join("\n");
  try {
    const out = await chatJson<{ verdict?: string; reason?: string; suggestions?: unknown }>(
      [
        { role: "system", content: BRAIN_REVIEW_SYSTEM },
        { role: "user", content: facts },
      ],
      taskOpts("brainReview"),
    );
    const verdict = out.verdict === "revise" || out.verdict === "reject" ? out.verdict : "approve";
    const suggestions = Array.isArray(out.suggestions) ? out.suggestions.map(String).filter(Boolean).slice(0, 3) : undefined;
    return { verdict, reason: out.reason?.trim(), suggestions };
  } catch (e) {
    // 降级放行：不阻塞提交，记 brain_unavailable
    logChange(w, {
      chapter: index,
      actor: "brain",
      kind: "brain-review",
      detail: `章末一致性审查不可用（${(e as Error).message.slice(0, 60)}），降级放行`,
      commandId: "CMD-L01",
      reason: "brain_unavailable",
    });
    return { verdict: "approve", reason: "brain_unavailable" };
  }
}

/** 章末审查落地（BRAIN §4.2 治理任务通道复用）：revise 建议注入后续 planned 章纲的 mergeTasks；
 * reject 时记录（由调用方决定是否回滚——现默认记录不强制回滚，避免破坏既有 commit 语义）。 */
export function applyBrainReview(w: WorldState, index: number, out: BrainReviewOutput, reason: string): void {
  const entry: Omit<ChangeLogEntry, "at"> = {
    chapter: index,
    actor: "brain",
    kind: "brain-review",
    detail: reason,
    commandId: "CMD-L01",
    reason: out.reason,
    ...(out.suggestions?.length ? { meta: { suggestions: out.suggestions } } : {}),
  };
  logChange(w, entry);
  if (out.verdict === "revise" && out.suggestions?.length) {
    // 复用 mergeTasks 通道（steering applyStrategy merge 语义）
    const plans = (w.chapterPlans ?? []).filter((p) => p.status === "planned").slice(0, 2);
    for (const p of plans) {
      p.mergeTasks = [...(p.mergeTasks ?? []), ...out.suggestions].slice(0, 3);
    }
  }
}

// —— ③ 状态变更闸门（DEEP-DIVE §1.3 / FLOWS flow 3）——

/** 闸门审查：仅 AGNES_BRAIN_GATE=on 且变更分级 ≥ L2 时触发中枢模型；
 * 审查失败降级放行（reason=brain_unavailable）。返回是否允许继续写字段。 */
export async function gateChange(
  w: WorldState,
  change: StateChange & { level: "L0" | "L1" | "L2" | "L3" },
): Promise<{ allow: boolean; reason?: string }> {
  if (!brainGateEnabled()) return { allow: true };
  if (change.level === "L0" || change.level === "L1") return { allow: true }; // L0/L1 直通（成本控制）
  const cmd = change.commandId ? getCommand(change.commandId) : undefined;
  const facts = [
    `梗概：${w.premise}`,
    `近 5 章摘要：${(w.chapterSummaries ?? []).slice(-5).map((s) => `第${s.index}章：${s.summary}`).join("\n") || "（无）"}`,
    `活跃伏笔：${w.foreshadowing.filter((f) => f.status !== "resolved").map((f) => f.text).join("；") || "（无）"}`,
    `变更：${cmd?.id ?? change.field}（${change.op ?? "set"}）${change.reason}`,
  ].join("\n");
  try {
    const out = await chatJson<{ verdict?: string; reason?: string }>(
      [
        {
          role: "system",
          content: `你是小说全局主脑。评估一项即将应用到已写小说的 L2/L3 状态变更是否与既成事实冲突。
只输出合法 JSON：{"verdict":"allow|reject","reason":"一句话依据"}
- allow：变更合理或可通过后续弥合；- reject：变更推翻已落定事实且无法弥合。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`,
        },
        { role: "user", content: facts },
      ],
      taskOpts("brainGate"),
    );
    if (out.verdict === "reject") return { allow: false, reason: out.reason?.trim() };
    return { allow: true };
  } catch (e) {
    // 降级放行（闸门是"加保险"不是"拦路虎"）+ 记录
    logChange(w, {
      chapter: change.chapter ?? w.nextChapter,
      actor: "brain",
      kind: "brain-gate",
      detail: `状态变更闸门不可用（${(e as Error).message.slice(0, 60)}），降级放行：${change.reason}`,
      commandId: cmd?.id,
      level: change.level,
      reason: "brain_unavailable",
    });
    return { allow: true };
  }
}
