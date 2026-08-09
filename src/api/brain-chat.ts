// 中枢对话编排（brain-chat）：意图识别（LLM）+ supervised 执行编排
// POST /api/brain/chat（SSE）：用户 prompt → 意图识别 → 流式回复 + 卡片（查询直接执行 / 写操作预览 / L2·L3 确认卡）
// supervised（INTERVENTION_MODE 语义）：L0/L1 直接执行或预览，L2/L3 出确认卡；失败降级为纯对话
// 卡片 JSON 结构与 components/brain-cards.tsx 的 BrainCard 一致，前端直接渲染
//
// 事件协议（v2）：
//   { type: "intent" }                        # 意图识别开始（前端 loading）
//   { type: "delta", messageId, text }        # 回复增量：text=消息累计全文（前端打字机动画）
//   { type: "card", messageId, card }         # 卡片（预览/确认/结果/浏览/计划/意见询问）
//   { type: "done", messageId }               # 回合完成（消息已落盘）
//   { type: "interrupted", messageId }        # 中断/出错（消息保留已生成文本，可重新编辑）
//   { type: "reset", messageId }              # resume：前端清空该消息，后续 delta 重新填充
//   { phase: "ping" } / { error }              # 心跳 / 致命错误（sseStream 层）
import { chatJson } from "./jsonutil";
import { chatStream } from "./agnes";
import { taskOpts } from "./modelconfig";
import { loadWorld } from "./storage";
import { readEvalReport } from "./eval";
import { isPendingForeshadow } from "./world";
import { mediaDataUri } from "./media";
import { gachaGenerate as directorGachaGenerate } from "./director";
import type { CardType } from "./cards";
import type { Card as WorldCard, WorldState } from "./world";
import {
  appendMessage,
  createSession,
  getSession,
  lastIncompleteMessage,
  lastUserMessage,
  markMessageDone,
  markMessageInterrupted,
  markStreaming,
  updateMessageText,
  type BrainChatCard,
} from "./brain-sessions";

const uid = () => crypto.randomUUID();

/** 是否为用户取消（DOMException AbortError / signal aborted） */
function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

type BrainCardLevel = "L0" | "L1" | "L2" | "L3";

/** 表单卡字段定义（kind:"form" 卡，前端受控表单渲染；透传 JSON） */
export type FormFieldDef = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "multiselect";
  /** 当前值/默认值 */
  value?: string | number | string[];
  options?: { label: string; value: string }[];
  placeholder?: string;
  required?: boolean;
  /** textarea 为 true 时按行 split 成数组提交（如设定规则） */
  array?: boolean;
  /** 提交时转换："bool" 将「开/关」/「true/false」→ boolean；number 类型自动 Number() */
  transform?: "bool";
};

/** 表单卡数据（brain-chat 产出，前端 brain-cards.tsx FormCard 渲染） */
export type FormCardData = {
  kind: "form";
  title: string;
  commandId?: string;
  level?: BrainCardLevel;
  summary?: string;
  fields: FormFieldDef[];
  action: { endpoint: string; method?: string; body: Record<string, unknown> };
  submitLabel?: string;
  /** L2/L3：提交后需确认（或端点返回 needIntervention 时出 confirm 卡） */
  confirmRequired?: boolean;
};

/** 客户端执行信息（写操作卡片携带，供 BrainCabin 点击执行时 fetch 对应端点） */
type CardAction = { endpoint: string; method?: string; body: Record<string, unknown> };

type IntentMeta = {
  commandId: string;
  level: BrainCardLevel;
  title: string;
  action?: CardAction;
};

/** 意图 → 指令/级别/端点映射表（覆盖 16 类手动入口的核心操作） */
export const INTENTS: Record<string, IntentMeta> = {
  advance: { commandId: "CMD-N02", level: "L2", title: "推进剧情（写一章）", action: { endpoint: "/api/novel/step", method: "POST", body: {} } },
  autostart: { commandId: "CMD-N03", level: "L2", title: "开始自动连载", action: { endpoint: "/api/novel/auto/start", method: "POST", body: {} } },
  autostop: { commandId: "CMD-N13", level: "L0", title: "停止连载", action: { endpoint: "/api/novel/auto/stop", method: "POST", body: {} } },
  autopause: { commandId: "CMD-N13", level: "L0", title: "暂停连载", action: { endpoint: "/api/novel/auto/pause", method: "POST", body: {} } },
  gacha: { commandId: "CMD-W17", level: "L0", title: "抽卡（生成卡池）", action: { endpoint: "/api/novel/gacha", method: "POST", body: { action: "generate" } } },
  read_chapter: { commandId: "CMD-Q01", level: "L0", title: "浏览章节" },
  read_character: { commandId: "CMD-Q01", level: "L0", title: "浏览角色" },
  read_foreshadow: { commandId: "CMD-Q01", level: "L0", title: "伏笔情况" },
  read_proposals: { commandId: "CMD-Q01", level: "L0", title: "新角色提案（角色推荐）" },
  open_proposals: { commandId: "CMD-L11", level: "L0", title: "打开新角色提案" },
  read_chapters: { commandId: "CMD-Q01", level: "L0", title: "浏览章节目录" },
  read_characters: { commandId: "CMD-Q01", level: "L0", title: "浏览角色列表" },
  read_plans: { commandId: "CMD-Q01", level: "L0", title: "查看计划/章纲进度" },
  read_tasks: { commandId: "CMD-Q01", level: "L0", title: "查看任务/质量债/重写队列" },
  read_logs: { commandId: "CMD-Q01", level: "L0", title: "查看台账/操作日志" },
  read_worldbook: { commandId: "CMD-Q01", level: "L0", title: "查看设定/世界书" },
  read_media: { commandId: "CMD-Q01", level: "L0", title: "查看媒体资源" },
  read_review: { commandId: "CMD-Q01", level: "L0", title: "查看审查报告" },
  read_gacha: { commandId: "CMD-Q01", level: "L0", title: "查看卡池（抽到的卡）" },
  eval: { commandId: "CMD-S09", level: "L0", title: "整书质量评估", action: { endpoint: "/api/novel/eval", method: "POST", body: {} } },
  edit_world: { commandId: "CMD-W12", level: "L2", title: "编辑设定/角色", action: { endpoint: "/api/novel/world", method: "POST", body: {} } },
  delete_chapter: { commandId: "CMD-N08", level: "L3", title: "删除章节", action: { endpoint: "/api/novel/chapter/delete", method: "POST", body: { phase: "preview" } } },
  regenerate: { commandId: "CMD-N05", level: "L2", title: "AI 重写章节", action: { endpoint: "/api/novel/chapter/regenerate", method: "POST", body: {} } },
  rewrite: { commandId: "CMD-G06", level: "L2", title: "回溯重写（消费重写队列）", action: { endpoint: "/api/novel/rewrite", method: "POST", body: { action: "start" } } },
  autoskip: { commandId: "CMD-N14", level: "L1", title: "跳过连载草稿章", action: { endpoint: "/api/novel/auto/skip", method: "POST", body: {} } },
  resettle: { commandId: "CMD-L03", level: "L2", title: "重算本章账本", action: { endpoint: "/api/novel/chapter/resettle", method: "POST", body: {} } },
  media_image: { commandId: "CMD-M02", level: "L0", title: "生成章节插画", action: { endpoint: "/api/novel/media/generate", method: "POST", body: { kind: "image" } } },
  media_video: { commandId: "CMD-M03", level: "L0", title: "生成章节视频", action: { endpoint: "/api/novel/media/generate", method: "POST", body: { kind: "video" } } },
  integrity: { commandId: "CMD-S01", level: "L0", title: "一致性巡检", action: { endpoint: "/api/novel/integrity", method: "POST", body: { action: "scan" } } },
  export: { commandId: "CMD-Q03", level: "L0", title: "导出全书", action: { endpoint: "/api/novel/export", method: "POST", body: { format: "md" } } },
  foreshadow_edit: { commandId: "CMD-L07", level: "L1", title: "伏笔增删改", action: { endpoint: "/api/novel/foreshadow", method: "POST", body: {} } },
  task_ops: { commandId: "CMD-G06", level: "L2", title: "处理任务（重写队列/质量债）" },
  draft_confirm: { commandId: "CMD-N04", level: "L2", title: "确认/放弃待入册草稿" },
  expand_arc: { commandId: "CMD-W05", level: "L1", title: "展开弧章纲" },
  settings: { commandId: "CMD-W12", level: "L0", title: "调整生成参数" },
  plan: { commandId: "CMD-W01", level: "L0", title: "制定计划/给方案" },
  opinion: { commandId: "CMD-Q09", level: "L0", title: "征求/给出意见" },
  chat: { commandId: "CMD-Q09", level: "L0", title: "对话" },
};

