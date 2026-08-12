// P2 系统鲁棒性：环节失效异常 + 脏数据治理。
// 覆盖：① chatJson 非 JSON/尾部杂文修复重试；② 空串输出降级不阻塞；③ 坏类型字段守卫（丢弃不崩）；
// ④ LLM 直接抛错 → 连续失败停下策略；⑤ 脏数据 state.json → loadWorld 兼容 / autoRepair 幂等 / auditWorld 报告。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMockAgnes } from "./mocks";

// —— 可切换故障注入状态（模块级变量控制 responder 行为，多测试共享同一 mock 实例） ——
type FailureMode = "none" | "bad-json" | "empty" | "throw" | "bad-types";
let mode: FailureMode = "none";
let calls = 0; // LLM 调用计数（验证修复重试次数）
let badJsonFirst = true;

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  calls++;
  if (mode === "throw") throw new Error("LLM 服务不可用（模拟 HTTP 500）");
  if (mode === "empty") return "";
  // 章纲展开
  if (sys.includes("分卷编辑")) {
    return JSON.stringify({ chapters: [{ goal: "推进剧情", beats: ["事件"], hookType: "悬念" }, { goal: "继续推进", beats: ["事件2"], hookType: "悬念" }] });
  }
  if (sys.includes("档案员")) return JSON.stringify({ summary: "本阶段剧情推进。" });
  if (sys.includes("一卷已经写完")) return JSON.stringify({ compass: "继续推进", note: "" });
  // 审查者
  if (sys.includes("审查者")) {
    if (mode === "bad-json" && badJsonFirst) {
      badJsonFirst = false;
      // 非 JSON + 中文引号杂文（chatJson 修复重试路径）
      return `好的，审查完成：\n本次评审通过，无需修改，详见如下。`;
    }
    return JSON.stringify({ criteria: [{ name: "张力", rubric: "推进" }], verdict: "pass", scores: { coherence: 8, tension: 8, prose: 7, pacing: 7, dialogue: 8 }, findings: [], foreshadow_notes: "无异常" });
  }
  // 记账者（bad-types：首次返回全字段错类型 JSON，验证 schema 校验拦截 → 修复重试 → 合法数据入账）
  if (sys.includes("记账者")) {
    if (mode === "bad-types" && calls < 2) {
      return JSON.stringify({
        summary: 12345,
        events: "not-an-array",
        appeared: 999,
        stateChanges: null,
        hook: { bad: true },
        new_foreshadowing: [{ text: 42 }, "not-an-object", { text: "合法伏笔A", note: "备注" }, { text: "合法伏笔B" }],
        resolved_foreshadowing: [{ id: 999 }, "bad-id", { id: "" }],
        character_updates: [{ name: "阿青", status: "推进中" }, { name: null, status: "x" }, "bad-entry"],
        character_relations: "oops",
        character_exits: "not-array",
        timeline_summary: 42,
        world_current: null,
        plot_threads: "bad",
        new_characters: [{ name: "新角色甲", role: "配角", traits: ["特质"], motivation: "动机" }, "bad"],
        setting_rules: "not-array",
      });
    }
    return JSON.stringify({
      summary: "剧情推进。", events: [], appeared: [], stateChanges: [], hook: "",
      new_foreshadowing: [{ text: "合法伏笔A", note: "备注" }, { text: "合法伏笔B" }],
      resolved_foreshadowing: [], character_updates: [{ name: "阿青", status: "推进中" }], character_relations: [],
      character_exits: [], timeline_summary: "剧情推进", world_current: "", plot_threads: [], new_characters: [], setting_rules: [],
    });
  }
  if (sys.includes("连续性顾问")) return JSON.stringify({ conflicts: [], reverseRelationHint: "" });
  // 导演写作
  if (sys.includes("导演")) {
    return `【标题】鲁棒性测试章\n正文内容第一段，人物行动推进。\n\n第二段，对话与转折。`;
  }
  return "{}";
});

