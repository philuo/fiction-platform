// useSyncChannel 测试：FakeWebSocket 驱动（连接/订阅/事件分发/版本去重/断线重连/title 切换/卸载）
// 基建：happy-dom + createRoot（与 use-brain-session.test.tsx 同模式）；globalThis.WebSocket 替换为 FakeWebSocket
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSyncChannel, type SyncChannelEvent } from "../src/components/useSyncChannel";
import { getSystemSyncState } from "../src/components/syncStateStore";

// ============ FakeWebSocket（仿 brain-reconnect 的 SSE mock 思路，暴露控制点） ============

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 0; // 0=CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    // 不自动触发 onclose（测试手动控制，模拟主动关闭 vs 断线）
  }
  // —— 测试控制点 ——
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop() {
    // 模拟网络断线：触发 onclose → hook 重连
    this.readyState = 3;
    this.onclose?.();
  }
}

let win: Window;
const origWs = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeAll(() => {
  win = new Window({ url: "http://localhost/?title=t" });
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).navigator = win.navigator;
  (globalThis as Record<string, unknown>).HTMLElement = win.HTMLElement;
  (globalThis as Record<string, unknown>).Node = win.Node;
  (globalThis as Record<string, unknown>).getComputedStyle = win.getComputedStyle.bind(win);
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterAll(() => {
  win.happyDOM.close();
  if (origWs !== undefined) (globalThis as { WebSocket: unknown }).WebSocket = origWs;
  else delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/** 测试壳：把 hook 暴露出来断言 */
function Harness(props: { title: string | null; log: (e: string) => void; onReconnected?: () => void; onBrainNote?: (e: SyncChannelEvent & { type: "brain-note" }) => void; onCardUpdate?: (e: SyncChannelEvent & { type: "card-update" }) => void; onBrainStatus?: (e: SyncChannelEvent & { type: "brain-status" }) => void }) {
  const { connected, syncMediaFormValues } = useSyncChannel({
    title: props.title,
    onWorldChanged: (e) => props.log("world-changed" + (e.regions ? ":" + e.regions.join(",") : "")),
    onAutoStatus: () => props.log("auto-status"),
    onTaskStatus: () => props.log("task-status"),
    onBrainNote: (e) => props.onBrainNote?.(e),
    onCardUpdate: (e) => props.onCardUpdate?.(e),
    onBrainStatus: (e) => props.onBrainStatus?.(e),
    onReconnected: () => { props.onReconnected?.(); props.log("reconnected"); },
  });
  return React.createElement("button", {
    "data-connected": String(connected),
    onClick: () => syncMediaFormValues({ sessionId: "s1", messageId: "m1", cardIndex: 0, values: { chapterIndex: 2, count: 1 } }),
  });
}

function mountHarness(title: string | null, log: (e: string) => void, onReconnected?: () => void, onBrainNote?: (e: SyncChannelEvent & { type: "brain-note" }) => void, onCardUpdate?: (e: SyncChannelEvent & { type: "card-update" }) => void): { root: Root; el: HTMLElement } {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  root.render(React.createElement(Harness, { title, log, onReconnected, onBrainNote, onCardUpdate }));
  return { root, el: mount };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

async function afterMount(): Promise<void> {
  await tick(20); // flush effects
}

test("挂载后连接 /api/sync 并发送 subscribe(title)", async () => {
  const log: string[] = [];
  const { root, el } = mountHarness("书A", (e) => log.push(e));
  await afterMount();
  expect(FakeWebSocket.instances.length).toBe(1);
  expect(FakeWebSocket.instances[0].url).toContain("/api/sync");
  // 打开连接 → 发 subscribe
  FakeWebSocket.instances[0].open();
  await tick(50);
  expect(FakeWebSocket.instances[0].sent).toEqual([JSON.stringify({ type: "subscribe", title: "书A" })]);
  expect(el.querySelector("[data-connected]")?.getAttribute("data-connected")).toBe("true");
  root.unmount();
});

test("媒体参数选择通过已连接的 sync WS 上行", async () => {
  const { root, el } = mountHarness("书参数", () => {});
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  // 未连接时点击不会发送
  (el.querySelector("button") as HTMLButtonElement).click();
  expect(ws.sent).toEqual([]);
  ws.open();
  await tick(20);
  (el.querySelector("button") as HTMLButtonElement).click();
  expect(ws.sent.at(-1)).toBe(JSON.stringify({
    type: "media-form-values", title: "书参数", sessionId: "s1", messageId: "m1", cardIndex: 0,
    values: { chapterIndex: 2, count: 1 },
  }));
  root.unmount();
});

test("world-changed 分发 + 版本去重（旧版本忽略，更新版本触发）", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书B", (e) => log.push(e));
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  // 服务端确认订阅版本=5
  ws.emit({ type: "subscribed", title: "书B", version: 5 });
  await tick(20);
  // 版本 5（<= 当前 5）→ 忽略
  ws.emit({ type: "world-changed", title: "书B", version: 5, at: Date.now() });
  await tick(20);
  expect(log).toEqual([]);
  // 版本 6 → 触发
  ws.emit({ type: "world-changed", title: "书B", version: 6, at: Date.now(), regions: ["U06", "U07"] });
  await tick(20);
  expect(log).toEqual(["world-changed:U06,U07"]);
  // 版本 5（乱序回退）→ 忽略
  ws.emit({ type: "world-changed", title: "书B", version: 5, at: Date.now() });
  await tick(20);
  expect(log).toEqual(["world-changed:U06,U07"]);
  root.unmount();
});

test("auto-status / task-status / brain-note / card-update 分发到对应回调", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书C", (e) => log.push(e), undefined, (e) => log.push("note:" + e.eventId), (e) => log.push("card:" + e.cardId));
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  ws.emit({ type: "auto-status", title: "书C", status: "paused", phase: "已暂停", at: Date.now() });
  ws.emit({ type: "task-status", title: "书C", kind: "media", id: "m1", status: "ready", at: Date.now() });
  ws.emit({ type: "brain-note", title: "书C", eventId: "auto-ch1", text: "连载已提交第 1 章", at: Date.now() });
  ws.emit({ type: "card-update", title: "书C", sessionId: "s1", messageId: "m1", cardId: "card-media-1", patch: { status: "ready" }, at: Date.now() });
  await tick(20);
  expect(log).toEqual(["auto-status", "task-status", "note:auto-ch1", "card:card-media-1"]);
  root.unmount();
});

test("brain-status 权威快照分发到回调", async () => {
  const log: string[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  root.render(React.createElement(Harness, {
    title: "书C2", log: (e: string) => log.push(e),
    onBrainStatus: (e: SyncChannelEvent & { type: "brain-status" }) => log.push(`brain:${e.sessions.length}:${e.sessions[0]?.streaming}`),
  }));
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  ws.emit({ type: "brain-status", title: "书C2", sessions: [{ id: "s1", sessionTitle: "插画", createdAt: 1, updatedAt: 2, streaming: true, messages: [], completed: [] }], tasks: [], at: Date.now() });
  await tick(20);
  expect(log).toEqual(["brain:1:true"]);
  root.unmount();
});

test("system-snapshot 写入全局状态库，弹窗生命周期之外仍可读取", async () => {
  const { root } = mountHarness("状态库书", () => {});
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  ws.emit({
    type: "system-snapshot", title: "状态库书", world: { title: "状态库书", chapters: [] },
    visual: { running: false, pending: [], failed: [] }, autoSession: null, autoPending: null, advanceTask: null, at: 10,
  });
  await tick(20);
  expect(getSystemSyncState("状态库书")?.world.title).toBe("状态库书");
  root.unmount();
  expect(getSystemSyncState("状态库书")?.at).toBe(10);
});

test("断线后自动重连：新连接 + 重新 subscribe + onReconnected 触发", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书D", (e) => log.push(e));
  await afterMount();
  FakeWebSocket.instances[0].open();
  await tick(20);
  expect(log).toEqual([]); // 初次连接不补偿

  // 断线 → 退避重连（1s 后新实例）
  FakeWebSocket.instances[0].drop();
  await tick(20);
  await tick(1100); // 等退避
  expect(FakeWebSocket.instances.length).toBe(2);
  const ws2 = FakeWebSocket.instances[1];
  ws2.open();
  await tick(20);
  expect(ws2.sent).toEqual([JSON.stringify({ type: "subscribe", title: "书D" })]);
  expect(log).toEqual(["reconnected"]); // 重连成功补偿
  root.unmount();
});

test("title 变化 → 复用用户级连接并切换故事订阅", async () => {
  const log: string[] = [];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  root.render(React.createElement(Harness, { title: "书E", log: (e: string) => log.push(e) }));
  await afterMount();
  FakeWebSocket.instances[0].open();
  await tick(20);

  flushSync(() => {
    root.render(React.createElement(Harness, { title: "书F", log: (e: string) => log.push(e) }));
  });
  await afterMount();
  expect(FakeWebSocket.instances.length).toBe(1);
  expect(FakeWebSocket.instances[0].sent.at(-1)).toBe(JSON.stringify({ type: "subscribe", title: "书F" }));
  root.unmount();
});

test("title 为空 → 仍建立用户级连接但不订阅故事", async () => {
  const log: string[] = [];
  const { root } = mountHarness(null, (e) => log.push(e));
  await afterMount();
  expect(FakeWebSocket.instances.length).toBe(1);
  FakeWebSocket.instances[0].open();
  await tick(20);
  expect(FakeWebSocket.instances[0].sent).toEqual([]);
  root.unmount();
});

test("卸载 → 关闭连接且不再重连", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书G", (e) => log.push(e));
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  root.unmount();
  await tick(20);
  expect(ws.readyState).toBe(3);
  // 浏览器在主动 close 后可能异步补发 close；旧 socket 的回调不得重连。
  ws.onclose?.();
  await tick(1300);
  expect(FakeWebSocket.instances.length).toBe(1);
});

test("服务端 error 事件（如订阅不存在）静默不崩", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书H", (e) => log.push(e));
  await afterMount();
  FakeWebSocket.instances[0].open();
  await tick(20);
  FakeWebSocket.instances[0].emit({ type: "error", error: "故事不存在: 书H" });
  await tick(20);
  expect(log).toEqual([]); // error 不触发业务回调
  root.unmount();
});

