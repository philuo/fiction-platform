// 状态同步 WebSocket 集成测试（阶段 1a/1c）：真实 Bun.serve + Bun 原生 WebSocket 客户端
// 隔离策略（规避并发文件 env 竞争——bun test 同进程并发跑文件，DB 单例/进程 env 共享）：
// - 协议测试：server 自定义 upgrade 注入假用户（X-Test-User header），不依赖 auth DB；
// - 鉴权测试：单独走 handleSyncUpgrade（无凭证 → 401，不需要 DB）；
// - 广播集成：notifyWorldSaved 直调（模拟 saveWorld 触发）+ 一次真 saveWorld 落盘临时用户目录（afterAll 清理）。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyWorld } from "../src/api/world";
import { attachSyncPublish, handleSyncUpgrade, syncWebsocket } from "../src/api/sync-server";
import { clearSyncPending, notifyWorldSaved, resetSyncState } from "../src/api/sync";
import { applyJsonPatch } from "../src/shared/json-patch";

let srv: ReturnType<typeof Bun.serve> | null = null;
let worldDataDir = ""; // saveWorld 集成测试落盘目录（临时 cwd/data 替代不可行，用真实 data/ 临时用户名目录 + 清理）

/** 连接 WS（带 X-Test-User 假用户，或 trueAuth 走真实鉴权路径） */
function connectWs(user: string): Promise<{ ws: WebSocket; msgs: string[]; waitFor: (pred: (m: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${srv!.port}/api/sync`, { headers: { "X-Test-User": user } });
    const msgs: string[] = [];
    const waiters: { pred: (m: Record<string, unknown>) => boolean; resolve: (m: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }[] = [];
    ws.onmessage = (e) => {
      const raw = String(e.data);
      msgs.push(raw);
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(raw); } catch { return; }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.pred(obj)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(obj);
        }
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = () =>
      resolve({
        ws,
        msgs,
        waitFor: (pred, timeoutMs = 4000) =>
          new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs);
            waiters.push({ pred, resolve: res, timer });
          }),
      });
    setTimeout(() => reject(new Error("connect timeout")), 4000);
  });
}

beforeAll(async () => {
  // 协议测试需要真实书目录（message handler 校验 storyExists）——用固定测试用户名建书，afterAll 清理
  const { saveWorld, runAsUser } = await import("../src/api/storage");
  const mk = (user: string, title: string) => {
    const w = emptyWorld();
    w.title = title;
    w.cover = "images/test-cover.jpg";
    runAsUser(user, () => saveWorld(w));
  };
  mk("u1", "ws-book-1");
  mk("uA", "shared-book");
  mk("uB", "shared-book");
  mk("u3", "ws-book-3");
  mk("sync_ws_user", "sync-ws-world");

  srv = Bun.serve({
    port: 0,
    websocket: syncWebsocket,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/sync") return new Response("ok", { status: 200 });
      const testUser = req.headers.get("x-test-user");
      if (testUser) {
        // 协议测试：注入假用户（绕开 auth DB）
        const ok = server.upgrade(req, { data: { user: { id: 1, username: testUser, displayName: testUser }, channels: new Set<string>() } });
        return ok ? undefined : new Response("upgrade fail", { status: 400 });
      }
      // 鉴权测试：真实路径（无凭证 → 401）
      return handleSyncUpgrade(url.pathname, req, server);
    },
  });
  attachSyncPublish(srv);
});

afterAll(async () => {
  if (srv) srv.stop(true);
  resetSyncState();
  clearSyncPending();
  // 清理测试用户的书目录（真实 data/<user>/<slug>）
  for (const u of ["u1", "u2", "u3", "uA", "uB", "sync_ws_user"]) {
    try { rmSync(join(process.cwd(), "data", u), { recursive: true, force: true }); } catch { /* 无残留 */ }
  }
});

describe("WS 升级鉴权", () => {
  test("无凭证 → 401（不升级）", () => {
    // 直接调 handleSyncUpgrade（不依赖全局 fetch——bun test 并发文件会 mock 全局 fetch，真实 fetch 不可靠）
    const res = handleSyncUpgrade("/api/sync", new Request("http://x/api/sync"), srv!);
    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(401);
  });

  test("非 WS 路径 → 返回 null（不劫持普通请求）", () => {
    const res = handleSyncUpgrade("/api/health", new Request("http://x/api/health"), srv!);
    expect(res).toBeNull();
  });
});

describe("订阅与广播（协议）", () => {
  test("建连即推 hello 与用户级 library-snapshot，无需先打开故事", async () => {
    const { ws, msgs, waitFor } = await connectWs("u1");
    const hello = msgs.map((m) => JSON.parse(m) as Record<string, unknown>).find((m) => m.type === "hello")
      ?? await waitFor((m) => m.type === "hello");
    expect(typeof hello.serverInstanceId).toBe("string");
    const library = msgs.map((m) => JSON.parse(m) as Record<string, unknown>).find((m) => m.type === "library-snapshot")
      ?? await waitFor((m) => m.type === "library-snapshot");
    expect((library.data as { stories: { title: string }[] }).stories.some((s) => s.title === "ws-book-1")).toBe(true);
    expect(typeof library.revision).toBe("number");
    expect(typeof library.hash).toBe("string");
    ws.close();
  });

  test("订阅成功 → subscribed(含 version)；publish 后收到 world-changed(版本递增)", async () => {
    const { ws, waitFor } = await connectWs("u1");
    ws.send(JSON.stringify({ type: "subscribe", title: "ws-book-1" }));
    const sub = await waitFor((m) => m.type === "subscribed");
    expect(sub.title).toBe("ws-book-1");
    expect(typeof sub.version).toBe("number");

    // 模拟 saveWorld 触发（notifyWorldSaved 是 saveWorld 的 A 级钩子入口）
    notifyWorldSaved("ws-book-1", "save", "u1");
    const evt = await waitFor((m) => m.type === "world-changed");
    expect(evt.title).toBe("ws-book-1");
    expect((evt.version as number)).toBeGreaterThanOrEqual((sub.version as number) + 1);

    // ping → pong
    ws.send(JSON.stringify({ type: "ping" }));
    await waitFor((m) => m.type === "pong");
    ws.close();
  });

  test("订阅不存在的书：自定义 upgrade 不校验书存在性——由 syncWebsocket.message 校验（模拟不存在）", async () => {
    // 协议层不校验书存在（书校验在真实 message handler，需要真实书目录）；
    // 这里验证：无 title 的 subscribe → error
    const { ws, waitFor } = await connectWs("u2");
    ws.send(JSON.stringify({ type: "subscribe", title: "" }));
    const err = await waitFor((m) => m.type === "error");
    expect(String(err.error)).toContain("缺少 title");
    ws.close();
  });

  test("频道隔离：uA 保存，uB 同名书收不到", async () => {
    const { ws: wsA, msgs: msgsA, waitFor: waitA } = await connectWs("uA");
    const { ws: wsB, msgs: msgsB, waitFor: waitB } = await connectWs("uB");
    wsA.send(JSON.stringify({ type: "subscribe", title: "shared-book" }));
    wsB.send(JSON.stringify({ type: "subscribe", title: "shared-book" }));
    await Promise.all([waitA((m) => m.type === "subscribed"), waitB((m) => m.type === "subscribed")]);
    // 订阅快照可能触发视觉自愈并异步保存；隔离断言只观察此刻之后的显式事件。
    msgsA.length = 0;
    msgsB.length = 0;

    notifyWorldSaved("shared-book", "save", "uA");
    await waitA((m) => m.type === "world-changed");
    await new Promise((r) => setTimeout(r, 200));
    expect(msgsB.some((s) => s.includes("world-changed"))).toBe(false);

    // uB 保存 → uB 收到，uA 收不到
    notifyWorldSaved("shared-book", "save", "uB");
    await waitB((m) => m.type === "world-changed");
    await new Promise((r) => setTimeout(r, 200));
    expect(msgsA.filter((s) => s.includes("world-changed")).length).toBe(1); // 仅 uA 自己那次
    wsA.close();
    wsB.close();
  });

  test("非法 JSON → error；未知消息类型忽略不崩", async () => {
    const { ws, waitFor } = await connectWs("u3");
    ws.send("not-json");
    const err = await waitFor((m) => m.type === "error");
    expect(String(err.error)).toContain("非法消息");
    ws.send(JSON.stringify({ type: "unknown-thing" }));
    ws.send(JSON.stringify({ type: "subscribe", title: "ws-book-3" }));
    await waitFor((m) => m.type === "subscribed");
    ws.close();
  });
});

describe("saveWorld → 事件总线 → WS 广播（真实链路集成）", () => {
  test("订阅后立即推 system-snapshot（世界/视觉/连载/推进同一 WS）", async () => {
    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    const snapshot = await waitFor((m) => m.type === "system-snapshot");
    expect(snapshot.title).toBe("sync-ws-world");
    expect((snapshot.world as { title?: string }).title).toBe("sync-ws-world");
    expect(snapshot.visual).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(snapshot, "autoSession")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(snapshot, "advanceTask")).toBe(true);
    ws.close();
  });

  test("brain-status：建连立即推 pending，多 Tab 未轮询也会定时收到终态", async () => {
    const { createSession, appendMessage, markStreaming, markMessageDone, registerSessionTask, finishSessionTask } = await import("../src/api/brain-sessions");
    const { runAsUser } = await import("../src/api/storage");
    const sid = "sync-brain-pending";
    runAsUser("sync_ws_user", () => {
      createSession("sync-ws-world", "生成插画", sid);
      appendMessage("sync-ws-world", sid, { id: "bm1", role: "assistant", text: "", at: Date.now(), pending: true });
      markStreaming("sync-ws-world", sid);
      registerSessionTask("sync-ws-world", sid, () => {}).running = true;
    });

    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    const pending = await waitFor((m) => m.type === "brain-status" && JSON.stringify(m).includes('"pending":true'));
    expect((pending.sessions as { id: string; streaming: boolean }[]).find((s) => s.id === sid)?.streaming).toBe(true);

    // 不发 HTTP、不主动查询：仅改变服务端持久态，等待 3s 周期 WS 快照推送最终状态。
    runAsUser("sync_ws_user", () => {
      markMessageDone("sync-ws-world", sid, "bm1");
      finishSessionTask("sync-ws-world", sid);
    });
    const pendingDocument = { title: "sync-ws-world", sessions: pending.sessions, tasks: pending.tasks };
    const done = await waitFor((m) => {
      if (m.type !== "patch" || m.document !== "brain") return false;
      const document = applyJsonPatch(pendingDocument, m.ops as Parameters<typeof applyJsonPatch>[1]);
      const sessions = (document as typeof pendingDocument).sessions as { id: string; streaming: boolean; messages: { id: string; pending?: boolean }[] }[];
      const session = sessions.find((s) => s.id === sid);
      return session?.streaming === false && session.messages.find((x) => x.id === "bm1")?.pending === false;
    }, 5000);
    const doneDocument = applyJsonPatch(pendingDocument, done.ops as Parameters<typeof applyJsonPatch>[1]);
    expect((doneDocument.sessions as { id: string; streaming: boolean }[]).find((s) => s.id === sid)?.streaming).toBe(false);
    ws.close();
  });

  test("媒体参数选择经 sync WS 持久化并广播到所有 Tab", async () => {
    const { createSession, appendMessage, getSession } = await import("../src/api/brain-sessions");
    const { loadWorld, runAsUser, saveWorld } = await import("../src/api/storage");
    const sid = "sync-media-form-session";
    const mid = "sync-media-form-message";
    runAsUser("sync_ws_user", () => {
      const w = loadWorld("sync-ws-world")!;
      w.chapters = [
        { index: 1, title: "第一章", text: "正文一", review: null },
        { index: 2, title: "第二章", text: "正文二", review: null },
      ];
      w.nextChapter = 3;
      saveWorld(w);
      createSession("sync-ws-world", "生成插画", sid);
      appendMessage("sync-ws-world", sid, {
        id: mid, role: "assistant", text: "请选择参数", at: Date.now(), cards: [{
          kind: "form", title: "生成章节插画",
          fields: [
            { key: "chapterIndex", label: "章节", type: "select", value: 1, options: [{ label: "第 1 章", value: "1" }, { label: "第 2 章", value: "2" }] },
            { key: "count", label: "张数", type: "select", value: 1, options: [{ label: "1 张", value: "1" }, { label: "2 张", value: "2" }, { label: "3 张", value: "3" }] },
          ],
          action: { endpoint: "/api/novel/media/plan", body: { kind: "image" } },
        }],
      });
    });
    const tabA = await connectWs("sync_ws_user");
    const tabB = await connectWs("sync_ws_user");
    tabA.ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    tabB.ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    await Promise.all([tabA.waitFor((m) => m.type === "subscribed"), tabB.waitFor((m) => m.type === "subscribed")]);
    tabA.ws.send(JSON.stringify({
      type: "media-form-values", title: "sync-ws-world", sessionId: sid, messageId: mid, cardIndex: 0,
      values: { chapterIndex: 2, count: 3 },
    }));
    const [eventA, eventB] = await Promise.all([
      tabA.waitFor((m) => m.type === "card-replaced" && m.messageId === mid),
      tabB.waitFor((m) => m.type === "card-replaced" && m.messageId === mid),
    ]);
    for (const event of [eventA, eventB]) {
      const fields = ((event.card as { fields?: { key: string; value?: unknown }[] }).fields ?? []);
      expect(fields.find((f) => f.key === "chapterIndex")?.value).toBe(2);
      expect(fields.find((f) => f.key === "count")?.value).toBe(3);
    }
    const persisted = runAsUser("sync_ws_user", () => getSession("sync-ws-world", sid));
    const fields = persisted?.messages[0]?.cards?.[0]?.fields as { key: string; value?: unknown }[];
    expect(fields.find((f) => f.key === "chapterIndex")?.value).toBe(2);
    expect(fields.find((f) => f.key === "count")?.value).toBe(3);
    tabA.ws.close();
    tabB.ws.close();
  });

  test("真 saveWorld 触发 world-changed 广播（runAsUser 上下文带 user）", async () => {
    const { saveWorld, runAsUser, loadWorld } = await import("../src/api/storage");
    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    await waitFor((m) => m.type === "subscribed");

    // 建书（落盘到 data/sync_ws_user/sync-ws-world/，afterAll 清理）
    const w = emptyWorld();
    w.title = "sync-ws-world";
    runAsUser("sync_ws_user", () => saveWorld(w));

    // 第二次保存 → world-changed
    const w2 = runAsUser("sync_ws_user", () => loadWorld("sync-ws-world"))!;
    w2.current = "v2";
    runAsUser("sync_ws_user", () => saveWorld(w2));
    const evt = await waitFor((m) => m.type === "world-changed");
    expect(evt.title).toBe("sync-ws-world");
    ws.close();
  });

  test("publishSync brain-note → 事件广播到频道（多 tab 感知链路）", async () => {
    const { publishSync } = await import("../src/api/sync");
    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    await waitFor((m) => m.type === "subscribed");

    // 模拟 system-note 端点注入成功后的广播（routes.ts 在 appendBrainSystemNote 返回 true 时 publishSync brain-note）
    publishSync({ type: "brain-note", title: "sync-ws-world", eventId: "evt-broadcast-1", text: "连载已提交第 1 章", at: Date.now(), user: "sync_ws_user" });
    const note = await waitFor((m) => m.type === "brain-note");
    expect(note.eventId).toBe("evt-broadcast-1");
    expect(note.title).toBe("sync-ws-world");
    ws.close();
  });

  test("publishSync card-update → 事件广播到频道（卡片就地更新链路）", async () => {
    const { publishSync } = await import("../src/api/sync");
    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    await waitFor((m) => m.type === "subscribed");

    publishSync({ type: "card-update", title: "sync-ws-world", sessionId: "s1", messageId: "m1", cardId: "card-1", patch: { status: "ready" }, at: Date.now(), user: "sync_ws_user" });
    const evt = await waitFor((m) => m.type === "card-update");
    expect(evt.cardId).toBe("card-1");
    expect((evt.patch as Record<string, unknown>).status).toBe("ready");
    ws.close();
  });
});

describe("task-status advance 广播（推进完成释放运行锁，bug 修复）", () => {
  test("publishSync task-status(kind:advance) → 广播到频道（前端清 advancePhase 依据）", async () => {
    const { publishSync } = await import("../src/api/sync");
    const { ws, waitFor } = await connectWs("sync_ws_user");
    ws.send(JSON.stringify({ type: "subscribe", title: "sync-ws-world" }));
    await waitFor((m) => m.type === "subscribed");

    publishSync({ type: "task-status", title: "sync-ws-world", kind: "advance", id: "1", status: "done", at: Date.now(), user: "sync_ws_user" });
    const evt = await waitFor((m) => m.type === "task-status");
    expect(evt.kind).toBe("advance");
    expect(evt.status).toBe("done");
    ws.close();
  });
});
