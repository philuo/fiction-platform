import { createJob, deleteJobs, listJobs, updateJob, type DurableJob } from "./control-plane";
import { currentUser } from "./storage";
import { runAsUser } from "./storage";
import { listUsernames } from "./auth";
import { loadSessions, updateMessageCard } from "./brain-sessions";
import { publishCardUpdate } from "./sync";

export type AdvanceTaskStatus = "running" | "done" | "failed";
export type AdvanceTask = {
  status: AdvanceTaskStatus;
  targetIndex: number;
  phase: string;
  startedAt: string;
  updatedAt: string;
  chapterIndex?: number;
  verdict?: string;
  rounds?: number;
  error?: string;
  pendingCommit?: boolean;
};

type AdvanceRecovery = { targetIndex: number; startedAt: string };
function fromJob(job: DurableJob): AdvanceTask {
  const recovery = (job.recovery ?? {}) as AdvanceRecovery;
  const progress = (job.progress ?? {}) as Partial<AdvanceTask>;
  const status: AdvanceTaskStatus = job.status === "succeeded" ? "done" : job.status === "failed" || job.status === "interrupted" || job.status === "cancelled" ? "failed" : "running";
  return {
    status,
    targetIndex: Number(progress.targetIndex ?? recovery.targetIndex),
    phase: String(progress.phase ?? job.phase ?? ""),
    startedAt: String(progress.startedAt ?? recovery.startedAt ?? job.updatedAt),
    updatedAt: job.updatedAt,
    chapterIndex: progress.chapterIndex,
    verdict: progress.verdict,
    rounds: progress.rounds,
    error: progress.error ?? job.error,
    pendingCommit: progress.pendingCommit,
  };
}

function latest(title: string): DurableJob | null {
  return listJobs(currentUser(), title).find((job) => job.kind === "advance") ?? null;
}

export function loadAdvanceTask(title: string): AdvanceTask | null {
  const job = latest(title);
  return job ? fromJob(job) : null;
}

export function saveAdvanceTask(title: string, task: AdvanceTask): void {
  const existing = latest(title);
  const job = existing ?? createJob({ user: currentUser(), title, kind: "advance", dedupeKey: `advance:${title}`, status: task.status === "done" ? "succeeded" : task.status === "failed" ? "failed" : "running", phase: task.phase, recovery: { targetIndex: task.targetIndex, startedAt: task.startedAt } }).job;
  updateJob(job.id, {
    status: task.status === "done" ? "succeeded" : task.status === "failed" ? "failed" : "running",
    phase: task.phase,
    progress: task,
    error: task.error ?? null,
  });
}

export function startAdvanceTask(title: string, targetIndex: number, commandId?: string): { ok: boolean; reason?: string } {
  const prev = latest(title);
  if (prev && ["queued", "running", "waiting_external", "paused"].includes(prev.status)) {
    return { ok: false, reason: `单章推进任务运行中（第 ${fromJob(prev).targetIndex} 章），请等待完成或稍后重试` };
  }
  const startedAt = new Date().toISOString();
  const created = createJob({ user: currentUser(), commandId, title, kind: "advance", dedupeKey: `advance:${title}`, status: "running", phase: "start", recovery: { targetIndex, startedAt } });
  updateJob(created.job.id, { progress: { status: "running", targetIndex, phase: "start", startedAt } });
  return { ok: true };
}

export function updateAdvanceTaskPhase(title: string, phase: string): void {
  const job = latest(title);
  if (!job || job.status !== "running") return;
  const task = fromJob(job);
  updateJob(job.id, { phase, progress: { ...task, phase, status: "running" } });
}

export function completeAdvanceTask(title: string, r: { chapterIndex: number; verdict?: string; rounds?: number; pendingCommit?: boolean }): void {
  const job = latest(title) ?? createJob({ user: currentUser(), title, kind: "advance", dedupeKey: `advance:${title}`, status: "succeeded", phase: "done", recovery: { targetIndex: r.chapterIndex, startedAt: new Date().toISOString() } }).job;
  const task = fromJob(job);
  updateJob(job.id, { status: "succeeded", phase: "done", progress: { ...task, status: "done", phase: "done", chapterIndex: r.chapterIndex, verdict: r.verdict, rounds: r.rounds, pendingCommit: r.pendingCommit }, error: null, result: r });
  finalizeProgressForTask(title, { status: "done", phase: "result", detail: `第 ${r.chapterIndex} 章已完成${r.pendingCommit ? "（等待确认入册）" : ""}` });
}

export function failAdvanceTask(title: string, error: string): void {
  const job = latest(title);
  if (!job) return;
  const task = fromJob(job);
  updateJob(job.id, { status: "failed", phase: "failed", progress: { ...task, status: "failed", phase: "failed", error }, error });
  finalizeProgressForTask(title, { status: "failed", phase: "failed", detail: error.slice(0, 200) });
}

function finalizeProgressForTask(title: string, patch: { status: string; phase: string; detail: string }): void {
  try {
    const user = currentUser() ?? undefined;
    const sessions = loadSessions(title);
    for (const s of sessions) for (const m of s.messages) for (const c of m.cards ?? []) {
      const card = c as { kind?: string; cardId?: string; status?: string };
      if (card.kind === "progress" && card.cardId && card.status === "running") {
        const updated = updateMessageCard(title, s.id, m.id, card.cardId, patch);
        if (updated) { publishCardUpdate(title, s.id, m.id, card.cardId, patch, user); return; }
      }
    }
  } catch { /* 卡片不存在不影响任务终态 */ }
}

export function getAdvanceTaskForClient(title: string): AdvanceTask | null { return loadAdvanceTask(title); }

export function clearAdvanceTask(title: string): void { deleteJobs(currentUser(), { kind: "advance", title }); }

export function cleanupStaleAdvanceTasks(): void {
  const cleanupCurrent = () => {
    for (const job of listJobs(currentUser()).filter((item) => item.kind === "advance" && ["queued", "running", "waiting_external"].includes(item.status))) {
      updateJob(job.id, { status: "interrupted", phase: "interrupted", error: "服务重启中断了任务，请重新推进" });
    }
  };
  runAsUser(null, cleanupCurrent);
  for (const username of listUsernames()) runAsUser(username, cleanupCurrent);
}