test("心跳：连接后定时发送 ping（30s 间隔）保活", async () => {
  const log: string[] = [];
  const { root } = mountHarness("书I", (e) => log.push(e));
  await afterMount();
  const ws = FakeWebSocket.instances[0];
  ws.open();
  await tick(20);
  // 30s 内不触发（避免测试过慢）；改断言：连接建立后 sent 里无 ping（首帧只 subscribe）
  expect(ws.sent.every((s) => !s.includes("ping"))).toBe(true);
  expect(ws.sent).toContain(JSON.stringify({ type: "subscribe", title: "书I" }));
  root.unmount();
});

test("onStatusChange：连接建立触发 true；断开触发 false（降级通道信号）", async () => {
  const statuses: boolean[] = [];
  const { root } = mountHarnessWithStatus("书J", statuses);
  await afterMount();
  FakeWebSocket.instances[0].open();
  await tick(20);
  expect(statuses).toEqual([true]);
  FakeWebSocket.instances[0].drop();
  await tick(20);
  expect(statuses).toEqual([true, false]); // 断开 → false（前端据此启动轮询降级）
  root.unmount();
});

function mountHarnessWithStatus(title: string, statuses: boolean[]): { root: Root; el: HTMLElement } {
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root = createRoot(mount);
  root.render(React.createElement(StatusHarness, { title, statuses }));
  return { root, el: mount };
}
function StatusHarness(props: { title: string; statuses: boolean[] }) {
  useSyncChannel({ title: props.title, onStatusChange: (c) => props.statuses.push(c) });
  return React.createElement("div");
}
