// 图像生成服务：强制 Agnes 云端生图（agnes-image-2.1-flash，当前免费）
// 硬性约束（用户确认）：① 模型固定 agnes-image-2.1-flash；② 尺寸严格 1K 档位；
// ③ 图生图/多图合成经 extra_body.image 传参考图（Data URI 或 URL）——用于角色形象一致性。
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "./storage";
import { imageLimiter } from "./limiter";

const AGNES_IMAGE_BASE = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const AGNES_IMAGE_KEY = process.env.AGNES_API_KEY ?? "";
// 模型硬绑定：不允许 env 覆盖（用户强制要求）
const AGNES_IMAGE_MODEL = "agnes-image-2.1-flash";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 与上传一致：10MB

/** 项目尺寸 "WxH" → Agnes 档位 + 宽高比。硬性约束：size 恒为 1K（用户限定），仅映射 ratio */
export function toAgnesSize(size: string): { size: string; ratio: string } {
  const [w, h] = size.split("x").map(Number);
  const width = Number.isInteger(w) && w > 0 ? w : 768;
  const height = Number.isInteger(h) && h > 0 ? h : 768;
  const landscape = width >= height;
  const r = Math.max(width, height) / Math.min(width, height);
  let ratio = "1:1";
  if (r >= 1.7) ratio = landscape ? "16:9" : "9:16";
  else if (r >= 1.25) ratio = landscape ? "3:2" : "2:3";
  else if (r > 1.1) ratio = landscape ? "4:3" : "3:4";
  return { size: "1K", ratio }; // 严格 1K：不开放 2K/3K/4K
}

export type AgnesImageOpts = {
  /** 参考图数组（URL 或 Data URI）：传入即走图生图/多图合成（extra_body.image） */
  images?: string[];
};

/** 调用 Agnes 云端生图。opts.images 非空 → 图生图（extra_body.image）；输出统一 b64_json 直出字节 */
export async function generateImageAgnes(prompt: string, size = "768x768", opts: AgnesImageOpts = {}): Promise<Uint8Array> {
  const { size: gSize, ratio } = toAgnesSize(size);
  const extraBody: Record<string, unknown> = { response_format: "b64_json" };
  if (opts.images?.length) extraBody.image = opts.images; // 图生图/多图合成（文档：extra_body.image）
  const res = await imageLimiter.run(() =>
    fetch(`${AGNES_IMAGE_BASE}/images/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_IMAGE_KEY}` },
      body: JSON.stringify({
        model: AGNES_IMAGE_MODEL,
        prompt,
        size: gSize,
        ratio,
        extra_body: extraBody,
      }),
      signal: AbortSignal.timeout(150_000), // 生图上限 150s：Agnes 正常 30-90s，超过即快速失败，避免前端干等 6 分钟
    }),
  );
  const data = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string | null }[];
    error?: { message?: string };
  } | null;
  if (!res.ok || !data?.data?.[0]?.b64_json) {
    const err = new Error(`Agnes 生图失败 HTTP ${res.status}: ${data?.error?.message ?? "响应无 b64_json"}`) as Error & { status?: number };
    err.status = res.status; // 供上层 429 重试/路由识别
    throw err;
  }
  const buf = Buffer.from(data.data[0].b64_json, "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("图像过大（限 10MB）");
  return new Uint8Array(buf);
}

/** 入口：强制 Agnes 云端生图（无本地回退——用户强制 agnes-image-2.1-flash），失败直接抛错由路由层处理 */
export async function generateImage(prompt: string, size = "768x768", opts: AgnesImageOpts = {}): Promise<Uint8Array> {
  return generateImageAgnes(prompt, size, opts);
}

/**
 * 图像压缩为 JPEG（体积小巧）：等比缩放到目标宽高 + quality 质量压缩（Bun 内置图像处理，无需额外依赖）。
 * 用于立绘/头像落盘（PNG 可能数 MB，JPEG 压缩后立绘 ~150KB、头像 ~50KB）。
 * 说明：生成图按目标比例生成（立绘 16:9、头像 1:1），此处仅等比缩小，无需裁切。
 */
export async function compressToJpeg(buf: Uint8Array, width: number, height: number, quality = 82): Promise<Uint8Array> {
  return new Uint8Array(await new Bun.Image(buf).resize(width, height).jpeg({ quality }).toBuffer());
}

/** 保存图像到 data/<story>/images/，返回相对路径 */
export function saveImage(storyTitle: string, name: string, data: Uint8Array): string {
  const dir = join(process.cwd(), "data", slugify(storyTitle), "images");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  return `images/${name}`;
}

/** 读取图像（防路径穿越：只能读 data/<story>/ 内；目录/非文件返回 null） */
export function readImage(storyTitle: string, rel: string): Uint8Array | null {
  const base = join(process.cwd(), "data", slugify(storyTitle));
  const full = join(base, rel);
  if (!full.startsWith(base + "/") && full !== base) return null;
  try {
    if (!statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return new Uint8Array(readFileSync(full));
}

/** 删除媒体文件（与 readImage 同款路径穿越守卫：仅 data/<story>/ 内；不存在/非文件静默跳过） */
export function deleteMediaFile(storyTitle: string, rel: string): boolean {
  const base = join(process.cwd(), "data", slugify(storyTitle));
  const full = join(base, rel);
  if (!full.startsWith(base + "/") || full === base) return false;
  try {
    if (!statSync(full).isFile()) return false;
    rmSync(full);
    return true;
  } catch {
    return false;
  }
}
