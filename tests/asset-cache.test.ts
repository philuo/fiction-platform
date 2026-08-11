// /api/novel/asset 缓存头：图片/视频响应带 public, max-age=2592000（30d）。
// 协商缓存由前置 nginx 层负责（ETag/304），应用只保证上游把 max-age 下发。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let oldCwd: string;
let authCookie = "";
const TEST_USER = "assetcache";
const TITLE = "缓存测试书";

async function assetReq(path: string): Promise<Response> {
  const url = `http://x/api/novel/asset?title=${encodeURIComponent(TITLE)}&path=${encodeURIComponent(path)}`;
  return (await import("../src/api/routes")).handleApi("/api/novel/asset", new Request(url, {
    headers: { Cookie: authCookie },
  })) as Response;
}

beforeAll(async () => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-asset-"));
  process.chdir(tmp);
  process.env.APP_DB_PATH = join(tmp, "app-test.db");
  const { handleApi } = await import("../src/api/routes");
  const { runAsUser } = await import("../src/api/storage");
  // 占位首用户 + 测试用户（账号隔离）
  await handleApi("/api/auth/register", new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dummyfirst", password: "secret123" }),
  }));
  await handleApi("/api/auth/register", new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_USER, password: "secret123" }),
  }));
  const login = await handleApi("/api/auth/login", new Request("http://x/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_USER, password: "secret123" }),
  }));
  authCookie = login!.headers.get("Set-Cookie")!.split(";")[0];
  // 写入测试媒体文件（真实 saveImage 落盘）
  const { saveImage } = await import("../src/api/images");
  runAsUser(TEST_USER, () => {
    saveImage(TITLE, "ill-test123.jpg", new Uint8Array(128).fill(7));
    saveImage(TITLE, "clip-test123.mp4", new Uint8Array(256).fill(1));
  });
});
afterAll(() => {
  process.chdir(oldCwd);
  delete process.env.APP_DB_PATH;
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try { getDb().close(); } catch { /* 未初始化则忽略 */ }
  rmSync(tmp, { recursive: true, force: true });
});

describe("/api/novel/asset 缓存头", () => {
  test("图片：200 带 public, max-age=2592000（30d）+ 正确 Content-Type", async () => {
    const res = await assetReq("images/ill-test123.jpg");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=2592000");
    expect(await res.text()).toBe("\x07".repeat(128)); // 内容透传
  });

  test("视频：同样 30d + video/mp4", async () => {
    const res = await assetReq("images/clip-test123.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=2592000");
  });

  test("资源不存在 → 404", async () => {
    const res = await assetReq("images/nope-404.jpg");
    expect(res.status).toBe(404);
  });

  test("未登录访问 → 401", async () => {
    const res = await (await import("../src/api/routes")).handleApi(
      "/api/novel/asset?title=x&path=images/ill-test123.jpg",
      new Request("http://x/api/novel/asset?title=x&path=images/ill-test123.jpg"),
    );
    expect(res!.status).toBe(401);
  });
});
