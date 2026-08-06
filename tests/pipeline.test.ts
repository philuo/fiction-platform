// P2 管线测试：mock LLM 下跑通 writeOneChapter（pass / patch 两条路径）+ verdict 决策表
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 被测模块之前安装 mock
import { installMockAgnes } from "./mocks";

let criticCalls = 0;
let passMode = true; // true=审查通过路径；false=patch 路径

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  const user = messages.map((m) => m.content).join("\n");
  if (sys.includes("你是小说的“导演”") || sys.includes('你是小说的"导演"') || sys.includes("导演（Writer）")) {
    // 修订稿请求（带审查意见）→ 输出已修正的正文
    if (user.includes("[审查者意见")) {
      return "【标题】修正之节\n修正后的第一段，问题段落已经重写。\n\n第二段保持原样，平稳收束。";
    }
    return "【标题】风起客栈\n阿青推开客栈的门，风沙扑面。\n\n他看见角落里坐着一个戴斗笠的人，手中握着一柄没有鞘的剑。\n\n「住店？」店迎迎上来。阿青没有答话，目光始终落在那柄剑上。";
  }
  if (sys.includes("记账者")) {
    return JSON.stringify({
      summary: "阿青在客栈遇见持剑的斗笠客。",
      events: ["阿青进入客栈", "发现斗笠客"],
      appeared: ["阿青"],
      stateChanges: [],
      hook: "斗笠客的剑没有鞘",
      new_foreshadowing: [{ text: "斗笠客无鞘之剑", note: "暗示身份", dueHint: "3 章内" }],
      resolved_foreshadowing: [],
      character_updates: [{ name: "阿青", status: "在客栈警戒中" }],
      character_exits: [],
      timeline_summary: "阿青抵达客栈，遇斗笠客",
      plot_threads: [],
      new_characters: [],
    });
  }
  if (sys.includes("审查者")) {
    criticCalls++;
    if (passMode) {
      return JSON.stringify({
        criteria: [{ name: "张力", rubric: "开场冲突感" }],
        verdict: "pass",
        scores: { coherence: 8, tension: 8, prose: 8, pacing: 7, dialogue: 8 },
        findings: [],
        foreshadow_notes: "无活跃伏笔",
      });
    }
    // patch 路径：第一轮 major（可段落定位），复审轮 pass
    if (criticCalls === 1) {
      return JSON.stringify({
        criteria: [],
        verdict: "revise",
        scores: { coherence: 8, tension: 6, prose: 6, pacing: 7, dialogue: 7 },
        findings: [
          { severity: "major", lens: "prose", issue: "首段描写空洞", evidence: "阿青推开客栈的门，风沙扑面", fixScope: "paragraph", suggestion: "补充感官细节" },
        ],
        foreshadow_notes: "",
      });
    }
    return JSON.stringify({
      criteria: [],
      verdict: "pass",
      scores: { coherence: 8, tension: 8, prose: 8, pacing: 8, dialogue: 8 },
      findings: [{ severity: "minor", lens: "aiTone", issue: "轻微套话", evidence: "修正后的第一段", fixScope: "paragraph", suggestion: "可选优化" }],
      foreshadow_notes: "",
    });
  }
  if (sys.includes("修订师")) {
    return "【段落1】\n阿青推开客栈的门，风沙混着酒气扑面，檐下铜铃哑了半截。";
  }
  return "{}";
});

// mock 安装后再加载被测模块（确保拿到被替换的 agnes）
const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { saveWorld } = await import("../src/api/storage");
const { step } = await import("../src/api/director");
const { decideAction } = await import("../src/api/critic");
const { detectAiTone, wordCountGuard } = await import("../src/api/style");
const { locateParagraphs } = await import("../src/api/patch");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-p2-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function mkWorld(name: string) {
  const w = emptyWorld();
  w.title = name;
  w.setting = { time: "架空", place: "边城", rules: [], tone: "冷峻" };
  w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
  w.gen = { ...DEFAULT_GEN, targetChapterWords: 80, minWords: 40, maxWords: 400 };
  return w;
}

