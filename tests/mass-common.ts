// 全链路 mock 长跑基建：10 本 × 10-30 章参数化（P1）+ 鲁棒性/恢复/媒体测试共用。
// 单例模式：installFullMock 仅安装一次 mock（bun mock.module 对已缓存模块幂等），
// 每次测试通过 setSpec/installFullMock(spec) 切换当前书参数，responder 运行时读取 activeSpec。
// 必须在 import 任何 src/api 模块【之前】首次调用 installFullMock。
import { mock } from "bun:test";

export type BookSpec = {
  idx: number; // 第几本（生成唯一书名/角色名）
  title: string;
  genre: string;
  targetChapters: number; // 10-30
  strictness: "宽松" | "标准" | "严格";
  charCount: number; // 立项角色数 2-4
  targetWords: number; // 每章目标字数（正文 mock 长度）
  minWords: number;
  maxWords: number;
};

/** 10 本测试书参数矩阵：题材/角色数/字数/严格度/章节数全维度覆盖 */
export const BOOK_SPECS: BookSpec[] = [
  { idx: 1, title: "测试古风悬疑", genre: "古风悬疑", targetChapters: 10, strictness: "标准", charCount: 3, targetWords: 120, minWords: 60, maxWords: 800 },
  { idx: 2, title: "测试星际冒险", genre: "星际", targetChapters: 12, strictness: "宽松", charCount: 4, targetWords: 150, minWords: 80, maxWords: 900 },
  { idx: 3, title: "测试武侠秘闻", genre: "武侠", targetChapters: 15, strictness: "标准", charCount: 2, targetWords: 130, minWords: 70, maxWords: 850 },
  { idx: 4, title: "测试都市怪谈", genre: "都市怪谈", targetChapters: 18, strictness: "严格", charCount: 3, targetWords: 160, minWords: 90, maxWords: 1000 },
  { idx: 5, title: "测试科幻末世", genre: "科幻", targetChapters: 20, strictness: "标准", charCount: 4, targetWords: 140, minWords: 80, maxWords: 950 },
  { idx: 6, title: "测试修仙问道", genre: "修仙", targetChapters: 22, strictness: "严格", charCount: 3, targetWords: 170, minWords: 100, maxWords: 1100 },
  { idx: 7, title: "测试宫斗风云", genre: "宫斗", targetChapters: 25, strictness: "宽松", charCount: 4, targetWords: 150, minWords: 80, maxWords: 1000 },
  { idx: 8, title: "测试奇幻世界", genre: "奇幻", targetChapters: 26, strictness: "标准", charCount: 3, targetWords: 160, minWords: 90, maxWords: 1050 },
  { idx: 9, title: "测试推理案件", genre: "悬疑推理", targetChapters: 28, strictness: "严格", charCount: 3, targetWords: 150, minWords: 80, maxWords: 1000 },
  { idx: 10, title: "测试历史权谋", genre: "历史权谋", targetChapters: 30, strictness: "标准", charCount: 4, targetWords: 180, minWords: 100, maxWords: 1200 },
];

const EVAL_NAMES = ["剧情逻辑", "人物塑造", "节奏张力", "文笔风格", "爽点钩子", "伏笔管理", "设定一致", "主题立意"];

let active: BookSpec | null = null;
let installed = false;
let _writeCalls = 0; // 每本书重置（setSpec）
let _settleCalls = 0;

/** 切换当前书参数（responder 运行时读取） */
export function setSpec(spec: BookSpec): void {
  active = spec;
  _writeCalls = 0;
  _settleCalls = 0;
}

