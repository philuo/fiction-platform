// 中枢对话编排（brain-chat）：意图识别（LLM）+ supervised 执行编排
// POST /api/brain/chat（SSE）：用户 prompt → 意图识别 → 流式回复 + 卡片（查询直接执行 / 写操作预览 / L2·L3 确认卡）
// supervised（INTERVENTION_MODE 语义）：L0/L1 直接执行或预览，L2/L3 出确认卡；失败降级为纯对话
// 卡片 JSON 结构与 components/brain-cards.tsx 的 BrainCard 一致，前端直接渲染
//
// 事件协议（v2）：
//   { type: "intent" }                        # 意图识别开始（前端 loading）
//   { type: "delta", messageId, text }        # 回复增量：text=消息累计全文（前端打字机动画）
//   { type: "reasoning", messageId, text }    # 思维链增量（思考模式开启时）：与正文 delta 分离，前端折叠展示
//   { type: "card", messageId, card }         # 卡片（预览/确认/结果/浏览/计划/意见询问）
//   { type: "done", messageId }               # 回合完成（消息已落盘）
//   { type: "interrupted", messageId }        # 中断/出错（消息保留已生成文本，可重新编辑）
//   { type: "reset", messageId }              # resume：前端清空该消息，后续 delta 重新填充
//   { phase: "ping" } / { error }              # 心跳 / 致命错误（sseStream 层）
import { chatJson } from "./jsonutil";
import { chatStream } from "./agnes";
import { taskOpts } from "./modelconfig";
import { loadWorld, saveWorld, slugify as slug } from "./storage";
import { logChange } from "./steering";
import { withTitleLock } from "./titlelock";
import { readEvalReport } from "./eval";
import { genOf, isPendingForeshadow, targetChapterCount } from "./world";
import { mediaDataUri, MAX_IMAGES_PER_CHAPTER } from "./media";
import { imageOccupiesQuota } from "../shared/media-const";
import { gachaGenerate as directorGachaGenerate } from "./director";
import { uuid } from '../shared/uuid';
import type { CardType } from "./cards";
import type { Card as WorldCard, WorldState } from "./world";
import { extractRelationshipSubgraph } from "../shared/relationships";
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
  updateMessageThinking,
  type BrainChatCard,
} from "./brain-sessions";

const uid = () => uuid();

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
  read_appearances: { commandId: "CMD-Q01", level: "L0", title: "查看出场角色" },
  read_relationships: { commandId: "CMD-Q01", level: "L0", title: "查看人物关系" },
  read_outline: { commandId: "CMD-Q01", level: "L0", title: "查看大纲/蓝图" },
  read_timeline: { commandId: "CMD-Q01", level: "L0", title: "查看脉络/时间线" },
  read_review: { commandId: "CMD-Q01", level: "L0", title: "查看审查报告" },
  read_gacha: { commandId: "CMD-Q01", level: "L0", title: "查看卡池（抽到的卡）" },
  read_settings: { commandId: "CMD-Q01", level: "L0", title: "查看生成参数" },
  eval: { commandId: "CMD-S09", level: "L0", title: "整书质量评估", action: { endpoint: "/api/novel/eval", method: "POST", body: {} } },
  edit_world: { commandId: "CMD-W12", level: "L2", title: "编辑设定/角色", action: { endpoint: "/api/novel/world", method: "POST", body: {} } },
  relationship_edit: { commandId: "CMD-W12", level: "L2", title: "建立/解除人物关系" },
  create_character: { commandId: "CMD-W12", level: "L2", title: "新建角色" },
  edit_character: { commandId: "CMD-W12", level: "L2", title: "修改角色" },
  delete_character: { commandId: "CMD-W12", level: "L3", title: "删除角色" },
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
  read_help: { commandId: "CMD-Q01", level: "L0", title: "中枢能力与支持指令" },
  open_settings: { commandId: "CMD-W12", level: "L0", title: "打开设置" },
  open_relationships: { commandId: "CMD-Q01", level: "L0", title: "打开关系图" },
  open_taskcenter: { commandId: "CMD-G06", level: "L0", title: "打开任务中心" },
  open_foreshadow: { commandId: "CMD-Q01", level: "L0", title: "打开伏笔账" },
  open_review: { commandId: "CMD-Q01", level: "L0", title: "打开审查面板" },
  open_eval: { commandId: "CMD-S09", level: "L0", title: "打开整书评估" },
  open_gacha: { commandId: "CMD-W17", level: "L0", title: "打开卡池" },
  open_autostart: { commandId: "CMD-N03", level: "L0", title: "打开自动连载" },
  open_memory: { commandId: "CMD-Q01", level: "L0", title: "打开记忆·台账" },
  chat: { commandId: "CMD-Q09", level: "L0", title: "对话" },
};

const INTENT_ENUM = Object.keys(INTENTS);

/** 简短世界摘要（供意图识别上下文）：世界静态快照 + 待办/状态（中枢全知的基础） */
function worldSummary(w: WorldState): string {
  const lines = [
    `《${w.title}》(${w.genre})，已写 ${w.chapters.length} 章`,
    `角色 ${w.characters.length} 个：${w.characters.slice(0, 6).map((c) => c.name).join("、")}`,
    `伏笔 ${w.foreshadowing.length} 条（活跃 ${w.foreshadowing.filter((f) => f.status !== "resolved").length}）`,
  ];
  const target = targetChapterCount(w);
  if (target != null) lines.push(`全书目标 ${target} 章（写作进度 ${w.chapters.length}/${target}，界面进度条分母即此目标章数）`);
  const props = (w.characterProposals ?? []).filter((p) => p.status === "pending");
  if (props.length) lines.push(`待确认新角色提案 ${props.length} 项：${props.map((p) => p.name).join("、")}`);
  if ((w.pendingCards ?? []).length) lines.push(`待应用卡池 ${w.pendingCards!.length} 张`);
  const debt = (w.qualityDebt ?? []).filter((d) => d.status === "open");
  if (debt.length) lines.push(`未处理质量债 ${debt.length} 项`);
  const revise = w.chapters.filter((c) => c.review?.verdict === "revise");
  if (revise.length) lines.push(`需修订章节 ${revise.length} 章：第 ${revise.map((c) => c.index).join("、")} 章`);
  lines.push(`梗概：${w.premise.slice(0, 80)}`);
  return lines.join("\n");
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
  read_appearances: "查看某章出场角色/这章出场了谁/第几章有哪些角色/本章出场角色",
  read_relationships: "查看人物关系/谁和谁什么关系/关系列表/张三的关系/关系网",
  read_outline: "查看大纲/全书结构/蓝图/卷章规划/故事结构",
  read_timeline: "查看脉络/时间线/故事进展/写到哪了的发展脉络",
  read_review: "查看审查报告/评分/审查意见/这章评价",
  read_gacha: "查看抽到的卡/查看卡池/应用卡牌/抽卡结果/看看抽到了什么/卡池里有什么",
  read_settings: "查看当前生成参数/自动抽卡是否开启/是否人工确认入册/当前字数温度视角审查严格度",
  eval: "整书质量评估",
  edit_world: "编辑设定/角色",
  relationship_edit: "建立关系/结仇/成为盟友/师徒/解除关系/给A和B建立C关系/让A和B成为C",
  create_character: "新建角色/添加角色/新角色叫X/加一个角色",
  edit_character: "修改角色/把X的定位改成Y/X的年龄改成Y/更新X的信息",
  delete_character: "删除角色/移除角色/不要X这个角色了/删掉X",
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
  read_help: "查看支持哪些指令/你能做什么/有什么功能/帮助/能力清单/你会什么",
  open_settings: "打开设置/设置面板/调整设置/打开设置弹窗（添加角色/新建人物/用户页面/人物页面 → tab=角色；本系统无独立用户资料页）",
  open_relationships: "打开关系图/人物关系/角色关系图/查看角色关系",
  open_taskcenter: "打开任务中心/任务面板/任务进度/任务列表",
  open_foreshadow: "打开伏笔账/伏笔面板/伏笔管理",
  open_review: "打开审查报告/审查面板/这章的审查/看审查",
  open_eval: "打开评估/整书评估/质量评估面板",
  open_gacha: "打开卡池/抽卡面板/卡池面板",
  open_autostart: "打开自动连载/开始自动连载设置/连载设置",
  open_memory: "打开记忆台账/台账面板/操作日志面板",
  chat: "纯对话（无操作）",
};

