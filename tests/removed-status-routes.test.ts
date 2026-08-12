import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleApi, handleNovelApi } from "../src/api/routes";

const removed = [
  "/api/novel/list",
  "/api/novel/new/status",
  "/api/novel/step/status",
  "/api/novel/step/clear",
  "/api/novel/auto/status",
  "/api/novel/media/plan-status",
  "/api/novel/media/status",
  "/api/novel/media/status-batch",
  "/api/novel/state",
  "/api/novel/visual/status",
];

describe("状态查询接口已移除", () => {
  for (const pathname of removed) {
    test(`${pathname} 返回 404`, async () => {
      const res = await handleNovelApi(pathname, new Request(`http://x${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }));
      expect(res?.status).toBe(404);
    });
  }

  test("前端源码不再引用状态查询路径", () => {
    const files = ["src/pages/Home.tsx", "src/components/BrainCabin.tsx", "src/components/useBrainSession.ts"];
    const source = files.map((f) => readFileSync(join(process.cwd(), f), "utf-8")).join("\n");
    for (const pathname of [...removed, "/api/brain/context"]) expect(source).not.toContain(pathname);
  });

  test("/api/brain/context 返回 404", async () => {
    const res = await handleApi("/api/brain/context", new Request("http://x/api/brain/context", { method: "POST", body: "{}" }));
    expect(res?.status).toBe(404);
  });
});
