// 自动连载（P4，修 D6）：全自动驾驶循环 + 停下策略（配额耗尽/评分熔断/用户停止/干预打断/全书完结/审查未过）
// git 语义：每章一个 commit；审查不通过 = commit 被拒 → 草稿进暂存区（pending-chapter.json）→ 停下等人工决策（重试/跳过/停止）
// 断点恢复：每章 commit 即存档 + checkpoint.jsonl；会话状态 autorun-session.json（前端刷新 / 服务重启恢复）
import { InterruptedError, registerReviewDebt, ReviewFailedError, type StepEvent, type StepResult } from "./director";
import { isBookComplete } from "./planner";
import { evaluateBookCached, type EvalReport } from "./eval";
import { logChange } from "./steering";
import { withTitleLock } from "./titlelock";
import { genOf, type PendingChapter, type ReviewFinding, type WorldState } from "./world";
import {
  clearPendingChapter, currentUser, loadAutoSession, loadPendingChapter, saveAutoSession, savePendingChapter, saveWorld,
  type AutoSession,
} from "./storage";
import { publishSync } from "./sync";
import { findLatestJob, updateJob } from "./control-plane";

export type AutoOptions = {
  maxChapters: number; // 硬上限（≤30，防失控烧额度；绝对目标，含恢复的初始 written）
  stopAvgScore?: number; // 评分熔断线（章节均分低于该值即停）
  autoGacha?: boolean; // 临时覆盖自动抽卡开关
  runEvalEvery?: number; // 每 N 章跑一次整书评估（默认 10，0=关闭）
  /** 暂存区草稿重试执行器（存在 pending 且与 nextChapter 匹配时使用）；不提供则跳过重试语义 */
  execRetry?: (w: WorldState, pending: PendingChapter, onEvent: (e: StepEvent) => void) => Promise<StepResult>;
};

export type AutoEvent =
  | ({ auto: true; chapter: number; written: number } & StepEvent)
  | { auto: true; phase: "auto-status"; written: number; reason: string; eval?: EvalReport }
  | { auto: true; phase: "review-failed"; chapter: number; findings: ReviewFinding[] };

export type AutoReport = {
  written: number;
  reason: "done" | "complete" | "stopped" | "paused" | "interrupted" | "score" | "error" | "quota" | "review";
  avgScore: number | null;
  /** 审查未通过停住时的章节号（reason === "review" 时有值） */
  failedChapter?: number;
};

type AutoControlIntent = "stop" | "pause";
function setControlIntent(title: string, intent?: AutoControlIntent): void {
  const job = findLatestJob(currentUser(), "auto", title);
  if (!job) return;
  const recovery = { ...((job.recovery ?? {}) as Record<string, unknown>) };
  if (intent) recovery.controlIntent = intent;
  else delete recovery.controlIntent;
  updateJob(job.id, { recovery });
}
function controlIntent(title: string): AutoControlIntent | undefined {
  return (findLatestJob(currentUser(), "auto", title)?.recovery as { controlIntent?: AutoControlIntent } | undefined)?.controlIntent;
}
export function stopAuto(title: string): void {
  setControlIntent(title, "stop");
  // 立即持久化停止意图：防止服务在 runAuto 检测到 stopFlags 前重启 → resumeAutoSessions 误续跑
  touchSession(title, { status: "stopped", phase: "用户手动停止", pauseReason: "用户手动停止" });
}
export function pauseAuto(title: string): void {
  setControlIntent(title, "pause");
}
export function clearAutoStop(title: string): void {
  setControlIntent(title);
}
function isStopped(title: string): boolean {
  return controlIntent(title) === "stop";
}
function isPausedByUser(title: string): boolean {
  return controlIntent(title) === "pause";
}

// —— 会话状态辅助：合并更新 autorun-session.json（不存在则忽略） ——
function touchSession(title: string, patch: Partial<AutoSession>): void {
  const prev = loadAutoSession(title);
  if (!prev) return;
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  saveAutoSession(title, next);
  // C 级广播点：连载会话状态转移（开始/暂停/每章提交/终态）→ 事件总线（无订阅者零开销，节流合并）
  publishSync({
    type: "auto-status",
    title,
    status: next.status,
    phase: next.phase,
    written: next.written,
    updatedAt: next.updatedAt,
    at: Date.now(),
    user: currentUser() ?? undefined,
  });
}

