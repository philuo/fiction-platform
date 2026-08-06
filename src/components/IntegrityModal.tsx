// 一致性报告弹窗：章节变更（编辑/重写/回滚/删除）后的确定性审计结果呈现。
// 两种形态：info（巡检/变更后报告，仅关闭）；confirm（删章预览，确认删除/放弃）。
import { AlertTriangle, Info, X } from "./icons";

export type IntegrityFindingView = {
  id: string;
  level: "info" | "warning" | "danger";
  kind: string;
  chapterIndex?: number;
  issue: string;
  suggestion: string;
};

export type IntegrityReportView = {
  autoFixed: string[];
  findings: IntegrityFindingView[];
  orphanMedia: { chapterIndex: number; mediaId: string; kind: "image" | "video"; anchor: string }[];
};

const LEVEL_LABEL: Record<IntegrityFindingView["level"], string> = { info: "提示", warning: "警告", danger: "危险" };

export const IntegrityModal: React.FC<{
  title: string; // 弹窗标题（如「删除第 3 章《…》· 影响评估」/「一致性巡检报告」）
  desc?: string; // 顶部说明文案
  tip?: string; // 标题旁 tip 图标：悬浮显示说明（与 desc 可同时存在）
  report: IntegrityReportView;
  mode?: "info" | "confirm"; // confirm = 删章预览（确认删除/放弃）
  busy?: boolean;
  onConfirm?: () => void; // confirm 模式：确认执行（merge）
  onRepair?: () => void; // info 模式（巡检报告）：一键修复入口；不传则不显示
  onClose: () => void; // 关闭/放弃（abort）
}> = (p) => {
  const r = p.report;
  const dangers = r.findings.filter((f) => f.level === "danger");
  const warnings = r.findings.filter((f) => f.level === "warning");
  const infos = r.findings.filter((f) => f.level === "info");
  const empty = !r.autoFixed.length && !r.findings.length && !r.orphanMedia.length;
  const renderList = (items: IntegrityFindingView[]) => (
    <ul className="integrity-list">
      {items.map((f) => (
        <li key={f.id} className={`integrity-item level-${f.level}`}>
          <span className={`integrity-badge level-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
          <span className="integrity-issue">{f.issue}</span>
          {f.suggestion && <span className="integrity-suggestion">{f.suggestion}</span>}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className="modal modal-stable" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "640px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>
            <AlertTriangle size={14} /> {p.title}
            {p.tip && (
              <span className="tip-wrap">
                <Info size={13} className="tip-icon" />
                <span className="tip-bubble" role="tooltip">{p.tip}</span>
              </span>
            )}
          </b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          {p.desc && (
            <p style={{ fontSize: "0.82rem", color: "var(--ink-soft)", marginBottom: "0.7rem" }}>{p.desc}</p>
          )}
          {empty && (
            <p style={{ fontSize: "0.82rem", color: "var(--ink-soft)" }}>未发现一致性问题。</p>
          )}
          {r.autoFixed.length > 0 && (
            <div className="integrity-section">
              <b className="integrity-section-title">已自动修复</b>
              <ul className="integrity-list">
                {r.autoFixed.map((s, i) => <li key={i} className="integrity-item level-fixed">✓ {s}</li>)}
              </ul>
            </div>
          )}
          {dangers.length > 0 && (
            <div className="integrity-section">
              <b className="integrity-section-title">危险项（需知悉）</b>
              {renderList(dangers)}
            </div>
          )}
          {warnings.length > 0 && (
            <div className="integrity-section">
              <b className="integrity-section-title">警告</b>
              {renderList(warnings)}
            </div>
          )}
          {infos.length > 0 && (
            <div className="integrity-section">
              <b className="integrity-section-title">提示</b>
              {renderList(infos)}
            </div>
          )}
          {r.orphanMedia.length > 0 && (
            <div className="integrity-section">
              <b className="integrity-section-title">失配媒体（锚定段落已变更）</b>
              <ul className="integrity-list">
                {r.orphanMedia.map((m) => (
                  <li key={m.mediaId} className="integrity-item level-warning">
                    <span className="integrity-issue">
                      第 {m.chapterIndex} 章 {m.kind === "video" ? "视频" : "插画"}：「{m.anchor.slice(0, 30)}{m.anchor.length > 30 ? "…" : ""}」
                    </span>
                    <span className="integrity-suggestion">可在正文中找到该媒体，修改提示词重新生成或删除</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", gap: "0.8rem", justifyContent: "flex-end", marginTop: "1rem" }}>
            {p.mode === "confirm" ? (
              <>
                <button className="btn" disabled={p.busy} onClick={p.onClose}>放弃</button>
                <button className="btn btn-primary btn-danger" disabled={p.busy} onClick={p.onConfirm}>
                  {p.busy ? "处理中…" : "确认删除"}
                </button>
              </>
            ) : (
              <>
                {p.onRepair && (
                  <button className="btn" disabled={p.busy} onClick={p.onRepair}>{p.busy ? "修复中…" : "一键修复"}</button>
                )}
                <button className="btn btn-primary" onClick={p.onClose}>关闭</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
