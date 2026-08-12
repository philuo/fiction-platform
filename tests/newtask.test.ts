// 异步立项任务（newtask + /api/novel/new 异步化）：
// ① 任务状态机：create(running) → complete(done,title) / fail(failed,error)，持久化落盘；
// ② 防重入：已有 running 时复用 id；
// ③ /api/novel/new 立即返回 taskId（不阻塞），终态由持久任务与 sync library 投影恢复；
// ④ 旧 /new/status 与 /list 状态查询接口固定 404；
// ⑤ 启动清理：running/ready 一律标 failed（服务重启后台执行已死）。
// 使用临时 cwd 隔离；后台任务在无 LLM key 环境下快速失败（401），不依赖真实模型。
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Storage from "../src/api/storage";
import type * as Routes from "../src/api/routes";
import type * as NewTask from "../src/api/newtask";

let storage: typeof Storage;
let routes: typeof Routes;
let newtask: typeof NewTask;
let dataDir: string; // 临时 cwd（数据落在 <dataDir>/data/）
let oldCwd: string;
let oldKeys: Record<string, string | undefined> = {};

beforeAll(async () => {
  oldCwd = process.cwd();
  dataDir = mkdtempSync(join(tmpdir(), "ms-newtask-"));
  process.chdir(dataDir);
  process.env.APP_DB_PATH = join(dataDir, "app-test.db");
  // 清空 LLM key：让后台立项快速失败（401），避免真调模型 / 长时间等待
  oldKeys = {
    TEXT_API_KEY: process.env.TEXT_API_KEY,
    AGNES_API_KEY: process.env.AGNES_API_KEY,
    TEXT_BASE_URL: process.env.TEXT_BASE_URL,
    AGNES_BASE_URL: process.env.AGNES_BASE_URL,
  };
  delete process.env.TEXT_API_KEY;
  delete process.env.AGNES_API_KEY;
  delete process.env.TEXT_BASE_URL;
  delete process.env.AGNES_BASE_URL;
  storage = await import("../src/api/storage");
  routes = await import("../src/api/routes");
  newtask = await import("../src/api/newtask");
});

