import { describe, expect, test } from "bun:test";
import { applyJsonPatch, createJsonPatch, sha256Json } from "../src/shared/json-patch";

describe("RFC 6902 projection patch", () => {
  test("对象字段递归变更且数组原子替换", async () => {
    const previous = { title: "书", runtime: { running: true, phase: "plan" }, chapters: [{ index: 1, text: "正文" }] };
    const next = { title: "书", runtime: { running: false, error: "中断" }, chapters: [{ index: 1, text: "正文" }] };
    const ops = createJsonPatch(previous, next);
    expect(ops.some((op) => op.path.startsWith("/chapters"))).toBe(false);
    expect(applyJsonPatch(previous, ops)).toEqual(next);
    expect(await sha256Json(applyJsonPatch(previous, ops))).toBe(await sha256Json(next));
  });

  test("JSON Pointer 转义与非法路径失败", () => {
    const previous = { "a/b": { "x~y": 1 } };
    const next = { "a/b": { "x~y": 2 } };
    const ops = createJsonPatch(previous, next);
    expect(ops).toEqual([{ op: "replace", path: "/a~1b/x~0y", value: 2 }]);
    expect(applyJsonPatch(previous, ops)).toEqual(next);
    expect(() => applyJsonPatch(previous, [{ op: "replace", path: "/missing/x", value: 1 }])).toThrow();
  });
});
