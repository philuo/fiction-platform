// 导演（Writer）：生成章节。与审查者是对手关系（参考 agent-writing）——
// 导演要推进剧情、捍卫自己的草稿；审查者负责挑毛病，两者互相独立。
import { chatJson } from "./jsonutil";
import { loreBlock } from "./lore";
import { genOf, worldSummary, type WorldState } from "./world";

const WRITER_SYSTEM = `你是小说的"导演"（Writer）。你的职责：基于世界状态写出有张力、有画面感的一节正文（约300-500字中文），
并主动管理伏笔：埋设新伏笔、回收旧伏笔。你要像优秀网文/纯文学作者那样写作：
- 展示而非讲述；对话要有个性；每节结尾留钩子
- 人物行为必须符合人设与动机
- 已埋设的伏笔要有意识地推进或回应（不是每节必须回收，但要有所动作或暗示）
- 输出必须是合法 JSON（不要 markdown 围栏），结构：
{"title":"本节标题","text":"正文","new_foreshadowing":[{"text":"伏笔内容","note":"如何/何时呼应"}],"resolved_foreshadowing":[{"id":"伏笔ID","how":"如何回收"}],"character_updates":[{"name":"人物名","status":"新状态"}],"timeline_summary":"本节事件一句话摘要","arcs":[{"name":"弧线名","status":"进行中或已解决","note":"本节进展"}]}
注意：new_foreshadowing 每节最多埋 2 个；resolved_foreshadowing 只回收真实发生的伏笔。
character_updates 必填：列出本节所有出场角色（name 须与设定中角色名完全一致）及其最新状态，不得遗漏。
arcs 必填：输出当前活跃/新开/已解决的情节弧线，至少 1 条（与 JSON 示例中同一字段）。
若有角色在本节离场或死亡，输出 character_exits：[{"name":"角色名","reason":"如何离场/死亡"}]。
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

export type WriterOutput = {
  title: string;
  text: string;
  new_foreshadowing: { text: string; note?: string }[];
  resolved_foreshadowing: { id: string; how: string }[];
  character_updates: { name: string; status: string }[];
  character_exits?: { name: string; reason: string }[]; // 角色离场/死亡
  timeline_summary: string;
  arcs?: { name: string; status: string; note?: string }[]; // M4 弧线更新
};

export async function writeChapter(world: WorldState, instruction: string, revisionNotes?: string, chapterIndex?: number): Promise<WriterOutput> {
  const buildUserMsg = (extra?: string): string[] => {
    const userMsg: string[] = [];
    userMsg.push(worldSummary(world));
    // M3 世界书条目（写作必须遵循的设定）
    const lore = loreBlock(world);
    if (lore) userMsg.push(lore);
    // M4 情节弧线（进行中的要推进）
    const arcs = (world.arcs ?? []).filter((a) => a.status !== "已解决");
    if (arcs.length) {
      userMsg.push(`\n[情节弧线] 进行中的弧线（本节应推进至少一条）:\n${arcs.map((a) => `- ${a.name}：${a.note}`).join("\n")}`);
    }
    // M4 人物声线（对话遵循，防千人一面）
    const voices = world.characters.filter((c) => c.voice?.trim());
    if (voices.length) {
      userMsg.push(`\n[人物声线] 对话必须遵循各角色声线，不得千人一面:\n${voices.map((c) => `- ${c.name}：${c.voice}`).join("\n")}`);
    }
    // M1 生成参数：字数/视角/文风/伏笔上限/钩子（含章节级覆盖）
    const g = genOf(world, chapterIndex);
    const style = g.styleOverride?.trim() || world.setting.tone;
    const modeHint =
      g.settingMode === "历史真实"
        ? "（遵循历史真实设定：涉及朝代/官职/地理/风俗时务必与史实相符，不得虚构关键史实）"
        : g.settingMode === "混合"
          ? "（架空为主，但涉及真实历史节点时保持相符）"
          : "（架空设定：以本世界规则为准，不受史实约束）";
    userMsg.push(
      `\n[写作参数] 目标字数 ${g.minWords}-${g.maxWords} 字；叙述视角：${g.pov}；文风：${style || "跟随世界基调"}${modeHint}；本节新埋伏笔最多 ${g.maxForeshadowPerChapter} 个；${g.forceHook ? "结尾必须留下悬念钩子" : "结尾可自然收束"}。`,
    );
    // 遵循设定细则（逐条指定史实/架空）
    if (Array.isArray(g.fidelityRules) && g.fidelityRules.length) {
      const follow = g.fidelityRules.filter((r) => r.follow === "史实" && r.content.trim());
      const fiction = g.fidelityRules.filter((r) => r.follow === "架空" && r.content.trim());
      if (follow.length || fiction.length) {
        userMsg.push(
          [
            "\n[遵循设定细则] 以下条目必须严格按标注处理：",
            ...follow.map((r) => `- 遵循史实：${r.content.trim()}`),
            ...fiction.map((r) => `- 架空处理：${r.content.trim()}`),
          ].join("\n"),
        );
      }
    }
    // 大纲指引：告诉导演接下来应该推进什么（如有）
    if ((world.outline ?? []).length) {
      userMsg.push(`\n[大纲指引] 接下来按大纲推进（可灵活演绎，但不要跳过大纲要点）:\n${(world.outline ?? []).map((o, i) => `${i + 1}. ${o}`).join("\n")}`);
    }
    if (instruction) userMsg.push(`\n[本节指令] ${instruction}`);
    if (revisionNotes) {
      userMsg.push(
        `\n[审查者意见，必须逐条回应修正] ${revisionNotes}\n` +
          `注意：修正意见后直接输出修订稿（仍然只输出 JSON）。`,
      );
    } else {
      userMsg.push(`\n请开始写第 ${world.nextChapter} 节。`);
    }
    if (extra) userMsg.push(extra);
    return userMsg;
  };

  let out = await chatJson<Partial<WriterOutput>>(
    [
      { role: "system", content: WRITER_SYSTEM },
      { role: "user", content: buildUserMsg().join("\n") },
    ],
    { temperature: genOf(world, chapterIndex).temperature, maxTokens: 4096 },
  );

  // 空正文兜底：要求导演重写一次
  if (!String(out.text ?? "").trim()) {
    out = await chatJson<Partial<WriterOutput>>(
      [
        { role: "system", content: WRITER_SYSTEM },
        { role: "user", content: buildUserMsg("\n注意：上次输出缺少正文（text 字段为空），请务必输出完整的正文。").join("\n") },
      ],
      { temperature: genOf(world, chapterIndex).temperature, maxTokens: 4096 },
    );
  }

  return {
    title: String(out.title ?? `第${world.nextChapter}节`).trim(),
    text: String(out.text ?? "").trim(),
    new_foreshadowing: Array.isArray(out.new_foreshadowing) ? out.new_foreshadowing : [],
    resolved_foreshadowing: Array.isArray(out.resolved_foreshadowing) ? out.resolved_foreshadowing : [],
    character_updates: Array.isArray(out.character_updates) ? out.character_updates : [],
    character_exits: Array.isArray(out.character_exits) ? out.character_exits : [],
    timeline_summary: String(out.timeline_summary ?? "").trim(),
    arcs: Array.isArray(out.arcs) ? out.arcs : [],
  };
}
