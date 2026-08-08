// 单章推进任务持久化（advancetask）单元测试：状态机 + 陈旧判定 + 重复拒绝
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storyDir } from "../src/api/storage";
import {
  startAdvanceTask, updateAdvanceTaskPhase, completeAdvanceTask,
  failAdvanceTask, getAdvanceTaskForClient, clearAdvanceTask, loadAdvanceTask,
} from "../src/api/advancetask";

// 独立临时 data 目录，避免污染真实 data/
const tmp = mkdirSync(join(tmpdir(), "advancetask-test-"), { recursive: true });
const origCwd = process.cwd();

beforeAll(() => {
  // advancetask 用 process.cwd()/data/<slug>，切到临时目录
  mkdirSync(join(tmp, "data"), { recursive: true });
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(origCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const TITLE = "任务持久化测试书";

describe("advancetask 任务状态机", () => {
  test("start：写 running + targetIndex", () => {
    const r = startAdvanceTask(TITLE, 3);
    expect(r.ok).toBe(true);
    const t = loadAdvanceTask(TITLE);
    expect(t?.status).toBe("running");
    expect(t?.targetIndex).toBe(3);
    expect(t?.phase).toBe("start");
  });

  test("start：running 未陈旧时拒绝重复启动（同书单任务）", () => {
    const r = startAdvanceTask(TITLE, 4);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("运行中");
    // 原任务 targetIndex 不变
    expect(loadAdvanceTask(TITLE)?.targetIndex).toBe(3);
  });

  test("updatePhase：running 中刷新 updatedAt + phase", () => {
    updateAdvanceTaskPhase(TITLE, "writing");
    expect(loadAdvanceTask(TITLE)?.phase).toBe("writing");
    updateAdvanceTaskPhase(TITLE, "reviewing");
    expect(loadAdvanceTask(TITLE)?.phase).toBe("reviewing");
  });

  test("updatePhase：非 running 状态忽略", () => {
    completeAdvanceTask(TITLE, { chapterIndex: 3, verdict: "pass", rounds: 1 });
    updateAdvanceTaskPhase(TITLE, "writing"); // done 后更新应无效
    expect(loadAdvanceTask(TITLE)?.status).toBe("done");
  });

  test("complete：写 done + chapterIndex/verdict/rounds", () => {
    clearAdvanceTask(TITLE);
    startAdvanceTask(TITLE, 5);
    completeAdvanceTask(TITLE, { chapterIndex: 5, verdict: "revise", rounds: 2 });
    const t = loadAdvanceTask(TITLE);
    expect(t?.status).toBe("done");
    expect(t?.chapterIndex).toBe(5);
    expect(t?.verdict).toBe("revise");
    expect(t?.rounds).toBe(2);
  });

  test("complete：pendingCommit 标记", () => {
    clearAdvanceTask(TITLE);
    startAdvanceTask(TITLE, 6);
    completeAdvanceTask(TITLE, { chapterIndex: 6, verdict: "pass", rounds: 1, pendingCommit: true });
    expect(loadAdvanceTask(TITLE)?.pendingCommit).toBe(true);
  });

  test("fail：写 failed + error", () => {
    clearAdvanceTask(TITLE);
    startAdvanceTask(TITLE, 7);
    failAdvanceTask(TITLE, "网络中断");
    const t = loadAdvanceTask(TITLE);
    expect(t?.status).toBe("failed");
    expect(t?.error).toBe("网络中断");
  });

  test("clear：删除任务文件", () => {
    clearAdvanceTask(TITLE);
    expect(loadAdvanceTask(TITLE)).toBeNull();
  });

  test("getForClient：陈旧 running（超 15 分钟无更新）→ 自动标记 failed", () => {
    clearAdvanceTask(TITLE);
    startAdvanceTask(TITLE, 9);
    // 手动把 updatedAt 改成 20 分钟前（模拟服务重启中断）
    const t = loadAdvanceTask(TITLE)!;
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    t.updatedAt = stale;
    writeFileSync(join(storyDir(TITLE), "advance-task.json"), JSON.stringify(t), "utf-8");
    const got = getAdvanceTaskForClient(TITLE);
    expect(got?.status).toBe("failed");
    expect(got?.error).toContain("中断");
  });

  test("getForClient：新鲜 running 原样返回", () => {
    clearAdvanceTask(TITLE);
    startAdvanceTask(TITLE, 10);
    const got = getAdvanceTaskForClient(TITLE);
    expect(got?.status).toBe("running");
    expect(got?.targetIndex).toBe(10);
  });

  test("无任务：load/get 返回 null", () => {
    clearAdvanceTask(TITLE);
    expect(loadAdvanceTask(TITLE)).toBeNull();
    expect(getAdvanceTaskForClient(TITLE)).toBeNull();
  });
});
