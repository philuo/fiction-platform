// 中枢聊天端到端测试（真实 HTTP 层）：通过 handleApi 走完整链路
// （认证 → 路由分发 → SSE 流），mock 仅注入 brainChatDeps 依赖点 + 临时数据目录。
// 覆盖核心闭环与极端场景：
// 1. 会话全生命周期：创建(id 透传) → chat SSE(intent→delta→done) → 列表 → detail → truncate → delete
// 2. 极端场景：空 prompt 400、缺 title/sessionId 400、resume 会话不存在 error、无待续流消息 error、
//    超长 prompt、会话删除后 send 重建、未登录 401、GET 405、双用户隔离、并发幂等创建
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyWorld, type WorldState } from "../src/api/world";
import type { ChatMessage } from "../src/api/agnes";
import { brainChatDeps } from "../src/api/brain-chat";

// —— 依赖注入（与 brain-chat.test 同款模式，避免 mock.module 污染） ——
let nextChatContent = "";
let nextReplyText = "你好，我是墨枢。这是流式回复。";
const originalDeps = { ...brainChatDeps };

brainChatDeps.chatJson = (async (_msgs: ChatMessage[], _opts?: unknown) =>
  JSON.parse(nextChatContent)) as typeof brainChatDeps.chatJson;
brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: { signal?: AbortSignal }) => {
  const text = nextReplyText;
  let acc = "";
  for (const ch of text) {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    acc += ch;
    onChunk(ch);
  }
  return acc;
}) as typeof brainChatDeps.chatStream;
brainChatDeps.gachaGenerate = (async () => ({ pool: [] })) as typeof brainChatDeps.gachaGenerate;

let mockWorld: WorldState | null = null;
brainChatDeps.loadWorld = (() => mockWorld) as typeof brainChatDeps.loadWorld;

let sessDataDir = "";
let dbDir = "";

beforeAll(async () => {
  // 会话存储 + 账号库均隔离到临时目录，不污染真实 data/
  sessDataDir = mkdtempSync(join(tmpdir(), "e2e-brainsess-"));
  dbDir = mkdtempSync(join(tmpdir(), "e2e-appdb-"));
  process.env.BRAIN_SESSIONS_DATA_DIR = sessDataDir;
  process.env.APP_DB_PATH = join(dbDir, "test.db");
  mockWorld = emptyWorld();
  mockWorld.title = "e2e-book";
  mockWorld.nextChapter = 1;
  nextChatContent = '{"intent":"chat","params":{},"reply":"你好，我是墨枢。"}';
});

