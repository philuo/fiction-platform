// 账号系统测试：注册 / 登录 / 会话校验 / 登出 / 新角色提案关闭状态（服务端权威）
// 使用临时 sqlite 库（APP_DB_PATH）隔离，不污染 data/app.db
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Auth from "../src/api/auth";

let auth: typeof Auth;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), "ms-auth-test-"));
  process.env.APP_DB_PATH = join(dbDir, "test.db");
  auth = await import("../src/api/auth"); // 惰性 getDb：env 设置后再初始化临时库
});

afterAll(() => {
  // 关闭 sqlite 连接释放文件句柄，再删临时目录
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  getDb().close();
  delete process.env.APP_DB_PATH;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("注册", () => {
  test("注册成功返回用户（密码为 argon2id 哈希，不存明文）", async () => {
    const u = await auth.registerUser("alice", "secret123");
    expect(u.id).toBeGreaterThan(0);
    expect(u.username).toBe("alice");
    expect(u.displayName).toBe("");
    // 数据库里不存明文
    const { getDb } = await import("../src/api/db");
    const row = getDb().query("SELECT password_hash FROM users WHERE username = ?").get("alice") as { password_hash: string };
    expect(row.password_hash).not.toContain("secret123");
  });

  test("重复用户名抛 AuthError", async () => {
    await expect(auth.registerUser("alice", "otherpass")).rejects.toThrow(auth.AuthError);
  });

  test("用户名/密码校验：过短用户名、过短密码拒绝", () => {
    expect(auth.validateCredentials("a", "secret123")).toContain("用户名");
    expect(auth.validateCredentials("alice", "123")).toContain("密码");
    expect(auth.validateCredentials("bob", "secret123")).toBeNull();
  });
});

describe("登录与会话", () => {
  test("正确密码登录成功，下发 token 且会话可校验", async () => {
    const s = await auth.loginUser("alice", "secret123");
    expect(s).not.toBeNull();
    const user = auth.userFromToken(s!.token);
    expect(user?.username).toBe("alice");
    expect(user?.id).toBe(s!.user.id);
  });

  test("错误密码 / 不存在用户 → null（不泄露用户是否存在）", async () => {
    expect(await auth.loginUser("alice", "wrongpass")).toBeNull();
    expect(await auth.loginUser("ghost", "whatever1")).toBeNull();
  });

  test("userFromRequest：从 Cookie 头解析用户", async () => {
    const s = await auth.loginUser("alice", "secret123");
    const req = new Request("http://x/", { headers: { cookie: `ms_session=${s!.token}` } });
    expect(auth.userFromRequest(req)?.username).toBe("alice");
  });

  test("登出后 token 失效；无效 token 返回 null", async () => {
    const s = await auth.loginUser("alice", "secret123");
    expect(auth.userFromToken(s!.token)).not.toBeNull();
    auth.logoutSession(s!.token);
    expect(auth.userFromToken(s!.token)).toBeNull();
    expect(auth.userFromToken("not-a-token")).toBeNull();
  });

  test("会话 cookie 值：httpOnly + SameSite=Lax", async () => {
    const s = await auth.loginUser("alice", "secret123");
    const v = auth.sessionCookieValue(s!.token);
    expect(v).toContain("HttpOnly");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain(`ms_session=${s!.token}`);
  });
});

describe("新角色提案关闭状态（按用户 + 书名隔离）", () => {
  test("默认未关闭；set 关闭后 get 为 true；恢复后为 false", async () => {
    const bob = await auth.registerUser("bob", "secret123");
    expect(auth.getPropClosed(bob.id, "测试书")).toBe(false);
    auth.setPropClosed(bob.id, "测试书", true);
    expect(auth.getPropClosed(bob.id, "测试书")).toBe(true);
    auth.setPropClosed(bob.id, "测试书", false);
    expect(auth.getPropClosed(bob.id, "测试书")).toBe(false);
  });

  test("不同用户 / 不同书名互不影响", async () => {
    const carol = await auth.registerUser("carol", "secret123");
    const alice = await auth.loginUser("alice", "secret123");
    auth.setPropClosed(alice!.user.id, "书A", true);
    expect(auth.getPropClosed(alice!.user.id, "书A")).toBe(true);
    expect(auth.getPropClosed(alice!.user.id, "书B")).toBe(false);
    expect(auth.getPropClosed(carol.id, "书A")).toBe(false); // 用户隔离
  });
});

describe("API 层冒烟（handleApi）", () => {
  test("POST /api/auth/register：注册即登录，下发会话 cookie", async () => {
    const { handleApi } = await import("../src/api/routes");
    const res = await handleApi(
      "/api/auth/register",
      new Request("http://x/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dave", password: "secret123", displayName: "大伟" }),
      }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { ok: boolean; user: { username: string } };
    expect(data.ok).toBe(true);
    expect(data.user.username).toBe("dave");
    expect(res!.headers.get("Set-Cookie")).toContain("ms_session=");
  });

  test("POST /api/auth/login：错误密码 401，正确密码 200 + cookie", async () => {
    const { handleApi } = await import("../src/api/routes");
    const bad = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dave", password: "wrong!" }),
      }),
    );
    expect(bad!.status).toBe(401);

    const good = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dave", password: "secret123" }),
      }),
    );
    expect(good!.status).toBe(200);
    expect(good!.headers.get("Set-Cookie")).toContain("ms_session=");
  });

  test("GET /api/novel/proposal-closed：未登录 401；登录后读写正常", async () => {
    const { handleApi } = await import("../src/api/routes");
    const anon = await handleApi(
      "/api/novel/proposal-closed",
      new Request("http://x/api/novel/proposal-closed?title=测试书"),
    );
    expect(anon!.status).toBe(401);

    const login = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "dave", password: "secret123" }),
      }),
    );
    const cookie = login!.headers.get("Set-Cookie")!.split(";")[0];

    const read = await handleApi(
      "/api/novel/proposal-closed",
      new Request("http://x/api/novel/proposal-closed?title=测试书", { headers: { cookie } }),
    );
    expect(read!.status).toBe(200);
    expect(((await read!.json()) as { closed: boolean }).closed).toBe(false);

    const write = await handleApi(
      "/api/novel/proposal-closed",
      new Request("http://x/api/novel/proposal-closed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json", cookie,
          "x-command-contract": "v1", "x-command-id": "auth-proposal-closed", "x-command-type": "CMD-S13",
        },
        body: JSON.stringify({ title: "测试书", closed: true }),
      }),
    );
    expect(write!.status).toBe(200);

    const read2 = await handleApi(
      "/api/novel/proposal-closed",
      new Request("http://x/api/novel/proposal-closed?title=测试书", { headers: { cookie } }),
    );
    expect(((await read2!.json()) as { closed: boolean }).closed).toBe(true);
  });

  test("token 路径：注册/登录响应携带 token；Bearer header 识别用户；登出后失效", async () => {
    const { handleApi } = await import("../src/api/routes");

    // 注册：响应体带 token
    const reg = await handleApi(
      "/api/auth/register",
      new Request("http://x/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "eve", password: "secret123" }),
      }),
    );
    expect(reg!.status).toBe(200);
    const regData = (await reg!.json()) as { ok: boolean; token?: string; user: { username: string } };
    expect(regData.token).toBeTruthy();
    expect(regData.user.username).toBe("eve");

    // 登录：响应体带 token
    const login = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "eve", password: "secret123" }),
      }),
    );
    const loginData = (await login!.json()) as { ok: boolean; token?: string; user: { username: string } };
    expect(loginData.token).toBeTruthy();

    // Bearer header 识别用户（不走 cookie）
    const me = await handleApi(
      "/api/auth/me",
      new Request("http://x/api/auth/me", { headers: { authorization: `Bearer ${loginData.token}` } }),
    );
    expect(me!.status).toBe(200);
    expect(((await me!.json()) as { user: { username: string } }).user.username).toBe("eve");

    // 按 token 登出后 token 失效
    await handleApi(
      "/api/auth/logout",
      new Request("http://x/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${loginData.token}` } }),
    );
    const afterLogout = await handleApi(
      "/api/auth/me",
      new Request("http://x/api/auth/me", { headers: { authorization: `Bearer ${loginData.token}` } }),
    );
    expect(afterLogout!.status).toBe(401);
  });

  test("无凭证（无 token 无 cookie）：/api/chat、/api/chat/stream、/api/search 一律 401", async () => {
    const { handleApi } = await import("../src/api/routes");
    for (const [p, method] of [
      ["/api/chat", "POST"],
      ["/api/chat/stream", "POST"],
      ["/api/search", "POST"],
    ] as const) {
      const r = await handleApi(p, new Request(`http://x${p}`, { method }));
      expect(r!.status).toBe(401, `${p} 未登录应 401`);
    }
  });

  test("带 token 的 /api/chat 与 /api/search 可到达业务层（不再 401）", async () => {
    const { handleApi } = await import("../src/api/routes");
    const login = await handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "eve", password: "secret123" }),
      }),
    );
    const token = ((await login!.json()) as { token: string }).token;
    // /api/chat 无 prompt → 400（说明鉴权已通过、进入业务校验）
    const chat = await handleApi(
      "/api/chat",
      new Request("http://x/api/chat", { method: "POST", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(chat!.status).toBe(400);
    // /api/search 无 query → 400
    const search = await handleApi(
      "/api/search",
      new Request("http://x/api/search", { method: "POST", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }),
    );
    expect(search!.status).toBe(400);
  });
});
