import { describe, expect, test } from "bun:test";
import { storyExistsForOpen, trackedNewStoryTask } from "../src/pages/Home";

describe("Home story navigation", () => {
  test("ready/done library frame remains authoritative when external store and React fallback are stale", () => {
    const triggeringFrame = { stories: [{ title: "雨夜验尸簿" }] };

    expect(storyExistsForOpen("雨夜验尸簿", triggeringFrame, null, [])).toBe(true);
    expect(storyExistsForOpen("雨夜验尸簿", triggeringFrame, { stories: [] }, [])).toBe(true);
  });

  test("unknown story is rejected when no authoritative source contains it", () => {
    expect(storyExistsForOpen("不存在", undefined, { stories: [{ title: "已有故事" }] }, [])).toBe(false);
  });

  test("ready 导航清空提交 ref 后仍按页面 task id 消费 done 终态", () => {
    const done = { id: "task-ready-opened", status: "done", title: "雾港电台" };

    expect(trackedNewStoryTask([done], null, "task-ready-opened")).toEqual(done);
    expect(trackedNewStoryTask([done], null, null)).toBeUndefined();
  });
});
