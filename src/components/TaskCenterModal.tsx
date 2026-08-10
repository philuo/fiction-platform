// 任务中心（弹窗二）：自动连载 / 推进剧情 两类任务的进度步骤可视化 + 运行控制
// 连载：暂停/恢复/移除；推进：取消；commitPolicy=confirm 时展示"确认入册/放弃"确认条
// 运行中互斥约束（AI 类禁用、手工编辑类放行）由 Home.tsx 的按钮 disabled 策略落实
import { AlertTriangle, Pause, Play, RefreshCw, X } from "./icons";
import type { AutoSessionView, PendingChapterView } from "./AutoRunPanel";

/** 从阶段文字推导步骤序号（SSE phase / busyPhase / session.phase 的关键字匹配） */
function stepIndex(phase: string): number {
  if (phase.includes("考据")) return 1;
  if (phase.includes("本章计划") || phase.includes("大纲")) return 2;
  if (phase.includes("写作")) return 3;
  if (phase.includes("审查")) return 4;
  if (phase.includes("修补")) return 5;
  if (phase.includes("结算")) return 6;
  if (phase.includes("存档") || phase.includes("已提交")) return 7;
  return 0;
}

const STEP_NAMES = ["准备", "考据", "本章计划", "写作", "审查", "修补", "结算", "存档"];

const StepBar: React.FC<{ phase: string; failed?: boolean }> = (p) => {
  const cur = stepIndex(p.phase);
  return (
    <div className="task-steps">
      {STEP_NAMES.map((name, i) => (
        <div key={name} className={`task-step ${i < cur ? "done" : i === cur ? (p.failed ? "failed" : "active") : ""}`}>
          <span className="task-step-dot" />
          <span className="task-step-name">{name}</span>
        </div>
      ))}
    </div>
  );
};

type Props = {
  title: string;
  session: AutoSessionView | null;
  pending: PendingChapterView | null;
  /** 推进剧情当前阶段（busyPhase）；空串 = 空闲 */
  advancePhase: string;
  advanceBusy: boolean;
  /** 世界构建中阶段文案（壳就绪后后台增强蓝图/章节；非空时任务中心显示构建进度） */
  buildingStage?: string | null;
  autoRunning: boolean; // 本页正在跑 auto SSE（运行中才可暂停）
  pendingCommitIdx: number | null; // 推进剧情待人工确认入册的章节号（SSE pending-commit 事件）
  onClose: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
  onCancelAdvance: () => void;
  onConfirmPending: () => void;
  onRejectPending: () => void;
  onOpenAutoPanel: () => void;
};

