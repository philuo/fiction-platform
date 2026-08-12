// 中枢聊天会话（brain-sessions）持久化测试：CRUD + 流式更新 + 中断/完成态 + 任务注册表
// 数据根用 BRAIN_SESSIONS_DATA_DIR 覆盖到临时目录，不污染真实 data/
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendMessage,
  appendSystemNote,
  attachSessionTask,
  broadcastToSession,
  createSession,
  deleteSession,
  detachSessionTask,
  finishSessionTask,
  getSession,
  lastIncompleteMessage,
  lastPendingMessage,
  lastUserMessage,
  listSessions,
  makeTitle,
  markMessageDone,
  markMessageInterrupted,
  markSessionCompleted,
  markStreaming,
  registerSessionTask,
  truncateSession,
  updateMessageCard,
  replaceMessageCard,
  updateMessageText,
  createProgressMessage,
  isCardExecutionTransition,
} from "../src/api/brain-sessions";

const TITLE = "brain-sessions-test";
let dataDir = "";

test("卡片执行状态机：允许正常推进，终态幂等且拒绝乱序回滚", () => {
  expect(isCardExecutionTransition("idle", "submitting")).toBe(true);
  expect(isCardExecutionTransition("submitting", "running")).toBe(true);
  expect(isCardExecutionTransition("running", "succeeded")).toBe(true);
  expect(isCardExecutionTransition("waiting_confirmation", "submitting")).toBe(true);
  expect(isCardExecutionTransition("succeeded", "succeeded")).toBe(true);
  expect(isCardExecutionTransition("succeeded", "running")).toBe(false);
  expect(isCardExecutionTransition("failed", "submitting")).toBe(false);
  expect(isCardExecutionTransition("idle", "bogus")).toBe(false);
});
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
    const task = registerSessionTask(TITLE, s.id, emitter);
    task.running = true;

    // 第二个连接 attach
    const events2: unknown[] = [];
    const attached = attachSessionTask(TITLE, s.id, (o) => events2.push(o));
    expect(attached).not.toBeNull();

    broadcastToSession(TITLE, s.id, { phase: "delta", text: "x" });
    expect(events).toHaveLength(1);
    expect(events2).toHaveLength(1);

    finishSessionTask(TITLE, s.id);
    broadcastToSession(TITLE, s.id, { phase: "delta", text: "y" });
    expect(events).toHaveLength(1); // 不再广播
    expect(attachSessionTask(TITLE, s.id, () => {})).toBeNull(); // 无运行中任务
  });

  test("register 同名会话复用任务；detach 后空集停表", () => {
    const s = createSession(TITLE, "复用测试");
    sessionIds.push(s.id);
    const e1 = () => {};
    const e2 = () => {};
    const t1 = registerSessionTask(TITLE, s.id, e1);
    const t2 = registerSessionTask(TITLE, s.id, e2);
    expect(t1).toBe(t2);
    expect(t2.emitters.size).toBe(2);
  });

  test("detach 后该连接不再收到广播，其余连接不受影响", () => {
    const s = createSession(TITLE, "detach 测试");
    sessionIds.push(s.id);
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const task = registerSessionTask(TITLE, s.id, (o) => gotA.push(o));
    task.running = true;
    attachSessionTask(TITLE, s.id, (o) => gotB.push(o));

    broadcastToSession(TITLE, s.id, { n: 1 });
    expect(gotA).toHaveLength(1);
    expect(gotB).toHaveLength(1);

    detachSessionTask(TITLE, s.id, task.emitters.values().next().value); // 摘除 A
    broadcastToSession(TITLE, s.id, { n: 2 });
    expect(gotA).toHaveLength(1); // A 不再收
    expect(gotB).toHaveLength(2); // B 仍收
    finishSessionTask(TITLE, s.id);
  });
});

