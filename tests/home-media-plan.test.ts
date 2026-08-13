import { describe, expect, test } from "bun:test";
import { mediaPlanFromTask, type PendingMediaPlan } from "../src/pages/Home";

describe("Home async media planning", () => {
  const pending: PendingMediaPlan = { id: "plan-1", kind: "image", chapterIndex: 2 };

  test("opens the confirmation plan only from the matching authoritative ready frame", () => {
    const scenes = [{ anchor: "锚点", scene: "雨夜停尸房" }];
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "ready", scenes })).toEqual({
      kind: "image", chapterIndex: 2, scenes,
    });
  });

  test("ignores pending, failed, unrelated, and empty ready frames", () => {
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "running" })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "failed" })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-2", status: "ready", scenes: [{ anchor: "a", scene: "b" }] })).toBeNull();
    expect(mediaPlanFromTask(pending, { id: "plan-1", status: "ready", scenes: [] })).toBeNull();
  });
});
