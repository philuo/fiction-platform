// 图像生成服务：Agnes 云端生图（默认，agnes-image-2.1-flash，当前免费）+ 本地 mflux 自动回退
// 配置：IMAGE_PROVIDER（agnes/mflux，默认 agnes）；IMAGE_STEPS/IMAGE_QUANT 仅在 mflux 回退时使用
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { slugify } from "./storage";

const AGNES_IMAGE_BASE = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const AGNES_IMAGE_KEY = process.env.AGNES_API_KEY ?? "";
const AGNES_IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL ?? "agnes-image-2.1-flash";
const IMAGE_PROVIDER = process.env.IMAGE_PROVIDER ?? "agnes";
const STEPS = Number(process.env.IMAGE_STEPS ?? 8);
const QUANT = Number(process.env.IMAGE_QUANT ?? 8);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 与上传一致：10MB

/** 项目尺寸 "WxH" → Agnes 档位 + 宽高比（1K 档即可满足 UI 展示，最大 10MB 限制内） */
function toAgnesSize(size: string): { size: string; ratio: string } {
  const [w, h] = size.split("x").map(Number);
  const width = Number.isInteger(w) && w > 0 ? w : 768;
  const height = Number.isInteger(h) && h > 0 ? h : 768;
  const landscape = width >= height;
  const r = Math.max(width, height) / Math.min(width, height);
  let ratio = "1:1";
  if (r >= 1.7) ratio = landscape ? "16:9" : "9:16";
  else if (r >= 1.25) ratio = landscape ? "3:2" : "2:3";
  else if (r > 1.1) ratio = landscape ? "4:3" : "3:4";
  return { size: "1K", ratio };
}

/** 调用 Agnes 云端生图（extra_body.response_format=b64_json 直出字节，图生图需在 extra_body.image 传参考图） */
async function generateImageAgnes(prompt: string, size = "768x768"): Promise<Uint8Array> {
  const { size: gSize, ratio } = toAgnesSize(size);
  const res = await fetch(`${AGNES_IMAGE_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGNES_IMAGE_KEY}` },
    body: JSON.stringify({
      model: AGNES_IMAGE_MODEL,
      prompt,
      size: gSize,
      ratio,
      extra_body: { response_format: "b64_json" },
    }),
    signal: AbortSignal.timeout(360_000),
  });
  const data = (await res.json().catch(() => null)) as {
    data?: { b64_json?: string | null }[];
    error?: { message?: string };
  } | null;
  if (!res.ok || !data?.data?.[0]?.b64_json) {
    throw new Error(`Agnes 生图失败 HTTP ${res.status}: ${data?.error?.message ?? "响应无 b64_json"}`);
  }
  const buf = Buffer.from(data.data[0].b64_json, "base64");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("图像过大（限 10MB）");
  return new Uint8Array(buf);
}

/** 调用本地 mflux 生成图像（HF 镜像无需代理） */
async function generateImageLocal(prompt: string, size = "768x768"): Promise<Uint8Array> {
  const [w, h] = size.split("x").map(Number);
  const width = Number.isInteger(w) && w > 0 ? w : 768;
  const height = Number.isInteger(h) && h > 0 ? h : 768;
  const outDir = mkdtempSync(join(tmpdir(), "ai-novel-img-"));
  try {
    const outFile = join(outDir, "out.png");
    const r = spawnSync(
      "mflux-generate-z-image-turbo",
      [
        "--prompt", prompt,
        "--width", String(width),
        "--height", String(height),
        "--seed", "42",
        "--steps", String(STEPS),
        "-q", String(QUANT),
        "--output", outFile,
      ],
      {
        env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com", HF_HUB_DISABLE_XET: "1" },
        timeout: 600_000,
        encoding: "utf-8",
      },
    );
    if (r.status !== 0) {
      const err = String(r.stderr || r.stdout || r.error?.message || "未知错误").slice(0, 300);
      throw new Error(`mflux 生成失败: ${err}`);
    }
    // 输出文件缺失：友好错误而非裸 ENOENT
    try {
      if (!statSync(outFile).isFile()) throw new Error("mflux 未生成输出文件");
    } catch (e) {
      if ((e as Error).message === "mflux 未生成输出文件") throw e;
      throw new Error("mflux 未生成输出文件（命令退出但无产物）");
    }
    const buf = readFileSync(outFile);
    if (buf.length > MAX_IMAGE_BYTES) throw new Error("图像过大（限 10MB）");
    return new Uint8Array(buf);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** 入口：默认 Agnes 云端生图，失败自动回退本地 mflux；IMAGE_PROVIDER=mflux 时直接用本地 */
export async function generateImage(prompt: string, size = "768x768"): Promise<Uint8Array> {
  if (IMAGE_PROVIDER !== "mflux") {
    try {
      return await generateImageAgnes(prompt, size);
    } catch (e) {
      console.warn("[images] Agnes 云端生图失败，回退本地 mflux:", (e as Error).message);
    }
  }
  return generateImageLocal(prompt, size);
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
