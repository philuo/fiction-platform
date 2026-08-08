// 单章推进任务持久化（advancetask）：/api/novel/step 任务状态落盘到 data/<username>/<slug>/advance-task.json。
// 解决的问题：推进剧情（本章续写）是数分钟级异步任务，客户端刷新/关闭后前端状态丢失，
// 但服务端仍会完整执行到存档——刷新后前端可查询任务状态恢复显示，不再"状态丢失"。
// 与连载会话（autorun-session.json）同规范：原子写、服务重启可恢复/清理。
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { storyDir, runAsUser, userDir } from "./storage";
import { listUsernames } from "./auth";

export type AdvanceTaskStatus = "running" | "done" | "failed";

export type AdvanceTask = {
  status: AdvanceTaskStatus;
  /** 目标章节号（任务启动时 world.nextChapter） */
  targetIndex: number;
  /** 最近阶段（writing / reviewing / settling …，客户端恢复显示用） */
  phase: string;
  startedAt: string;
  updatedAt: string;
  /** done：入册章节号 */
  chapterIndex?: number;
  /** done：审查结论 pass/revise */
  verdict?: string;
  /** done：通过用了几稿 */
  rounds?: number;
  /** failed：错误信息 */
  error?: string;
  /** commitPolicy=confirm：审查通过已暂存，等人工确认入册 */
  pendingCommit?: boolean;
};

/** 陈旧判定：updatedAt 超过 15 分钟仍 running（服务重启中断，无 SSE 消费者推进），视为失败 */
const STALE_MS = 15 * 60 * 1000;

function taskPath(title: string): string {
  return join(storyDir(title), "advance-task.json");
}

export function loadAdvanceTask(title: string): AdvanceTask | null {
  try {
    const p = taskPath(title);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as AdvanceTask;
  } catch {
    return null;
  }
}

export function saveAdvanceTask(title: string, task: AdvanceTask): void {
  try {
    const dir = storyDir(title);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `advance-task.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(task, null, 2), "utf-8");
    renameSync(tmp, taskPath(title));
  } catch (e) {
    console.warn("[advancetask] 写入失败:", (e as Error).message);
  }
}

/** 任务启动：写 running；上一任务 running 且未陈旧时拒绝（同书同时只允许一个单章推进） */
export function startAdvanceTask(title: string, targetIndex: number): { ok: boolean; reason?: string } {
  const prev = loadAdvanceTask(title);
  if (prev && prev.status === "running" && Date.now() - Date.parse(prev.updatedAt) < STALE_MS) {
    return { ok: false, reason: `单章推进任务运行中（第 ${prev.targetIndex} 章），请等待完成或稍后重试` };
  }
  saveAdvanceTask(title, {
    status: "running",
    targetIndex,
    phase: "start",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { ok: true };
}

/** 阶段更新（心跳）：running 中刷新 updatedAt，防陈旧误判 */
export function updateAdvanceTaskPhase(title: string, phase: string): void {
  const t = loadAdvanceTask(title);
  if (!t || t.status !== "running") return;
  saveAdvanceTask(title, { ...t, phase, updatedAt: new Date().toISOString() });
}

/** 任务完成（入册或 pending-commit 暂存待确认） */
export function completeAdvanceTask(title: string, r: { chapterIndex: number; verdict?: string; rounds?: number; pendingCommit?: boolean }): void {
  const t = loadAdvanceTask(title);
  saveAdvanceTask(title, {
    status: "done",
    targetIndex: t?.targetIndex ?? r.chapterIndex,
    phase: "done",
    startedAt: t?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapterIndex: r.chapterIndex,
    verdict: r.verdict,
    rounds: r.rounds,
    pendingCommit: r.pendingCommit,
  });
}

/** 任务失败 */
export function failAdvanceTask(title: string, error: string): void {
  const t = loadAdvanceTask(title);
  if (!t) return;
  saveAdvanceTask(title, { ...t, status: "failed", phase: "failed", error, updatedAt: new Date().toISOString() });
}

/** 查询：陈旧 running（服务重启中断，超 STALE_MS 无更新）→ 返回时直接标记 failed */
export function getAdvanceTaskForClient(title: string): AdvanceTask | null {
  const t = loadAdvanceTask(title);
  if (t && t.status === "running" && Date.now() - Date.parse(t.updatedAt) > STALE_MS) {
    failAdvanceTask(title, "任务在服务重启/长时间无响应后中断，请重新推进");
    return loadAdvanceTask(title);
  }
  return t;
}

/** 前端已确认读取 done/failed 结果后清除任务文件（避免每次刷新重复提示） */
export function clearAdvanceTask(title: string): void {
  try {
    const p = taskPath(title);
    if (existsSync(p)) unlinkSync(p);
  } catch (e) {
    console.warn("[advancetask] 清除失败:", (e as Error).message);
  }
}

/** 服务启动恢复：扫描各用户目录（+遗留根目录）的 advance-task.json，陈旧 running → 标记 failed。
 * 与连载不同，单章推进无自动续跑（执行上下文不持久化），只清理状态避免永久卡 running。 */
export function cleanupStaleAdvanceTasks(): void {
  cleanupStaleForDir("");
  for (const username of listUsernames()) {
    runAsUser(username, () => cleanupStaleForDir(username));
  }
}

function cleanupStaleForDir(username: string): void {
  try {
    const dataDir = userDir(username);
    if (!existsSync(dataDir)) return;
    for (const slug of readdirSync(dataDir)) {
      const p = join(dataDir, slug, "advance-task.json");
      if (!existsSync(p)) continue;
      try {
        const t = JSON.parse(readFileSync(p, "utf-8")) as AdvanceTask;
        if (t.status === "running" && Date.now() - Date.parse(t.updatedAt) > STALE_MS) {
          saveAdvanceTask(slug, { ...t, status: "failed", phase: "failed", error: "服务重启中断了任务，请重新推进", updatedAt: new Date().toISOString() });
          console.log(`[advancetask] 清理陈旧任务: ${slug}`);
        }
      } catch { /* 单文件损坏忽略 */ }
    }
  } catch (e) {
    console.warn("[advancetask] 启动清理失败:", (e as Error).message);
  }
}
