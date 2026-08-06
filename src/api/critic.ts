// 审查者（Critic）P2 重构（修 D1-D5、B1）：
// - 动态准则（WritingBench：先按本章任务生成 5 条 instance-specific 准则，再按准则审查）
// - 单次调用合并输出准则+评分+findings（省额度）
// - verdict 决策表由代码确定性覆盖 LLM（floor / fixScope / minor 容忍通道）
// - 上下文 = 记忆层真实摘要（buildCriticContext）
import { chatJson, clampScore } from "./jsonutil";
import { buildCriticContext } from "./memory";
import { activeForeshadows, genOf, type ChapterPlan, type ReviewFinding, type WorldState } from "./world";

// —— 类型扩展（保持 ReviewResult 旧字段兼容前端） ——
export type ReviewAction = "pass" | "patch" | "rewrite";

export type CriticFinding = ReviewFinding & { fixScope?: "paragraph" | "chapter"; criteriaRef?: string };

export type CriticVerdict = {
  action: ReviewAction; // 代码决策表产出（权威）
  llmVerdict: "pass" | "revise"; // LLM 原始意见（审计用）
  scores: { coherence: number; tension: number; prose: number; pacing: number; dialogue: number };
  criteria: { name: string; rubric: string }[];
  findings: CriticFinding[];
  foreshadowNotes: string;
  floorFail: boolean;
  round: number;
};

