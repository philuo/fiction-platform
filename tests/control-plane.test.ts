import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb } from "../src/api/db";
import {
  acceptCommand, CommandConflictError, commitWorldCommit, contentHash, createJob, getActiveJob, getJob,
  getCommandReceipt, isScopeDeleted, isScopeGenerationCurrent, latestOutboxCursor, listJobs, markScopeDeleted,
  prepareWorldCommit, recordProjectionSnapshot, recoverPreparedWorldCommits, scopeGeneration, settleOrphanedCommands,
  settleOrphanedJobs, syncRevision, updateCommand, updateJob, userOutboxAfter, clearScopeDeleted,
} from "../src/api/control-plane";

const root = join(tmpdir(), `control-plane-${crypto.randomUUID()}`);
const dbPath = join(root, "app.db");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  process.env.APP_DB_PATH = dbPath;
});

afterAll(async () => {
  closeDb();
  delete process.env.APP_DB_PATH;
  Bun.gc(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); } catch { /* Windows 可能延迟释放 WAL 句柄 */ }
});

describe("command receipts", () => {
  test("同 commandId+payload 幂等，不同 payload 冲突", () => {
    const req = { commandId: "cmd-1", type: "CMD-N02", scope: { title: "书" }, payload: { text: "继续" } };
    expect(acceptCommand("alice", req).status).toBe("queued");
    expect(acceptCommand("alice", req)).toEqual({ accepted: true, commandId: "cmd-1", status: "queued" });
    expect(() => acceptCommand("alice", { ...req, payload: { text: "改写" } })).toThrow(CommandConflictError);
    expect(() => acceptCommand("bob", req)).toThrow(CommandConflictError);
  });

  test("失败/取消终态及结果原样重放，不伪装 queued", () => {
    const failed = { commandId: "cmd-failed", type: "CMD-N02" as const, scope: { title: "书" }, payload: { text: "继续" } };
    acceptCommand("alice", failed);
    updateCommand(failed.commandId, "failed", { detail: 1 }, "模型失败");
    expect(acceptCommand("alice", failed)).toEqual({
      accepted: true, commandId: failed.commandId, status: "failed", result: { detail: 1 }, error: "模型失败",
    });
    const cancelled = { ...failed, commandId: "cmd-cancelled" };
    acceptCommand("alice", cancelled);
    updateCommand(cancelled.commandId, "cancelled", undefined, "用户取消");
    expect(acceptCommand("alice", cancelled).status).toBe("cancelled");
    expect(getCommandReceipt("bob", failed.commandId)).toBeNull();
  });

  test("启动时只收敛没有活动 job 承接的孤立命令", () => {
    const orphan = { commandId: "cmd-orphan", type: "CMD-N02" as const, scope: { title: "书" }, payload: {} };
    const active = { ...orphan, commandId: "cmd-active" };
    acceptCommand("alice", orphan);
    acceptCommand("alice", active);
    updateCommand(orphan.commandId, "running");
    updateCommand(active.commandId, "running");
    createJob({ commandId: active.commandId, user: "alice", title: "书", kind: "auto", dedupeKey: "active-command", status: "running" });
    expect(settleOrphanedCommands()).toBeGreaterThanOrEqual(1);
    expect(getCommandReceipt("alice", orphan.commandId)?.status).toBe("failed");
    expect(getCommandReceipt("alice", active.commandId)?.status).toBe("running");
  });

  test("终态不可被晚到 running 回滚，但可补充受理结果", () => {
    const req = { commandId: "cmd-monotonic", type: "CMD-N02" as const, scope: { title: "书" }, payload: {} };
    acceptCommand("alice", req);
    updateCommand(req.commandId, "succeeded");
    updateCommand(req.commandId, "running", { ok: true, taskId: "task-1" });
    expect(getCommandReceipt("alice", req.commandId)).toEqual({
      accepted: true, commandId: req.commandId, status: "succeeded", result: { ok: true, taskId: "task-1" },
    });
  });
});

