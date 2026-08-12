import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "../src/api/db";
import {
  acceptCommand, CommandConflictError, commitWorldCommit, contentHash, createJob, getJob,
  listJobs, prepareWorldCommit, recoverPreparedWorldCommits, syncRevision, updateJob,
} from "../src/api/control-plane";

const root = join(tmpdir(), `control-plane-${crypto.randomUUID()}`);
const dbPath = join(root, "app.db");

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  process.env.APP_DB_PATH = dbPath;
});

afterAll(() => {
  try { getDb().close(); } catch { /* 未打开 */ }
  delete process.env.APP_DB_PATH;
  rmSync(root, { recursive: true, force: true });
});

describe("command receipts", () => {
  test("同 commandId+payload 幂等，不同 payload 冲突", () => {
    const req = { commandId: "cmd-1", type: "CMD-N02", scope: { title: "书" }, payload: { text: "继续" } };
    expect(acceptCommand("alice", req).status).toBe("queued");
    expect(acceptCommand("alice", req)).toEqual({ accepted: true, commandId: "cmd-1", status: "queued" });
    expect(() => acceptCommand("alice", { ...req, payload: { text: "改写" } })).toThrow(CommandConflictError);
  });
});

describe("durable jobs", () => {
  test("同用户 dedupeKey 只有一条活动任务，终态后可新建", () => {
    const first = createJob({ user: "alice", title: "书", kind: "media-plan", dedupeKey: "plan:ch1" });
    const duplicate = createJob({ user: "alice", title: "书", kind: "media-plan", dedupeKey: "plan:ch1" });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
    updateJob(first.job.id, { status: "failed", error: "interrupted" });
    const retry = createJob({ user: "alice", title: "书", kind: "media-plan", dedupeKey: "plan:ch1" });
    expect(retry.created).toBe(true);
    expect(retry.job.id).not.toBe(first.job.id);
    expect(listJobs("alice", "书", true)).toHaveLength(1);
    expect(getJob(first.job.id)?.error).toBe("interrupted");
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
