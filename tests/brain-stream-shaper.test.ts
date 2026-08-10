import { test, expect } from "bun:test";
import { createStreamShaper } from "../src/api/brain-chat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("巨块同步连发：按 tickMs 节奏逐片输出，总量完整", async () => {
  const out: { t: number; text: string }[] = [];
  const t0 = Date.now();
  const shaper = createStreamShaper((text) => out.push({ t: Date.now() - t0, text }));
  // 模拟上游一次性吐 100 字符（同步连发）→ 25 片，全部由 timer 播完（24*30=720ms）
  shaper.push("中".repeat(100));
  await sleep(1000);
  shaper.drain(); // 兜底 flush（应已无剩余）
  const joined = out.map((o) => o.text).join("");
  expect(joined).toBe("中".repeat(100)); // 数据完整无丢失
  expect(out.length).toBe(25); // 恰好 25 片（非一次性）
  // 间隔均匀：除首片（立即发）外，相邻间隔 ≈ tickMs(30)
  const gaps = out.slice(1).map((o, i) => o.t - out[i].t);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  expect(Math.abs(avg - 30)).toBeLessThan(12);
  expect(Math.max(...gaps)).toBeLessThan(45); // 无异常长间隔
});

test("慢速上游：每片立即转发，不人为延迟", async () => {
  const out: { t: number; text: string }[] = [];
  const t0 = Date.now();
  const shaper = createStreamShaper((text) => out.push({ t: Date.now() - t0, text }));
  // 模拟上游真流式：每 60ms 到 1 片（间隔 > tickMs）
  shaper.push("甲");
  await sleep(60);
  shaper.push("乙");
  await sleep(60);
  shaper.push("丙");
  shaper.drain();
  expect(out.map((o) => o.text).join("")).toBe("甲乙丙");
  // 每片到达即转发（间隔 ≈ 上游节奏，无额外 30ms 延迟累积）
  expect(out.length).toBe(3);
  expect(out[1].t).toBeGreaterThan(50); // 第二片在 ~60ms 到达，未被拖延到 90ms+
  expect(out[1].t).toBeLessThan(75);
});

test("小块立即发 + 后续等节奏：混合节奏不丢字", async () => {
  const out: string[] = [];
  const shaper = createStreamShaper((text) => out.push(text));
  shaper.push("abc"); // 首片立即发（3 字符 < 4）
  shaper.push("defg");
  shaper.push("hijkl");
  await sleep(120);
  shaper.drain();
  expect(out.join("")).toBe("abcdefghijkl");
});

test("空 push 与 drain 安全", () => {
  const out: string[] = [];
  const shaper = createStreamShaper((text) => out.push(text));
  shaper.push("");
  shaper.drain();
  expect(out).toEqual([]);
});
