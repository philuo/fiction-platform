// 审查者（Critic）：对抗性审查 + 全书一致性检查。
// 与导演独立（参考 Book Genesis / agent-writing）——不奉承、不代写，只挑毛病并引用原文证据。
import { chatJson, clampScore } from "./jsonutil";
import { activeForeshadows, genOf, worldSummary, type WorldState, type ReviewResult } from "./world";

const CRITIC_SYSTEM = `你是独立的小说“审查者”（Critic / Editor）。你与导演是对手关系：导演想快点交稿，你的职责是确保稿件经得起推敲。
审查原则（参考 lit-critic 与 Book Genesis）：
- 只报告问题，不重写句子；每条问题必须引用原文证据
- 检查维度（分两类）：
  【文本质量】
  * prose 文笔：是否空洞/说教/词语重复
  * pacing 节奏：是否拖沓或跳跃
  * dialogue 对话：是否千人一面
  * arc 弧线：进行中的情节弧线是否被推进
  【全书一致性】
  * continuity 连续性：人物行为是否符合人设/动机（OOC）、设定规则是否被违反、时间线/地点是否矛盾
  * character_state 角色状态矛盾：角色已死亡/离开但后续又出现，角色性格突变无铺垫
  * logic 逻辑：因果链是否断裂、剧情逻辑跳脱
  * foreshadow 伏笔：应该回应的伏笔是否毫无动作？新埋的伏笔是否生硬？同一伏笔被矛盾地回收或忽略
  * style 风格一致性：与设定的 POV/温度/风格参数是否偏离，叙事风格是否前后一致
- 评分 1-10：coherence(连贯) tension(张力) prose(文笔) pacing(节奏) dialogue(对话)
- 地板机制：coherence 或 tension 低于 6 分 → verdict 必须为 "revise"
- 输出必须为合法 JSON（不要 markdown 围栏）：
{"verdict":"pass 或 revise","scores":{"coherence":8,"tension":7,"prose":8,"pacing":7,"dialogue":8},"findings":[{"severity":"major或minor","lens":"维度","issue":"问题","evidence":"当前章节原文引用","conflict_with":"冲突的另一方原文/设定（可选）","suggestion":"修改建议"}],"foreshadow_notes":"对伏笔账本的核查结论"}
major 问题 ≤ 2 条时优先给出最有价值的意见，不要凑数。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** 构建全书上下文（角色状态、伏笔、时间线、前几章摘要） */
function buildGlobalContext(world: WorldState, chapterIndex: number): string {
  const parts: string[] = [];

  // 角色当前状态
  parts.push("[全书角色当前状态]");
  for (const c of world.characters) {
    parts.push(`- ${c.name}（${c.role}）：${c.status}｜性格: ${c.traits.join("、")}｜动机: ${c.motivation}`);
  }

  // 伏笔全览（含已回收）
  parts.push("\n[全书伏笔账本]");
  for (const f of world.foreshadowing) {
    parts.push(`- [${f.id}] ${f.text}（第${f.plantedAt}章埋设，状态: ${f.status}${f.note ? `，备注: ${f.note}` : ""}）`);
  }

  // 时间线
  if (world.timeline?.length) {
    parts.push("\n[时间线]");
    for (const t of world.timeline.slice(-10)) {
      parts.push(`- 第${t.chapter}章: ${t.summary}`);
    }
  }

  // 前几章摘要（最多前 5 章）
  const prevChapters = world.chapters.filter((c) => c.index < chapterIndex).slice(-5);
  if (prevChapters.length) {
    parts.push("\n[前文摘要]");
    for (const ch of prevChapters) {
      parts.push(`- 第${ch.index}节《${ch.title}》: ${ch.text.slice(0, 120)}…`);
    }
  }

  // 设定参数
  const gen = genOf(world, chapterIndex);
  parts.push(`\n[当前设定参数] POV: ${gen.pov}｜温度: ${gen.temperature}｜风格: ${gen.styleOverride || "默认"}｜审查严格度: ${gen.reviewStrictness}`);

  return parts.join("\n");
}

export async function reviewChapter(world: WorldState, chapterText: string, chapterTitle: string, chapterIndex?: number): Promise<ReviewResult> {
  const fs = activeForeshadows(world);
  const arcs = (world.arcs ?? []).filter((a) => a.status !== "已解决");
  const idx = chapterIndex ?? world.nextChapter;
  const globalCtx = buildGlobalContext(world, idx);

  const userMsg = [
    worldSummary(world),
    `\n${globalCtx}`,
    `\n[进行中的情节弧线] ${arcs.length ? arcs.map((a) => `- ${a.name}：${a.note}`).join("\n") : "无"}`,
    `\n[审查对象：第${idx}节《${chapterTitle}》全文]`,
    chapterText,
    `\n[待核查的活跃伏笔] ${fs.length ? fs.map((f) => `[${f.id}] ${f.text}（埋于第${f.plantedAt}章）`).join("\n") : "无"}`,
    "\n请给出审查结论（只输出 JSON）。重点检查全书一致性：角色状态矛盾、剧情逻辑、伏笔冲突、风格一致性、OOC。",
  ].join("\n");

  const out = await chatJson<{
    verdict?: string;
    scores?: Record<string, unknown>;
    findings?: { severity?: string; lens?: string; issue?: string; evidence?: string; conflict_with?: string; suggestion?: string }[];
    foreshadow_notes?: string;
  }>(
    [
      { role: "system", content: CRITIC_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.4, maxTokens: 2048 },
  );

  const scores = {
    coherence: clampScore(out.scores?.coherence),
    tension: clampScore(out.scores?.tension),
    prose: clampScore(out.scores?.prose),
    pacing: clampScore(out.scores?.pacing),
    dialogue: clampScore(out.scores?.dialogue),
  };
  const findings = (Array.isArray(out.findings) ? out.findings : [])
    .filter((f) => f && (f.issue || f.evidence))
    .map((f) => ({
      severity: (f.severity === "major" ? "major" : "minor") as "major" | "minor",
      lens: String(f.lens ?? "general"),
      issue: String(f.issue ?? ""),
      evidence: String(f.evidence ?? ""),
      suggestion: String(f.suggestion ?? ""),
    }));

  // M1 审查严格度 → 地板阈值
  const floor = genOf(world, idx).reviewStrictness === "宽松" ? 4 : genOf(world, idx).reviewStrictness === "严格" ? 7 : 6;
  const floorFail = scores.coherence < floor || scores.tension < floor;
  const capped = findings
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "major" ? -1 : 1))
    .slice(0, 5);
  const majorCount = capped.filter((f) => f.severity === "major").length;
  const verdict: "pass" | "revise" = out.verdict === "pass" && !floorFail && majorCount === 0 ? "pass" : "revise";

  return { verdict, scores, findings: capped, round: 0 };
}
