// 路由级协议守护：/api/brain/sessions POST 按 body.id 分派
// - 无 id → 返回 {sessions} 列表（不创建会话）
// - 有 id → 创建会话并透传前端 id（id 与请求一致，detail 可命中）
// 覆盖"refreshList 用 POST 拿列表"与"newSession 前端预生成 id 被服务端接受"两个此前断裂的协议点。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const USER = "sessproto_" + Math.random().toString(36).slice(2, 8);
const PASS = "secret123";
const TITLE = "协议守护书";
let dataDir = "";
let authHeader = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-proto-"));
  process.env.BRAIN_SESSIONS_DATA_DIR = dataDir;
  const { handleApi } = await import("../src/api/routes");
  // 注册即登录：响应体携带 token（全量并发下比 Set-Cookie 解析更稳）
  const res = await handleApi(
    "/api/auth/register",
    new Request("http://x/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASS }),
    }),
  );
  const data = res ? (await res.json().catch(() => null)) as { ok?: boolean; token?: string } | null : null;
  if (data?.token) {
    authHeader = `Bearer ${data.token}`;
  } else {
    // 注册冲突（同名已存在，极端情况）→ 登录拿 token
    const login = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USER, password: PASS }),
      }),
    );
    const loginData = login ? (await login.json().catch(() => null)) as { token?: string } | null : null;
    authHeader = `Bearer ${loginData?.token ?? ""}`;
  }
  expect(authHeader).toContain("Bearer ");
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.BRAIN_SESSIONS_DATA_DIR;
});

function post(path: string, body: unknown): Promise<Response | null> {
  // 动态 import 路由（与 auth.test.ts 一致：避免模块级注册互相污染）
  return import("../src/api/routes").then(({ handleApi }) =>
    handleApi(
      path,
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify(body),
      }),
    ),
  );
}