afterAll(() => {
  // 恢复 deps（防跨文件污染）
  Object.assign(brainChatDeps, originalDeps);
  // 关闭 sqlite 释放句柄，再删临时目录（Windows EBUSY）
  try {
    const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
    getDb().close();
  } catch { /* 未初始化则跳过 */ }
  delete process.env.APP_DB_PATH;
  delete process.env.BRAIN_SESSIONS_DATA_DIR;
  rmSync(sessDataDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// —— 工具：注册用户拿 token、发请求、读 SSE ——
let cookieA = "";
let cookieB = "";

async function register(username: string): Promise<string> {
  const { handleApi } = await import("../src/api/routes");
  const res = await handleApi(
    "/api/auth/register",
    new Request("http://x/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "secret123" }),
    }),
  );
  const setCookie = res!.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0];
}

async function api(path: string, method: string, body: unknown, cookie: string): Promise<{ status: number; json: () => Promise<Record<string, unknown>>; text: () => Promise<string>; headers: Headers; body: ReadableStream<Uint8Array> | null }> {
  const { handleApi } = await import("../src/api/routes");
  const res = await handleApi(
    path,
    new Request(`http://x${path}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )!;
  return { status: res.status, json: () => res.json(), text: () => res.text(), headers: res.headers, body: res.body };
}

/** 读 SSE 响应 body 全部事件（行缓冲，正确处理分块边界） */
async function readSSE(body: ReadableStream<Uint8Array> | null): Promise<Record<string, unknown>[]> {
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: Record<string, unknown>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行切分：SSE 事件以 \n\n 分隔，逐行解析更稳（事件 JSON 可能跨 chunk）
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = block.trim();
      if (line.startsWith("data: ")) {
        try { events.push(JSON.parse(line.slice(6))); } catch { /* ping 或非 JSON 忽略 */ }
      }
    }
  }
  // 尾部残留
  const tail = buf.trim();
  if (tail.startsWith("data: ")) {
    try { events.push(JSON.parse(tail.slice(6))); } catch { /* ignore */ }
  }
  return events;
}

describe("中枢聊天 e2e：会话生命周期", () => {
  test("中枢系统状态快照：/api/brain/context 返回自动连载/待办聚合（索引式全知）", async () => {
    // 用固定用户名注册（cookieA 与 saveWorld 同一用户目录）；直接 storage 建书（绕开 LLM 立项，测试快速稳定）
    const ctxUser = "e2e_ctx_" + Math.random().toString(36).slice(2, 8);
    cookieA = await register(ctxUser);
    const { saveWorld, runAsUser } = await import("../src/api/storage");
    const w = structuredClone(mockWorld!);
    w.title = "e2e-ctx-book";
    w.characterProposals = [{ id: "cp1", name: "小翠", role: "掌柜", traits: [], motivation: "查清身世", reason: "呼应身世线", source: "writer", status: "pending" }];
    w.pendingCards = [{ id: "g1", type: "伏笔", rarity: "SR", title: "锈剑", description: "一把剑", effect: "取剑", dueHint: "第8章", status: "pending" }];
    w.qualityDebt = [{ id: "d1", text: "逻辑漏洞", status: "open", severity: "major" }];
    w.chapters = [{ index: 1, title: "第一章", text: "正文", review: { verdict: "revise", round: 1, scores: { coherence: 6, logic: 6, pacing: 6, style: 6, character: 6 }, findings: [], summary: "需修订" } }];
    runAsUser(ctxUser, () => saveWorld(w));
    const res = await api("/api/brain/context", "POST", { title: "e2e-ctx-book" }, cookieA);
    expect(res.status).toBe(200);
    const d = (await res.json()) as { context: Record<string, unknown> };
    expect(d.context.autoRunning).toBe(false);
    expect(d.context.pendingProposals).toBe(1);
    expect(d.context.pendingCards).toBe(1);
    expect(d.context.openDebt).toBe(1);
    expect(d.context.reviseChapters).toEqual([1]);
    expect(typeof d.context.mediaGenerating).toBe("boolean");
  });

  test("卡片操作完成标记持久化：POST /completed → detail 返回 completed（刷新恢复完成态）", async () => {
    cookieA = await register("e2e_user_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-completed-" + Math.random().toString(36).slice(2, 8);
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "看看提案" }, cookieA);
    expect(create.status).toBe(201);

    // 标记卡级完成（preview/form/confirm）与项级完成（browse 列表项）
    const mark1 = await api("/api/brain/sessions/completed", "POST", { title: "e2e-book", id: sid, key: "m1:0" }, cookieA);
    expect(mark1.status).toBe(200);
    expect(((await mark1.json()) as { ok: boolean }).ok).toBe(true);
    const mark2 = await api("/api/brain/sessions/completed", "POST", { title: "e2e-book", id: sid, key: "m1:1:cp1" }, cookieA);
    expect(((await mark2.json()) as { ok: boolean }).ok).toBe(true);

    // detail 返回 completed（刷新后前端据此恢复完成态）
    const detail = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d = (await detail.json()) as { session: { completed?: string[] } };
    expect(d.session.completed).toContain("m1:0");
    expect(d.session.completed).toContain("m1:1:cp1");

    // 幂等：重复标记不重复存储
    await api("/api/brain/sessions/completed", "POST", { title: "e2e-book", id: sid, key: "m1:0" }, cookieA);
    const detail2 = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d2 = (await detail2.json()) as { session: { completed?: string[] } };
    expect(d2.session.completed!.filter((k) => k === "m1:0").length).toBe(1);

    // 缺 key → 400
    const bad = await api("/api/brain/sessions/completed", "POST", { title: "e2e-book", id: sid }, cookieA);
    expect(bad.status).toBe(400);
  });

  test("创建 → chat SSE(intent→delta→done) → 列表 → detail → truncate → delete 全链路", async () => {
    cookieA = await register("e2e_user_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-session-1";

    // 1) 创建（id 透传）
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "你好" }, cookieA);
    expect(create.status).toBe(201);
    expect(((await create.json()) as { session: { id: string } }).session.id).toBe(sid);

    // 2) chat SSE：intent → delta → done
    const chat = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好", sessionId: sid, resume: false }, cookieA);
    expect(chat.status).toBe(200);
    expect(chat.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSSE(chat.body as unknown as ReadableStream<Uint8Array>);
    const types = events.map((e) => e.type);
    expect(types).toContain("intent");
    expect(types).toContain("delta");
    expect(types).toContain("done");
    // delta 真流式：每条是增量块（append:true），拼接后含完整回复（避免每块重传累积全文）
    const deltas = events.filter((e) => e.type === "delta") as { text?: string; append?: boolean }[];
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.every((d) => d.append === true)).toBe(true);
    expect(deltas.map((d) => d.text ?? "").join("")).toContain("墨枢");

    // 3) 列表含该会话（有消息）
    const list = await api("/api/brain/sessions", "POST", { title: "e2e-book" }, cookieA);
    const listData = (await list.json()) as { sessions: { id: string }[] };
    expect(listData.sessions.map((s) => s.id)).toContain(sid);

    // 4) detail 命中且消息已落盘
    const detail = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const detailData = (await detail.json()) as { session: { messages: unknown[] } };
    expect(detailData.session.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

    // 5) truncate 到首条 user 消息之后（编辑重发语义）
    const trunc = await api("/api/brain/sessions/truncate", "POST", { title: "e2e-book", id: sid, messageId: "non-existent" }, cookieA);
    expect(trunc.status).toBe(200); // 不存在的消息 id：返回 200 {ok:false}，不破坏

    // 6) 删除
    const del = await api("/api/brain/sessions/delete", "POST", { title: "e2e-book", id: sid }, cookieA);
    expect(del.status).toBe(200);
    const list2 = await api("/api/brain/sessions", "POST", { title: "e2e-book" }, cookieA);
    expect(((await list2.json()) as { sessions: unknown[] }).sessions).not.toContain(sid);
  });
});

describe("中枢聊天 e2e：极端场景", () => {
  test("空 prompt → 400", async () => {
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "", sessionId: "s-empty", resume: false }, cookieA);
    expect(r.status).toBe(400);
  });

  test("缺 title → 400", async () => {
    const r = await api("/api/brain/sessions", "POST", {}, cookieA);
    expect(r.status).toBe(400);
  });

  test("缺 sessionId → 400", async () => {
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好" }, cookieA);
    expect(r.status).toBe(400);
  });

  test("resume 不存在的会话 → SSE error 事件（非崩溃）", async () => {
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "继续", sessionId: "no-such-session", resume: true }, cookieA);
    expect(r.status).toBe(200); // SSE 仍 200
    const events = await readSSE(r.body as unknown as ReadableStream<Uint8Array>);
    expect(events.some((e) => e.error)).toBe(true);
  });

  test("resume 无待续流消息 → SSE error 事件", async () => {
    const sid = "e2e-finished";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "你好" }, cookieA);
    // 正常完成一轮（消息已 done，无 pending）
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好", sessionId: sid, resume: false }, cookieA);
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "继续", sessionId: sid, resume: true }, cookieA);
    const events = await readSSE(r.body as unknown as ReadableStream<Uint8Array>);
    // 已完成会话无 pending 消息 → 服务端发 error 事件
    expect(events.some((e) => e.error)).toBe(true);
  });

  test("未登录访问 → 401", async () => {
    const r = await api("/api/brain/sessions", "POST", { title: "e2e-book" }, "");
    expect(r.status).toBe(401);
  });

  test("GET 方法 → 405", async () => {
    const r = await api("/api/brain/sessions", "GET", undefined, cookieA);
    expect(r.status).toBe(405);
  });

  test("超长 prompt（10k 字符）不崩溃且正常处理", async () => {
    const sid = "e2e-long";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "长输入" }, cookieA);
    const long = "写一章".repeat(5000); // 1.5 万字符
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: long, sessionId: sid, resume: false }, cookieA);
    expect(r.status).toBe(200);
    const events = await readSSE(r.body as unknown as ReadableStream<Uint8Array>);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("会话删除后再次 send → 服务端自动重建同 id（不崩）", async () => {
    const sid = "e2e-recreate";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "你好" }, cookieA);
    await api("/api/brain/sessions/delete", "POST", { title: "e2e-book", id: sid }, cookieA);
    // 删除后立即 chat：非 resume → 自动 createSession 重建
    const r = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好", sessionId: sid, resume: false }, cookieA);
    expect(r.status).toBe(200);
    const events = await readSSE(r.body as unknown as ReadableStream<Uint8Array>);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("双用户同名书会话隔离", async () => {
    cookieB = await register("e2e_user_b_" + Math.random().toString(36).slice(2, 8));
    const sidA = "e2e-isol-a";
    const sidB = "e2e-isol-b";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sidA, prompt: "A 的会话" }, cookieA);
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sidB, prompt: "B 的会话" }, cookieB);
    // 各发一轮消息（否则空壳被列表过滤）
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好 A", sessionId: sidA, resume: false }, cookieA);
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好 B", sessionId: sidB, resume: false }, cookieB);
    // A 看不到 B 的会话，B 看不到 A 的
    const listA = (await (await api("/api/brain/sessions", "POST", { title: "e2e-book" }, cookieA)).json()) as { sessions: { id: string }[] };
    const listB = (await (await api("/api/brain/sessions", "POST", { title: "e2e-book" }, cookieB)).json()) as { sessions: { id: string }[] };
    expect(listA.sessions.map((s) => s.id)).toContain(sidA);
    expect(listA.sessions.map((s) => s.id)).not.toContain(sidB);
    expect(listB.sessions.map((s) => s.id)).toContain(sidB);
    expect(listB.sessions.map((s) => s.id)).not.toContain(sidA);
  });

  test("并发同 id 幂等创建：重复请求不产生重复会话", async () => {
    const sid = "e2e-race";
    const [r1, r2] = await Promise.all([
      api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "并发" }, cookieA),
      api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "并发" }, cookieA),
    ]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);
    // 发消息后列表只应有 1 个该 id
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "测试消息", sessionId: sid, resume: false }, cookieA);
    const list = (await (await api("/api/brain/sessions", "POST", { title: "e2e-book" }, cookieA)).json()) as { sessions: { id: string }[] };
    expect(list.sessions.filter((s) => s.id === sid)).toHaveLength(1);
  });

  test("detail 不存在的会话 → 404（前端静默处理，不崩溃）", async () => {
    const r = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: "no-such-detail" }, cookieA);
    expect(r.status).toBe(404); // 前端 openSession 对 !res.ok 静默 return
  });

  test("会话被截断（truncate 到某消息）后仅保留该消息之前内容", async () => {
    const sid = "e2e-trunc";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "你好" }, cookieA);
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好", sessionId: sid, resume: false }, cookieA);
    // 取第一条 user 消息 id，truncate 到它（删除其后的全部）
    const detail = (await (await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA)).json()) as { session: { messages: { id: string; role: string }[] } };
    const firstUser = detail.session.messages.find((m) => m.role === "user");
    expect(firstUser).toBeTruthy();
    const trunc = await api("/api/brain/sessions/truncate", "POST", { title: "e2e-book", id: sid, messageId: firstUser!.id }, cookieA);
    expect(trunc.status).toBe(200);
    const after = (await (await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA)).json()) as { session: { messages: { id: string }[] } };
    // 截断到 firstUser 及其后删除 → 剩余 0 条（该消息也被删）
    expect(after.session.messages.length).toBe(0);
  });

  test("delete 后 detail → 空响应；重新 create 同 id 可恢复", async () => {
    const sid = "e2e-del-det";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "你好" }, cookieA);
    await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "你好", sessionId: sid, resume: false }, cookieA);
    await api("/api/brain/sessions/delete", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d = (await (await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA)).json()) as { session?: unknown };
    expect(d.session ?? null).toBeFalsy();
    // 重新创建同 id
    const re = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "再次" }, cookieA);
    expect([200, 201]).toContain(re.status);
  });

  test("中断后 resume：复用同一消息续流（不新增消息，user 不重复）", async () => {
    const sid = "e2e-resume";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "写一段" }, cookieA);
    // 第一轮：慢流式 + 中途 abort → interrupted
    const origStream = brainChatDeps.chatStream;
    brainChatDeps.chatStream = (async (_m: unknown, onChunk: (d: string) => void, opts?: { signal?: AbortSignal }) => {
      let acc = "";
      for (const ch of "写了一半的内容") {
        if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        acc += ch;
        onChunk(ch);
        await new Promise((r) => setTimeout(r, 10));
      }
      return acc;
    }) as typeof brainChatDeps.chatStream;
    // 发起并等待首块后 abort（用 AbortController）
    const ac = new AbortController();
    const reqPromise = (async () => {
      const { handleApi } = await import("../src/api/routes");
      return handleApi(
        "/api/brain/chat",
        new Request("http://x/api/brain/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookieA },
          body: JSON.stringify({ title: "e2e-book", prompt: "写一段", sessionId: sid, resume: false }),
          signal: ac.signal,
        }),
      );
    })();
    // 稍等让任务开始流式，然后 abort
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const res = await reqPromise;
    const events = await readSSE(res!.body as unknown as ReadableStream<Uint8Array>);
    expect(events.some((e) => e.type === "interrupted")).toBe(true);
    // 恢复原 chatStream
    brainChatDeps.chatStream = origStream;

    // resume 续流：应复用最后 pending 消息（interrupted），不新增 user 消息
    nextChatContent = '{"intent":"chat","params":{},"reply":"续流回复"}';
    const r2 = await api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "写一段", sessionId: sid, resume: true }, cookieA);
    const ev2 = await readSSE(r2.body as unknown as ReadableStream<Uint8Array>);
    // resume 先 reset 再 delta
    expect(ev2.some((e) => e.type === "reset")).toBe(true);
    expect(ev2.some((e) => e.type === "delta")).toBe(true);
    expect(ev2.some((e) => e.type === "done")).toBe(true);
    // user 消息只有 1 条（resume 不重复写 user）
    const detail = (await (await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA)).json()) as { session: { messages: { role: string }[] } };
    expect(detail.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  test("attach 补发最终状态：任务结束后新连接收到 done（需求 3：不再永久 loading）", async () => {
    const sid = "e2e-attach";
    await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "慢速生成" }, cookieA);
    // 慢速流式：每字符 30ms，测试期间任务保持 running
    const origStream = brainChatDeps.chatStream;
    brainChatDeps.chatStream = (async (_m: unknown, onChunk: (d: string) => void, _opts?: unknown) => {
      let acc = "";
      for (const ch of "慢速回复内容") {
        acc += ch;
        onChunk(ch);
        await new Promise((r) => setTimeout(r, 30));
      }
      return acc;
    }) as typeof brainChatDeps.chatStream;

    try {
      // 第一个连接：发起生成（挂起，任务 running）
      const first = api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "慢速生成", sessionId: sid, resume: false }, cookieA);
      // 等待任务开始（注册 running）后再 attach
      await new Promise((r) => setTimeout(r, 80));
      // 第二个连接：attach 到同一任务（refetch 需要新请求）
      const second = api("/api/brain/chat", "POST", { title: "e2e-book", prompt: "慢速生成", sessionId: sid, resume: false }, cookieA);
      const res2 = await second;
      const events2 = await readSSE(res2.body as unknown as ReadableStream<Uint8Array>);
      // attach 连接：先重放（reset）或直接等到任务结束，最终必须收到 done（补发）——不永久挂起
      expect(events2.some((e) => e.type === "done")).toBe(true);
      // 第一个连接正常完成
      const res1 = await first;
      const events1 = await readSSE(res1!.body as unknown as ReadableStream<Uint8Array>);
      expect(events1.some((e) => e.type === "done")).toBe(true);
      // 会话最终无 pending 消息（落盘完成），且 assistant 恰 1 条（证明 second 走了 attach 而非新回合）
      const detail = (await (await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA)).json()) as { session: { messages: { role: string; pending?: boolean }[] } };
      expect(detail.session.messages.some((m) => m.pending)).toBe(false);
      expect(detail.session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    } finally {
      brainChatDeps.chatStream = origStream;
    }
  });
});

describe("system-note 路由（系统状态注入聊天记录的 HTTP 入口）", () => {
  test("注入成功 → injected:true；重复 eventId → injected:false（幂等）；detail 可见 system 消息", async () => {
    cookieA = await register("e2e_sys_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-sys-" + Math.random().toString(36).slice(2, 8);
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "聊聊连载" }, cookieA);
    expect(create.status).toBe(201);

    const first = await api("/api/brain/sessions/system-note", "POST", { title: "e2e-book", eventId: "auto-ch1", text: "自动连载已提交第 1 章" }, cookieA);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { injected: boolean }).injected).toBe(true);

    const dup = await api("/api/brain/sessions/system-note", "POST", { title: "e2e-book", eventId: "auto-ch1", text: "自动连载已提交第 1 章" }, cookieA);
    expect(((await dup.json()) as { injected: boolean }).injected).toBe(false);

    // detail 可见注入的 system 消息（聊天记录里真实出现）
    const detail = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d = (await detail.json()) as { session: { messages: { kind?: string; text?: string }[] } };
    const sys = d.session.messages.filter((m) => m.kind === "system");
    expect(sys).toHaveLength(1);
    expect(sys[0].text).toContain("自动连载已提交第 1 章");
  });

  test("缺参数 → 400；无会话 → injected:false（事件不补录，不崩溃）", async () => {
    cookieA = await register("e2e_sys2_" + Math.random().toString(36).slice(2, 8));
    const bad = await api("/api/brain/sessions/system-note", "POST", { title: "e2e-book", eventId: "", text: "x" }, cookieA);
    expect(bad.status).toBe(400);
    const noSession = await api("/api/brain/sessions/system-note", "POST", { title: "e2e-nosession-book", eventId: "e1", text: "连载已开始" }, cookieA);
    expect(noSession.status).toBe(200);
    expect(((await noSession.json()) as { injected: boolean }).injected).toBe(false);
  });
});

describe("update-card 路由（卡片就地更新，阶段 3a）", () => {
  test("缺参数 → 400；消息/卡片不存在 → updated:false（不广播、不崩溃）", async () => {
    cookieA = await register("e2e_uc_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-uc-" + Math.random().toString(36).slice(2, 8);
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "生成插画" }, cookieA);
    expect(create.status).toBe(201);

    // 缺参数 → 400
    const bad = await api("/api/brain/sessions/update-card", "POST", { title: "e2e-book", sessionId: sid, messageId: "m1", cardId: "" }, cookieA);
    expect(bad.status).toBe(400);
    // 消息/卡片不存在 → updated:false（不广播、不崩溃）
    const miss = await api("/api/brain/sessions/update-card", "POST", { title: "e2e-book", sessionId: sid, messageId: "no-msg", cardId: "card-x", patch: { detail: "y" } }, cookieA);
    expect(miss.status).toBe(200);
    expect(((await miss.json()) as { updated: boolean }).updated).toBe(false);
  });
});

describe("progress 路由（任务进度卡，阶段 3b）", () => {
  test("创建进度消息 → 返回 messageId/cardId；detail 可见 progress 卡；update-card 翻转", async () => {
    cookieA = await register("e2e_pg_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-pg-" + Math.random().toString(36).slice(2, 8);
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "推进剧情" }, cookieA);
    expect(create.status).toBe(201);

    const pg = await api("/api/brain/sessions/progress", "POST", { title: "e2e-book", sessionId: sid, cardTitle: "推进剧情（写一章）" }, cookieA);
    expect(pg.status).toBe(200);
    const pd = (await pg.json()) as { ok: boolean; messageId: string; cardId: string };
    expect(pd.ok).toBe(true);
    expect(pd.messageId).toBeTruthy();
    expect(pd.cardId).toContain("progress-");

    // detail 可见 progress 卡（status running）
    const detail = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d = (await detail.json()) as { session: { messages: { id: string; cards?: { kind?: string; cardId?: string; status?: string }[] }[] } };
    const msg = d.session.messages.find((m) => m.id === pd.messageId)!;
    expect(msg.cards?.[0]?.kind).toBe("progress");
    expect(msg.cards?.[0]?.cardId).toBe(pd.cardId);
    expect(msg.cards?.[0]?.status).toBe("running");

    // update-card 翻转 done（阶段 3b 完成路径）
    const flip = await api("/api/brain/sessions/update-card", "POST", { title: "e2e-book", sessionId: sid, messageId: pd.messageId, cardId: pd.cardId, patch: { status: "done", phase: "result", detail: "第 1 章《风云》已完成" } }, cookieA);
    expect(((await flip.json()) as { updated: boolean }).updated).toBe(true);
    const detail2 = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d2 = (await detail2.json()) as { session: { messages: { id: string; cards?: { status?: string; detail?: string }[] }[] } };
    const msg2 = d2.session.messages.find((m) => m.id === pd.messageId)!;
    expect(msg2.cards?.[0]?.status).toBe("done");
    expect(msg2.cards?.[0]?.detail).toContain("第 1 章");
  });

  test("缺参数 → 400", async () => {
    cookieA = await register("e2e_pg2_" + Math.random().toString(36).slice(2, 8));
    const bad = await api("/api/brain/sessions/progress", "POST", { title: "e2e-book", sessionId: "" }, cookieA);
    expect(bad.status).toBe(400);
  });
});

describe("replace-card 路由（卡片整体替换，阶段 3b 单面板流转）", () => {
  test("form→preview 整体替换并落盘；detail 可见替换后卡片；下标越界 → replaced:false", async () => {
    cookieA = await register("e2e_rc_" + Math.random().toString(36).slice(2, 8));
    const sid = "e2e-rc-" + Math.random().toString(36).slice(2, 8);
    const create = await api("/api/brain/sessions", "POST", { title: "e2e-book", id: sid, prompt: "生成插画" }, cookieA);
    expect(create.status).toBe(201);

    // 先注入一张 form 卡消息（模拟中枢产出的媒体 form 卡）
    const append = await api("/api/brain/sessions/append", "POST", {
      title: "e2e-book", sessionId: sid,
      message: { id: "rc1", role: "assistant", text: "", cards: [{ kind: "form", title: "生成章节插画", action: { endpoint: "/api/novel/media/plan" }, submitLabel: "挑选场景并生成" }] },
    }, cookieA);
    expect(append.status).toBe(200);

    // 整体替换为 preview（分镜中）
    const preview = {
      kind: "preview", cardId: "media-rc1", title: "生成第 1 章插画（分镜中）", status: "running",
      statusLabel: "分镜中", detail: "AI 分镜中…",
    };
    const rc = await api("/api/brain/sessions/replace-card", "POST", { title: "e2e-book", sessionId: sid, messageId: "rc1", cardIndex: 0, card: preview }, cookieA);
    expect(rc.status).toBe(200);
    expect(((await rc.json()) as { replaced: boolean }).replaced).toBe(true);

    const detail = await api("/api/brain/sessions/detail", "POST", { title: "e2e-book", id: sid }, cookieA);
    const d = (await detail.json()) as { session: { messages: { id: string; cards?: { kind?: string; cardId?: string; status?: string; submitLabel?: string }[] }[] } };
    const msg = d.session.messages.find((m) => m.id === "rc1")!;
    expect(msg.cards?.[0]?.kind).toBe("preview");
    expect(msg.cards?.[0]?.cardId).toBe("media-rc1");
    expect(msg.cards?.[0]?.status).toBe("running");
    expect(msg.cards?.[0]?.submitLabel).toBeUndefined(); // 旧 form 字段整体清除

    // 下标越界 → replaced:false（不破坏）
    const outOfRange = await api("/api/brain/sessions/replace-card", "POST", { title: "e2e-book", sessionId: sid, messageId: "rc1", cardIndex: 9, card: preview }, cookieA);
    expect(((await outOfRange.json()) as { replaced: boolean }).replaced).toBe(false);
    // 缺参数 → 400
    const bad = await api("/api/brain/sessions/replace-card", "POST", { title: "e2e-book", sessionId: sid, messageId: "rc1" }, cookieA);
    expect(bad.status).toBe(400);
  });
});
