// 整书评估面板（P4）：8 维雷达式列表 + 质量债务处置（修复/忽略）
import { useEffect, useState } from "react";
import { X } from "./icons";
import { lensCn } from "../terms";
import type { WorldState, QualityDebt } from "../api/world";

type EvalReportView = {
  at: string;
  chaptersEvaluated: number;
  dimensions: { name: string; score: number; evidence: string }[];
  overall: number;
  suggestions: string[];
};

export const EvalModal: React.FC<{
  world: WorldState;
  onClose: () => void;
  onToast?: (msg: string) => void;
  onWorldUpdate?: (w: WorldState) => void;
  taskActive?: boolean;
}> = (p) => {
  const [report, setReport] = useState<EvalReportView | null>(null);
  const [cached, setCached] = useState(false);
  const [debt, setDebt] = useState<QualityDebt[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function loadAll(force = false) {
    setBusy(true);
    setErr("");
    try {
      const [evalRes, debtRes] = await Promise.all([
        fetch("/api/novel/eval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: p.world.title, force }) }),
        fetch("/api/novel/debt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: p.world.title, action: "list" }) }),
      ]);
      const ev = (await evalRes.json()) as { ok?: boolean; report?: EvalReportView; cached?: boolean; error?: string };
      if (!ev.ok || !ev.report) throw new Error(ev.error ?? "评估失败");
      setReport(ev.report);
      setCached(!!ev.cached);
      const db = (await debtRes.json()) as { ok?: boolean; debt?: QualityDebt[] };
      setDebt((db.debt ?? []).filter((d) => d.status === "open"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function debtAction(id: string, action: "fix" | "ignore") {
    if (p.taskActive) { p.onToast?.("任务运行中，质量债操作已禁止——请先取消任务。"); return; } // 运行锁
    try {
      const res = await fetch("/api/novel/debt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: p.world.title, action, id }) });
      const data = (await res.json()) as { ok?: boolean; debt?: QualityDebt[]; world?: WorldState; error?: string };
      if (!data.ok) throw new Error(data.error ?? "操作失败");
      setDebt((data.debt ?? []).filter((d) => d.status === "open"));
      if (data.world) p.onWorldUpdate?.(data.world);
      p.onToast?.(action === "fix" ? "已注入修复任务到后续章节计划。" : "已忽略该问题。");
    } catch (e) {
      p.onToast?.("操作失败: " + (e as Error).message);
    }
  }

  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "680px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>整书评估 · 8 维</b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
          {busy && <div style={{ textAlign: "center", padding: "1.5rem 0", fontSize: "0.8rem", color: "var(--ink-soft)" }}>主编审读中…</div>}
          {err && <div className="form-msg">评估失败：{err}</div>}
          {report && !busy && cached && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.74rem", color: "var(--ink-soft)", background: "var(--paper-dark)", border: "1px solid var(--line)", padding: "0.4rem 0.6rem", marginBottom: "0.7rem" }}>
              <span style={{ flex: 1 }}>评估时间：{new Date(report.at).toLocaleString("zh-CN", { hour12: false })}</span>
              <button className="btn-save btn-xs" onClick={() => void loadAll(true)}>重新评估</button>
            </div>
          )}
          {report && !busy && (
            <>
              <div style={{ textAlign: "center", marginBottom: "0.8rem" }}>
                <span style={{ fontSize: "1.6rem", fontFamily: "var(--sans)" }}>{report.overall}</span>
                <span style={{ fontSize: "0.75rem", color: "var(--ink-soft)" }}> / 10（{report.chaptersEvaluated} 章）</span>
              </div>
              {report.dimensions.map((d) => (
                <div key={d.name} style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.35rem", fontSize: "0.78rem" }}>
                  <span style={{ width: "5.2em", flexShrink: 0 }}>{d.name}</span>
                  <div style={{ flex: 1, height: "8px", background: "var(--paper-dark)", border: "1px solid var(--line)" }}>
                    <div style={{ width: `${d.score * 10}%`, height: "100%", background: d.score >= 7 ? "var(--seal)" : d.score >= 5 ? "var(--gold, #a67c2e)" : "var(--ink-soft)" }} />
                  </div>
                  <span style={{ width: "2em", textAlign: "right" }}>{d.score}</span>
                  <span style={{ flex: 2, fontSize: "0.68rem", color: "var(--ink-soft)" }}>{d.evidence.slice(0, 40)}</span>
                </div>
              ))}
              {report.suggestions.length > 0 && (
                <div style={{ marginTop: "0.8rem", fontSize: "0.78rem" }}>
                  <b>主编建议：</b>
                  <ul style={{ margin: "0.3rem 0 0 1.2rem" }}>
                    {report.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                </div>
              )}
            </>
          )}

          {debt.length > 0 && (
            <div style={{ marginTop: "1rem" }}>
              <h4 style={{ fontFamily: "var(--sans)", fontSize: "0.82rem" }}>待处理质量债务（{debt.length}）</h4>
              {debt.slice(0, 8).map((d) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.74rem", marginTop: "0.3rem" }}>
                  <span className="panel-tag tag-muted">第{d.chapterIndex}章·{lensCn(d.lens)}</span>
                  <span style={{ flex: 1 }}>{d.issue.slice(0, 50)}</span>
                  <button className="btn-save btn-xs" disabled={p.taskActive} title={p.taskActive ? "任务运行中已禁止" : undefined} onClick={() => debtAction(d.id, "fix")}>修复</button>
                  <button className="btn-save btn-xs" disabled={p.taskActive} title={p.taskActive ? "任务运行中已禁止" : undefined} onClick={() => debtAction(d.id, "ignore")}>忽略</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
