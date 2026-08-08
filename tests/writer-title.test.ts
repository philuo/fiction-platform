// 章节标题生成回归（修「标题变成长句」）：
// parseDraft 兼容【标题】/【XX】/标题：变体；isTitleLike 拒绝目标句；缺失标题时 LLM 提炼兜底而非截断 plan.goal。
import { describe, expect, test } from "bun:test";

import { installMockAgnes } from "./mocks";

let draftMode: "standard" | "selfFormat" | "noTitle" = "standard";
let nameMode: "ok" | "garbage" | "throw" = "ok";

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  // 章节命名兜底（summarizeChapterTitle）
  if (sys.includes("章节命名编辑")) {
    if (nameMode === "throw") throw new Error("模拟提炼失败");
    if (nameMode === "garbage") return "```json\n{}```";
    return "提炼标题";
  }
  // 导演写作（writeChapter）
  if (sys.includes("导演")) {
    const body = "第一段正文。\n\n第二段正文。";
    if (draftMode === "selfFormat") return `【衣债】\n\n${body}`;
    if (draftMode === "noTitle") return body;
    return `【标题】标准标题\n\n${body}`;
  }
  return "{}";
});

const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { writeChapter, parseDraft, isTitleLike } = await import("../src/api/writer");

function makeWorld() {
  const w = emptyWorld();
  w.title = "标题测试";
  w.setting = { time: "架空", place: "南城", rules: [], tone: "冷峻" };
  w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
  // 目标字数贴合短测试正文，避免触发续写补足干扰标题断言
  w.gen = { ...DEFAULT_GEN, targetChapterWords: 12, minWords: 10, maxWords: 10000, autoGacha: false };
  return w;
}

describe("parseDraft 标题解析", () => {
  test("标准【标题】格式", () => {
    const r = parseDraft("【标题】跪尸巷\n\n正文一。\n\n正文二。", "第1章");
    expect(r.title).toBe("跪尸巷");
    expect(r.text).toBe("正文一。\n\n正文二。");
  });

  test("模型自创【XX】格式：采纳并从正文剥离", () => {
    const r = parseDraft("【衣债】\n\n正文一。", "第1章");
    expect(r.title).toBe("衣债");
    expect(r.text).toBe("正文一。");
  });

  test("「标题：XX」冒号变体", () => {
    const r = parseDraft("标题：梦引\n\n正文一。", "第1章");
    expect(r.title).toBe("梦引");
    expect(r.text).toBe("正文一。");
  });

  test("首行无标题：回退 fallback 且正文首行保留", () => {
    const r = parseDraft("南城的雨下了整三日。\n\n第二段。", "第3章");
    expect(r.title).toBe("第3章");
    expect(r.text).toBe("南城的雨下了整三日。\n\n第二段。");
  });
});

describe("isTitleLike 标题健全判定", () => {
  test("短词组通过", () => {
    expect(isTitleLike("跪尸巷")).toBe(true);
    expect(isTitleLike("梦引")).toBe(true);
  });
  test("目标长句（含逗号/超长）拒绝", () => {
    expect(isTitleLike("让沈青梧主动入梦深挖旧案，却触发赵崇的暗")).toBe(false);
  });
  test("第N章 / 空 / 括号符号拒绝", () => {
    expect(isTitleLike("第3章")).toBe(false);
    expect(isTitleLike("")).toBe(false);
    expect(isTitleLike("```json")).toBe(false);
  });
});

describe("writeChapter 标题兜底", () => {
  test("标准格式直接采用", async () => {
    draftMode = "standard";
    const r = await writeChapter({ world: makeWorld(), instruction: "", chapterIndex: 1 });
    expect(r.title).toBe("标准标题");
  });

  test("自创格式【衣债】采纳为标题并剥离首行", async () => {
    draftMode = "selfFormat";
    const r = await writeChapter({ world: makeWorld(), instruction: "", chapterIndex: 1 });
    expect(r.title).toBe("衣债");
    expect(r.text.startsWith("【衣债】")).toBe(false);
  });

  test("缺失标题行 → LLM 提炼兜底（不再截断 plan.goal）", async () => {
    draftMode = "noTitle";
    nameMode = "ok";
    const r = await writeChapter({
      world: makeWorld(), instruction: "", chapterIndex: 1,
      plan: { index: 1, arcId: "a1", goal: "让沈青梧主动入梦深挖旧案，却触发赵崇的暗网拦截，并暴露魏无踪的模糊立场。", beats: ["节拍"], hookType: "悬念", status: "planned" },
    });
    expect(r.title).toBe("提炼标题");
  });

  test("提炼失败 → 回退第N章（而非目标长句）", async () => {
    draftMode = "noTitle";
    nameMode = "throw";
    const r = await writeChapter({ world: makeWorld(), instruction: "", chapterIndex: 3 });
    expect(r.title).toBe("第3章");
  });

  test("提炼输出垃圾 → 回退第N章", async () => {
    draftMode = "noTitle";
    nameMode = "garbage";
    const r = await writeChapter({ world: makeWorld(), instruction: "", chapterIndex: 5 });
    expect(r.title).toBe("第5章");
  });
});