const INTENT_ENUM = Object.keys(INTENTS);

/** 简短世界摘要（供意图识别上下文） */
function worldSummary(w: WorldState): string {
  return [
    `《${w.title}》(${w.genre})，已写 ${w.chapters.length} 章`,
    `角色 ${w.characters.length} 个：${w.characters.slice(0, 6).map((c) => c.name).join("、")}`,
    `伏笔 ${w.foreshadowing.length} 条（活跃 ${w.foreshadowing.filter((f) => f.status !== "resolved").length}）`,
    `梗概：${w.premise.slice(0, 80)}`,
  ].join("\n");
}

/** 意图 → 中文语义提示（供意图识别参考，提升中文口语命中率） */
const INTENT_HINT: Record<string, string> = {
  advance: "推进剧情（写一章）",
  autostart: "开始自动连载",
  autostop: "停止连载",
  autopause: "暂停连载",
  gacha: "抽卡（生成卡池）",
  read_chapter: "浏览/查看章节内容",
  read_character: "浏览/查看角色",
  read_foreshadow: "查看伏笔情况",
  read_proposals: "查看新角色提案列表/有哪些角色推荐/列出提案（看内容）",
  open_proposals: "打开新角色提案/新角色提案（仅打开底部提案面板，不列列表）",
  read_chapters: "浏览/查看章节列表/章节目录/写到哪了/目录",
  read_characters: "浏览/查看角色列表/有哪些角色/登场角色",
  read_plans: "查看计划/章纲进度/弧线/接下来怎么写/大纲进度",
  read_tasks: "查看任务/质量债/重写队列/弥合任务/有什么要处理的",
  read_logs: "查看台账/操作日志/变更记录/最近做了什么",
  read_worldbook: "查看设定/世界书/世界观/规则",
  read_media: "查看媒体资源/插画/视频/立绘/配图",
  read_review: "查看审查报告/评分/审查意见/这章评价",
  read_gacha: "查看抽到的卡/查看卡池/应用卡牌/抽卡结果/看看抽到了什么/卡池里有什么",
  eval: "整书质量评估",
  edit_world: "编辑设定/角色",
  delete_chapter: "删除章节",
  regenerate: "AI 重写章节",
  rewrite: "回溯重写/重写队列/按计划重写/处理重写任务/重新写那几章",
  autoskip: "跳过草稿/跳过这章/放弃草稿/不要这章草稿/跳过连载章",
  resettle: "重算本章账本",
  media_image: "生成章节插画",
  media_video: "生成章节视频",
  integrity: "一致性巡检",
  export: "导出全书",
  foreshadow_edit: "伏笔增删改",
  task_ops: "处理任务/重写队列/修复质量债/清空重写队列",
  draft_confirm: "确认入册/确认草稿/放弃草稿/拒绝草稿/入册",
  expand_arc: "展开弧/展开章纲/生成章节计划",
  settings: "调整生成参数/修改设置/字数/温度/视角/审查严格度",
  plan: "制定计划/给几个方案/接下来怎么写/规划下一步/给点建议",
  opinion: "征求意见/你觉得呢/要不要继续/这个方案行不行/选哪个好",
  chat: "纯对话（无操作）",
};

