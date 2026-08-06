// 连载控制台（git 式自动连载可视化）：进度 / 每章状态 / 审查失败详情 / 停止·重试·跳过·放弃
import { AlertTriangle, RefreshCw, X } from "./icons";

export type AutoSessionView = {
  status: "running" | "paused" | "stopped" | "done";
  target: number;
  written: number;
  phase: string;
  pauseReason?: string;
  failedChapter?: number;
  failedFindings?: { severity: string; lens: string; issue: string; evidence: string; suggestion: string }[];
  lastEval?: unknown;
  startedAt: string;
  updatedAt: string;
};

export type PendingChapterView = {
  chapterIndex: number;
  title: string;
  review?: { verdict?: string; findings?: { severity: string; lens: string; issue: string; evidence: string; suggestion: string }[] } | null;
};

type Props = {
  session: AutoSessionView;
  pending: PendingChapterView | null;
  debtCount: number;
  onStop: () => void;
  onInterrupt: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onDiscard: () => void;
  onClose: () => void;
  onOpenEval: () => void;
};

const STATUS_TEXT: Record<AutoSessionView["status"], string> = {
  running: "连载中",
  paused: "已暂停 · 审查未过",
  stopped: "已停止",
  done: "已完成",
};

export const AutoRunPanel: React.FC<Props> = (p) => {
  const s = p.session;
  const paused = s.status === "paused";
  const running = s.status === "running";
  const ended = s.status === "stopped" || s.status === "done";
  const pct = s.target > 0 ? Math.min(100, Math.round((s.written / s.target) * 100)) : 0;
  const findings = p.pending?.review?.findings ?? s.failedFindings ?? [];
  const majors = findings.filter((f) => f.severity === "major");

  return (
    <div className="modal-overlay" onClick={() => { if (!running) p.onClose(); }}>
      <div className="auto-panel" onClick={(e) => e.stopPropagation()}>
        {/* 头部：状态徽章 + 进度 + 阶段 */}
        <div className="auto-panel-head">
          <span className={`auto-badge auto-badge-${s.status}`}>{STATUS_TEXT[s.status]}</span>
          <b style={{ fontFamily: "var(--sans)" }}>
            {s.written}/{s.target} 章
          </b>
          <span className="auto-phase">{s.phase}</span>
          <span style={{ flex: 1 }} />
          <button className="btn-save btn-xs" onClick={p.onClose} title={running ? "收起面板（连载继续后台运行）" : "关闭"}>
            <X size={12} /> 收起
          </button>
        </div>

        <div style={{ height: "6px", background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "3px", overflow: "hidden", marginBottom: "0.7rem" }}>
          <div style={{ height: "100%", width: `${pct}%`, background: s.status === "paused" ? "var(--seal)" : "var(--seal)", transition: "width 0.4s ease" }} />
        </div>

        {/* 每章状态（git 式）：已提交 / 审查失败 / 进行中 */}
        <div className="auto-chapters">
          {Array.from({ length: Math.min(s.target, 30) }, (_, i) => i + 1).map((no) => {
            const isFailed = p.pending?.chapterIndex === no;
            const isCommitted = no <= s.written;
            const isNext = !isCommitted && !isFailed && no === s.written + 1;
            return (
              <span
                key={no}
                className={`auto-ch ${isCommitted ? "done" : isFailed ? "failed" : isNext ? "next" : "todo"}`}
                title={isCommitted ? `第 ${no} 章已提交` : isFailed ? `第 ${no} 章审查未通过` : isNext ? `第 ${no} 章（当前）` : `第 ${no} 章待写`}
              >
                {no}
              </span>
            );
          })}
        </div>

        {/* 暂停详情：审查未通过 → 问题清单（记账联动） */}
        {paused && (
          <div className="auto-fail" style={{ border: "1px dashed var(--line-strong)", padding: "0.6rem 0.8rem", background: "var(--paper-dark)", marginBottom: "0.7rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem" }}>
              <AlertTriangle size={14} style={{ color: "var(--seal)" }} />
              <b style={{ fontFamily: "var(--sans)", fontSize: "0.82rem" }}>
                第 {p.pending?.chapterIndex ?? s.failedChapter ?? "?"} 章《{p.pending?.title ?? ""}》审查未通过
              </b>
            </div>
            <div style={{ fontSize: "0.76rem", color: "var(--ink-soft)", marginBottom: "0.3rem" }}>
              已登记 {majors.length} 条 major / {findings.length} 条问题至质量债务（共 {p.debtCount} 条未处置），修复通过后再继续连载。
            </div>
            {findings.map((f, i) => (
              <div key={i} style={{ fontSize: "0.74rem", marginBottom: "0.25rem", lineHeight: 1.6 }}>
                <span className={`fs-status ${f.severity === "major" ? "fs-active" : ""}`}>{f.severity === "major" ? "● major" : "○ minor"}</span>{" "}
                <b>[{f.lens}]</b> {f.issue}
                {f.suggestion && <div style={{ color: "var(--ink-soft)", marginLeft: "1.1rem" }}>建议：{f.suggestion}</div>}
              </div>
            ))}
          </div>
        )}

        {/* 联动摘要：评估入口 */}
        {s.lastEval ? (
          <div className="auto-links" style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.7rem", fontSize: "0.76rem", color: "var(--ink-soft)" }}>
            <span>最近整书评估已完成</span>
            <button className="btn-save btn-xs" onClick={p.onOpenEval}>查看报告</button>
          </div>
        ) : null}

        {/* 操作区 */}
        <div className="auto-actions" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {running && (
            <>
              <button className="btn btn-danger-sm" onClick={p.onStop} title="当前章结束后停下"><X size={13} /> 停止连载</button>
              <button className="btn btn-danger-sm" onClick={p.onInterrupt} title="立即中断当前章（草稿不存档）"><X size={13} /> 立即打断</button>
            </>
          )}
          {paused && (
            <>
              <button className="btn btn-primary" onClick={p.onRetry} title="以审查意见重写本章，通过后继续连载"><RefreshCw size={13} /> 重试本章并继续</button>
              <button className="btn" onClick={p.onSkip} title="丢弃本章草稿，直接写下一章"><X size={13} /> 跳过本章继续</button>
              <button className="btn btn-danger-sm" onClick={p.onDiscard} title="放弃本次连载（已写章节保留）"><X size={13} /> 放弃连载</button>
            </>
          )}
          {ended && (
            <button className="btn" onClick={p.onDiscard} title="清理会话记录"><X size={13} /> 关闭并清理</button>
          )}
          {ended && <span style={{ fontSize: "0.74rem", color: "var(--ink-soft)", alignSelf: "center" }}>{s.phase}</span>}
        </div>
      </div>
    </div>
  );
};