/** 写会话终态（done/complete → done；其余人为或异常停止 → stopped） */
function finish(title: string, report: AutoReport): AutoReport {
  touchSession(title, {
    status: report.reason === "done" || report.reason === "complete" ? "done" : "stopped",
    phase: `连载结束（${report.reason}）`,
    pauseReason: undefined,
    failedChapter: report.failedChapter,
  });
  return report;
}

/**
 * 自动连载主循环。
 * @param exec 单章执行器（调用方包 withTitleLock：load→writeOneChapter(requirePass)，保证与手动 step 互斥）
 * @param load 每章重新加载世界（捕获干预/编辑带来的外部变更）
 * @param initialWritten 会话恢复时的已写章数（服务重启续跑：written 从该值继续，maxChapters 为绝对目标）
 */
export async function runAuto(
  title: string,
  opts: AutoOptions,
  exec: (w: WorldState, onEvent: (e: StepEvent) => void) => Promise<StepResult>,
  load: () => WorldState | null,
  onEvent: (e: AutoEvent) => void,
  initialWritten = 0,
): Promise<AutoReport> {
  const maxChapters = Math.max(1, Math.min(opts.maxChapters, 30));
  let written = initialWritten;
  let errStreak = 0;
  let lowStreak = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  let lastEval: EvalReport | undefined;

  clearAutoStop(title);

  // 会话开始：置 running（保留历史开始时间与 lastEval，幂等恢复）
  const prev = loadAutoSession(title);
  saveAutoSession(title, {
    status: "running",
    target: maxChapters,
    written,
    phase: prev?.phase ?? "连载开始",
    pauseReason: undefined,
    failedChapter: undefined,
    failedFindings: undefined,
    lastEval: prev?.lastEval ?? null,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  while (written < maxChapters) {
    // 用户停止 / 干预打断（peek 不消费，交给管线边界处理）
    if (isStopped(title)) return finish(title, { written, reason: "stopped", avgScore: scoreCount ? scoreSum / scoreCount : null });
    // 用户主动暂停：章边界停下，保持 paused 会话（重新 start 即恢复，不计终态）
    if (isPausedByUser(title)) {
      clearAutoStop(title);
      touchSession(title, { status: "paused", phase: "已暂停（用户手动暂停）", pauseReason: "用户手动暂停" });
      return { written, reason: "paused", avgScore: scoreCount ? scoreSum / scoreCount : null };
    }
    const w0 = load();
    if (!w0) return finish(title, { written, reason: "error", avgScore: null });
    // 全书完结（最后一卷 done + 伏笔全回收）
    if (isBookComplete(w0)) return finish(title, { written, reason: "complete", avgScore: scoreCount ? scoreSum / scoreCount : null });

    const chapterNo = w0.nextChapter;
    // 临时覆盖自动抽卡
    if (opts.autoGacha !== undefined && w0.gen) w0.gen.autoGacha = opts.autoGacha;

    // git 语义：暂存区有匹配当前章的草稿 → 先重试该章（通过才 commit 并继续写新章）
    const pending = loadPendingChapter(title);
    const usingRetry = !!pending && pending.chapterIndex === chapterNo && !!opts.execRetry;
    if (usingRetry) touchSession(title, { phase: `第 ${chapterNo} 章重试中（上一稿审查未过）` });

    try {
      const result = usingRetry
        ? await opts.execRetry!(w0, pending!, (e) => onEvent({ auto: true, chapter: chapterNo, written, ...e } as AutoEvent))
        : await exec(w0, (e) => onEvent({ auto: true, chapter: chapterNo, written, ...e } as AutoEvent));
      if (usingRetry) clearPendingChapter(title); // 重试成功：清空暂存区
      written++;
      errStreak = 0;
      touchSession(title, { written, phase: `第 ${chapterNo} 章已提交` });
      const s = result.review.scores;
      const avg = (s.coherence + s.tension + s.prose + s.pacing + s.dialogue) / 5;
      scoreSum += avg;
      scoreCount++;
      // 评分熔断：连续 2 章低于地板分
      const floor = genOf(w0, chapterNo).reviewStrictness === "宽松" ? 4 : genOf(w0, chapterNo).reviewStrictness === "严格" ? 7 : 6;
      if (avg < floor) lowStreak++;
      else lowStreak = 0;
      if (lowStreak >= 2 || (opts.stopAvgScore !== undefined && avg < opts.stopAvgScore)) {
        return finish(title, { written, reason: "score", avgScore: scoreSum / scoreCount });
      }
      // 定期整书评估（可关）：走持久化缓存（内容指纹未变直接返回，避免每 10 章必烧一次 8 维 LLM 评估）
      const every = opts.runEvalEvery ?? 10;
      if (every > 0 && written % every === 0) {
        try {
          const fresh = load();
          if (fresh) {
            const { report, cached } = await evaluateBookCached(fresh);
            lastEval = report;
            touchSession(title, { lastEval });
            onEvent({ auto: true, phase: "auto-status", written, reason: cached ? "eval-cached" : "eval", eval: lastEval });
          }
        } catch {
          /* 评估失败不阻塞连载 */
        }
      }
    } catch (e) {
      if (e instanceof InterruptedError) {
        return finish(title, { written, reason: "interrupted", avgScore: scoreCount ? scoreSum / scoreCount : null });
      }
      if (e instanceof ReviewFailedError) {
        // git commit 被拒：草稿进暂存区（工作区保留），停下等人工决策（重试/跳过/停止）
        savePendingChapter(title, {
          chapterIndex: e.chapterIndex,
          title: e.title,
          text: e.text,
          review: e.review,
          savedAt: new Date().toISOString(),
        });
        // 记账联动：major findings 登记质量债务（锁内独立事务落盘，防与并发写章基于旧快照覆盖）
        try {
          await withTitleLock(title, async () => {
            const wd = load();
            if (wd) {
              registerReviewDebt(wd, e.chapterIndex, e.review, true);
              logChange(wd, { chapter: e.chapterIndex, actor: "system", kind: "debt-auto", detail: `连载审查未过记账联动：第 ${e.chapterIndex} 章 major 问题登记质量债务（${(wd.qualityDebt ?? []).filter((d) => d.status === "open").length} 条未处置）`, commandId: "CMD-L12" });
              saveWorld(wd);
            }
          });
        } catch {
          /* 债务登记失败不阻塞暂停流程 */
        }
        touchSession(title, {
          status: "paused",
          phase: `第 ${e.chapterIndex} 章审查未通过，等待处理`,
          pauseReason: `第 ${e.chapterIndex} 章审查未通过`,
          failedChapter: e.chapterIndex,
          failedFindings: e.review.findings,
        });
        onEvent({ auto: true, phase: "review-failed", chapter: e.chapterIndex, findings: e.review.findings });
        return { written, reason: "review", avgScore: scoreCount ? scoreSum / scoreCount : null, failedChapter: e.chapterIndex };
      }
      if (isStopped(title)) return finish(title, { written, reason: "stopped", avgScore: scoreCount ? scoreSum / scoreCount : null });
      const msg = (e as Error)?.message ?? "";
      // 配额/限流类错误：首次命中即停（限流窗口内重试必然再失败，白烧额度）
      if (/429|503|繁忙|配额/.test(msg)) {
        return finish(title, { written, reason: "quota", avgScore: scoreCount ? scoreSum / scoreCount : null });
      }
      errStreak++;
      // 连续失败：留痕停下，不硬重试（AI-Novel-Writing-Assistant 停下策略）
      if (errStreak >= 3) {
        return finish(title, { written, reason: "error", avgScore: scoreCount ? scoreSum / scoreCount : null });
      }
    }
  }
  return finish(title, { written, reason: "done", avgScore: scoreCount ? scoreSum / scoreCount : null });
}