const INTENT_SYSTEM = `你是小说创作引擎「墨枢」的中枢对话编排器。根据用户输入识别意图，从以下动作中选择最匹配的一个：
${INTENT_ENUM.map((k) => `- ${k}：${INTENT_HINT[k] ?? k}`).join("\n")}

输出合法 JSON：{"intent":"动作名","params":{...},"reply":"一句话自然语言回复（中文）"}
- params：从用户输入中提取动作参数（需求 2：自动提取工具参数）：
  · read_chapter / read_review / regenerate / delete_chapter → {index: 第几章}（数字）
  · read_character → {name:"角色名"}
  · media_image（生成插画）→ {chapterIndex: 第几章, count: 张数}；media_video（生成视频）→ {chapterIndex: 第几章}
  · autostart → {maxChapters: 章数}；gacha → {count: 张数}
  · 用户未指定具体章节时，**不要填 chapterIndex**（系统会自动用其当前选中的章节兜底）
- 「打开新角色提案」「新角色提案」「打开提案面板」等**打开类**表达（用户想直接看底部面板）→ intent 为 "open_proposals"，reply 用一句话说明已打开
- 「有哪些角色推荐」「列出提案」「查看提案内容」等**查询列表**表达 → intent 为 "read_proposals"（在聊天中列提案卡）
- intent 为 "chat" 时 params 为空对象，reply 直接回答用户问题
- 无法确定具体操作时选 "chat"
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

type IntentResult = { intent: string; params: Record<string, unknown>; reply: string };

/** 意图识别（LLM）；失败降级为 chat。
 *  ctx：前端上下文（选中章）——用户未指定章节时作为参数兜底（需求 1/2）；
 *  history：最近会话文本（支持「上一章/刚说的那个」类指代）。 */
async function recognizeIntent(w: WorldState, prompt: string, ctx?: { chapterIndex?: number | null }, history?: string[]): Promise<IntentResult> {
  try {
    const ctxLines: string[] = [];
    if (history?.length) ctxLines.push(`最近对话：\n${history.join("\n")}`);
    if (typeof ctx?.chapterIndex === "number" && Number.isInteger(ctx.chapterIndex)) {
      ctxLines.push(`用户当前选中的章节：第 ${ctx.chapterIndex} 章（用户未指定章节的操作默认作用于该章）`);
    }
    const ctxBlock = ctxLines.length ? `\n\n${ctxLines.join("\n\n")}` : "";
    const out = await brainChatDeps.chatJson<{ intent?: string; params?: Record<string, unknown>; reply?: string }>(
      [
        { role: "system", content: INTENT_SYSTEM },
        { role: "user", content: `用户输入：${prompt}${ctxBlock}\n\n当前世界：\n${worldSummary(w)}` },
      ],
      {
        ...taskOpts("brainGate"),
        maxTokens: 2000,
        schema: {
          type: "object",
          required: ["intent", "reply"],
          properties: {
            intent: { type: "string", enum: INTENT_ENUM },
            params: { type: "object" },
            reply: { type: "string" },
          },
        },
      },
    );
    return {
      intent: INTENT_ENUM.includes(out.intent ?? "") ? (out.intent as string) : "chat",
      params: (out.params ?? {}) as Record<string, unknown>,
      reply: (out.reply ?? "").trim(),
    };
  } catch {
    // 降级：纯对话
    return { intent: "chat", params: {}, reply: "（中枢意图识别暂不可用，请直接操作或稍后重试）" };
  }
}

/** 目标处置三态（轻量内联，避免引入 brain.ts→planner→agnes 重依赖；与 brain-state 口径一致） */
function brainDisposition(w: WorldState): "continue" | "complete" | "blocked" {
  const vols = w.blueprint?.volumes ?? [];
  if (vols.length > 0 && vols.every((v) => v.status === "done") && (w.foreshadowing ?? []).every((f) => f.status === "resolved")) return "complete";
  const t = w.goal?.structure?.targetChapters;
  if (t != null && w.nextChapter > t) return "blocked";
  return "continue";
}

/** 抽卡卡池 → 浏览卡（gacha）：每张带「应用此卡」，顶层带「全部应用（AI 优选）」；
 *  供 executeQuery(read_gacha) 与 gacha 意图特判共用（聊天内完成 生成→浏览→应用 闭环） */
function gachaBrowseCard(pool: WorldCard[], title: string): Record<string, unknown> {
  const list = pool.map((c) => ({
    id: c.id,
    type: c.type,
    rarity: c.rarity,
    title: c.title,
    description: c.description,
    effect: c.effect,
    dueHint: c.dueHint,
    character: c.character,
    actions: [
      { label: "应用此卡", action: { endpoint: "/api/novel/gacha", method: "POST", body: { title, action: "apply", pick: [c.id] } } },
    ],
  }));
  return {
    kind: "browse",
    title: `抽卡卡池（${pool.length} 张）`,
    browseType: "gacha",
    data: { list },
    actions: [
      { label: "全部应用（AI 优选）", action: { endpoint: "/api/novel/gacha", method: "POST", body: { title, action: "apply", auto: true } } },
    ],
  };
}

/** L0 查询直接执行 → BrowseCard / ResultCard */
export function executeQuery(w: WorldState, intent: string, params: Record<string, unknown>): Record<string, unknown> | null {
  /** 目标章数：goal 显式目标 > 弧线估计合计 > 章纲总数；无则 null（前端不显示进度条） */
  const targetChapters = (): number | null => {
    const t = w.goal?.structure?.targetChapters;
    if (t != null && t > 0) return t;
    const est = (w.storyArcs ?? []).reduce((n, a) => n + (a.estChapters || 0), 0);
    if (est > 0) return est;
    const plans = (w.chapterPlans ?? []).length;
    return plans > 0 ? plans : null;
  };
  if (intent === "read_chapter") {    const idx = Number(params.index);
    const ch = w.chapters.find((c) => c.index === idx);
    if (!ch) return { kind: "result", title: "未找到章节", success: false, detail: `第 ${idx} 章不存在` };
    return { kind: "browse", title: `第${ch.index}章 · ${ch.title}`, browseType: "chapter", data: { index: ch.index, title: ch.title, text: ch.text } };
  }
  if (intent === "read_character") {
    const name = String(params.name ?? "");
    const c = w.characters.find((x) => x.name.includes(name) || name.includes(x.name));
    if (!c) return { kind: "result", title: "未找到角色", success: false, detail: `没有叫「${name}」的角色` };
    const card: Record<string, unknown> = {
      kind: "browse", title: `${c.name} · ${c.role}`, browseType: "character",
      data: { name: c.name, role: c.role, motivation: c.motivation, status: c.status },
    };
    // 附图：角色立绘（portrait）优先，其次头像（image）——data URI 直接可显示
    const mediaPath = c.portrait?.path ?? c.image;
    if (mediaPath) {
      card.image = { src: mediaDataUri(w.title, { id: "", kind: "image", anchor: c.name, path: mediaPath, status: "ready" }), alt: `${c.name} 立绘` };
    }
    return card;
  }
  if (intent === "read_foreshadow") {
    const list = w.foreshadowing.map((f) => ({
      id: f.id, text: f.text, status: f.status, plantedAt: f.plantedAt,
      pending: isPendingForeshadow(w, f),
    }));
    return { kind: "browse", title: `伏笔账本（${list.length} 条）`, browseType: "foreshadow", data: { list } };
  }
  if (intent === "read_proposals") {
    // 新角色提案：pending 列表 + 每项内嵌确认/拒绝操作（卡片可交互，允许操作）
    const list = (w.characterProposals ?? [])
      .filter((p) => p.status === "pending")
      .map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        reason: p.reason ?? "",
        motivation: p.motivation,
        source: p.source,
        actions: [
          { label: "确认入册", action: { endpoint: "/api/novel/proposal", method: "POST", body: { title: w.title, proposalId: p.id, action: "confirm" } } },
          { label: "拒绝", danger: true, action: { endpoint: "/api/novel/proposal", method: "POST", body: { title: w.title, proposalId: p.id, action: "reject" } } },
        ],
      }));
    if (!list.length) return { kind: "result", title: "暂无新角色提案", success: false, detail: "当前没有待确认的新角色提案，抽卡或推进剧情可能产生提案。" };
    return { kind: "browse", title: `新角色提案（${list.length} 项）`, browseType: "proposal", data: { list } };
  }
  if (intent === "read_gacha") {
    // 抽卡卡池：pendingCards 浏览 + 逐张应用/全部应用（聊天内完成「生成 → 浏览 → 应用」闭环）
    const pool = w.pendingCards ?? [];
    if (!pool.length) {
      return { kind: "result", title: "暂无卡池", success: false, detail: "当前没有待应用的卡池，说「抽卡」先生成卡池。" };
    }
    return gachaBrowseCard(pool, w.title);
  }
  if (intent === "read_chapters") {
    // 章节目录：状态/审查分/字数/媒体数 + 章进度（done/target）
    const list = w.chapters.map((ch) => ({
      index: ch.index,
      title: ch.title,
      status: ch.review && ch.review.verdict === "revise" ? "需修订" : "已入册",
      score: ch.review?.scores?.coherence ?? null,
      words: ch.text.length,
      media: (ch.media ?? []).length,
    }));
    return { kind: "browse", title: `章节目录（${w.chapters.length} 章）`, browseType: "chapters", data: { done: w.chapters.length, target: targetChapters(), list } };
  }
  if (intent === "read_characters") {
    // 角色列表：定位/状态/形象/出场次数 + 统计网格
    const list = w.characters.map((c) => ({
      name: c.name, role: c.role, status: c.status ?? "在世",
      gender: c.gender, age: c.age, identity: c.identity,
      portrait: !!(c.portrait?.path || c.image), appeared: (c.appearedIn ?? []).length,
    }));
    return {
      kind: "browse", title: `角色列表（${list.length} 个）`, browseType: "characters",
      data: { stats: { total: list.length, withPortrait: list.filter((c) => c.portrait).length, appeared: list.filter((c) => c.appeared > 0).length }, list },
    };
  }
  if (intent === "read_plans") {
    // 计划/章纲进度：指南针 + 卷 + 弧 + 章纲（done/total）
    const volumes = (w.blueprint?.volumes ?? []).map((v) => ({ title: v.title, status: v.status, goal: v.goal, range: v.chapterRange ?? null }));
    const arcs = (w.storyArcs ?? []).map((a) => ({ title: a.title, status: a.status, estChapters: a.estChapters, goal: a.goal }));
    const plans = (w.chapterPlans ?? []).map((p) => ({ index: p.index, goal: p.goal, status: p.status, hookType: p.hookType }));
    const done = plans.filter((p) => p.status === "done").length;
    const next = (w.chapterPlans ?? []).find((p) => p.status !== "done");
    return {
      kind: "browse", title: `计划与章纲进度（${done}/${plans.length}）`, browseType: "plans",
      data: {
        compass: w.blueprint?.compass, progressContract: w.blueprint?.progressContract,
        volumes, arcs, plans, done, total: plans.length,
        next: next ? { index: next.index, goal: next.goal, hookType: next.hookType } : null,
      },
    };
  }
  if (intent === "read_tasks") {
    // 任务中心：质量债（内嵌 fix/ignore 操作）+ 重写队列 + 弥合任务
    const openDebt = (w.qualityDebt ?? []).filter((d) => d.status === "open");
    const list = openDebt.map((d) => ({
      id: d.id, chapterIndex: d.chapterIndex, lens: d.lens, issue: d.issue, severity: d.severity,
      actions: [
        { label: "标记已修", action: { endpoint: "/api/novel/debt", method: "POST", body: { title: w.title, id: d.id, action: "fix" } } },
        { label: "忽略", danger: true, action: { endpoint: "/api/novel/debt", method: "POST", body: { title: w.title, id: d.id, action: "ignore" } } },
      ],
    }));
    const mergeTasks: string[] = [];
    for (const p of w.chapterPlans ?? []) if (p.mergeTasks?.length) mergeTasks.push(...p.mergeTasks.map((t) => `第${p.index}章：${t}`));
    return {
      kind: "browse", title: `任务中心（质量债 ${list.length} · 重写 ${(w.rewriteQueue ?? []).length}）`, browseType: "tasks",
      data: {
        debt: list, major: list.filter((d) => d.severity === "major").length,
        rewriteQueue: w.rewriteQueue ?? [], mergeTasks,
        goal: { disposition: brainDisposition(w), chapterCount: w.chapters.length, target: targetChapters() },
      },
    };
  }
  if (intent === "read_logs") {
    // 台账·操作日志：最近 50 条（倒序）
    const list = (w.changeLog ?? []).slice(-50).reverse().map((e) => ({
      at: e.at, chapter: e.chapter, actor: e.actor, kind: e.kind, detail: e.detail,
      commandId: e.commandId, level: e.level, reason: e.reason,
    }));
    return { kind: "browse", title: `台账 · 操作日志（最近 ${list.length} 条）`, browseType: "logs", data: { list } };
  }
  if (intent === "read_worldbook") {
    // 设定·世界书：setting + lore 条目
    const lore = (w.lore ?? []).map((l) => ({ keywords: l.keywords, content: l.content, enabled: l.enabled }));
    return {
      kind: "browse", title: "设定 · 世界书", browseType: "worldbook",
      data: {
        setting: { time: w.setting.time, place: w.setting.place, tone: w.setting.tone, rules: w.setting.rules },
        lore,
      },
    };
  }
  if (intent === "read_media") {
    // 媒体资源：章节插画/视频 + 角色立绘统计
    const list: Record<string, unknown>[] = [];
    let images = 0, videos = 0;
    for (const ch of w.chapters) {
      for (const m of ch.media ?? []) {
        if (m.kind === "video") videos++; else images++;
        list.push({ kind: m.kind, chapter: ch.index, title: ch.title, caption: m.caption ?? "", status: m.status ?? "ready" });
      }
    }
    const withPortrait = w.characters.filter((c) => c.portrait?.path || c.image).length;
    return {
      kind: "browse", title: `媒体资源（插画 ${images} · 视频 ${videos}）`, browseType: "media",
      data: { stats: { images, videos, characters: withPortrait }, list: list.slice(0, 60) },
    };
  }
  if (intent === "read_review") {
    // 审查报告：指定章（params.index）或最近一章
    const idx = params.index != null && params.index !== "" ? Number(params.index) : w.chapters.length;
    const ch = w.chapters.find((c) => c.index === idx);
    if (!ch || !ch.review) return { kind: "result", title: "暂无审查报告", success: false, detail: `第 ${idx} 章还没有审查记录` };
    const r = ch.review;
    return {
      kind: "browse", title: `第${ch.index}章审查报告 · ${r.verdict === "pass" ? "通过" : "需修订"}（第 ${r.round} 轮）`, browseType: "review",
      data: { verdict: r.verdict, scores: r.scores, findings: r.findings, round: r.round },
    };
  }
  if (intent === "eval") {
    const report = readEvalReport(w.title);
    if (!report) return { kind: "result", title: "暂无评估", success: false, detail: "尚未进行整书评估，可在评估面板发起" };
    return { kind: "browse", title: "整书评估", browseType: "eval", data: { overall: report.overall, dimensions: report.dimensions } };
  }
  return null;
}

/** 中枢对话上下文：会话 + 连接 + 中断信号 */
export type BrainChatContext = {
  title: string;
  prompt: string;
  sessionId: string;
  send: (obj: unknown) => void;
  /** 外部取消信号（“停止生成”）：abort 时终止 LLM 调用并标记消息中断 */
  signal?: AbortSignal;
  /** resume 模式：复用最后一条未完成 assistant 消息重新生成（不重复写用户消息，前端先 reset 再收 delta） */
  resume?: boolean;
  /** 前端上下文（左侧栏选中章等）：意图识别/参数提取兜底（需求 1/2：未指定章节的操作默认用选中章） */
  ctx?: { chapterIndex?: number | null };
};

/** 纯对话系统提示：中枢以「墨枢」身份自然回答，允许 Markdown 富文本 */
const CHAT_SYSTEM = `你是小说创作引擎「墨枢」的中枢（brain），正在与用户对话，话题围绕当前小说的创作与治理。
回答要求：
- 自然、简洁、有判断力；创作建议给出具体可行的方案
- 可使用 Markdown 组织内容（标题/列表/表格/引用/代码块/图片 ![]()），便于前端渲染
- 涉及多方案取舍时先给出推荐并简述理由`;

/**
 * LLM/存储依赖注入点（测试替身用）：生产默认走真实实现；
 * 测试通过替换本对象避免 mock.module 全局污染（Bun mock.module 为进程级注册）。
 */
export const brainChatDeps = {
  chatJson,
  chatStream,
  loadWorld,
  gachaGenerate: directorGachaGenerate,
};

/** 纯对话回复：真流式（chatStream 逐 delta），每 500ms 节流落盘一次 */
async function streamChatReply(ctx: BrainChatContext, messageId: string): Promise<void> {
  const { title, sessionId, prompt, send, signal } = ctx;
  let acc = "";
  let lastFlush = 0;
  await brainChatDeps.chatStream(
    [
      { role: "system", content: CHAT_SYSTEM },
      { role: "user", content: prompt },
    ],
    (delta) => {
      acc += delta;
      // 增量块（append:true）：前端拼接而非替换——避免每块重传累积全文导致传输体积线性膨胀（长文本后期卡顿）
      send({ type: "delta", messageId, text: delta, append: true });
      const now = Date.now();
      if (now - lastFlush > 500) {
        lastFlush = now;
        updateMessageText(title, sessionId, messageId, acc, true);
      } else {
        updateMessageText(title, sessionId, messageId, acc, false);
      }
    },
    { ...taskOpts("brainGate"), signal, temperature: 0.7, maxTokens: 20000, retries: 2 },
  );
  updateMessageText(title, sessionId, messageId, acc, true);
}

/** 可执行意图白名单（选项的 intent → action 映射用；无 action 的只读意图不提供执行） */
const CHOICE_INTENTS = Object.entries(INTENTS)
  .filter(([, m]) => m.action)
  .map(([k]) => k);

const CHOICE_SYSTEM = `你是小说创作引擎「墨枢」的中枢。根据用户请求，生成 2-3 个可执行选项（输出 JSON 数组），
每项格式：{"label":"选项短名","description":"一句话说明（做什么/效果）","intent":"可执行意图名"}
可用 intent（带对应动作）：${CHOICE_INTENTS.join("、")}
- 选项必须贴合用户请求，给出不同策略方向（如推进剧情/查看现状/生成媒体/暂停等）
- 无法映射到可用 intent 的选项用 "chat"（仅解释不执行）
输出合法 JSON 数组，字符串值内部用中文引号「」。`;

/** 计划/意见选项：LLM 生成 2-3 个可执行选项；失败降级为固定兜底 */
async function buildChoiceOptions(w: WorldState, prompt: string, kind: "plan" | "opinion"): Promise<{ label: string; description: string; action?: CardAction }[]> {
  try {
    const out = await brainChatDeps.chatJson<{ options?: { label?: string; description?: string; intent?: string }[] }>(
      [
        { role: "system", content: CHOICE_SYSTEM },
        { role: "user", content: `请求：${prompt}\n\n当前世界：\n${worldSummary(w)}` },
      ],
      {
        ...taskOpts("brainGate"),
        maxTokens: 2000,
        schema: {
          type: "object",
          required: ["options"],
          properties: { options: { type: "array", items: { type: "object" } } },
        },
      },
    );
    const list: { label: string; description: string; action?: CardAction }[] = [];
    for (const o of (out.options ?? []).slice(0, 3)) {
      const meta = INTENTS[o.intent ?? ""];
      const label = (o.label ?? "").trim();
      if (!label) continue;
      if (meta?.action) list.push({ label, description: (o.description ?? "").trim(), action: { ...meta.action, body: { ...meta.action.body, title: w.title } } });
      else list.push({ label, description: (o.description ?? "").trim() });
    }
    if (list.length) return list;
    throw new Error("空选项");
  } catch {
    // 降级：确定性兜底（对齐 fallback: deterministic）
    if (kind === "opinion") {
      return [
        { label: "保持现状", description: "继续当前节奏，暂不调整" },
        { label: "重新考虑", description: "回到上一步重新决策" },
        { label: "给出建议", description: "让中枢推荐一个方向", action: { endpoint: "/api/novel/step", method: "POST", body: { title: w.title } } },
      ];
    }
    return [
      { label: "推进一章", description: "按当前大纲写下一章", action: { endpoint: "/api/novel/step", method: "POST", body: { title: w.title } } },
      { label: "查看现状", description: "浏览章节与角色进度" },
      { label: "继续对话", description: "与中枢深入讨论方向" },
    ];
  }
}

/** 从最近对话历史中提取角色名（用户刚提到过的角色，最长名优先），供表单参数预填（需求：信息可从对话收集） */
export function extractNameFromHistory(w: WorldState, userHist?: string[]): string {
  if (!userHist?.length) return "";
  const names = w.characters
    .map((c) => c.name)
    .filter((n): n is string => !!n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (let i = userHist.length - 1; i >= 0; i--) {
    const text = userHist[i] ?? "";
    for (const n of names) {
      if (text.includes(n)) return n;
    }
  }
  return "";
}

/** 表单卡构建：edit_world（角色/设定）、foreshadow_edit（伏笔增删改）走结构化表单，
 * 前端填写 → 提交 → 结果回执（L2/L3 端点返回 needIntervention 时自动衔接确认卡）。
 * opts.userHist：最近用户对话原文（表单参数可从对话历史收集预填，如角色名）；
 * opts.prompt：本次用户输入（用于判断是否该主动询问补充信息）。 */
export function buildFormCard(w: WorldState, intent: string, params: Record<string, unknown>, summary?: string, opts?: { userHist?: string[]; prompt?: string }): FormCardData | null {
  if (intent === "edit_world") {
    // 角色编辑：params.name 定位角色 → 结构化字段（只读标识 + 可编辑字段）
    // 缺名时先从最近对话历史收集（用户刚提过哪个角色，需求：信息可从对话收集）
    let name = String(params.name ?? "").trim();
    const fromHistory = !name ? extractNameFromHistory(w, opts?.userHist) : "";
    if (!name && fromHistory) name = fromHistory;
    if (name) {
      const c = w.characters.find((x) => x.name === name || name.includes(x.name));
      if (!c) {
        return {
          kind: "form", title: "编辑角色", commandId: "CMD-W12", level: "L2", summary: `没有找到叫「${name}」的角色，试试：「编辑角色 林墨」或先问「有哪些角色」`,
          fields: [], action: { endpoint: "/api/novel/world", method: "POST", body: { characters: [] } },
        };
      }
      const fields: FormFieldDef[] = [
        { key: "role", label: "定位", type: "text", value: c.role, placeholder: "主角 / 反派 / 配角 / 关键人物" },
        { key: "status", label: "当前状态", type: "text", value: c.status ?? "", placeholder: "如：调查中 / 负伤 / 离场" },
        { key: "gender", label: "性别", type: "select", value: c.gender, options: [{ label: "男", value: "男" }, { label: "女", value: "女" }] },
        { key: "age", label: "年龄", type: "text", value: c.age, placeholder: "如：二十出头 / 中年" },
        { key: "identity", label: "社会身份", type: "text", value: c.identity, placeholder: "如：东厂提督" },
        { key: "motivation", label: "动机", type: "textarea", value: c.motivation },
        { key: "look", label: "当前形象", type: "textarea", value: c.look ?? "" },
        { key: "voice", label: "声线/说话风格", type: "text", value: c.voice ?? "" },
      ];
      return {
        kind: "form", title: `编辑角色「${c.name}」`, commandId: "CMD-W12", level: "L2",
        summary: summary || (fromHistory
          ? `已从对话中识别出角色「${c.name}」，可直接修改下方信息。`
          : `修改「${c.name}」的信息，提交后写入世界（L2 回溯变更，影响已写章节时将请求确认）`),
        fields,
        action: { endpoint: "/api/novel/world", method: "POST", body: { characters: [{ id: c.id }] } },
        submitLabel: "保存角色",
        confirmRequired: true,
      };
    }
    // 用户明确要编辑角色但说不清是谁 → 返回 null，由中枢主动询问补充（而非误弹设定表单）
    if (/角色/.test(opts?.prompt ?? "")) return null;
    // 设定/全局编辑（无角色语境 → 设定表单）
    return {
      kind: "form", title: "编辑设定与全局信息", commandId: "CMD-W12", level: "L0",
      summary: summary || "修改故事设定/梗概/当前状态（L0 前瞻，不回溯已写章节）",
      fields: [
        { key: "premise", label: "梗概", type: "textarea", value: w.premise, array: false },
        { key: "current", label: "全局当前状态", type: "text", value: w.current ?? "", placeholder: "季节/天气/局势（单行）" },
        { key: "setting.time", label: "时代", type: "text", value: w.setting.time },
        { key: "setting.place", label: "地点", type: "text", value: w.setting.place },
        { key: "setting.tone", label: "基调", type: "text", value: w.setting.tone },
        { key: "setting.rules", label: "设定规则", type: "textarea", value: w.setting.rules, array: true, placeholder: "每行一条" },
      ],
      action: { endpoint: "/api/novel/world", method: "POST", body: {} },
      submitLabel: "保存设定",
    };
  }
  if (intent === "foreshadow_edit") {
    const action = String(params.action ?? "add");
    if (action === "add") {
      return {
        kind: "form", title: "新增伏笔", commandId: "CMD-L07", level: "L1",
        summary: summary || "登记一条新伏笔（默认埋设于最新已写章节）",
        fields: [
          { key: "text", label: "伏笔内容", type: "textarea", required: true, placeholder: "如：主角腕上的玉佩每逢满月发热" },
          { key: "plantedAt", label: "埋设章", type: "number", value: w.chapters.length ? Math.max(...w.chapters.map((c) => c.index)) : w.nextChapter },
          { key: "note", label: "备注", type: "text", placeholder: "可选" },
          { key: "dueHint", label: "建议回收时机", type: "text", placeholder: "可选，如：第 10 章前" },
        ],
        action: { endpoint: "/api/novel/foreshadow", method: "POST", body: { action: "add" } },
        submitLabel: "登记伏笔",
      };
    }
    const id = String(params.id ?? "");
    if (!id) {
      return {
        kind: "form", title: "伏笔增删改", commandId: "CMD-L07", level: "L1", summary: "修改/删除伏笔需要先指定伏笔 id：先问「查看伏笔情况」获取 id，再说「修改伏笔 <id>」或「删除伏笔 <id>」；说「新增伏笔」可直接登记",
        fields: [], action: { endpoint: "/api/novel/foreshadow", method: "POST", body: { action: "add" } },
      };
    }
    const f = w.foreshadowing.find((x) => x.id === id);
    if (action === "delete") {
      return {
        kind: "form", title: `删除伏笔「${f?.text?.slice(0, 30) ?? id}」`, commandId: "CMD-L07", level: "L1",
        summary: "确认后删除该伏笔（已埋入正文的伏笔需先回收）",
        fields: [], action: { endpoint: "/api/novel/foreshadow", method: "POST", body: { action: "delete", id } },
        submitLabel: "确认删除",
        confirmRequired: true,
      };
    }
    // update
    return {
      kind: "form", title: `修改伏笔「${f?.text?.slice(0, 30) ?? id}」`, commandId: "CMD-L07", level: "L1",
      summary: summary || "修改伏笔内容/备注/状态（状态联动回收章）",
      fields: [
        { key: "text", label: "伏笔内容", type: "textarea", value: f?.text ?? "" },
        { key: "note", label: "备注", type: "text", value: f?.note ?? "" },
        {
          key: "status", label: "状态", type: "select", value: f?.status ?? "planted",
          options: [{ label: "已埋设", value: "planted" }, { label: "推进中", value: "active" }, { label: "已回收", value: "resolved" }],
        },
        { key: "dueHint", label: "建议回收时机", type: "text", value: f?.dueHint ?? "" },
      ],
      action: { endpoint: "/api/novel/foreshadow", method: "POST", body: { action: "update", id } },
      submitLabel: "保存修改",
    };
  }
  if (intent === "task_ops") {
    const action = String(params.action ?? "");
    if (action === "rewrite" || params.rewrite === true) {
      const queue = w.rewriteQueue ?? [];
      return {
        kind: "form", title: "消费回溯重写队列", commandId: "CMD-G06", level: "L2",
        summary: queue.length ? `将按序重写第 ${queue.join("、")} 章（失败即停，剩余保留）` : "当前重写队列为空",
        fields: [], action: { endpoint: "/api/novel/rewrite", method: "POST", body: { action: "start" } },
        submitLabel: queue.length ? "开始重写" : "无任务",
        confirmRequired: queue.length > 0,
      };
    }
    if (action === "clear" || params.clear === true) {
      return {
        kind: "form", title: "清空重写队列", commandId: "CMD-G07", level: "L2",
        summary: "放弃队列中未重写的章节（已重写的不受影响）",
        fields: [], action: { endpoint: "/api/novel/rewrite", method: "POST", body: { action: "clear" } },
        submitLabel: "确认清空", confirmRequired: true,
      };
    }
    const id = String(params.id ?? "");
    if (id) {
      const debt = (w.qualityDebt ?? []).find((d) => d.id === id);
      return {
        kind: "form", title: "处理质量债", commandId: "CMD-G06", level: "L0",
        summary: debt ? `第 ${debt.chapterIndex} 章 · ${debt.lens}：${debt.issue}` : `未找到质量债 ${id}`,
        fields: [
          { key: "action", label: "处理方式", type: "select", value: "fix", options: [{ label: "标记已修", value: "fix" }, { label: "忽略", value: "ignore" }] },
        ],
        action: { endpoint: "/api/novel/debt", method: "POST", body: { id } },
        submitLabel: "提交",
      };
    }
    return {
      kind: "form", title: "任务中心", commandId: "CMD-G06", level: "L2",
      summary: "重写队列与质量债操作：说「消费重写队列」「清空重写队列」，或先问「有什么任务」查看清单后指定质量债 id",
      fields: [], action: { endpoint: "/api/novel/rewrite", method: "POST", body: { action: "start" } },
    };
  }
  if (intent === "draft_confirm") {
    const action = String(params.action ?? "confirm");
    const isConfirm = action !== "reject" && action !== "abort";
    return {
      kind: "form", title: isConfirm ? "确认草稿入册" : "放弃待确认草稿", commandId: "CMD-N04", level: "L2",
      summary: isConfirm ? "将暂存区的待确认草稿正式入册（完整记账）" : "放弃暂存区草稿（不入册，章节号保留可重新推进）",
      fields: [],
      action: { endpoint: isConfirm ? "/api/novel/chapter/confirm" : "/api/novel/chapter/reject", method: "POST", body: {} },
      submitLabel: isConfirm ? "确认入册" : "确认放弃",
      confirmRequired: true,
    };
  }
  if (intent === "expand_arc") {
    const arcId = String(params.arcId ?? "");
    const target = arcId ? (w.storyArcs ?? []).find((a) => a.id === arcId) : (w.storyArcs ?? []).find((a) => a.status === "skeleton");
    return {
      kind: "form", title: "展开弧章纲", commandId: "CMD-W05", level: "L1",
      summary: target ? `展开「${target.title}」为 3-6 章章纲` : "当前没有可展开的弧（需 status=skeleton 的骨架弧）",
      fields: [], action: { endpoint: "/api/novel/plans", method: "POST", body: { action: "expand", arcId: target?.id ?? "" } },
      submitLabel: target ? "展开" : "无弧可展开",
    };
  }
  if (intent === "settings") {
    const g = w.gen ?? {};
    return {
      kind: "form", title: "生成参数设置", commandId: "CMD-W12", level: "L0",
      summary: summary || "调整生成参数（作用于后续章节，不回溯已写内容）",
      fields: [
        { key: "gen.minWords", label: "最少字数", type: "number", value: g.minWords },
        { key: "gen.maxWords", label: "最多字数", type: "number", value: g.maxWords },
        { key: "gen.temperature", label: "温度（0-2）", type: "number", value: g.temperature },
        { key: "gen.settingMode", label: "设定模式", type: "select", value: g.settingMode, options: [{ label: "历史真实", value: "历史真实" }, { label: "架空", value: "架空" }, { label: "混合", value: "混合" }] },
        { key: "gen.pov", label: "视角", type: "select", value: g.pov, options: [{ label: "第一人称", value: "第一人称" }, { label: "第三人称", value: "第三人称" }, { label: "第二人称", value: "第二人称" }] },
        { key: "gen.reviewStrictness", label: "审查严格度", type: "select", value: g.reviewStrictness, options: [{ label: "宽松", value: "宽松" }, { label: "标准", value: "标准" }, { label: "严格", value: "严格" }] },
        { key: "gen.autoGacha", label: "每章自动抽卡", type: "select", value: g.autoGacha ? "开" : "关", options: [{ label: "开", value: "开" }, { label: "关", value: "关" }], transform: "bool" },
      ],
      action: { endpoint: "/api/novel/world", method: "POST", body: {} },
      submitLabel: "保存参数",
    };
  }
  return null;
}

/** 从用户输入中提取章号（「第 N 章/第N章/N章」，支持阿拉伯数字与中文数字一~九十九；无则 null） */
const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function chapterIndexFromPrompt(prompt: string): number | null {
  // 阿拉伯数字：「第 5 章」「第12章」「第 3 回」（0 非法）
  const ar = prompt.match(/第\s*(\d{1,4})\s*[章回节]/);
  if (ar) {
    const n = Number(ar[1]);
    return n > 0 ? n : null;
  }
  // 中文数字：「第一章」「第三章」「第十二章」「第二十章」「二十五章」
  const cn = prompt.match(/第\s*([一二三四五六七八九十]{1,3})\s*[章回节]/);
  if (!cn) return null;
  const s = cn[1];
  if (s === "十") return 10;
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    const tens = a ? (CN_NUM[a] ?? 1) * 10 : 10;
    const ones = b ? CN_NUM[b] ?? 0 : 0;
    return tens + ones;
  }
  return null;
}

/**
 * 媒体生成表单卡（需求 1/2）：
 * - 章号解析优先级：LLM 提取的 params.chapterIndex → prompt 正则「第 N 章」→ 前端选中章（ctx）→ 最后一章
 * - 未指定章节时默认前端选中章；张数默认 1（需求 1）
 * - 提交后前端先调 /api/novel/media/plan 分镜 → preview 卡确认 → /api/novel/media/generate 生成（聊天内完整闭环）
 */
export function buildMediaCard(
  w: WorldState,
  intent: "media_image" | "media_video",
  params: Record<string, unknown>,
  prompt: string,
  ctx?: { chapterIndex?: number | null },
): FormCardData {
  const kind = intent === "media_image" ? "image" : "video";
  const chapters = [...w.chapters].sort((a, b) => a.index - b.index);
  const lastIdx = chapters.length ? chapters[chapters.length - 1].index : null;
  // 章号解析：LLM params → prompt 正则 → 前端选中章
  let idx: number | null = null;
  const raw = params.chapterIndex ?? params.chapter ?? params.index;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) idx = raw;
  else if (typeof raw === "string") {
    const n = Number(raw.replace(/[^\d]/g, ""));
    if (Number.isInteger(n) && n > 0) idx = n;
  }
  if (idx == null) idx = chapterIndexFromPrompt(prompt);
  if (idx == null && typeof ctx?.chapterIndex === "number" && Number.isInteger(ctx.chapterIndex) && ctx.chapterIndex > 0) {
    idx = ctx.chapterIndex;
  }
  const validIdx = idx != null && chapters.some((c) => c.index === idx) ? idx : null;
  // 张数：默认 1（需求 1）；video 恒 1 段
  const count = kind === "video" ? 1 : Math.max(1, Math.min(3, Number(params.count ?? 1) || 1));
  const fields: FormFieldDef[] = [
    {
      key: "chapterIndex",
      label: "章节",
      type: "select",
      value: validIdx ?? lastIdx ?? undefined,
      options: chapters.map((c) => ({ label: `第 ${c.index} 章 · ${c.title}`, value: String(c.index) })),
      required: true,
    },
  ];
  if (kind === "image") fields.push({ key: "count", label: "张数（1-3）", type: "number", value: count });
  const target = validIdx != null ? `第 ${validIdx} 章` : "当前章节";
  return {
    kind: "form",
    title: kind === "image" ? "生成章节插画" : "生成章节视频",
    commandId: intent === "media_image" ? "CMD-M02" : "CMD-M03",
    level: "L0",
    summary: `为「${target}」${kind === "image" ? `生成 ${count} 张插画` : "生成 1 段视频"}：提交后 AI 先从正文挑选关键场景，确认后开始生成（未指定章节时默认选中章节，可改）`,
    fields,
    action: { endpoint: "/api/novel/media/plan", method: "POST", body: { title: w.title, kind } },
    submitLabel: "挑选场景并生成",
  };
}

/** 卡片 JSON 扁平化提交：field.key 支持点路径（setting.time → { setting: { time } }），array 字段按行拆分 */
export function flattenFormValues(fields: FormFieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    let v = values[f.key];
    if (v == null) continue;
    if (f.array && typeof v === "string") {
      v = v.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    }
    if (f.transform === "bool") v = v === true || v === "开" || v === "true";
    if (f.type === "number" && typeof v === "string") {
      if (v.trim() === "") continue; // 数字字段留空 = 未修改，跳过
      const n = Number(v);
      v = Number.isFinite(n) ? n : v;
    }
    const parts = f.key.split(".");
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] ?? {};
      cur = cur[parts[i]] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/**
 * 中枢对话编排主流程（SSE，事件协议 v2）：
 * 1. 会话准备：新建会话或 resume 复用未完成消息
 * 2. 意图识别（{type:"intent"}）
 * 3. chat 意图 → 真流式回复；操作意图 → reply 一次性 delta + 卡片
 * 4. 回合完成 {done} / 中断 {interrupted}；增量写入会话（brain-sessions 持久化）
 */
export async function brainChatStream(ctx: BrainChatContext): Promise<void> {
  const { title, prompt, sessionId, send, signal, resume } = ctx;
  const w = brainChatDeps.loadWorld(title);
  if (!w) {
    send({ error: "故事不存在: " + title });
    return;
  }

  // —— 会话准备 ——
  let session = getSession(title, sessionId);
  let messageId: string;
  let activePrompt = prompt;
  if (resume) {
    if (!session) {
      send({ error: "会话不存在或已删除" });
      return;
    }
    // 复用最后一条未完成消息（pending=进行中 / interrupted=被中断），重新生成并替换
    const pending = lastIncompleteMessage(session);
    if (!pending) {
      send({ error: "该会话没有待续流消息" });
      return;
    }
    messageId = pending.id;
    // 前端清空该消息，后续 delta 重新填充（避免已生成文本与新流重复拼接）
    send({ type: "reset", messageId });
    // 用最后一条用户输入作为回复上下文
    const lastUser = lastUserMessage(session);
    if (lastUser) activePrompt = lastUser.text;
  } else {
    // 用前端传入的 sessionId 创建（前端预生成 UUID，一次请求拿回完整会话）
    if (!session) session = createSession(title, prompt, sessionId);
    appendMessage(title, sessionId, { id: uid(), role: "user", text: prompt, at: Date.now() });
    messageId = uid();
    appendMessage(title, sessionId, { id: messageId, role: "assistant", text: "", at: Date.now(), pending: true });
    markStreaming(title, sessionId);
  }

  try {
    send({ type: "intent" });

    // —— 意图识别（注入前端选中章 + 最近会话上下文，供 LLM 自动提取工具参数，需求 2） ——
    const hist = (session?.messages ?? []).slice(-6).map((m) => `${m.role === "user" ? "用户" : "中枢"}：${(m.text ?? "").slice(0, 200)}`);
    const { intent, params, reply } = await recognizeIntent(w, activePrompt, ctx.ctx, hist);

    // 纯对话 / 未知意图：真流式回复（可中断、可恢复）
    const meta = INTENTS[intent];
    if (intent === "chat" || !meta) {
      await streamChatReply({ ...ctx, prompt: activePrompt }, messageId);
      markMessageDone(title, sessionId, messageId);
      send({ type: "done", messageId });
      return;
    }

    // 计划/意见询问：回复文本 + 可执行选项卡（遵循用户意见）
    if (intent === "plan" || intent === "opinion") {
      const text = reply || meta.title;
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      const options = await buildChoiceOptions(w, activePrompt, intent);
      const card: BrainChatCard = {
        kind: intent,
        title: intent === "plan" ? "计划选项" : "意见征询",
        summary: reply || meta.title,
        options,
      };
      markMessageDone(title, sessionId, messageId, [card]);
      send({ type: "card", messageId, card });
      send({ type: "done", messageId });
      return;
    }

    // 抽卡：聊天内完整闭环——直接生成卡池 → 浏览卡（逐张应用/全部应用），不走 preview 卡
    if (intent === "gacha") {
      const text = reply || meta.title;
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      const count = Math.max(1, Math.min(Number(params.count ?? 4) || 4, 6));
      const types = Array.isArray(params.types)
        ? (params.types.map(String).filter((t) => ["角色", "发展方向", "伏笔", "章节", "道具", "场景"].includes(t)) as CardType[])
        : undefined;
      const w2 = brainChatDeps.loadWorld(title);
      if (!w2) {
        markMessageDone(title, sessionId, messageId, []);
        send({ type: "done", messageId });
        return;
      }
      try {
        const { pool } = await brainChatDeps.gachaGenerate(w2, { count, types });
        const card = gachaBrowseCard(pool, title);
        markMessageDone(title, sessionId, messageId, [card]);
        send({ type: "card", messageId, card });
      } catch (e) {
        markMessageDone(title, sessionId, messageId, []);
        send({ error: `抽卡失败：${(e as Error).message}`, messageId });
      }
      send({ type: "done", messageId });
      return;
    }

    // 媒体生成（插画/视频）：form 卡收集章节+张数 → 前端分镜 → preview 确认 → 生成（需求 1/2）。
    // 未指定章节时默认前端选中章、默认 1 张；不在此处同步调分镜（LLM 分镜耗时长，避免 SSE 长挂）
    if (intent === "media_image" || intent === "media_video") {
      const text = reply || meta.title;
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      const card = buildMediaCard(w, intent, params, activePrompt, ctx.ctx);
      markMessageDone(title, sessionId, messageId, [card]);
      send({ type: "card", messageId, card });
      send({ type: "done", messageId });
      return;
    }

    // 表单类（编辑设定/角色/伏笔/任务/草稿/章纲/参数）：reply 开场 + 结构化表单卡（字段→填写→提交→结果回执）
    if (["edit_world", "foreshadow_edit", "task_ops", "draft_confirm", "expand_arc", "settings"].includes(intent)) {
      const text = reply || meta.title;
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      // 从对话历史收集表单参数：最近用户消息原文（供 buildFormCard 预填角色名等，需求：信息可从对话收集）
      const userHist = (session?.messages ?? []).filter((m) => m.role === "user").slice(-5).map((m) => m.text ?? "");
      const card = buildFormCard(w, intent, params, reply, { userHist, prompt: activePrompt });
      if (card) {
        markMessageDone(title, sessionId, messageId, [card]);
        send({ type: "card", messageId, card });
      } else {
        // 信息不足：中枢主动询问补充（自然对话流，不弹误导表单）
        await streamChatReply({ ...ctx, prompt: `用户想要「${meta.title}」，但缺少必要信息（如具体要编辑哪个角色、哪条伏笔）。请用一到两句自然的中文，询问用户需要补充的具体信息。不要执行任何操作。` }, messageId);
        markMessageDone(title, sessionId, messageId);
      }
      send({ type: "done", messageId }); // card 分支与询问分支共用一次 done
      return;
    }

    // 操作意图：reply 作为开场回复（一次性 delta，前端打字机动画）
    const text = reply || meta.title;
    if (text) {
      updateMessageText(title, sessionId, messageId, text, true);
      send({ type: "delta", messageId, text });
    }

    const cards: BrainChatCard[] = [];

    // 打开新角色提案：纯 UI 动作——只回复 + 发「已打开」result 卡（前端检测到该卡 → 恢复底部提案区），不列提案列表
    if (intent === "open_proposals") {
      const text = reply || meta.title;
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      const card: BrainChatCard = {
        kind: "result", title: "新角色提案", success: true,
        detail: "已为你打开底部新角色提案面板，可在其中查看推荐原因与确认/拒绝。",
      };
      markMessageDone(title, sessionId, messageId, [card]);
      send({ type: "card", messageId, card });
      send({ type: "done", messageId });
      return;
    }

    // L0 查询类：直接执行 → BrowseCard/ResultCard
    if (meta.level === "L0" && !meta.action) {
      const card = executeQuery(w, intent, params);
      if (card) {
        cards.push(card);
        send({ type: "card", messageId, card });
      }
    } else {
      // 写操作（L0 有 action 的如 gacha/eval/integrity 也走预览卡，客户端执行）
      const needConfirm = meta.level === "L2" || meta.level === "L3";
      // 注入 params 到 action.body（title 放最后确保不被 LLM 返回的 params 覆盖）
      const body: Record<string, unknown> = { ...meta.action?.body, ...params, title };
      const preview: BrainChatCard = {
        kind: "preview",
        title: meta.title,
        commandId: meta.commandId,
        level: meta.level,
        summary: reply || meta.title,
        confirmRequired: needConfirm,
        action: meta.action ? { ...meta.action, body } : undefined,
      };
      cards.push(preview);
      send({ type: "card", messageId, card: preview });

      // L2/L3 额外下发确认卡（三选一；deleteChapter 用 abort，其他用 merge/rewrite/abort）
      if (needConfirm) {
        const options: ("merge" | "rewrite" | "abort")[] = intent === "delete_chapter" ? ["abort"] : ["merge", "rewrite", "abort"];
        const confirm: BrainChatCard = {
          kind: "confirm",
          title: `${meta.title} · 确认`,
          commandId: meta.commandId,
          level: meta.level,
          impact: `此操作为 ${meta.level} 级别（${meta.level === "L3" ? "不可逆" : "回溯性"}），将影响已写内容。`,
          options,
        };
        cards.push(confirm);
        send({ type: "card", messageId, card: confirm });
      }
    }

    markMessageDone(title, sessionId, messageId, cards);
    send({ type: "done", messageId });
  } catch (e) {
    // 用户取消：标记中断（保留已生成文本，前端可重新编辑）
    if (isAbort(e, signal)) {
      markMessageInterrupted(title, sessionId, messageId);
      send({ type: "interrupted", messageId });
      return;
    }
    // 其他错误：保留已生成文本并标记中断，同时回显错误（带 messageId，前端精确落到对应消息）
    console.error("[brain-chat] 回合失败:", e);
    markMessageInterrupted(title, sessionId, messageId);
    send({ error: e instanceof Error ? e.message : "内部错误，请稍后重试", messageId });
    send({ type: "interrupted", messageId });
  }
}
