// 段落锚定媒体：LLM 从全章挑选关键段落并提炼电影化场景描述（planScenes），
// 再用 scene 作为 prompt 生成插画（generateSceneImage）或视频（createSceneVideo，时长 5~15s）。
import { chatJson } from "./jsonutil";
import { generateImage, saveImage } from "./images";
import { createVideoTask } from "./videos";
import type { ChapterMedia, WorldState } from "./world";

/** 归一化：去空白与「」『』引号（与 ChapterView 引用匹配保持一致），用于 anchor 定位 */
export const normAnchor = (s: string): string => s.replace(/[\s「」『』]/g, "");

export type ScenePlan = { anchor: string; scene: string };

const PLAN_SYSTEM = `你是小说的"分镜师"。给定一节正文，从中挑选出最具画面感的关键段落，并为每个段落写一句用于 AI 生图/生视频的电影化场景描述。
要求：
- anchor 必须是正文中某个段落的连续原文片段（直接摘抄，不要改写、不要加引号），用于定位该段落，长度 12~40 字为宜。
- scene 用英文撰写，遵循结构：[主体]+[动作]+[场景]+[镜头运动]+[光线]+[风格]，电影级、动漫插画风格，结尾附 no text, no watermark。
- 挑选的段落应彼此不同、覆盖本节的关键情景。
- 输出必须是合法 JSON（不要 markdown 围栏）：{"scenes":[{"anchor":"段落原文片段","scene":"cinematic english prompt"}]}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** 让 LLM 从章节正文挑选 count 个关键段落并提炼场景描述。anchor 校验可在正文匹配；全部失配时回退首段。 */
export async function planScenes(
  w: WorldState,
  chapterIndex: number,
  kind: "image" | "video",
  count: number,
): Promise<ScenePlan[]> {
  const ch = w.chapters.find((c) => c.index === chapterIndex);
  if (!ch) throw new Error("章节不存在");
  const n = kind === "video" ? 1 : Math.max(1, Math.min(3, count));
  const userMsg = [
    `小说《${w.title}》（${w.genre || "未知题材"}），基调：${w.setting.tone || "跟随正文"}。`,
    `第 ${chapterIndex} 节《${ch.title}》正文：`,
    ch.text,
    `\n请从中挑选 ${n} 个最具画面感的关键段落，各写一句电影化场景描述（只输出 JSON）。`,
  ].join("\n");
  const out = await chatJson<{ scenes?: ScenePlan[] }>(
    [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { temperature: 0.7, maxTokens: 1024 },
  );
  const nText = normAnchor(ch.text);
  const raw = Array.isArray(out.scenes) ? out.scenes : [];
  // 仅保留 anchor 能在正文归一化匹配的条目（去重 anchor）
  const seen = new Set<string>();
  const scenes: ScenePlan[] = [];
  for (const s of raw) {
    const anchor = String(s?.anchor ?? "").trim();
    const scene = String(s?.scene ?? "").trim();
    const na = normAnchor(anchor);
    if (!anchor || !scene || na.length < 4 || !nText.includes(na)) continue;
    if (seen.has(na)) continue;
    seen.add(na);
    scenes.push({ anchor, scene });
    if (scenes.length >= n) break;
  }
  if (scenes.length) return scenes;
  // 兜底：LLM anchor 全部失配 → 取最长段落作 anchor，scene 用 LLM 首条或通用描述
  const paras = ch.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const fallbackAnchor = (paras.sort((a, b) => b.length - a.length)[0] ?? ch.text).slice(0, 40);
  const fallbackScene = raw[0]?.scene?.trim() || `cinematic scene from "${w.title}", dramatic lighting, anime illustration style, no text, no watermark`;
  return [{ anchor: fallbackAnchor, scene: fallbackScene }];
}

function mediaId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 用 scene 作为 prompt 生成插画，返回就绪的 image 媒体（anchor 用于段落定位） */
export async function generateSceneImage(storyTitle: string, scene: string, anchor: string): Promise<ChapterMedia> {
  const buf = await generateImage(scene, "896x560");
  const name = `ill-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.png`;
  const path = saveImage(storyTitle, name, buf);
  return { id: mediaId(), kind: "image", anchor, prompt: scene, path, status: "ready" };
}

/** 视频时长 5~15s → 满足 8n+1 且 ≤441 的 num_frames（@24fps） */
export function videoNumFrames(): number {
  const duration = 5 + Math.floor(Math.random() * 11); // 5..15 秒
  const raw = duration * 24;
  const n = 8 * Math.round((raw - 1) / 8) + 1;
  return Math.min(441, Math.max(9, n));
}

/** 用 scene 作为 prompt 创建视频任务（异步），返回 pending 的 video 媒体；image 存在时走 i2v */
export async function createSceneVideo(scene: string, anchor: string, image?: string): Promise<ChapterMedia> {
  const task = await createVideoTask(scene, { image, numFrames: videoNumFrames() });
  return { id: mediaId(), kind: "video", anchor, prompt: scene, videoId: task.videoId, status: "pending" };
}
