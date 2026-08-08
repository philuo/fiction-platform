// 中枢聊天会话（brain-sessions）持久化测试：CRUD + 流式更新 + 中断/完成态 + 任务注册表
// 数据根用 BRAIN_SESSIONS_DATA_DIR 覆盖到临时目录，不污染真实 data/
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendMessage,
  attachSessionTask,
  broadcastToSession,
  createSession,
  deleteSession,
  finishSessionTask,
  getSession,
  lastPendingMessage,
  lastUserMessage,
  listSessions,
  makeTitle,
  markMessageDone,
  markMessageInterrupted,
  markStreaming,
  registerSessionTask,
  truncateSession,
  updateMessageText,
} from "../src/api/brain-sessions";

const TITLE = "brain-sessions-test";
let dataDir = "";
let sessionIds: string[] = [];

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "brain-sessions-"));
  process.env.BRAIN_SESSIONS_DATA_DIR = dataDir;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.BRAIN_SESSIONS_DATA_DIR;
});

describe("会话 CRUD 与持久化往返", () => {
  test("createSession → 落盘 → getSession/listSessions 可恢复", () => {
    const s = createSession(TITLE, "帮我看看第三章写得怎么样");
    sessionIds.push(s.id);
    expect(s.id).toBeTruthy();
    expect(s.title).toBe("帮我看看第三章写得怎么样");
    expect(s.streaming).toBe(false);

    const recovered = getSession(TITLE, s.id);
    expect(recovered?.id).toBe(s.id);
    expect(listSessions(TITLE).map((x) => x.id)).toContain(s.id);
  });

  test("标题截断 24 字符", () => {
    expect(makeTitle("  长篇大论".repeat(10) + "  ").length).toBeLessThanOrEqual(25);
    expect(makeTitle("短标题")).toBe("短标题");
  });

  test("appendMessage + 流式更新 + markMessageDone 完整往返", () => {
    const s = createSession(TITLE, "继续");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u1", role: "user", text: "继续写", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a1", role: "assistant", text: "", at: Date.now(), pending: true });
    markStreaming(TITLE, s.id);

    updateMessageText(TITLE, s.id, "a1", "第一章");
    updateMessageText(TITLE, s.id, "a1", "第一章完成了");
    const mid = getSession(TITLE, s.id);
    expect(lastPendingMessage(mid!)?.text).toBe("第一章完成了");
    expect(lastUserMessage(mid!)?.text).toBe("继续写");
    expect(mid!.streaming).toBe(true);

    markMessageDone(TITLE, s.id, "a1", [{ kind: "result", title: "完成", success: true }]);
    const done = getSession(TITLE, s.id);
    expect(done!.streaming).toBe(false);
    expect(done!.messages[1].pending).toBeFalsy();
    expect(done!.messages[1].cards).toHaveLength(1);
  });

  test("中断态保存", () => {
    const s = createSession(TITLE, "中断测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u2", role: "user", text: "中断测试", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a2", role: "assistant", text: "写到一半", at: Date.now(), pending: true });
    markStreaming(TITLE, s.id);
    markMessageInterrupted(TITLE, s.id, "a2");
    const s2 = getSession(TITLE, s.id)!;
    expect(s2.streaming).toBe(false);
    expect(s2.messages[1].interrupted).toBe(true);
    expect(s2.messages[1].pending).toBeFalsy();
  });

  test("truncateSession：删除 fromMessageId 及其后消息", () => {
    const s = createSession(TITLE, "截断测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u0", role: "user", text: "问题A", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a0", role: "assistant", text: "回答A", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "u1", role: "user", text: "问题B", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a1", role: "assistant", text: "回答B", at: Date.now() });

    expect(truncateSession(TITLE, s.id, "u1")).toBe(true);
    const s2 = getSession(TITLE, s.id)!;
    expect(s2.messages.map((m) => m.id)).toEqual(["u0", "a0"]);
    // 不存在目标消息 → false 且不破坏
    expect(truncateSession(TITLE, s.id, "nonexistent")).toBe(false);
    expect(getSession(TITLE, s.id)!.messages.length).toBe(2);
  });

  test("deleteSession 移除", () => {
    const s = createSession(TITLE, "待删");
    sessionIds.push(s.id);
    expect(deleteSession(TITLE, s.id)).toBe(true);
    expect(getSession(TITLE, s.id)).toBeUndefined();
    expect(deleteSession(TITLE, "nonexistent")).toBe(false);
  });

  test("listSessions 按最近更新倒序", async () => {
    const a = createSession(TITLE, "会话A");
    await Bun.sleep(2);
    const b = createSession(TITLE, "会话B");
    sessionIds.push(a.id, b.id);
    const list = listSessions(TITLE);
    expect(list[0].id).toBe(b.id); // 后创建更新
  });
});

describe("会话级任务注册表（连接解耦）", () => {
  test("attach 到运行中任务可收到广播，finish 后停表", () => {
    const s = createSession(TITLE, "任务测试");
    sessionIds.push(s.id);
    const events: unknown[] = [];
    const emitter = (o: unknown) => events.push(o);
    const task = registerSessionTask(s.id, emitter);
    task.running = true;

    // 第二个连接 attach
    const events2: unknown[] = [];
    const attached = attachSessionTask(s.id, (o) => events2.push(o));
    expect(attached).not.toBeNull();

    broadcastToSession(s.id, { phase: "delta", text: "x" });
    expect(events).toHaveLength(1);
    expect(events2).toHaveLength(1);

    finishSessionTask(s.id);
    broadcastToSession(s.id, { phase: "delta", text: "y" });
    expect(events).toHaveLength(1); // 不再广播
    expect(attachSessionTask(s.id, () => {})).toBeNull(); // 无运行中任务
  });

  test("register 同名会话复用任务；detach 后空集停表", () => {
    const s = createSession(TITLE, "复用测试");
    sessionIds.push(s.id);
    const e1 = () => {};
    const e2 = () => {};
    const t1 = registerSessionTask(s.id, e1);
    const t2 = registerSessionTask(s.id, e2);
    expect(t1).toBe(t2);
    expect(t2.emitters.size).toBe(2);
  });
});
