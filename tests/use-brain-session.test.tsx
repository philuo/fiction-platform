// useBrainSession 回归：首次对话发送后消息立即出现在对话列表
// 背景 bug：send()/patchMsg() 等 useCallback 闭包捕获渲染时的 activeId；
// 首次对话（activeId=""）经 newSession() 异步创建后，旧闭包内 sessionId === activeId 永不成立
// → send 内 setMessages 不触发，消息显示依赖「state 数组被 cacheRef push 原地改写 + setActiveId 重渲染」的偶然时序
// （真实浏览器中重渲染常先于 push 发生 → 用户消息不显示）。
// 修复：activeIdRef 镜像最新 activeId，陈旧闭包读 ref 判断 → send 内立即正规 setMessages。
// 测试用延迟 SSE：断言在 SSE 完成前（doSend 返回后立即）用户消息已出现在列表。
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useBrainSession } from "../src/components/useBrainSession";

let win: Window;
const origFetch = globalThis.fetch;
const created = new Map<string, { id: string; role: string; text?: string }[]>();
/** 手动释放 SSE（模拟生成完成） */
let releaseChat: (() => void) | null = null;
/** 记录对 /api/brain/sessions 的调用（验证无 id 列表 / 有 id 创建分派与挂载无空壳） */
const listCalls: Array<{ hasId: boolean; id?: string }> = [];
/** 记录对 /api/brain/sessions/detail 的调用（验证 newSession id 被复用） */
const detailCalls: string[] = [];

beforeAll(() => {
  win = new Window({ url: "http://localhost/?title=brain-session-hook-test" });
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
      detailCalls.push(body.id);
      const session = {
        id: body.id,
        title: "t",
        createdAt: 0,
        updatedAt: 0,
        messages: created.get(body.id) ?? [],
        streaming: false,
      };
      return new Response(JSON.stringify({ session }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/sessions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { id?: string; prompt?: string };
      if (body.id) {
        // 创建会话（前端预生成 id；首条 prompt 写入会话）
        listCalls.push({ hasId: true, id: body.id });
        if (!created.has(body.id)) created.set(body.id, []);
        if (body.prompt) created.get(body.id)!.push({ id: crypto.randomUUID(), role: "user", text: body.prompt });
        return new Response(JSON.stringify({ session: { id: body.id } }), { status: 201, headers: { "Content-Type": "application/json" } }) as unknown as Response;
      }
      // 会话列表
      listCalls.push({ hasId: false });
      const sessions = [...created.keys()].map((id) => ({ id, title: "t", createdAt: 0, updatedAt: 0, streaming: false, messageCount: (created.get(id) ?? []).length }));
      return new Response(JSON.stringify({ sessions }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/chat")) {
      // SSE 延迟完成：先只发 intent（不做 delta），由测试手动 release 完成
      const enc = new TextEncoder();
      const body = "data: " + JSON.stringify({ type: "intent" }) + "\n\n";
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(body));
          releaseChat = () => {
            c.enqueue(enc.encode("data: " + JSON.stringify({ type: "delta", messageId: "brain-1", text: "你好" }) + "\n\n"));
            c.enqueue(enc.encode("data: " + JSON.stringify({ type: "done", messageId: "brain-1" }) + "\n\n"));
            c.close();
          };
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

/** 复刻 BrainCabin.doSend 的发送入口（无 activeId → newSession → send） */
function Harness() {
  const { messages, activeId, newSession, send } = useBrainSession("brain-session-hook-test");
  const msgRef = React.useRef(messages);
  msgRef.current = messages;
  React.useEffect(() => {
    (win as unknown as { __harness?: unknown }).__harness = {
      doSend: async (prompt: string) => {
        let sid = activeId;
        if (!sid) sid = await newSession(prompt);
        await send({ prompt, sessionId: sid });
      },
      startNew: () => newSession(),
      getMessages: () => msgRef.current,
      getActiveId: () => activeId,
    };
  });
  return <div>{messages.map((m) => `${m.role}:${m.text}`).join("|")}</div>;
}

async function mountHarness() {
  created.clear();
  releaseChat = null;
  listCalls.length = 0;
  detailCalls.length = 0;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => { root.render(React.createElement(Harness)); });
  return { mount, root };
}

const harness = () => (win as unknown as { __harness: { doSend: (p: string) => Promise<void>; getMessages: () => { role: string; text?: string }[]; getActiveId: () => string } }).__harness;

describe("useBrainSession 首次对话发送", () => {
  test("无 activeId 时发送：SSE 完成前用户消息已出现在对话列表（立即展示，不依赖流式完成）", async () => {
    const { root } = await mountHarness();
    await tick();
    // 发起发送（不 await：SSE 挂起等待 release）
    const p = harness().doSend("你好中枢");
    // 让 newSession→openSession→send 的同步段执行完（此时 SSE 尚未 release）
    await tick();
    await tick();
    const msgs = harness().getMessages();
    const sid = harness().getActiveId();
    expect(sid).not.toBe("");
    // 修复点：send 内通过 activeIdRef 匹配 → 立即正规 setMessages（不等 SSE delta/done）
    expect(msgs.some((m) => m.role === "user" && m.text === "你好中枢")).toBe(true);
    // brain 槽位也已创建（pending）
    expect(msgs.some((m) => m.role === "brain")).toBe(true);
    // 协议：newSession 创建时透传前端 id（listCalls 有 hasId=true 且 id === sid）
    expect(listCalls.some((c) => c.hasId && c.id === sid)).toBe(true);
    // 协议：openSession 用同一 id 拉详情（detailCalls 含 sid），列表请求均为无 id 列表语义
    expect(detailCalls).toContain(sid);
    expect(listCalls.filter((c) => !c.hasId).length).toBeGreaterThan(0);
    // 释放 SSE 完成收尾，避免悬挂
    releaseChat?.();
    await p;
    await act(() => root.unmount());
  });

  test("挂载恢复：无历史会话时不创建空壳会话（列表请求全部为无 id 语义）", async () => {
    const { root } = await mountHarness();
    await tick();
    await tick();
    // 挂载：refreshList 只发一次列表请求（无 id），绝不创建会话
    expect(listCalls.filter((c) => c.hasId)).toEqual([]);
    expect(detailCalls).toEqual([]);
    await act(() => root.unmount());
  });

  test("「新建」无输入时不创建会话（空态起步，首条消息才创建）", async () => {
    const { root } = await mountHarness();
    await tick();
    // 点「+」新建（无 prompt）→ 不产生创建请求（hasId=false），视图清空
    await act(() => harness().startNew());
    await tick();
    expect(listCalls.filter((c) => c.hasId)).toEqual([]);
    expect(harness().getActiveId()).toBe("");
    expect(harness().getMessages()).toEqual([]);
    await act(() => root.unmount());
  });

  test("已有会话时发送：消息同样立即追加", async () => {
    const { root } = await mountHarness();
    await tick();
    // 第一轮：发起 → 立即展示 → release SSE 完成
    const p1 = harness().doSend("第一轮");
    await tick();
    await tick();
    releaseChat?.();
    await p1;
    await tick();
    // 第二轮：同上
    const p2 = harness().doSend("第二轮");
    await tick();
    await tick();
    releaseChat?.();
    await p2;
    await tick();
    const msgs = harness().getMessages();
    expect(msgs.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["第一轮", "第二轮"]);
    // 协议：两轮对话只创建一次会话（hasId=true 仅 1 次），第二轮复用同一会话不重复创建
    const creates = listCalls.filter((c) => c.hasId);
    expect(creates).toHaveLength(1);
    await act(() => root.unmount());
  });
});
