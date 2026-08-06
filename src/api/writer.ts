// 导演（Writer）P2 重构：纯写作（修 C1-C5、E1）
// - 只输出正文（首行【标题】），不再夹带状态 JSON → 记账移交 chronicler
// - 走 chatStream 流式（onDelta 透传 SSE），maxTokens 60000 防截断（思考型模型 reasoning 与正文共享预算）
// - 字数治理：short → 1 次续写补足；long → warning 不截断（inkos 式）
// - 注入：记忆层上下文（自适应档位+预算）+ 世界书关键词匹配 + 风格指纹 + 反 AI 味规则
import { chatStream } from "./agnes";
import { loreBlock } from "./lore";
import { buildWriterContext } from "./memory";
import { antiAiToneRules, detectAiTone, wordCountGuard } from "./style";
import { genOf, type ChapterPlan, type WorldState } from "./world";

export type WriterResult = {
  title: string;
  text: string;
  guard: "ok" | "short" | "long"; // 字数治理结果
  aiToneHits: string[]; // 确定性 AI 味命中（供自检阶段）
  supplemented: boolean; // 是否触发过续写补足
};

const WRITER_SYSTEM = `你是小说的"导演"（Writer）。基于世界状态与本章任务写出有张力、有画面感的一章正文。
写作要求：
- 展示而非讲述；对话有个性（遵循人物声线）；细节具体（动作/感官/环境）
- 人物行为必须符合人设与动机；已埋设的伏笔要有意识地推进或暗示
- 段落自然分行；直接写正文，不要输出任何 JSON、markdown、标题编号或解释性文字
输出格式（严格遵守）：
第一行：【标题】本章标题（贴合本章内容，禁止用"第N章"作为标题）
其后：正文段落（空行分段）`;

function parseDraft(raw: string, fallbackTitle: string): { title: string; text: string } {
  const lines = raw.trim().split("\n");
  let title = fallbackTitle;
  let start = 0;
  const m = lines[0]?.match(/^【标题】\s*(.+)$/);
  if (m) {
    title = m[1].trim().slice(0, 60) || fallbackTitle;
    start = 1;
  }
  const text = lines.slice(start).join("\n").trim();
  return { title, text };
}

export interface WriteChapterOpts {
  world: WorldState;
  instruction: string;
  revisionNotes?: string; // 审查意见（修订稿）
  draft?: string; // 修订时提供上一稿
  chapterIndex?: number;
  plan?: ChapterPlan | null; // 本章章纲（P3 接入，无则 null）
  onDelta?: (delta: string) => void; // 流式增量（SSE 透传）
}

/** 组装 writer 用户消息（记忆层上下文 + 章纲 + 参数 + 指令） */
function buildUserMsg(o: WriteChapterOpts): string {
  const w = o.world;
  const idx = o.chapterIndex ?? w.nextChapter;
  const g = genOf(w, idx);
  const ctx = buildWriterContext(w, o.plan ?? null);
  const parts: string[] = [];

  for (const seg of ctx.segments) parts.push(seg.text);

  // 世界书（关键词匹配注入，修 B3）
  const loreCtx = [o.plan?.goal ?? "", ...(o.plan?.beats ?? []), o.instruction].join("\n");
  const lore = loreBlock(w, loreCtx);
  if (lore) parts.push(lore);

  // 章纲（写作目标；P3 起由 planner 供给）
  if (o.plan) {
    parts.push(`\n[本章任务] 目标：${o.plan.goal}\n节拍：\n${o.plan.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}`);
    if (o.plan.mergeTasks?.length) parts.push(`[弥合任务·必须自然融入] ${o.plan.mergeTasks.join("；")}`);
    if (o.plan.hookType !== "无") parts.push(`[结尾钩子类型] ${o.plan.hookType}`);
  }

  // 写作参数（字数不再与 system 矛盾，修 C1）
  const target = g.targetChapterWords ?? Math.round((g.minWords + g.maxWords) / 2);
  const style = g.styleOverride?.trim() || w.setting.tone;
  const modeHint =
    g.settingMode === "历史真实"
      ? "（遵循历史真实设定：涉及朝代/官职/地理/风俗时务必与史实相符）"
      : g.settingMode === "混合"
        ? "（架空为主，真实历史节点保持相符）"
        : "（架空设定：以本世界规则为准）";
  parts.push(
    `\n[写作参数] 目标字数 ${target} 字（±40%）；叙述视角：${g.pov}；文风：${style || "跟随世界基调"}${modeHint}；${g.forceHook ? "结尾必须留下悬念钩子" : "结尾可自然收束"}。`,
  );
  if (Array.isArray(g.fidelityRules) && g.fidelityRules.length) {
    const follow = g.fidelityRules.filter((r) => r.follow === "史实" && r.content.trim());
    const fiction = g.fidelityRules.filter((r) => r.follow === "架空" && r.content.trim());
    if (follow.length || fiction.length) {
      parts.push(
        [
          "\n[遵循设定细则]",
          ...follow.map((r) => `- 遵循史实：${r.content.trim()}`),
          ...fiction.map((r) => `- 架空处理：${r.content.trim()}`),
        ].join("\n"),
      );
    }
  }
  // 风格指纹（仿写）
  if (g.styleFingerprint?.trim()) parts.push(`\n[风格指纹·全文遵循] ${g.styleFingerprint.trim()}`);
  // 反 AI 味硬规则
  parts.push(`\n${antiAiToneRules()}`);

  if (o.revisionNotes && o.draft) {
    parts.push(`\n[上一稿] ${o.draft}`);
    parts.push(
      `\n[审查者意见·必须逐条回应修正] ${o.revisionNotes}\n请输出修订后的完整稿（仍遵守输出格式：首行【标题】+正文）。`,
    );
  } else {
    if (o.instruction) parts.push(`\n[本章指令] ${o.instruction}`);
    parts.push(`\n请开始写第 ${idx} 章（首行必须输出【标题】XX，标题贴合本章内容，禁止用"第N章"作为标题）。`);
  }
  return parts.join("\n");
}

