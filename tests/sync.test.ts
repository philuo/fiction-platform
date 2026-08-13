// 状态同步事件总线（sync.ts）测试：订阅/退订、节流合并、版本戳、无订阅者零开销、订阅者隔离
// 注意：模块级单例状态（listeners/worldVersions/pendingByKey）跨测试共享，
// 每个测试自包含（beforeEach reset + 唯一书名 + 收尾退订）；节流窗口 1000ms，
// 断言"事件到达"统一用 flushSyncPending()（立即派发），"窗口内未到边界"用 tick(10) 断言 0 条。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearSyncPending,
  flushSyncPending,
  notifyWorldSaved,
  publishSync,
  resetSyncState,
  subscribeSync,
  worldVersion,
  type SyncEvent,
} from "../src/api/sync";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  resetSyncState();
});
afterEach(() => {
  clearSyncPending();
});

describe("订阅与派发", () => {
  test("subscribe 后 publish 派发事件；退订后不再派发", async () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    publishSync({ type: "world-changed", title: "书A", version: 1, at: 1 });
    flushSyncPending();
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("world-changed");

    unsub();
    publishSync({ type: "world-changed", title: "书A", version: 2, at: 2 });
    flushSyncPending();
    expect(got).toHaveLength(1); // 退订后不再收
  });

  test("无订阅者时 publish 零开销（无挂起、无副作用）", async () => {
    publishSync({ type: "world-changed", title: "书B", version: 1, at: 1 });
    publishSync({ type: "auto-status", title: "书B", status: "running", at: 1 });
    // 无订阅者：publish 直接 return，flush 也无事件可发
    flushSyncPending();
    // 订阅后再发，确认总线仍可用且未积累旧挂起
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    publishSync({ type: "auto-status", title: "书B", status: "paused", at: 2 });
    flushSyncPending();
    expect(got.map((g) => g.type)).toEqual(["auto-status"]);
    unsub();
  });
});

describe("节流合并（同 key 窗口内取最新）", () => {
  test("同书连续 saveWorld → 窗口内合并为一条，取最新 version", async () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("书C");
    notifyWorldSaved("书C");
    notifyWorldSaved("书C");
    await tick(10); // 窗口内（<1000ms）不派发
    expect(got).toHaveLength(0);
    flushSyncPending(); // 冲刷 → 一条合并事件
    expect(got).toHaveLength(1);
    expect(got[0].type).toBe("world-changed");
    expect((got[0] as Extract<SyncEvent, { type: "world-changed" }>).version).toBe(3);
    unsub();
  });

  test("不同书 / 不同类型不合并", async () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("书D");
    publishSync({ type: "auto-status", title: "书D", status: "running", at: 1 });
    publishSync({ type: "task-status", title: "书D", kind: "media", id: "m1", status: "ready", at: 1 });
    flushSyncPending();
    expect(got).toHaveLength(3);
    expect(got.map((g) => g.type).sort()).toEqual(["auto-status", "task-status", "world-changed"]);
    unsub();
  });

  test("窗口内重复任务状态取最新（media 多张并发各自合并）", async () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    publishSync({ type: "task-status", title: "书E", kind: "media", id: "m1", status: "pending", at: 1 });
    publishSync({ type: "task-status", title: "书E", kind: "media", id: "m1", status: "ready", at: 2 });
    publishSync({ type: "task-status", title: "书E", kind: "media", id: "m2", status: "failed", at: 3 });
    flushSyncPending();
    const media = got.filter((g) => g.type === "task-status") as Extract<SyncEvent, { type: "task-status" }>[];
    expect(media).toHaveLength(2);
    expect(media.find((m) => m.id === "m1")?.status).toBe("ready");
    expect(media.find((m) => m.id === "m2")?.status).toBe("failed");
    unsub();
  });

  test("窗口自然到期（>1000ms）自动派发，不依赖手动 flush", async () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("书H");
    await tick(1100); // 超过默认窗口
    expect(got).toHaveLength(1);
    unsub();
  });
});

describe("版本戳（worldVersion / notifyWorldSaved）", () => {
  test("无订阅者时仍推进版本事实；订阅者只影响事件分发", () => {
    expect(worldVersion("书F")).toBe(0);
    notifyWorldSaved("书F");
    expect(worldVersion("书F")).toBe(1);
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("书F");
    expect(worldVersion("书F")).toBe(2);
    notifyWorldSaved("书F");
    expect(worldVersion("书F")).toBe(3);
    flushSyncPending();
    unsub();
  });

  test("同 title 连续 notifyWorldSaved → 版本递增", () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("测试之书");
    notifyWorldSaved("测试之书");
    expect(worldVersion("测试之书")).toBe(2);
    flushSyncPending();
    unsub();
  });

  test("同名书版本按用户隔离", () => {
    notifyWorldSaved("同名书", "save", "alice");
    notifyWorldSaved("同名书", "save", "alice");
    notifyWorldSaved("同名书", "save", "bob");
    expect(worldVersion("同名书", "alice")).toBe(2);
    expect(worldVersion("同名书", "bob")).toBe(1);
    expect(worldVersion("同名书")).toBe(0);
  });
});

describe("订阅者异常隔离", () => {
  test("某订阅者抛错不影响其他订阅者", () => {
    const got: SyncEvent[] = [];
    const unsub1 = subscribeSync(() => {
      throw new Error("bad listener");
    });
    const unsub2 = subscribeSync((e) => got.push(e));
    publishSync({ type: "auto-status", title: "书G", status: "done", at: 1 });
    flushSyncPending();
    expect(got).toHaveLength(1); // 正常订阅者仍收到
    unsub1();
    unsub2();
  });
});

describe("区域级刷新（regions 维度）", () => {
  test("notifyWorldSaved 带 regions → 事件携带；缺省 → undefined（全量）", () => {
    const got: SyncEvent[] = [];
    const unsub = subscribeSync((e) => got.push(e));
    notifyWorldSaved("书R1", "save", "u1", ["U06", "U07"]);
    notifyWorldSaved("书R2", "save", "u1");
    flushSyncPending();
    const r1 = got.find((e) => (e as { title?: string }).title === "书R1") as Extract<SyncEvent, { type: "world-changed" }>;
    const r2 = got.find((e) => (e as { title?: string }).title === "书R2") as Extract<SyncEvent, { type: "world-changed" }>;
    expect(r1.regions).toEqual(["U06", "U07"]);
    expect(r2.regions).toBeUndefined(); // 缺省=全量
    unsub();
  });
});
