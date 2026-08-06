// P4 长篇连载集成测试：mock LLM 下跑 5 章自动连载
// 断言：章摘要回写 / 章纲核销 / 弧边界 / 时间线 / checkpoint / 打断零污染 / 上下文预算
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMockAgnes } from "./mocks";

let writerCalls = 0;
let settleCalls = 0; // 记账调用计数（伏笔文本逐章差异化，验证文本去重下仍逐章入账）

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  // 章纲展开（分卷编辑）
  if (sys.includes("分卷编辑")) {
    return JSON.stringify({
      chapters: [
        { goal: "主角抵达边城，初见疑云", beats: ["进城", "遭遇异象"], hookType: "悬念" },
        { goal: "主角结识线人，打探消息", beats: ["酒馆对话", "获得线索"], hookType: "危机" },
        { goal: "第一次冲突爆发", beats: ["遭伏击", "脱身"], hookType: "反转" },
        { goal: "线索指向幕后黑手", beats: ["追查", "发现信物"], hookType: "悬念" },
      ],
    });
  }
  // 弧/卷摘要归并（档案员）
  if (sys.includes("档案员")) {
    return JSON.stringify({ summary: "本阶段主角抵达边城并揭开第一层阴谋。" });
  }
  // 指南针更新（总编剧）
  if (sys.includes("总编剧")) {
    return JSON.stringify({ compass: "继续追查边城阴谋，逐步逼近幕后黑手", note: "首弧收束" });
  }
  // 审查者
  if (sys.includes("审查者")) {
    return JSON.stringify({
      criteria: [{ name: "张力", rubric: "冲突推进" }],
      verdict: "pass",
      scores: { coherence: 8, tension: 8, prose: 7, pacing: 7, dialogue: 8 },
      findings: [],
      foreshadow_notes: "无异常",
    });
  }
  // 记账者
  if (sys.includes("记账者")) {
    settleCalls++;
    return JSON.stringify({
      summary: "阿青在边城推进调查。",
      events: ["调查推进"],
      appeared: ["阿青"],
      stateChanges: [],
      hook: "新的疑点浮现",
      new_foreshadowing: [{ text: `神秘信物的来历·${settleCalls}`, note: "后续回收", dueHint: "3 章内" }],
      resolved_foreshadowing: [],
      character_updates: [{ name: "阿青", status: "调查中" }],
      character_exits: [],
      timeline_summary: "阿青推进边城调查",
      plot_threads: [],
      new_characters: [],
    });
  }
  // 干预影响评估（连续性顾问）
  if (sys.includes("连续性顾问")) {
    return JSON.stringify({ conflicts: [], reverseRelationHint: "" });
  }
  // 导演写作（最后兜底；每章正文略有差异）
  if (sys.includes("导演")) {
    writerCalls++;
    return `【标题】边城风云·${writerCalls}\n阿青走进边城的第${writerCalls}个清晨，风里带着沙。\n\n他在街角看见了那张熟悉的脸，对方显然也认出了他，两人隔着人流对视了一瞬。\n\n「你终于来了。」对方低声说。`;
  }
  return "{}";
});

const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { saveWorld, loadWorld } = await import("../src/api/storage");
const { writeOneChapter, InterruptedError } = await import("../src/api/director");
const { runAuto } = await import("../src/api/autorun");
const { requestInterrupt } = await import("../src/api/steering");
const { estimateTokens, buildWriterContext } = await import("../src/api/memory");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-long-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const TITLE = "长篇连载测试";

describe("自动连载 5 章（mock LLM）", () => {
  test("runAuto 全链路断言", async () => {
    // 建世界（模拟旧故事：无蓝图 → 管线自愈 healLegacyStory）
    const w = emptyWorld();
    w.title = TITLE;
    w.premise = "边城阴谋";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "冷峻" };
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
    w.gen = { ...DEFAULT_GEN, targetChapterWords: 90, minWords: 40, maxWords: 400 };
    saveWorld(w);

    const phases: string[] = [];
    const report = await runAuto(
      TITLE,
      { maxChapters: 5, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", (e) => { phases.push(e.phase); onEvent(e); }, null),
      () => loadWorld(TITLE),
      () => {},
    );

    expect(report.reason).toBe("done");
    expect(report.written).toBe(5);

    const after = loadWorld(TITLE)!;
    // 章节与摘要
    expect(after.chapters.length).toBe(5);
    expect(after.nextChapter).toBe(6);
    expect((after.chapterSummaries ?? []).length).toBe(5);
    // 章纲核销（healLegacy 展开 4 章 + 第 5 章无章纲降级）
    const donePlans = (after.chapterPlans ?? []).filter((p) => p.status === "done");
    expect(donePlans.length).toBeGreaterThanOrEqual(4);
    // 弧边界：首弧 4 章完成 → 弧摘要 + 状态 done
    const arc = (after.storyArcs ?? [])[0];
    expect(arc?.status).toBe("done");
    expect(arc?.summary).toContain("边城");
    // 记账：伏笔入账（每章 1 条，上限 2）+ 时间线覆盖式
    expect(after.foreshadowing.length).toBe(5);
    expect(after.timeline.length).toBe(5);
    expect(after.characters[0].status).toBe("调查中");
    // 蓝图自愈存在
    expect(after.blueprint).toBeDefined();
    // checkpoint 落盘
    expect(existsSync(join(tmp, "data", "长篇连载测试", "checkpoint.jsonl"))).toBe(true);
    const ck = readFileSync(join(tmp, "data", "长篇连载测试", "checkpoint.jsonl"), "utf-8");
    expect(ck.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(5);
    // SSE v2 事件覆盖
    for (const p of ["writing", "delta", "selfcheck", "reviewing", "settling", "saving", "done"]) {
      expect(phases).toContain(p);
    }
  }, 60_000);

  test("上下文预算：tiered 档位下硬性预算上限生效（长书不膨胀）", async () => {
    const w = loadWorld(TITLE)!;
    // 构造 30 章×8000 字的长书（>20万字 → tiered 档），验证上下文不随章节数无限增长
    const big = { ...w };
    big.chapters = Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      title: `章${i + 1}`,
      text: `第${i + 1}章正文内容填充。`.repeat(500),
      review: null,
    }));
    big.chapterSummaries = Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      summary: `第${i + 1}章发生了关键事件，主角推进了主线并理下新的伏笔，结尾留下悬念。`,
      events: ["事件"],
      appeared: ["阿青"],
      stateChanges: [],
    }));
    big.nextChapter = 31;
    const ctxBig = buildWriterContext(big, null, 6000);
    const ctxSmall = buildWriterContext(w, null, 6000);
    // 硬性预算：超大书的上下文不得超过预算太多（非裁减核心段少量溢出容忍）
    expect(ctxBig.tokens).toBeLessThanOrEqual(7000);
    expect(ctxBig.tokens).toBeLessThanOrEqual(ctxSmall.tokens * 3);
    expect(estimateTokens("你好世界")).toBe(6);
  });

  test("打断零污染：写作前 requestInterrupt → InterruptedError，章节不增加", async () => {
    const before = loadWorld(TITLE)!;
    const n = before.chapters.length;
    requestInterrupt(TITLE, { kind: "test", payload: {} });
    let threw = false;
    try {
      await writeOneChapter(before, "", undefined, null);
    } catch (e) {
      threw = e instanceof InterruptedError;
    }
    expect(threw).toBe(true);
    const after = loadWorld(TITLE)!;
    expect(after.chapters.length).toBe(n); // 未 commit，零污染
  });
});
