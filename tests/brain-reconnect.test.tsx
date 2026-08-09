// useBrainSession SSE 断线自动重连回归：
// 网络瞬时断开（流异常中断，非用户停止）→ 自动以 attach 模式重连服务端仍在运行的任务，
// 续收剩余 delta 至完成（不重复生成、不丢已生成文本、消息不永久 pending）。
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useBrainSession } from "../src/components/useBrainSession";

let win: Window;
const origFetch = globalThis.fetch;
let chatCall = 0;
let releaseFirst: (() => void) | null = null;
let mode: "normal" | "attach-empty" = "normal";
const chatBodies: Array<{ prompt?: string; sessionId?: string; resume?: boolean; attach?: boolean }> = [];

beforeAll(() => {
  win = new Window({ url: "http://localhost/?title=brain-reconnect-test" });
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Node = win.Node;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/brain/sessions/detail")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: string };
      const session = { id: body.id, title: "t", createdAt: 0, updatedAt: 0, messages: [], streaming: false };
      return new Response(JSON.stringify({ session }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/sessions") && init?.method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
      if (body.id) {
        return new Response(JSON.stringify({ session: { id: body.id } }), { status: 201, headers: { "Content-Type": "application/json" } }) as unknown as Response;
      }
      return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/chat")) {
      chatCall++;
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof chatBodies)[number]);
      const enc = new TextEncoder();
      if (chatCall === 1 && mode === "attach-empty") {
        // 首连在到达服务端前即失败（无任何事件；异步触发避免流 start 同步 error 状态异常）
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            setTimeout(() => c.error(new Error("network disconnected")), 10);
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as unknown as Response;
      }
      if (chatCall === 1) {
        // 首次连接：intent + 一条 delta 后流异常中断（模拟网络断开）
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode("data: " + JSON.stringify({ type: "intent" }) + "\n\n"));
            c.enqueue(enc.encode("data: " + JSON.stringify({ type: "delta", messageId: "brain-1", text: "前一半" }) + "\n\n"));
            releaseFirst = () => c.error(new Error("network disconnected"));
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as unknown as Response;
      }
      if (chatCall >= 2 && mode === "attach-empty") {
        // attach：服务端无运行中任务 → 空流立即 EOF（异步触发，避免 start 同步 close 后 read 挂起）
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            setTimeout(() => c.close(), 10);
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as unknown as Response;
      }
      // 重连：服务端任务仍在运行 → attach 续流（reset 重放已生成文本 + delta 续写 + done）
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("data: " + JSON.stringify({ type: "reset", messageId: "brain-1", text: "前一半" }) + "\n\n"));
          c.enqueue(enc.encode("data: " + JSON.stringify({ type: "delta", messageId: "brain-1", text: "前一半，后一半" }) + "\n\n"));
          c.enqueue(enc.encode("data: " + JSON.stringify({ type: "done", messageId: "brain-1" }) + "\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as unknown as Response;
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
  };
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function Harness() {
  const { messages, activeId, newSession, send, reconnecting } = useBrainSession("brain-reconnect-test");
  const msgRef = React.useRef(messages);
  msgRef.current = messages;
  const recRef = React.useRef(reconnecting);
  recRef.current = reconnecting;
  React.useEffect(() => {
    (win as unknown as { __harness?: unknown }).__harness = {
      doSend: async (prompt: string) => {
        let sid = activeId;
        if (!sid) sid = await newSession(prompt);
        await send({ prompt, sessionId: sid });
      },
      getMessages: () => msgRef.current,
      getReconnecting: () => recRef.current,
    };
  });
  return <div>{messages.map((m) => `${m.role}:${m.text}`).join("|")}</div>;
}

async function mountHarness() {
  chatCall = 0;
  releaseFirst = null;
  chatBodies.length = 0;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => { root.render(React.createElement(Harness)); });
  return { mount, root };
}

const harness = () => (win as unknown as { __harness: { doSend: (p: string) => Promise<void>; getMessages: () => { role: string; text?: string; pending?: boolean }[]; getReconnecting: () => boolean } }).__harness;

test("流异常中断后自动 attach 重连：续收剩余 delta，消息完成且不重复生成", async () => {
  mode = "normal";
  const { root } = await mountHarness();
  await tick();
  const p = harness().doSend("继续生成");
  // 等待首连收到 delta（消息文本出现「前一半」）
  let brainText = "";
  for (let i = 0; i < 50 && !brainText.includes("前一半"); i++) {
    await sleep(30);
    brainText = [...harness().getMessages()].reverse().find((m) => m.role === "brain")?.text ?? "";
  }
  expect(brainText).toContain("前一半");
  // 触发断线（流 error）
  releaseFirst?.();
  // 等待重连（800ms 退避 + attach 流处理）
  await p;
  await sleep(1200);
  const msgs = harness().getMessages();
  const brain = [...msgs].reverse().find((m) => m.role === "brain");
  // 重连请求为 attach 模式（不发起新回合）
  expect(chatBodies.length).toBe(2);
  expect(chatBodies[1].attach).toBe(true);
  expect(chatBodies[1].resume).toBe(false);
  // 文本从重放续写完整，消息完成（不永久 pending）
  expect(brain?.text).toBe("前一半，后一半");
  expect(brain?.pending).toBe(false);
  // 用户消息只有 1 条（attach 不追加）
  expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  await act(() => root.unmount());
});

test("attach 重连遇空流（服务端无运行任务）且消息仍 pending → 明确回显错误，不永久 loading", async () => {
  mode = "attach-empty";
  const { root } = await mountHarness();
  await tick();
  const p = harness().doSend("继续生成");
  // 首连无任何事件即失败 → 重连 attach 空流 EOF → attach 兜底回显错误
  await p;
  await sleep(1200);
  const msgs = harness().getMessages();
  const brain = [...msgs].reverse().find((m) => m.role === "brain");
  expect(chatBodies.length).toBe(2);
  expect(chatBodies[1].attach).toBe(true);
  expect(brain?.pending).toBe(false); // 不再永久 loading
  expect(brain?.text ?? "").toContain("连接中断");
  await act(() => root.unmount());
});
