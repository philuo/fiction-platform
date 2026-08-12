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
const created = new Map<string, { id: string; role: string; text?: string; pending?: boolean; interrupted?: boolean; at?: number }[]>();
/** 手动释放 SSE（模拟生成完成） */
let releaseChat: (() => void) | null = null;
/** 记录对 /api/brain/sessions 的调用（验证无 id 列表 / 有 id 创建分派与挂载无空壳） */
const listCalls: Array<{ hasId: boolean; id?: string }> = [];
/** 记录对 /api/brain/sessions/detail 的调用（验证 newSession id 被复用） */
const detailCalls: string[] = [];
/** 记录对 /api/brain/chat 的请求体（验证 ctx 透传 / resume 标记） */
const chatBodies: Array<{ prompt?: string; sessionId?: string; resume?: boolean; ctx?: { chapterIndex?: number | null } }> = [];
/** SSE 事件队列（由测试预置，逐条发射后关闭） */
let chatEvents: Array<Record<string, unknown>> | null = null;
/** detail 返回的 per-session completed（模拟服务端持久化的卡片完成标记） */
const detailCompleted = new Map<string, string[]>();
/** 记录 /api/brain/sessions/completed 调用（验证持久化请求） */
const completedCalls: Array<{ id: string; key: string }> = [];
/** 记录对 /api/brain/sessions/append 调用（验证卡片消息持久化请求） */
const appendCalls: Array<{ id: string; messageId: string; cards: unknown[] }> = [];
/** 记录对 /api/brain/sessions/replace-card 调用（验证单面板流转的卡片整体替换持久化） */
const replaceCalls: Array<{ id: string; messageId: string; cardIndex: number; card: unknown }> = [];

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
    if (u.includes("/api/brain/sessions/completed")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: string; key: string };
      completedCalls.push({ id: body.id, key: body.key });
      const arr = detailCompleted.get(body.id) ?? [];
      if (!arr.includes(body.key)) detailCompleted.set(body.id, [...arr, body.key]);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/sessions/append")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sessionId: string; message: { id: string; cards?: unknown[] } };
      appendCalls.push({ id: body.sessionId, messageId: body.message.id, cards: body.message.cards ?? [] });
      // 持久化到 mock 会话存储：detail 可读到（模拟服务端落盘后刷新恢复）
      const arr = created.get(body.sessionId) ?? [];
      if (!arr.some((m) => m.id === body.message.id)) arr.push({ id: body.message.id, role: "assistant", cards: body.message.cards });
      created.set(body.sessionId, arr);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
    if (u.includes("/api/brain/sessions/replace-card")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sessionId: string; messageId: string; cardIndex: number; card: unknown };
      replaceCalls.push({ id: body.sessionId, messageId: body.messageId, cardIndex: body.cardIndex, card: body.card });
      // 持久化到 mock 会话存储（模拟服务端落盘后刷新恢复）
      const arr = created.get(body.sessionId) ?? [];
      const msg = arr.find((m) => m.id === body.messageId) as { cards?: { [k: string]: unknown }[] } | undefined;
      if (msg && Array.isArray(msg.cards) && body.cardIndex >= 0 && body.cardIndex < msg.cards.length) {
        msg.cards[body.cardIndex] = body.card as { [k: string]: unknown };
      }
      return new Response(JSON.stringify({ ok: true, replaced: true }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }
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
        completed: detailCompleted.get(body.id) ?? [],
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
      // 记录请求体（ctx 透传 / resume 标记断言）
      chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof chatBodies)[number]);
      // SSE：默认先发 intent，由测试手动 release 完成；chatEvents 预置时逐条发射后关闭
      const enc = new TextEncoder();
      if (chatEvents) {
        const events = chatEvents;
        chatEvents = null;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            for (const ev of events) c.enqueue(enc.encode("data: " + JSON.stringify(ev) + "\n\n"));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }) as unknown as Response;
      }
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
  const { messages, activeId, newSession, openSession, send, completed, markCompleted, appendCard, replaceCard, applySyncSnapshot } = useBrainSession("brain-session-hook-test");
  const msgRef = React.useRef(messages);
  msgRef.current = messages;
  const completedRef = React.useRef(completed);
  completedRef.current = completed;
  React.useEffect(() => {
    (win as unknown as { __harness?: unknown }).__harness = {
      doSend: async (prompt: string, ctx?: {
        chapterIndex?: number | null;
        chapterTitle?: string | null;
        chapterStatus?: string | null;
        chapterWords?: number | null;
        versionCount?: number | null;
        systemStatus?: string | null;
        writingRunning?: boolean;
        presence?: string | null;
        activity?: string | null;
        autoRunning?: boolean;
      }) => {
        let sid = activeId;
        if (!sid) sid = await newSession(prompt);
        await send({ prompt, sessionId: sid, ctx });
      },
      startNew: () => newSession(),
      openSession: (id: string, force?: boolean) => openSession(id, undefined, force),
      getMessages: () => msgRef.current,
      getActiveId: () => activeId,
      getCompleted: () => completedRef.current,
      markCompleted: (key: string) => markCompleted(key),
      appendCard: (msg: { id: string; role: "brain"; cards: unknown[]; at: string }) => appendCard(activeId, msg),
      replaceCard: (messageId: string, cardIndex: number, card: unknown, persist?: boolean) => replaceCard(activeId, messageId, cardIndex, card as never, persist ?? true),
      applySyncSnapshot,
    };
  });
  return <div>{messages.map((m) => `${m.role}:${m.text}`).join("|")}</div>;
}

