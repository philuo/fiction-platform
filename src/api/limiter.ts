// 全局速率/并发限制器：滑动窗口 RPM + 异步信号量并发。进程内单例。
// 三类模型各自独立限流池：文本（TEXT_MODEL 可配，默认 agnes-2.5-flash）、图片(agnes-image-2.5-flash 1K 档)、视频(agnes-video-2.5-flash)。
// 限流器是「排队」语义：超 RPM/并发时 await 排队，不主动触发 429--服务端看到的发起速率 ≤ 上限。
// 企业认证默认值（实际 RPM：文本/图片 1K 各 40、视频 2）；env 可覆盖。docs: https://www.agnes-ai.cn/zh-Hans/docs/tokenplan

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : def;
}

/**
 * 单池限流器：并发信号量 + RPM 滑动窗口。
 * run(fn)：先占并发槽 -> 再占 RPM 槽 -> 执行 fn -> 释放并发槽（RPM 槽 windowMs 后自动滑出）。
 * RPM 槽在拿到后才计入窗口，避免「占了 RPM 却在等并发」导致额度空耗。
 */
export class RateLimiter {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly rpmWindow: number[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly rpm: number,
    readonly name = "limiter",
    private readonly windowMs = 60_000,
  ) {}

  /** 并发信号量：超并发时排队等待（FIFO） */
  private acquireSem(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private releaseSem(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next(); // 唤醒队首等待者（其回调内 inFlight++ 重新占槽）
  }

  /** RPM 滑动窗口：最近 windowMs 内发起数 < rpm 时放行并计入，否则等到最早一次滑出窗口 */
  private async acquireRpm(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.rpmWindow.length && now - this.rpmWindow[0] >= this.windowMs) this.rpmWindow.shift();
      if (this.rpmWindow.length < this.rpm) {
        this.rpmWindow.push(now);
        return;
      }
      await Bun.sleep(this.windowMs - (now - this.rpmWindow[0]) + 20);
    }
  }

  /** 在限流内执行 fn：返回值/异常原样透传，finally 必释放并发槽 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSem();
    try {
      await this.acquireRpm();
      return await fn();
    } finally {
      this.releaseSem();
    }
  }
}

// 三个全局限流器（企业认证默认值；env 可覆盖）
// 设计决策：**全局共享而非按用户隔离**（多用户部署下共享企业配额；单个用户跑满自动连载时
// 其他用户需排队等待 LLM 额度，但数据绝不串扰）。若需按用户独立配额可改为 per-user 池。
export const textLimiter = new RateLimiter(envInt("AGNES_TEXT_CONCURRENCY", 5), envInt("AGNES_TEXT_RPM", 40), "text");
export const imageLimiter = new RateLimiter(envInt("AGNES_IMAGE_CONCURRENCY", 5), envInt("AGNES_IMAGE_RPM", 40), "image");
export const videoLimiter = new RateLimiter(envInt("AGNES_VIDEO_CONCURRENCY", 1), envInt("AGNES_VIDEO_RPM", 2), "video");