describe("/api/brain/sessions POST 协议", () => {
  test("无 id → 返回 {sessions} 列表，不创建会话", async () => {
    const res = await post("/api/brain/sessions", { title: TITLE });
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { sessions?: unknown[] };
    expect(Array.isArray(data.sessions)).toBe(true);
    // 无 id 的列表请求不应产生任何会话文件副作用：再查一次仍为空
    const res2 = await post("/api/brain/sessions", { title: TITLE });
    const data2 = (await res2!.json()) as { sessions: unknown[] };
    expect(data2.sessions).toEqual([]);
  });

  test("有 id → 创建会话并透传前端 id（id 与请求一致，detail 可命中）", async () => {
    const sid = "proto-uuid-0001";
    const res = await post("/api/brain/sessions", { title: TITLE, id: sid, prompt: "你好中枢" });
    expect(res!.status).toBe(201);
    const data = (await res!.json()) as { session?: { id: string; title: string } };
    expect(data.session?.id).toBe(sid); // 透传前端 id
    // detail 用同一 id 可命中（前端 openSession 不再 404）
    const detail = await post("/api/brain/sessions/detail", { title: TITLE, id: sid });
    expect(detail!.status).toBe(200);
    const d = (await detail!.json()) as { session?: { id: string; messages: unknown[] } };
    expect(d.session?.id).toBe(sid);
    // 幂等：同 id 重复创建 → 返回已有会话（200），不重复创建
    const dup = await post("/api/brain/sessions", { title: TITLE, id: sid, prompt: "重复请求" });
    expect(dup!.status).toBe(200);
    const dupData = (await dup!.json()) as { session?: { id: string; title: string } };
    expect(dupData.session?.id).toBe(sid);
    // 列表过滤空壳：该会话 messages=0（prompt 仅作 title，未写消息）→ 列表不含（"初始无会话"语义）
    const list = await post("/api/brain/sessions", { title: TITLE });
    const l = (await list!.json()) as { sessions: { id: string }[] };
    expect(l.sessions.map((s) => s.id)).not.toContain(sid);
  });

  test("有消息的会话出现在过滤后列表（空壳过滤语义：仅保留有对话内容的）", async () => {
    const sid = "proto-msg-0001";
    await post("/api/brain/sessions", { title: TITLE, id: sid, prompt: "你好" });
    // 模拟真实聊天：在用户上下文内写入一条消息（缓存按 currentUser 隔离，需与接口同一用户上下文）
    const { appendMessage } = await import("../src/api/brain-sessions");
    const { runAsUser } = await import("../src/api/storage");
    await runAsUser(USER, () => appendMessage(TITLE, sid, { id: "m1", role: "user", text: "你好", at: Date.now() }));
    // 列表应包含该有消息会话
    const list = await post("/api/brain/sessions", { title: TITLE });
    const l = (await list!.json()) as { sessions: { id: string }[] };
    expect(l.sessions.map((s) => s.id)).toContain(sid);
    // 清理：删除该会话，避免污染后续测试
    await post("/api/brain/sessions/delete", { title: TITLE, id: sid });
  });

  test("GET 方法 → 405（死代码分支已移除）", async () => {
    const { handleApi } = await import("../src/api/routes");
    const res = await handleApi(
      "/api/brain/sessions",
      new Request("http://x/api/brain/sessions?title=" + encodeURIComponent(TITLE), {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
    );
    expect(res!.status).toBe(405);
  });

  test("append 卡片消息 → 持久化到会话；detail 可读到；缺参数 400", async () => {
    const sid = "proto-append-0001";
    await post("/api/brain/sessions", { title: TITLE, id: sid, prompt: "给当前章节配张插画" });
    // 模拟前端 submitForm 提交 form 卡后生成的 preview 卡（此前只存前端内存，刷新即丢）
    const msg = {
      id: "preview-uuid-0001",
      role: "brain",
      text: "",
      cards: [
        {
          kind: "preview",
          title: "生成第 1 章插画（2 张）",
          commandId: "CMD-M02",
          level: "L0",
          summary: "已从第 1 章正文挑选 2 个关键场景，确认后开始生成。",
          action: { endpoint: "/api/novel/media/generate", method: "POST", body: { title: TITLE, chapterIndex: 1, kind: "image", scenes: [{ anchor: "a", scene: "s" }] } },
        },
      ],
      at: new Date().toISOString(), // 前端 ChatMessage.at 为 ISO 字符串
    };
    const res = await post("/api/brain/sessions/append", { title: TITLE, sessionId: sid, message: msg });
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as { ok?: boolean }).ok).toBe(true);
    // detail 应读到该 preview 卡消息（role 归一为 assistant，at 转 epoch ms）
    const detail = await post("/api/brain/sessions/detail", { title: TITLE, id: sid });
    const d = (await detail!.json()) as { session?: { messages: { id: string; role: string; cards?: unknown[]; at: number }[] } };
    const found = d.session?.messages.find((m) => m.id === "preview-uuid-0001");
    expect(found?.role).toBe("assistant");
    expect(Array.isArray(found?.cards)).toBe(true);
    expect((found!.cards as unknown[]).length).toBe(1);
    expect(typeof found?.at).toBe("number");
    // 幂等：同 id 重复 append 不产生重复消息（appendMessage 追加，但 id 重复会导致两条——此处只验证协议返回 ok）
    // 缺 message → 400
    const bad = await post("/api/brain/sessions/append", { title: TITLE, sessionId: sid });
    expect(bad!.status).toBe(400);
    // 清理
    await post("/api/brain/sessions/delete", { title: TITLE, id: sid });
  });

  test("删除/编辑截断会话后立即发布 brain-status 权威快照", async () => {
    const { appendMessage } = await import("../src/api/brain-sessions");
    const { runAsUser } = await import("../src/api/storage");
    const { subscribeSync } = await import("../src/api/sync");
    const events: Record<string, unknown>[] = [];
    const unsubscribe = subscribeSync((e) => {
      if (e.type === "brain-status" && e.title === TITLE && e.user === USER) events.push(e as unknown as Record<string, unknown>);
    });
    try {
      const sid = "proto-sync-change";
      await post("/api/brain/sessions", { title: TITLE, id: sid, prompt: "第一条" });
      runAsUser(USER, () => {
        appendMessage(TITLE, sid, { id: "sync-u1", role: "user", text: "第一条", at: 1 });
        appendMessage(TITLE, sid, { id: "sync-b1", role: "assistant", text: "回复", at: 2 });
      });

      const trunc = await post("/api/brain/sessions/truncate", { title: TITLE, id: sid, messageId: "sync-b1" });
      expect(((await trunc!.json()) as { ok?: boolean }).ok).toBe(true);
      const truncated = events.at(-1) as { sessions?: { id: string; messages: { id: string }[] }[] } | undefined;
      expect(truncated?.sessions?.find((s) => s.id === sid)?.messages.map((m) => m.id)).toEqual(["sync-u1"]);

      const del = await post("/api/brain/sessions/delete", { title: TITLE, id: sid });
      expect(((await del!.json()) as { ok?: boolean }).ok).toBe(true);
      const deleted = events.at(-1) as { sessions?: { id: string }[] } | undefined;
      expect(deleted?.sessions?.some((s) => s.id === sid)).toBe(false);
      expect(events).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  test("服务重启后的孤儿 streaming/pending 在 sync 快照前收敛为 interrupted", async () => {
    const { createSession, appendMessage, markStreaming, listSyncSessionSnapshots } = await import("../src/api/brain-sessions");
    const { runAsUser } = await import("../src/api/storage");
    const sid = "orphan-stream-after-restart";
    const snapshot = runAsUser(USER, () => {
      createSession(TITLE, "未完成回复", sid);
      appendMessage(TITLE, sid, { id: "orphan-msg", role: "assistant", text: "半段回复", at: 1, pending: true });
      markStreaming(TITLE, sid);
      return listSyncSessionSnapshots(TITLE);
    });
    const session = snapshot.find((s) => s.id === sid)!;
    const message = session.messages.find((m) => m.id === "orphan-msg")!;
    expect(session.streaming).toBe(false);
    expect(message.pending).toBe(false);
    expect(message.interrupted).toBe(true);
    await post("/api/brain/sessions/delete", { title: TITLE, id: sid });
  });
});
