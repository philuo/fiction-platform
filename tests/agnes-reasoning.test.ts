// readStream：DeepSeek 思考内容（delta.reasoning_content）与正文（delta.content）分离回调。
// 直接构造 SSE Response 传入（不 mock 全局 fetch，避免 bun test 同进程并发污染）。
import { test, expect } from "bun:test";
import { readStream } from "../src/api/agnes";

function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(e));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const mk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;

test("reasoning_content 与 content 分离回调（思考先行，正文随后）", async () => {
  const chunks: string[] = [];
  const reasonings: string[] = [];
  const res = sseResponse([
    mk({ reasoning_content: "思" }),
    mk({ reasoning_content: "考" }),
    mk({ content: "正" }),
    mk({ content: "文" }),
    "data: [DONE]\n\n",
  ]);
  const out = await readStream(res, (d) => chunks.push(d), (d) => reasonings.push(d));
  expect(out).toBe("正文");
  expect(chunks.join("")).toBe("正文");
  expect(reasonings.join("")).toBe("思考");
});

test("无 reasoning 字段（thinking 关闭/普通模型）→ onReasoning 不回调", async () => {
  const chunks: string[] = [];
  const reasonings: string[] = [];
  const res = sseResponse([mk({ content: "答" }), "data: [DONE]\n\n"]);
  const out = await readStream(res, (d) => chunks.push(d), (d) => reasonings.push(d));
  expect(out).toBe("答");
  expect(reasonings).toEqual([]);
});

test("thinking 关闭仍能收到 content（流式正文不受影响）", async () => {
  const chunks: string[] = [];
  const res = sseResponse([mk({ reasoning_content: "内部思考" }), mk({ content: "回复" }), "data: [DONE]\n\n"]);
  const out = await readStream(res, (d) => chunks.push(d));
  expect(out).toBe("回复");
  expect(chunks.join("")).toBe("回复");
});
