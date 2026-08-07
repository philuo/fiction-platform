// pollVideoTask 错误分类验证：429→rate_limited / 500→failed / 非 JSON→failed / completed / in_progress
import { describe, expect, test, afterEach } from "bun:test";
import { pollVideoTask } from "../src/api/videos";

describe("pollVideoTask 错误分类", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("429 → rate_limited（前端继续轮询）", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 429 }))) as typeof fetch;
    const st = await pollVideoTask("vid-1");
    expect(st.status).toBe("rate_limited");
    expect(st.progress).toBe(-1);
  });

  test("500 → failed（不再无限轮询）", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 500 }))) as typeof fetch;
    const st = await pollVideoTask("vid-2");
    expect(st.status).toBe("failed");
    expect(st.error).toContain("500");
  });

  test("非 JSON 响应 → failed", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch;
    const st = await pollVideoTask("vid-3");
    expect(st.status).toBe("failed");
  });

  test("completed + url → completed", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "completed", progress: 100, url: "https://example.com/v.mp4" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const st = await pollVideoTask("vid-4");
    expect(st.status).toBe("completed");
    expect(st.url).toBe("https://example.com/v.mp4");
  });

  test("in_progress → in_progress", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "in_progress", progress: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const st = await pollVideoTask("vid-5");
    expect(st.status).toBe("in_progress");
    expect(st.progress).toBe(42);
  });
});
