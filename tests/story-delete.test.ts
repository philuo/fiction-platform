// 删除整本书（/api/novel/delete + storage.deleteStory）：
// ① 删除整目录（含 state.json/meta.json/brain-sessions.json/媒体子文件）且列表消失；
// ② 非书条目拒绝删除（不误删 sqlite/任意目录）；
// ③ 账号隔离：A 用户删不到 B 用户的书；
// ④ API 层：登录后删除成功、删除不存在的书返回错误。
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Storage from "../src/api/storage";
import type * as Routes from "../src/api/routes";
import type { WorldState } from "../src/api/world";

let storage: typeof Storage;
let routes: typeof Routes;
let dataDir: string;
let oldCwd: string;

function mkWorld(title: string): WorldState {
  return {
    title,
    genre: "测试",
    premise: "p",
    setting: { time: "架空", place: "测试城", rules: [], tone: "冷峻" },
    characters: [],
    foreshadowing: [],
    timeline: [],
    chapters: [],
    cards: [],
    outline: [],
    nextChapter: 1,
    updatedAt: new Date().toISOString(),
  };
}

beforeAll(async () => {
  oldCwd = process.cwd();
  dataDir = mkdtempSync(join(tmpdir(), "ms-story-delete-"));
  process.chdir(dataDir);
  process.env.APP_DB_PATH = join(dataDir, "app-test.db");
  storage = await import("../src/api/storage");
  routes = await import("../src/api/routes");
});

afterAll(() => {
  process.chdir(oldCwd);
  delete process.env.APP_DB_PATH;
  // 先 close db 再删临时目录，避免残留句柄导致同进程并发文件 SQLITE_IOERR_VNODE
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try {
    getDb().close();
  } catch {
    /* 未初始化则忽略 */
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("storage.deleteStory", () => {
  test("删除整本书：目录整体消失（含会话/媒体子文件），列表与读取均不再包含", () => {
    storage.runAsUser("alice", () => storage.saveWorld(mkWorld("甲书")));
    const dir = join(dataDir, "data", "alice", "甲书");
    mkdirSync(join(dir, "media"), { recursive: true });
    writeFileSync(join(dir, "brain-sessions.json"), "[]");
    writeFileSync(join(dir, "media", "portrait.png"), "fake-png");
    expect(existsSync(join(dir, "state.json"))).toBe(true);

    const ok = storage.runAsUser("alice", () => storage.deleteStory("甲书"));
    expect(ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    storage.runAsUser("alice", () => {
      expect(storage.loadWorld("甲书")).toBeNull();
      expect(storage.listStoriesMeta().map((m) => m.title)).toEqual([]);
    });
  });

  test("非书条目拒绝删除：普通文件与无存档目录返回 false 且保留", () => {
    storage.runAsUser("alice", () => {
      mkdirSync(join(dataDir, "data", "alice"), { recursive: true });
      writeFileSync(join(dataDir, "data", "alice", "app.db"), "sqlite-bytes");
      mkdirSync(join(dataDir, "data", "alice", "scratch"), { recursive: true });
      expect(storage.deleteStory("app.db")).toBe(false);
      expect(storage.deleteStory("scratch")).toBe(false);
    });
    expect(existsSync(join(dataDir, "data", "alice", "app.db"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "alice", "scratch"))).toBe(true);
  });

  test("账号隔离：A 用户删不到 B 用户的书", () => {
    storage.runAsUser("alice", () => storage.saveWorld(mkWorld("共名书")));
    storage.runAsUser("bob", () => storage.saveWorld(mkWorld("共名书")));
    const ok = storage.runAsUser("alice", () => storage.deleteStory("共名书"));
    expect(ok).toBe(true);
    storage.runAsUser("bob", () => {
      expect(storage.loadWorld("共名书")).not.toBeNull();
    });
    expect(existsSync(join(dataDir, "data", "bob", "共名书"))).toBe(true);
  });
});

describe("/api/novel/delete", () => {
  test("登录后删除成功：列表不再包含该书", async () => {
    storage.runAsUser("carol", () => storage.saveWorld(mkWorld("待删书")));
    const res = await storage.runAsUser("carol", () =>
      routes.handleNovelApi(
        "/api/novel/delete",
        new Request("http://x/api/novel/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "待删书" }),
        }),
      ),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { ok?: boolean };
    expect(data.ok).toBe(true);
    expect(existsSync(join(dataDir, "data", "carol", "待删书"))).toBe(false);

    const meta = storage.runAsUser("carol", () => storage.listStoriesMeta());
    expect(meta.map((m) => m.title)).not.toContain("待删书");
  });

  test("删除不存在的书 → 报错（故事不存在）", async () => {
    const res = await storage.runAsUser("carol", () =>
      routes.handleNovelApi(
        "/api/novel/delete",
        new Request("http://x/api/novel/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "从不存在" }),
        }),
      ),
    );
    expect(res!.status).toBe(502);
    const data = (await res!.json()) as { error?: string };
    expect(data.error).toContain("故事不存在");
  });

  test("缺少 title → 400", async () => {
    const res = await storage.runAsUser("carol", () =>
      routes.handleNovelApi(
        "/api/novel/delete",
        new Request("http://x/api/novel/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    );
    expect(res!.status).toBe(400);
  });
});
