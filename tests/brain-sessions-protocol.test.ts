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
});
