// 分镜任务化端到端测试：/api/novel/media/plan 异步返回 planId（非 scenes）→ /media/plan-status 轮询
// pending→ready 流转、ready 携带匹配正文的 scenes。mock 仅注入 LLM 层（agnes），planScenes 走真实归一化逻辑。
// 数据写入 data/tester/ 临时目录（与 media-auto.test 同款模式），测试结束清理。
import { afterAll, beforeAll, describe, expect, test, mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyWorld, type WorldState } from "../src/api/world";

// —— mock LLM 层（必须在 import 任何 src/api 模块之前） ——
let nextScenesJson = "";
/** 分镜失败开关：true 时 LLM 恒返回空场景（planScenes 3 次重试后失败）；后台任务异步执行，测试期间须保持 true 直至收到 failed 广播 */
let planFailScenes = false;
let transientFailures = 0;
let llmCalls = 0;
mock.module("../src/api/agnes", () => ({
  ChatMessage: Object,
  ToolCall: Object,
  ToolDef: Object,
  AgnesOptions: Object,
  LLMError: class LLMError extends Error {},
  isRetryableError: () => false,
  withSmartRetry: async (_fn: () => Promise<unknown>) => _fn(),
  complete: async () => ({ content: planFailScenes ? JSON.stringify({ scenes: [] }) : nextScenesJson }),
  chat: async () => (planFailScenes ? JSON.stringify({ scenes: [] }) : nextScenesJson),
  readStream: async () => (planFailScenes ? JSON.stringify({ scenes: [] }) : nextScenesJson),
  chatStream: async () => {
    llmCalls++;
    if (transientFailures > 0) {
      transientFailures--;
      throw new Error("HTTP 503: temporary cloud failure");
    }
    return planFailScenes ? JSON.stringify({ scenes: [] }) : nextScenesJson;
  },
}));

const TITLE = "plan-task-test";
const USER = "tester";
let cookie = "";
const chapterText = [
  "夜色渐浓，沈夜负剑立于城楼，眺望远方。他沉默良久，终于开口。",
  "柳青霜提灯而来，衣袖沾着露水，将一封信递到他手中。",
].join("\n\n");

let mockWorld: WorldState;

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

beforeAll(async () => {
  // 隔离账号库（防合跑时与其他测试的 APP_DB_PATH 竞争导致 register 401）
  const tmpDb = join(tmpdir(), "plan-task-" + Math.random().toString(36).slice(2, 8) + ".db");
  process.env.APP_DB_PATH = tmpDb;
  mockWorld = emptyWorld();
  mockWorld.title = TITLE;
  mockWorld.genre = "武侠";
  mockWorld.nextChapter = 1;
  mockWorld.chapters = [{ index: 1, title: "第一章 夜访", text: chapterText, review: null }];
  nextScenesJson = JSON.stringify({
    scenes: [
      { anchor: "沈夜负剑立于城楼，眺望远方", scene: "月色下的城楼，沈夜负剑而立，眺望远方", caption: "沈夜夜登城楼", type: "事件", subject: "沈夜" },
      { anchor: "柳青霜提灯而来，衣袖沾着露水", scene: "柳青霜提灯而来，衣袖沾着露水，递信", caption: "柳青霜递信", type: "事件", subject: "柳青霜" },
    ],
  });
  cookie = await register(USER);
  // 写真实数据目录（storage 硬编码 data/<user>/<slug>）
  const dir = join(process.cwd(), "data", USER, "plan-task-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(mockWorld), "utf8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ title: TITLE, genre: "武侠", updatedAt: Date.now() }), "utf8");
});

afterAll(() => {
  const dir = join(process.cwd(), "data", USER, "plan-task-test");
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  // 关闭 sqlite 释放句柄后删临时 db（Windows EBUSY）
  try {
    const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
    getDb().close();
  } catch { /* 未初始化则跳过 */ }
  delete process.env.APP_DB_PATH;
});

const { runAsUser } = require("../src/api/storage") as typeof import("../src/api/storage");

