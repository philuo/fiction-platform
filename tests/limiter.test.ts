// 全局限流器单测：bun test tests/limiter.test.ts
// 覆盖：并发信号量上限、RPM 滑动窗口排队、返回值/异常透传与槽位释放
import { test, expect } from "bun:test";
import { RateLimiter } from "../src/api/limiter";

test("并发上限：超过 concurrency 的任务排队，任一时刻在飞数不超过上限", async () => {
  const lim = new RateLimiter(2, 100, "test"); // 并发 2，RPM 100（不触顶）
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(30);
    active--;
  };
  await Promise.all(Array.from({ length: 6 }, () => lim.run(task)));
  expect(maxActive).toBe(2);
});

test("RPM 滑动窗口：超 rpm 的请求排队到窗口滑出后才发起", async () => {
  const lim = new RateLimiter(5, 2, "test", 200); // 200ms 窗口，rpm 2，并发 5
  const t0 = Date.now();
  const times: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, () => lim.run(async () => { times.push(Date.now() - t0); })),
  );
  times.sort((a, b) => a - b);
  // 前 2 个立即发起（< 100ms），后 2 个等窗口滑出（≥ 150ms）
  expect(times[0]).toBeLessThan(100);
  expect(times[1]).toBeLessThan(100);
  expect(times[2]).toBeGreaterThanOrEqual(150);
  expect(times[3]).toBeGreaterThanOrEqual(150);
});

test("run 透传返回值与异常，且槽位必释放（异常后下一个仍能立即跑）", async () => {
  const lim = new RateLimiter(1, 100, "test"); // 并发 1
  expect(await lim.run(async () => 42)).toBe(42);
  await expect(lim.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  // 槽位已释放：下一个任务立即返回，不阻塞
  expect(await lim.run(async () => "ok")).toBe("ok");
});

test("并发 1 串行化：任务按 FIFO 顺序执行，无重叠", async () => {
  const lim = new RateLimiter(1, 100, "test");
  const order: string[] = [];
  let active = 0;
  let overlap = false;
  const task = async (id: string) => {
    active++;
    if (active > 1) overlap = true;
    order.push(`${id}-start`);
    await Bun.sleep(20);
    order.push(`${id}-end`);
    active--;
  };
  await Promise.all(["a", "b", "c"].map((id) => lim.run(() => task(id))));
  expect(overlap).toBe(false);
  // 每个任务的 start 紧跟自己的 end（无交错）
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end", "c-start", "c-end"]);
});
