// 视频生成服务：Agnes Video V2.0（异步任务 API，当前免费 $0/秒）
// 硬性约束（用户确认）：① 模型固定 agnes-video-v2.0；② 宽高只要 720p 16:9（1280x720）；
// ③ 时长严格 5~15 秒；④ frame_rate 固定 24（文档推荐）
// 流程：createVideoTask 创建任务 → pollVideoTask 轮询 → completed 时 downloadVideo 落盘
// 视频为异步任务；创建走 videoLimiter（企业版默认 1 并发 / 2 RPM），状态查询间歇 429（需容忍，由前端轮询频率控制）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storyDir } from "./storage";
import { videoLimiter } from "./limiter";

const AGNES_VIDEO_BASE = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
// 轮询与创建任务同源：统一以 AGNES_VIDEO_BASE 为前缀（创建走 /videos、轮询走 /agnesapi）；
// 旧版另起 HOST 并剥 /v1，当 BASE 不以 /v1 结尾时会导致创建与轮询 host 不一致
const AGNES_VIDEO_KEY = process.env.AGNES_API_KEY ?? "";
// 模型硬绑定：不允许 env 覆盖（用户强制要求）
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
export const VIDEO_FRAME_RATE = 24; // 文档推荐帧率
export const VIDEO_WIDTH = 1280; // 720p 16:9（用户限定，仅此一种宽高比）
export const VIDEO_HEIGHT = 720;
export const VIDEO_MIN_SECONDS = 5;
export const VIDEO_MAX_SECONDS = 15;
const MIN_NUM_FRAMES = VIDEO_MIN_SECONDS * VIDEO_FRAME_RATE + 1; // 121：5s 下限（8n+1）
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB

/** num_frames 必须 ≤441 且满足 8n+1；另钳制 ≥5s（≥121 @24fps，用户硬性时长下限） */
export function normalizeNumFrames(n: number): number {
  let v = Number.isInteger(n) && n > 0 ? n : MIN_NUM_FRAMES;
  v = Math.min(v, 441);
  // 向下取到最近的 8n+1
  const k = Math.floor((v - 1) / 8);
  v = 8 * k + 1;
  if (v < MIN_NUM_FRAMES) v = MIN_NUM_FRAMES; // 时长下限 5s
  return v;
}

/** 目标秒数（严格钳制 5~15s）→ @24fps 归一到最近合法 8n+1 帧数（5s→121、10s→241、15s→361，均 ≤441） */
export function durationToNumFrames(seconds: number): number {
  const clamped = Math.max(VIDEO_MIN_SECONDS, Math.min(VIDEO_MAX_SECONDS, Math.round(Number.isFinite(seconds) ? seconds : VIDEO_MIN_SECONDS)));
  const raw = clamped * VIDEO_FRAME_RATE;
  const n = 8 * Math.round((raw - 1) / 8) + 1;
  return normalizeNumFrames(n);
}

export type CreateVideoOpts = {
  image?: string; // 图生视频：图片 URL 或 base64 data URI（i2v）
  numFrames?: number;
  frameRate?: number;
  width?: number;
  height?: number;
  negativePrompt?: string;
  /** 外部取消信号：仅取消"创建视频任务"的 HTTP 请求；已拿到 videoId 的远端任务无法中止 */
  signal?: AbortSignal;
};

export type VideoTask = {
  videoId: string;
  taskId: string;
  seconds: string;
  size: string;
};

/** 创建视频任务（不阻塞）。image 存在时走图生视频（ti2vid），否则文生视频 */
export async function createVideoTask(prompt: string, opts: CreateVideoOpts = {}): Promise<VideoTask> {
  const body: Record<string, unknown> = {
    model: AGNES_VIDEO_MODEL,
    prompt,
    num_frames: normalizeNumFrames(opts.numFrames ?? MIN_NUM_FRAMES),
    frame_rate: opts.frameRate ?? VIDEO_FRAME_RATE,
    width: opts.width ?? VIDEO_WIDTH,
    height: opts.height ?? VIDEO_HEIGHT,
  };
  if (opts.image) body.image = opts.image;
  if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;

  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const res = await videoLimiter.run(() =>
    fetch(`${AGNES_VIDEO_BASE}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_VIDEO_KEY}` },
      body: JSON.stringify(body),
      signal,
    }),
  );
  const data = (await res.json().catch(() => null)) as {
    video_id?: string;
    task_id?: string;
    id?: string;
    seconds?: string;
    size?: string;
    error?: { message?: string; code?: number | string };
  } | null;
  if (!res.ok || !data?.video_id) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(`Agnes 视频任务创建失败: ${msg}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return {
    videoId: data.video_id,
    taskId: data.task_id ?? data.id ?? data.video_id,
    seconds: data.seconds ?? "",
    size: data.size ?? "",
  };
}

export type VideoStatus = {
  status: "queued" | "in_progress" | "completed" | "failed" | "rate_limited";
  progress: number;
  url?: string; // completed 时的 mp4 地址（顶层 url，兼容 metadata.url）
  error?: string;
};

/** 轮询视频任务状态。429 限流时返回 status=rate_limited（调用方应继续等待，不视为失败） */
export async function pollVideoTask(videoId: string): Promise<VideoStatus> {
  const res = await fetch(`${AGNES_VIDEO_BASE}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${AGNES_VIDEO_KEY}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 429) {
    return { status: "rate_limited", progress: -1 };
  }
  const data = (await res.json().catch(() => null)) as {
    status?: string;
    progress?: number;
    url?: string;
    metadata?: { url?: string };
    error?: { message?: string } | null;
  } | null;
  if (!res.ok || !data) {
    // 非 429 的 HTTP 错误（500/404 等）或响应解析失败 → 视为失败（而非 rate_limited，避免前端无限轮询）
    return { status: "failed", progress: 0, error: `视频状态查询失败：HTTP ${res.status}` };
  }
  const status = (data.status ?? "in_progress") as VideoStatus["status"];
  return {
    status,
    progress: typeof data.progress === "number" ? data.progress : 0,
    url: data.url ?? data.metadata?.url,
    error: data.error?.message,
  };
}

/** 下载视频字节（限 100MB） */
export async function downloadVideo(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`视频下载失败 HTTP ${res.status}`);
  // 预判：响应头带 Content-Length 且超阈值时，在整包读入内存前直接拒绝
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) {
    throw new Error("视频过大（限 100MB）");
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_VIDEO_BYTES) throw new Error("视频过大（限 100MB）");
  return buf;
}

/** 保存视频到 data/<username>/<slug>/videos/，返回相对路径 videos/<name> */
export function saveVideo(storyTitle: string, name: string, data: Uint8Array): string {
  const base = storyDir(storyTitle);
  const dir = join(base, "videos");
  // 防路径穿越：resolve 后写入路径必须仍在 videos/ 目录内
  const full = join(dir, name);
  const norm = (p: string) => p.replace(/[\\/]+/g, "/");
  if (!norm(full).startsWith(norm(dir) + "/")) throw new Error("非法路径：" + name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, data);
  return `videos/${name}`;
}