const CRITIC_SYSTEM = `你是独立的小说"审查者"（Critic / Editor），与导演是对手关系：不奉承、不代写，只挑毛病并引用原文证据。
审查分两步（一次输出完成）：
第一步·动态准则：根据本章任务与全书基调，生成本章专属的 5 条评估准则（每条含名称与评分要点），覆盖：本章任务完成度、叙事张力、人物一致性、文笔与风格、读者体验（钩子/节奏）。
第二步·按准则审查正文，并叠加静态一致性检查：
* continuity 连续性：人物行为符合人设/动机（OOC）、设定规则、时间线/地点矛盾
* character_state：已离场/死亡角色是否复活、性格突变无铺垫
* logic：因果链断裂、剧情跳脱
* foreshadow：该回应的伏笔无动作、新埋伏笔生硬、矛盾回收
* outline：本章任务的节拍是否逐项落实（未落实的列为问题）
* aiTone：AI 腔（套话/疲劳词/总结式收尾/解释性旁白）
* intervention：近期人工干预的弥合任务是否自然融入（如有）
评分 1-10：coherence(连贯) tension(张力) prose(文笔) pacing(节奏) dialogue(对话)。
输出必须为合法 JSON（不要 markdown 围栏）：
{"criteria":[{"name":"准则名","rubric":"评分要点"}],
"verdict":"pass 或 revise",
"scores":{"coherence":8,"tension":7,"prose":8,"pacing":7,"dialogue":8},
"findings":[{"severity":"major或minor","lens":"维度","issue":"问题","evidence":"本章原文引用","fixScope":"paragraph（可定位段落修补）或 chapter（需整章重写）","suggestion":"修改建议"}],
"foreshadow_notes":"伏笔账本核查结论"}
要求：findings ≤5 条，major 优先给最有价值的意见不凑数；每条 evidence 必须是正文原句；minor 问题（不影响阅读）如实列出但 verdict 可为 pass。
引用伏笔时使用其中文全称并加「」括起（如「银针里的断蛇」），禁止输出伏笔 id 或编号。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** verdict 决策表（确定性，代码侧覆盖 LLM，修 D2）：
 * floor 失败或存在 chapter 级 major → rewrite；
 * 仅 paragraph 级 major → patch；
 * minor-only → pass（minor 由管线登记质量债务，不阻塞）。 */
export function decideAction(
  llmVerdict: string,
  scores: { coherence: number; tension: number },
  findings: CriticFinding[],
  floor: number,
): { action: ReviewAction; floorFail: boolean } {
  const floorFail = scores.coherence < floor || scores.tension < floor;
  const majors = findings.filter((f) => f.severity === "major");
  if (floorFail || majors.some((f) => f.fixScope === "chapter")) return { action: "rewrite", floorFail };
  if (majors.length) return { action: "patch", floorFail };
  if (llmVerdict !== "pass") {
    // LLM 判 revise 但无 major：尊重其意见做段落级修补（findings 仍可能含可修项）
    return findings.length ? { action: "patch", floorFail } : { action: "pass", floorFail };
  }
  return { action: "pass", floorFail };
}

/** 审查一章（单次调用合并输出动态准则+评分+findings） */
export async function reviewChapter(
  world: WorldState,
  chapterText: string,
  chapterTitle: string,
  chapterIndex?: number,
  plan?: ChapterPlan | null,
): Promise<CriticVerdict> {
  const fs = activeForeshadows(world);
  const threads = (world.plotThreads ?? []).filter((a) => a.status !== "已解决");
  const idx = chapterIndex ?? world.nextChapter;
  const g = genOf(world, idx);
  const globalCtx = buildCriticContext(world, idx);

  const userMsg = [
    `[全书基调] ${world.setting.tone || world.genre}｜POV: ${g.pov}｜风格: ${g.styleOverride || "默认"}`,
    plan
      ? `[本章任务] 目标：${plan.goal}\n节拍：\n${plan.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}${plan.mergeTasks?.length ? `\n弥合任务：${plan.mergeTasks.join("；")}` : ""}`
      : "[本章任务] （无本章计划，按常规审查）",
    `\n${globalCtx}`,
    `\n[进行中的情节弧线] ${threads.length ? threads.map((a) => `- ${a.name}：${a.note}`).join("\n") : "无"}`,
    `\n[待核查的活跃伏笔] ${fs.length ? fs.map((f) => `「${f.text}」（埋于第${f.plantedAt}章）`).join("\n") : "无"}`,
    `\n[审查对象：第${idx}章《${chapterTitle}》全文]\n${chapterText}`,
    "\n请输出审查结论（只输出 JSON）。重点：全书一致性、本章计划落实、AI 腔。",
  ].join("\n");

  const out = await chatJson<{
    criteria?: { name?: string; rubric?: string }[];
    verdict?: string;
    scores?: Record<string, unknown>;
    findings?: { severity?: string; lens?: string; issue?: string; evidence?: string; fixScope?: string; suggestion?: string }[];
    foreshadow_notes?: string;
  }>(
    [
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.4, maxTokens: 60000 },
  );

  const scores = {
    coherence: clampScore(out.scores?.coherence),
    tension: clampScore(out.scores?.tension),
    prose: clampScore(out.scores?.prose),
    pacing: clampScore(out.scores?.pacing),
    dialogue: clampScore(out.scores?.dialogue),
  };
  const findings: CriticFinding[] = (Array.isArray(out.findings) ? out.findings : [])
    .filter((f) => f && (f.issue || f.evidence))
    .map((f) => ({
      severity: (f.severity === "major" ? "major" : "minor") as "major" | "minor",
      lens: String(f.lens ?? "general"),
      issue: String(f.issue ?? ""),
      evidence: String(f.evidence ?? ""),
      suggestion: String(f.suggestion ?? ""),
      fixScope: (f.fixScope === "chapter" ? "chapter" : "paragraph") as "chapter" | "paragraph",
    }))
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1))
    .slice(0, 5);
  const criteria = (Array.isArray(out.criteria) ? out.criteria : [])
    .filter((c) => c?.name)
    .slice(0, 5)
    .map((c) => ({ name: String(c.name), rubric: String(c.rubric ?? "") }));

  // 审查严格度 → 地板阈值
  const floor = g.reviewStrictness === "宽松" ? 4 : g.reviewStrictness === "严格" ? 7 : 6;
  const { action, floorFail } = decideAction(String(out.verdict ?? ""), scores, findings, floor);

  return {
    action,
    llmVerdict: out.verdict === "pass" ? "pass" : "revise",
    scores,
    criteria,
    findings,
    foreshadowNotes: String(out.foreshadow_notes ?? ""),
    floorFail,
    round: 0,
  };
}
