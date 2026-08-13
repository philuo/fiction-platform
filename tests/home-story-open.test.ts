import { describe, expect, test } from "bun:test";
import { storyExistsForOpen } from "../src/pages/Home";

describe("Home story navigation", () => {
  test("ready/done library frame remains authoritative when external store and React fallback are stale", () => {
    const triggeringFrame = { stories: [{ title: "雨夜验尸簿" }] };

    expect(storyExistsForOpen("雨夜验尸簿", triggeringFrame, null, [])).toBe(true);
    expect(storyExistsForOpen("雨夜验尸簿", triggeringFrame, { stories: [] }, [])).toBe(true);
  });

  test("unknown story is rejected when no authoritative source contains it", () => {
    expect(storyExistsForOpen("不存在", undefined, { stories: [{ title: "已有故事" }] }, [])).toBe(false);
  });
});
