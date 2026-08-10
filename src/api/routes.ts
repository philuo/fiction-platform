// API 路由：/api/* 的统一处理，dev（bun --hot）与 prod（Bun.serve）共用
import * as agnes from "./agnes";
import * as anysearch from "./anysearch";
import * as director from "./director";
import { buildBlueprint, confirmBlueprint, expandArc, type BlueprintOption } from "./planner";
import * as steering from "./steering";
import { runAuto, stopAuto, pauseAuto } from "./autorun";
import { evaluateBookCached, readEvalReport } from "./eval";
import { extractFingerprint } from "./style";
import { loadWorld, listStories, listStoriesMeta, deleteStory, exportMarkdown, exportEpub, slugify as slug, saveWorld, storyDir, storyExists, loadAutoSession, clearAutoSession, loadPendingChapter, clearPendingChapter, currentUser, migrateLegacyStoriesTo, runAsUser, userDir } from "./storage";
import { createNewStoryTask, completeNewStoryTask, failNewStoryTask, markNewStoryTaskReady, updateNewStoryTaskStage, getNewStoryTask, listActiveNewStoryTasks, removeNewStoryTaskByTitle } from "./newtask";
import { buildAutoLore, mergeLore, sanitizeLore } from "./lore";
import { generateImage, saveImage, readImage, deleteMediaFile, compressToJpeg } from "./images";
import { pollVideoTask, downloadVideo, saveVideo } from "./videos";
import { planScenes, generateSceneImage, createSceneVideo, styleAnchor, findCharacterRef, findVideoFirstFrame, generateCharacterPortrait, generateCharacterAvatar, mediaDataUri, mediaId, identityDress, MAX_IMAGES_PER_CHAPTER, markOrphanMedia } from "./media";
import { auditWorld, autoRepair, alignWorld, collectOrphanMediaFiles } from "./integrity";
import { resetChapterLedger, settleChapter } from "./chronicler";
import { applyStateChange, finalizeStateChange } from "./statechange";
import { withTitleLock } from "./titlelock";
import { deriveBrainState } from "./brain-state";
import { brainChatStream } from "./brain-chat";
import {
  attachSessionTask,
  broadcastToSession,
  createSession as createBrainSession,
  deleteSession as deleteBrainSession,
  finishSessionTask,
  getSession as getBrainSession,
  isSessionRunning,
  lastPendingMessage,
  listSessions as listBrainSessions,
  registerSessionTask,
  truncateSession as truncateBrainSession,
  markSessionCompleted as markBrainSessionCompleted,
} from "./brain-sessions";
import { startAdvanceTask, updateAdvanceTaskPhase, completeAdvanceTask, failAdvanceTask, getAdvanceTaskForClient, clearAdvanceTask } from "./advancetask";
import { migrateChapterMedia, touchChapter, genOf, type WorldState, type Character as WorldCharacter, type ChapterMedia, type ConsistencyFinding, type PendingChapter } from "./world";
import { AuthError, clearSessionCookieValue, firstUsername, getPropClosed, listUsernames, loginUser, logoutSession, registerUser, sessionCookieValue, setPropClosed, userFromRequest, validateCredentials, SESSION_COOKIE } from "./auth";
import type { AuthUser } from "./auth";
import type { CardType } from "./cards";
import { renameSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
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
      // 心跳：长回合（写+审+修可达数分钟）每 8s 发 ping 保活（必须小于 Bun.serve 的 idleTimeout=255s，并防中间代理断连）
      const heartbeat = setInterval(() => send({ phase: "ping" }), 8_000);
      try {
        await produce(send);
      } catch (e) {
        // 干预打断：推 interrupted 事件（非错误）；业务错误（AppError）可回显；内部异常只记日志
        if (e instanceof director.InterruptedError) {
          send({ phase: "interrupted", item: e.item });
        } else {
          console.error("[api] 请求失败:", e);
          const msg = e instanceof AppError ? e.message : "内部错误，请稍后重试";
          send({ error: msg });
        }
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive" },
  });
}

/** 业务错误：消息可安全回显给前端（区别于内部异常） */
export class AppError extends Error {}

/** 错误信息归一（入库/回显）：取首行（剥离 stack 尾部）、截断 300 字符；
 *  非 AppError（LLMError/TypeError 等）也保留真实原因（如 ECONNRESET/超时），不笼统吞掉 */
function errorDetail(e: unknown, fallback: string): string {
  const msg = e instanceof Error && e.message ? e.message.split("\n")[0].trim() : "";
  return msg ? msg.slice(0, 300) : fallback;
}

// 自动连载活跃运行注册表：同一用户名下同一书名同时只允许一个 runAuto 循环（防双跑重复写章/停止信号串扰）
const activeAuto = new Set<string>();
// 已删除图书注册表（key 同 autoKey：`<user>::<slug>`）：删除后仍在锁外跑的后台任务（角色视觉生成等）
// 据此自查，避免向已删目录继续写媒体/烧配额；延迟清理防无限增长
const deletedStories = new Set<string>();
// 媒体重生成并发防护：同一 mediaId 同时只允许一个重生成（单进程部署，进程内集合即可）
const regenBusy = new Set<string>();
/** 进程内注册表 key：前缀当前用户，不同账号的同名书 / 相同 mediaId 互不串扰 */
function mediaKey(id: string): string {
  return `${currentUser() ?? ""}::${id}`;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 插画异步生成任务表（内存态）：mediaId → 生成中；status 轮询据此区分“生成中”与“服务重启中断” */
const imageGenTasks = new Map<string, boolean>();

/** 画面主体角色硬性描述（性别/年龄/身份/外貌/当前形象/身份服饰）——强制拼入插画/视频提示词，不依赖 LLM 转写；无主体或角色不存在时返回 undefined */
function charHintFor(w: WorldState, subject?: string): string | undefined {
  if (!subject) return undefined;
  const c = w.characters.find((x) => x.name === subject);
  if (!c) return undefined;
  const attrs = [c.gender ? `性别 ${c.gender}` : "", c.age ? `年龄 ${c.age}` : "", c.identity ? `身份 ${c.identity}` : ""].filter(Boolean).join("，");
  const looks = c.traits.slice(0, 4).join("、");
  const idDress = identityDress(c);
  const segs = [`画面主体角色「${c.name}」`, attrs];
  if (looks) segs.push(`外貌 ${looks}`);
  // 注意：不注入 c.look（当前形象）——look 是此前章节结算的瞬时状态，与所选段落可能不同时点，
  if (idDress) segs.push(`身份服饰 ${idDress}${c}`);
  return `${segs.filter(Boolean).join("：")}。`;
}
/** 媒体生成后确保出场角色视觉完整（fire-and-forget，不阻塞本次插画/视频）：委托 ensureCharacterVisuals——
 * 统一「先头像（纯文生）→ 立绘（以头像为参考）」顺序与 visualInFlight 去重 / visualTriedAt 冷却 / visualTasks 状态表；
 * 筛选出场角色中「缺立绘」者触发（缺立绘的角色通常头像也缺，ensureCharacterVisuals 会一并补齐；
 * 已有立绘者视觉已完整或仅缺头像的异常态由中枢巡检/读时自愈兜底，此处只负责媒体出图后的顺带补全）。
 * （CMD-M11 语义由「补立绘」扩展为「补角色视觉」。） */
function schedulePortraitFor(title: string, w0: WorldState, anchor: string): void {
  const c = w0.characters.find((x) => x.name && anchor.includes(x.name) && !x.portrait?.path);
  if (!c) return;
  ensureCharacterVisuals(title, w0, c);
}

/** 角色视觉自动生成任务表（内存态）：slug(title) → 角色 id → 任务结果（running/done/failed，失败带原因）；
 * 前端 /api/novel/visual/status 轮询据此判断「角色头像/立绘自动生成」是否完成（完成后中枢恢复待命） */
type VisualTaskResult = { status: "running" | "done" | "failed"; reason?: string };
const visualTasks = new Map<string, Map<string, VisualTaskResult>>();
/** 角色视觉生成中集合（进程级去重：同一角色同时只允许一个自动生成任务） */
const visualInFlight = new Set<string>();
/** 小说封面生成中集合（进程级去重：同一本书同时只允许一个自动封面任务） */
const coverInFlight = new Set<string>();
/** 视觉自动重试冷却：失败/尝试后 1 分钟内不再自动触发（防高频烧配额；手动生成不受影响）。入口触发与中枢巡检共用 */
const VISUAL_RETRY_COOLDOWN = 60_000;

/** 角色视觉自动补全（fire-and-forget）：角色创建（立项 / 确认入册 / 手动新增 / 读时自愈 / 中枢巡检）后自动生成头像 + 立绘。
 * 生成顺序：先头像（纯文生，仅角色自身字段属性）→ 再以头像为参考图生成立绘（立绘必须参考头像，渠道单一；头像缺失时立绘不生成，随头像失败一并留痕）；
 * 每步锁内短事务落盘 + logChange（立绘 CMD-M07 / 头像 CMD-M08，actor=system），操作日志可追溯；
 * 失败同样写操作日志（kind=visual-fail，带原因），不在日志层面静默；可在角色面板手动生成；
 * 已有完整视觉（portrait+image）的角色跳过（幂等），只缺其一则只补缺的；失败不抛错。
 * 注意：内部自带短事务落盘，调用方勿持锁（锁可重入，锁内启动亦安全）。 */
function ensureCharacterVisuals(title: string, w0: WorldState, c: WorldCharacter): void {
  if (c.portrait?.path && c.image) return; // 视觉已完整，跳过
  const uk = currentUser() ?? "";
  const key = `${uk}::${slug(title)}::${c.id}`;
  if (visualInFlight.has(key)) return; // 已在生成中
  visualInFlight.add(key);
  const tKey = `${uk}::${slug(title)}`;
  const tasks = visualTasks.get(tKey) ?? new Map<string, VisualTaskResult>();
  tasks.set(c.id, { status: "running" });
  visualTasks.set(tKey, tasks);
  void (async () => {
    const t0 = Date.now();
    const failures: string[] = [];
    // 删除自查：书已被删除时停止后续生成（书目录删除后仍在锁外跑的任务在每步生成前检查，防写孤儿媒体/继续烧配额）
    const deleted = () => deletedStories.has(tKey);
    try {
      // ⓪ 立即落盘 visualTriedAt（读时自愈据此冷却重试，防烧配额；每次尝试都刷新时间戳，失败也置位，手动生成不受影响）；此步失败不阻塞生成
      try {
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const cc = w?.characters.find((x) => x.id === c.id);
          if (w && cc) {
            cc.visualTriedAt = Date.now();
            saveWorld(w);
          }
        });
      } catch (e) {
        console.warn(`[media] 角色 visualTriedAt 落盘失败（不影响生成）: ${c.name}`, (e as Error).message);
      }
      // ① 头像（缺失才生成）：纯文生方形头像（头像先于立绘生成，是立绘的容貌基准，不依赖立绘）
      if (deleted()) return;
      let avatar: { path: string; prompt: string } | undefined;
      if (!c.image) {
        try {
          avatar = await generateCharacterAvatar(title, w0, c);
        } catch (e) {
          const msg = (e as Error).message;
          failures.push(`头像：${msg}`);
          console.warn(`[media] 角色头像自动生成失败（${c.name}），立绘因无头像参考不生成:`, msg);
        }
      }
      // ② 立绘（缺失才生成；重生成走手动入口）：必须以头像为参考图图生图，立绘与头像容貌一致；无头像时 generateCharacterPortrait 抛错（渠道单一，不降级纯文生）
      if (deleted()) return;
      let portrait = c.portrait;
      if (!portrait?.path) {
        try {
          const ref = avatar?.path
            ? mediaDataUri(title, { id: "", kind: "image", anchor: c.name, path: avatar.path, status: "ready" })
            : undefined;
          portrait = await generateCharacterPortrait(title, w0, c, { refImage: ref });
        } catch (e) {
          const msg = (e as Error).message;
          failures.push(`立绘：${msg}`);
          console.warn(`[media] 角色立绘自动生成失败（${c.name}）:`, msg);
        }
      }
      // ③ 短事务落盘 + 操作日志（成功写 avatar-auto/portrait-auto，失败写 visual-fail，操作日志可追溯）
      const avatarFresh = Boolean(avatar?.path) && avatar!.path !== c.image;
      const portraitFresh = Boolean(portrait?.path) && portrait!.path !== c.portrait?.path;
      if (avatarFresh || portraitFresh || failures.length) {
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const cc = w?.characters.find((x) => x.id === c.id);
          if (w && cc) {
            // 落盘前复查：若目标视觉字段已被并发操作（如用户手动生成）填充，自动生成不覆盖手动结果
            const aOk = Boolean(avatar) && !cc.image;
            const pOk = portraitFresh && !cc.portrait?.path;
            if (aOk) {
              cc.image = avatar!.path;
              steering.logChange(w, { chapter: w.nextChapter, actor: "system", kind: "avatar-auto", detail: `自动生成头像（${cc.name}）`, commandId: "CMD-M08" });
            }
            if (pOk) {
              cc.portrait = portrait!;
              steering.logChange(w, { chapter: w.nextChapter, actor: "system", kind: "portrait-auto", detail: `自动生成立绘（${cc.name}${avatar?.path ? "，以头像为参考" : ""}）`, commandId: "CMD-M07" });
            }
            if (failures.length) {
              steering.logChange(w, { chapter: w.nextChapter, actor: "system", kind: "visual-fail", detail: `角色视觉自动生成失败（${cc.name}）：${failures.join("；")}`, commandId: avatarFresh ? "CMD-M07" : "CMD-M08" });
            }
            saveWorld(w);
          }
        });
        console.log(`[media] 角色视觉自动生成结束: ${c.name}（${((Date.now() - t0) / 1000).toFixed(1)}s${failures.length ? `，失败: ${failures.join("；")}` : ""}）`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      // 并入 failures：保持结果表状态（failed）与操作日志（visual-fail）一致，避免「日志说失败、状态说成功」
      failures.push(`落盘：${msg}`);
      console.warn(`[media] 角色视觉自动生成失败（不影响使用，可在角色面板手动生成）: ${c.name}`, msg);
      // 整体异常（含日志/落盘环节）也写入操作日志，避免静默
      try {
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const cc = w?.characters.find((x) => x.id === c.id);
          if (w && cc) {
            steering.logChange(w, { chapter: w.nextChapter, actor: "system", kind: "visual-fail", detail: `角色视觉自动生成失败（${cc.name}）：${msg}`, commandId: "CMD-M07" });
            saveWorld(w);
          }
        });
      } catch { /* 日志尽力而为 */ }
    } finally {
      visualInFlight.delete(key);
      const tasks = visualTasks.get(tKey);
      if (tasks) {
        // 只写结果状态，不在任务结束时清表：failed/done 信息须由 /api/novel/visual/status
        // 在返回给前端后清理（否则前端轮询永远拿不到 failed/reason，失败提示链路失效）
        tasks.set(c.id, { status: failures.length ? "failed" : "done", reason: failures.join("；") });
      }
    }
  })();
}