const INTENT_SYSTEM = `你是小说创作引擎「墨枢」的中枢对话编排器。根据用户输入识别意图，从以下动作中选择最匹配的一个：
${INTENT_ENUM.map((k) => `- ${k}：${INTENT_HINT[k] ?? k}`).join("\n")}

输出合法 JSON：{"intent":"动作名","params":{...},"reply":"一句话自然语言回复（中文）"}
- reply 必须有实质内容：查询类意图直接点出关键信息（如角色的形象/状态/关系要点、章节/任务概况），禁止「这就为您调出/调取」等空话开场；确无内容可概括时才用一句话说明将展示什么卡片
- params：从用户输入中提取动作参数（需求 2：自动提取工具参数）：
  · read_chapter / read_review / regenerate / delete_chapter / read_appearances → {index: 第几章}（数字）
  · read_character → {name:"角色名"}
  · read_relationships → {name:"角色名"}（可选；缺省 = 全部关系）
  · media_image（生成插画）→ {chapterIndex: 第几章, count: 张数}；media_video（生成视频）→ {chapterIndex: 第几章}
  · autostart → {maxChapters: 章数}；gacha → {count: 张数}
  · open_settings → {tab: "全局"|"章节"|"设定"|"角色"|"大纲"|"导出"}（用户说「添加角色」「新建人物」「用户/人物页面」→ tab="角色"；本系统无独立用户资料页，人物即角色）
  · open_review → {index: 第几章}（缺省用当前选中章）
  · relationship_edit（建立/解除人物关系）→ {nameA:"角色A", nameB:"角色B", relation:"关系词"}；解除时 {remove:true}
  · create_character（新建角色）→ {name:"角色名", role:"定位（主角/反派/配角/关键人物，可省略）"}
  · edit_character（修改角色）→ {name:"角色名", role|status|age|identity|motivation|look|voice: "修改后的值"}
  · delete_character（删除角色）→ {name:"角色名"}
  · edit_world（修改全局信息）→ {author:"作者署名"} 或 {premise|current|time|place|tone|rules: "修改后的值"}
  · 用户未指定具体章节时，**不要填 chapterIndex**（系统会自动用其当前选中的章节兜底）
- 「打开新角色提案」「新角色提案」「打开提案面板」等**打开类**表达（用户想直接看底部面板）→ intent 为 "open_proposals"，reply 用一句话说明已打开
- 「有哪些角色推荐」「列出提案」「查看提案内容」等**查询列表**表达 → intent 为 "read_proposals"（在聊天中列提案卡）
- intent 为 "chat" 时 params 为空对象，reply 直接回答用户问题
- 无法确定具体操作时选 "chat"
- 用户只提到章节（如「第一章」「第三章」）而没说要看什么时，intent 仍选 "read_chapter" 并提取 {index: 章节号}，**不要直接输出正文**（系统会追问用户想做什么：看正文/生成插画/审查/聊聊）
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

type IntentResult = { intent: string; params: Record<string, unknown>; reply: string };

/** 显式媒体指令走本地确定性识别，避免云端意图分类器超时把参数卡一起卡住。
 *  这里只接管明确的执行语气；疑问、失败排查、取消等仍交给 LLM 正常对话。 */
export function explicitMediaIntent(prompt: string): IntentResult | null {
  const text = prompt.replace(/\s+/g, "").trim();
  if (!text || /(?:不要|不用|别|取消|停止|失败|报错|为什么|怎么|如何|是否|能否|可以吗|是什么|说明|介绍)/.test(text)) return null;
  const video = /(?:生成|制作|创建|做|拍)(?:.{0,12})(?:视频|短片)/.test(text);
  const image = /(?:生成|制作|创建|画|绘制|配)(?:.{0,12})(?:插画|插图|配图|图片)/.test(text);
  if (!video && !image) return null;
  const params: Record<string, unknown> = {};
  const chapterIndex = chapterIndexFromPrompt(text);
  if (chapterIndex != null) params.chapterIndex = chapterIndex;
  if (!video) {
    const countMatch = text.match(/([1-3])张/) ?? text.match(/([一二三])张/);
    if (countMatch) params.count = /^[1-3]$/.test(countMatch[1]) ? Number(countMatch[1]) : CN_NUM[countMatch[1]];
  }
  return {
    intent: video ? "media_video" : "media_image",
    params,
    reply: video ? "请选择生成视频的参数。" : "请选择生成插画的参数。",
  };
}

/** 明确的参数状态查询本地确定性识别，避免“当前是否开启”被模型误判成 plan/opinion。 */
export function explicitSettingsQuery(prompt: string): IntentResult | null {
  const text = prompt.replace(/\s+/g, "").trim();
  if (!text) return null;
  const asksCurrent = /当前|现在|目前|是否|有没有|是什么|多少/.test(text);
  const asksSetting = /自动抽卡|人工确认|确认入册|字数|温度|叙述视角|审查严格度|结尾钩子|生成参数/.test(text);
  const mutatesSetting = /修改|调整|设置为|改成|我要开启|我要关闭|请开启|请关闭|打开设置/.test(text);
  return asksCurrent && asksSetting && !mutatesSetting
    ? { intent: "read_settings", params: {}, reply: "以下是当前实际生效的生成参数。" }
    : null;
}

/** 意图识别（LLM）；失败降级为 chat。
 *  ctx：前端上下文（选中章）——用户未指定章节时作为参数兜底（需求 1/2）；
 *  history：最近会话文本（支持「上一章/刚说的那个」类指代）。 */
async function recognizeIntent(w: WorldState, prompt: string, ctx?: BrainChatContext["ctx"], history?: string[]): Promise<IntentResult> {
  try {
    const ctxLines: string[] = [];
    if (history?.length) ctxLines.push(`最近对话：\n${history.join("\n")}`);
    // —— 系统全知上下文：选中章详情 + 系统时机 + 状态（前端快照注入） ——
    if (typeof ctx?.chapterIndex === "number" && Number.isInteger(ctx.chapterIndex)) {
      const parts = [`用户当前选中的章节：第 ${ctx.chapterIndex} 章`];
      if (ctx.chapterTitle) parts.push(`标题「${ctx.chapterTitle}」`);
      if (ctx.chapterStatus) parts.push(`审查状态：${ctx.chapterStatus === "revise" ? "需修订" : ctx.chapterStatus}`);
      if (typeof ctx.chapterWords === "number" && ctx.chapterWords > 0) parts.push(`约 ${ctx.chapterWords} 字`);
      if (typeof ctx.versionCount === "number" && ctx.versionCount > 1) parts.push(`有 ${ctx.versionCount} 个历史版本（可回滚）`);
      ctxLines.push(parts.join("，") + "（用户未指定章节的操作默认作用于该章）");
    }
    const sysState: string[] = [];
    if (ctx?.autoRunning) sysState.push("自动连载正在运行中");
    if (ctx?.writingRunning) sysState.push("写作任务进行中");
    if (ctx?.systemStatus) sysState.push(ctx.systemStatus);
    if (ctx?.activity && ctx.activity !== "idle") sysState.push(`中枢活动：${ctx.activity}`);
    // 服务端权威 system 投影：写作任务/媒体生成/视觉任务/待办——中枢知道系统正在做什么
    const sv = ctx?.server;
    if (sv) {
      if (sv.advanceTaskRunning) sysState.push(`推进任务进行中${sv.advancePhase ? `（${sv.advancePhase}）` : ""}`);
      if (sv.mediaGenerating) sysState.push("插画/视频生成中");
      if (sv.visualRunning) sysState.push("角色视觉生成中");
      if (sv.pendingCommit) sysState.push(`有第 ${(sv.pendingCommit as { index?: number | null }).index ?? "?"} 章待确认入册`);
    }
    if (sysState.length) ctxLines.push(`系统当前状态：${sysState.join("；")}（写操作需与运行中任务冲突时谨慎）`);
    const ctxBlock = ctxLines.length ? `\n\n${ctxLines.join("\n\n")}` : "";
    const out = await brainChatDeps.chatJson<{ intent?: string; params?: Record<string, unknown>; reply?: string }>(
      [
        { role: "system", content: INTENT_SYSTEM },
        { role: "user", content: `用户输入：${prompt}${ctxBlock}\n\n当前世界：\n${worldSummary(w)}` },
      ],
      {
        ...taskOpts("brainGate"),
        maxTokens: 2000,
        // 意图识别是简单 JSON 分类（非长推理）：关闭思考，首字节大幅提速，避免思考吃光预算（对齐 planScenesOnce）
        thinking: "disabled",
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
    // Deterministic local fallback keeps common commands useful when the intent model
    // is unavailable (network outage, missing key, or malformed model output).
    const p = prompt.trim();
    const chapter = chapterIndexFromPrompt(p);
    if (/帮助|能做什么|支持哪些|功能/.test(p)) return { intent: "read_help", params: {}, reply: "我可以查询章节、角色、伏笔、关系、大纲、任务和媒体，也可以推进剧情、编辑设定、生成插画、管理连载。" };
    if (/章节目录|写到哪|有哪些章节/.test(p)) return { intent: "read_chapters", params: {}, reply: "我会列出已入册章节、字数、审查状态和媒体数量。" };
    if (/角色列表|有哪些角色|登场角色/.test(p)) return { intent: "read_characters", params: {}, reply: "我会列出角色定位、状态、出场次数和形象资料。" };
    if (/伏笔/.test(p) && !/新增|修改|删除|登记/.test(p)) return { intent: "read_foreshadow", params: {}, reply: "我会列出伏笔账及其埋设、推进和回收状态。" };
    if (/关系图|人物关系|关系网/.test(p)) return { intent: "read_relationships", params: {}, reply: "我会展示人物关系及一跳关系图。" };
    if (chapter != null && /审查|评价|评分/.test(p)) return { intent: "read_review", params: { index: chapter }, reply: `我会查看第 ${chapter} 章的审查报告。` };
    if (chapter != null && /看|查看|阅读|正文|内容/.test(p)) return { intent: "read_chapter", params: { index: chapter }, reply: `我会展示第 ${chapter} 章正文。` };
    if (/推进剧情|写下一章|继续写/.test(p)) return { intent: "advance", params: {}, reply: "我会先展示推进剧情的确认卡，确认后开始写作。" };
    return { intent: "chat", params: {}, reply: "我暂时无法连接意图识别服务，但仍可以处理章节、角色、伏笔、关系查询，以及推进剧情等常用指令。" };
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

/** 空话开场回复检测：仅「这就为您调出/调取/调阅/拉取 XX」之类的短句，无实质内容 */
export function isHollowReply(text: string | undefined | null): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 30) return false;
  return /(调出|调取|调阅|拉取|为您加载|为您展示|为您列出|为您查询)/.test(t);
}

function queryData(card: Record<string, unknown>): Record<string, unknown> {
  return (card.data ?? {}) as Record<string, unknown>;
}

function recordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function requestedVolume(prompt: string, volumes: Record<string, unknown>[]): { index: number; volume: Record<string, unknown> } | null {
  const match = prompt.match(/第\s*([一二三四五六七八九十\d]+)\s*卷/);
  if (!match) return null;
  const cn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const index = /^\d+$/.test(match[1]) ? Number(match[1]) : cn[match[1]];
  const volume = index ? volumes[index - 1] : undefined;
  return volume ? { index, volume } : null;
}

function sentenceValue(value: unknown, fallback: string): string {
  return String(value ?? fallback).replace(/[。！？!?]+$/u, "");
}

/** L0 查询开场文本只复述已构造的权威卡片事实；provider reply 只参与意图识别，
 *  不得在同一回合覆盖 projection 数据。read_character 仍按用户问法侧重。 */
export function l0QueryReply(intent: string, card: Record<string, unknown>, prompt: string, llmReply: string | undefined | null): string {
  const p = prompt ?? "";
  if (card.kind === "result") {
    const detail = String(card.detail ?? "").trim();
    return detail || String(card.title ?? "");
  }
  if (intent === "read_chapter" && card.kind === "browse") {
    // 正文即全部，无需 LLM 复述；模板说明已调取 + 字数 + 如何看全文（避免「重复输出标题」）
    const d = (card.data ?? {}) as Record<string, unknown>;
    const len = String(d.text ?? "").length;
    return `第 ${String(d.index ?? "?")} 章「${String(d.title ?? "")}」已为你调取${len > 0 ? `（约 ${len} 字）` : ""}，正文可在下方卡片中展开查看全文。`;
  }
  if (intent === "read_character" && card.kind === "browse") {
    const d = (card.data ?? {}) as Record<string, unknown>;
    const name = String(d.name ?? "该角色");
    const role = String(d.role ?? "");
    // 状态正则刻意不含「现在/目前」：避免「他现在长什么样/她现在跟谁关系好」被状态分支劫持
    if (/状态|近况|最新|处境/.test(p)) {
      return `「${name}」当前状态：${String(d.status ?? "—")}`;
    }
    if (/形象|样子|长什么样|什么样|外貌|穿着|长相/.test(p)) {
      const look = String(d.look ?? "").trim();
      return look ? `「${name}」的形象：${look}` : `「${name}」：${role}。暂未登记形象细节，其余资料已为你列出。`;
    }
    if (/关系|认识谁|和谁|跟谁/.test(p)) {
      const rels = (Array.isArray(d.relations) ? d.relations : []) as { name?: unknown; relation?: unknown }[];
      return rels.length
        ? `「${name}」的人物关系：${rels.map((r) => `${String(r.name)}（${String(r.relation)}）`).join("、")}。`
        : `「${name}」暂无记录在案的人物关系，其余资料已为你列出。`;
    }
    return `「${name}」：${role}。当前状态：${String(d.status ?? "—")}`;
  }

  const d = queryData(card);
  if (intent === "read_characters") {
    const list = recordList(d.list);
    return list.length
      ? `当前共有 ${list.length} 位角色：${list.map((c) => `${String(c.name)}（${String(c.role ?? "未定位")}）`).join("、")}。`
      : "当前还没有角色。";
  }
  if (intent === "read_outline") {
    const volumes = recordList(d.volumes);
    const arcs = recordList(d.arcs);
    const requested = requestedVolume(p, volumes);
    if (requested) return `第 ${requested.index} 卷「${String(requested.volume.title)}」：${sentenceValue(requested.volume.goal, "尚未填写目标")}。`;
    const names = volumes.map((v) => `「${String(v.title)}」`).join("、");
    return `当前全书已规划 ${volumes.length} 卷、${arcs.length} 条故事弧${names ? `；卷名为 ${names}` : ""}，已完成 ${String(d.done ?? 0)}/${String(d.target ?? 0)} 章。`;
  }
  if (intent === "read_plans") {
    const volumes = recordList(d.volumes);
    const arcs = recordList(d.arcs);
    const requested = requestedVolume(p, volumes);
    if (requested) return `第 ${requested.index} 卷「${String(requested.volume.title)}」：${sentenceValue(requested.volume.goal, "尚未填写目标")}。`;
    if (/首弧|第一.*弧/.test(p) && arcs[0]) {
      return `首弧「${String(arcs[0].title)}」预计 ${String(arcs[0].estChapters ?? "未定")} 章，目标：${String(arcs[0].goal ?? "尚未填写")}。`;
    }
    if (/下一弧/.test(p) && arcs.length) {
      const currentIndex = arcs.findIndex((arc) => arc.status !== "done");
      const next = arcs[Math.max(0, currentIndex + 1)] ?? arcs[0];
      return `下一弧是「${String(next.title)}」，预计 ${String(next.estChapters ?? "未定")} 章。`;
    }
    const next = d.next as Record<string, unknown> | null | undefined;
    return `当前已有 ${volumes.length} 卷、${arcs.length} 条故事弧和 ${String(d.total ?? 0)} 条章纲，已完成 ${String(d.done ?? 0)} 条${next ? `；下一条是第 ${String(next.index)} 章：${String(next.goal ?? "待规划")}` : ""}。`;
  }
  if (intent === "read_worldbook") {
    const setting = (d.setting ?? {}) as Record<string, unknown>;
    const rules = Array.isArray(setting.rules) ? setting.rules : [];
    const lore = recordList(d.lore);
    return `当前设定：时代 ${String(setting.time ?? "未设定")}；地点 ${String(setting.place ?? "未设定")}；规则 ${rules.length} 条；世界书条目 ${lore.length} 条。`;
  }
  if (intent === "read_media") {
    const stats = (d.stats ?? {}) as Record<string, unknown>;
    return `当前媒体：封面${stats.cover ? "已生成" : "未生成"}；章节插画 ${String(stats.images ?? 0)} 张；视频 ${String(stats.videos ?? 0)} 个；有视觉资源的角色 ${String(stats.characters ?? 0)} 位。`;
  }
  if (intent === "read_chapters") return `当前章节目录共 ${String(d.done ?? 0)} 章，全书目标 ${String(d.target ?? 0)} 章。`;
  if (intent === "read_foreshadow") return `当前伏笔账本共 ${recordList(d.list).length} 条。`;
  if (intent === "read_relationships") {
    const list = recordList(d.list);
    return list.length ? `当前记录了 ${list.length} 条人物关系，详情已列在下方。` : "当前没有已登记的人物关系。";
  }
  if (intent === "read_timeline") {
    const events = recordList(d.events);
    if (!events.length) return `时间线目前还没有已入册事件；故事已规划 ${recordList(d.volumes).length} 卷，下一章是第 ${String(d.next ?? 1)} 章。`;
    const recent = events.slice(-3).map((event) => `第 ${String(event.chapter)} 章：${String(event.summary ?? "未填写摘要")}`).join("；");
    return `时间线已记录 ${events.length} 个章节事件。最近记录：${recent}。`;
  }
  if (intent === "read_gacha") return `当前待应用卡池有 ${recordList(d.list).length} 张卡。`;
  if (intent === "read_proposals") return `当前有 ${recordList(d.list).length} 个待确认的新角色提案。`;
  if (intent === "read_tasks") return `当前任务中心有 ${recordList(d.debt).length} 条质量债、${Array.isArray(d.rewriteQueue) ? d.rewriteQueue.length : 0} 个重写任务。`;
  if (intent === "read_logs") return `当前已调取最近 ${recordList(d.list).length} 条操作日志。`;
  return String(card.title ?? "");
}

/** 含糊章节提及判定：仅提到章节号（如「第一章」）而无明确「查看正文」动作词时返回 true——
 *  此时应追问用户意图（看正文/生成插画/审查/聊聊），而非直接把正文糊上来（用户可能只想要插画或概况）。 */
export function isAmbiguousChapterPrompt(prompt: string | undefined | null): boolean {
  const p = (prompt ?? "").trim();
  if (!p) return false;
  // 必须确实提及了章节（第 N 章 / 第N章）
  const chapterMention = /第\s*[0-9一二三四五六七八九十百]+\s*章/.test(p);
  if (!chapterMention) return false;
  // 明确查看/获取内容/评价的动作词 → 视为有明确意图，不追问
  const actionWords = /查看|看|看看|浏览|读|阅读|打开|展示|调出|调取|给我|发|输出|全文|内容|正文|讲|说|写|概况|梗概|大概|什么|如何|怎么样|评价|评论|评估|生成|配图|插图|画/;
  return !actionWords.test(p);
}

/** read_chapter 含糊提及时的追问卡：让用户明确要做什么（查看正文/生成插画/审查/聊聊）。
 *  选项 label 会被作为新输入继续对话（answerAsk 机制），命中对应意图。index 缺失时返回 null（调用方走原逻辑）。 */
export function chapterAskCard(w: WorldState, params: Record<string, unknown>): { kind: "ask"; question: string; options: { label: string; description?: string }[] } | null {
  const idx = Number(params.index);
  if (!Number.isInteger(idx) || idx <= 0) return null;
  const ch = w.chapters.find((c) => c.index === idx);
  const label = ch ? `第 ${idx} 章「${ch.title}」` : `第 ${idx} 章`;
  const options: { label: string; description?: string }[] = [
    { label: `查看第 ${idx} 章正文`, description: "在聊天中展示章节全文，可展开查看" },
    { label: `为第 ${idx} 章生成插画`, description: "按章节内容生成一张配图" },
  ];
  if (ch?.review?.verdict === "revise") options.push({ label: `查看第 ${idx} 章审查报告`, description: "展示该章审查意见与评分" });
  options.push({ label: "只是聊聊", description: "与中枢讨论这一章，不执行操作" });
  return { kind: "ask", question: `你想对${label}做什么？`, options };
}

/** L0 查询直接执行 → BrowseCard / ResultCard */
export function executeQuery(w: WorldState, intent: string, params: Record<string, unknown>): Record<string, unknown> | null {
  
  if (intent === "read_chapter") {    const idx = Number(params.index);
    const ch = w.chapters.find((c) => c.index === idx);
    if (!ch) return { kind: "result", title: "未找到章节", success: false, detail: `第 ${idx} 章不存在` };
    return { kind: "browse", title: `第${ch.index}章 · ${ch.title}`, browseType: "chapter", data: { index: ch.index, title: ch.title, text: ch.text } };
  }
  if (intent === "read_character") {
    const name = String(params.name ?? "");
    const c = w.characters.find((x) => x.name.includes(name) || name.includes(x.name));
    if (!c) return { kind: "result", title: "未找到角色", success: false, detail: `没有叫「${name}」的角色` };
    // 关系：该角色全部 relations（name → 关系词），展开为 [{name, relation}]
    const relations = Object.entries(c.relations ?? {}).map(([n, relation]) => ({ name: n, relation }));
    // 出场：appearedIn 章节 + 正文提及但未登记（appearedIn 可能滞后）
    const appeared = [...new Set([...(c.appearedIn ?? []), ...w.chapters.filter((ch) => ch.text.includes(c.name)).map((ch) => ch.index)])].sort((a, b) => a - b);
    // 后续安排：未完成章纲计划 / 相关弧线 / 待处理任务中提及该角色的条目
    const arrangement: string[] = [];
    for (const p of w.chapterPlans ?? []) {
      if (p.status !== "done" && (p.goal ?? "").includes(c.name)) arrangement.push(`第 ${p.index} 章计划：${(p.goal ?? "").slice(0, 60)}`);
    }
    for (const a of w.storyArcs ?? []) {
      if (a.status !== "done" && (a.goal ?? "").includes(c.name)) arrangement.push(`弧线「${a.title}」：${(a.goal ?? "").slice(0, 60)}`);
    }
    for (const d of w.qualityDebt ?? []) {
      if (d.status === "open" && (d.issue ?? "").includes(c.name)) arrangement.push(`待处理质量债 第 ${d.chapterIndex} 章：${(d.issue ?? "").slice(0, 50)}`);
    }
    const card: Record<string, unknown> = {
      kind: "browse", title: `${c.name} · ${c.role}`, browseType: "character",
      data: {
        name: c.name, role: c.role, status: c.status, gender: c.gender, age: c.age, identity: c.identity,
        look: c.look, voice: c.voice, motivation: c.motivation,
        relations, appeared, appearedCount: appeared.length,
        exit: c.exit ? { chapter: c.exit.chapter, reason: c.exit.reason } : null,
        arrangement: arrangement.slice(0, 5),
        portrait: !!(c.portrait?.path || c.image),
      },
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
  if (intent === "read_appearances") {
    const idx = params.index != null && params.index !== "" ? Number(params.index) : w.chapters.length;
    const ch = w.chapters.find((c) => c.index === idx);
    if (!ch) return { kind: "result", title: "未找到章节", success: false, detail: `第 ${idx} 章不存在` };
    const appeared = w.characters
      .filter((c) => (c.appearedIn ?? []).includes(idx) || ch.text.includes(c.name))
      .map((c) => ({ name: c.name, role: c.role, status: c.status, portrait: !!(c.portrait?.path || c.image) }));
    // 章节名并入标题（卡片标题只保留 head 一处，body 不再重复展示章名）
    return {
      kind: "browse", title: `第${idx}章 · ${ch.title} · 出场角色（${appeared.length} 个）`, browseType: "appearances",
      data: { chapter: idx, chapterTitle: ch.title, list: appeared },
    };
  }
  if (intent === "read_relationships") {
    const filterName = String(params.name ?? "").trim();
    const subgraph = extractRelationshipSubgraph(w.characters, filterName || undefined);
    if (!subgraph) return { kind: "result", title: "未找到角色", success: false, detail: `没有叫「${filterName}」的角色` };
    const byId = new Map(subgraph.nodes.map((node) => [node.id, node.name]));
    const list = subgraph.edges.map((edge) => ({ a: byId.get(edge.from) ?? edge.from, relation: edge.label, b: byId.get(edge.to) ?? edge.to }));
    const focus = subgraph.focus ? byId.get(subgraph.focus) : undefined;
    return {
      kind: "browse",
      title: focus ? `${focus} · 关系网（${list.length} 条）` : `人物关系图（${list.length} 条）`,
      browseType: "relationships",
      data: { name: focus, list, subgraph },
    };
  }
  if (intent === "read_outline") {
    // 大纲/蓝图：主题 + 指南针 + 卷 + 弧线
    const volumes = (w.blueprint?.volumes ?? []).map((v) => ({ title: v.title, status: v.status, goal: v.goal, range: v.chapterRange ?? null }));
    const arcs = (w.storyArcs ?? []).map((a) => ({ title: a.title, status: a.status, estChapters: a.estChapters, goal: a.goal }));
    return {
      kind: "browse", title: "全书大纲", browseType: "outline",
      data: {
        premise: w.premise, genre: w.genre,
        compass: w.blueprint?.compass, progressContract: w.blueprint?.progressContract,
        volumes, arcs, done: w.chapters.length, target: targetChapterCount(w),
      },
    };
  }
  if (intent === "read_timeline") {
    // 脉络：卷 → 弧 → 章 进展链
    const arcsByVol = new Map<string, NonNullable<typeof w.storyArcs>>();
    for (const a of w.storyArcs ?? []) {
      const v = a.volumeId ?? "";
      if (!arcsByVol.has(v)) arcsByVol.set(v, []);
      arcsByVol.get(v)!.push(a);
    }
    const volumes = (w.blueprint?.volumes ?? []).map((v) => ({
      title: v.title, status: v.status, goal: v.goal,
      arcs: (arcsByVol.get(v.id) ?? []).map((a) => ({ title: a.title, status: a.status, estChapters: a.estChapters })),
      chapters: w.chapters
        .filter((ch) => (v.chapterRange?.[0] ?? 0) <= ch.index && ch.index <= (v.chapterRange?.[1] ?? Number.MAX_SAFE_INTEGER))
        .map((ch) => ({ index: ch.index, title: ch.title, status: ch.review?.verdict === "revise" ? "需修订" : "已入册", words: ch.text.length })),
    }));
    return {
      kind: "browse", title: "故事脉络", browseType: "timeline",
      data: {
        volumes,
        events: w.timeline.map((event) => ({ chapter: event.chapter, summary: event.summary })),
        next: w.nextChapter ?? w.chapters.length + 1,
        target: targetChapterCount(w),
        premise: w.premise,
      },
    };
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
  if (intent === "read_settings") {
    const g = genOf(w);
    return {
      kind: "result", title: "当前生成参数", success: true,
      detail: `自动抽卡：${g.autoGacha ? "开" : "关"}；人工确认入册：${g.commitPolicy === "confirm" ? "开" : "关"}；字数：${g.minWords}-${g.maxWords}；叙述视角：${g.pov}；审查严格度：${g.reviewStrictness}；章节结尾钩子：${g.forceHook ? "开" : "关"}；温度：${g.temperature}。`,
      data: {
        autoGacha: g.autoGacha,
        commitPolicy: g.commitPolicy ?? "auto",
        minWords: g.minWords,
        maxWords: g.maxWords,
        pov: g.pov,
        reviewStrictness: g.reviewStrictness,
        forceHook: g.forceHook,
        temperature: g.temperature,
      },
    };
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
    return { kind: "browse", title: `章节目录（${w.chapters.length} 章）`, browseType: "chapters", data: { done: w.chapters.length, target: targetChapterCount(w), list } };
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
        goal: { disposition: brainDisposition(w), chapterCount: w.chapters.length, target: targetChapterCount(w) },
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
      data: { stats: { cover: !!w.cover, images, videos, characters: withPortrait }, list: list.slice(0, 60) },
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
  /** DeepSeek 思考模式开关（true=开，false/缺省=关）：仅影响纯对话回复的 streamChatReply，
   *  思考开启时思维链经 reasoning SSE 事件流式推前端（折叠展示）；默认关（首字节提速 90%+）。 */
  thinking?: boolean;
  /** 前端系统快照（左侧栏选中章详情 + 系统时机 + presence/activity + 自动连载）：中枢全知上下文。
   *  用于意图识别/参数提取兜底（未指定章节的操作默认用选中章），并感知「系统正在做什么/是否冲突」。 */
  ctx?: {
    chapterIndex?: number | null;
    chapterTitle?: string | null;
    chapterStatus?: string | null;
    chapterWords?: number | null;
    versionCount?: number | null;
    systemStatus?: string | null;
    writingRunning?: boolean;
    presence?: string | null;
    activity?: string | null;
    autoRunning?: boolean;
    /** 服务端 system 投影：自动连载/写作任务/媒体生成/视觉任务/待办——索引式全知 */
    server?: Record<string, unknown>;
  };
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

/** 纯对话回复：真流式（chatStream 逐 delta），每 500ms 节流落盘一次。
 *  注入世界摘要 + 系统快照：纯对话也能感知当前世界状态与系统时机（中枢全知）。 */

/**
 * 流式整形器：把上游"聚合式流式"（tokenrhythm 网关思考完成后一次性推 34-101KB 巨块）拆成
 * 稳定的 4 字符/30ms 小增量，让前端逐 delta 独立渲染（真流式感）。
 * - 上游慢速（相邻 delta 间隔 > tickMs）：每次 push 无 pending timer → 立即转发，不人为延迟；
 * - 上游巨块同步连发：首分片立即发，剩余按 tickMs 节奏逐片发，避免同步连发被 React 批处理合并为一次渲染；
 * - drain()：回合结束 flush 剩余分片（数据完整性）。
 */
export function createStreamShaper(
  emit: (text: string) => void,
  charsPerTick = 4,
  tickMs = 30,
): { push: (text: string) => void; drain: () => void } {
  let queue = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    timer = null;
    const take = queue.slice(0, charsPerTick);
    queue = queue.slice(take.length);
    if (take) emit(take);
    if (queue) timer = setTimeout(tick, tickMs);
  };
  return {
    push(text: string) {
      if (!text) return;
      queue += text;
      if (!timer) tick(); // 无 pending 节奏时立即发一分片；否则按 tickMs 节奏续发
    },
    drain() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (queue) {
        const take = queue.slice(0, charsPerTick);
        queue = queue.slice(take.length);
        if (take) emit(take);
      }
    },
  };
}

async function streamChatReply(ctx: BrainChatContext, messageId: string): Promise<void> {
  const { title, sessionId, prompt, send, signal, ctx: snap, thinking } = ctx;
  let acc = "";
  let accThinking = "";
  let lastFlush = 0;
  let lastThinkingFlush = 0;
  // 世界摘要（动态读取，避免过期）；失败静默降级为仅 prompt
  let worldCtx = "";
  try {
    const w = brainChatDeps.loadWorld(title);
    if (w) {
      const lines = [worldSummary(w)];
      if (typeof snap?.chapterIndex === "number" && Number.isInteger(snap.chapterIndex)) {
        const ch = w.chapters.find((c) => c.index === snap.chapterIndex);
        if (ch) lines.push(`用户当前选中章节：第 ${ch.index} 章「${ch.title}」${ch.review?.verdict === "revise" ? "（需修订）" : ""}`);
      }
      const sys: string[] = [];
      if (snap?.autoRunning) sys.push("自动连载运行中");
      if (snap?.writingRunning) sys.push("写作任务进行中");
      if (snap?.systemStatus) sys.push(snap.systemStatus);
      if (sys.length) lines.push(`系统状态：${sys.join("；")}`);
      worldCtx = lines.join("\n");
    }
  } catch { /* 世界读取失败：仅用 prompt 兜底 */ }
  const userContent = worldCtx ? `当前世界与系统状态：\n${worldCtx}\n\n用户问题：${prompt}` : prompt;
  // 流式整形：上游聚合吐巨块 → 按 4字符/30ms 节奏推给前端（真流式感，防同步连发被 React 批处理合并）
  const shaper = createStreamShaper((text) => send({ type: "delta", messageId, text, append: true }));
  // 思维链独立通道：思考内容与正文 delta 分离推送（前端折叠展示，无边框文字样式）
  const thinkingShaper = createStreamShaper((text) => send({ type: "reasoning", messageId, text, append: true }));
  await brainChatDeps.chatStream(
    [
      { role: "system", content: CHAT_SYSTEM },
      { role: "user", content: userContent },
    ],
    (delta) => {
      acc += delta;
      shaper.push(delta);
      const now = Date.now();
      if (now - lastFlush > 500) {
        lastFlush = now;
        updateMessageText(title, sessionId, messageId, acc, true);
      } else {
        updateMessageText(title, sessionId, messageId, acc, false);
      }
    },
    {
      ...taskOpts("brainGate"),
      signal,
      temperature: 0.7,
      maxTokens: 20000,
      retries: 2,
      // 思考模式开关（默认关）：thinking={type:"disabled"} 关闭思维链（首字节提速 90%+，tokenrhythm 实测生效）
      thinking: thinking ? "enabled" : "disabled",
      onReasoning: (delta) => {
        accThinking += delta;
        thinkingShaper.push(delta);
        const now = Date.now();
        if (now - lastThinkingFlush > 500) {
          lastThinkingFlush = now;
          updateMessageThinking(title, sessionId, messageId, accThinking, true);
        } else {
          updateMessageThinking(title, sessionId, messageId, accThinking, false);
        }
      },
    },
  );
  shaper.drain(); // flush 剩余分片（数据完整性）
  thinkingShaper.drain();
  updateMessageText(title, sessionId, messageId, acc, true);
  if (accThinking) updateMessageThinking(title, sessionId, messageId, accThinking, true);
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
        // 选项生成是小 JSON 输出：关闭思考提速（对齐 recognizeIntent / planScenesOnce）
        thinking: "disabled",
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

/** 明确的作者修改问法兜底：优先使用意图识别器的结构化 author；当 provider
 * 漏参时只接受带“作者/署名”锚点的短句，避免把其它全局编辑内容误当作者。 */
export function authorFromEditPrompt(params: Record<string, unknown>, prompt = ""): string {
  const structured = String(params.author ?? "").trim();
  if (structured) return structured;
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!/(?:作者|署名)/.test(text)) return "";
  const match = text.match(/(?:作者(?:署名)?|署名)(?:修改|改|设置|设|换|署)?(?:为|成|叫|是)?[：:「『“\s]*([^」』”。，,；;！!？?]{1,30})/);
  return match?.[1]?.replace(/^(?:改为|改成|设置为|设为)/, "").trim() ?? "";
}

/** 明确的全局当前状态修改问法兜底。只接受“全局当前状态/故事当前状态”锚点，
 * 避免把角色当前状态或普通的“现在”问法错误写入世界全局状态。 */
export function currentFromEditPrompt(params: Record<string, unknown>, prompt = ""): string {
  const structured = String(params.current ?? "").trim();
  if (structured) return structured;
  const text = prompt.replace(/\s+/g, " ").trim();
  const match = text.match(/(?:全局|故事)(?:的)?当前状态(?:修改|改|设置|设|换)?(?:为|成|叫|是)?[：:「『“\s]*([^」』”。，,；;！!？?]{1,80})/);
  return match?.[1]?.replace(/^(?:改为|改成|设置为|设为)/, "").trim() ?? "";
}

/** 追问选择卡（ask）构建：信息不足时给结构化候选选项（输入框上方询问面板，不混入聊天流），
 * 无法生成候选时返回 null（调用方降级为自然追问）。
 * 用户选完后把选项 label 作为新输入继续，AI 据此补全参数。 */
export function buildAskCard(w: WorldState, intent: string, params: Record<string, unknown>): { kind: "ask"; question: string; options: { label: string; description?: string }[] } | null {
  if (intent === "edit_world") {
    const name = String(params.name ?? "").trim();
    if (!name) {
      const candidates = w.characters.slice(0, 4).map((c) => ({ label: c.name, description: `${c.role} · 可修改定位/状态/年龄/身份/动机/形象` }));
      if (candidates.length) return { kind: "ask", question: "你想编辑哪个角色？", options: candidates };
      return { kind: "ask", question: "你想编辑什么？", options: [{ label: "故事设定", description: "修改梗概/世界观/当前状态" }, { label: "新增角色", description: "添加一个新角色（如「新建角色 林墨」）" }] };
    }
  }
  if (intent === "create_character") {
    const name = String(params.name ?? "").trim();
    if (!name) {
      const props = (w.characterProposals ?? []).filter((p) => p.status === "pending").slice(0, 4).map((p) => ({ label: p.name, description: `${p.role} · ${(p.reason ?? "").slice(0, 30)}` }));
      if (props.length) return { kind: "ask", question: "要新建哪个角色？（可从待确认提案中选择，或直接输入角色名）", options: props };
      return { kind: "ask", question: "新建哪个角色？", options: [{ label: "直接输入", description: "在输入框输入角色名，如「新建角色 林墨」" }] };
    }
  }
  if (intent === "relationship_edit") {
    const a = String(params.nameA ?? params.a ?? "").trim();
    const b = String(params.nameB ?? params.b ?? "").trim();
    const rel = String(params.relation ?? "").trim();
    if (!a || !b || !rel) {
      const names = w.characters.slice(0, 4).map((c) => c.name);
      const options = names.length >= 2
        ? names.map((n) => ({ label: n, description: "选择此角色" }))
        : [{ label: "输入角色名", description: "在输入框输入，如「给张三和李四建立仇人关系」" }];
      const parts: string[] = [];
      if (!a) parts.push("缺角色 A");
      if (!b) parts.push("缺角色 B");
      if (!rel) parts.push("缺关系词（如 仇人/盟友/师徒）");
      return { kind: "ask", question: `建立关系还差：${parts.join("、")}。${a || b ? "请选择或输入另一个角色" : "请选择两个角色"}：`, options };
    }
  }
  return null;
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
    const author = authorFromEditPrompt(params, opts?.prompt);
    if (author || /(?:作者|署名)/.test(opts?.prompt ?? "")) {
      return {
        kind: "form", title: "修改作者署名", commandId: "CMD-W12", level: "L2",
        summary: author ? `请确认将作者署名修改为「${author}」。` : "请输入新的作者署名，确认后写入故事信息。",
        fields: [{ key: "author", label: "作者署名", type: "text", value: author || (w.author ?? ""), placeholder: "可留空" }],
        action: { endpoint: "/api/novel/world", method: "POST", body: {} },
        submitLabel: "保存署名",
      };
    }
    const current = currentFromEditPrompt(params, opts?.prompt);
    // 设定/全局编辑（无角色语境 → 设定表单）
    return {
      kind: "form", title: "编辑设定与全局信息", commandId: "CMD-W12", level: "L0",
      summary: summary || "修改故事设定/梗概/当前状态（不回溯已写章节）",
      fields: [
        { key: "premise", label: "梗概", type: "textarea", value: w.premise, array: false },
        { key: "current", label: "全局当前状态", type: "text", value: current || (w.current ?? ""), placeholder: "季节/天气/局势（单行）" },
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
  // 剩余可生成张数（下拉选择依据）：每章上限 MAX_IMAGES_PER_CHAPTER，扣掉已有插画（含生成中的 pending）
  // —— 前端切换章节时也会用 world 实时重算（brain-cards 动态 options），此处按默认章节兜底
  const quotaCh = validIdx != null ? chapters.find((c) => c.index === validIdx) : undefined;
  const existingImgs = (quotaCh?.media ?? []).filter(imageOccupiesQuota).length;
  const remaining = Math.max(0, MAX_IMAGES_PER_CHAPTER - existingImgs);
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
  if (kind === "image") {
    fields.push({
      key: "count",
      label: `张数（还可生成 ${remaining} 张）`,
      type: "select",
      value: remaining > 0 ? Math.min(count, remaining) : 0,
      options: remaining > 0
        ? Array.from({ length: remaining }, (_, i) => ({ label: `${i + 1} 张`, value: String(i + 1) }))
        : [{ label: "本章插画已满（上限 " + MAX_IMAGES_PER_CHAPTER + " 张）", value: "0" }],
    });
  }
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

/** 打开面板映射：open_* 意图 → 前端 onOpenPanel 分发键（target）/ 标题 / 定位参数（opts）/ 时机校验（blocked 返回拒绝原因） */
const OPEN_PANELS: Record<
  string,
  {
    title: string;
    target: string;
    detail: string;
    opts?: (params: Record<string, unknown>, prompt?: string) => Record<string, unknown> | undefined;
    /** 时机校验：返回非空字符串 = 拒绝并告知用户何时可操作（params 供 index 等提取） */
    blocked?: (w: WorldState, ctx?: BrainChatContext["ctx"], params?: Record<string, unknown>) => string | null;
  }
> = {
  open_proposals: {
    title: "新角色提案", target: "proposals",
    detail: "已为你打开底部新角色提案面板，可在其中查看推荐原因并确认/拒绝。",
  },
  open_settings: {
    title: "打开设置", target: "settings",
    detail: "已为你打开系统设置弹窗。",
    opts: (params, prompt) => {
      const t = String(params.tab ?? "");
      if (["全局", "章节", "设定", "角色", "大纲", "导出"].includes(t)) return { tab: t };
      // LLM 未提取 tab 时从用户输入兜底：添加/新建角色、用户（人物）页面 → 角色页（本系统无独立用户资料页）
      const p = prompt ?? "";
      if (/添加.{0,6}角色|新建.{0,6}角色|新建人物|用户页面|人物页面|角色页|加.{0,3}角色/.test(p)) return { tab: "角色" };
      return undefined;
    },
  },
  open_relationships: {
    title: "打开关系图", target: "relationships",
    detail: "已为你打开人物关系图，可查看各角色间的关联；点击角色可查看详情。",
  },
  open_taskcenter: {
    title: "打开任务中心", target: "taskcenter",
    detail: "已为你打开任务中心，可查看连载/推进任务进度与待确认事项。",
  },
  open_foreshadow: {
    title: "打开伏笔账", target: "foreshadow",
    detail: "已为你打开伏笔账，可查看全部伏笔的埋设/回收状态并增删改。",
  },
  open_review: {
    title: "打开审查面板", target: "review",
    detail: "已为你打开审查面板。",
    // 优先取用户明确指定的章节（params.index），其次当前选中章
    opts: (params) => {
      const i = params?.index;
      return i != null && i !== "" && Number.isFinite(Number(i)) ? { index: Number(i) } : undefined;
    },
    blocked: (w, ctx, params) => {
      const specified = params?.index != null && params.index !== "" ? Number(params.index) : null;
      const idx = specified != null && Number.isFinite(specified) ? specified : (typeof ctx?.chapterIndex === "number" ? ctx.chapterIndex : null);
      const ch = idx != null && Number.isFinite(idx) ? w.chapters.find((c) => c.index === idx) : undefined;
      if (specified != null && Number.isFinite(specified) && !ch) return `第 ${specified} 章不存在或还没有审查记录，写完并保存后会自动生成审查报告。`;
      if (idx == null || !Number.isFinite(idx) || !ch) return "请先指定或选中一个已写章节，再让我打开它的审查面板。";
      if (!ch.review) return `第 ${idx} 章还没有审查记录，写完并保存后会自动生成审查报告。`;
      return null;
    },
  },
  open_eval: {
    title: "打开整书评估", target: "eval",
    detail: "已为你打开整书评估面板。",
    blocked: (w) => (w.chapters.length === 0 ? "还没有已写章节，写完第一章后即可评估整书质量。" : null),
  },
  open_gacha: {
    title: "打开卡池", target: "gacha",
    detail: "已为你打开卡池面板，可抽卡并查看待应用的卡牌。",
  },
  open_autostart: {
    title: "打开自动连载", target: "autostart",
    detail: "已为你打开自动连载确认框，配置目标章数后即可开始。",
    blocked: (w) => {
      const revise = w.chapters.filter((c) => c.review?.verdict === "revise");
      if (revise.length) {
        return `当前有 ${revise.length} 章需修订（第 ${revise.map((c) => c.index).join("、")} 章），自动连载前请先处理修订（章节操作栏「AI 修复」，或让我调出审查报告）。修订完成后随时可再让我打开自动连载。`;
      }
      return null;
    },
  },
  open_memory: {
    title: "打开记忆·台账", target: "memory",
    detail: "已为你打开记忆·台账，可查看分层记忆与操作日志。",
  },
};

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
    // 前端清空该消息，后续 delta 重新填充（避免已生成文本与新流重复拼接）。
    // 注意：与 attach（断线续流，reset 携带 text/thinking 重放）不同，resume 是重新生成，
    // 必须不带 text/thinking——否则旧内容 + 新流 append 叠加造成重复拼接。
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
    const { intent, params, reply } = explicitMediaIntent(activePrompt)
      ?? explicitSettingsQuery(activePrompt)
      ?? await recognizeIntent(w, activePrompt, ctx.ctx, hist);

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
      // 系统状态冲突前置检测（抽卡为写操作，与连载/写作任务冲突时拒绝）
      const gachaBusy: string[] = [];
      if (ctx.ctx?.autoRunning) gachaBusy.push("自动连载正在运行中");
      if (ctx.ctx?.writingRunning) gachaBusy.push("写作任务进行中");
      if (ctx.ctx?.systemStatus) gachaBusy.push(ctx.ctx.systemStatus);
      const sv3 = ctx.ctx?.server;
      if (sv3?.advanceTaskRunning) gachaBusy.push("推进任务进行中");
      if (sv3?.mediaGenerating) gachaBusy.push("插画/视频生成中");
      if (gachaBusy.length) {
        const text = reply || meta.title;
        if (text) {
          updateMessageText(title, sessionId, messageId, text, true);
          send({ type: "delta", messageId, text });
        }
        const busyCard: BrainChatCard = {
          kind: "result", title: meta.title, success: false,
          detail: `当前${gachaBusy.join("、")}，为避免与运行中任务冲突暂不执行「${meta.title}」。可先等待完成或中断后再试。`,
        };
        markMessageDone(title, sessionId, messageId, [busyCard]);
        send({ type: "card", messageId, card: busyCard });
        send({ type: "done", messageId });
        return;
      }
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
      // 正文为提示性文案（去「正在…生成」的误导：此时仅收集参数，尚未开始生成）；
      // 前端渲染时（BrainCabin.mediaGuideText）会跟随卡片章节/张数选项实时更新正文（bc-msg-text）
      const text = intent === "media_video"
        ? "请选择生成视频的章节，确认后开始生成。"
        : "请选择生成插画的参数（章节与张数），确认后开始生成。";
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
      const text = intent === "edit_world" ? "请核对下方待修改内容；提交前不会写入故事。" : (reply || meta.title);
      if (text) {
        updateMessageText(title, sessionId, messageId, text, true);
        send({ type: "delta", messageId, text });
      }
      // 从对话历史收集表单参数：最近用户消息原文（供 buildFormCard 预填角色名等，需求：信息可从对话收集）
      const userHist = (session?.messages ?? []).filter((m) => m.role === "user").slice(-5).map((m) => m.text ?? "");
      const card = buildFormCard(w, intent, params, intent === "edit_world" ? undefined : reply, { userHist, prompt: activePrompt });
      if (card) {
        markMessageDone(title, sessionId, messageId, [card]);
        send({ type: "card", messageId, card });
      } else {
        // 信息不足：优先结构化 ask 追问卡（输入框上方询问面板，选项可点选，刷新后恢复）；
        // 无法生成候选时降级为自然对话流追问
        const ask = buildAskCard(w, intent, params);
        if (ask) {
          markMessageDone(title, sessionId, messageId, [ask]);
          send({ type: "card", messageId, card: ask });
        } else {
          await streamChatReply({ ...ctx, prompt: `用户想要「${meta.title}」，但缺少必要信息（如具体要编辑哪个角色、哪条伏笔）。请用一到两句自然的中文，询问用户需要补充的具体信息。不要执行任何操作。` }, messageId);
          markMessageDone(title, sessionId, messageId);
        }
      }
      send({ type: "done", messageId }); // card 分支与询问分支共用一次 done
      return;
    }

    // —— 角色写操作：评估 → 直接执行（关系/增删改）或拒绝（给原因，不轻易拒绝）——
    // relationship_edit：给张三和李四建立仇人关系 → 评估冲突 → 通过直接写世界 + 「已建立关系：张三-(仇人)-李四」
    // create_character / edit_character / delete_character：便捷增删改（参数不足先 ask 追问）
    if (intent === "relationship_edit" || intent === "create_character" || intent === "edit_character" || intent === "delete_character") {
      // 系统状态冲突前置检测：自动连载/写作任务运行中 → 拒绝写操作（load-modify-save 与连载任务竞态会互相覆盖）
      const roleBusyReasons: string[] = [];
      if (ctx.ctx?.autoRunning) roleBusyReasons.push("自动连载正在运行中");
      if (ctx.ctx?.writingRunning) roleBusyReasons.push("写作任务进行中");
      if (ctx.ctx?.systemStatus) roleBusyReasons.push(ctx.ctx.systemStatus);
      const svR = ctx.ctx?.server;
      if (svR?.advanceTaskRunning) roleBusyReasons.push("推进任务进行中");
      if (svR?.mediaGenerating) roleBusyReasons.push("插画/视频生成中");
      if (roleBusyReasons.length) {
        const busyCard: BrainChatCard = {
          kind: "result", title: meta.title, success: false,
          detail: `当前${roleBusyReasons.join("、")}，为避免与运行中任务冲突暂不执行「${meta.title}」。可先等待完成或中断后再试。`,
        };
        markMessageDone(title, sessionId, messageId, [busyCard]);
        send({ type: "card", messageId, card: busyCard });
        send({ type: "done", messageId });
        return;
      }
      // 先发「评估中」提示（delta），再出结果——呈现 评估中 → 结果 的过程（SSE 输出保持锁外）
      const assessing = reply || (intent === "relationship_edit" ? "正在评估关系与现状的冲突…" : `正在处理「${meta.title}」…`);
      if (assessing) {
        updateMessageText(title, sessionId, messageId, assessing, true);
        send({ type: "delta", messageId, text: assessing });
      }
      let result: BrainChatCard | null = null;
      let askCard: { kind: "ask"; question: string; options: { label: string; description?: string }[] } | null = null;
      // 只锁 world 读写事务（load→修改→save），与连载/其他写操作互斥，避免基于旧快照互相覆盖；
      // 锁内重新 loadWorld 拿最新快照。上方软忙碌检测与 SSE 输出均在锁外。
      await withTitleLock(slug(title), async () => {
        const w = brainChatDeps.loadWorld(title);
        if (!w) {
          result = null;
          askCard = null;
          return;
        }
        if (intent === "relationship_edit") {
          const aName = String(params.nameA ?? params.a ?? "").trim();
          const bName = String(params.nameB ?? params.b ?? "").trim();
          const rel = typeof params.relation === "string" ? params.relation.trim() : "";
          const remove = params.remove === true || params.action === "remove";
          const a = aName ? w.characters.find((c) => c.name.includes(aName) || aName.includes(c.name)) : undefined;
          const b = bName ? w.characters.find((c) => c.name.includes(bName) || bName.includes(c.name)) : undefined;
          if (!aName || !bName || !rel) {
            // 参数不足 → ask 追问（不轻易拒绝）
            askCard = buildAskCard(w, "relationship_edit", params);
          } else if (!a || !b) {
            const missing = !a ? aName : bName;
            result = {
              kind: "result", title: "关系未建立", success: false,
              detail: `「${missing}」还不在这本书里，暂时无法建立关系。可以让我「新建角色 ${missing}」，或从现有角色里选一个（现有：${w.characters.slice(0, 5).map((c) => c.name).join("、")}${w.characters.length > 5 ? "…" : ""}）。`,
            };
          } else if (a.id === b.id) {
            result = { kind: "result", title: "关系未建立", success: false, detail: "不能与自己建立关系，请选择两个不同角色。" };
          } else {
            // 宽松评估：不轻易拒绝——已存在同值关系幂等确认；异值关系升级覆盖；无冲突直接建立
            const existingA = a.relations?.[b.name];
            const existingB = b.relations?.[a.name];
            if (remove) {
              const ra = { ...(a.relations ?? {}) };
              delete ra[b.name];
              a.relations = ra;
              const rb = { ...(b.relations ?? {}) };
              delete rb[a.name];
              b.relations = rb;
            } else {
              a.relations = { ...(a.relations ?? {}), [b.name]: rel };
              b.relations = { ...(b.relations ?? {}), [a.name]: rel };
            }
            logChange(w, {
              chapter: w.nextChapter, actor: "user", kind: "relationship-edit",
              detail: remove
                ? `解除关系：${a.name}-(${existingA ?? "原关系"})-${b.name}`
                : `${existingA ? `更新关系（原「${String(existingA).slice(0, 20)}」）` : "建立关系"}：${a.name}-(${rel})-${b.name}`,
              commandId: "CMD-W12",
            });
            saveWorld(w);
            result = {
              kind: "result", title: remove ? "关系已解除" : "关系已建立", success: true,
              detail: remove
                ? `已解除关系：${a.name}-(${existingA ?? "原关系"})-${b.name}`
                : `已建立关系：${a.name}-(${rel})-${b.name}${existingA ? `（原关系已更新）` : ""}${existingB ? `（反向关系 ${b.name}-(${existingB})-${a.name} 已同步更新）` : ""}`,
            };
          }
        } else if (intent === "create_character") {
          const cName = String(params.name ?? "").trim();
          const role = String(params.role ?? "配角").trim();
          if (!cName) {
            askCard = buildAskCard(w, "create_character", params);
          } else if (w.characters.some((c) => c.name === cName)) {
            result = { kind: "result", title: "角色已存在", success: false, detail: `「${cName}」已经在这本书里了（${w.characters.find((c) => c.name === cName)?.role}）。可以让我「修改角色 ${cName}」或「查看 ${cName}」。` };
          } else {
            const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            w.characters.push({
              id, name: cName, role, traits: [], motivation: String(params.motivation ?? ""),
              status: String(params.status ?? "在世"), relations: {}, introducedAt: Date.now(),
            });
            logChange(w, { chapter: w.nextChapter, actor: "user", kind: "character-create", detail: `新建角色「${cName}」（${role}）`, commandId: "CMD-W12" });
            saveWorld(w);
            result = {
              kind: "result", title: "角色已创建", success: true,
              detail: `已创建角色：${cName}（定位：${role}）。可让我「为 ${cName} 生成立绘」「给 ${cName} 和某角色建立关系」，或在「打开设置-角色」页完善信息。`,
            };
          }
        } else if (intent === "edit_character") {
          const eName = String(params.name ?? "").trim();
          const c = eName ? w.characters.find((x) => x.name.includes(eName) || eName.includes(x.name)) : undefined;
          if (!eName || !c) {
            // 缺名/找不到 → ask 追问（候选角色）或明确提示
            if (eName) {
              result = { kind: "result", title: "角色未找到", success: false, detail: `没有叫「${eName}」的角色。现有角色：${w.characters.slice(0, 5).map((x) => x.name).join("、")}${w.characters.length > 5 ? "…" : ""}` };
            } else {
              askCard = buildAskCard(w, "edit_world", params);
            }
          } else {
            const updates: string[] = [];
            if (params.role != null) { c.role = String(params.role); updates.push(`定位→${String(params.role)}`); }
            if (params.status != null) { c.status = String(params.status); updates.push(`状态→${String(params.status)}`); }
            if (params.age != null) { c.age = String(params.age); updates.push(`年龄→${String(params.age)}`); }
            if (params.identity != null) { c.identity = String(params.identity); updates.push(`身份→${String(params.identity)}`); }
            if (params.motivation != null) { c.motivation = String(params.motivation); updates.push(`动机→${String(params.motivation).slice(0, 20)}${String(params.motivation).length > 20 ? "…" : ""}`); }
            if (params.look != null) { c.look = String(params.look); updates.push(`形象→${String(params.look).slice(0, 20)}`); }
            if (params.voice != null) { c.voice = String(params.voice); updates.push(`声线→${String(params.voice)}`); }
            if (!updates.length) {
              result = { kind: "result", title: "未修改", success: false, detail: `请告诉我要修改「${c.name}」的哪一项（定位/状态/年龄/身份/动机/形象/声线），如「把 ${c.name} 的状态改成负伤」。` };
            } else {
              logChange(w, { chapter: w.nextChapter, actor: "user", kind: "character-edit", detail: `修改角色「${c.name}」：${updates.join("、")}`, commandId: "CMD-W12" });
              saveWorld(w);
              result = { kind: "result", title: "角色已更新", success: true, detail: `已更新「${c.name}」：${updates.join("、")}。` };
            }
          }
        } else if (intent === "delete_character") {
          const dName = String(params.name ?? "").trim();
          const c = dName ? w.characters.find((x) => x.name.includes(dName) || dName.includes(x.name)) : undefined;
          if (!dName || !c) {
            result = dName
              ? { kind: "result", title: "角色未找到", success: false, detail: `没有叫「${dName}」的角色。现有角色：${w.characters.slice(0, 5).map((x) => x.name).join("、")}${w.characters.length > 5 ? "…" : ""}` }
              : { kind: "result", title: "未删除", success: false, detail: "请告诉我要删除哪个角色，如「删除角色 刘二」。" };
          } else if ((c.appearedIn ?? []).length || w.chapters.some((ch) => ch.text.includes(c.name))) {
            result = { kind: "result", title: "无法删除", success: false, detail: `「${c.name}」已在 ${(c.appearedIn ?? []).length || "部分"} 个章节出场，删除会破坏已写剧情。建议改为「把 ${c.name} 的状态改成离场」或在关系图中解除其关系后继续使用。` };
          } else {
            const idx = w.characters.indexOf(c);
            w.characters.splice(idx, 1);
            logChange(w, { chapter: w.nextChapter, actor: "user", kind: "character-delete", detail: `删除角色「${c.name}」`, commandId: "CMD-W12" });
            saveWorld(w);
            result = { kind: "result", title: "角色已删除", success: true, detail: `已删除角色：${c.name}。` };
          }
        }
      });
      // 锁内发现世界已不存在：保持原行为——仅收尾 done，不出卡片
      if (!result && !askCard) {
        markMessageDone(title, sessionId, messageId, []);
        send({ type: "done", messageId });
        return;
      }
      if (askCard) {
        markMessageDone(title, sessionId, messageId, [askCard]);
        send({ type: "card", messageId, card: askCard });
      } else {
        const finalCard = result!;
        markMessageDone(title, sessionId, messageId, [finalCard]);
        send({ type: "card", messageId, card: finalCard });
      }
      send({ type: "done", messageId });
      return;
    }

    // 操作意图：reply 作为开场回复（一次性 delta，前端打字机动画）
    const text = reply || meta.title;
    if (text) {
      updateMessageText(title, sessionId, messageId, text, true);
      send({ type: "delta", messageId, text });
    }

    const cards: BrainChatCard[] = [];

    // —— 打开系统面板/弹窗：纯 UI 导航（result 卡带 open 字段，前端统一分发触发对应弹窗） ——
    // 时机校验：需在正确时机才能触发的（自动连载须无待修订章、评估须有已写章、审查须选中章有报告）在服务端拒绝并说明
    // 注意：开场回复文本已由上方「操作意图」分支统一 delta 发送，此处不再重复发送（曾重复广播同一 delta）
    if (intent.startsWith("open_")) {
      const def = OPEN_PANELS[intent];
      if (!def) {
        // 未知 open 目标（模型幻觉）：明确告知不可用，避免静默落入 L0 查询分支
        const card: BrainChatCard = {
          kind: "result", title: meta.title, success: false,
          detail: "暂不支持打开该面板。可尝试：打开设置 / 关系图 / 任务中心 / 伏笔账 / 审查面板 / 卡池 / 整书评估 / 记忆·台账 / 自动连载 / 新角色提案区。",
        };
        markMessageDone(title, sessionId, messageId, [card]);
        send({ type: "card", messageId, card });
        send({ type: "done", messageId });
        return;
      }
      if (def) {
        const blocked = def.blocked ? def.blocked(w, ctx.ctx, params) : null;
        if (blocked) {
          const card: BrainChatCard = { kind: "result", title: meta.title, success: false, detail: blocked };
          markMessageDone(title, sessionId, messageId, [card]);
          send({ type: "card", messageId, card });
          send({ type: "done", messageId });
          return;
        }
        const card: BrainChatCard = {
          kind: "result", title: def.title, success: true, detail: def.detail,
          cardId: `card-${uid()}`,
          panelIntent: {
            intentId: `panel-${uid()}`,
            target: def.target,
            ...(def.opts ? { opts: def.opts(params, activePrompt) } : {}),
          },
          open: { target: def.target, ...(def.opts ? { opts: def.opts(params, activePrompt) } : {}) },
        };
        markMessageDone(title, sessionId, messageId, [card]);
        send({ type: "card", messageId, card });
        send({ type: "done", messageId });
        return;
      }
    }

    // —— 中枢能力清单：回复文本（流式）+ 固定摘要卡 ——
    if (intent === "read_help") {
      const card: BrainChatCard = {
        kind: "result", title: "中枢能力清单", success: true,
        detail: "数据询问：章节目录/角色（立绘·关系·出场·后续安排）/某章出场角色/人物关系/大纲/脉络时间线/伏笔/新角色提案/卡池/计划进度/任务（质量债与重写队列）/台账日志/审查报告/媒体资源/整书评估/设定世界书\n写作治理：推进剧情写一章/AI 重写章节/回溯重写/自动连载（开始·暂停·停止·跳过·确认草稿）/生成插画与视频/抽卡/设定一致性巡检/导出全书\n编辑计划：编辑设定与角色/新建·修改·删除角色/建立人物关系（如「给张三和李四建立仇人关系」）/伏笔增删改/展开弧章纲/调整生成参数/制定方案/征求意见\n打开面板：设置（含角色页）/关系图/任务中心/伏笔账/审查面板/卡池/整书评估/记忆·台账/自动连载/新角色提案区",
      };
      markMessageDone(title, sessionId, messageId, [card]);
      send({ type: "card", messageId, card });
      send({ type: "done", messageId });
      return;
    }

    // L0 查询类：直接执行 → BrowseCard/ResultCard
    if (meta.level === "L0" && !meta.action) {
      // 含糊章节提及治理：仅提章节号（如「第一章」）而无查看动作 → 追问意图（看正文/插画/审查/聊聊），不直接输出正文
      if (intent === "read_chapter" && isAmbiguousChapterPrompt(activePrompt)) {
        const ask = chapterAskCard(w, params);
        if (ask) {
          updateMessageText(title, sessionId, messageId, ask.question, true);
          send({ type: "delta", messageId, text: ask.question });
          markMessageDone(title, sessionId, messageId, [ask]);
          send({ type: "card", messageId, card: ask });
          send({ type: "done", messageId });
          return;
        }
      }
      const card = executeQuery(w, intent, params);
      if (card) {
        // 开场文本升级：LLM reply 是「这就为您调出」式空话、或角色查询需按问法侧重时，
        // 用卡片要点重写（delta 为替换语义覆盖空话，不重复拼接；保留打字机动画体验）
        const better = l0QueryReply(intent, card, activePrompt, reply);
        if (better && better !== text) {
          updateMessageText(title, sessionId, messageId, better, true);
          send({ type: "delta", messageId, text: better });
        }
        // 跨消息去重：同会话最近 3 条 assistant 消息已含相同卡（整卡 JSON 相同 = 数据未变）→ 不发卡，
        // 避免连续查询（如「哪几章需修改」「温雪见状态」）重复展示同一标题/内容的卡；文本要点已足够
        const cardJson = JSON.stringify(card);
        const dupCard = (session?.messages ?? [])
          .filter((m) => m.role === "assistant")
          .slice(-3)
          .some((m) => (m.cards ?? []).some((c) => JSON.stringify(c) === cardJson));
        if (!dupCard) {
          cards.push(card);
          send({ type: "card", messageId, card });
        } else {
          const base = better || text;
          const finalText = `${base}（数据与上次查看一致，未重复展示卡片）`;
          updateMessageText(title, sessionId, messageId, finalText, true);
          send({ type: "delta", messageId, text: finalText });
        }
      }
    } else {
      // 写操作（L0 有 action 的如 gacha/eval/integrity 也走预览卡，客户端执行）
      // —— 系统状态冲突前置检测：自动连载/写作任务运行中 → 拒绝写操作，给失败 result 卡（不生成 preview，避免双跑） ——
      const busyReasons: string[] = [];
      if (ctx.ctx?.autoRunning) busyReasons.push("自动连载正在运行中");
      if (ctx.ctx?.writingRunning) busyReasons.push("写作任务进行中");
      if (ctx.ctx?.systemStatus) busyReasons.push(ctx.ctx.systemStatus);
      const sv2 = ctx.ctx?.server;
      if (sv2?.advanceTaskRunning) busyReasons.push("推进任务进行中");
      if (sv2?.mediaGenerating) busyReasons.push("插画/视频生成中");
      if (busyReasons.length) {
        const text = reply || meta.title;
        if (text) {
          updateMessageText(title, sessionId, messageId, text, true);
          send({ type: "delta", messageId, text });
        }
        const busyCard: BrainChatCard = {
          kind: "result", title: meta.title, success: false,
          detail: `当前${busyReasons.join("、")}，为避免与运行中任务冲突暂不执行「${meta.title}」。可先等待完成或中断后再试。`,
        };
        markMessageDone(title, sessionId, messageId, [busyCard]);
        send({ type: "card", messageId, card: busyCard });
        send({ type: "done", messageId });
        return;
      }
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
