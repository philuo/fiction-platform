import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { currentUser, runAsUser, userDir } from "./storage";
import { listUsernames } from "./auth";
import { createJob, deleteJobs, getJob, listJobs, updateJob, type DurableJob } from "./control-plane";

export type NewTaskStatus = "running" | "ready" | "done" | "failed";
export type NewStoryTask = {
  id: string;
  status: NewTaskStatus;
  idea: string;
  genre?: string;
  title?: string;
  stage?: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

type NewRecovery = { idea: string; genre?: string; title?: string; startedAt: string };
type NewProgress = { status: NewTaskStatus; stage?: string; title?: string };

function fromJob(job: DurableJob): NewStoryTask {
  const recovery = (job.recovery ?? {}) as NewRecovery;
  const progress = (job.progress ?? {}) as NewProgress;
  const result = (job.result ?? {}) as { title?: string };
  const status: NewTaskStatus = job.status === "succeeded" ? "done" : job.status === "failed" || job.status === "interrupted" || job.status === "cancelled" ? "failed" : progress.status === "ready" ? "ready" : "running";
  return {
    id: job.id,
    status,
    idea: recovery.idea ?? "",
    genre: recovery.genre,
    title: progress.title ?? result.title ?? recovery.title ?? job.title,
    stage: progress.stage,
    startedAt: recovery.startedAt ?? job.updatedAt,
    updatedAt: job.updatedAt,
    error: job.error,
  };
}

function legacyPath(): string { return join(userDir(currentUser() ?? ""), "newstory-tasks.json"); }

/** 旧 JSON 只在 SQLite 尚无记录时导入一次，随后停止写入。 */
function importLegacy(): void {
  if (listJobs(currentUser()).some((job) => job.kind === "new-story")) return;
  const path = legacyPath();
  if (!existsSync(path)) return;
  let tasks: NewStoryTask[] = [];
  try { tasks = JSON.parse(readFileSync(path, "utf-8")) as NewStoryTask[]; } catch { return; }
  for (const task of tasks) {
    const status = task.status === "done" ? "succeeded" : task.status === "failed" ? "failed" : "running";
    const created = createJob({
      id: task.id, user: currentUser(), title: task.title, kind: "new-story", dedupeKey: `new-story:${task.id}`,
      status, phase: task.stage ?? task.status,
      recovery: { idea: task.idea, genre: task.genre, title: task.title, startedAt: task.startedAt },
    });
    updateJob(created.job.id, { status, phase: task.stage ?? task.status, progress: { status: task.status, stage: task.stage, title: task.title }, result: task.title ? { title: task.title } : undefined, error: task.error ?? null });
  }
  try { unlinkSync(path); } catch { /* 已导入，遗留文件清理失败不影响权威账本 */ }
}

export function loadNewStoryTasks(): NewStoryTask[] {
  importLegacy();
  return listJobs(currentUser()).filter((job) => job.kind === "new-story").map(fromJob);
}

export function createNewStoryTask(idea: string, genre?: string, commandId?: string): { id: string; created: boolean } {
  importLegacy();
  const active = listJobs(currentUser(), undefined, true).find((job) => job.kind === "new-story");
  if (active) return { id: active.id, created: false };
  const startedAt = new Date().toISOString();
  const created = createJob({
    user: currentUser(), commandId, kind: "new-story", dedupeKey: "new-story:active", status: "running", phase: "start",
    recovery: { idea, genre, startedAt },
  });
  updateJob(created.job.id, { progress: { status: "running" } });
  return { id: created.job.id, created: created.created };
}

export function completeNewStoryTask(id: string, title: string): void {
  updateJob(id, { status: "succeeded", phase: "done", progress: { status: "done", title }, recovery: { ...((getJob(id)?.recovery ?? {}) as object), title }, result: { title }, error: null });
}

export function markNewStoryTaskReady(id: string, title: string): void {
  const job = getJob(id);
  if (!job || !["queued", "running"].includes(job.status)) return;
  updateJob(id, { status: "running", phase: "enhancing", progress: { status: "ready", title, stage: "世界已就绪，正在生成故事蓝图…" }, recovery: { ...((job.recovery ?? {}) as object), title } });
}

export function updateNewStoryTaskStage(id: string, stage: string): void {
  const job = getJob(id);
  if (!job || !["queued", "running"].includes(job.status)) return;
  const current = fromJob(job);
  updateJob(id, { phase: stage, progress: { status: current.status, title: current.title, stage } });
}

export function failNewStoryTask(id: string, error: string): void {
  if (!getJob(id)) return;
  updateJob(id, { status: "failed", phase: "failed", progress: { status: "failed" }, error });
}

export function getNewStoryTask(id: string): NewStoryTask | null {
  importLegacy();
  const job = getJob(id);
  return job?.kind === "new-story" ? fromJob(job) : null;
}

export function listActiveNewStoryTasks(): NewStoryTask[] {
  return loadNewStoryTasks().filter((task) => task.status === "running" || task.status === "ready");
}

export function removeNewStoryTaskByTitle(title: string): void {
  for (const job of listJobs(currentUser()).filter((item) => item.kind === "new-story" && fromJob(item).title === title)) deleteJobs(currentUser(), { id: job.id });
}

/** 启动屏障收敛 new-story：模型调用没有安全续跑点，统一标记中断。 */
export function cleanupNewStoryTasks(): void {
  const cleanupCurrent = () => {
    importLegacy();
    for (const job of listJobs(currentUser(), undefined, true).filter((item) => item.kind === "new-story")) {
      updateJob(job.id, { status: "interrupted", phase: "interrupted", error: "服务重启中断了立项任务，请重新发起" });
    }
  };
  runAsUser(null, cleanupCurrent);
  for (const username of listUsernames()) runAsUser(username, cleanupCurrent);
}

export function _clearNewStoryTasks(): void {
  deleteJobs(currentUser(), { kind: "new-story" });
  try { if (existsSync(legacyPath())) unlinkSync(legacyPath()); } catch { /* 测试清理 */ }
}