/** 小说封面自动生成（fire-and-forget）：新建书（立项壳就绪）后自动生成封面，与角色视觉生成并行。
 * 幂等：已有封面跳过；锁内复查（防并发覆盖手动生成）；失败不阻塞（前端读时自愈/手动生成兜底）。
 * 与 /api/novel/image kind=cover 同 prompt（标题+体裁+基调+时代+地点，A4 比例），画风与全书统一。 */
function ensureCover(title: string, w: WorldState): void {
  if (w.cover) return; // 已有封面跳过
  const uk = currentUser() ?? "";
  const tKey = `${uk}::${slug(title)}`;
  if (coverInFlight.has(tKey)) return; // 已在生成中
  coverInFlight.add(tKey);
  const deleted = () => deletedStories.has(tKey);
  void (async () => {
    const t0 = Date.now();
    try {
      // 锁内复查 + 落盘（防并发期间已有封面；与手动生成互斥）
      const { path, oldRel } = await withTitleLock(slug(title), async () => {
        const cur = loadWorld(title);
        if (!cur) throw new AppError("故事不存在: " + title);
        if (cur.cover) return { path: cur.cover, oldRel: "" }; // 并发复查：已有封面不覆盖
        if (deleted()) return { path: "", oldRel: "" };
        const prompt = `${cur.title}（${cur.genre}）小说封面：${cur.setting.tone}，${cur.setting.time}，${cur.setting.place}，电影感光影，戏剧性构图，细节丰富的插画，画面中不要出现文字，无水印`;
        const buf = await generateImage(prompt, "768x1086");
        // Bun 图片压缩：原始 PNG 可能数 MB，等比缩到 A4 尺寸 + JPEG q82（与立绘/插画一致），体积降 ~90%
        const compressed = await compressToJpeg(buf, 768, 1086);
        const p = saveImage(title, `cover-${Date.now().toString(36)}.jpg`, compressed);
        const w2 = loadWorld(title);
        if (!w2 || w2.cover) return { path: w2?.cover ?? p, oldRel: w2?.cover ? "" : p }; // 再次复查：落盘期间被手动生成则不覆盖
        w2.cover = p;
        steering.logChange(w2, { chapter: w2.nextChapter, actor: "system", kind: "cover-auto", detail: "自动生成小说封面", commandId: "CMD-M09" });
        saveWorld(w2);
        return { path: p, oldRel: "" };
      });
      if (oldRel && oldRel !== path) deleteMediaFile(title, oldRel); // 未采用则清理新图
      console.log(`[media] 封面自动生成结束: ${title}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[media] 封面自动生成失败（不影响使用，可手动生成）: ${title}`, msg);
      try {
        await withTitleLock(slug(title), async () => {
          const w2 = loadWorld(title);
          if (w2) {
            steering.logChange(w2, { chapter: w2.nextChapter, actor: "system", kind: "visual-fail", detail: `封面自动生成失败：${msg}`, commandId: "CMD-M09" });
            saveWorld(w2);
          }
        });
      } catch { /* 日志尽力而为 */ }
    } finally {
      coverInFlight.delete(tKey);
    }
  })();
}

/** 中枢巡检：扫描 data 下所有故事的每个角色，检测头像/立绘是否生成——缺失且未尝试（或已过 1 分钟冷却）的自动补全。
 * 与入口触发（立项/入册/手动新增/读时自愈）互补：即使角色经由任何路径进入世界而未走入口（如手动改存档、dev 热重启丢任务后），
 * 中枢巡检也会兜底补全；触发条件与读时自愈完全一致（visualTriedAt 冷却共用 VISUAL_RETRY_COOLDOWN），幂等（视觉完整跳过）。
 * 由 startVisualSweep 周期调用；也可单次调用（服务启动立即扫一遍）。不阻塞：ensureCharacterVisuals 为 fire-and-forget。 */
export function sweepVisualGaps(): void {
  sweepVisualGapsFor(""); // 遗留根目录（未迁移前）
  for (const username of listUsernames()) {
    runAsUser(username, () => sweepVisualGapsFor(username));
  }
}

function sweepVisualGapsFor(_username: string): void {
  for (const d of listStories()) {
    const w = loadWorldBySlug(d);
    if (!w) continue;
    const needy = w.characters.filter((c) => {
      if (c.portrait?.path && c.image) return false;
      if (!c.visualTriedAt) return true;
      return Date.now() - c.visualTriedAt > VISUAL_RETRY_COOLDOWN;
    });
    for (const c of needy) ensureCharacterVisuals(w.title, w, c);
  }
}

/** 中枢巡检周期：每 60s 扫一遍（视觉生成低频，冷却 1 分钟兜底防烧配额） */
const VISUAL_SWEEP_INTERVAL = 60_000;
let visualSweepTimer: ReturnType<typeof setInterval> | null = null;

/** 启动中枢巡检（服务启动时调用一次，与 resumeAutoSessions 并列挂载；幂等，重复调用不叠加） */
export function startVisualSweep(): void {
  if (visualSweepTimer) return;
  visualSweepTimer = setInterval(() => {
    try {
      sweepVisualGaps();
    } catch (e) {
      console.warn("[media] 中枢视觉巡检异常（下轮重试）:", (e as Error).message);
    }
  }, VISUAL_SWEEP_INTERVAL);
}


/** 返回 null 表示非 API 路径（由调用方继续处理页面渲染）。
 * 入口注入用户上下文（AsyncLocalStorage）：小说/中枢 API 全程按登录用户路由与隔离。 */
export async function handleApi(pathname: string, req: Request): Promise<Response | null> {
  if (!pathname.startsWith("/api/")) return null;
  const user = userFromRequest(req);
  return runAsUser(user?.username ?? null, () => handleApiInner(pathname, req, user));
}

