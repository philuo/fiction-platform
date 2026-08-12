// 启动恢复 / 取消：recoverRunningMediaCards 卡片收敛、abortSessionTask 幂等。
// 数据根用 BRAIN_SESSIONS_DATA_DIR 覆盖到临时目录，不污染真实 data/。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  abortSessionTask,
  appendMessage,
  createSession,
  getSession,
  recoverRunningMediaCards,
  registerSessionTask,
} from "../src/api/brain-sessions";

const TITLE = "media-recovery-test";
let dataDir = "";

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "media-recovery-"));
  process.env.BRAIN_SESSIONS_DATA_DIR = dataDir;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.BRAIN_SESSIONS_DATA_DIR;
});

type PreviewCard = {
  kind: "preview";
  cardId: string;
  title: string;
  summary: string;
  status: string;
  detail?: string;
  planId?: string;
  mediaIds?: string[];
  scenes?: unknown;
  chapterIndex?: number;
};

function makeSessionWithCard(card: PreviewCard): string {
  const s = createSession(TITLE, "测试会话");
  appendMessage(TITLE, s.id, {
    id: "m1",
    role: "assistant",
    text: "",
    cards: [card as never],
    createdAt: Date.now(),
  });
  return s.id;
}

function getCard(sid: string): PreviewCard {
  const s = getSession(TITLE, sid)!;
  return s.messages.find((m) => m.id === "m1")!.cards![0] as PreviewCard;
}

describe("recoverRunningMediaCards — 重启后 running 卡收敛", () => {
  test("running + planId → failed（分镜纯内存态丢失）", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-plan", title: "生成分镜", summary: "分镜中",
      status: "running", planId: "plan-1",
    });
    const r = recoverRunningMediaCards(TITLE, new Map());
    expect(r.planFailed).toBe(1);
    expect(getCard(sid).status).toBe("failed");
  });

  test("running + mediaIds 全部 ready → done", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-ok", title: "生成插画", summary: "生成中",
      status: "running", mediaIds: ["m-a", "m-b"],
    });
    const r = recoverRunningMediaCards(
      TITLE,
      new Map([["m-a", "ready"], ["m-b", "ready"]]),
    );
    expect(r.mediaDone).toBe(1);
    expect(getCard(sid).status).toBe("done");
  });

  test("running + mediaIds 混合成功失败 → failed 并带计数", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-mix", title: "生成插画", summary: "生成中",
      status: "running", mediaIds: ["m-ok", "m-fail"],
    });
    const r = recoverRunningMediaCards(
      TITLE,
      new Map([["m-ok", "ready"], ["m-fail", "failed"]]),
    );
    expect(r.mediaFailed).toBe(1);
    const c = getCard(sid);
    expect(c.status).toBe("failed");
    expect(c.detail).toContain("1");
  });

  test("running + mediaIds 全失败（含 map 缺失的孤儿）→ failed", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-fail", title: "生成插画", summary: "生成中",
      status: "running", mediaIds: ["m-x", "m-y"],
    });
    const r = recoverRunningMediaCards(TITLE, new Map([["m-x", "failed"]]));
    expect(r.mediaFailed).toBe(1);
    expect(getCard(sid).status).toBe("failed");
  });

  test("running + mediaIds 有 pending → 保留 running（交 WS/一次性核对收敛）", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-pend", title: "生成插画", summary: "生成中",
      status: "running", mediaIds: ["m-p", "m-r"],
    });
    const r = recoverRunningMediaCards(
      TITLE,
      new Map([["m-p", "pending"], ["m-r", "ready"]]),
    );
    expect(r.kept).toBe(1);
    expect(getCard(sid).status).toBe("running");
  });

  test("running 无 planId/mediaIds/scenes → stuck failed", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-stuck", title: "生成", summary: "处理中",
      status: "running",
    });
    const r = recoverRunningMediaCards(TITLE, new Map());
    expect(r.stuckFailed).toBe(1);
    expect(getCard(sid).status).toBe("failed");
  });

  test("running 卡带 scenes（倒计时卡）→ 保留 running，不误伤", () => {
    const sid = makeSessionWithCard({
      kind: "preview", cardId: "card-countdown", title: "生成", summary: "处理中",
      status: "running", scenes: [{ anchor: "a", scene: "s" }],
    });
    recoverRunningMediaCards(TITLE, new Map());
    expect(getCard(sid).status).toBe("running");
  });

  test("幂等：对已终态卡重复跑不再翻转/计数", () => {
    makeSessionWithCard({
      kind: "preview", cardId: "card-idem", title: "生成插画", summary: "生成中",
      status: "running", mediaIds: ["m-i"],
    });
    recoverRunningMediaCards(TITLE, new Map([["m-i", "ready"]]));
    const r2 = recoverRunningMediaCards(TITLE, new Map([["m-i", "ready"]]));
    expect(r2.mediaDone).toBe(0); // 已 done，不再被扫描到
    expect(r2.planFailed).toBe(0);
    expect(r2.mediaFailed).toBe(0);
    expect(r2.stuckFailed).toBe(0);
  });
});

describe("abortSessionTask", () => {
  test("注册任务后 abort 置任务自身 controller aborted；重复调用幂等不抛错，无任务返回 false", () => {
    const s = createSession(TITLE, "abort 测试");
    const task = registerSessionTask(TITLE, s.id, () => {});
    expect(task.abort.signal.aborted).toBe(false);
    expect(abortSessionTask(TITLE, s.id)).toBe(true);
    expect(task.abort.signal.aborted).toBe(true);
    // 已 abort：幂等（不抛错、不再二次 abort），任务仍存在 → 返回 true
    expect(abortSessionTask(TITLE, s.id)).toBe(true);
    expect(task.abort.signal.aborted).toBe(true);
    // 不存在的会话
    expect(abortSessionTask(TITLE, "no-such-session")).toBe(false);
  });
});
