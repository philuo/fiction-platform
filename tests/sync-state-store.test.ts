import { beforeEach, describe, expect, test } from "bun:test";
import {
  acceptServerInstance, getBrainSyncState, getLibrarySyncState, getSystemSyncState,
  resetSyncStores, setBrainSyncState, setLibrarySyncState, setSystemSyncState,
} from "../src/components/syncStateStore";
import { emptyWorld } from "../src/api/world";

beforeEach(resetSyncStores);

describe("sync projection store", () => {
  test("重复或乱序 snapshot 不覆盖较新 revision", () => {
    const newer = emptyWorld(); newer.title = "书"; newer.nextChapter = 9;
    const older = emptyWorld(); older.title = "书"; older.nextChapter = 2;
    setSystemSyncState({ title: "书", world: newer, visual: { running: false, pending: [], failed: [] }, autoSession: null, autoPending: null, advanceTask: null, at: 2, revision: 8, hash: "new" });
    setSystemSyncState({ title: "书", world: older, visual: { running: true, pending: [], failed: [] }, autoSession: null, autoPending: null, advanceTask: null, at: 1, revision: 7, hash: "old" });
    expect(getSystemSyncState("书")?.world.nextChapter).toBe(9);
  });

  test("同 revision 不同 hash 拒绝分叉快照并报告 conflict", () => {
    const first = emptyWorld(); first.title = "分叉书"; first.nextChapter = 3;
    const fork = emptyWorld(); fork.title = "分叉书"; fork.nextChapter = 99;
    expect(setSystemSyncState({ title: "分叉书", world: first, visual: { running: false, pending: [], failed: [] }, autoSession: null, autoPending: null, advanceTask: null, at: 1, revision: 4, hash: "hash-a" })).toBe("accepted");
    expect(setSystemSyncState({ title: "分叉书", world: fork, visual: { running: false, pending: [], failed: [] }, autoSession: null, autoPending: null, advanceTask: null, at: 2, revision: 4, hash: "hash-b" })).toBe("conflict");
    expect(getSystemSyncState("分叉书")?.world.nextChapter).toBe(3);
  });

  test("服务纪元变化清空旧投影，避免重启后沿用旧 revision", () => {
    acceptServerInstance("instance-a");
    setLibrarySyncState({ stories: [], tasks: [], revision: 3, hash: "a" });
    setBrainSyncState({ title: "书", sessions: [{ id: "old" }], tasks: [], at: 1, revision: 3 });
    acceptServerInstance("instance-b");
    expect(getLibrarySyncState()).toBeNull();
    expect(getBrainSyncState("书")).toBeNull();
  });

  test("完整 brain snapshot 中无活动任务时替换旧 loading 任务", () => {
    setBrainSyncState({ title: "书", sessions: [], tasks: [{ id: "pending", status: "running" }], at: 1, revision: 1 });
    setBrainSyncState({ title: "书", sessions: [], tasks: [], at: 2, revision: 2 });
    expect(getBrainSyncState("书")?.tasks).toEqual([]);
  });
});
