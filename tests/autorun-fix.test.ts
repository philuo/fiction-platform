// 自动连载修复回归测试（审查整改）：429 首错即停 / autoGacha 不污染 / checkpoint 可读 / regenerate 打断
// P4.5 git 式：requirePass 审查不过不提交（ReviewFailedError 零污染）/ 修复循环 ≤2 轮 / retryChapter / session 持久化
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMockAgnes } from "./mocks";

let fail429 = false;
let writerCalls = 0;
// 审查模式：always-pass（默认）/ fail-once（每章首次 revise 二次 pass）/ always-fail（始终 revise 触发拒提交）
let reviewMode: "always-pass" | "fail-once" | "always-fail" = "always-pass";
let reviewCalls = 0;

installMockAgnes((messages) => {
  const sys = messages[0]?.content ?? "";
  // 章纲展开（分卷编辑）：展开 2 章（避免首章后弧完结触发 isBookComplete 提前停止）
  if (sys.includes("分卷编辑")) {
    return JSON.stringify({
      chapters: [
        { goal: "推进剧情", beats: ["事件"], hookType: "悬念" },
        { goal: "继续推进", beats: ["事件2"], hookType: "悬念" },
      ],
    });
  }
  // 弧/卷摘要归并（档案员）
  if (sys.includes("档案员")) return JSON.stringify({ summary: "本阶段剧情推进。" });
  // 指南针更新（总编剧）
  if (sys.includes("总编剧")) return JSON.stringify({ compass: "继续推进", note: "" });
  // 审查者
  if (sys.includes("审查者")) {
    reviewCalls++;
    const revise = {
      criteria: [{ name: "张力", rubric: "推进" }],
      verdict: "revise",
      scores: { coherence: 4, tension: 4, prose: 5, pacing: 5, dialogue: 5 },
      findings: [{ severity: "major", lens: "continuity", issue: "人物行为前后矛盾", evidence: "正文", fixScope: "chapter", suggestion: "修正行为动机" }],
      foreshadow_notes: "无异常",
    };
    if (reviewMode === "always-fail") return JSON.stringify(revise);
    if (reviewMode === "fail-once" && reviewCalls % 2 === 1) return JSON.stringify(revise);
    return JSON.stringify({ criteria: [{ name: "张力", rubric: "推进" }], verdict: "pass", scores: { coherence: 8, tension: 8, prose: 7, pacing: 7, dialogue: 8 }, findings: [], foreshadow_notes: "无异常" });
  }
  // 记账者
  if (sys.includes("记账者")) {
    return JSON.stringify({
      summary: "剧情推进。", events: [], appeared: [], stateChanges: [], hook: "",
      new_foreshadowing: [], resolved_foreshadowing: [], character_updates: [], character_exits: [],
      timeline_summary: "剧情推进", plot_threads: [], new_characters: [],
    });
  }
  // 连续性顾问
  if (sys.includes("连续性顾问")) return JSON.stringify({ conflicts: [], reverseRelationHint: "" });
  // 导演写作
  if (sys.includes("导演")) {
    writerCalls++;
    if (fail429) throw new Error("HTTP 429 AI 服务繁忙，请稍后重试");
    return `【标题】测试章·${writerCalls}\n正文内容第一段。\n\n第二段。`;
  }
  return "{}";
});