export const TaskCenterModal: React.FC<Props> = (p) => {
  const s = p.session;
  const running = s?.status === "running";
  const paused = s?.status === "paused";
  const pct = s && s.target > 0 ? Math.min(100, Math.round((s.written / s.target) * 100)) : 0;
  const hasPendingCommit = p.pendingCommitIdx !== null;

  return (
    <div className="modal-overlay" onClick={p.onClose}>
      <div className="task-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mem-modal-head">
          <b style={{ fontFamily: "var(--sans)" }}>任务中心</b>
          <span className="mem-layer-desc">任务进度步骤可视化 · 运行控制（任务运行中一切编辑类操作全面禁止，取消任务回空闲后才可手动操作）</span>
          <button className="mem-close" onClick={p.onClose} title="关闭"><X size={15} /></button>
        </div>

        <div className="mem-modal-body">
          {/* —— 自动连载任务 —— */}
          <div className="mem-group-title">自动连载</div>
          {s ? (
            <>
              <div className="task-row">
                <span className={`auto-badge auto-badge-${s.status}`}>
                  {running ? "连载中" : paused ? "已暂停" : s.status === "done" ? "已完成" : "已停止"}
                </span>
                <b>{s.written}/{s.target} 章（{pct}%）</b>
                <span className="mem-char-status">{s.phase}</span>
              </div>
              <div className="task-progress"><div className="task-progress-bar" style={{ width: `${pct}%` }} /></div>
              {(running || paused) && <StepBar phase={p.autoRunning ? (s.phase || "准备") : "已暂停"} failed={paused && !!s.failedChapter} />}
              {paused && s.pauseReason && <div className="task-note task-note-warn"><AlertTriangle size={12} /> {s.pauseReason}</div>}
              <div className="task-actions">
                {running && p.autoRunning && (
                  <>
                    <button className="btn btn-ghost" onClick={p.onPause} title="章边界停下，保持会话可恢复"><Pause size={14} /> 暂停</button>
                    <button className="btn btn-danger-sm" onClick={p.onRemove} title="取消任务：立即打断并清理会话与暂存区，回到空闲状态后才可手动操作"><X size={14} /> 取消任务</button>
                  </>
                )}
                {paused && (
                  <>
                    <button className="btn btn-primary" onClick={p.onResume} title="恢复连载（复用原目标与已写章数）"><Play size={14} /> 恢复</button>
                    <button className="btn btn-danger-sm" onClick={p.onRemove} title="取消任务：立即打断并清理会话与暂存区，回到空闲状态后才可手动操作"><X size={14} /> 取消任务</button>
                  </>
                )}
                {p.pending && !hasPendingCommit && (
                  <button className="btn btn-ghost" onClick={p.onOpenAutoPanel} title="重试/跳过审查未过的暂存章节"><RefreshCw size={14} /> 处理暂存章节</button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="mem-empty">暂无连载任务 · 在底部「推进剧情」下拉选「章节连载」开始</div>
            </>
          )}

          {/* —— 世界构建任务（异步立项增强阶段） —— */}
          {p.buildingStage ? (
            <>
              <div className="mem-group-title" style={{ marginTop: "1.2rem" }}>世界构建</div>
              <div className="task-row">
                <span className="auto-badge auto-badge-running">构建中</span>
                <span className="mem-char-status">{p.buildingStage}</span>
              </div>
              <div className="task-progress"><div className="task-progress-bar task-progress-bar-indeterminate" /></div>
              <div className="task-note">正在后台增强故事蓝图与章节结构，完成后自动进入可写作状态；期间推进/编辑已禁用</div>
            </>
          ) : null}

          {/* —— 推进剧情任务 —— */}
          <div className="mem-group-title" style={{ marginTop: "1.2rem" }}>推进剧情（单章）</div>
          {p.advanceBusy ? (
            <>
              <StepBar phase={p.advancePhase} />
              <div className="task-note">{p.advancePhase || "准备中…"}</div>
              <div className="task-actions">
                <button className="btn btn-danger-sm" onClick={p.onCancelAdvance} title="立即打断：阶段边界丢弃草稿，零污染"><X size={14} /> 取消推进</button>
              </div>
            </>
          ) : hasPendingCommit ? (
            <>
              <div className="task-note task-note-info">
                第 {p.pending?.chapterIndex ?? p.pendingCommitIdx} 章{p.pending?.title ? `《${p.pending.title}》` : ""}审查已通过，等待你确认后作为新版本入册（commitPolicy=人工确认）。
              </div>
              <div className="task-actions">
                <button className="btn btn-primary" onClick={p.onConfirmPending}><Play size={14} /> 确认入册</button>
                <button className="btn btn-danger-sm" onClick={p.onRejectPending}><X size={14} /> 放弃草稿</button>
              </div>
            </>
          ) : (
            <div className="mem-empty">空闲 · 在底部控制条点「推进剧情」开始单章写作任务</div>
          )}

          {/* —— 运行中互斥说明 —— */}
          {(running || p.advanceBusy) && (
            <div className="task-note" style={{ marginTop: "1rem" }}>
              ⚠ 任务运行中（含暂停态）：一切编辑类操作全面禁止（编辑/删章/版本切换/角色/伏笔/关系/设定/大纲/抽卡/评估/AI修复/重算账本，AI 与手工均不可）——请取消任务回到空闲状态后再手动操作。
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
