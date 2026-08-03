// API 路由：/api/* 的统一处理，dev（bun --hot）与 prod（Bun.serve）共用
import * as agnes from "./agnes";
import * as anysearch from "./anysearch";
import * as director from "./director";
import { loadWorld, listStoriesMeta, exportMarkdown, exportEpub, slugify as slug, saveWorld } from "./storage";
import { buildAutoLore, mergeLore } from "./lore";
import { generateImage, saveImage, readImage } from "./images";
import { pollVideoTask, downloadVideo, saveVideo } from "./videos";
import { planScenes, generateSceneImage, createSceneVideo, normAnchor } from "./media";
import { migrateChapterMedia, type WorldState, type ChapterMedia } from "./world";
import type { CardType } from "./cards";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function sseStream(produce: (send: (obj: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // 客户端断开（如 curl 超时）后 enqueue 会抛错：吞掉，保证服务端回合完整执行到存档
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* 客户端已断开，忽略 */
        }
      };
      try {
        await produce(send);
      } catch (e) {
        // 安全：业务错误（AppError）可回显，内部异常只记日志不泄露细节
        console.error("[api] 请求失败:", e);
        const msg = e instanceof AppError ? e.message : "内部错误，请稍后重试";
        send({ error: msg });
      } finally {
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

/** 业务错误：消息可安全回显给前端（区别于内部异常） */
export class AppError extends Error {}

// per-title 互斥锁：串行化 load→修改→save 的回合/抽卡操作，防止并发覆盖
const titleLocks = new Map<string, Promise<unknown>>();
function withTitleLock<T>(title: string, fn: () => Promise<T>): Promise<T> {
  const prev = titleLocks.get(title) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const guard = run.then(
    () => undefined,
    () => undefined,
  );
  titleLocks.set(title, guard);
  return run.finally(() => {
    if (titleLocks.get(title) === guard) titleLocks.delete(title);
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 返回 null 表示非 API 路径（由调用方继续处理页面渲染） */
export async function handleApi(pathname: string, req: Request): Promise<Response | null> {
  if (!pathname.startsWith("/api/")) return null;

  // 小说引擎路由优先
  const novelRes = await handleNovelApi(pathname, req);
  if (novelRes) return novelRes;

  switch (pathname) {
    case "/api/health": {
      const agnesOk = Boolean(process.env.AGNES_API_KEY);
      const anysearchOk = Boolean(process.env.ANYSEARCH_API_KEY);
      return json({
        ok: agnesOk && anysearchOk,
        agnes: agnesOk,
        anysearch: anysearchOk,
        ts: new Date().toISOString(),
      });
    }

    case "/api/chat": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const body = await readBody(req);
      const prompt = String(body.prompt ?? "");
      if (!prompt) return json({ error: "缺少 prompt" }, 400);
      try {
        const text = await agnes.chat([{ role: "user", content: prompt }], { maxTokens: 2048 });
        return json({ text });
      } catch (e) {
        console.error("[api/chat]", e);
        return json({ error: e instanceof AppError ? e.message : "生成失败，请稍后重试" }, 502);
      }
    }

    case "/api/chat/stream": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const body = await readBody(req);
      const prompt = String(body.prompt ?? "");
      if (!prompt) return json({ error: "缺少 prompt" }, 400);

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            const full = await agnes.chatStream([{ role: "user", content: prompt }], (delta) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
            });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, text: full })}\n\n`));
          } catch (e) {
            console.error("[api/chat/stream]", e);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "生成失败，请稍后重试" })}\n\n`));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    case "/api/search": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const body = await readBody(req);
      const query = String(body.query ?? "");
      if (!query) return json({ error: "缺少 query" }, 400);
      try {
        const result = await anysearch.search({
          query,
          max_results: typeof body.max_results === "number" ? body.max_results : 5,
        });
        return json({ result });
      } catch (e) {
        console.error("[api/search]", e);
        return json({ error: e instanceof AppError ? e.message : "搜索失败，请稍后重试" }, 502);
      }
    }

    default:
      return json({ error: `未知 API: ${pathname}` }, 404);
  }
}