const { emptyWorld, DEFAULT_GEN } = await import("../src/api/world");
const { saveWorld, loadWorld, readLastCheckpoint, loadPendingChapter, loadAutoSession, saveAutoSession } = await import("../src/api/storage");
const { writeOneChapter, regenerateChapter, retryChapter, ReviewFailedError, InterruptedError } = await import("../src/api/director");
const { autoReportJobOutcome, runAuto, stopAuto } = await import("../src/api/autorun");
const { requestInterrupt } = await import("../src/api/steering");
const { subscribeSync } = await import("../src/api/sync");
const { createJob, findLatestJob, listJobs, updateJob } = await import("../src/api/control-plane");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-fix-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  // resumeAutoSessions 会经 listUsernames 初始化 db（临时库）：先关闭释放句柄再删目录（Windows 文件锁）
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try {
    getDb().close();
  } catch {
    /* 未初始化则忽略 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

function makeWorld(title: string) {
  const w = emptyWorld();
  w.title = title;
  w.premise = "边城阴谋";
  w.setting = { time: "架空", place: "边城", rules: [], tone: "冷峻" };
  w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: ["机警"], motivation: "查案", status: "赶路中", relations: {}, introducedAt: 0 });
  w.gen = { ...DEFAULT_GEN, targetChapterWords: 90, minWords: 40, maxWords: 400, autoGacha: false };
  saveWorld(w);
  return w;
}

describe("自动连载修复回归", () => {
  test("连载退出原因映射到真实 job 终态，不把暂停/失败写成 done", () => {
    expect(autoReportJobOutcome({ written: 0, reason: "review", avgScore: null })).toEqual({ status: "succeeded", phase: "paused" });
    expect(autoReportJobOutcome({ written: 0, reason: "quota", avgScore: null })).toEqual({ status: "failed", phase: "failed", error: "自动连载因额度或限流停止" });
    expect(autoReportJobOutcome({ written: 0, reason: "interrupted", avgScore: null })).toEqual({ status: "interrupted", phase: "interrupted", error: "自动连载被中断" });
    expect(autoReportJobOutcome({ written: 0, reason: "stopped", avgScore: null })).toEqual({ status: "cancelled", phase: "cancelled", error: "自动连载已停止" });
    expect(autoReportJobOutcome({ written: 1, reason: "done", avgScore: 8 })).toEqual({ status: "succeeded", phase: "done" });
  });

  test("连载开始立即广播 running session，首章期间任务中心可恢复", async () => {
    const TITLE = "首帧同步测试";
    makeWorld(TITLE);
    const events: { type: string; title?: string; status?: string; written?: number }[] = [];
    const unsubscribe = subscribeSync((event) => {
      if (event.type === "auto-status" && event.title === TITLE) events.push(event);
    });
    try {
      await runAuto(
        TITLE,
        { maxChapters: 1, runEvalEvery: 0 },
        (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
        () => loadWorld(TITLE),
        () => {},
      );
    } finally {
      unsubscribe();
    }
    expect(events[0]).toMatchObject({ type: "auto-status", title: TITLE, status: "running", written: 0 });
  });

  test("429/限流错误首错即停（reason=quota，不重试不白烧额度）", async () => {
    const TITLE = "限流测试";
    makeWorld(TITLE);
    fail429 = true;
    const before = writerCalls;
    const report = await runAuto(
      TITLE,
      { maxChapters: 3, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
      () => loadWorld(TITLE),
      () => {},
    );
    fail429 = false;
    expect(report.reason).toBe("quota");
    expect(report.written).toBe(0); // 未写入任何章节即停
    expect(writerCalls - before).toBe(1); // 仅 1 次写作尝试
  });

  test("autoGacha 选项不再污染世界对象（临时覆盖在路由层处理）", async () => {
    const TITLE = "覆盖测试";
    const w = makeWorld(TITLE);
    const report = await runAuto(
      TITLE,
      { maxChapters: 1, autoGacha: true, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
      () => loadWorld(TITLE),
      () => {},
    );
    expect(report.reason).toBe("done");
    expect(report.written).toBe(1);
    expect(w.gen?.autoGacha).toBe(false); // 传入对象未被修改
    expect(loadWorld(TITLE)?.gen?.autoGacha).toBe(false); // 磁盘持久化未污染
  });

  test("readLastCheckpoint 读取最后一条 commit 记录", async () => {
    const TITLE = "断点测试";
    makeWorld(TITLE);
    await runAuto(
      TITLE,
      { maxChapters: 2, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null),
      () => loadWorld(TITLE),
      () => {},
    );
    const ck = readLastCheckpoint(TITLE);
    expect(ck).not.toBeNull();
    expect(ck?.step).toBe("commit");
    expect(ck?.chapter).toBe(2);
    expect(ck?.at).toBeTruthy();
  });

  test("regenerateChapter 阶段边界消费打断并抛 InterruptedError", async () => {
    const TITLE = "打断测试";
    makeWorld(TITLE);
    const w = loadWorld(TITLE)!;
    await writeOneChapter(w, "", undefined, null);
    requestInterrupt(TITLE, { kind: "test", payload: {} });
    let threw = false;
    try {
      await regenerateChapter(loadWorld(TITLE)!, 1);
    } catch (e) {
      threw = e instanceof InterruptedError;
    }
    expect(threw).toBe(true);
    // 未落盘零污染：章节文本保持原样
    const after = loadWorld(TITLE)!;
    expect(after.chapters[0].text).toContain("正文内容");
  });

  // —— P4.5 git 式：审查不通过 = commit 被拒 ——

  test("writeOneChapter requirePass：审查不过 → ReviewFailedError 零污染 + major 记账", async () => {
    const TITLE = "审查拒提交";
    makeWorld(TITLE);
    reviewMode = "always-fail";
    reviewCalls = 0;
    let threw: unknown = null;
    const w = loadWorld(TITLE)!;
    try {
      await writeOneChapter(w, "", undefined, null, { requirePass: true });
    } catch (e) {
      threw = e;
    }
    reviewMode = "always-pass";
    expect(threw).toBeInstanceOf(ReviewFailedError);
    const err = threw as unknown as { chapterIndex: number; review: { verdict: string } };
    expect(err.chapterIndex).toBe(1);
    expect(err.review.verdict).toBe("revise");
    // 零污染：章节未入册、nextChapter 未推进（磁盘）
    const disk = loadWorld(TITLE)!;
    expect(disk.chapters.length).toBe(0);
    expect(disk.nextChapter).toBe(1);
    // 记账联动：major findings 已在内存登记（autorun 场景下会独立事务落盘）
    expect((w.qualityDebt ?? []).some((d) => d.severity === "major")).toBe(true);
  });

  test("writeOneChapter requirePass：修复循环第 2 轮通过 → 正常提交 + 版本快照", async () => {
    const TITLE = "修复通过";
    makeWorld(TITLE);
    reviewMode = "fail-once";
    reviewCalls = 0;
    const result = await writeOneChapter(loadWorld(TITLE)!, "", undefined, null, { requirePass: true });
    reviewMode = "always-pass";
    expect(result.chapter.index).toBe(1);
    const w = loadWorld(TITLE)!;
    expect(w.chapters.length).toBe(1);
    expect(w.nextChapter).toBe(2);
    // 版本联动：入册基线快照存在（可回滚）
    expect(w.chapters[0].versions?.length).toBeGreaterThan(0);
    expect(w.chapters[0].versions?.[0].reason).toContain("连载入册");
  });

  test("runAuto：审查不过 → reason=review + pending 落盘 + session=paused；重试成功 → commit 并清 pending", async () => {
    const TITLE = "连载审查停";
    makeWorld(TITLE);
    reviewMode = "always-fail";
    reviewCalls = 0;
    const report = await runAuto(
      TITLE,
      { maxChapters: 3, runEvalEvery: 0, execRetry: (w, pending, onEvent) => retryChapter(loadWorld(TITLE)!, pending, onEvent) },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null, { requirePass: true }),
      () => loadWorld(TITLE),
      () => {},
    );
    expect(report.reason).toBe("review");
    expect(report.failedChapter).toBe(1);
    expect(report.written).toBe(0); // 未提交任何章节即停
    // 暂存区草稿 + 会话状态
    const pending = loadPendingChapter(TITLE);
    expect(pending).not.toBeNull();
    expect(pending!.chapterIndex).toBe(1);
    const session = loadAutoSession(TITLE);
    expect(session?.status).toBe("paused");
    expect(session?.failedChapter).toBe(1);
    // 重试：runAuto 检测 pending 走 retryChapter → 通过则 commit + 清暂存区
    reviewMode = "always-pass";
    reviewCalls = 0;
    const report2 = await runAuto(
      TITLE,
      { maxChapters: 3, runEvalEvery: 0, execRetry: (w, pending, onEvent) => retryChapter(loadWorld(TITLE)!, pending, onEvent) },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null, { requirePass: true }),
      () => loadWorld(TITLE),
      () => {},
    );
    expect(report2.written).toBe(2); // 重试 1 章 + 续写 1 章（mock 章纲仅 2 章，卷完结后以 complete 停）
    expect(loadPendingChapter(TITLE)).toBeNull();
    const w = loadWorld(TITLE)!;
    expect(w.chapters.length).toBe(2);
    expect(w.nextChapter).toBe(3);
    expect(loadAutoSession(TITLE)?.status).toBe("done");
    // 记账联动已落盘（major 债务登记）
    expect((w.qualityDebt ?? []).some((d) => d.severity === "major")).toBe(true);
  });

  test("runAuto initialWritten：会话恢复从已写章数继续（绝对目标）", async () => {
    const TITLE = "恢复测试";
    makeWorld(TITLE);
    // 已写 1 章（会话中断前）
    await writeOneChapter(loadWorld(TITLE)!, "", undefined, null, { requirePass: true });
    const report = await runAuto(
      TITLE,
      { maxChapters: 2, runEvalEvery: 0 },
      (_w, onEvent) => writeOneChapter(loadWorld(TITLE)!, "", onEvent, null, { requirePass: true }),
      () => loadWorld(TITLE),
      () => {},
      1,
    );
    expect(report.reason).toBe("done");
    expect(report.written).toBe(2); // 已写 1 + 续写 1 = 2（绝对目标达成）
    expect(loadWorld(TITLE)!.chapters.length).toBe(2);
    expect(loadWorld(TITLE)!.nextChapter).toBe(3);
    expect(loadAutoSession(TITLE)?.status).toBe("done");
  });

  test("新一轮 running 会话创建新 job，不复活上一轮终态", () => {
    const TITLE = "连载轮次隔离";
    makeWorld(TITLE);
    const at = new Date().toISOString();
    saveAutoSession(TITLE, { status: "done", target: 1, written: 1, phase: "完成", startedAt: at, updatedAt: at });
    saveAutoSession(TITLE, { status: "running", target: 2, written: 1, phase: "新一轮", startedAt: at, updatedAt: at });
    const jobs = listJobs(null, TITLE).filter((job) => job.kind === "auto");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.status).sort()).toEqual(["running", "succeeded"]);
    expect(loadAutoSession(TITLE)).toMatchObject({ status: "running", target: 2, phase: "新一轮" });
  });

  test("loadAutoSession 以 job 终态收敛旧 progress，避免升级后幽灵运行态", () => {
    const TITLE = "旧进度收敛";
    makeWorld(TITLE);
    const at = new Date().toISOString();
    saveAutoSession(TITLE, { status: "running", target: 1, written: 0, phase: "写作中", startedAt: at, updatedAt: at });
    const job = findLatestJob(null, "auto", TITLE)!;
    updateJob(job.id, { status: "cancelled", phase: "cancelled" });
    expect(job.progress).toMatchObject({ status: "running", phase: "写作中" });
    expect(loadAutoSession(TITLE)).toMatchObject({ status: "stopped", phase: "cancelled" });
  });

  test("停止后的晚到章节阶段不创建匿名 running job", async () => {
    const TITLE = "停止晚到隔离";
    makeWorld(TITLE);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const running = runAuto(
      TITLE,
      { maxChapters: 2, runEvalEvery: 0 },
      async (_w, onEvent) => {
        started();
        await gate;
        return writeOneChapter(loadWorld(TITLE)!, "", onEvent, null, { requirePass: true });
      },
      () => loadWorld(TITLE),
      () => {},
    );
    await entered;
    stopAuto(TITLE);
    release();
    expect((await running).reason).toBe("stopped");
    const jobs = listJobs(null, TITLE).filter((job) => job.kind === "auto");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "cancelled" });
    expect(loadAutoSession(TITLE)?.status).toBe("stopped");
  });

  test("绑定 job 在 provider 开始前已取消时不创建新轮次", async () => {
    const TITLE = "启动前取消";
    makeWorld(TITLE);
    const job = createJob({
      user: null,
      title: TITLE,
      kind: "auto",
      dedupeKey: `auto:${TITLE}`,
      status: "cancelled",
      phase: "stopping",
    }).job;
    let calls = 0;
    const report = await runAuto(
      TITLE,
      { maxChapters: 1, runEvalEvery: 0, jobId: job.id },
      async (_w, onEvent) => {
        calls++;
        return writeOneChapter(loadWorld(TITLE)!, "", onEvent, null, { requirePass: true });
      },
      () => loadWorld(TITLE),
      () => {},
    );
    expect(report.reason).toBe("stopped");
    expect(calls).toBe(0);
    expect(listJobs(null, TITLE).filter((item) => item.kind === "auto")).toHaveLength(1);
    expect(findLatestJob(null, "auto", TITLE)?.status).toBe("cancelled");
  });

  test("resumeAutoSessions：running 会话自动恢复续跑，paused 不恢复", async () => {
    const { resumeAutoSessions } = await import("../src/api/routes");
    // running 会话 → 自动恢复并写完目标
    const TITLE = "重启恢复";
    makeWorld(TITLE);
    saveAutoSession(TITLE, {
      status: "running", target: 1, written: 0, phase: "连载中", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    resumeAutoSessions();
    // 后台续跑（mock 下很快）：轮询等待会话终态
    let s = loadAutoSession(TITLE);
    for (let i = 0; i < 100 && s?.status === "running"; i++) {
      await Bun.sleep(50);
      s = loadAutoSession(TITLE);
    }
    expect(s?.status).toBe("done");
    expect(loadWorld(TITLE)!.chapters.length).toBe(1);
    // paused 会话（等待人工决策）不自动恢复
    const TITLE2 = "暂停不恢复";
    makeWorld(TITLE2);
    saveAutoSession(TITLE2, {
      status: "paused", target: 2, written: 0, phase: "第 1 章审查未通过", pauseReason: "审查未通过", failedChapter: 1,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    resumeAutoSessions();
    await Bun.sleep(100);
    expect(loadWorld(TITLE2)!.chapters.length).toBe(0); // 未自动续写
    expect(loadAutoSession(TITLE2)?.status).toBe("paused");
  });
});