async function api(url: string, body: Record<string, unknown>) {
  const { handleApi } = await import("../src/api/routes");
  const res = await handleApi(
    url,
    new Request(`http://x${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
  return { status: res!.status, data: (await res!.json()) as Record<string, unknown> };
}

describe("media/plan 分镜任务化（异步 + 状态轮询恢复）", () => {
  test("提交返回 planId（而非同步 scenes），plan-status pending→ready 流转并带匹配场景", async () => {
    const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 2 }));
    expect(p.status).toBe(200);
    expect(p.data.ok).toBe(true);
    const planId = String(p.data.planId ?? "");
    expect(planId.length).toBeGreaterThan(0);
    expect(p.data.scenes).toBeUndefined(); // 不再同步返回场景

    // 轮询 plan-status：mock LLM 立即返回 → 很快 ready
    let got: Record<string, unknown> | null = null;
    for (let i = 0; i < 40; i++) {
      const s = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId }));
      if (s.status === 200 && (s.data.status === "ready" || s.data.status === "failed")) { got = s.data; break; }
      await Bun.sleep(25);
    }
    expect(got).not.toBeNull();
    expect(got!.status).toBe("ready");
    const scenes = got!.scenes as { anchor: string; scene: string }[];
    expect(Array.isArray(scenes)).toBe(true);
    expect(scenes.length).toBe(2);
    // 场景 anchor 已归一化为正文原文（逐字匹配）
    expect(chapterText.includes(scenes[0].anchor)).toBe(true);
    expect(chapterText.includes(scenes[1].anchor)).toBe(true);
  });

  test("未知 planId → notfound（前端提示重试）；缺参 400", async () => {
    const nf = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId: "plan-nonexistent" }));
    expect(nf.status).toBe(200);
    expect(nf.data.status).toBe("notfound");
    const bad = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE }));
    expect(bad.status).toBe(400);
  });
});

describe("media/generate video 同书同章并发防护", () => {
  test("视频生成中（同书同章）再提交 → 409 拒绝；完成后可再提交", async () => {
    // 直接请求 /media/generate（kind=video）：mock 的 createSceneVideo 需可控延迟
    // —— 用 Promise 阻塞第一个请求，观察第二个请求被 409 拦截；再释放第一个，随后新请求成功
    const { handleApi } = await import("../src/api/routes");
    const doGen = () => handleApi(
      "/api/novel/media/generate",
      new Request("http://x/api/novel/media/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ title: TITLE, chapterIndex: 1, kind: "video", scenes: [{ anchor: "沈夜负剑立于城楼", scene: "月色城楼，沈夜负剑而立", caption: "沈夜夜登城楼" }] }),
      }),
    );
    // 第一个请求发起（videoGenBusy 标记后挂起）
    const p1 = doGen();
    await Bun.sleep(30);
    // 同书同章第二个请求 → 409
    const r2 = await doGen();
    expect(r2!.status).toBe(409);
    const d2 = (await r2!.json()) as { error?: string };
    expect(String(d2.error ?? "")).toContain("正在生成");
    // 等第一个完成（video 同步生成很快）
    const r1 = await p1;
    expect(r1!.status).toBe(200);
    // 释放后新请求可再提交（busy 已清）
    const r3 = await doGen();
    expect(r3!.status).toBe(200);
  });
});

describe("分镜任务完成事件广播（sync websocket 事件驱动，免轮询）", () => {
  test("plan ready → publishSync 广播 task-status(kind:media, sub:plan) 携带 scenes", async () => {
    const { subscribeSync, resetSyncState } = await import("../src/api/sync");
    resetSyncState();
    const got: unknown[] = [];
    const unsub = subscribeSync((e) => { if (e.type === "task-status") got.push(e); });
    try {
      // 提交分镜 → 后台完成 → 应触发 ready 广播
      const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 2 }));
      const planId = String(p.data.planId ?? "");
      // 等广播（mock LLM 立即完成）
      for (let i = 0; i < 40 && got.length === 0; i++) await Bun.sleep(25);
      expect(got.length).toBe(1);
      const evt = got[0] as { kind: string; sub?: string; status: string; id?: string; scenes?: unknown[] };
      expect(evt.kind).toBe("media");
      expect(evt.sub).toBe("plan");
      expect(evt.status).toBe("ready");
      expect(evt.id).toBe(planId);
      expect(Array.isArray(evt.scenes)).toBe(true);
      expect((evt.scenes as unknown[]).length).toBe(2);
    } finally {
      unsub();
      resetSyncState();
    }
  });
});

describe("分镜失败事件广播", () => {
  test("plan failed → publishSync 广播 task-status(kind:media, sub:plan, status:failed) 携带 error", async () => {
    const { subscribeSync, resetSyncState } = await import("../src/api/sync");
    resetSyncState();
    const got: unknown[] = [];
    const unsub = subscribeSync((e) => { if (e.type === "task-status") got.push(e); });
    try {
      // 让分镜失败：开关置 true（LLM 恒返回空场景 → planScenes 3 次重试后抛错）
      planFailScenes = true;
      const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 1 }));
      expect(p.status).toBe(200);
      expect(String(p.data.planId ?? "")).not.toBe("");
      // 等 failed 广播（planScenes 3 次重试 + 指数退避，最多约 2.4s）；期间保持 planFailScenes=true
      for (let i = 0; i < 60 && got.length === 0; i++) await Bun.sleep(100);
      expect(got.length).toBe(1);
      const evt = got[0] as { kind: string; sub?: string; status: string; error?: string };
      expect(evt.kind).toBe("media");
      expect(evt.sub).toBe("plan");
      expect(evt.status).toBe("failed");
      expect(typeof evt.error).toBe("string");
    } finally {
      planFailScenes = false;
      unsub();
      resetSyncState();
    }
  });
});

describe("分镜云端错误重试", () => {
  test("连续两次失败后第三次成功，不会提前把任务翻 failed", async () => {
    const { planScenes } = await import("../src/api/media");
    transientFailures = 2;
    llmCalls = 0;
    try {
      const scenes = await planScenes(mockWorld, 1, "image", 1);
      expect(scenes.length).toBe(1);
      expect(llmCalls).toBe(3);
    } finally {
      transientFailures = 0;
    }
  });
});

describe("分镜完成服务端落盘翻卡（带会话上下文，刷新/重开读落盘卡即最新）", () => {
  test("提交带 session → 完成后会话卡直接翻为「分镜完成」确认卡（含场景+倒计时+立即生成）", async () => {
    const { handleApi } = await import("../src/api/routes");
    // 建会话（与 brain-e2e 同款：/api/brain/sessions POST 带 id 创建）
    const sid = "plan-flip-session";
    const mk = await handleApi(
      "/api/brain/sessions",
      new Request("http://x/api/brain/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ title: TITLE, id: sid, prompt: "给当前章节配张插画" }),
      }),
    );
    expect(mk!.status).toBe(201);
    // append 一张「分镜中」running 卡（模拟前端 submitForm 落盘的卡）
    const msgId = "plan-flip-msg";
    const ap = await handleApi(
      "/api/brain/sessions/append",
      new Request("http://x/api/brain/sessions/append", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          title: TITLE, sessionId: sid,
          message: { id: msgId, role: "assistant", text: "", cards: [{
            kind: "preview", cardId: "media-flip-1",
            title: "生成第 1 章插画（分镜中）", status: "running", statusLabel: "分镜中",
            detail: "AI 分镜中…", chapterIndex: 1, mediaKind: "image",
          }] },
        }),
      }),
    );
    expect(ap!.status).toBe(200);
    // 提交分镜（带 session 上下文）
    const p = await runAsUser(USER, () => api("/api/novel/media/plan", {
      title: TITLE, chapterIndex: 1, kind: "image", count: 2,
      session: { sessionId: sid, messageId: msgId, cardIndex: 0, cardId: "media-flip-1" },
    }));
    expect(p.status).toBe(200);
    expect(String(p.data.planId ?? "")).not.toBe("");
    // 等后台完成并落盘（mock LLM 立即完成，轮询 detail 直到卡被翻）
    let flipped: { kind?: string; status?: string; scenes?: unknown[]; countdownAt?: number; action?: { endpoint?: string } } | null = null;
    for (let i = 0; i < 40; i++) {
      const dt = await handleApi(
        "/api/brain/sessions/detail",
        new Request("http://x/api/brain/sessions/detail", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ title: TITLE, id: sid }),
        }),
      );
      const dj = (await dt!.json()) as { session?: { messages?: { cards?: unknown[] }[] } };
      const cards = dj.session?.messages?.find((m) => (m as { id?: string }).id === msgId)?.cards ?? [];
      const c = cards[0] as { kind?: string; status?: string; scenes?: unknown[]; countdownAt?: number; action?: { endpoint?: string } } | undefined;
      if (c && c.status !== "running") { flipped = c; break; }
      await Bun.sleep(50);
    }
    expect(flipped).not.toBeNull();
    expect(flipped!.kind).toBe("preview");
    expect(flipped!.status).toBeUndefined(); // 确认卡无 status（scenes+countdownAt 态）
    expect((flipped!.scenes ?? []).length).toBe(2);
    expect(typeof flipped!.countdownAt).toBe("number");
    expect(flipped!.action?.endpoint).toBe("/api/novel/media/generate");
  });
});

describe("WS 订阅快照（listPendingMediaTasks：进行中任务由后端状态决定）", () => {
  test("分镜 pending 期间快照含该 planId；完成后（failed/ready）不再含", async () => {
    const { listPendingMediaTasks } = await import("../src/api/routes");
    // 用失败开关让分镜保持 pending 约 3.5s（3 次重试退避），期间快照应含该任务
    planFailScenes = true;
    try {
      const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 1 }));
      const planId = String(p.data.planId ?? "");
      expect(planId).not.toBe("");
      // pending 期间：快照含该分镜任务（sub:plan）
      await Bun.sleep(50);
      const snap1 = runAsUser(USER, () => listPendingMediaTasks(USER, TITLE));
      expect(snap1.some((e) => e.type === "task-status" && (e as { sub?: string }).sub === "plan" && e.id === planId)).toBe(true);
      // 等任务结束（外层 2 次重试 + 退避 ~2.4s）→ 快照不再含
      await Bun.sleep(3800);
      const snap2 = runAsUser(USER, () => listPendingMediaTasks(USER, TITLE));
      expect(snap2.some((e) => e.id === planId)).toBe(false);
    } finally {
      planFailScenes = false;
    }
  });
});

describe("/api/novel/media/cancel 幂等取消", () => {
  test("缺 title → 400；不存在的 planId/items 幂等返回 ok", async () => {
    const r1 = await runAsUser(USER, () => api("/api/novel/media/cancel", { planId: "plan-nope" } as Record<string, unknown>));
    expect(r1.status).toBe(400);
    const r2 = await runAsUser(USER, () => api("/api/novel/media/cancel", {
      title: TITLE, planId: "plan-nope", items: [{ chapterIndex: 1, mediaId: "m-nope" }],
    }));
    expect(r2.status).toBe(200);
    expect(r2.data.ok).toBe(true);
  });

  test("取消进行中的分镜 → plan-status 立即 failed，且晚到结果不覆盖 failed", async () => {
    // planFailScenes=true 让分镜外层重试 ~2.4s，期间有充足窗口取消
    planFailScenes = true;
    try {
      const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 1 }));
      const planId = String(p.data.planId ?? "");
      expect(planId).not.toBe("");
      await Bun.sleep(50);
      const c = await runAsUser(USER, () => api("/api/novel/media/cancel", { title: TITLE, planId, reason: "用户取消" }));
      expect(c.status).toBe(200);
      // 立即查：应为 failed
      const s = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId }));
      expect(s.data.status).toBe("failed");
      // 等后台重试全部跑完（~2.4s），晚到结果不得把 failed 翻回 ready
      await Bun.sleep(2800);
      const s2 = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId }));
      expect(s2.data.status).toBe("failed");
    } finally {
      planFailScenes = false;
    }
  });

  test("对已终态（ready）的 planId 取消为 no-op，不翻回 failed", async () => {
    const p = await runAsUser(USER, () => api("/api/novel/media/plan", { title: TITLE, chapterIndex: 1, kind: "image", count: 1 }));
    const planId = String(p.data.planId ?? "");
    // 等 ready
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const s = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId }));
      if (s.data.status === "ready") { ready = true; break; }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const c = await runAsUser(USER, () => api("/api/novel/media/cancel", { title: TITLE, planId }));
    expect(c.status).toBe(200);
    const s = await runAsUser(USER, () => api("/api/novel/media/plan-status", { title: TITLE, planId }));
    expect(s.data.status).toBe("ready");
  });
});