async function handleApiInner(pathname: string, req: Request, user: AuthUser | null): Promise<Response | null> {
  // 强制登录：全部业务数据/能力接口按账号隔离，未登录一律 401（前端未登录本就只显示登录页）。
  // 覆盖小说、中枢、对话（/api/chat、/api/chat/stream）与搜索——全局功能均与账号绑定。
  const requiresAuth =
    pathname.startsWith("/api/novel") ||
    pathname.startsWith("/api/brain") ||
    pathname.startsWith("/api/chat") ||
    pathname === "/api/search";
  if (!user && requiresAuth) {
    return json({ error: "未登录" }, 401);
  }

  // 小说引擎路由优先
  const novelRes = await handleNovelApi(pathname, req);
  if (novelRes) return novelRes;

  switch (pathname) {
    case "/api/auth/register": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const body = await readBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const displayName = String(body.displayName ?? "").trim();
      const err = validateCredentials(username, password);
      if (err) return json({ error: err }, 400);
      try {
        const user = await registerUser(username, password, displayName);
        // 首个注册用户：认领 data/ 根下的遗留旧数据（迁移到其用户目录，登录后立即可见）
        if (user.isFirstUser) {
          try {
            migrateLegacyStoriesTo(user.username);
          } catch (e) {
            console.warn("[api/auth/register] 旧数据迁移失败:", (e as Error).message);
          }
        }
        // 注册即登录：下发业务 token（响应体，前端存 localStorage 供 Authorization header）+ 只读会话 cookie（SSR 首帧识别）
        const session = await loginUser(username, password);
        const token = session?.token ?? "";
        return json({ ok: true, token, user: { id: user.id, username: user.username, displayName: user.displayName } }, 200, token ? { "Set-Cookie": sessionCookieValue(token) } : undefined);
      } catch (e) {
        if (e instanceof AuthError) return json({ error: e.message }, 409);
        console.error("[api/auth/register]", e);
        return json({ error: "注册失败，请稍后重试" }, 500);
      }
    }

    case "/api/auth/login": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const body = await readBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const result = await loginUser(username, password);
      if (!result) return json({ error: "用户名或密码错误" }, 401);
      // 响应体带业务 token（前端存 localStorage 走 Authorization header）+ 只读会话 cookie（SSR 首帧识别）
      return json({ ok: true, token: result.token, user: result.user }, 200, { "Set-Cookie": sessionCookieValue(result.token) });
    }

    case "/api/auth/logout": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      // 按凭证注销：Authorization header token 优先，回退 cookie（旧客户端/SSR 兼容）
      const auth = req.headers.get("authorization");
      let token = "";
      if (auth?.startsWith("Bearer ")) token = auth.slice("Bearer ".length).trim();
      if (!token) {
        const cookie = req.headers.get("cookie") ?? "";
        const pair = cookie
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
        if (pair) token = pair.slice(SESSION_COOKIE.length + 1);
      }
      if (token) logoutSession(token);
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookieValue() });
    }

    case "/api/auth/me": {
      const user = userFromRequest(req);
      if (!user) return json({ error: "未登录" }, 401);
      return json({ ok: true, user });
    }

    case "/api/health": {
      // 文本 key 检查 TEXT_* 优先（当前文本走基元），媒体固定 AGNES_*
      const textOk = Boolean(process.env.TEXT_API_KEY ?? process.env.AGNES_API_KEY);
      const mediaOk = Boolean(process.env.AGNES_API_KEY);
      const anysearchOk = Boolean(process.env.ANYSEARCH_API_KEY);
      return json({
        ok: textOk && mediaOk && anysearchOk,
        agnes: mediaOk,
        text: textOk,
        textModel: process.env.TEXT_MODEL ?? process.env.AGNES_MODEL ?? "agnes-2.5-flash",
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
        const text = await agnes.chat([{ role: "user", content: prompt }], { maxTokens: 60000 });
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
            }, { maxTokens: 60000 });
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
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive" },
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

    case "/api/brain/sessions": {
      // 中枢聊天会话 API（POST 语义按 body.id 分派）：
      // - POST body 无 id → 返回历史列表（title/时间/流式标记，最近更新倒序；历史详情走 /api/brain/sessions/detail）
      // - POST body 有 id → 新建会话，透传前端预生成的 id（一次请求拿回完整会话）
      // （前端统一走 POST：无 body 的 GET 无法传 title，历史遗留 GET 分支已移除）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bsBody = await readBody(req);
      const bsTitle = String(bsBody.title ?? "").trim();
      if (!bsTitle) return json({ error: "缺少 title" }, 400);
      const bsId = String(bsBody.id ?? "").trim();
      if (bsId) {
        // 幂等：id 已存在（重放/前端重试）→ 返回已有会话，不重复创建
        const existing = getBrainSession(bsTitle, bsId);
        if (existing) return json({ session: existing }, 200);
        const firstPrompt = String(bsBody.prompt ?? "").trim();
        const s = createBrainSession(bsTitle, firstPrompt, bsId);
        return json({ session: s }, 201);
      }
      // 列表只回显标题/时间/流式标记（不含完整消息，历史详情走 /api/brain/sessions/detail）
      // 过滤空壳会话（messages=0，从未发消息）：用户期望「初始无会话，首条消息时自动创建」，空壳无存在意义
      const list = listBrainSessions(bsTitle).filter((s) => s.messages.length > 0).map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        streaming: s.streaming,
        messageCount: s.messages.length,
      }));
      return json({ sessions: list });
    }

    case "/api/brain/sessions/delete": {
      // DELETE /api/brain/sessions/:id 用 POST + body.id（handleApi 无 path 参数解析，统一走 body）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bsBody = await readBody(req);
      const bsTitle = String(bsBody.title ?? "").trim();
      const bsId = String(bsBody.id ?? "").trim();
      if (!bsTitle || !bsId) return json({ error: "缺少 title/id" }, 400);
      const ok = deleteBrainSession(bsTitle, bsId);
      return json({ ok });
    }

    case "/api/brain/sessions/detail": {
      // GET /api/brain/sessions/:id 用 POST + body.id（返回完整会话含消息，供刷新恢复/历史回看）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bsBody = await readBody(req);
      const bsTitle = String(bsBody.title ?? "").trim();
      const bsId = String(bsBody.id ?? "").trim();
      if (!bsTitle || !bsId) return json({ error: "缺少 title/id" }, 400);
      const s = getBrainSession(bsTitle, bsId);
      if (!s) return json({ error: "会话不存在" }, 404);
      return json({ session: s });
    }

    case "/api/brain/sessions/completed": {
      // 卡片操作完成标记（preview/form/confirm 卡级 / browse 项级）：服务端持久化，刷新后恢复完成态（防重复提交 + 就地反馈）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bcBody = await readBody(req);
      const bcTitle = String(bcBody.title ?? "").trim();
      const bcId = String(bcBody.id ?? "").trim();
      const bcKey = String(bcBody.key ?? "").trim();
      if (!bcTitle || !bcId || !bcKey) return json({ error: "缺少 title/id/key" }, 400);
      const ok = markBrainSessionCompleted(bcTitle, bcId, bcKey);
      return json({ ok });
    }

    case "/api/brain/sessions/truncate": {
      // 编辑重发前置：删除 fromMessageId 及其后的消息（截断会话）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bsBody = await readBody(req);
      const bsTitle = String(bsBody.title ?? "").trim();
      const bsId = String(bsBody.id ?? "").trim();
      const bsMsgId = String(bsBody.messageId ?? "").trim();
      if (!bsTitle || !bsId || !bsMsgId) return json({ error: "缺少 title/id/messageId" }, 400);
      const ok = truncateBrainSession(bsTitle, bsId, bsMsgId);
      return json({ ok });
    }

    case "/api/brain/state": {
      // 中枢四维状态派生（零 LLM）：world + autoSession runtime + 落盘 eval + 确定性完整性扫描
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bsBody = await readBody(req);
      const bsTitle = String(bsBody.title ?? "").trim();
      if (!bsTitle) return json({ error: "缺少 title" }, 400);
      const bw = loadWorld(bsTitle);
      if (!bw) return json({ error: "故事不存在: " + bsTitle }, 404);
      const bsSession = loadAutoSession(bsTitle);
      const bsAutoRunning = bsSession?.status === "running";
      const brainState = deriveBrainState(bw, {
        busy: bsAutoRunning,
        phase: bsAutoRunning ? bsSession?.phase : undefined,
        autoRunning: bsAutoRunning,
        evalReport: readEvalReport(bsTitle),
        integrityReport: auditWorld(bw),
      });
      return json({ brainState });
    }

    case "/api/brain/context": {
      // 中枢系统状态快照（索引式全知）：服务端权威聚合——自动连载/写作任务/媒体生成/视觉任务/待办清单。
      // 供中枢按需拉取（而非每轮全量注入 LLM，控制 token）；前端 BrainCabin 一并注入 chatCtx。
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bcCtxBody = await readBody(req);
      const bcCtxTitle = String(bcCtxBody.title ?? "").trim();
      if (!bcCtxTitle) return json({ error: "缺少 title" }, 400);
      const bcCtxW = loadWorld(bcCtxTitle);
      if (!bcCtxW) return json({ error: "故事不存在: " + bcCtxTitle }, 404);
      // 自动连载 / 待入册草稿
      const bcCtxAuto = loadAutoSession(bcCtxTitle);
      const bcCtxPending = loadPendingChapter(bcCtxTitle);
      // 写作任务（advance-task）
      const bcCtxTask = getAdvanceTaskForClient(bcCtxTitle);
      // 媒体生成中（内存表，按当前用户+书名 key）
      const mk = mediaKey(bcCtxTitle);
      const mediaGenerating = imageGenTasks.has(mk);
      // 视觉任务运行中
      const vk = `${currentUser() ?? ""}::${bcCtxTitle}`;
      const vTasks = visualTasks.get(vk);
      const visualRunning = vTasks ? [...vTasks.values()].some((v) => v.status === "running") : false;
      // 待办清单（world 派生）
      const pendingProposals = (bcCtxW.characterProposals ?? []).filter((pp) => pp.status === "pending").length;
      const pendingCards = (bcCtxW.pendingCards ?? []).length;
      const openDebt = (bcCtxW.qualityDebt ?? []).filter((d) => d.status === "open").length;
      const reviseChapters = bcCtxW.chapters.filter((c) => c.review?.verdict === "revise").map((c) => c.index);
      return json({
        context: {
          autoRunning: bcCtxAuto?.status === "running",
          autoPhase: bcCtxAuto?.status === "running" ? bcCtxAuto?.phase : undefined,
          pendingCommit: bcCtxPending ? { index: bcCtxPending.chapterIndex ?? null, title: bcCtxPending.title ?? "" } : null,
          advanceTaskRunning: bcCtxTask?.status === "running",
          advancePhase: bcCtxTask?.status === "running" ? bcCtxTask?.phase : undefined,
          mediaGenerating,
          visualRunning,
          pendingProposals,
          pendingCards,
          openDebt,
          reviseChapters,
        },
      });
    }
    case "/api/brain/chat": {
      // 中枢对话编排（SSE，事件协议 v2）：意图识别 + 流式回复 + 卡片（查询直接执行 / 写操作预览 / L2·L3 确认卡）
      // 会话化：body 带 sessionId（历史会话）或新建；resume=true 续流未完成消息
      // 连接解耦：会话级任务注册表 —— 客户端断连不杀任务；刷新后新连接 attach 同一任务，
      // 先重放已生成文本（{type:"reset",text}）再收后续 delta，支撑“刷新恢复流式输出完成”
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const bcChatBody = await readBody(req);
      const bcChatTitle = String(bcChatBody.title ?? "").trim();
      const bcChatPrompt = String(bcChatBody.prompt ?? "").trim();
      const bcSessionId = String(bcChatBody.sessionId ?? "").trim();
      const bcResume = bcChatBody.resume === true;
      // attach-only（断线自动重连用）：只挂到已在运行的任务，无任务则立即结束流——绝不发起新回合（防重复生成）
      const bcAttach = bcChatBody.attach === true;
      // 前端上下文（左侧栏选中章等）：供意图识别参数提取兜底（需求 1/2）
      const bcCtx = (bcChatBody.ctx ?? null) as { chapterIndex?: number | null } | null;
      if (!bcChatTitle) return json({ error: "缺少 title" }, 400);
      if (!bcResume && !bcChatPrompt) return json({ error: "缺少 prompt" }, 400);
      if (!bcSessionId) return json({ error: "缺少 sessionId" }, 400);
      return sseStream(async (send) => {
        // 已有运行中任务（其他连接在流式）→ attach：先重放当前已生成文本，再收广播直到任务结束；
        // 结束后补发最终状态（done/interrupted）——任务收尾期 attach 的新连接可能错过已广播的 done，
        // 否则前端消息永久 pending（一直 loading），需刷新才能看到最新状态（需求 3 修复）
        const attached = attachSessionTask(bcChatTitle, bcSessionId, send);
        if (bcAttach && !attached) return; // attach-only 且任务已结束：直接收尾（前端查 detail 同步最终状态）
        if (attached) {
          const sess = getBrainSession(bcChatTitle, bcSessionId);
          const pending = sess ? lastPendingMessage(sess) : null;
          if (pending) send({ type: "reset", messageId: pending.id, text: pending.text });
          // 客户端已断开（req.signal abort）时立即退出，避免空轮询悬挂
          while (isSessionRunning(bcChatTitle, bcSessionId) && !req.signal.aborted) await Bun.sleep(300);
          // 收尾窗口兜底：任务已 done 但 running 仍 true 时 attach（无 pending 消息），
          // 或等待期结束时补发当前最后一条 assistant 消息的最终状态，防该连接错过 done 后永久 loading
          const sess2 = getBrainSession(bcChatTitle, bcSessionId);
          const last = sess2?.messages[sess2.messages.length - 1];
          if (last && last.role === "assistant" && !last.pending) {
            send(last.interrupted ? { type: "interrupted", messageId: last.id } : { type: "done", messageId: last.id });
          }
          return;
        }
        // 新回合：注册任务（req.signal 取消时 abort 任务），回合内 send 一律广播给会话全部连接
        const task = registerSessionTask(bcChatTitle, bcSessionId, send, req.signal);
        task.running = true;
        const broadcast = (obj: unknown) => broadcastToSession(bcChatTitle, bcSessionId, obj);
        try {
          await brainChatStream({ title: bcChatTitle, prompt: bcChatPrompt, sessionId: bcSessionId, send: broadcast, signal: req.signal, resume: bcResume, ctx: bcCtx ?? undefined });
        } finally {
          task.running = false;
          finishSessionTask(bcChatTitle, bcSessionId);
        }
      });
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
      const genre = body.genre ? String(body.genre) : undefined;
      try {
        // 异步立项：立即返回 taskId，后台跑完 5 个 LLM 调用（1-3 分钟）再落盘。
        // 前端据 taskId 轮询 /api/novel/new/status，列表接口合并 creating 占位——用户"点了就有反馈"，
        // 刷新列表也能看到生成中的书；不再同步阻塞 HTTP 请求（原实现最坏挂十几分钟）。
        const { id: taskId, created } = createNewStoryTask(idea, genre);
        if (created) {
          // 只有真正新建任务才启动后台执行；复用已有 running 时（created=false）不再启动，
          // 否则两个并发 newStory 写同一 taskId 互相覆盖终态（防重入状态管理硬约束）
          const username = currentUser();
          void (async () => {
            try {
              // 两段式立项：
              // 段 1（壳就绪）——立项主调用 + 落盘基础 world，随即 markReady；前端轮询到 ready
              // 立即进入三栏页面，角色视觉同步提前启动（角色已就绪，不等待蓝图）。
              const world = await runAsUser(username, () => director.newStoryCore(idea, genre));
              markNewStoryTaskReady(taskId, world.title);
              const fresh = world.characters.filter((c) => !(c.portrait?.path && c.image));
              for (const c of fresh) ensureCharacterVisuals(world.title, world, c);
              // 封面自动生成（fire-and-forget，与角色视觉并行）：新书封面随立绘/头像一起后台生成
              ensureCover(world.title, world);
              // 段 2（后台增强）——字段兜底 + 蓝图 + 首弧章节，逐阶段上报进度供前端构建徽章展示
              try {
                await runAsUser(username, async () => {
                  updateNewStoryTaskStage(taskId, "正在补全角色设定…");
                  await director.newStoryEnhance(world, idea);
                });
              } catch (e) {
                // 壳已就绪、增强失败：任务标 failed 但书名已在（前端页面内提示"世界已生成，增强未完成"，可手动重试蓝图）
                console.error("[api/novel/new] 后台立项增强失败:", e);
                failNewStoryTask(taskId, `世界已生成，但蓝图/章节增强失败（${errorDetail(e, "可在小说内手动生成")}）`);
                return;
              }
              completeNewStoryTask(taskId, world.title);
              console.log(`[api/novel/new] 立项完成: ${world.title}（task=${taskId}）`);
            } catch (e) {
              // 段 1 失败（壳未就绪）：任务 failed，前端列表占位卡提示失败。
              // 保留真实原因（ECONNRESET/超时/空内容等）供用户感知与诊断，不再笼统吞掉
              console.error("[api/novel/new] 后台立项失败:", e);
              failNewStoryTask(taskId, `立项失败：${errorDetail(e, "请稍后重试")}`);
            }
          })();
        }
        return json({ ok: true, taskId, created });
      } catch (e) {
        console.error("[api/novel/new]", e);
        return json({ error: "立项提交失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/new/status": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const id = String(body.taskId ?? "").trim();
      if (!id) return json({ error: "缺少 taskId" }, 400);
      const t = getNewStoryTask(id);
      if (!t) return json({ error: "任务不存在" }, 404);
      return json({ status: t.status, title: t.title, error: t.error, idea: t.idea, stage: t.stage });
    }

    case "/api/novel/state": {
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      // 锁内 load→自愈→save：与并发写章互斥，防读时自愈基于旧快照覆盖（可靠性）
      const w = await withTitleLock(slug(title), async () => {
        const w = loadWorld(title);
        if (!w) throw new AppError("故事不存在: " + title);
        // 自愈：出场角色重算 + 旧媒体迁移 + 一致性自动修复（幂等，旧书打开即治理），有变更则持久化
        let dirty = director.recomputeAppearedIn(w);
        if (migrateChapterMedia(w)) dirty = true;
        if (autoRepair(w).length) dirty = true;
        if (dirty) {
          applyStateChange(w, { actor: "system", commandId: "CMD-S08", field: "appearedIn", reason: "读时自愈：重算登场记录/媒体迁移/一致性修复", chapter: w.nextChapter });
          saveWorld(w);
        }
        return w;
      });
      // 读时自愈②：视觉缺失的角色 → 后台补头像+立绘（fire-and-forget，不阻塞打开）。
      // 触发条件：未自动尝试过，或上次尝试失败已过冷却期（visualTriedAt 防高频烧配额，也避免 dev 热重启丢任务后永久缺视觉）；
      // 前端据 visualPending 启动轮询，中枢显示「自动生成角色头像/立绘中…」，完成后刷新恢复待命
      const needy = w.characters.filter((c) => {
        if (c.portrait?.path && c.image) return false;
        if (!c.visualTriedAt) return true;
        return Date.now() - c.visualTriedAt > VISUAL_RETRY_COOLDOWN;
      });
      for (const c of needy) ensureCharacterVisuals(w.title, w, c);
      // 中枢四维状态（轻量：复用落盘 eval，不含完整性扫描——完整扫描见 /api/brain/state）
      const stSession = loadAutoSession(title);
      const stAutoRunning = stSession?.status === "running";
      const brainState = deriveBrainState(w, {
        busy: stAutoRunning,
        phase: stAutoRunning ? stSession?.phase : undefined,
        autoRunning: stAutoRunning,
        evalReport: readEvalReport(title),
      });
      return json({ world: sanitize(w), visualPending: needy.length > 0, brainState });
    }

    case "/api/novel/list": {
      // creating：进行中的异步立项任务（running 壳未就绪 + ready 壳已就绪仍在增强）。
      // 失败任务不进列表——失败即时 toast 提示即可，不残留卡片；status 端点仍可查终态
      return json({
        stories: listStoriesMeta(),
        creating: listActiveNewStoryTasks().map((t) => ({ id: t.id, idea: t.idea, genre: t.genre ?? "", status: t.status, title: t.title, createdAt: t.startedAt })),
      });
    }

    case "/api/novel/delete": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        // 先停该书运行态（自动连载/推进任务/暂存草稿），再锁内删除目录（与并发写章互斥，防删除后任务回写复活）
        const autoKey = `${currentUser() ?? ""}::${slug(title)}`;
        stopAuto(title);
        clearAutoSession(title);
        clearPendingChapter(title);
        clearAdvanceTask(title);
        // 同步清理该书关联的异步立项任务（running/ready/done 全清——书已删，任务无存在意义，防占位卡复活）
        removeNewStoryTaskByTitle(title);
        const ok = await withTitleLock(slug(title), async () => {
          if (!storyExists(title)) throw new AppError("故事不存在: " + title);
          return deleteStory(title);
        });
        activeAuto.delete(autoKey);
        // 该书正在后台生成的角色视觉任务：删除后无书可写，清理状态表（防 /visual/status 残留），
        // 并登记已删除标记让仍在锁外跑的任务在下一步写盘前自查（防向已删目录写孤儿媒体/继续烧配额）
        const delKey = `${currentUser() ?? ""}::${slug(title)}`;
        visualTasks.delete(delKey);
        deletedStories.add(delKey);
        setTimeout(() => deletedStories.delete(delKey), 30 * 60_000).unref?.();
        return json({ ok });
      } catch (e) {
        console.error("[api/novel/delete]", e);
        return json({ error: e instanceof AppError ? e.message : "删除失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/step": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const instruction = String(body.instruction ?? "").trim();
      // 任务持久化：刷新/关闭页面后可恢复状态；上一任务 running 且未陈旧时拒绝
      const stepWorld = loadWorld(title);
      if (!stepWorld) return json({ error: "故事不存在: " + title }, 404);
      const startRes = startAdvanceTask(title, stepWorld.nextChapter);
      if (!startRes.ok) return json({ error: startRes.reason ?? "任务已在运行" }, 409);
      return sseStream(async (send) => {
        // loadWorld 必须与修改/保存同锁，防止并发下基于旧快照覆盖
        try {
          const result = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            send({ phase: "start", nextChapter: w.nextChapter });
            return director.step(w, instruction, (e) => {
              send(e);
              // 阶段心跳：同步落盘 phase + updatedAt（前端断开后仍可恢复显示）
              if (e && typeof e === "object" && "phase" in e) updateAdvanceTaskPhase(title, String((e as { phase: string }).phase));
            }, { commitPolicy: genOf(w).commitPolicy ?? "auto" });
          });
          completeAdvanceTask(title, { chapterIndex: result.chapter.index, verdict: result.review?.verdict, rounds: result.rounds });
          send({ phase: "result", result: { chapter: result.chapter, review: result.review, rounds: result.rounds } });
        } catch (e) {
          // commitPolicy=confirm：审查通过后暂存待人工确认（非错误，前端弹确认条）
          if (e instanceof director.PendingCommitError) {
            completeAdvanceTask(title, { chapterIndex: e.chapterIndex, verdict: e.review?.verdict, rounds: e.review?.round, pendingCommit: true });
            send({ phase: "pending-commit", chapterIndex: e.chapterIndex, review: e.review });
            return;
          }
          failAdvanceTask(title, e instanceof AppError ? e.message : "推进失败，请重试");
          throw e;
        }
      });
    }

    case "/api/novel/step/status": {
      // 查询单章推进任务状态（前端刷新后恢复显示用）：陈旧 running 自动标记 failed
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      return json({ task: getAdvanceTaskForClient(title) });
    }

    case "/api/novel/step/clear": {
      // 前端已读取 done/failed 结果后清除任务文件（避免刷新重复提示）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      clearAdvanceTask(title);
      return json({ ok: true });
    }

    case "/api/novel/chapter/confirm": {
      // 确认入册（commitPolicy=confirm 通道）：消费暂存区待确认草稿 → 完整 commit 记账
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.confirmPendingChapter(w);
        });
        return json({ ok: true, world: sanitize(result.world), chapter: result.chapter, review: result.review });
      } catch (e) {
        console.error("[api/novel/chapter/confirm]", e);
        return json({ error: e instanceof AppError ? e.message : (e as Error).message ?? "确认入册失败" }, 502);
      }
    }

    case "/api/novel/chapter/reject": {
      // 放弃待确认草稿：清暂存区 + 记日志（不入册，章节号保留待重写）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const pending = loadPendingChapter(title);
          if (!pending?.pendingCommit) throw new AppError("暂存区没有待确认的章节");
          clearPendingChapter(title);
          steering.logChange(w, { chapter: pending.chapterIndex, actor: "user", kind: "chapter-reject", detail: `放弃第 ${pending.chapterIndex} 章待确认草稿《${pending.title}》（未入册，可重新推进）` });
          saveWorld(w);
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof AppError ? e.message : "放弃失败" }, e instanceof AppError ? 400 : 502);
      }
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
          // 最新已写章节号（add 默认埋设章 / update 手动回收章的默认回收章共用）
          const latestChapter = w.chapters.length ? Math.max(...w.chapters.map((c) => c.index)) : (w.nextChapter ?? 1);
          let fsDetail = "";
          if (action === "add") {
            const text = String(body.text ?? "").trim();
            if (!text) throw new AppError("伏笔内容不能为空");
            const id = `fs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            // 默认归属最新已写章节（手动登记属既有账目）；无章节时才落下一章（待埋设）
            const plantedAt = typeof body.plantedAt === "number" ? body.plantedAt : latestChapter;
            w.foreshadowing.push({ id, text, plantedAt, status: "planted", note: String(body.note ?? "") || undefined });
            fsDetail = `新增伏笔「${text.slice(0, 40)}」（埋设于第 ${plantedAt} 章）`;
          } else if (action === "update") {
            const id = String(body.id ?? "");
            const f = w.foreshadowing.find((x) => x.id === id);
            if (!f) throw new AppError("伏笔不存在: " + id);
            if (body.text !== undefined) f.text = String(body.text).trim();
            if (body.note !== undefined) f.note = String(body.note).trim() || undefined;
            if (body.status !== undefined) {
              const nextStatus = String(body.status) as "planted" | "active" | "resolved";
              f.status = nextStatus;
              // 状态联动回收章（数据一致性）：标为已回收 → 自动填当前最新已写章节；解除已回收 → 清除回收记录
              if (nextStatus === "resolved") f.resolvedAt = f.resolvedAt ?? latestChapter;
              else delete f.resolvedAt;
            }
            // 存量数据兜底：已是已回收但缺回收章的补齐（旧数据修复）
            if (f.status === "resolved" && f.resolvedAt == null) f.resolvedAt = latestChapter;
            fsDetail = `修改伏笔「${f.text.slice(0, 40)}」（${[body.text !== undefined ? "内容" : null, body.note !== undefined ? "备注" : null, body.status !== undefined ? `状态→${body.status}` : null].filter(Boolean).join("/") || "字段"}）`;
          } else if (action === "delete") {
            const id = String(body.id ?? "");
            const idx = w.foreshadowing.findIndex((x) => x.id === id);
            if (idx === -1) throw new AppError("伏笔不存在: " + id);
            const f = w.foreshadowing[idx];
            // 伏笔不允许放弃（用户决策）：已埋入正文的伏笔不可删除，需先回收为 resolved；待埋设/已回收可删
            if (f.status !== "resolved" && f.plantedAt < w.nextChapter) {
              throw new AppError("该伏笔已埋入正文，不可删除（需先回收为已解决）");
            }
            fsDetail = `删除伏笔「${f.text.slice(0, 40)}」（${f.status === "resolved" ? "已回收" : "未埋入"}）`;
            w.foreshadowing.splice(idx, 1);
          } else {
            throw new AppError("未知操作: " + action);
          }
          applyStateChange(w, { actor: "user", commandId: "CMD-L07", field: "foreshadowing", reason: fsDetail, chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          // 返回完整 world：alignWorld 修复/回收章联动等变更全部同步到前端，避免局部浅合并丢字段
          return { foreshadowing: w.foreshadowing, world: sanitize(w) };
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

    case "/api/novel/blueprint": {
      // 蓝图：生成候选 / 确认某套 / 编辑指南针与承诺（P3）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "generate");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          if (action === "generate") {
            const options = await buildBlueprint(w, body.hint ? String(body.hint).slice(0, 300) : undefined);
            w.blueprintOptions = options;
            applyStateChange(w, { actor: "user", commandId: "CMD-W02", field: "blueprintOptions", reason: "生成蓝图候选", chapter: w.nextChapter });
            finalizeStateChange(w, { ok: true });
            return { options };
          } else if (action === "confirm") {
            const idx = Number(body.optionIndex ?? 0);
            const options = (w.blueprintOptions ?? []) as BlueprintOption[];
            if (!options.length) throw new AppError("无蓝图候选，请先 generate");
            const opt = options[Math.max(0, Math.min(options.length - 1, idx))];
            await confirmBlueprint(w, opt);
            return { world: sanitize(w) };
          } else if (action === "edit") {
            if (!w.blueprint) throw new AppError("尚无蓝图");
            const patch = (body.patch ?? {}) as Record<string, unknown>;
            if (typeof patch.compass === "string") w.blueprint.compass = patch.compass.slice(0, 200);
            if (typeof patch.progressContract === "string") w.blueprint.progressContract = patch.progressContract.slice(0, 300);
            if (typeof patch.mainPlot === "string") w.blueprint.mainPlot = patch.mainPlot.slice(0, 400);
            if (typeof patch.ending === "string") w.blueprint.ending = patch.ending.slice(0, 300);
            applyStateChange(w, { actor: "user", commandId: "CMD-W04", field: "blueprint", reason: `编辑蓝图（${Object.keys(patch).filter((k) => ["compass", "progressContract", "mainPlot", "ending"].includes(k)).join("/") || "字段"}）`, chapter: w.nextChapter });
            finalizeStateChange(w, { ok: true });
            return { world: sanitize(w) };
          }
          throw new AppError("未知操作: " + action);
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/blueprint]", e);
        return json({ error: e instanceof AppError ? e.message : "蓝图操作失败" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/plans": {
      // 本章计划/弧：list 查看 / expand 手动展开弧 / edit 编辑未写本章计划（L1）（P3）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "list");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          if (action === "list") {
            return {
              blueprint: w.blueprint ?? null,
              volumes: w.blueprint?.volumes ?? [],
              arcs: w.storyArcs ?? [],
              plans: w.chapterPlans ?? [],
            };
          } else if (action === "expand") {
            const arcId = String(body.arcId ?? "");
            const arc = (w.storyArcs ?? []).find((a) => a.id === arcId || a.status === "skeleton");
            if (!arc) throw new AppError("无可展开的弧");
            const plans = await expandArc(w, arc.id);
            return { plans: w.chapterPlans ?? [], expanded: plans, arcs: w.storyArcs ?? [] };
          } else if (action === "edit") {
            const index = Number(body.index);
            if (!Number.isInteger(index) || index < w.nextChapter) throw new AppError("仅可编辑未写章节的本章计划");
            const plan = (w.chapterPlans ?? []).find((p) => p.index === index);
            if (!plan) throw new AppError("本章计划不存在: " + index);
            const patch = (body.patch ?? {}) as Record<string, unknown>;
            if (typeof patch.goal === "string") plan.goal = patch.goal.slice(0, 200);
            if (Array.isArray(patch.beats)) plan.beats = patch.beats.map(String).filter(Boolean).slice(0, 4).map((b) => b.slice(0, 120));
            if (typeof patch.hookType === "string") plan.hookType = patch.hookType as typeof plan.hookType;
            applyStateChange(w, { actor: "user", commandId: "CMD-W07", field: "chapterPlans", reason: `编辑第 ${index} 章本章计划（${Object.keys(patch).join("/") || "字段"}）`, chapter: index });
            finalizeStateChange(w, { ok: true });
            return { plans: w.chapterPlans ?? [] };
          }
          throw new AppError("未知操作: " + action);
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/plans]", e);
        return json({ error: e instanceof AppError ? e.message : "本章计划操作失败" }, e instanceof AppError ? 400 : 502);
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
        return json({ ok: true, world: sanitize(result.world), review: result.review, report: result.report });
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
            // 已废弃：世界书手动保存已合并到 /api/novel/world（设定面板单接口保存）；保留兼容
            w.lore = sanitizeLore(body.entries);
          } else {
            throw new AppError("未知操作: " + action);
          }
          applyStateChange(w, { actor: "user", commandId: "CMD-W14", field: "lore", reason: action === "auto" ? "自动重建世界书" : "保存世界书", chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return w.lore ?? [];
        });
        return json({ ok: true, entries });
      } catch (e) {
        console.error("[api/novel/lore]", e);
        return json({ error: e instanceof AppError ? e.message : "世界书保存失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/world": {
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const patch = {
            author: typeof body.author === "string" ? body.author : undefined,
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
            chapterTitle: Array.isArray(body.chapterTitle)
              ? (body.chapterTitle as { index: number; title: string }[])
              : undefined,
            lore: Array.isArray(body.lore) ? (body.lore as never[]) : undefined,
          };
          // 干预分级（P3.5）：L2 回溯变更未携带策略时，返回影响报告交前端三选一
          const level = steering.classifyWorldPatch(w, { characters: patch.characters as { id?: string }[] | undefined, setting: patch.setting as { rules?: string[] } | undefined });
          const charIds = ((patch.characters ?? []) as { id?: string }[]).map((c) => String(c?.id ?? "")).filter(Boolean);
          const change = { kind: "world-edit", detail: JSON.stringify({ premise: !!patch.premise, setting: !!patch.setting, characters: charIds.length }).slice(0, 200), characterIds: charIds };
          if (level === "L2" && !body.strategy) {
            const report = await steering.impactReport(w, change);
            return { needIntervention: true, report, change };
          }
          if (level === "L2" && body.strategy) {
            const strategy = String(body.strategy);
            if (strategy === "abort") {
              await steering.applyStrategy(w, change, "abort");
              return { world: sanitize(w), aborted: true };
            }
            // 确定性重算受影响章节（与 report 同逻辑，免再调 LLM）
            const affected = new Set<number>();
            for (const id of charIds) {
              const c = w.characters.find((x) => x.id === id);
              for (const ch of c?.appearedIn ?? []) affected.add(ch);
            }
            await steering.applyStrategy(w, change, strategy as "merge" | "rewrite", [...affected].sort((a, b) => a - b));
          }
          // 记录 status/look 手改的字段锁（用户决策④）：应用前检测哪些角色字段变了
          const statusChangedIds: string[] = [];
          const lookChangedIds: string[] = [];
          for (const pc of (patch.characters ?? []) as { id?: string; status?: string; look?: string }[]) {
            const target = pc?.id ? w.characters.find((c) => c.id === pc.id) : undefined;
            if (target && typeof pc.status === "string" && pc.status !== target.status) statusChangedIds.push(target.id);
            if (target && typeof pc.look === "string" && pc.look !== (target.look ?? "")) lookChangedIds.push(target.id);
          }
          const existingIds = new Set(w.characters.map((c) => c.id));
          const updated = director.editWorld(w, patch);
          for (const id of statusChangedIds) steering.setFieldLock(updated, id, "status", true);
          for (const id of lookChangedIds) steering.setFieldLock(updated, id, "look", true);
          // 账本确定性对齐（零 LLM）：登场重算 + 孤儿引用修复（角色改名传播已由 editWorld.applyRename 完成）
          const aligned = alignWorld(updated);
          // 手动新增角色：id 不在既有集合且 editWorld 已成功写入（重名会抛错，不会走到这）的为新增
          const newCharacterIds = ((patch.characters ?? []) as { id?: string }[])
            .map((pc) => String(pc?.id ?? ""))
            .filter((id) => id && !existingIds.has(id) && updated.characters.some((c) => c.id === id));
          // 书名修改：slug 变化时先改名存档目录（媒体/版本随目录整体迁移），再落盘新 title
          const bookTitle = typeof body.bookTitle === "string" ? body.bookTitle.trim().slice(0, 60) : undefined;
          if (bookTitle && bookTitle !== updated.title) {
            if (slug(bookTitle) !== slug(updated.title)) {
              if (storyExists(bookTitle)) throw new AppError("书名已存在，请换一个：" + bookTitle);
              renameSync(storyDir(updated.title), storyDir(bookTitle));
            }
            updated.title = bookTitle;
          }
          // 任何 patch 均落盘（含关系/改名/设定/大纲等；对齐修复随存）
          saveWorld(updated);
          return { world: sanitize(updated), autoFixed: aligned, newCharacterIds };
        });
        if ((out as { needIntervention?: boolean }).needIntervention) return json({ ok: false, ...out });
        // 手动新增角色自动生成头像+立绘（后台 fire-and-forget，不阻塞返回；前端轮询 /api/novel/visual/status，
        // 期间中枢显示「自动生成角色头像/立绘中…」，完成后操作日志留 CMD-M07/CMD-M08 记录）
        const newCharIds = (out as { newCharacterIds?: string[] }).newCharacterIds ?? [];
        const outWorld = (out as { world: unknown }).world as WorldState | undefined;
        if (newCharIds.length && outWorld) {
          for (const id of newCharIds) {
            const c = outWorld.characters.find((x) => x.id === id);
            if (c) ensureCharacterVisuals(outWorld.title, outWorld, c);
          }
        }
        return json({ ok: true, world: outWorld, aborted: (out as { aborted?: boolean }).aborted, autoFixed: (out as { autoFixed?: string[] }).autoFixed ?? [], visualPending: newCharIds.length > 0 });
      } catch (e) {
        console.error("[api/novel/world]", e);
        // 透传业务校验错误（角色重名/撞名等），前端可显示具体原因
        return json({ error: e instanceof AppError ? e.message : ((e as Error)?.message ?? "保存失败，请稍后重试") }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/intervene": {
      // 干预治理：report 影响评估 / apply 策略执行（针对非 world 入口的变更，如伏笔编辑）（P3.5）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "report");
      if (!title) return json({ error: "缺少 title" }, 400);
      if (action === "interrupt") {
        // 写作中提交干预：立即打断当前管线（未 commit 零污染）。
        // 注意：不入 title 锁（否则被写作回合阻塞，无法立即生效）（用户决策②）
        const item = steering.requestInterrupt(title, {
          kind: String(body.kind ?? "manual"),
          payload: { detail: String(body.detail ?? "").slice(0, 300) },
        });
        return json({ ok: true, interrupted: true, item });
      }
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const change = {
            kind: String(body.kind ?? "manual"),
            detail: String(body.detail ?? "").slice(0, 300),
            characterIds: Array.isArray(body.characterIds) ? body.characterIds.map(String) : undefined,
            foreshadowIds: Array.isArray(body.foreshadowIds) ? body.foreshadowIds.map(String) : undefined,
          };
          if (action === "report") return { report: await steering.impactReport(w, change) };
          if (action === "apply") {
            const strategy = String(body.strategy ?? "");
            if (!["merge", "rewrite", "abort"].includes(strategy)) throw new AppError("策略必须为 merge/rewrite/abort");
            const report = await steering.impactReport(w, change);
            const r = await steering.applyStrategy(w, change, strategy as "merge" | "rewrite" | "abort", report.affectedChapters);
            return { world: sanitize(w), ...r };
          }
          throw new AppError("未知操作: " + action);
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/intervene]", e);
        return json({ error: e instanceof AppError ? e.message : "干预处理失败" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/lock": {
      // 字段锁：人工上锁/解锁角色字段（chronicler 跳过锁定字段）（P3.5）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const characterId = String(body.characterId ?? "");
      const field = String(body.field ?? "");
      if (!title || !characterId || !field) return json({ error: "缺少参数" }, 400);
      try {
        const world = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          steering.setFieldLock(w, characterId, field, body.locked === true);
          applyStateChange(w, { actor: "user", commandId: "CMD-G03", field: "lockedFields", reason: `${body.locked === true ? "上锁" : "解锁"}角色字段 ${characterId}.${field}`, chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return sanitize(w);
        });
        return json({ ok: true, world });
      } catch (e) {
        console.error("[api/novel/lock]", e);
        return json({ error: e instanceof AppError ? e.message : "锁操作失败" }, 502);
      }
    }

    case "/api/novel/proposal-closed": {
      // 新角色提案区关闭状态（按用户 + 书名存服务端，SSR 首帧读库，刷新不闪现）
      const user = userFromRequest(req);
      if (!user) return json({ error: "未登录" }, 401);
      const query = new URL(req.url).searchParams;
      const title = String(body.title ?? query.get("title") ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      if (req.method === "POST") {
        const closed = body.closed === true;
        setPropClosed(user.id, title, closed);
        return json({ ok: true, closed });
      }
      return json({ closed: getPropClosed(user.id, title) });
    }

    case "/api/novel/proposal": {
      // 新角色提案：confirm 入册 / reject 拒绝（抽卡角色卡与 writer 新角色统一走此入口）（P3.5）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const proposalId = String(body.proposalId ?? "");
      const action = String(body.action ?? "confirm");
      if (!title || !proposalId) return json({ error: "缺少参数" }, 400);
      try {
        const world = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const p = (w.characterProposals ?? []).find((x) => x.id === proposalId);
          if (!p) throw new AppError("提案不存在");
          if (action === "confirm") {
            if (!w.characters.some((c) => c.name === p.name)) {
              w.characters.push({
                id: `c${Date.now().toString(36)}`,
                name: p.name,
                role: p.role || "配角",
                // 与立项一致：性别只接受「男/女」，非法值一律丢弃（面板无 AI 推断选项）
                gender: p.gender === "男" || p.gender === "女" ? p.gender : undefined,
                age: p.age,
                identity: p.identity,
                traits: p.traits,
                motivation: p.motivation,
                status: "待登场（提案确认）",
                relations: {},
                voice: p.voice,
                introducedAt: w.nextChapter,
              });
            }
            p.status = "confirmed";
            applyStateChange(w, { actor: "user", commandId: "CMD-L11", field: "characterProposals", reason: `确认新角色「${p.name}」入册`, chapter: w.nextChapter });
          } else {
            p.status = "rejected";
            applyStateChange(w, { actor: "user", commandId: "CMD-L11", field: "characterProposals", reason: `驳回新角色提案「${p.name}」`, chapter: w.nextChapter });
          }
          finalizeStateChange(w, { ok: true });
          return sanitize(w);
        });
        // 入册新角色自动生成头像+立绘（后台 fire-and-forget，不阻塞返回；前端轮询 /api/novel/visual/status，
        // 期间中枢显示「自动生成角色头像/立绘中…」，完成后操作日志留 CMD-M07/CMD-M08 记录）
        const confirmedNew = world.characters.filter(
          (c) => c.status === "待登场（提案确认）" && !(c.portrait?.path && c.image),
        );
        for (const c of confirmedNew) ensureCharacterVisuals(title, world, c);
        return json({ ok: true, world, visualPending: confirmedNew.length > 0 });
      } catch (e) {
        console.error("[api/novel/proposal]", e);
        return json({ error: e instanceof AppError ? e.message : "提案处理失败" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/changelog": {
      // 干预审计日志（只读）（P3.5）
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const w = loadWorld(title);
      if (!w) return json({ error: "故事不存在: " + title }, 404);
      return json({ ok: true, entries: w.changeLog ?? [] });
    }

    case "/api/novel/style": {
      // 风格仿写（P5）：从样章提取风格指纹，注入后续全部写作
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const sample = String(body.sample ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      if (sample.length < 100) return json({ error: "样章至少 100 字" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const fingerprint = await extractFingerprint(sample);
          if (!fingerprint) throw new AppError("指纹提取失败，请稍后重试");
          w.gen = { ...(w.gen ?? {}), styleSample: sample.slice(0, 2000), styleFingerprint: fingerprint };
          applyStateChange(w, { actor: "user", commandId: "CMD-W16", field: "gen", reason: `风格仿写：提取样章指纹注入全书（指纹 ${fingerprint.length} 字）`, chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return { world: sanitize(w), fingerprint };
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/style]", e);
        return json({ error: e instanceof AppError ? e.message : "风格提取失败" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/auto/start": {
      // 自动连载（git 式）：SSE 推进度（phase/delta/review/auto-status）；每章 commit；
      // 审查不通过 = commit 被拒 → 草稿进暂存区停下（重试/跳过由前端决策，见 /api/novel/auto/skip）；停下策略见 autorun.ts
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const lockKey = slug(title);
      const autoKey = `${currentUser() ?? ""}::${slug(title)}`;
      // 运行中守卫：同一用户同一书名同时只允许一个连载循环（防双跑重复写章/停止信号串扰）
      if (activeAuto.has(autoKey)) return json({ error: "该书自动连载已在运行中，请先停止" }, 409);
      // 会话恢复：暂停态（审查未过）继续 → 复用原目标与已写章数；running 说明后台恢复中，拒绝双跑
      const session = loadAutoSession(title);
      if (session?.status === "running") return json({ error: "该书自动连载已在后台运行中，请先停止" }, 409);
      const resumed = session?.status === "paused";
      const maxChapters = Math.max(1, Math.min(Number(body.maxChapters) || (resumed ? session?.target ?? 3 : 3), 30));
      const initialWritten = resumed ? (session?.written ?? 0) : 0;
      const stopAvgScore = typeof body.stopAvgScore === "number" ? body.stopAvgScore : undefined;
      const autoGacha = typeof body.autoGacha === "boolean" ? body.autoGacha : undefined;
      const rawEvalEvery = Number(body.runEvalEvery);
      const runEvalEvery = Number.isInteger(rawEvalEvery) && rawEvalEvery >= 0 ? Math.min(rawEvalEvery, 50) : undefined;
      activeAuto.add(autoKey);
      // 原 autoGacha 值：运行结束后还原（修：临时覆盖不得持久化污染后续手动写作）
      const savedAutoGacha = (() => { const w = loadWorld(title); return w?.gen?.autoGacha; })();
      return sseStream(async (send) => {
        try {
          // 断点恢复（修 D6）：崩溃窗口（章节已落盘但 nextChapter 未推进）→ 修正计数后从断点续跑
          let resumedFrom: number | null = null;
          await withTitleLock(lockKey, async () => {
            const w = loadWorld(title);
            if (w) {
              const maxIdx = w.chapters.reduce((m, c) => Math.max(m, c.index), 0);
              if (w.nextChapter <= maxIdx) {
                w.nextChapter = maxIdx + 1;
                saveWorld(w);
                resumedFrom = maxIdx;
              }
            }
          });
          if (resumedFrom !== null) {
            send({ auto: true, phase: "auto-status", written: initialWritten, reason: "resumed", resumedFrom });
          }
          const report = await runAuto(
            title,
            { maxChapters, stopAvgScore, autoGacha, runEvalEvery, execRetry: buildAutoExecRetry(lockKey, title) },
            // 每章在锁内重新加载最新世界（杜绝旧快照覆盖）；autoGacha 临时覆盖仅作用本章；requirePass：审查不通过不 commit
            (_w, onEvent) => withTitleLock(lockKey, async () => {
              const fresh = loadWorld(title);
              if (!fresh) throw new AppError("故事不存在: " + title);
              if (autoGacha !== undefined && fresh.gen) fresh.gen.autoGacha = autoGacha;
              return director.writeOneChapter(fresh, "", onEvent, null, { requirePass: true });
            }),
            () => loadWorld(title),
            (e) => send(e),
            initialWritten,
          );
          send({ phase: "auto-done", report });
        } finally {
          // 还原 autoGacha 临时覆盖（锁内短事务，保证持久化一致）
          if (autoGacha !== undefined) {
            await withTitleLock(lockKey, async () => {
              const w = loadWorld(title);
              if (w?.gen) {
                w.gen.autoGacha = savedAutoGacha;
                saveWorld(w);
              }
            });
          }
          // 释放活跃运行守卫（run 生命周期结束）
          activeAuto.delete(autoKey);
        }
      });
    }

    case "/api/novel/auto/stop": {
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      stopAuto(title);
      return json({ ok: true });
    }

    case "/api/novel/auto/pause": {
      // 用户主动暂停：置暂停标志，连载在章边界停下并保持 paused 会话（重新 start 即恢复）
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      pauseAuto(title);
      return json({ ok: true });
    }

    case "/api/novel/auto/status": {
      // 会话与暂存区查询（前端刷新恢复 / 进度轮询）
      const url = new URL(req.url, "http://localhost");
      const title = String(url.searchParams.get("title") ?? body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      return json({ ok: true, session: loadAutoSession(title), pending: loadPendingChapter(title) });
    }

    case "/api/novel/auto/skip": {
      // 跳过暂存区章节（git：放弃该章工作区）：清草稿 + 删未核销本章计划 + nextChapter 前移（章节号空洞由 integrity 支持）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        await withTitleLock(slug(title), async () => {
          const pending = loadPendingChapter(title);
          if (!pending) throw new AppError("暂存区为空，没有可跳过的章节");
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          clearPendingChapter(title);
          const plans = w.chapterPlans ?? [];
          const pi = plans.findIndex((p) => p.index === pending.chapterIndex && p.status === "planned");
          if (pi >= 0) plans.splice(pi, 1);
          if (w.nextChapter <= pending.chapterIndex) w.nextChapter = pending.chapterIndex + 1;
          applyStateChange(w, { actor: "user", commandId: "CMD-N14", field: "chapterPlans", reason: `跳过第 ${pending.chapterIndex} 章暂存草稿`, chapter: pending.chapterIndex });
          finalizeStateChange(w, { ok: true });
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof AppError ? e.message : "跳过失败" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/auto/clear-session": {
      // 关闭/放弃会话：清理会话状态与暂存区（已结束或已暂停的会话；running 由停止接口处理）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      clearAutoSession(title);
      clearPendingChapter(title);
      return json({ ok: true });
    }

    case "/api/novel/chapter/resettle": {
      // 账本重结算（修复旧存档无变更快照/删除章节后角色状态残留）：以现存正文重新记账，
      // 覆盖本章摘要/伏笔/角色状态/时间线/当前状态，并补写 delta 快照（git 式恢复基础）；不动正文、不重写
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.index);
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ch = w.chapters.find((c) => c.index === index);
          if (!ch) throw new AppError("章节不存在");
          const report = await settleChapter(w, ch, (w.chapterPlans ?? []).find((p) => p.index === index) ?? null);
          w.chapterDeltas = { ...(w.chapterDeltas ?? {}), [index]: report.delta };
          applyStateChange(w, { actor: "user", commandId: "CMD-L03", field: "chapterDeltas", reason: `重结算第 ${index} 章《${ch.title}》账本（摘要/伏笔/角色状态/时间线覆盖式重算）`, chapter: index });
          finalizeStateChange(w, { ok: true });
          return { world: sanitize(w), report };
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/chapter/resettle]", e);
        return json({ error: e instanceof AppError ? e.message : "重结算失败，请稍后重试" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/rewrite": {
      // 回溯重写队列消费（P3.5）：按序逐章重生成受影响章节，完成后清空队列（失败即停、剩余保留）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "start");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          if (action === "clear") {
            w.rewriteQueue = [];
            applyStateChange(w, { actor: "user", commandId: "CMD-G07", field: "rewriteQueue", reason: "清空回溯重写队列", chapter: w.nextChapter });
            finalizeStateChange(w, { ok: true });
            return { rewritten: 0, world: sanitize(w) };
          }
          const queue = (w.rewriteQueue ?? []).filter((i) => i >= 1 && i < w.nextChapter).sort((a, b) => a - b);
          let rewritten = 0;
          for (const i of queue) {
            try {
              await director.regenerateChapter(w, i, "按回溯重写队列重写，保持既定事实一致");
              rewritten++;
            } catch {
              break; // 单章失败即停（含干预打断），剩余保留在队列
            }
          }
          w.rewriteQueue = [];
          applyStateChange(w, { actor: "user", commandId: "CMD-G06", field: "rewriteQueue", reason: `回溯重写队列消费完成（重写 ${rewritten} 章）`, chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return { rewritten, world: sanitize(w) };
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/rewrite]", e);
        return json({ error: e instanceof AppError ? e.message : "重写失败，请稍后重试" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/eval": {
      // 整书 8 维评估（P4，WebNovelBench 式 LLM-as-Judge）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const w = loadWorld(title);
        if (!w) throw new AppError("故事不存在: " + title);
        const range = Array.isArray(body.range) && body.range.length === 2 ? ([Number(body.range[0]), Number(body.range[1])] as [number, number]) : undefined;
        // 内容指纹未变则复用上次结果（cached=true）；force=true 强制重新评估
        const { report, cached } = await evaluateBookCached(w, range, body.force === true);
        return json({ ok: true, report, cached });
      } catch (e) {
        console.error("[api/novel/eval]", e);
        return json({ error: e instanceof AppError ? e.message : "评估失败，请稍后重试" }, e instanceof AppError ? 400 : 502);
      }
    }

    case "/api/novel/debt": {
      // 质量债务：list / fix（注入修复任务到下章弥合）/ ignore（P4）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "list");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        const out = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const debt = w.qualityDebt ?? [];
          if (action === "list") return { debt };
          const id = String(body.id ?? "");
          const item = debt.find((d) => d.id === id);
          if (!item) throw new AppError("债务不存在: " + id);
          if (action === "ignore") {
            item.status = "ignored";
          } else if (action === "fix") {
            item.status = "fixed";
            // 注入修复任务到下一章本章计划的弥合列表
            const nextPlan = (w.chapterPlans ?? []).find((p) => p.status === "planned");
            const task = `修复质量债务（第${item.chapterIndex}章[${item.lens}]）：${item.issue}`;
            if (nextPlan) nextPlan.mergeTasks = [...(nextPlan.mergeTasks ?? []), task].slice(0, 3);
            else w.outline = [task, ...(w.outline ?? [])].slice(0, 10);
          } else {
            throw new AppError("未知操作: " + action);
          }
          applyStateChange(w, { actor: "user", commandId: "CMD-L13", field: "qualityDebt", reason: `质量债务${action === "fix" ? "修复（注入下一章弥合任务）" : "忽略"}：第${item.chapterIndex}章[${item.lens}]${item.issue.slice(0, 60)}`, chapter: item.chapterIndex });
          finalizeStateChange(w, { ok: true });
          return { debt: w.qualityDebt ?? [], world: sanitize(w) };
        });
        return json({ ok: true, ...out });
      } catch (e) {
        console.error("[api/novel/debt]", e);
        return json({ error: e instanceof AppError ? e.message : "债务操作失败" }, e instanceof AppError ? 400 : 502);
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
          let path = "";
          let oldRel = ""; // 旧文件路径（重生成/替换后锁外删盘，避免本地残留）
          if (kind === "cover") {
            // A4 纸张宽高比 (210:297 ≈ 1:1.414)；中文提示词（与全书风格统一）
            prompt = userPrompt || `${w.title}（${w.genre}）小说封面：${w.setting.tone}，${w.setting.time}，${w.setting.place}，电影感光影，戏剧性构图，细节丰富的插画，画面中不要出现文字，无水印`;
            const buf = await generateImage(prompt, "768x1086");
            // Bun 图片压缩：等比缩到 A4 尺寸 + JPEG q82，体积降 ~90%（与自动封面/立绘一致）
            const compressed = await compressToJpeg(buf, 768, 1086);
            path = saveImage(title, `cover-${Date.now().toString(36)}.jpg`, compressed);
            oldRel = w.cover ?? "";
            w.cover = path;
          } else {
            // 角色头像：仅供用户查看，中文提示词 + 全书画风锚点 + 小体积 JPEG；
            // 头像先于立绘生成（纯文生，是立绘的容貌基准），不依赖立绘
            const cid = String(body.characterId ?? "");
            const c = w.characters.find((x) => x.id === cid);
            if (!c) throw new AppError("角色不存在");
            const avatar = await generateCharacterAvatar(title, w, c);
            path = avatar.path;
            prompt = avatar.prompt;
            oldRel = c.image ?? "";
            c.image = path;
          }
          applyStateChange(w, { actor: "user", commandId: kind === "cover" ? "CMD-M09" : "CMD-M08", field: kind === "cover" ? "cover" : "characters", reason: kind === "cover" ? "生成小说封面" : "生成角色头像", chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return { path, prompt, oldRel };
        });
        // 重生成/替换：删旧文件（与新文件不同路径时；best-effort，引用守卫在 deleteMediaFile 内）
        if (result.oldRel && result.oldRel !== result.path) deleteMediaFile(title, result.oldRel);
        return json({ ok: true, path: result.path, prompt: result.prompt });
      } catch (e) {
        console.error("[api/novel/image]", e);
        return json({ error: e instanceof AppError ? e.message : "图像生成失败（Agnes 云端不可用且本地回退失败），请稍后重试" }, 502);
      }
    }

    case "/api/novel/character/portrait": {
      // 角色全局立绘：生成/重新生成（可选 description 外貌描述；中文提示词 + 全书画风锚点，立绘以头像为容貌基准，自身是插画图生图参考图与视频 i2v 首帧的基准）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const characterId = String(body.characterId ?? "").trim();
      const description = body.description ? String(body.description).slice(0, 300) : undefined;
      if (!title || !characterId) return json({ error: "缺少参数" }, 400);
      try {
        const w0 = loadWorld(title);
        if (!w0) return json({ error: "故事不存在: " + title }, 404);
        const c0 = w0.characters.find((x) => x.id === characterId);
        if (!c0) return json({ error: "角色不存在" }, 404);
        // 立绘必须参考头像（渠道单一）：无头像时明确提示先生成头像，不降级纯文生
        if (!c0.image) return json({ error: `角色「${c0.name}」还没有头像，请先 AI 生成头像（立绘必须以头像为参考）` }, 400);
        const oldPortraitPath = c0.portrait?.path; // 旧立绘文件（重生成后锁外删盘，避免本地残留）
        // 锁外生成（耗时生图不持锁），锁内短事务落盘 portrait；立绘以头像为参考图，保证立绘与头像容貌一致
        const portrait = await generateCharacterPortrait(title, w0, c0, {
          description,
          refImage: mediaDataUri(title, { id: "", kind: "image", anchor: c0.name, path: c0.image, status: "ready" }),
        });
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const c = w?.characters.find((x) => x.id === characterId);
          if (w && c) {
            c.portrait = portrait;
            applyStateChange(w, { actor: "user", commandId: "CMD-M07", field: "characters", reason: `生成立绘（${c.name}）`, chapter: w.nextChapter });
            finalizeStateChange(w, { ok: true });
          }
        });
        // 重生成：删旧立绘文件（与新文件不同路径时；best-effort，引用守卫在 deleteMediaFile 内）
        if (oldPortraitPath && oldPortraitPath !== portrait.path) deleteMediaFile(title, oldPortraitPath);
        return json({ ok: true, portrait });
      } catch (e) {
        console.error("[api/novel/character/portrait]", e);
        return json({ error: e instanceof AppError ? e.message : "生成立绘失败，请稍后重试" }, 502);
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
      // 按确认的场景生成媒体：image/video 均锁外生成、锁内短事务追加（对齐，避免长时间持锁阻塞写作）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const kind = String(body.kind ?? "image");
      const scenes = Array.isArray(body.scenes) ? (body.scenes as { anchor?: string; scene?: string; caption?: string; type?: string; subject?: string }[]) : [];
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      const valid = scenes
        .filter((s) => s?.anchor?.trim() && s?.scene?.trim())
        .map((s) => ({
          anchor: String(s.anchor).trim(),
          scene: String(s.scene).trim(),
          caption: String(s.caption ?? "").trim(),
          type: String(s.type ?? "").trim(),
          subject: String(s.subject ?? "").trim(),
        }));
      if (!valid.length) return json({ error: "缺少有效的场景" }, 400);
      try {
        if (kind === "video") {
          const scene = valid[0];
          const sceneType = scene.type === "人物" || scene.type === "场景" || scene.type === "事件" ? scene.type : "事件";
          const w0 = loadWorld(title);
          if (!w0) return json({ error: "故事不存在: " + title }, 404);
          // i2v 优先：首帧级联查找（同段落锚点插画 → 场景主体角色全局立绘 → 跨章角色插画）；
          // 无图时后台补立绘并直接 t2v（不阻塞视频创建，立绘完成后下次自动 i2v）
          const firstImg = findVideoFirstFrame(w0, idx, scene.anchor, scene.subject || undefined);
          schedulePortraitFor(title, w0, scene.anchor);
          const firstFrame = firstImg ? mediaDataUri(title, firstImg) : undefined;
          let media: ChapterMedia;
          const charHint = charHintFor(w0, scene.subject);
          try {
            media = await createSceneVideo(scene.scene, scene.anchor, { image: firstFrame, caption: scene.caption, sceneType, styleAnchor: styleAnchor(w0), charHint, roster: w0.characters.map((c) => c.name) });
          } catch (e) {
            if (firstFrame) {
              console.warn("[media/generate] i2v 失败，回退 t2v:", (e as Error).message);
              media = await createSceneVideo(scene.scene, scene.anchor, { caption: scene.caption, sceneType, styleAnchor: styleAnchor(w0), charHint, roster: w0.characters.map((c) => c.name) });
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
            touchChapter(w, idx);
            applyStateChange(w, { actor: "user", commandId: "CMD-M03", field: "chapters[].media", reason: `生成第 ${idx} 章视频（${(media.caption ?? "").slice(0, 40) || media.anchor.slice(0, 20)}）`, chapter: idx });
            saveWorld(w);
          });
          return json({ ok: true, mediaId: media.id, videoId: media.videoId, mode: firstFrame ? "i2v" : "t2v" });
        }
        // image：异步生成——锁内先落 pending 条目（刷新/中断可恢复轮询），锁外并行生成，完成后锁内更新 ready/failed；
        // 不阻塞请求：立即返回 mediaIds，前端轮询 /media/status
        const w0 = loadWorld(title);
        if (!w0) return json({ error: "故事不存在: " + title }, 404);
        // 插画数量上限校验（用户确认：每章最多 3 张，超限需先删除）
        const existingImgs = (w0.chapters.find((x) => x.index === idx)?.media ?? []).filter((m) => m.kind === "image").length;
        const toAdd = valid.slice(0, 3);
        if (existingImgs + toAdd.length > MAX_IMAGES_PER_CHAPTER) {
          return json({ error: `本章已有 ${existingImgs} 张插画，上限 ${MAX_IMAGES_PER_CHAPTER} 张，请先删除部分插画后再生成` }, 400);
        }
        const style = styleAnchor(w0);
        // ① 锁内：创建 pending 条目并落盘（含 subject/最终 prompt 前缀；生成完成后覆盖 prompt 为最终值）
        const created = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ch = w.chapters.find((x) => x.index === idx);
          if (!ch) throw new AppError("章节不存在");
          const items: ChapterMedia[] = toAdd.map((s) => {
            const sceneType = s.type === "人物" || s.type === "场景" || s.type === "事件" ? s.type : "事件";
            return {
              id: mediaId(),
              kind: "image" as const,
              anchor: s.anchor,
              prompt: s.scene,
              caption: s.caption || undefined,
              sceneType,
              subject: s.subject || undefined,
              status: "pending" as const,
            };
          });
          ch.media = [...(ch.media ?? []), ...items];
          touchChapter(w, idx);
          applyStateChange(w, { actor: "user", commandId: "CMD-M02", field: "chapters[].media", reason: `创建第 ${idx} 章插画任务（${items.length} 张）`, chapter: idx });
          saveWorld(w);
          return items;
        });
        // ② 锁外并行生成（多张并发 + 429 限流重试一次；失败不阻塞其余张），完成后锁内更新
        const t0 = Date.now();
        void (async () => {
          let ok = 0;
          await Promise.allSettled(created.map(async (item, i) => {
            const s = toAdd[i];
            imageGenTasks.set(mediaKey(item.id), true);
            try {
              // 参考图级联：主体角色立绘绝对优先 → 跨章角色插画（仅用已就绪图）；角色无任何图时后台补立绘，不阻塞本次插画
              const ref = findCharacterRef(w0, idx, s.anchor, s.subject || undefined);
              schedulePortraitFor(title, w0, s.anchor);
              let media: ChapterMedia | undefined;
              for (let attempt = 0; ; attempt++) {
                try {
                  media = await generateSceneImage(title, s.scene, s.anchor, {
                    caption: s.caption, sceneType: item.sceneType, styleAnchor: style,
                    refImage: ref ? mediaDataUri(title, ref) : undefined,
                    charHint: charHintFor(w0, s.subject),
                    roster: w0.characters.map((c) => c.name),
                  });
                  break;
                } catch (e) {
                  const st = (e as { status?: number }).status;
                  if (st === 429 && attempt === 0) {
                    console.warn("[media/generate] 生图 429 限流，4s 后重试:", s.anchor.slice(0, 20));
                    await Bun.sleep(4000);
                    continue;
                  }
                  throw e;
                }
              }
              await withTitleLock(slug(title), async () => {
                const w = loadWorld(title);
                const ch = w?.chapters.find((x) => x.index === idx);
                const m = (ch?.media ?? []).find((x) => x.id === item.id);
                if (!w || !m || !media) {
                  // 媒体/章节已被删：丢弃产物并删盘刚生成的文件，避免孤儿残留
                  if (media?.path) deleteMediaFile(title, media.path);
                  return;
                }
                m.path = media.path;
                m.prompt = media.prompt;
                m.status = "ready";
                m.error = undefined;
                touchChapter(w, idx);
                applyStateChange(w, { actor: "user", commandId: "CMD-M02", field: "chapters[].media", reason: `第 ${idx} 章插画生成完成（${item.id}）`, chapter: idx });
                saveWorld(w);
              });
              ok++;
            } catch (e) {
              console.warn(`[media/generate] 插画生成失败（${item.id}）:`, (e as Error).message);
              await withTitleLock(slug(title), async () => {
                const w = loadWorld(title);
                const ch = w?.chapters.find((x) => x.index === idx);
                const m = (ch?.media ?? []).find((x) => x.id === item.id);
                if (w && m && m.status === "pending") {
                  m.status = "failed";
                  m.error = (e as Error).message;
                  touchChapter(w, idx);
                  applyStateChange(w, { actor: "user", commandId: "CMD-M02", field: "chapters[].media", reason: `第 ${idx} 章插画生成失败（${item.id}）：${(e as Error).message.slice(0, 60)}`, chapter: idx });
                  saveWorld(w);
                }
              });
            } finally {
              imageGenTasks.delete(mediaKey(item.id));
            }
          }));
          console.log(`[media/generate] 插画后台完成 ${ok}/${created.length}，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        })();
        return json({ ok: true, mediaIds: created.map((x) => x.id) });
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
      if (!media.videoId) {
        // 插画（或异常媒体）：ready/failed 直接返回；pending 查内存任务表区分生成中与中断
        if (media.status === "failed") return json({ ok: true, status: "failed", error: media.error ?? "插画生成失败" });
        if (media.status === "pending") {
          if (imageGenTasks.has(mediaKey(mediaId))) return json({ ok: true, status: "pending", progress: 0 });
          // 服务重启/进程中断：标记 failed，前端提示重新生成
          await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            const ch = w?.chapters.find((x) => x.index === idx);
            const m = (ch?.media ?? []).find((x) => x.id === mediaId);
            if (w && m && m.status === "pending") {
              m.status = "failed";
              m.error = "生成任务已中断（服务重启），请删除后重新生成";
              touchChapter(w, idx);
              applyStateChange(w, { actor: "system", commandId: "CMD-M04", field: "chapters[].media", reason: `第 ${idx} 章媒体任务中断标记 failed（${mediaId}）`, chapter: idx });
              saveWorld(w);
            }
          });
          return json({ ok: true, status: "failed", error: "生成任务已中断（服务重启），请删除后重新生成" });
        }
        return json({ ok: true, status: media.status ?? "failed", error: "无视频任务" });
      }
      // 视频超时回收：pending 超过 30 分钟（视频正常 5-15s）→ 标记 failed，避免永久 pending
      if (media.status === "pending" && media.createdAt && Date.now() - media.createdAt > 30 * 60_000) {
        await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const ch = w?.chapters.find((x) => x.index === idx);
          const m = (ch?.media ?? []).find((x) => x.id === mediaId);
          if (w && m && m.status === "pending") {
            m.status = "failed";
            m.error = "视频生成超时（超过 30 分钟），请删除后重新生成";
            touchChapter(w, idx);
            applyStateChange(w, { actor: "system", commandId: "CMD-M04", field: "chapters[].media", reason: `第 ${idx} 章视频超时标记 failed（${mediaId}）`, chapter: idx });
            saveWorld(w);
          }
        });
        return json({ ok: true, status: "failed", error: "视频生成超时（超过 30 分钟），请删除后重新生成" });
      }
      try {
        const st = await pollVideoTask(media.videoId);
        if (st.status === "rate_limited") return json({ ok: true, status: "pending", progress: -1, rateLimited: true });
        if (st.status === "failed") {
          await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            const ch = w?.chapters.find((x) => x.index === idx);
            const m = (ch?.media ?? []).find((x) => x.id === mediaId);
            if (m) m.status = "failed";
            if (w) {
              applyStateChange(w, { actor: "user", commandId: "CMD-M04", field: "chapters[].media", reason: `第 ${idx} 章视频生成失败（${mediaId}）：${st.error ?? ""}`, chapter: idx });
              saveWorld(w);
            }
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
            // 时间戳文件名（cache-bust）：重生成后浏览器不会命中旧缓存
            const rel = saveVideo(title, `${mediaId}-${Date.now().toString(36)}.mp4`, buf);
            m.path = rel;
            m.status = "ready";
            touchChapter(w, idx);
            applyStateChange(w, { actor: "user", commandId: "CMD-M04", field: "chapters[].media", reason: `第 ${idx} 章视频生成完成（${mediaId}）`, chapter: idx });
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

    case "/api/novel/visual/status": {
      // 角色头像/立绘自动生成任务状态（立项 / 确认入册 / 手动新增 / 读时自愈 / 中枢巡检后，前端轮询此端点）：
      // pending 非空 = 生成中（中枢显示忙碌）；为空 = 全部结束（前端刷新世界、中枢恢复待命）；
      // failed 带原因返回一次（操作日志另有 visual-fail 留痕），前端据此区分「成功/失败」提示
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      if (!title) return json({ error: "缺少 title" }, 400);
      const tKey = `${currentUser() ?? ""}::${slug(title)}`;
      const tasks = visualTasks.get(tKey);
      const entries = [...(tasks?.entries() ?? [])];
      const w = loadWorld(title);
      // 以落盘状态为准：任务表中 running 但视觉已完整（生成刚完成/落盘与任务表暂不一致）视为完成
      const pending = entries
        .filter(([, v]) => v.status === "running")
        .map(([id]) => w?.characters.find((c) => c.id === id))
        .filter((c): c is WorldCharacter => !!c && !(c.portrait?.path && c.image))
        .map((c) => ({ id: c.id, name: c.name }));
      const failed = entries
        .filter(([, v]) => v.status === "failed")
        .map(([id, v]) => ({ id, name: w?.characters.find((c) => c.id === id)?.name ?? id, reason: v.reason ?? "" }));
      const done = entries.filter(([, v]) => v.status === "done").length;
      // 任务全部结束（无 running）→ 清表（failed/done 随本次响应返回一次）
      if (entries.length && !entries.some(([, v]) => v.status === "running")) visualTasks.delete(tKey);
      return json({ ok: true, pending, failed, done, count: pending.length });
    }

    case "/api/novel/media/regenerate": {
      // 单张改词重生成（原地替换，id/anchor/kind/sceneType 不变 → 段落定位与轮询零改动）
      // 模式：锁内短事务取快照 → 锁外生成 → 锁内短事务交换 → 锁外删旧文件
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const mediaId = String(body.mediaId ?? "").trim();
      const newPrompt = String(body.prompt ?? "").trim().slice(0, 1200);
      if (!title || !mediaId) return json({ error: "缺少参数" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      if (regenBusy.has(mediaKey(mediaId))) return json({ error: "该媒体正在重生成中，请稍候" }, 409);
      try {
        // ① 锁内短事务：校验存在 + 记录快照（oldPath/oldPrompt）
        const snap = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ch = w.chapters.find((x) => x.index === idx);
          if (!ch) throw new AppError("章节不存在");
          const m = (ch.media ?? []).find((x) => x.id === mediaId);
          if (!m) throw new AppError("媒体不存在");
          const finalPrompt = newPrompt || m.prompt || "";
          if (!finalPrompt.trim()) throw new AppError("提示词不能为空");
          return { kind: m.kind, anchor: m.anchor, oldPath: m.path, prompt: finalPrompt, style: styleAnchor(w), caption: m.caption, sceneType: m.sceneType, subject: m.subject };
        });
        regenBusy.add(mediaKey(mediaId));
        let newMedia: ChapterMedia;
        try {
          // ② 锁外生成（耗时操作不持锁）
          if (snap.kind === "image") {
            const w0 = loadWorld(title);
            const ref = w0 ? findCharacterRef(w0, idx, snap.anchor, snap.subject) : undefined;
            if (w0) schedulePortraitFor(title, w0, snap.anchor); // 后台补立绘，不阻塞本次重生成
            newMedia = await generateSceneImage(title, snap.prompt, snap.anchor, {
              caption: snap.caption, sceneType: snap.sceneType, styleAnchor: snap.style,
              refImage: ref && ref.path !== snap.oldPath ? mediaDataUri(title, ref) : undefined,
              charHint: w0 ? charHintFor(w0, snap.subject) : undefined,
              roster: w0 ? w0.characters.map((c) => c.name) : undefined,
            });
          } else {
            const w0 = loadWorld(title);
            let firstFrame: string | undefined;
            if (w0) {
              const fi = findVideoFirstFrame(w0, idx, snap.anchor, snap.subject);
              schedulePortraitFor(title, w0, snap.anchor); // 后台补立绘，不阻塞视频创建
              firstFrame = fi && fi.path !== snap.oldPath ? mediaDataUri(title, fi) : undefined;
            }
            try {
              newMedia = await createSceneVideo(snap.prompt, snap.anchor, { image: firstFrame, caption: snap.caption, sceneType: snap.sceneType, styleAnchor: snap.style, charHint: w0 ? charHintFor(w0, snap.subject) : undefined, roster: w0 ? w0.characters.map((c) => c.name) : undefined });
            } catch (e) {
              if (firstFrame) {
                console.warn("[media/regenerate] i2v 失败，回退 t2v:", (e as Error).message);
                newMedia = await createSceneVideo(snap.prompt, snap.anchor, { caption: snap.caption, sceneType: snap.sceneType, styleAnchor: snap.style, charHint: w0 ? charHintFor(w0, snap.subject) : undefined, roster: w0 ? w0.characters.map((c) => c.name) : undefined });
              } else {
                throw e;
              }
            }
          }
        } catch (e) {
          regenBusy.delete(mediaKey(mediaId));
          throw e;
        }
        // ③ 锁内短事务：按 mediaId 重新定位（防期间被删/回滚）后交换
        const swapped = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          const ch = w?.chapters.find((x) => x.index === idx);
          const m = (ch?.media ?? []).find((x) => x.id === mediaId);
          if (!w || !m) return false; // 媒体已被删除：丢弃新产物，不污染存档
          m.prompt = snap.prompt;
          if (snap.kind === "image") {
            m.path = newMedia.path;
            m.status = "ready";
          } else {
            m.videoId = newMedia.videoId;
            m.path = undefined;
            m.status = "pending";
          }
          steering.logChange(w, { chapter: idx, actor: "user", kind: "media-regenerate", detail: `改词重生成第 ${idx} 章${snap.kind === "image" ? "插画" : "视频"}：${(snap.prompt ?? "").slice(0, 60)}` });
          touchChapter(w, idx);
          applyStateChange(w, { actor: "user", commandId: "CMD-M05", field: "chapters[].media", reason: `改词重生成第 ${idx} 章${snap.kind === "image" ? "插画" : "视频"}（${mediaId}）`, chapter: idx });
          saveWorld(w);
          return true;
        });
        regenBusy.delete(mediaKey(mediaId));
        if (!swapped) {
          if (snap.kind === "image" && snap.oldPath === undefined && newMedia.path) deleteMediaFile(title, newMedia.path);
          return json({ error: "媒体已被删除，重生成结果已丢弃" }, 404);
        }
        // ④ 锁外删旧文件（best-effort，引用守卫在 deleteMediaFile 内）
        if (snap.oldPath) deleteMediaFile(title, snap.oldPath);
        return json({ ok: true, mediaId, status: snap.kind === "image" ? "ready" : "pending", videoId: newMedia.videoId });
      } catch (e) {
        regenBusy.delete(mediaKey(mediaId));
        console.error("[api/novel/media/regenerate]", e);
        const st = (e as { status?: number }).status;
        return json({ error: e instanceof AppError ? e.message : "重生成失败，请稍后重试" }, st === 429 ? 429 : 502);
      }
    }

    case "/api/novel/media/delete": {
      // 删除媒体：锁内短事务移除条目 → 锁外删盘文件（前端需二次确认后才调用）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const idx = Number(body.chapterIndex);
      const mediaId = String(body.mediaId ?? "").trim();
      if (!title || !mediaId) return json({ error: "缺少参数" }, 400);
      if (!Number.isInteger(idx) || idx < 1) return json({ error: "缺少有效的章节号" }, 400);
      if (regenBusy.has(mediaKey(mediaId))) return json({ error: "该媒体正在重生成中，无法删除" }, 409);
      try {
        const oldPath = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ch = w.chapters.find((x) => x.index === idx);
          if (!ch) throw new AppError("章节不存在");
          const m = (ch.media ?? []).find((x) => x.id === mediaId);
          if (!m) throw new AppError("媒体不存在");
          ch.media = (ch.media ?? []).filter((x) => x.id !== mediaId);
          applyStateChange(w, { actor: "user", commandId: "CMD-M06", field: "chapters[].media", reason: `删除第 ${idx} 章${m.kind === "image" ? "插画" : "视频"}（${(m.caption ?? m.prompt ?? "").slice(0, 40) || "无题"}）`, chapter: idx });
          touchChapter(w, idx);
          saveWorld(w);
          return m.path;
        });
        if (oldPath) deleteMediaFile(title, oldPath);
        return json({ ok: true });
      } catch (e) {
        console.error("[api/novel/media/delete]", e);
        return json({ error: e instanceof AppError ? e.message : "删除失败，请稍后重试" }, 502);
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
          // 媒体可被重生成/替换：禁止长缓存，避免重生成后浏览器仍显示旧图（每次回源验证）
          "Cache-Control": "no-cache",
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
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const ext = m[1] === "png" ? "png" : "jpg";
          const oldRel = w.cover ?? ""; // 旧封面（替换后锁外删盘，避免本地残留）
          const rel = saveImage(title, `cover.${ext}`, new Uint8Array(buf));
          w.cover = rel;
          applyStateChange(w, { actor: "user", commandId: "CMD-M10", field: "cover", reason: `上传封面（${ext}，替换旧封面）`, chapter: w.nextChapter });
          finalizeStateChange(w, { ok: true });
          return { rel, oldRel };
        });
        // 替换封面：删旧文件（与新文件不同路径时；best-effort，引用守卫在 deleteMediaFile 内）
        if (result.oldRel && result.oldRel !== result.rel) deleteMediaFile(title, result.oldRel);
        return json({ ok: true, path: result.rel });
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
      const t0 = Date.now();
      console.log(`[regenerate] 开始 title=${title} index=${index} t0=${new Date(t0).toISOString()}`);
      try {
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return director.regenerateChapter(w, index, body.instruction ? String(body.instruction).slice(0, 500) : undefined);
        });
        console.log(`[regenerate] 完成 title=${title} index=${index} 耗时${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return json({ ok: true, chapter: result.chapter, review: result.review, world: sanitize(result.world), report: result.report });
      } catch (e) {
        if (e instanceof director.InterruptedError) return json({ ok: false, interrupted: true, error: "重写被干预打断（未保存）" });
        console.error(`[regenerate] 失败 title=${title} index=${index} 耗时${((Date.now() - t0) / 1000).toFixed(1)}s:`, e);
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
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          return await director.rollbackChapter(w, index, versionIndex);
        });
        return json({ ok: true, world: sanitize(result.world), report: result.report });
      } catch (e) {
        console.error("[api/novel/chapter/rollback]", e);
        return json({ error: e instanceof AppError ? e.message : "回滚失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/chapter/delete": {
      // 删除章节（两阶段）：无 strategy → 影响预览（确定性危险项 + 删中间章时 1 次 LLM 冲突评估）；
      // strategy=merge → 级联删除（允许空洞、绝不重排 index）；abort → 放弃
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const index = Number(body.chapterIndex);
      const strategy = body.strategy === "merge" || body.strategy === "abort" ? (body.strategy as "merge" | "abort") : undefined;
      if (!title) return json({ error: "缺少 title" }, 400);
      if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
      const w0 = loadWorld(title);
      if (!w0) return json({ error: "故事不存在: " + title }, 404);
      const ch0 = w0.chapters.find((c) => c.index === index);
      if (!ch0) return json({ error: "章节不存在" }, 404);
      if ((ch0.media ?? []).some((m) => regenBusy.has(mediaKey(m.id)))) return json({ error: "本章有媒体正在重生成中，无法删除" }, 409);
      try {
        if (!strategy) {
          // 预览：确定性收集危险项；删中间章（非尾章）追加 1 次语义冲突评估（失败降级）
          const isTail = index === w0.nextChapter - 1;
          const planted = w0.foreshadowing.filter((f) => f.plantedAt === index && f.status !== "resolved");
          const exits = w0.characters.filter((c) => c.exit?.chapter === index);
          const mediaCount = (ch0.media ?? []).length;
          const findings: ConsistencyFinding[] = [];
          for (const f of planted) {
            findings.push({ id: `preview-foreshadow:${f.id}`, level: "danger", kind: "planted-foreshadow-lost", chapterIndex: index, issue: `本章埋设的活跃伏笔「${f.text.slice(0, 40)}」将被删除`, suggestion: "如需保留该悬念，删章后请在后续章节重新埋设" });
          }
          for (const c of exits) {
            findings.push({ id: `preview-exit:${c.id}`, level: "warning", kind: "exit-cleared", issue: `角色「${c.name}」在本章离场，删除后离场记录将被清除`, suggestion: "如角色确已离场，删章后请在角色面板重新登记" });
          }
          if (mediaCount) findings.push({ id: "preview-media", level: "info", kind: "media-deleted", chapterIndex: index, issue: `本章 ${mediaCount} 个媒体（插画/视频）将随章节删除`, suggestion: "" });
          if (!isTail) {
            findings.push({ id: "preview-hole", level: "warning", kind: "middle-chapter-hole", chapterIndex: index, issue: `删除中间章节后章号将出现空号（第 ${index} 节缺失），前后剧情可能断裂`, suggestion: "建议删章后重写后续章节弥合衔接" });
            try {
              const rep = await steering.impactReport(w0, {
                kind: "chapter-delete",
                detail: `删除第 ${index} 节《${ch0.title}》，后续章节可能失去因果衔接`,
                foreshadowIds: planted.map((f) => f.id),
              });
              for (const c of rep.conflicts) {
                findings.push({ id: `preview-conflict:${findings.length}`, level: "danger", kind: "semantic-conflict", issue: c, suggestion: "删章前请确认该冲突可接受" });
              }
            } catch {
              /* 语义评估失败降级：仅确定性部分 */
            }
          }
          return json({ ok: true, needIntervention: true, options: ["merge", "abort"], isTail, report: { autoFixed: [], findings, orphanMedia: [] } });
        }
        if (strategy === "abort") return json({ ok: true, aborted: true });
        // merge：锁内级联删除 + 存档，锁外逐个删媒体文件（引用校验在 cascade 内已做）
        const result = await withTitleLock(slug(title), async () => {
          const w = loadWorld(title);
          if (!w) throw new AppError("故事不存在: " + title);
          const r = director.deleteChapter(w, index);
          saveWorld(w);
          return r;
        });
        for (const p of result.mediaPaths) deleteMediaFile(title, p);
        for (const p of result.versionFilePaths) deleteMediaFile(title, p); // 版本快照随章节删盘
        return json({ ok: true, world: sanitize(result.world), report: result.report });
      } catch (e) {
        console.error("[api/novel/chapter/delete]", e);
        return json({ error: e instanceof AppError ? e.message : "删除章节失败，请稍后重试" }, 502);
      }
    }

    case "/api/novel/integrity": {
      // 一致性巡检：scan 只读审计；repair 幂等自动修复；resettle 用户显式重算指定章节记账（先撤账再结算，防伏笔重复埋设）
      if (req.method !== "POST") return json({ error: "仅支持 POST" }, 405);
      const title = String(body.title ?? "").trim();
      const action = String(body.action ?? "scan");
      if (!title) return json({ error: "缺少 title" }, 400);
      try {
        if (action === "scan") {
          const w = loadWorld(title);
          if (!w) return json({ error: "故事不存在: " + title }, 404);
          // 只读预览：loadWorld 每次新解析，内存修改不落盘
          const orphanMedia: { chapterIndex: number; mediaId: string; kind: "image" | "video"; anchor: string }[] = [];
          for (const c of w.chapters) {
            markOrphanMedia(c);
            for (const m of c.media ?? []) {
              if (m.orphan) orphanMedia.push({ chapterIndex: c.index, mediaId: m.id, kind: m.kind, anchor: m.anchor });
            }
          }
          const findings = auditWorld(w);
          // 磁盘孤儿媒体文件（state 未引用的本地文件）：置顶提示，repair 时真实删盘
          const diskOrphans = collectOrphanMediaFiles(w);
          if (diskOrphans.length) {
            findings.unshift({ id: "disk-orphan-media", level: "info", kind: "disk-orphan-media", issue: `${diskOrphans.length} 个本地媒体文件未被存档引用（旧重生成/迁移残留）`, suggestion: "运行「一键修复」将真实删除这些孤儿文件" });
          }
          return json({ ok: true, report: { autoFixed: [], findings, orphanMedia } });
        }
        if (action === "repair") {
          const result = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            const fixed = autoRepair(w);
            for (const c of w.chapters) markOrphanMedia(c); // 同步 orphan 标记并持久化
            applyStateChange(w, { actor: "user", commandId: "CMD-S02", field: "多字段", reason: `一致性自动修复（${fixed.length} 项）`, chapter: w.nextChapter });
            saveWorld(w);
            return { fixed, w };
          });
          // 清理磁盘孤儿媒体文件（state 未引用的本地文件，旧重生成/迁移残留）
          const orphans = collectOrphanMediaFiles(result.w);
          for (const p of orphans) deleteMediaFile(title, p);
          const autoFixed = orphans.length ? [...result.fixed, `清理 ${orphans.length} 个孤儿媒体文件`] : result.fixed;
          return json({ ok: true, autoFixed, world: sanitize(result.w), report: { autoFixed, findings: auditWorld(result.w), orphanMedia: [] } });
        }
        if (action === "resettle") {
          const index = Number(body.chapterIndex);
          if (!Number.isInteger(index) || index < 1) return json({ error: "缺少有效的章节号" }, 400);
          // 锁内完成（含 1 次 LLM 记账）：显式用户操作，频率低；先 resetChapterLedger 再结算防伏笔重复埋设
          const result = await withTitleLock(slug(title), async () => {
            const w = loadWorld(title);
            if (!w) throw new AppError("故事不存在: " + title);
            const ch = w.chapters.find((c) => c.index === index);
            if (!ch) throw new AppError("章节不存在");
            resetChapterLedger(w, index);
            const settleReport = await settleChapter(w, ch, (w.chapterPlans ?? []).find((p) => p.index === index) ?? null);
            w.chapterDeltas = { ...(w.chapterDeltas ?? {}), [index]: settleReport.delta }; // 重结算覆盖该章变更快照
            markOrphanMedia(ch);
            applyStateChange(w, { actor: "user", commandId: "CMD-L04", field: "chapterDeltas", reason: `完整性重结算第 ${index} 章《${ch.title}》账本（先撤账再结算）`, chapter: index });
            saveWorld(w);
            return { w, settleReport };
          });
          return json({ ok: true, world: sanitize(result.w), settle: result.settleReport, report: { autoFixed: ["重算本章记账（摘要/伏笔/时间线/角色状态）"], findings: auditWorld(result.w), orphanMedia: [] } });
        }
        return json({ error: "action 必须为 scan/repair/resettle" }, 400);
      } catch (e) {
        console.error("[api/novel/integrity]", e);
        return json({ error: e instanceof AppError ? e.message : "一致性巡检失败，请稍后重试" }, 502);
      }
    }

    default:
      return json({ error: `未知 API: ${pathname}` }, 404);
  }
}

// —— 自动连载：公共执行器 + 服务重启恢复（刷新不断任务 / 重启自动续跑） ——

/** 暂存区草稿重试执行器（锁内重载最新世界 → retryChapter：以上一稿+审查意见重写，通过才 commit） */
function buildAutoExecRetry(key: string, title: string) {
  return (w: WorldState, pending: PendingChapter, onEvent: (e: director.StepEvent) => void) =>
    withTitleLock(key, async () => {
      const fresh = loadWorld(title);
      if (!fresh) throw new AppError("故事不存在: " + title);
      return director.retryChapter(fresh, pending, onEvent);
    });
}

/** 按 slug 读世界（恢复会话时目录名 → 书名；路径随当前用户上下文，无上下文时读 data/ 根遗留） */
function loadWorldBySlug(slugName: string): WorldState | null {
  try {
    const p = join(userDir(currentUser() ?? ""), slugName, "state.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as WorldState;
  } catch {
    return null;
  }
}

/** 后台续跑（服务重启恢复）：无 SSE 消费者，进度仅写入 autorun-session.json */
async function runAutoInBackground(title: string, target: number, written: number): Promise<void> {
  const lockKey = slug(title);
  const autoKey = `${currentUser() ?? ""}::${slug(title)}`;
  try {
    const report = await runAuto(
      title,
      { maxChapters: target, runEvalEvery: 10, execRetry: buildAutoExecRetry(lockKey, title) },
      (_w, onEvent) => withTitleLock(lockKey, async () => {
        const fresh = loadWorld(title);
        if (!fresh) throw new AppError("故事不存在: " + title);
        return director.writeOneChapter(fresh, "", onEvent, null, { requirePass: true });
      }),
      () => loadWorld(title),
      () => {
        /* 后台无 SSE 消费者 */
      },
      written,
    );
    console.log("[auto] 后台连载结束", title, JSON.stringify(report));
  } catch (e) {
    console.error("[auto] 后台连载异常:", title, e);
  } finally {
    activeAuto.delete(autoKey);
  }
}

/** 启动兜底迁移：把 data/ 根下遗留的旧书目录迁移给现存第一个注册用户（首个注册用户认领语义）。
 * 注册时的 isFirstUser 迁移只覆盖「迁移上线后才注册首个用户」的环境；存量环境（已有用户 + 根下旧书）
 * 由本函数在服务启动时补上，避免旧数据成为无主孤儿。 */
export function migrateLegacyOnBoot(): void {
  const first = firstUsername();
  if (!first) return;
  migrateLegacyStoriesTo(first);
}

/** 服务启动时恢复未停止的连载：遍历所有用户目录（+遗留根目录），status==="running" 的 autorun-session.json → 后台续跑（未被人工停止的任务不因重启丢失） */
export function resumeAutoSessions(): void {
  resumeAutoForDir(""); // 遗留根目录（未迁移前）
  for (const username of listUsernames()) {
    runAsUser(username, () => resumeAutoForDir(username));
  }
}

function resumeAutoForDir(username: string): void {
  const dataDir = userDir(username);
  if (!existsSync(dataDir)) return;
  for (const d of readdirSync(dataDir)) {
    if (d === ".DS_Store") continue;
    const sp = join(dataDir, d, "autorun-session.json");
    if (!existsSync(sp)) continue;
    try {
      const s = JSON.parse(readFileSync(sp, "utf-8")) as { status?: string; target?: number; written?: number };
      if (s.status !== "running") continue; // paused（等待人工决策）/ stopped / done 不自动恢复
      const w = loadWorldBySlug(d);
      if (!w) continue;
      const autoKey = `${currentUser() ?? ""}::${slug(w.title)}`;
      if (activeAuto.has(autoKey)) continue; // 防重复恢复（同进程内已有任务）
      activeAuto.add(autoKey);
      const target = Math.max(1, Math.min(Number(s.target) || 3, 30));
      const written = Math.max(0, Number(s.written) || 0);
      void runAutoInBackground(w.title, target, written);
      console.log(`[auto] 服务重启恢复连载：${w.title}（目标 ${target} 章，已写 ${written} 章）`);
    } catch (e) {
      console.warn("[auto] 会话恢复跳过:", d, (e as Error).message);
    }
  }
}

/** 传输给前端的精简视图（剔除超长正文以外的敏感字段；这里主要控制体积；chapterDeltas 仅服务端内部使用） */
function sanitize(w: import("./world").WorldState) {
  const { chapterDeltas: _cd, ...rest } = w;
  return {
    ...rest,
    chapters: rest.chapters.map((c) => ({ index: c.index, title: c.title, text: c.text, review: c.review, versions: c.versions, media: c.media })),
  };
}
