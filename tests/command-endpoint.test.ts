import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDb, getDb } from "../src/api/db";
import { registerUser, loginUser } from "../src/api/auth";
import { handleApi } from "../src/api/routes";

const root = mkdtempSync(join(tmpdir(), "command-endpoint-"));
let token = "";

beforeAll(async () => {
  process.env.APP_DB_PATH = join(root, "commands.db");
  await registerUser("command-user", "secret123");
  token = (await loginUser("command-user", "secret123"))!.token;
});

afterAll(async () => {
  closeDb();
  delete process.env.APP_DB_PATH;
  Bun.gc(true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows WAL 延迟释放 */ }
});

function command(body: Record<string, unknown>, auth = true) {
  return handleApi("/api/commands", new Request("http://x/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
}

function receipt(commandId: string, auth = true) {
  return handleApi(`/api/commands/${encodeURIComponent(commandId)}`, new Request(`http://x/api/commands/${encodeURIComponent(commandId)}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {},
  }));
}

function contracted(pathname: string, commandId: string, type: string, body: Record<string, unknown>) {
  return handleApi(pathname, new Request(`http://x${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${token}`,
      "x-command-contract": "v1", "x-command-id": commandId, "x-command-type": type,
    },
    body: JSON.stringify(body),
  }));
}

describe("POST /api/commands", () => {
  test("未登录拒绝，公开写指令均已迁入", async () => {
    expect((await command({ commandId: "unauth", type: "CMD-M01", scope: { title: "书" }, payload: {} }, false))?.status).toBe(401);
    const migrated = await command({ commandId: "world-edit", type: "CMD-W12", scope: { title: "书" }, payload: {} });
    expect(migrated?.status).toBe(202);
    await Bun.sleep(20);
    const row = getDb().query("SELECT status,error FROM command_receipts WHERE command_id=?").get("world-edit") as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("故事不存在");
  });

  test("相同 commandId 同 payload 返回原回执，不同 payload 409", async () => {
    const request = { commandId: "cmd-media-plan", type: "CMD-M01", scope: { title: "不存在的书" }, payload: { chapterIndex: 1, kind: "image" } };
    const first = await command(request);
    expect(first?.status).toBe(202);
    expect((await first!.json()).accepted).toBe(true);
    const retry = await command(request);
    expect(retry?.status).toBe(409);
    const retried = await retry!.json() as { commandId: string; status: string; error: string };
    expect(retried.commandId).toBe(request.commandId);
    expect(retried.status).toBe("failed");
    expect(retried.error).toContain("故事不存在");
    const conflict = await command({ ...request, payload: { chapterIndex: 2, kind: "image" } });
    expect(conflict?.status).toBe(409);
    await Bun.sleep(20);
    const row = getDb().query("SELECT status,error FROM command_receipts WHERE command_id=?").get(request.commandId) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("故事不存在");
  });

  test("命令回执查询按登录用户隔离并返回真实终态", async () => {
    const own = await receipt("cmd-media-plan");
    expect(own?.status).toBe(200);
    expect(((await own!.json()) as { status: string }).status).toBe("failed");
    expect((await receipt("cmd-media-plan", false))?.status).toBe(401);
    expect((await receipt("missing-command"))?.status).toBe(404);
  });

  test("同步业务端点幂等重放保持原状态码和 JSON 契约", async () => {
    const first = await contracted("/api/novel/proposal-closed", "sync-replay", "CMD-S13", { title: "重放书", closed: true });
    expect(first?.status).toBe(200);
    expect(await first!.json()).toEqual({ ok: true, closed: true });
    const replay = await contracted("/api/novel/proposal-closed", "sync-replay", "CMD-S13", { title: "重放书", closed: true });
    expect(replay?.status).toBe(200);
    expect(await replay!.json()).toEqual({ ok: true, closed: true });
  });
});