// —— 小说引擎路由（独立处理，避免 handleApi 过长） ——

export async function handleNovelApi(pathname: string, req: Request): Promise<Response | null> {
  if (!pathname.startsWith("/api/novel")) return null;
  const body = await readBody(req);

  switch (pathname) {
    case "/api/novel/new": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const idea = String(body.idea ?? "").trim();
      if (!idea) return json({ error: "缺少 idea" }, 400);
      try {
        const world = await director.newStory(idea, body.genre ? String(body.genre) : undefined);
        return json({ ok: true, world: sanitize(world) });
      } catch (e) {
        console.error("[api/novel/new]", e);
        return json({ error: e instanceof AppError ? e.message : "立项失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/state": {
      const title = String(body.title ?? "").trim();
      const w = title ? loadWorld(title) : null;
      if (!w) return json({ error: "故事不存在: " + title }, 404);
      // 自愈：出场角色以正文为准重算 + 旧章节级媒体迁移为段落锚定 media[]，有变更则持久化
      let dirty = director.recomputeAppearedIn(w);
      if (migrateChapterMedia(w)) dirty = true;
      if (dirty) saveWorld(w);
      return json({ world: sanitize(w) });
    }

    case "/api/novel/list": {
      return json({ stories: listStoriesMeta() });
    }

    case "/api/novel/step": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const instruction = String(body.instruction ?? "").trim();
      return sseStream(async (send) => {
        // loadWorld 必须与修改/保存同锁，防止并发下基于旧快照覆盖
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          send({ phase: "start", nextChapter: w.nextChapter });
          return director.step(w, instruction, (e) => send(e));
        });
        send({ phase: "result", result: { chapter: result.chapter, review: result.review, rounds: result.rounds } });
      });
    }

    case "/api/novel/gacha": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const action = String(body.action ?? "generate"); // generate | apply
      try {
        if (action === "generate") {
          const out = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            return director.gachaGenerate(w, {
              count: Math.max(1, Math.min(typeof body.count === "number" ? body.count : 4, 6)),
              types: Array.isArray(body.types)
                ? (body.types.map(String).filter((t) => ["角色", "发展方向", "伏笔", "章节", "道具", "场景"].includes(t)) as CardType[])
                : undefined,
            });
          });
          return json({ ok: true, pool: out.pool });
        } else {
          // apply：从已存储的 pendingCards 中抽取
          const out = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            return director.gachaApply(w, {
              auto: body.auto === true,
              pick: Array.isArray(body.pick) ? body.pick.map(String) : undefined,
            });
          });
          return json({ ok: true, applied: out.applied, instructions: out.instructions });
        }
      } catch (e) {
        console.error("[api/novel/gacha]", e);
        return json({ error: e instanceof AppError ? e.message : "抽卡失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/export": {
      // 支持 ?title= query 或 body；format=epub 导出 EPUB
      const url = new URL(req.url, "http://localhost");
      const title = String(url.searchParams.get("title") ?? body.title ?? "").trim();
      const format = String(url.searchParams.get("format") ?? "md");
      const w = title ? loadWorld(title) : null;
      if (!w) return json({ error: "故事不存在: " + title }, 404);
      if (format === "epub") {
        const blob = exportEpub(w);
        const fn = encodeURIComponent(slug(w.title)); // ASCII 安全（RFC 5987）
        return new Response(blob, {
          headers: {
            "Content-Type": "application/epub+zip",
            "Content-Disposition": `attachment; filename="${fn}.epub"; filename*=UTF-8''${fn}.epub`,
          },
        });
      }
      const fn = encodeURIComponent(slug(w.title));
      return new Response(exportMarkdown(w), {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fn}.md"; filename*=UTF-8''${fn}.md`,
        },
      });
    }

    case "/api/novel/foreshadow": {
      // 伏笔 CRUD：action = add | update | delete
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          if (action === "add") {
            const text = String(body.text ?? "").trim();
            if (!text) throw new AppError("伏笔内容不能为空");
            const id = `fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            const plantedAt = typeof body.plantedAt === "number" ? body.plantedAt : (w.nextChapter ?? 1);
            w.foreshadowing.push({ id, text, plantedAt, status: "planted", note: String(body.note ?? "") || undefined });
          } else if (action === "update") {
            const id = String(body.id ?? "");
            const f = w.foreshadowing.find((x) => x.id === id);
            if (!f) throw new AppError("伏笔不存在: " + id);
            if (body.text !== undefined) f.text = String(body.text).trim();
            if (body.note !== undefined) f.note = String(body.note).trim() || undefined;
            if (body.status !== undefined) f.status = String(body.status) as "planted" | "active" | "resolved";
          } else if (action === "delete") {
            const id = String(body.id ?? "");
            const idx = w.foreshadowing.findIndex((x) => x.id === id);
            if (idx === -1) throw new AppError("伏笔不存在: " + id);
            w.foreshadowing.splice(idx, 1);
          } else {
            throw new AppError("未知操作: " + action);
          }
          saveWorld(w);
          return { foreshadowing: w.foreshadowing };
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/foreshadow]", e);
        return json({ error: e instanceof AppError ? e.message : "伏笔操作失败" }, e instanceof AppError ? 400 : 500);
      }
    }

    case "/api/novel/outline": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const outline = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.generateOutline(w, body.hint ? String(body.hint) : undefined);
        });
        return json({ ok: true, outline });
      } catch (e) {
        console.error("[api/novel/outline]", e);
        return json({ error: e instanceof AppError ? e.message : "大纲生成失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/world": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const updated = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.editWorld(w, {
            premise: typeof body.premise === "string" ? body.premise : undefined,
            setting:
              body.setting && typeof body.setting === "object"
                ? (body.setting as Partial<WorldState["setting"]>)
                : undefined,
            characters: Array.isArray(body.characters) ? (body.characters as never[]) : undefined,
            outline: Array.isArray(body.outline) ? body.outline.map(String) : undefined,
            removeCharacterIds: Array.isArray(body.removeCharacterIds) ? body.removeCharacterIds.map(String) : undefined,
            gen: body.gen && typeof body.gen === "object" ? (body.gen as never) : undefined,
            chapterGen: body.chapterGen && typeof body.chapterGen === "object" ? (body.chapterGen as never) : undefined,
          });
        });
        return json({ ok: true, world: sanitize(updated) });
      } catch (e) {
        console.error("[api/novel/world]", e);
        return json({ error: e instanceof AppError ? e.message : "保存失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/chapter/edit": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.index);
      const text = String(body.text ?? "").trim().slice(0, 20000); // 长度 clamp（安全 LOW）
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      if (!text) return json({ error: "章节内容不能为空" }, 400);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.editChapter(w, index, text);
        });
        return json({ ok: true, world: sanitize(result.world), review: result.review });
      } catch (e) {
        console.error("[api/novel/chapter/edit]", e);
        return json({ error: e instanceof AppError ? e.message : "保存失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/chapter/review": {
      // 手动触发审查（不重写）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.index);
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.reReviewChapter(w, index);
        });
        return json({ ok: true, world: sanitize(result.world), review: result.review });
      } catch (e) {
        console.error("[api/novel/chapter/review]", e);
        return json({ error: e instanceof AppError ? e.message : "审查失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/lore": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const action = String(body.action ?? "auto");
      try {
        const entries = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          if (action === "auto") {
            // 自动重建：手动条目保留
            const auto = buildAutoLore(w);
            w.lore = mergeLore(w, auto);
          } else if (action === "save" && Array.isArray(body.entries)) {
            // 手动保存：校验字段
            w.lore = body.entries
              .filter((e: unknown): e is Record<string, unknown> => !!e && typeof e === "object")
              .map((e) => ({
                id: String(e.id ?? `lore-${Date.now().toString(36)}`),
                keywords: Array.isArray(e.keywords) ? e.keywords.map(String).filter(Boolean).slice(0, 4).map((k) => k.slice(0, 50)) : [],
                content: String(e.content ?? "").slice(0, 300),
                enabled: e.enabled !== false,
                auto: e.auto === true,
              }));
          } else {
            throw new AppError("未知操作: " + action);
          }
          saveWorld(w);
          return w.lore ?? [];
        });
        return json({ ok: true, entries });
      } catch (e) {
        console.error("[api/novel/lore]", e);
        return json({ error: e instanceof AppError ? e.message : "世界书保存失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/image": {
      // 生成图像：kind = cover | character | chapter
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const kind = String(body.kind ?? "");
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!["cover", "character"].includes(kind)) return json({ error: "kind 必须为 cover/character（章节插画请用 media/* 接口）" }, 400);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const userPrompt = body.prompt ? String(body.prompt).slice(0, 300) : "";
          // cover | character：单张（章节插画已迁移到 media/* 接口，段落锚定）
          let prompt = "";
          let rel = "";
          let size = "768x768";
          if (kind === "cover") {
            // A4 纸张宽高比 (210:297 ≈ 1:1.414)
            size = "768x1086";
            prompt = userPrompt || `${w.title}, ${w.genre} novel cover, ${w.setting.tone}, ${w.setting.time}, ${w.setting.place}, cinematic lighting, dramatic composition, detailed illustration, no text, no watermark`;
            rel = "images/cover.png";
          } else {
            const cid = String(body.characterId ?? "");
            const c = w.characters.find((x) => x.id === cid);
            if (!c) throw new AppError("角色不存在");
            // 角色图：仅人物 + 名称，统一风格
            size = "768x768";
            prompt = userPrompt || `character portrait, ${c.name}, ${c.role}, ${c.traits.slice(0, 3).join(", ")}, upper body, facing viewer, clean background, anime illustration style, consistent lighting, high quality, no text, no watermark`;
            rel = `images/char-${c.id}.png`;
          }
          const buf = await generateImage(prompt, size);
          const path = saveImage(title, rel.split("/").pop()!, buf);
          if (kind === "cover") w.cover = path;
          else {
            const c = w.characters.find((x) => x.id === String(body.characterId ?? ""));
            if (c) c.image = path;
          }
          saveWorld(w);
          return { path, prompt };
        });
        return json({ ok: true, ...result });
      } catch (e) {
        console.error("[api/novel/image]", e);
        return json({ error: e instanceof AppError ? e.message : "图像生成失败（Agnes 云端不可用且本地回退失败），请稍后重试" }, 502);
      }
    }

    case "/api/novel/media/plan": {
      // 分镜：LLM 从全章挑选关键段落并提炼电影化场景描述（不生成）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const kind = String(body.kind ?? "image");
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      if (kind !== "image" && kind !== "video") return json({ error: "kind 必须为 image/video" }, 400);
      const w = loadWorld(title);
      if (!w) return json({ error: "故事不存在: " + title }, 404);
      try {
        const scenes = await planScenes(w, idx, kind as "image" | "video", Number(body.count) || 1);
        return json({ ok: true, scenes });
      } catch (e) {
        console.error("[api/novel/media/plan]", e);
        return json({ error: e instanceof AppError ? e.message : "场景规划失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/media/generate": {
      // 按确认的场景生成媒体：image 同步生成；video 创建异步任务（pending）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const kind = String(body.kind ?? "image");
      const scenes = Array.isArray(body.scenes) ? (body.scenes as { anchor?: string; scene?: string }[]) : [];
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      const valid = scenes
        .filter((s) => s?.anchor?.trim() && s?.scene?.trim())
        .map((s) => ({ anchor: String(s.anchor).trim(), scene: String(s.scene).trim() }));
      if (!valid.length) return json({ error: "缺少有效的场景" }, 400);
      try {
        if (kind === "video") {
          const scene = valid[0];
          // i2v：若该段落已有就绪插画则作首帧（读不到则 t2v）
          let image: string | undefined;
          const w0 = loadWorld(title);
          const ch0 = w0?.chapters.find((x) => x.index === idx);
          const imgs = (ch0?.media ?? []).filter((m) => m.kind === "image" && m.status === "ready" && m.path);
          const na = normAnchor(scene.anchor);
          const match = imgs.find((m) => normAnchor(m.anchor) === na) ?? imgs.find((m) => normAnchor(m.anchor).includes(na) || na.includes(normAnchor(m.anchor)));
          if (match?.path) {
            const buf = readImage(title, match.path);
            if (buf) {
              const ext = match.path.slice(match.path.lastIndexOf(".") + 1).toLowerCase();
              const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
              image = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
            }
          }
          let media: ChapterMedia;
          try {
            media = await createSceneVideo(scene.scene, scene.anchor, image);
          } catch (e) {
            if (image) {
              console.warn("[media/generate] i2v 失败，回退 t2v:", (e as Error).message);
              media = await createSceneVideo(scene.scene, scene.anchor);
            } else {
              throw e;
            }
          }
          await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            const ch = w.chapters.find((x) => x.index === idx);
            if (!ch) throw new AppError("章节不存在");
            ch.media = [...(ch.media ?? []), media];
            saveWorld(w);
          });
          return json({ ok: true, mediaId: media.id, videoId: media.videoId, mode: image ? "i2v" : "t2v" });
        }
        // image：持锁内逐场景生成
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ch = w.chapters.find((x) => x.index === idx);
          if (!ch) throw new AppError("章节不存在");
          const added: ChapterMedia[] = [];
          for (const s of valid.slice(0, 3)) {
            added.push(await generateSceneImage(title, s.scene, s.anchor));
          }
          ch.media = [...(ch.media ?? []), ...added];
          saveWorld(w);
          return { media: added };
        });
        return json({ ok: true, ...result });
      } catch (e) {
        console.error("[api/novel/media/generate]", e);
        const st = (e as { status?: number }).status;
        return json({ error: e instanceof AppError ? e.message : "媒体生成失败，请稍后重试" }, st === 429 ? 429 : 502);
      }
    }

    case "/api/novel/media/status": {
      // 轮询视频媒体任务；completed 时下载落盘并置 ready（429 容忍）
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const mediaId = String(body.mediaId ?? "").trim();
      if (!title || !mediaId) return json({ error: "缺少参数" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      const w0 = loadWorld(title);
      const ch0 = w0?.chapters.find((x) => x.index === idx);
      const media = (ch0?.media ?? []).find((m) => m.id === mediaId);
      if (!media) return json({ error: "媒体不存在" }, 404);
      if (media.status === "ready") return json({ ok: true, status: "ready", progress: 100, path: media.path });
      if (!media.videoId) return json({ ok: true, status: media.status ?? "failed", error: "无视频任务" });
      try {
        const st = await pollVideoTask(media.videoId);
        if (st.status === "rate_limited") return json({ ok: true, status: "pending", progress: -1, rateLimited: true });
        if (st.status === "failed") {
          await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            const ch = w?.chapters.find((x) => x.index === idx);
            const m = (ch?.media ?? []).find((x) => x.id === mediaId);
            if (m) m.status = "failed";
            if (w) saveWorld(w);
          });
          return json({ ok: true, status: "failed", error: st.error ?? "视频生成失败" });
        }
        if (st.status === "completed" && st.url) {
          const buf = await downloadVideo(st.url);
          const path = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            const ch = w.chapters.find((x) => x.index === idx);
            const m = (ch?.media ?? []).find((x) => x.id === mediaId);
            if (!m) throw new AppError("媒体不存在");
            const rel = saveVideo(title, `${mediaId}.mp4`, buf);
            m.path = rel;
            m.status = "ready";
            saveWorld(w);
            return rel;
          });
          return json({ ok: true, status: "ready", progress: 100, path });
        }
        return json({ ok: true, status: "pending", progress: st.progress });
      } catch (e) {
        console.error("[api/novel/media/status]", e);
        return json({ error: e instanceof AppError ? e.message : "查询视频状态失败" }, 502);
      }
    }

    case "/api/novel/asset": {
      // 读取图片：?title=&path=images/cover.png
      const u = new URL(req.url, "http://localhost");
      const title = String(u.searchParams.get("title") ?? "").trim();
      const path = String(u.searchParams.get("path") ?? "").trim();
      if (!title || !path) return json({ error: "缺少参数" }, 400);
      const buf = readImage(title, path);
      if (!buf) return json({ error: "资源不存在" }, 404);
      const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
      return new Response(Buffer.from(buf), {
        headers: {
          "Content-Type": ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "mp4" ? "video/mp4" : "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    case "/api/novel/cover/upload": {
      // 上传封面（前端 FileReader → dataUrl）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const dataUrl = String(body.dataUrl ?? "");
      if (!title) return json({ error: "缺少 title" }, 400);
      const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/s);
      if (!m) return json({ error: "仅支持 PNG/JPEG 图片" }, 400);
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 10 * 1024 * 1024) return json({ error: "图片过大（限 10MB）" }, 400);
      // 校验解码后的魔数：PNG (89504E47) 或 JPEG (FFD8)
      const isPng = buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      const isJpeg = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
      if (!isPng && !isJpeg) return json({ error: "仅支持 PNG/JPEG 图片" }, 400);
      try {
        const path = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ext = m[1] === "png" ? "png" : "jpg";
          const rel = saveImage(title, `cover.${ext}`, new Uint8Array(buf));
          w.cover = rel;
          saveWorld(w);
          return rel;
        });
        return json({ ok: true, path });
      } catch (e) {
        console.error("[api/novel/cover/upload]", e);
        return json({ error: e instanceof AppError ? e.message : "上传失败" }, 502);
      }
    }

    case "/api/novel/chapter/regenerate": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.index);
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.regenerateChapter(w, index, body.instruction ? String(body.instruction).slice(0, 500) : undefined);
        });
        return json({ ok: true, chapter: result.chapter, review: result.review, world: sanitize(result.world) });
      } catch (e) {
        console.error("[api/novel/chapter/regenerate]", e);
        return json({ error: e instanceof AppError ? e.message : "重写失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/chapter/rollback": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.index);
      const versionIndex = Number(body.versionIndex);
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      if (!Number.isInteger(versionIndex) || versionIndex < 0) return json({ error: "缺少有效的版本号" }, 400);
      try {
        const updated = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.rollbackChapter(w, index, versionIndex);
        });
        return json({ ok: true, world: sanitize(updated) });
      } catch (e) {
        console.error("[api/novel/chapter/rollback]", e);
        return json({ error: e instanceof AppError ? e.message : "回滚失败，请稍后重试" }, 502);
      }
    }

    default:
      return json({ error: `未知 API: ${pathname}` }, 404);
  }
}

/** 传输给前端的精简视图（剔除超长正文以外的敏感字段；这里主要控制体积） */
function sanitize(w: import("./world").WorldState) {
  return {
    ...w,
    chapters: w.chapters.map((c) => ({ index: c.index, title: c.title, text: c.text, review: c.review, versions: c.versions, media: c.media })),
  };
}