/** 安装全链路 mock（幂等：只装一次）；spec 缺省时用当前 active */
export function installFullMock(spec?: BookSpec): void {
  if (spec) active = spec;
  if (installed) return;
  installed = true;
  mock.module("../src/api/agnes", () => {
    class LLMError extends Error {}
    const responder = (messages: { role: string; content: string }[]) => {
      const spec = active ?? BOOK_SPECS[0];
      const sys = messages[0]?.content ?? "";
      const names = [`主角${spec.idx}`, `同伴${spec.idx}`, `对手${spec.idx}`, `路人${spec.idx}`].slice(0, spec.charCount);
      const hero = names[0];

      // 立项（director.newStory）
      if (sys.includes("立项导演")) {
        return JSON.stringify({
          title: spec.title,
          genre: spec.genre,
          premise: `${spec.title}：主角${spec.idx}卷入一场牵动全局的阴谋，需要抽丝剥茧。`,
          setting: { time: "架空", place: `${spec.title}城`, rules: ["规则一：世界自有其法则", "规则二：关键之物不可轻得"], tone: "冷峻克制" },
          characters: names.map((n, i) => ({
            name: n,
            gender: i % 2 === 0 ? "男" : "女",
            age: "二十出头",
            identity: i === 0 ? "捕快" : i === 1 ? "医者" : "游侠",
            role: i === 0 ? "主角" : i === names.length - 1 ? "反派" : "配角",
            traits: [i === 0 ? "机警" : "沉稳", "执着"],
            motivation: i === 0 ? "查明真相" : "守护同伴",
            secret: i === 0 ? undefined : "隐藏身份",
            status: "登场",
            relations: {},
            voice: i === 0 ? "简短冷峻，爱用反问" : "温婉绵长，常用比喻",
          })),
        });
      }
      // 蓝图（planner.buildBlueprint）
      if (sys.includes("设计 2-3 套")) {
        return JSON.stringify({
          options: [{
            theme: `${spec.title}的宿命与抗争`,
            mainPlot: "主角追查阴谋，逐步逼近幕后黑手",
            ending: "真相大白，主角做出最终抉择",
            compass: "沿主线推进，保持张力",
            progressContract: "前 10 章立足世界观与首个悬念弧，中段推进主线反转，结尾收束",
            volumes: [
              { title: "第一卷", goal: "建立世界观与首弧冲突", arcs: [
                { title: "初入漩涡", goal: "主角卷入阴谋", arcType: "成长突破", estChapters: 4 },
                { title: "线索浮现", goal: "追查第一条线索", arcType: "恩怨冲突", estChapters: 4 },
              ] },
              { title: "第二卷", goal: "推进主线反转", arcs: [
                { title: "真相逼近", goal: "发现幕后黑手", arcType: "探索发现", estChapters: 4 },
                { title: "终局对决", goal: "最终收束", arcType: "竞技对抗", estChapters: 4 },
              ] },
            ],
          }],
        });
      }
      // 弧展开（planner.expandArc）
      if (sys.includes("分卷编辑")) {
        return JSON.stringify({
          chapters: [
            { goal: "推进弧目标", beats: ["事件推进", "冲突升级"], hookType: "悬念" },
            { goal: "深化线索", beats: ["线索追查", "遭遇阻碍"], hookType: "危机" },
            { goal: "弧内收束", beats: ["对决", "新的悬念"], hookType: "反转" },
          ],
        });
      }
      // 指南针更新（planner.updateCompass，卷边界）
      if (sys.includes("一卷已经写完")) {
        return JSON.stringify({ compass: "继续追查主线，逐步逼近真相", note: "本卷收束，下卷进入反转阶段" });
      }
      // 章摘要（memory.summarizeChapter）
      if (sys.includes("随场书记员")) {
        return JSON.stringify({
          summary: `${hero}在本章推进了调查，新的线索浮现，局势更加紧张。`,
          events: ["调查推进"],
          appeared: names,
          stateChanges: [],
          hook: "新的疑点浮现",
        });
      }
      // 弧/卷摘要归并（memory.summarizeRange）
      if (sys.includes("档案员")) {
        return JSON.stringify({ summary: `${spec.title}本阶段：主角推进主线，揭开第一层阴谋。` });
      }
      // 审查（critic.reviewChapter）
      if (sys.includes("审查者")) {
        return JSON.stringify({
          criteria: [{ name: "张力", rubric: "冲突推进" }, { name: "一致性", rubric: "人设行为" }],
          verdict: "pass",
          scores: { coherence: 8, tension: 8, prose: 7, pacing: 7, dialogue: 8 },
          findings: [],
          foreshadow_notes: "无异常",
        });
      }
      // 记账（chronicler.settleChapter）
      if (sys.includes("记账者")) {
        _settleCalls++;
        return JSON.stringify({
          summary: `${hero}在${spec.title}城中推进调查，线索指向更深的阴谋。`,
          events: ["调查推进"],
          appeared: names,
          stateChanges: [],
          hook: "新的疑点浮现",
          new_foreshadowing: [{ text: `神秘信物的来历·${_settleCalls}`, note: "后续回收", dueHint: "3 章内" }],
          resolved_foreshadowing: [],
          character_updates: [{ name: hero, status: `调查中·第${_settleCalls}阶段` }],
          character_relations: [],
          character_exits: [],
          timeline_summary: `${hero}推进调查`,
          world_current: "故事进入白热化",
          plot_threads: [],
          new_characters: [],
          setting_rules: [],
        });
      }
      // 整书评估（eval.evaluateBook）
      if (sys.includes("资深网文主编")) {
        return JSON.stringify({
          dimensions: EVAL_NAMES.map((name) => ({ name, score: 8, evidence: "主线推进清晰，人物动机成立" })),
          suggestions: ["保持悬念节奏", "深化配角弧光", "收束早期伏笔"],
        });
      }
      // 干预影响评估（steering）
      if (sys.includes("连续性顾问")) {
        return JSON.stringify({ conflicts: [], reverseRelationHint: "" });
      }
      // 抽卡（cards.generateCardPool，autoGacha 默认关闭）
      if (sys.includes("抽卡系统")) {
        return JSON.stringify({ cards: [] });
      }
      // 导演写作（writer.writeChapter，纯文本非 JSON）
      if (sys.includes("导演")) {
        _writeCalls++;
        const n = _writeCalls;
        const lines = [
          `${hero}走进${spec.title}城的街巷，风卷起尘土，灯火在远处明灭。他停下脚步，望向夜色深处，心头微沉。`,
          `「线索指向这里。」${names[1] ?? "同伴"}低声说道，神色凝重。`,
          `远处传来脚步声，${names[names.length - 1]}的身影在阴影里若隐若现，空气骤然绷紧。`,
          `${hero}攥紧拳头，知道今夜不会太平。他深吸一口气，朝灯火最亮处走去。`,
        ];
        let body = lines.join("\n\n");
        while (body.length < spec.minWords) body += `\n\n${hero}继续前行，夜色如墨，唯有心中那点执念不曾熄灭。`;
        body = body.slice(0, spec.maxWords);
        return `【标题】第${n}章·夜探${spec.title}\n\n${body}`;
      }
      return "{}";
    };
    return {
      LLMError,
      chat: async (messages: { role: string; content: string }[]) => responder(messages),
      complete: async (messages: { role: string; content: string }[]) => ({ content: responder(messages) }),
      chatStream: async (messages: { role: string; content: string }[], onChunk: (d: string) => void) => {
        const full = responder(messages);
        for (let i = 0; i < full.length; i += 64) onChunk(full.slice(i, i + 64));
        return full;
      },
    };
  });
}

/** 单测快捷方式：直接替换 responder（继承既有 tests/mocks.ts 语义） */
export { installMockAgnes } from "./mocks";