describe("critic.decideAction 决策表（修 D2）", () => {
  test("floor 失败 → rewrite", () => {
    const r = decideAction("pass", { coherence: 4, tension: 8 }, [], 6);
    expect(r.action).toBe("rewrite");
    expect(r.floorFail).toBe(true);
  });
  test("chapter 级 major → rewrite", () => {
    const r = decideAction("revise", { coherence: 8, tension: 8 }, [{ severity: "major", lens: "logic", issue: "", evidence: "", suggestion: "", fixScope: "chapter" }], 6);
    expect(r.action).toBe("rewrite");
  });
  test("paragraph 级 major → patch", () => {
    const r = decideAction("revise", { coherence: 8, tension: 8 }, [{ severity: "major", lens: "prose", issue: "", evidence: "", suggestion: "", fixScope: "paragraph" }], 6);
    expect(r.action).toBe("patch");
  });
  test("minor-only → pass（容忍通道）", () => {
    const r = decideAction("pass", { coherence: 8, tension: 8 }, [{ severity: "minor", lens: "aiTone", issue: "", evidence: "", suggestion: "", fixScope: "paragraph" }], 6);
    expect(r.action).toBe("pass");
  });
  test("LLM revise 但无 findings → pass", () => {
    const r = decideAction("revise", { coherence: 8, tension: 8 }, [], 6);
    expect(r.action).toBe("pass");
  });
});

describe("style 确定性自检（修 C3）", () => {
  test("detectAiTone 命中疲劳词与禁用收尾", () => {
    const hits = detectAiTone("只见他缓缓走来。总之，一切都结束了。");
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
  test("wordCountGuard 区间判断", () => {
    const g = { ...DEFAULT_GEN, targetChapterWords: 100 };
    expect(wordCountGuard("字".repeat(30), g)).toBe("short");
    expect(wordCountGuard("字".repeat(100), g)).toBe("ok");
    expect(wordCountGuard("字".repeat(200), g)).toBe("long");
  });
});

describe("patch.locateParagraphs", () => {
  test("归一化子串定位段落（证据≥4字）", () => {
    const text = "第一段「你好」。 \n\n第二段内容更长一些。";
    const hit = locateParagraphs(text, ["第一段「你好"]);
    expect([...hit]).toEqual([0]);
    // 过短证据被守卫过滤（避免误匹配）
    expect(locateParagraphs(text, ["你好"]).size).toBe(0);
  });
});

describe("writeOneChapter 管线（mock）", () => {
  test("pass 路径：写→审→记账→存档", async () => {
    passMode = true;
    criticCalls = 0;
    const w = mkWorld("管线测试A");
    saveWorld(w);
    const phases: string[] = [];
    const result = await step(w, "开场写阿青进客栈", (e) => phases.push(e.phase));
    expect(result.chapter.index).toBe(1);
    expect(result.chapter.title).toBe("风起客栈");
    expect(result.review.verdict).toBe("pass");
    expect(result.rounds).toBe(1);
    // 记账：伏笔入账 + 摘要回写 + 时间线
    expect(w.foreshadowing.length).toBe(1);
    expect(w.chapterSummaries?.[0]?.summary).toContain("客栈");
    expect(w.timeline.some((t) => t.chapter === 1)).toBe(true);
    expect(w.characters[0].status).toBe("在客栈警戒中");
    expect(w.nextChapter).toBe(2);
    // SSE v2 事件含 delta / selfcheck / settling
    expect(phases).toContain("delta");
    expect(phases).toContain("selfcheck");
    expect(phases).toContain("settling");
  });

  test("patch 路径：major 段落修补 → 复审 → minor 入质量债务", async () => {
    passMode = false;
    criticCalls = 0;
    const w = mkWorld("管线测试B");
    saveWorld(w);
    const phases: string[] = [];
    const result = await step(w, "", (e) => phases.push(e.phase));
    expect(phases).toContain("patching");
    // 修补生效：首段被替换为修订师输出
    expect(result.chapter.text).toContain("檐下铜铃哑了半截");
    // 复审通过；minor finding 登记质量债务（不阻塞）
    expect(result.review.verdict).toBe("pass");
    expect(w.qualityDebt?.some((d) => d.lens === "aiTone" && d.status === "open")).toBe(true);
    expect(result.rounds).toBe(1); // patch 不算新写作轮
  });
});
