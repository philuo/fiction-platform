import { getDb } from "./db";
import { recoverPreparedWorldCommits, settleOrphanedJobs } from "./control-plane";
import { cleanupStaleAdvanceTasks } from "./advancetask";
import { cleanupNewStoryTasks } from "./newtask";
import { cleanupStaleMediaTasksOnBoot } from "./media-recovery";
import { migrateLegacyOnBoot, resumeAutoSessions, resumeScheduledMediaJobs, startVisualSweep } from "./routes";
import { markRuntimeReady, markRuntimeRecovering, markRuntimeRecoveryFailed, runtimeReadiness } from "./runtime-readiness";

const BOOT_PROMISE_KEY = "__moshift_boot_recovery_promise__";
type BootGlobal = typeof globalThis & { [BOOT_PROMISE_KEY]?: Promise<void> };

/** 完成所有会改变用户可见投影的恢复后，服务器才可监听端口。 */
export async function runBootRecovery(): Promise<void> {
  markRuntimeRecovering();
  try {
    getDb();
    migrateLegacyOnBoot();
    const recoveredWorldCommits = recoverPreparedWorldCommits();
    if (recoveredWorldCommits.conflicts > 0) {
      throw new Error(`存在 ${recoveredWorldCommits.conflicts} 个无法自动恢复的世界写入冲突`);
    }
    const interruptedJobs = settleOrphanedJobs();
    cleanupStaleAdvanceTasks();
    cleanupNewStoryTasks();
    await cleanupStaleMediaTasksOnBoot();
    resumeAutoSessions();
    resumeScheduledMediaJobs();
    startVisualSweep();
    markRuntimeReady({ recoveredWorldCommits, interruptedJobs });
  } catch (error) {
    markRuntimeRecoveryFailed(error);
    throw error;
  }
}

/** bun --hot 会重新执行入口模块；同一进程只运行一次启动恢复。 */
export function ensureBootRecovery(): Promise<void> {
  const root = globalThis as BootGlobal;
  root[BOOT_PROMISE_KEY] ??= runBootRecovery();
  return root[BOOT_PROMISE_KEY];
}

export { runtimeReadiness };
