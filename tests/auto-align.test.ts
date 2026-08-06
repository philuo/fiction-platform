// 变更自动触发账本治理回归测试：伏笔文本去重 / 编辑·回滚后语义重算 / alignWorld 幂等
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMockAgnes } from "./mocks";

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  // 审查者
  if (sys.includes("审查者")) {
    return JSON.stringify({ criteria: [{ name: "张力", rubric: "推进" }], verdict: "pass", scores: { coherence: 8, tension: 8, prose: 7, pacing: 7, dialogue: 8 }, findings: [], foreshadow_notes: "无异常" });
  }
  // 记账者（固定重算输出）
  if (sys.includes("记账者")) {
    return JSON.stringify({
      summary: "本章重算摘要：阿青推进调查。",
      events: [], appeared: ["阿青"], stateChanges: [],
      hook: "",
      new_foreshadowing: [{ text: "神秘信物的来历", note: "后续回收" }],
      resolved_foreshadowing: [],
      character_updates: [{ name: "阿青", status: "调查中" }],
      character_relations: [],
      character_exits: [],
      timeline_summary: "阿青推进调查",
      world_current: "调查进行中",
      plot_threads: [],
      new_characters: [],
      setting_rules: [],
    });
  }
  return "{}";
});

const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { saveWorld, loadWorld } = await import("../src/api/storage");
const { editChapter, rollbackChapter } = await import("../src/api/director");
const { settleChapter } = await import("../src/api/chronicler");
const { alignWorld } = await import("../src/api/integrity");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-align-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function makeWorld(title: string) {
  const w = emptyWorld();
  w.title = title;
  w.premise = "边城阴谋";
  w.setting = { time: "架空", place: "边城", rules: [], tone: "冷峻" };
  w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
  w.gen = { ...DEFAULT_GEN, targetChapterWords: 90, minWords: 40, maxWords: 400 };
  saveWorld(w);
  return w;
}

describe("变更自动触发账本治理", () => {
  test("伏笔文本去重：同章重复结算不重复入账", async () => {
    const TITLE = "去重测试";
    makeWorld(TITLE);
    const w = loadWorld(TITLE)!;
    const ch = { index: 1, title: "第一章", text: "阿青在边城调查，发现神秘信物。", review: null } as never;
    w.chapters.push(ch as never);
    await settleChapter(w, ch as never, null);
    expect(w.foreshadowing.length).toBe(1);
    await settleChapter(w, ch as never, null);
    expect(w.foreshadowing.length).toBe(1); // 重复文本被去重，不重复埋设
  });

  test("editChapter 后账本跟随新正文（摘要/角色状态重算 + delta 覆盖）", async () => {
    const TITLE = "编辑测试";
    makeWorld(TITLE);
    const w = loadWorld(TITLE)!;
    w.chapters.push({ index: 1, title: "第一章", text: "阿青调查旧文书。", review: null } as never);
    saveWorld(w);
    await editChapter(w, 1, "阿青发现关键线索，决定深入虎穴。");
    const after = loadWorld(TITLE)!;
    expect(after.chapterSummaries?.find((s) => s.index === 1)?.summary).toContain("重算摘要");
    expect(after.characters[0].status).toBe("调查中"); // 角色状态随编辑重算
    expect(after.chapterDeltas?.[1]).toBeDefined(); // git 式快照覆盖
    expect(after.chapterDeltas?.[1].characterUpdates.length).toBeGreaterThan(0);
  });

  test("rollbackChapter 后账本更新且 delta 覆盖", async () => {
    const TITLE = "回滚测试";
    const w = makeWorld(TITLE);
    w.chapters.push({
      index: 1,
      title: "第一章",
      text: "当前版本正文",
      review: null,
      versions: [
        { at: new Date().toISOString(), title: "第一章", text: "历史版本正文：阿青在山村。", review: null, why: "历史" },
        { at: new Date().toISOString(), title: "第一章", text: "当前版本正文", review: null, why: "当前" },
      ] as never,
      versionFiles: [],
    } as never);
    saveWorld(w);
    await rollbackChapter(loadWorld(TITLE)!, 1, 0);
    const after = loadWorld(TITLE)!;
    expect(after.chapters[0].text).toContain("历史版本正文");
    expect(after.chapterSummaries?.find((s) => s.index === 1)?.summary).toContain("重算摘要"); // 回滚后重算摘要
    expect(after.chapterDeltas?.[1]).toBeDefined(); // 快照覆盖，删除可精确恢复
  });

  test("alignWorld 幂等：孤儿引用首次修复后第二次无修复项", async () => {
    const TITLE = "对齐测试";
    const w = makeWorld(TITLE);
    w.chapterSummaries = [{ index: 99, summary: "孤儿摘要", events: [], appeared: [], stateChanges: [] }];
    const first = alignWorld(w);
    expect(first.length).toBeGreaterThan(0);
    const second = alignWorld(w);
    expect(second.length).toBe(0);
  });
});