const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { saveWorld, loadWorld } = await import("../src/api/storage");
const { writeOneChapter } = await import("../src/api/director");
const { runAuto } = await import("../src/api/autorun");
const { chatJson } = await import("../src/api/jsonutil");
const { autoRepair, auditWorld } = await import("../src/api/integrity");
const { closeDb } = await import("../src/api/db");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-robust-"));
  process.chdir(tmp);
});
afterAll(() => {
  closeDb();
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function makeWorld(title: string) {
  const w = emptyWorld();
  w.title = title;
  w.premise = "鲁棒性测试";
  w.setting = { time: "架空", place: "边城", rules: [], tone: "冷峻" };
  w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
  w.gen = { ...DEFAULT_GEN, targetChapterWords: 90, minWords: 40, maxWords: 400, autoGacha: false };
  saveWorld(w);
  return w;
}

describe("P2 鲁棒性：环节失效异常", () => {
  test("chatJson：非 JSON 输出 → 修复重试成功；合法 JSON 尾部杂文 → 平衡括号截取", async () => {
    mode = "bad-json";
    badJsonFirst = true;
    const before = calls;
    // 通过 writeOneChapter 走 chatJson（审查者返回非 JSON → chatJson 修复重试）
    const TITLE = "坏JSON测试";
    makeWorld(TITLE);
    // 审查坏 JSON 只影响审查阶段；写作正常 → 章节应成功
    const r = await writeOneChapter(loadWorld(TITLE)!, "", undefined, null);
    expect(r.chapter.index).toBe(1);
    expect(calls - before).toBeGreaterThanOrEqual(3); // 首次审查坏 + 修复重试 + 记账等
    mode = "none";

    // extractJson 尾部杂文：直接验证平衡括号截取
    const { extractJson } = await import("../src/api/jsonutil");
    const parsed = extractJson<{ a: number }>(`前面有杂文\n{"a":1}\n后面还有一大段解释文字说明巴拉巴拉...`);
    expect(parsed.a).toBe(1);
  });

  test("空串输出：管线不崩（写章降级/失败可被捕获，不产生半章）", async () => {
    mode = "empty";
    const TITLE = "空串测试";
    makeWorld(TITLE);
    const report = await runAuto(
      TITLE,
      { maxChapters: 5, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
      () => loadWorld(TITLE),
      () => {},
    );
    mode = "none";
    // 空串使写作/审查/记账全部无效：可能 reason=error（连续失败）或 done（若某环节降级成功）
    const w = loadWorld(TITLE)!;
    // 核心不变量：世界状态合法，章节要么 0（失败未 commit）要么全部有效
    expect(w.chapters.every((c) => c.text.length > 0)).toBe(true);
  });

  test("坏类型字段：schema 校验拦截 → 修复重试 → 合法数据入账，世界不崩", async () => {
    mode = "bad-types";
    calls = 0;
    const TITLE = "坏类型测试";
    makeWorld(TITLE);
    await writeOneChapter(loadWorld(TITLE)!, "", undefined, null);
    mode = "none";
    const w = loadWorld(TITLE)!;
    // schema 校验失败触发修复重试（首次坏类型 + 重试成功）
    expect(calls).toBeGreaterThanOrEqual(2);
    // 重试后的合法伏笔入账
    const fs = w.foreshadowing.map((f) => f.text);
    expect(fs).toContain("合法伏笔A");
    expect(fs).toContain("合法伏笔B");
    // 角色更新生效
    expect(w.characters.find((c) => c.name === "阿青")?.status).toBe("推进中");
    // 合法时间线入账（重试后 timeline_summary 为字符串）
    expect(w.timeline.length).toBe(1);
  });

  test("LLM 直接抛错：连续失败 3 次后停下（reason=error），不产生半章", async () => {
    mode = "throw";
    const TITLE = "抛错测试";
    makeWorld(TITLE);
    const before = calls;
    const report = await runAuto(
      TITLE,
      { maxChapters: 5, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
      () => loadWorld(TITLE),
      () => {},
    );
    mode = "none";
    expect(report.reason).toBe("error");
    expect(report.written).toBe(0);
    expect(calls - before).toBeGreaterThanOrEqual(3); // 连续 3 次尝试
    const w = loadWorld(TITLE)!;
    expect(w.chapters.length).toBe(0); // 零污染
  });
});

describe("P2 鲁棒性：脏数据治理", () => {
  test("损坏 state.json：loadWorld 兼容不崩；autoRepair 幂等修复孤儿条目；auditWorld 报告危险项", () => {
    const TITLE = "脏数据测试";
    const w = makeWorld(TITLE);
    // 注入脏数据：悬空摘要/时间线/债务/章节覆盖/章纲 + 非法伏笔/坏角色条目
    w.chapters = [{ index: 1, title: "第一章", text: "正文内容……", review: null }];
    w.nextChapter = 2;
    w.chapterSummaries = [
      { index: 1, summary: "合法摘要", events: [], appeared: [], stateChanges: [] },
      { index: 99, summary: "孤儿摘要（悬空 index 99）", events: [], appeared: [], stateChanges: [] },
    ];
    w.timeline = [{ chapter: 1, summary: "合法" }, { chapter: 99, summary: "孤儿时间线" }];
    w.qualityDebt = [
      { id: "qd1", chapterIndex: 1, lens: "continuity", issue: "合法债务", severity: "major", status: "open" },
      { id: "qd2", chapterIndex: 99, lens: "logic", issue: "悬空债务", severity: "minor", status: "open" },
    ];
    w.chapterGen = { "1": { minWords: 100 }, "99": { minWords: 100 } };
    w.chapterPlans = [
      { index: 1, arcId: "arc1", goal: "合法计划", beats: [], hookType: "悬念", status: "done" },
      { index: 99, arcId: "arc1", goal: "孤儿计划", beats: [], hookType: "悬念", status: "done" },
    ];
    // 坏角色条目：缺 traits/motivation（类型错）
    w.characters.push({ id: "bad", name: "坏角色", role: "配角", traits: "not-array", motivation: 123, status: "", relations: "bad", introducedAt: 0 } as never);
    // 非法伏笔：缺 text / 非法 status
    w.foreshadowing.push({ id: "f-bad-1", text: "", plantedAt: 1, status: "planted" } as never);
    w.foreshadowing.push({ id: "f-bad-2", text: "非法状态", plantedAt: 1, status: "weird" } as never);
    saveWorld(w);

    // loadWorld 兼容（不抛错，返回对象）
    let loaded: typeof w | null = null;
    expect(() => { loaded = loadWorld(TITLE); }).not.toThrow();
    expect(loaded).not.toBeNull();

    // autoRepair：首次修复孤儿条目
    const fixed1 = autoRepair(loaded!);
    expect(fixed1.length).toBeGreaterThan(0);
    expect(fixed1.some((s) => s.includes("孤儿章节摘要"))).toBe(true);
    expect(fixed1.some((s) => s.includes("孤儿时间线"))).toBe(true);
    expect(fixed1.some((s) => s.includes("悬空质量债务"))).toBe(true);
    expect(loaded!.chapterSummaries?.some((s) => s.index === 99)).toBe(false);
    expect(loaded!.timeline.some((t) => t.chapter === 99)).toBe(false);
    expect(loaded!.qualityDebt?.some((d) => d.chapterIndex === 99)).toBe(false);
    expect(loaded!.chapterGen?.["99"]).toBeUndefined();
    expect(loaded!.chapterPlans?.some((p) => p.index === 99)).toBe(false);
    // 幂等：第二次无修复项
    const fixed2 = autoRepair(loaded!);
    expect(fixed2).toEqual([]);
    // 坏角色/伏笔不崩（保守策略：不作为孤儿删除，交 auditWorld 报告）
    expect(loaded!.characters.some((c) => c.name === "坏角色")).toBe(true);

    // auditWorld：危险项报告（含坏伏笔/悬空等）
    const findings = auditWorld(loaded!);
    const kinds = findings.map((f) => f.kind);
    // 非法伏笔被审计捕获（文本为空或状态非法）
    expect(kinds).toContain("foreshadow-invalid");
  });
});
