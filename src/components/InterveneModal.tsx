// 干预处理面板（P3.5）：L2 回溯变更的影响报告 + 三选一（正向弥合/回溯重写/放弃变更）
import { AlertTriangle, X } from "./icons";

export type ImpactReportView = {
  affectedChapters: number[];
  conflicts: string[];
  reverseRelationHint?: string;
  options: ("merge" | "rewrite" | "abort")[];
};

export const InterveneModal: React.FC<{
  report: ImpactReportView;
  changeDesc: string;
  busy?: boolean;
  onChoose: (strategy: "merge" | "rewrite" | "abort") => void;
  onClose: () => void;
}> = (p) => {
  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "640px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>
            <AlertTriangle size={14} /> 回溯性变更 · 影响评估
          </b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          <p style={{ fontSize: "0.82rem", color: "var(--ink-soft)", marginBottom: "0.7rem" }}>
            本次修改涉及已写内容（{p.changeDesc}），直接落盘可能造成剧情矛盾。请选择处置方式：
          </p>

          {p.report.affectedChapters.length > 0 && (
            <div style={{ fontSize: "0.8rem", marginBottom: "0.6rem" }}>
              <b>受影响章节：</b>第 {p.report.affectedChapters.join("、")} 章
            </div>
          )}

          {p.report.conflicts.length > 0 && (
            <div style={{ marginBottom: "0.6rem" }}>
              <b style={{ fontSize: "0.8rem" }}>与既成事实的冲突：</b>
              <ul style={{ fontSize: "0.78rem", color: "var(--seal)", margin: "0.3rem 0 0 1.2rem" }}>
                {p.report.conflicts.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {p.report.reverseRelationHint && (
            <div style={{ fontSize: "0.78rem", marginBottom: "0.8rem", padding: "0.5rem 0.7rem", background: "var(--paper-dark)", border: "1px dashed var(--line)" }}>
              <b>反向关系建议：</b>{p.report.reverseRelationHint}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.8rem" }}>
            <button className="btn btn-primary" disabled={p.busy} onClick={() => p.onChoose("merge")} style={{ textAlign: "left" }}>
              ① 正向弥合（推荐）· 已写正文不动，注入弥合任务让后续剧情自然解释变更
            </button>
            <button className="btn" disabled={p.busy} onClick={() => p.onChoose("rewrite")} style={{ textAlign: "left" }}>
              ② 回溯重写 · 受影响章节入重写队列，逐章重生成（成本高）
            </button>
            <button className="btn" disabled={p.busy} onClick={() => p.onChoose("abort")} style={{ textAlign: "left" }}>
              ③ 放弃变更 · 不应用本次修改
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
