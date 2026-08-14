import { describe, expect, test } from "bun:test";
import { mediaPlanFromTask, pendingMediaPlanFromTask, type PendingMediaPlan } from "../src/pages/Home";

describe("Home async media planning", () => {
  const pending: PendingMediaPlan = { id: "plan-1", kind: "image", chapterIndex: 2 };

  test("opens the confirmation plan only from the matching authoritative ready frame", () => {
    const scenes = [{ anchor: "锚点", scene: "雨夜停尸房" }];
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "ready", scenes })).toEqual({
      id: "plan-1", kind: "image", chapterIndex: 2, scenes,
    });
  });

  test("restores running and ready direct-Home plans from a full snapshot after refresh", () => {
    const running = {
      id: "plan-refresh", status: "running", chapterIndex: 3, mediaKind: "video" as const,
      awaitingConfirmation: true,
    };
    expect(pendingMediaPlanFromTask(running)).toEqual({ id: "plan-refresh", kind: "video", chapterIndex: 3 });

    const scenes = [{ anchor: "锚点", scene: "雾港桥墩" }];
    expect(mediaPlanFromTask(null, { ...running, status: "ready", scenes })).toEqual({
      id: "plan-refresh", kind: "video", chapterIndex: 3, scenes,
    });
  });

  test("does not reopen consumed, historical, session-owned, or malformed plans", () => {
    const scenes = [{ anchor: "a", scene: "b" }];
    expect(mediaPlanFromTask(null, { id: "consumed", status: "ready", scenes, chapterIndex: 1, mediaKind: "image", awaitingConfirmation: false })).toBeNull();
    expect(mediaPlanFromTask(null, { id: "legacy", status: "ready", scenes, chapterIndex: 1, mediaKind: "image" })).toBeNull();
    expect(pendingMediaPlanFromTask({ id: "session", status: "running", chapterIndex: 1, mediaKind: "image", awaitingConfirmation: false })).toBeNull();
    expect(pendingMediaPlanFromTask({ id: "bad", status: "running", chapterIndex: 0, mediaKind: "image", awaitingConfirmation: true })).toBeNull();
  });

  test("ignores pending, failed, unrelated, and empty ready frames", () => {
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "running" })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "failed" })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-2", status: "ready", scenes: [{ anchor: "a", scene: "b" }] })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "ready", scenes: [] })).toBeNull();
  });
});