afterAll(() => {
  process.chdir(oldCwd);
  delete process.env.APP_DB_PATH;
  // 必须先 close db 再删临时目录：否则已删文件上的 sqlite 句柄残留会让同进程
  // 并发的其他测试文件 getDb() 拿到已失效 vnode（SQLITE_IOERR_VNODE）
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try {
    getDb().close();
  } catch {
    /* 未初始化则忽略 */
  }
  for (const [k, v] of Object.entries(oldKeys)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const U = "tester";

describe("newtask 任务状态机", () => {
  test("create → running 落盘；complete → done 带 title；fail → failed 带 error；created 标记正确", () => {
    storage.runAsUser(U, () => {
      newtask._clearNewStoryTasks();
      const { id, created } = newtask.createNewStoryTask("一个念头", "科幻");
      expect(created).toBe(true); // 首次创建
      expect(id).toBeTruthy();
      expect(newtask.getNewStoryTask(id)?.status).toBe("running");
      expect(existsSync(join(dataDir, "data", U, "newstory-tasks.json"))).toBe(true);

      newtask.completeNewStoryTask(id, "星辰之书");
      const done = newtask.getNewStoryTask(id)!;
      expect(done.status).toBe("done");
      expect(done.title).toBe("星辰之书");

      const { id: id2, created: c2 } = newtask.createNewStoryTask("另一个念头");
      expect(c2).toBe(true); // 前一个已 done，不占用 running，允许新建
      newtask.failNewStoryTask(id2, "LLM 失败");
      const failed = newtask.getNewStoryTask(id2)!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("LLM 失败");
      // 落盘可恢复（刷新/重启后仍可感知）
      const reloaded = newtask.loadNewStoryTasks();
      expect(reloaded.some((t) => t.id === id && t.status === "done")).toBe(true);
    });
  });

  test("防重入：已有 running 时复用 id 且 created=false（调用方不得再启动后台）", () => {
    storage.runAsUser(U, () => {
      newtask._clearNewStoryTasks();
      const first = newtask.createNewStoryTask("任务A");
      expect(first.created).toBe(true);
      const second = newtask.createNewStoryTask("任务B");
      expect(second.id).toBe(first.id); // 复用同一任务
      expect(second.created).toBe(false); // 明确告知"未新建"，后端据此不启动第二个后台
      expect(newtask.listActiveNewStoryTasks()).toHaveLength(1);
    });
  });

  test("ready 状态机：running → markReady（落 title+stage）→ done 清 stage；updateStage 更新文案", () => {
    storage.runAsUser(U, () => {
      newtask._clearNewStoryTasks();
      const { id } = newtask.createNewStoryTask("壳任务");
      expect(newtask.getNewStoryTask(id)?.status).toBe("running");

      newtask.markNewStoryTaskReady(id, "壳之书");
      const ready = newtask.getNewStoryTask(id)!;
      expect(ready.status).toBe("ready");
      expect(ready.title).toBe("壳之书");
      expect(ready.stage).toBeTruthy(); // 默认阶段文案

      newtask.updateNewStoryTaskStage(id, "正在生成故事蓝图…");
      expect(newtask.getNewStoryTask(id)?.stage).toContain("蓝图");

      newtask.completeNewStoryTask(id, "壳之书");
      const done = newtask.getNewStoryTask(id)!;
      expect(done.status).toBe("done");
      expect(done.stage).toBeUndefined(); // 终态清阶段

      // ready 任务也计入"进行中"（listActive 含 running+ready）
      const { id: id2 } = newtask.createNewStoryTask("又一个壳");
      newtask.markNewStoryTaskReady(id2, "壳二");
      expect(newtask.listActiveNewStoryTasks().map((t) => t.id)).toContain(id2);
    });
  });

  test("removeNewStoryTaskByTitle：删除书时按 title 清理任务（running/ready/done 全清，不影响其他书）", () => {
    storage.runAsUser(U, () => {
      newtask._clearNewStoryTasks();
      const { id: idA } = newtask.createNewStoryTask("书A的念头");
      newtask.completeNewStoryTask(idA, "书A"); // 先完成 A，释放 running 槽，B 才能新建（防重入）
      const { id: idB } = newtask.createNewStoryTask("书B的念头");
      newtask.markNewStoryTaskReady(idB, "书B"); // ready（壳已落盘，仍在增强）
      newtask.removeNewStoryTaskByTitle("书A");
      const tasks = newtask.loadNewStoryTasks();
      expect(tasks.some((t) => t.id === idA)).toBe(false); // done 任务被清
      expect(tasks.some((t) => t.id === idB)).toBe(true); // 其他书保留
      newtask.removeNewStoryTaskByTitle("书B");
      expect(newtask.loadNewStoryTasks()).toHaveLength(0);
    });
  });

  test("cleanup（启动时）：所有 running/ready 一律标 failed（执行上下文不持久化，重启即中断），终态超期清除", () => {
    // 无用户上下文：数据落在 data/ 根，由 cleanupNewStoryTasks 的遗留目录分支（cleanupForDir("")）覆盖
    // （cleanup 遍历 listUsernames 即已注册用户表；测试环境无注册用户，故不走 runAsUser 路径）
    newtask._clearNewStoryTasks();
    const { id: idDone } = newtask.createNewStoryTask("已完成的任务");
    newtask.completeNewStoryTask(idDone, "完成的书"); // 释放 running 槽
    const { id: idReady } = newtask.createNewStoryTask("壳已就绪的任务");
    newtask.markNewStoryTaskReady(idReady, "壳之书"); // ready（壳已就绪仍在增强）
    const { id: idRunning } = newtask.createNewStoryTask("刚提交的任务"); // 非陈旧 running
    newtask.cleanupNewStoryTasks();
    // running + ready 全部被标 failed（无论新旧——重启后后台执行必死），前端可查失败原因，
    // 占位卡/「世界构建中」横幅不再永久 loading；done 任务保留
    expect(newtask.listActiveNewStoryTasks()).toHaveLength(0);
    const after = newtask.loadNewStoryTasks();
    expect(after.find((t) => t.id === idReady)?.status).toBe("failed");
    expect(after.find((t) => t.id === idRunning)?.status).toBe("failed");
    expect(after.find((t) => t.id === idDone)?.status).toBe("done");
  });
});

describe("/api/novel/new 异步提交", () => {
  test("提交立即返回 taskId（不阻塞）；后台任务在无 LLM key 下快速 failed；旧 status 接口不可用", async () => {
    storage.runAsUser(U, () => newtask._clearNewStoryTasks());
    const t0 = Date.now();
    const res = await storage.runAsUser(U, () =>
      routes.handleNovelApi(
        "/api/novel/new",
        new Request("http://x/api/novel/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idea: "失去记忆的剑客寻找过去" }),
        }),
      ),
    );
    expect(res!.status).toBe(200);
    const data = (await res!.json()) as { taskId?: string };
    expect(data.taskId).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(2_000); // 立即返回，不再同步阻塞 1-3 分钟

    // 后台任务应快速结束为 failed（无 LLM key）
    let final: NewTask.NewStoryTask | null = null;
    for (let i = 0; i < 50; i++) {
      final = storage.runAsUser(U, () => newtask.getNewStoryTask(data.taskId!));
      if (final && final.status !== "running") break;
      await Bun.sleep(100);
    }
    expect(final?.status).toBe("failed");
    expect(final?.error).toBeTruthy();

    // 状态查询已迁入 sync；旧端点固定 404。
    const st = await storage.runAsUser(U, () =>
      routes.handleNovelApi(
        "/api/novel/new/status",
        new Request("http://x/api/novel/new/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: data.taskId }),
        }),
      ),
    );
    expect(st!.status).toBe(404);

    // 不存在的任务 → 404
    const miss = await storage.runAsUser(U, () =>
      routes.handleNovelApi(
        "/api/novel/new/status",
        new Request("http://x/api/novel/new/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: "nope" }),
        }),
      ),
    );
    expect(miss!.status).toBe(404);
  });

  test("缺少 idea → 400", async () => {
    const res = await storage.runAsUser(U, () =>
      routes.handleNovelApi(
        "/api/novel/new",
        new Request("http://x/api/novel/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      ),
    );
    expect(res!.status).toBe(400);
  });
});

describe("用户书架状态只经 sync library 投影读取", () => {
  test("旧 /api/novel/list 在任务运行及完成后均固定 404", async () => {
    storage.runAsUser(U, () => {
      newtask._clearNewStoryTasks();
      newtask.createNewStoryTask("进行中的书", "武侠");    });
    const res = await storage.runAsUser(U, () =>
      routes.handleNovelApi("/api/novel/list", new Request("http://x/api/novel/list")),
    );
    expect(res!.status).toBe(404);

    // 完成后 creating 消失（无真实书落盘，stories 不含）
    const running = storage.runAsUser(U, () => newtask.listActiveNewStoryTasks());
    storage.runAsUser(U, () => newtask.completeNewStoryTask(running[0].id, "完成的书"));
    const res2 = await storage.runAsUser(U, () =>
      routes.handleNovelApi("/api/novel/list", new Request("http://x/api/novel/list")),
    );
    expect(res2!.status).toBe(404);
  });
});
