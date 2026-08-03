// 视频生成服务：Agnes Video V2.0（异步任务 API，当前免费 $0/秒）
// 流程：createVideoTask 创建任务 → pollVideoTask 轮询 → completed 时 downloadVideo 落盘
// 与生图不同：视频为异步任务，且创建限流 1 次/分钟、状态查询间歇 429（需容忍）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./storage";

const AGNES_VIDEO_BASE = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const AGNES_VIDEO_HOST = AGNES_VIDEO_BASE.replace(/\/v1$/, ""); // https://api.agnes-ai.cn
const AGNES_VIDEO_KEY = process.env.AGNES_API_KEY ?? "";
const AGNES_VIDEO_MODEL = process.env.AGNES_VIDEO_MODEL ?? "agnes-video-v2.0";
const DEFAULT_NUM_FRAMES = Number(process.env.VIDEO_NUM_FRAMES ?? 121); // ≈5s @24fps
const DEFAULT_FRAME_RATE = Number(process.env.VIDEO_FRAME_RATE ?? 24);
const DEFAULT_WIDTH = 1152;
const DEFAULT_HEIGHT = 768;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB

/** num_frames 必须 ≤441 且满足 8n+1；不合法时归一到最近的合法值 */
export function normalizeNumFrames(n: number): number {
  let v = Number.isInteger(n) && n > 0 ? n : DEFAULT_NUM_FRAMES;
  v = Math.min(v, 441);
  // 向下取到最近的 8n+1
  const k = Math.floor((v - 1) / 8);
  v = 8 * k + 1;
  if (v < 9) v = 9; // 最小合法值
  return v;
}

export type CreateVideoOpts = {
  image?: string; // 图生视频：图片 URL 或 base64 data URI（i2v）
  numFrames?: number;
  frameRate?: number;
  width?: number;
  height?: number;
  negativePrompt?: string;
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
    num_frames: normalizeNumFrames(opts.numFrames ?? DEFAULT_NUM_FRAMES),
    frame_rate: opts.frameRate ?? DEFAULT_FRAME_RATE,
    width: opts.width ?? DEFAULT_WIDTH,
    height: opts.height ?? DEFAULT_HEIGHT,
  };
  if (opts.image) body.image = opts.image;
  if (opts.negativePrompt) body.negative_prompt = opts.negativePrompt;

  const res = await fetch(`${AGNES_VIDEO_BASE}/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_VIDEO_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
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
  const res = await fetch(`${AGNES_VIDEO_HOST}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
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
    return { status: "rate_limited", progress: -1 };
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
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_VIDEO_BYTES) throw new Error("视频过大（限 100MB）");
  return buf;
}

/** 保存视频到 data/<story>/videos/，返回相对路径 videos/<name> */
export function saveVideo(storyTitle: string, name: string, data: Uint8Array): string {
  const dir = join(process.cwd(), "data", slugify(storyTitle), "videos");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  return `videos/${name}`;
}

/** 关键情节视频 prompt：[主体]+[动作]+[场景]+[镜头]+[光线]+[风格] */
export function buildVideoPrompt(input: {
  title: string;
  chapterTitle: string;
  chapterText: string;
  tone: string;
  userPrompt?: string;
}): string {
  if (input.userPrompt?.trim()) return input.userPrompt.trim();
  const snippet = input.chapterText.replace(/\s+/g, " ").trim().slice(0, 100);
  return [
    `cinematic scene from "${input.title}", chapter "${input.chapterTitle}"`,
    snippet,
    `${input.tone || "dramatic"} atmosphere`,
    "slow cinematic camera movement",
    "dramatic lighting",
    "high quality, detailed, no text, no watermark",
  ].join(", ");
}