async function mountHarness() {
  created.clear();
  releaseChat = null;
  listCalls.length = 0;
  detailCalls.length = 0;
  chatBodies.length = 0;
  chatEvents = null;
  detailCompleted.clear();
  completedCalls.length = 0;
  appendCalls.length = 0;
  replaceCalls.length = 0;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const root: Root = createRoot(mount);
  await act(() => { root.render(React.createElement(Harness)); });
  return { mount, root };
}

  const harness = () => (win as unknown as { __harness: { doSend: (p: string, ctx?: { chapterIndex?: number | null }) => Promise<void>; startNew: () => Promise<string>; getMessages: () => { id?: string; role: string; text?: string; pending?: boolean; cards?: unknown[] }[]; getActiveId: () => string; openSession: (id: string, force?: boolean) => Promise<void>; replaceCard: (messageId: string, cardIndex: number, card: unknown, persist?: boolean) => Promise<void>; appendCard: (msg: { id: string; role: "brain"; cards: unknown[]; at: string }) => Promise<void>; applySyncSnapshot: (sessions: unknown[]) => void } }).__harness;

describe("useBrainSession 首次对话发送", () => {
  test("brain-status 快照覆盖非本 Tab 流式会话，清除 pending/loading 并更新 running 卡", async () => {
    const { root } = await mountHarness();
    await tick();
    const sid = "sync-session";
    await act(() => harness().applySyncSnapshot([{
      id: sid, sessionTitle: "插画任务", createdAt: 1, updatedAt: 2, streaming: false, completed: [],
      messages: [{ id: "brain-sync-1", role: "assistant", text: "分镜失败", at: 2, pending: false, interrupted: true, cards: [{ kind: "preview", cardId: "media-sync", status: "failed", title: "分镜失败" }] }],
    }]));
    await act(() => harness().openSession(sid));
    await tick();
    const msg = harness().getMessages().find((m) => m.id === "brain-sync-1");
    expect(msg?.pending).toBe(false);
    expect((msg?.cards?.[0] as { status?: string }).status).toBe("failed");
    await act(() => root.unmount());
  });

  test("brain-status 权威快照移除当前会话时清空旧消息与 activeId", async () => {
    const { root } = await mountHarness();
    await tick();
    const sid = "deleted-in-other-tab";
    await act(() => harness().applySyncSnapshot([{
      id: sid, sessionTitle: "待删除", createdAt: 1, updatedAt: 2, streaming: false, completed: [],
      messages: [{ id: "u-del", role: "user", text: "旧消息", at: 2 }],
    }]));
    await act(() => harness().openSession(sid));
    expect(harness().getActiveId()).toBe(sid);
    expect(harness().getMessages()).toHaveLength(1);

    await act(() => harness().applySyncSnapshot([]));
    expect(harness().getActiveId()).toBe("");
    expect(harness().getMessages()).toEqual([]);
    await act(() => root.unmount());
  });

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

  test("打开被中断的会话：不自动发起 resume（修复每次打开弹窗默认发起聊天）", async () => {
    const { root } = await mountHarness();
    await tick();
    // 手工构造：会话含 user 消息 + 被中断的 assistant 消息（interrupted=true）
    const sid = "interrupted-session";
    created.set(sid, [
      { id: "u1", role: "user", text: "你好", at: 1786182000000 },
      { id: "b1", role: "assistant", text: "部分生成", interrupted: true, at: 1786182000000 },
    ]);
    // 记录 chat 请求次数（需重置 mock 的 chatCalls——直接用 fetch 内嵌计数）
    let chatCalls = 0;
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/brain/chat")) chatCalls++;
      return origFetch2(url, init);
    };
    // 打开该会话（detail 未命中缓存 → 拉取 → 不应触发 resume）
    await act(() => harness().openSession(sid));
    await tick();
    await tick();
    expect(chatCalls).toBe(0); // interrupted 不自动 resume
    // 会话已展示（消息可读；role 转换为 brain）
    const shown = harness().getMessages();
    expect(shown.some((m) => m.role === "brain" && m.text === "部分生成" && m.interrupted)).toBe(true);
    globalThis.fetch = origFetch2;
    await act(() => root.unmount());
  });

  test("markCompleted 持久化到服务端；openSession 恢复 completed（刷新后完成态不丢失）", async () => {
    const { root } = await mountHarness();
    await tick();
    const sid = "persist-session-1";
    // 预置会话（created 里有消息才被列表显示；直接构造）
    created.set(sid, [{ id: "u1", role: "user", text: "你好", at: 0 }]);
    // 模拟上次会话里已完成的卡片操作（服务端持久化）
    detailCompleted.set(sid, ["m1:0", "m1:1:cp1"]);
    // 打开会话 → completed 恢复
    await harness().openSession(sid);
    await tick();
    expect(harness().getCompleted()).toEqual(new Set(["m1:0", "m1:1:cp1"]));
    // 标记新操作 → 本地立即生效 + POST 持久化
    await harness().markCompleted("m1:2:cp2");
    await tick();
    await tick();
    expect(harness().getCompleted()).toEqual(new Set(["m1:0", "m1:1:cp1", "m1:2:cp2"]));
    expect(completedCalls).toContainEqual({ id: sid, key: "m1:2:cp2" });
    // 重复标记幂等：不再发请求
    await harness().markCompleted("m1:0");
    await tick();
    await tick();
    expect(completedCalls.filter((c) => c.id === sid && c.key === "m1:0").length).toBe(0);
    // 切到空态（新建无输入）→ completed 清空
    await harness().startNew();
    await tick();
    expect(harness().getCompleted()).toEqual(new Set());
    await act(() => root.unmount());
  });

  test("send 透传完整系统快照 ctx（选中章详情 + 时机 + 自动连载）到 /api/brain/chat 请求体（中枢全知）", async () => {
    const { root } = await mountHarness();
    await tick();
    const p = harness().doSend("帮我生成插画", {
      chapterIndex: 3,
      chapterTitle: "雨夜",
      chapterStatus: "revise",
      chapterWords: 1250,
      versionCount: 2,
      systemStatus: "中枢正在生成回复…",
      writingRunning: false,
      presence: "awake",
      activity: "idle",
      autoRunning: true,
    });
    await tick();
    await tick();
    // 释放 SSE 完成流（doSend 内部 await send 需要它结束）
    releaseChat?.();
    await p;
    const lastBody = chatBodies[chatBodies.length - 1] as Record<string, unknown>;
    expect(lastBody.ctx).toMatchObject({
      chapterIndex: 3,
      chapterTitle: "雨夜",
      chapterStatus: "revise",
      chapterWords: 1250,
      versionCount: 2,
      systemStatus: "中枢正在生成回复…",
      writingRunning: false,
      presence: "awake",
      activity: "idle",
      autoRunning: true,
    });
    await act(() => root.unmount());
  });

  test("send 透传 ctx（选中章节上下文）到 /api/brain/chat 请求体（需求 1/2）", async () => {
    const { root } = await mountHarness();
    await tick();
    const p = harness().doSend("给第三章配张插画", { chapterIndex: 2 });
    await tick();
    await tick();
    // 请求体携带 ctx.chapterIndex = 2（前端选中章）
    expect(chatBodies.length).toBeGreaterThan(0);
    expect(chatBodies[chatBodies.length - 1].ctx).toEqual({ chapterIndex: 2 });
    expect(chatBodies[chatBodies.length - 1].resume).toBe(false);
    releaseChat?.();
    await p;
    await act(() => root.unmount());
  });

  test("onReset 保留服务端重放文本（attach 恢复不闪没已生成内容，需求 3）", async () => {
    const { root } = await mountHarness();
    await tick();
    // 预置 SSE：先 reset（带服务端已生成文本）→ 追加 delta → done
    chatEvents = [
      { type: "reset", messageId: "brain-1", text: "已生成一半" },
      { type: "delta", messageId: "brain-1", text: "已生成一半，继续" },
      { type: "done", messageId: "brain-1" },
    ];
    const p = harness().doSend("继续生成");
    await tick();
    await tick();
    const msgs = harness().getMessages();
    const brain = [...msgs].reverse().find((m) => m.role === "brain");
    // reset 后 delta 从重放文本续写，最终完整文本不被清空
    expect(brain?.text).toBe("已生成一半，继续");
    expect(brain?.pending).toBe(false);
    await p;
    await act(() => root.unmount());
  });

  test("appendCard 本地即时展示 + 持久化到服务端（刷新后卡片消息不丢失）", async () => {
    const { root } = await mountHarness();
    await tick();
    // 先建会话（有 activeId 才能 appendCard）
    const p = harness().doSend("给当前章节配张插画");
    await tick();
    await tick();
    const sid = harness().getActiveId();
    expect(sid).not.toBe("");
    // 模拟 submitForm 提交 form 卡成功后生成的 preview 卡（此前只存前端内存，刷新即丢）
    const previewMsg = {
      id: "preview-local-1",
      role: "brain" as const,
      cards: [{ kind: "preview", title: "生成第 1 章插画（2 张）", commandId: "CMD-M02", level: "L0", summary: "已挑选 2 个关键场景，确认后开始生成。", action: { endpoint: "/api/novel/media/generate", method: "POST", body: { chapterIndex: 1, kind: "image" } } }],
      at: new Date().toISOString(),
    };
    await act(() => harness().appendCard(previewMsg));
    await tick();
    // 本地即时可见
    const msgs = harness().getMessages();
    expect(msgs.some((m) => m.role === "brain" && (m as { cards?: unknown[] }).cards?.length === 1)).toBe(true);
    // 持久化请求已发出（服务端落盘）
    expect(appendCalls).toContainEqual({ id: sid, messageId: "preview-local-1", cards: previewMsg.cards });
    // 模拟刷新：openSession 重拉 detail → preview 卡从服务端恢复（不丢失）
    await act(() => harness().openSession(sid));
    await tick();
    await tick();
    const reloaded = harness().getMessages();
    expect(reloaded.some((m) => (m as { cards?: unknown[] }).cards?.some((c) => (c as { kind?: string }).kind === "preview"))).toBe(true);
    releaseChat?.();
    await p;
    await act(() => root.unmount());
  });

  test("replaceCard 就地整体替换消息内卡片（form→preview 单面板）并持久化到服务端", async () => {
    const { root } = await mountHarness();
    await tick();
    const p = harness().doSend("给当前章节配张插画");
    await tick();
    await tick();
    const sid = harness().getActiveId();
    expect(sid).not.toBe("");
    // 模拟中枢已返回一张媒体 form 卡消息（经 appendCard 本地展示 + 服务端落盘）
    await act(() => harness().appendCard({
      id: "media-msg-1",
      role: "brain",
      cards: [{ kind: "form", title: "生成章节插画", action: { endpoint: "/api/novel/media/plan" }, submitLabel: "挑选场景并生成" }],
      at: new Date().toISOString(),
    }));
    await tick();
    // 替换 form → preview（分镜中，单面板流转第一步）
    const preview = { kind: "preview", cardId: "media-x", title: "生成第 1 章插画（分镜中）", status: "running", statusLabel: "分镜中", detail: "AI 分镜中…" };
    await act(() => harness().replaceCard("media-msg-1", 0, preview));
    await tick();
    const msgs = harness().getMessages();
    const target = msgs.find((m) => (m as { id?: string }).id === "media-msg-1") as { cards?: unknown[] };
    const card = target?.cards?.[0] as { kind?: string; cardId?: string; submitLabel?: string };
    expect(card.kind).toBe("preview");
    expect(card.cardId).toBe("media-x");
    expect(card.submitLabel).toBeUndefined(); // 整体替换清除旧 form 字段
    // 持久化请求已发出（服务端落盘，刷新后恢复单面板状态）
    expect(replaceCalls.some((c) => c.id === sid && c.messageId === "media-msg-1" && c.cardIndex === 0)).toBe(true);
    // 模拟刷新：openSession 重拉 detail → preview 卡从服务端恢复
    await act(() => harness().openSession(sid));
    await tick();
    await tick();
    const reloaded = harness().getMessages();
    const reloadedCard = (reloaded.find((m) => (m as { id?: string }).id === "media-msg-1") as { cards?: unknown[] })?.cards?.[0] as { kind?: string };
    expect(reloadedCard.kind).toBe("preview");
    releaseChat?.();
    await p;
    await act(() => root.unmount());
  });

  test("replaceCard persist=false：本地替换生效但不落盘（分镜中中间态防悬死）", async () => {
    const { root } = await mountHarness();
    await tick();
    const p = harness().doSend("给当前章节配张插画");
    await tick();
    await tick();
    const sid = harness().getActiveId();
    expect(sid).not.toBe("");
    await act(() => harness().appendCard({
      id: "media-msg-persist-false",
      role: "brain",
      cards: [{ kind: "form", title: "生成章节插画", action: { endpoint: "/api/novel/media/plan" }, submitLabel: "挑选场景并生成" }],
      at: new Date().toISOString(),
    }));
    await tick();
    // 分镜中 running 中间态：persist=false → 本地即时替换为 preview
    const preview = { kind: "preview", cardId: "media-y", title: "生成第 1 章插画（分镜中）", status: "running", statusLabel: "分镜中", detail: "AI 分镜中…" };
    await act(() => harness().replaceCard("media-msg-persist-false", 0, preview, false));
    await tick();
    const msgs = harness().getMessages();
    const target = msgs.find((m) => (m as { id?: string }).id === "media-msg-persist-false") as { cards?: unknown[] };
    expect((target?.cards?.[0] as { kind?: string }).kind).toBe("preview");
    // 未发出 replace-card 持久化请求（服务端仍是 form 卡）
    expect(replaceCalls.some((c) => c.messageId === "media-msg-persist-false")).toBe(false);
    // 模拟刷新：真实刷新 = 新 hook 实例缓存未命中 → 从服务端 detail 读取 → created 中仍是 form 卡（可重新提交）
    const stored = (created.get(sid) ?? []).find((m) => (m as { id?: string }).id === "media-msg-persist-false") as { cards?: { kind?: string }[] } | undefined;
    expect(stored?.cards?.[0]?.kind).toBe("form");
    releaseChat?.();
    await p;
    await act(() => root.unmount());
  });
});
