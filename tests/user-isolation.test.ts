// 账号数据隔离测试：每个用户一个数据目录（data/<username>/），小说/会话/媒体完全隔离；
// sqlite（app.db）与会话记录等非书数据不出现在小说列表；首个注册用户认领 data/ 根遗留旧数据。
// 使用临时 cwd + 临时 sqlite 库（APP_DB_PATH）隔离，不污染真实 data/。
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Storage from "../src/api/storage";
import type * as Auth from "../src/api/auth";
import type * as BrainSessions from "../src/api/brain-sessions";
import type * as Routes from "../src/api/routes";
import type { WorldState } from "../src/api/world";

let storage: typeof Storage;
let auth: typeof Auth;
let sessions: typeof BrainSessions;
let routes: typeof Routes;
let dataDir: string; // 临时 cwd（数据落在 <dataDir>/data/）
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
  dataDir = mkdtempSync(join(tmpdir(), "ms-isolation-"));
  process.chdir(dataDir);
  process.env.APP_DB_PATH = join(dataDir, "app-test.db");
  storage = await import("../src/api/storage");
  auth = await import("../src/api/auth");
  sessions = await import("../src/api/brain-sessions");
  routes = await import("../src/api/routes");
});

afterAll(() => {
  process.chdir(oldCwd);
  delete process.env.APP_DB_PATH;
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try {
    getDb().close();
  } catch {
    /* 未初始化则忽略 */
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("账号数据目录隔离", () => {
  test("不同用户的书落在各自 data/<username>/<slug> 目录，列表与读取互不可见", () => {
    storage.runAsUser("alice", () => storage.saveWorld(mkWorld("甲书")));
    storage.runAsUser("bob", () => storage.saveWorld(mkWorld("乙书")));
    // 落盘位置：用户目录下，而非 data/ 根
    expect(existsSync(join(dataDir, "data", "alice", "甲书", "state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "bob", "乙书", "state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "甲书"))).toBe(false);
    // 列表隔离
    storage.runAsUser("alice", () => {
      expect(storage.listStoriesMeta().map((m) => m.title)).toEqual(["甲书"]);
    });
    storage.runAsUser("bob", () => {
      expect(storage.listStoriesMeta().map((m) => m.title)).toEqual(["乙书"]);
    });
    // 读取隔离：alice 读不到 bob 的书
    storage.runAsUser("alice", () => {
      expect(storage.loadWorld("乙书")).toBeNull();
    });
  });

  test("同书名不同用户各自独立存档，互不影响", () => {
    storage.runAsUser("alice", () => storage.saveWorld(mkWorld("同名书")));
    storage.runAsUser("bob", () => storage.saveWorld(mkWorld("同名书")));
    storage.runAsUser("alice", () => {
      const w = storage.loadWorld("同名书")!;
      w.premise = "alice 修改";
      storage.saveWorld(w);
    });
    storage.runAsUser("bob", () => {
      expect(storage.loadWorld("同名书")!.premise).not.toBe("alice 修改");
    });
    storage.runAsUser("alice", () => {
      expect(storage.loadWorld("同名书")!.premise).toBe("alice 修改");
    });
  });

  test("AsyncLocalStorage 用户上下文沿异步链保持，退出后复位", async () => {
    let inside = "";
    await storage.runAsUser("alice", async () => {
      await new Promise((r) => setTimeout(r, 10));
      inside = storage.currentUser() ?? "";
    });
    expect(inside).toBe("alice");
    expect(storage.currentUser()).toBeNull();
  });
});

describe("非书数据不出现在小说列表", () => {
  test("sqlite 文件、会话记录、杂项文件不被识别为小说", () => {
    mkdirSync(join(dataDir, "data"), { recursive: true });
    writeFileSync(join(dataDir, "data", "app.db"), "sqlite");
    writeFileSync(join(dataDir, "data", "app.db-wal"), "wal");
    writeFileSync(join(dataDir, "data", "app.db-shm"), "shm");
    storage.runAsUser("alice", () => {
      // 书目录内放会话记录：仍是同一本书，不单独出现
      writeFileSync(join(storage.storyDir("甲书"), "brain-sessions.json"), "{}");
      // 用户目录根放杂项文件：不当作书
      writeFileSync(join(storage.userDir("alice"), "随便.txt"), "x");
    });
    // 无上下文（遗留根）列表：不含 app.db 等 sqlite 文件
    const rootMetas = storage.listStoriesMeta();
    expect(rootMetas.some((m) => m.title === "app.db" || m.title === "app.db-wal" || m.title === "app.db-shm")).toBe(false);
    // alice 列表：只有书，不含会话/杂项
    storage.runAsUser("alice", () => {
      const metas = storage.listStoriesMeta();
      expect(metas.map((m) => m.title).sort()).toEqual(["甲书", "同名书"].sort());
    });
  });
});

describe("旧数据迁移（首个注册用户认领）", () => {
  test("migrateLegacyStoriesTo 把 data/ 根下的书目录移到用户目录", () => {
    storage.saveWorld(mkWorld("遗留老书")); // 无上下文 → data/ 根
    expect(existsSync(join(dataDir, "data", "遗留老书", "state.json"))).toBe(true);
    const moved = storage.migrateLegacyStoriesTo("alice");
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dataDir, "data", "alice", "遗留老书", "state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "遗留老书"))).toBe(false);
    storage.runAsUser("alice", () => {
      expect(storage.loadWorld("遗留老书")?.title).toBe("遗留老书");
    });
  });

  test("首个注册用户注册成功后自动迁移（API 层）", async () => {
    storage.saveWorld(mkWorld("首用户认领书"));
    const res = await routes.handleApi(
      "/api/auth/register",
      new Request("http://x/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "firstuser", password: "secret123" }),
      }),
    );
    expect(res!.status).toBe(200);
    expect(existsSync(join(dataDir, "data", "firstuser", "首用户认领书", "state.json"))).toBe(true);
    // 非首用户注册不再迁移
    const again = await routes.handleApi(
      "/api/auth/register",
      new Request("http://x/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "seconduser", password: "secret123" }),
      }),
    );
    expect(again!.status).toBe(200);
    expect(existsSync(join(dataDir, "data", "seconduser"))).toBe(false);
  });

  test("migrateLegacyOnBoot：存量环境（已有用户）启动兜底迁移根下旧书给第一个注册用户", () => {
    // 根下放一本新遗留书（模拟迁移上线前已注册用户 + 遗留数据的环境）
    storage.saveWorld(mkWorld("启动认领书"));
    routes.migrateLegacyOnBoot(); // 第一个注册用户 = firstuser（users 表 id 最小）
    expect(existsSync(join(dataDir, "data", "firstuser", "启动认领书", "state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "启动认领书"))).toBe(false);
    storage.runAsUser("firstuser", () => {
      expect(storage.loadWorld("启动认领书")?.title).toBe("启动认领书");
    });
  });
});

describe("中枢会话隔离", () => {
  test("不同用户同名书的会话互不可见、各自落盘", () => {
    storage.runAsUser("alice", () => sessions.createSession("会话书", "alice 的问题"));
    storage.runAsUser("bob", () => sessions.createSession("会话书", "bob 的问题"));
    storage.runAsUser("alice", () => {
      const list = sessions.listSessions("会话书");
      expect(list).toHaveLength(1);
      expect(list[0].title).toContain("alice");
    });
    storage.runAsUser("bob", () => {
      const list = sessions.listSessions("会话书");
      expect(list).toHaveLength(1);
      expect(list[0].title).toContain("bob");
    });
    expect(existsSync(join(dataDir, "data", "alice", "会话书", "brain-sessions.json"))).toBe(true);
    expect(existsSync(join(dataDir, "data", "bob", "会话书", "brain-sessions.json"))).toBe(true);
  });
});

describe("未登录访问小说/中枢 API 强制 401", () => {
  test("未登录 /api/novel/list 与 /api/brain/state → 401；登录后正常", async () => {
    const anon = await routes.handleApi("/api/novel/list", new Request("http://x/api/novel/list"));
    expect(anon!.status).toBe(401);
    const anonBrain = await routes.handleApi(
      "/api/brain/state",
      new Request("http://x/api/brain/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "甲书" }),
      }),
    );
    expect(anonBrain!.status).toBe(401);

    const login = await routes.handleApi(
      "/api/auth/login",
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "firstuser", password: "secret123" }),
      }),
    );
    expect(login!.status).toBe(200);
    // 改用 token header 走完整流程（不依赖 cookie）
    const loginData = (await login!.json()) as { token: string };
    expect(loginData.token).toBeTruthy();
    const list = await routes.handleApi("/api/novel/list", new Request("http://x/api/novel/list", { headers: { authorization: `Bearer ${loginData.token}` } }));
    expect(list!.status).toBe(200);
    const data = (await list!.json()) as { stories: { title: string }[] };
    // firstuser 只看到自己目录里的书（含注册时认领 + 启动兜底迁移的旧书），看不到 alice/bob 的书
    expect(data.stories.map((s) => s.title).sort()).toEqual(["首用户认领书", "启动认领书"].sort());
  });
});