describe("durable jobs", () => {
  test("同用户 dedupeKey 只有一条活动任务，终态后可新建", () => {
    const title = "持久判重书";
    const first = createJob({ user: "alice", title, kind: "media-plan", dedupeKey: "plan:ch1" });
    const duplicate = createJob({ user: "alice", title, kind: "media-plan", dedupeKey: "plan:ch1" });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    updateJob(first.job.id, { status: "failed", error: "interrupted" });
    const retry = createJob({ user: "alice", title, kind: "media-plan", dedupeKey: "plan:ch1" });
    expect(retry.created).toBe(true);
    expect(retry.job.id).not.toBe(first.job.id);
    expect(listJobs("alice", title, true)).toHaveLength(1);
    expect(getJob(first.job.id)?.error).toBe("interrupted");
  });

  test("可按持久 dedupeKey 恢复视频重生成回滚上下文", () => {
    const created = createJob({
      user: "alice", title: "书", kind: "media-regenerate", dedupeKey: "media-regenerate:m1",
      status: "waiting_external", recovery: { videoId: "new", rollback: { oldVideoId: "old", oldPath: "old.mp4" } },
    }).job;
    expect(getActiveJob("alice", "media-regenerate:m1")?.id).toBe(created.id);
    expect(getActiveJob("alice", "media-regenerate:m1")?.recovery).toEqual({ videoId: "new", rollback: { oldVideoId: "old", oldPath: "old.mp4" } });
    updateJob(created.id, { status: "succeeded" });
    expect(getActiveJob("alice", "media-regenerate:m1")).toBeNull();
  });

  test("启动时仅保留有安全恢复点的活动任务", () => {
    const image = createJob({ user: "boot-user", title: "书", kind: "image", dedupeKey: "image:boot", status: "running" }).job;
    const video = createJob({ user: "boot-user", title: "书", kind: "video", dedupeKey: "video:boot", status: "waiting_external", recovery: { videoId: "v-1" } }).job;
    expect(settleOrphanedJobs()).toBeGreaterThanOrEqual(1);
    expect(getJob(image.id)?.status).toBe("interrupted");
    expect(getJob(video.id)?.status).toBe("waiting_external");
  });

  test("Provider 视频与自动连载保留恢复点，其它业务任务收敛 interrupted", () => {
    const plan = createJob({ user: "recovery-user", title: "书", kind: "media-plan", dedupeKey: "plan:x", status: "running" }).job;
    const video = createJob({ user: "recovery-user", title: "书", kind: "video", dedupeKey: "video:x", status: "waiting_external", recovery: { videoId: "provider-1" } }).job;
    const auto = createJob({ user: "recovery-user", title: "书", kind: "auto", dedupeKey: "auto:x", status: "running", recovery: { written: 2 } }).job;
    settleOrphanedJobs();
    expect(getJob(plan.id)?.status).toBe("interrupted");
    expect(getJob(video.id)?.status).toBe("waiting_external");
    expect(getJob(auto.id)?.status).toBe("queued");
  });

  test("普通任务更新保留租约，只有显式 null 才清除", () => {
    const leased = createJob({ user: "lease-user", kind: "auto", dedupeKey: "lease-preserve" }).job;
    updateJob(leased.id, { leaseOwner: "worker-1", leaseExpiresAt: "2099-01-01T00:00:00.000Z" });
    updateJob(leased.id, { phase: "working" });
    expect(getJob(leased.id)?.leaseOwner).toBe("worker-1");
    expect(getJob(leased.id)?.leaseExpiresAt).toBe("2099-01-01T00:00:00.000Z");
    updateJob(leased.id, { leaseOwner: null, leaseExpiresAt: null });
    expect(getJob(leased.id)?.leaseOwner).toBeUndefined();
  });
});

describe("scope lifecycle", () => {
  test("同名故事重建会推进 generation，旧任务仍不可写回", () => {
    clearScopeDeleted("alice", "同名书");
    const oldGeneration = scopeGeneration("alice", "同名书");
    expect(isScopeGenerationCurrent("alice", "同名书", oldGeneration)).toBe(true);
    markScopeDeleted("alice", "同名书");
    expect(isScopeDeleted("alice", "同名书")).toBe(true);
    clearScopeDeleted("alice", "同名书");
    expect(isScopeDeleted("alice", "同名书")).toBe(false);
    expect(scopeGeneration("alice", "同名书")).not.toBe(oldGeneration);
    expect(isScopeGenerationCurrent("alice", "同名书", oldGeneration)).toBe(false);
  });
});

