// 服务启动恢复：收敛重启后失去后台依托的「进行中」章节媒体与中枢卡片。
// 单进程内存任务表（planTasks/imageGenTasks）重启即空，state.json 里残留的 pending 插画、
// brain-sessions.json 里 running+mediaIds/planId 的卡片无人收敛，会永久 loading。
// 启动时在所有用户的所有书上跑一遍（与 cleanupStaleAdvanceTasks/cleanupNewStoryTasks 同级）：
//   - 图片 pending：有 path → ready；无 path → failed（重启后内存任务必空，无 path 一定中断）；
//   - 视频：无 videoId 无 path → failed；有 path → ready；有 videoId 未超 30min → 保留 pending
//     （交给 WS 快照 + 前端一次性核对继续 poll provider）；
//   - 随后按真实 mediaId 状态收敛中枢 running 预览卡（recoverRunningMediaCards）。
// 只翻状态、不重启任何生成；幂等。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listUsernames } from "./auth";
import { loadWorld, saveWorld, listStories, runAsUser, userDir, currentUser, slugify as slug } from "./storage";
import { withTitleLock } from "./titlelock";
import { touchChapter, type WorldState } from "./world";
import { applyStateChange } from "./statechange";
import { recoverRunningMediaCards } from "./brain-sessions";

const VIDEO_STALE_MS = 30 * 60_000;

type RecoverTally = {
  imgReady: number; imgFailed: number; vidFailed: number; vidKept: number;
  cards: ReturnType<typeof recoverRunningMediaCards>;
};

/** 收敛单本书：返回翻转数量（供日志） */
async function recoverStory(title: string, resumePendingVideos: (title: string) => void): Promise<RecoverTally> {
  const tally = { imgReady: 0, imgFailed: 0, vidFailed: 0, vidKept: 0 };
  const mediaStatusById = new Map<string, string>();
  const now = Date.now();

  await withTitleLock(slug(title), async () => {
    const w = loadWorld(title);
    if (!w) return;
    let dirty = false;
    for (const ch of w.chapters) {
      for (const m of ch.media ?? []) {
        if (m.status !== "pending" || !m.id) continue;
        if (m.kind === "image") {
          if (m.path) {
            m.status = "ready";
            m.error = undefined;
            tally.imgReady++;
          } else {
            m.status = "failed";
            m.error = "生成任务因服务重启中断，请删除后重新生成";
            tally.imgFailed++;
          }
          dirty = true;
          touchChapter(w, ch.index);
          applyStateChange(w, { actor: "system", commandId: "CMD-M04", field: "chapters[].media", reason: `启动恢复：第 ${ch.index} 章图片任务收敛（${m.id}）`, chapter: ch.index });
        } else if (m.kind === "video") {
          if (!m.videoId && !m.path) {
            m.status = "failed";
            m.error = "视频任务因服务重启中断，请删除后重新生成";
            tally.vidFailed++;
            dirty = true;
            touchChapter(w, ch.index);
            applyStateChange(w, { actor: "system", commandId: "CMD-M04", field: "chapters[].media", reason: `启动恢复：第 ${ch.index} 章视频任务收敛（${m.id}）`, chapter: ch.index });
          } else if (m.path) {
            m.status = "ready";
            m.error = undefined;
            tally.imgReady++;
            dirty = true;
            touchChapter(w, ch.index);
          } else if (m.createdAt && now - m.createdAt > VIDEO_STALE_MS) {
            m.status = "failed";
            m.error = "视频生成超时（超过 30 分钟），请删除后重新生成";
            tally.vidFailed++;
            dirty = true;
            touchChapter(w, ch.index);
            applyStateChange(w, { actor: "system", commandId: "CMD-M04", field: "chapters[].media", reason: `启动恢复：第 ${ch.index} 章视频超时（${m.id}）`, chapter: ch.index });
          } else {
            // 有 videoId 且未超时：保留 pending，继续 poll
            tally.vidKept++;
          }
        }
        if (m.status) mediaStatusById.set(m.id, m.status);
      }
    }
    if (dirty) saveWorld(w);
  });

  // 用收敛后的真实媒体状态翻转中枢 running 卡（planId 卡一律 failed——planTasks 是纯内存态）
  const cards = recoverRunningMediaCards(title, mediaStatusById);
  // 重启后仍 pending 的视频（有 videoId 未超时）：续上服务端轮询（Agnes 视频无回调，需服务端查询驱动落盘+广播）
  resumePendingVideos(title);
  return { ...tally, cards };
}

/** 按 slug 读 state.json 取 title（启动遍历目录用；等价 routes.ts 的 loadWorldBySlug） */
function titleFromSlug(slugName: string): string | null {
  try {
    const p = join(userDir(currentUser() ?? ""), slugName, "state.json");
    if (!existsSync(p)) return null;
    const w = JSON.parse(readFileSync(p, "utf-8")) as WorldState;
    return w.title ?? null;
  } catch {
    return null;
  }
}

/** 恢复当前用户上下文下所有书（串行，启动期无并发写） */
async function recoverForUser(resumePendingVideos: (title: string) => void): Promise<void> {
  for (const slugName of listStories()) {
    const title = titleFromSlug(slugName);
    if (!title) continue;
    try {
      const r = await recoverStory(title, resumePendingVideos);
      const total = r.imgReady + r.imgFailed + r.vidFailed + r.vidKept;
      if (total || r.cards.planFailed || r.cards.mediaDone || r.cards.mediaFailed || r.cards.stuckFailed) {
        console.log(
          `[boot/media] 恢复《${title}》: 图片 ready=${r.imgReady} failed=${r.imgFailed}；视频 failed=${r.vidFailed} 保留pending=${r.vidKept}；` +
          `卡片 分镜失败=${r.cards.planFailed} 媒体完成=${r.cards.mediaDone} 媒体失败=${r.cards.mediaFailed} 悬死失败=${r.cards.stuckFailed}`,
        );
      }
    } catch (e) {
      console.warn(`[boot/media] 恢复《${title}》失败:`, (e as Error).message);
    }
  }
}

/** 服务启动入口：在监听端口前扫描全部用户并收敛陈旧媒体/卡片。 */
export async function cleanupStaleMediaTasksOnBoot(resumePendingVideos: (title: string) => void = () => {}): Promise<void> {
  await runAsUser(null, () => recoverForUser(resumePendingVideos));
  for (const username of listUsernames()) {
    await runAsUser(username, () => recoverForUser(resumePendingVideos));
  }
}
