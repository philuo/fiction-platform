// P3 连续自动化流程自动恢复：断点续跑（服务重启语义，章节不重不漏）/ pause / stop / checkpoint 幂等。
// 复用 mass-common 全链路 mock（单例安装 + setSpec 切换当前书）。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOOK_SPECS, installFullMock, setSpec } from "./mass-common";

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-resume-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const specA = BOOK_SPECS[0]; // 10 章
const specB = BOOK_SPECS[9]; // 30 章

describe("P3 连续自动化流程自动恢复", () => {
  test("断点续跑：服务重启后从已写章数继续，章节不重不漏 + checkpoint 不重复", async () => {
    installFullMock(specA);
    const { newStory } = await import("../src/api/director");
    const { writeOneChapter } = await import("../src/api/director");
    const { runAuto } = await import("../src/api/autorun");
    const { loadWorld } = await import("../src/api/storage");

    await newStory("断点续跑测试", specA.genre);

    // ① 第一次运行：目标 6 章跑满（模拟会话中断前已写 6 章）
    const exec = (_w: unknown, onEvent: (e: unknown) => void) => writeOneChapter(loadWorld(specA.title)!, "", (e) => onEvent(e), null);
    const report1 = await runAuto(specA.title, { maxChapters: 6, runEvalEvery: 0 }, exec, () => loadWorld(specA.title), () => {});
    expect(report1.reason).toBe("done");
    expect(loadWorld(specA.title)!.chapters.length).toBe(6);

    // ② 模拟服务重启：新会话 initialWritten=6 续跑至绝对目标 10
    const report2 = await runAuto(specA.title, { maxChapters: 10, runEvalEvery: 0 }, exec, () => loadWorld(specA.title), () => {}, 6);
    expect(report2.reason).toBe("done");
    expect(report2.written).toBe(10);

    // ③ 章节不重不漏：index 连续 1..10，无重复
    const w = loadWorld(specA.title)!;
    expect(w.chapters.map((c) => c.index)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(w.nextChapter).toBe(11);
    // 章摘要/时间线逐章 10 条（不因续跑重复）
    expect((w.chapterSummaries ?? []).length).toBe(10);
    expect(w.timeline.length).toBe(10);

    // ④ checkpoint 幂等：每章一条 commit，续跑不产生重复记录
    const ckPath = join(tmp, "data", specA.title, "checkpoint.jsonl");
    expect(existsSync(ckPath)).toBe(true);
    const ck = readFileSync(ckPath, "utf-8").split("\n").filter(Boolean);
    expect(ck.length).toBe(10);
  }, 120_000);

  test("pause 语义：章边界停下保持 paused 会话，重新 start 恢复至目标", async () => {
    installFullMock(specB); // 30 章（目标大，确保暂停生效）
    const { newStory } = await import("../src/api/director");
    const { writeOneChapter } = await import("../src/api/director");
    const { runAuto, pauseAuto } = await import("../src/api/autorun");
    const { loadWorld, loadAutoSession } = await import("../src/api/storage");

    await newStory("暂停恢复测试", specB.genre);
    const exec = (_w: unknown, onEvent: (e: unknown) => void) => writeOneChapter(loadWorld(specB.title)!, "", (e) => onEvent(e), null);

    // 启动后立即暂停（章边界停下）
    const p1 = runAuto(specB.title, { maxChapters: 30, runEvalEvery: 0 }, exec, () => loadWorld(specB.title), () => {});
    pauseAuto(specB.title);
    const report1 = await p1;
    expect(report1.reason).toBe("paused");
    expect(report1.written).toBeLessThan(30);
    expect(loadAutoSession(specB.title)?.status).toBe("paused");

    // 重新 start（runAuto 内部 clearAutoStop 清暂停标记）→ 从 paused 会话的 written 续跑至绝对目标 30
    const session = loadAutoSession(specB.title);
    const report2 = await runAuto(specB.title, { maxChapters: 30, runEvalEvery: 0 }, exec, () => loadWorld(specB.title), () => {}, session?.written ?? 0);
    expect(report2.reason).toBe("done");
    expect(report2.written).toBe(30);
    const w = loadWorld(specB.title)!;
    expect(w.chapters.map((c) => c.index)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(loadAutoSession(specB.title)?.status).toBe("done");
  }, 120_000);

  test("stop 语义：stopAuto 后立即停下（reason=stopped），不继续写新章", async () => {
    installFullMock(specB);
    const { newStory } = await import("../src/api/director");
    const { writeOneChapter } = await import("../src/api/director");
    const { runAuto, stopAuto } = await import("../src/api/autorun");
    const { loadWorld } = await import("../src/api/storage");

    await newStory("停止测试", specB.genre);
    const exec = (_w: unknown, onEvent: (e: unknown) => void) => writeOneChapter(loadWorld(specB.title)!, "", (e) => onEvent(e), null);

    const p = runAuto(specB.title, { maxChapters: 30, runEvalEvery: 0 }, exec, () => loadWorld(specB.title), () => {});
    stopAuto(specB.title);
    const report = await p;
    expect(report.reason).toBe("stopped");
    expect(report.written).toBeLessThan(30);
    // 停止后世界无半章（每章 commit 原子）
    const w = loadWorld(specB.title)!;
    expect(w.chapters.every((c) => c.text.length > 0)).toBe(true);
  }, 120_000);
});