describe("projection outbox", () => {
  test("正文、revision/hash 和 RFC 6902 patch 同事务提交", () => {
    const first = recordProjectionSnapshot("alice", "story/投影书", "system", { world: { title: "投影书", chapters: [{ text: "大正文" }] }, running: true });
    expect(first.changed).toBe(true);
    expect(first.frame?.ops).toEqual([{ op: "replace", path: "", value: { world: { title: "投影书", chapters: [{ text: "大正文" }] }, running: true } }]);
    const second = recordProjectionSnapshot("alice", "story/投影书", "system", { world: { title: "投影书", chapters: [{ text: "大正文" }] }, running: false });
    expect(second.revision).toBe(first.revision + 1);
    expect(second.frame?.baseRevision).toBe(first.revision);
    expect(second.frame?.ops).toEqual([{ op: "replace", path: "/running", value: false }]);
    expect(JSON.stringify(second.frame)).not.toContain("大正文");
    const replay = userOutboxAfter("alice", first.cursor);
    expect(replay.at(-1)?.frame.type).toBe("patch");
  });

  test("相同投影不推进 revision 或重复写 outbox", () => {
    const value = { stories: [{ title: "A" }] };
    const first = recordProjectionSnapshot("alice", "user", "library-stable", value);
    const second = recordProjectionSnapshot("alice", "user", "library-stable", value);
    expect(second.changed).toBe(false);
    expect(second.revision).toBe(first.revision);
    expect(second.frameCursor).toBe(first.cursor);
  });
});

describe("world commit journal", () => {
  test("文件已替换但未提交时，启动恢复补 revision/outbox 提交", () => {
    const filePath = join(root, "story", "state.json");
    mkdirSync(join(root, "story"), { recursive: true });
    const oldJson = JSON.stringify({ title: "恢复书", n: 1 }, null, 2);
    const newJson = JSON.stringify({ title: "恢复书", n: 2 }, null, 2);
    writeFileSync(filePath, oldJson, "utf-8");
    const prepared = prepareWorldCommit({ user: "alice", title: "恢复书", filePath, oldJson, newJson });
    writeFileSync(filePath, newJson, "utf-8");
    const recovered = recoverPreparedWorldCommits();
    expect(recovered.committed).toBe(1);
    expect(syncRevision("alice", "story/恢复书", "world")).toEqual({ revision: prepared.targetRevision, hash: contentHash(newJson) });
    expect(latestOutboxCursor("alice")).toBeGreaterThan(0);
    const replay = userOutboxAfter("alice", 0);
    expect(replay.some((item) => item.frame.document === "world" && item.frame.revision === prepared.targetRevision)).toBe(true);
  });

  test("文件仍为旧版本时中止 prepared，不推进 revision", () => {
    const filePath = join(root, "story2", "state.json");
    mkdirSync(join(root, "story2"), { recursive: true });
    const oldJson = JSON.stringify({ title: "中止书", n: 1 });
    const newJson = JSON.stringify({ title: "中止书", n: 2 });
    writeFileSync(filePath, oldJson, "utf-8");
    prepareWorldCommit({ user: "alice", title: "中止书", filePath, oldJson, newJson });
    const recovered = recoverPreparedWorldCommits();
    expect(recovered.aborted).toBe(1);
    expect(syncRevision("alice", "story/中止书", "world").revision).toBe(0);
    expect(readFileSync(filePath, "utf-8")).toBe(oldJson);
  });

  test("正常提交幂等", () => {
    const filePath = join(root, "story3", "state.json");
    const newJson = JSON.stringify({ title: "提交书" });
    const prepared = prepareWorldCommit({ user: "alice", title: "提交书", filePath, newJson });
    mkdirSync(join(root, "story3"), { recursive: true });
    writeFileSync(filePath, newJson, "utf-8");
    expect(commitWorldCommit(prepared.id).targetRevision).toBe(1);
    expect(commitWorldCommit(prepared.id).targetRevision).toBe(1);
    expect(existsSync(filePath)).toBe(true);
  });
});