describe("卡片操作完成标记（markSessionCompleted）与 resume 定位工具", () => {
  test("markSessionCompleted 幂等：同 key 只记录一次", () => {
    const s = createSession(TITLE, "completed 测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u1", role: "user", text: "抽卡", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a1", role: "assistant", text: "", at: Date.now(), cards: [{ kind: "browse" }] });
    expect(markSessionCompleted(TITLE, s.id, "a1:0")).toBe(true);
    expect(markSessionCompleted(TITLE, s.id, "a1:0")).toBe(false); // 幂等
    expect(markSessionCompleted(TITLE, s.id, "a1:1")).toBe(true); // 不同 key 记录
    const s2 = getSession(TITLE, s.id)!;
    expect(s2.completed).toEqual(["a1:0", "a1:1"]);
  });

  test("lastIncompleteMessage：pending 与 interrupted 均算未完成（resume 目标），lastPendingMessage 仅 pending", () => {
    const s = createSession(TITLE, "定位工具测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u1", role: "user", text: "继续", at: Date.now() });
    appendMessage(TITLE, s.id, { id: "a1", role: "assistant", text: "写了一半", at: Date.now(), pending: true });
    const mid = getSession(TITLE, s.id)!;
    expect(lastPendingMessage(mid)?.id).toBe("a1");
    expect(lastIncompleteMessage(mid)?.id).toBe("a1");
    markMessageInterrupted(TITLE, s.id, "a1");
    const mid2 = getSession(TITLE, s.id)!;
    expect(lastPendingMessage(mid2)).toBeNull(); // interrupted 不再是 pending
    expect(lastIncompleteMessage(mid2)?.id).toBe("a1"); // 但仍是未完成（可 resume）
  });

  test("updateMessageCard：按 cardId 就地更新卡片并落盘；无 cardId/不匹配 → false 且不破坏", () => {
    const s = createSession(TITLE, "卡片更新测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "u1", role: "user", text: "生成插画", at: Date.now() });
    appendMessage(TITLE, s.id, {
      id: "a1", role: "assistant", text: "已创建任务", at: Date.now(),
      cards: [
        { kind: "result", title: "任务", success: true, detail: "生成中", cardId: "card-media-1" },
        { kind: "browse", title: "无 id 卡", browseType: "media", data: {} }, // 无 cardId（旧卡兼容）
      ],
    });
    // 命中 cardId → 就地合并 patch（保留 cardId）
    const hit = updateMessageCard(TITLE, s.id, "a1", "card-media-1", { detail: "已完成", success: false });
    expect(hit).toBe(true);
    const updated = getSession(TITLE, s.id)!;
    const card = updated.messages[1].cards![0] as { cardId?: string; detail?: string; title?: string; success?: boolean };
    expect(card.detail).toBe("已完成");
    expect(card.success).toBe(false);
    expect(card.cardId).toBe("card-media-1"); // 保留
    expect(card.title).toBe("任务"); // 未 patch 字段保留
    // 无 cardId 的卡不更新
    const hit2 = updateMessageCard(TITLE, s.id, "a1", "card-media-1", { detail: "再改" });
    expect(hit2).toBe(true);
    // 不匹配 cardId → false 且卡片数组不变
    const before = JSON.stringify(getSession(TITLE, s.id)!.messages[1].cards);
    const miss = updateMessageCard(TITLE, s.id, "a1", "no-such-card", { detail: "x" });
    expect(miss).toBe(false);
    expect(JSON.stringify(getSession(TITLE, s.id)!.messages[1].cards)).toBe(before);
    // 消息不存在 → false
    expect(updateMessageCard(TITLE, s.id, "nomsg", "card-media-1", {})).toBe(false);
  });

  test("replaceMessageCard：按消息内下标整体替换卡片（含 kind/action 变更）；下标越界/无卡 → false", () => {
    const s = createSession(TITLE, "卡片替换测试");
    sessionIds.push(s.id);
    appendMessage(TITLE, s.id, { id: "r0", role: "user", text: "生成插画", at: Date.now() });
    appendMessage(TITLE, s.id, {
      id: "r1", role: "assistant", text: "", at: Date.now(),
      cards: [
        { kind: "form", title: "生成章节插画", action: { endpoint: "/api/novel/media/plan" }, submitLabel: "挑选场景并生成" },
      ],
    });
    // 整体替换：form → preview（含 kind/action 变更，updateMessageCard 合并无法做到）
    const preview = {
      kind: "preview", cardId: "media-r1", title: "生成第 1 章插画（分镜中）", status: "running",
      statusLabel: "分镜中", detail: "AI 分镜中…",
    };
    const hit = replaceMessageCard(TITLE, s.id, "r1", 0, preview);
    expect(hit).toBe(true);
    const card = getSession(TITLE, s.id)!.messages[1].cards![0] as { kind?: string; cardId?: string; status?: string; submitLabel?: string };
    expect(card.kind).toBe("preview");
    expect(card.cardId).toBe("media-r1");
    expect(card.status).toBe("running");
    expect(card.submitLabel).toBeUndefined(); // 旧卡字段被整体替换清除
    // 下标越界 / 负数 → false 且不破坏
    const before = JSON.stringify(getSession(TITLE, s.id)!.messages[1].cards);
    expect(replaceMessageCard(TITLE, s.id, "r1", 5, preview)).toBe(false);
    expect(replaceMessageCard(TITLE, s.id, "r1", -1, preview)).toBe(false);
    expect(replaceMessageCard(TITLE, s.id, "nomsg", 0, preview)).toBe(false);
    expect(JSON.stringify(getSession(TITLE, s.id)!.messages[1].cards)).toBe(before);
  });

  test("createProgressMessage：追加带 cardId 的 progress 卡消息（status:running）；updateMessageCard 可翻转", () => {
    const s = createSession(TITLE, "进度卡测试");
    sessionIds.push(s.id);
    const { messageId, cardId } = createProgressMessage(TITLE, s.id, "推进剧情（写一章）");
    expect(messageId).toBeTruthy();
    expect(cardId).toContain("progress-");
    const msg = getSession(TITLE, s.id)!.messages.find((m) => m.id === messageId)!;
    expect(msg.role).toBe("assistant");
    expect(msg.cards).toHaveLength(1);
    const card = msg.cards![0] as { kind?: string; cardId?: string; status?: string; title?: string };
    expect(card.kind).toBe("progress");
    expect(card.cardId).toBe(cardId);
    expect(card.status).toBe("running");
    expect(card.title).toBe("推进剧情（写一章）");
    // 翻转 → done（阶段 3b 完成路径）
    expect(updateMessageCard(TITLE, s.id, messageId, cardId, { status: "done", phase: "result", detail: "第 1 章《风云》已完成" })).toBe(true);
    const flipped = getSession(TITLE, s.id)!.messages.find((m) => m.id === messageId)!;
    expect((flipped.cards![0] as { status?: string; detail?: string }).status).toBe("done");
    expect((flipped.cards![0] as { detail?: string }).detail).toContain("第 1 章");
  });
});

describe("系统事件注入（appendSystemNote）—— 聊天记录同步系统状态的核心", () => {
  const SYS_TITLE = "system-note-test";

  test("注入最近会话：kind=system 消息追加到列表首条（最近更新）", () => {
    const old = createSession(SYS_TITLE, "旧会话");
    const fresh = createSession(SYS_TITLE, "新会话");
    appendMessage(SYS_TITLE, fresh.id, { id: "u1", role: "user", text: "hi", at: Date.now() });
    appendMessage(SYS_TITLE, old.id, { id: "u2", role: "user", text: "hi2", at: Date.now() });

    const targetBefore = listSessions(SYS_TITLE)[0]; // 最近更新（old 后 append → 排最前）
    const injected = appendSystemNote(SYS_TITLE, "evt-auto-ch1", "自动连载已提交第 1 章");
    expect(injected).toBe(true);
    const target = listSessions(SYS_TITLE)[0];
    expect(target.id).toBe(targetBefore.id);
    const last = target.messages[target.messages.length - 1];
    expect(last.kind).toBe("system");
    expect(last.role).toBe("assistant");
    expect(last.text).toContain("【系统】自动连载已提交第 1 章");
    expect(target.systemNotes).toContain("evt-auto-ch1");
    // 非目标会话未注入
    const other = listSessions(SYS_TITLE)[1];
    expect(other.messages.some((m) => m.kind === "system")).toBe(false);
  });

  test("幂等：同 eventId 不重复注入", () => {
    const before = listSessions(SYS_TITLE)[0];
    const beforeSys = before.messages.filter((m) => m.kind === "system").length;
    const first = appendSystemNote(SYS_TITLE, "evt-dup", "连载已开始");
    const again = appendSystemNote(SYS_TITLE, "evt-dup", "连载已开始");
    expect(first).toBe(true);
    expect(again).toBe(false);
    const s = listSessions(SYS_TITLE)[0];
    const sysCount = s.messages.filter((m) => m.kind === "system").length;
    expect(sysCount).toBe(beforeSys + 1); // 首次注入 1 条，重复被拒不追加
  });

  test("无会话 → false（事件不补录，不崩溃）", () => {
    expect(appendSystemNote("no-session-book", "evt-1", "任何事件")).toBe(false);
  });

  test("systemNotes 上限 200：只留最近 200 条事件 id（防文件膨胀）", () => {
    const fresh = createSession(SYS_TITLE, "上限测试");
    for (let i = 0; i < 205; i++) appendSystemNote(SYS_TITLE, `evt-${i}`, `事件 ${i}`);
    const s = getSession(SYS_TITLE, fresh.id)!;
    expect(s.systemNotes?.length).toBe(200);
    expect(s.systemNotes![s.systemNotes!.length - 1]).toBe("evt-204"); // 最新的保留
    expect(s.systemNotes).not.toContain("evt-0"); // 最旧的被丢弃
  });
});