/** 写一章正文（流式）。失败时抛出，由管线决定重试/停下 */
export async function writeChapter(o: WriteChapterOpts): Promise<WriterResult> {
  const w = o.world;
  const idx = o.chapterIndex ?? w.nextChapter;
  const g = genOf(w, idx);
  // 标题兜底：有章纲时用章纲目标提炼（比"第N章"更有信息量），无章纲才退回"第N章"
  const fallbackTitle = o.plan?.goal?.slice(0, 20) || `第${idx}章`;

  const raw = await chatStream(
    [
      { role: "system", content: WRITER_SYSTEM },
      { role: "user", content: buildUserMsg(o) },
    ],
    (delta) => o.onDelta?.(delta),
    // 思考型模型：reasoning 与正文共享预算（默认思考实测 1000~8000+），60000 兜底不截断；流式超时放宽到 240s
    { temperature: g.temperature, maxTokens: 60000, timeoutMs: 240_000 },
  );

  let { title, text } = parseDraft(raw, fallbackTitle);

  // 空正文兜底：重试一次（非流式语义保持，同样走 chatStream）
  if (!text.trim()) {
    const retry = await chatStream(
      [
        { role: "system", content: WRITER_SYSTEM },
        { role: "user", content: buildUserMsg(o) + "\n注意：上次输出缺少正文，请务必输出完整正文。" },
      ],
      (delta) => o.onDelta?.(delta),
      { temperature: g.temperature, maxTokens: 60000, timeoutMs: 240_000 },
    );
    ({ title, text } = parseDraft(retry, fallbackTitle));
  }

  // 字数治理（修 C3）：short → 1 次续写补足；long → warning 不截断
  let supplemented = false;
  let guard = wordCountGuard(text, g);
  if (guard === "short" && text.trim()) {
    const target = g.targetChapterWords ?? Math.round((g.minWords + g.maxWords) / 2);
    const cont = await chatStream(
      [
        { role: "system", content: "你是小说续写者。从上文结尾处无缝续写，不重复已有内容，不输出标题行与任何说明，直到情节推进到自然段落收束。" },
        { role: "user", content: `上文：\n…${text.slice(-1500)}\n\n请续写约 ${Math.max(200, target - text.length)} 字，与前文语气、视角、时态完全一致。` },
      ],
      (delta) => o.onDelta?.(delta),
      { temperature: g.temperature, maxTokens: 60000, timeoutMs: 240_000 },
    );
    const addition = cont.replace(/^【标题】.*$/m, "").trim();
    if (addition) {
      text = `${text}\n\n${addition}`;
      supplemented = true;
      guard = wordCountGuard(text, g);
    }
  }

  return { title, text, guard, aiToneHits: detectAiTone(text), supplemented };
}
