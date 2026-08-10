// agnes 重试策略回归：ECONNRESET 等网络瞬时错误必须重试（修立项一次网络抖动即失败——retries 配置此前形同虚设）；
// AbortError（外部取消）不重试；非重试错误直接抛、不浪费配额。
// 注：不 mock 全局 fetch（bun test 默认同进程并发跑文件，全局 fetch 会被其他测试文件覆盖，
// 导致集成测试不稳定）——改为直测 isRetryableError 判定 + withSmartRetry 重试接线。
import { test, expect, describe } from "bun:test";
import { isRetryableError, LLMError, withSmartRetry } from "../src/api/agnes";

/** 构造 fetch 底层网络错误（TypeError + code），模拟 Bun fetch 对 socket 断开抛出的错误形态 */
function netErr(code: string, msg = "fetch failed"): TypeError {
  const e = new TypeError(msg);
  (e as unknown as { code: string }).code = code;
  return e;
}

describe("isRetryableError", () => {
  test("ECONNRESET（用户报错同款 message+code）→ 可重试", () => {
    const e = netErr("ECONNRESET", "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
    expect(isRetryableError(e)).toBe(true);
  });

  test("cause 链内带网络错误码 → 可重试", () => {
    const e = new TypeError("fetch failed");
    (e as unknown as { cause: unknown }).cause = netErr("ECONNREFUSED");
    expect(isRetryableError(e)).toBe(true);
  });

  test("消息含 socket connection was closed / terminated → 可重试", () => {
    expect(isRetryableError(new Error("The socket connection was closed unexpectedly"))).toBe(true);
    expect(isRetryableError(new Error("terminated"))).toBe(true);
  });

  test("HTTP 429 / 503 / 空内容 → 可重试", () => {
    expect(isRetryableError(new LLMError("HTTP 429: rate limited"))).toBe(true);
    expect(isRetryableError(new LLMError("HTTP 503: busy"))).toBe(true);
    expect(isRetryableError(new LLMError("AI 服务暂时无输出（HTTP 200 空内容，免费渠道繁忙），正在重试"))).toBe(true);
  });

  test("AbortError（外部取消）→ 不重试", () => {
    expect(isRetryableError(new DOMException("aborted", "AbortError"))).toBe(false);
  });

  test("普通错误 → 不重试", () => {
    expect(isRetryableError(new Error("unexpected bug"))).toBe(false);
  });
});

describe("withSmartRetry 重试接线", () => {
  test("ECONNRESET → 退避后重试成功（共调用 2 次，返回成功值）", async () => {
    let calls = 0;
    const out = await withSmartRetry(
      async () => {
        calls++;
        if (calls === 1) throw netErr("ECONNRESET", "The socket connection was closed unexpectedly");
        return "ok";
      },
      {},
      3,
    );
    expect(out).toBe("ok");
    expect(calls).toBe(2); // 失败 1 次 + 成功 1 次（此前 ECONNRESET 直接抛，1 次就失败）
  });

  test("AbortError → 不重试直接抛（仅 1 次调用）", async () => {
    let calls = 0;
    await expect(
      withSmartRetry(
        async () => {
          calls++;
          throw new DOMException("aborted", "AbortError");
        },
        {},
        3,
      ),
    ).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  test("非重试错误 → 不重试直接抛（仅 1 次调用，不浪费配额）", async () => {
    let calls = 0;
    await expect(
      withSmartRetry(
        async () => {
          calls++;
          throw new Error("unexpected bug");
        },
        {},
        3,
      ),
    ).rejects.toThrow("unexpected bug");
    expect(calls).toBe(1);
  });

  test("重试次数耗尽 → 抛最后一次错误", async () => {
    await expect(
      withSmartRetry(
        async () => {
          throw netErr("ECONNRESET");
        },
        {},
        2, // 最多 2 次尝试（退避 1s，避免超时）
      ),
    ).rejects.toThrow("fetch failed"); // message 为 fetch failed（code=ECONNRESET 在属性上）
  });
});
