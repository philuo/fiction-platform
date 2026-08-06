// 规划面板（P4）：卷 → 弧 → 章纲树 + 指南针/进度承诺展示 + 手动展开弧
import { useState } from "react";
import type { WorldState } from "../api/world";

export const PlanPanel: React.FC<{ world: WorldState; onWorldUpdate?: (w: WorldState) => void; onToast?: (msg: string) => void; taskActive?: boolean }> = (p) => {
  const w = p.world;
  const [busyArc, setBusyArc] = useState<string | null>(null);
  const bp = w.blueprint;
  const arcs = w.storyArcs ?? [];
  const plans = w.chapterPlans ?? [];

  async function expandArc(arcId: string) {
    if (p.taskActive) { p.onToast?.("任务运行中，大纲/章纲操作已禁止——请先取消任务。"); return; } // 运行锁
    setBusyArc(arcId);
    try {
      const res = await fetch("/api/novel/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: w.title, action: "expand", arcId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? "展开失败");
      p.onToast?.("弧章纲已展开");
      // 重新拉取世界状态（plans 已变更）
      const st = await fetch("/api/novel/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: w.title }),
      });
      const sd = (await st.json()) as { world?: WorldState };
      if (sd.world) p.onWorldUpdate?.(sd.world);
    } catch (e) {
      p.onToast?.("展开失败: " + (e as Error).message);
    } finally {
      setBusyArc(null);
    }
  }

  if (!bp) {
    return <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)", padding: "0.5rem 0" }}>（尚无蓝图，立项后自动导演生成；推进剧情时会自动补建）</div>;
  }

  const statusLabel: Record<string, string> = { skeleton: "骨架", expanded: "已展开", writing: "写作中", done: "✓ 完成", planned: "规划中" };

  return (
    <div>
      <h3 className="col-title">指南针</h3>
      <div style={{ fontSize: "0.76rem", lineHeight: 1.6 }}>
        <div><b>方向：</b>{bp.compass}</div>
        <div><b>主线：</b>{bp.mainPlot.slice(0, 120)}{bp.mainPlot.length > 120 ? "…" : ""}</div>
        <div><b>进度承诺：</b>{bp.progressContract.slice(0, 100)}{bp.progressContract.length > 100 ? "…" : ""}</div>
      </div>

      {bp.volumes.map((v) => (
        <div key={v.id} style={{ marginTop: "0.8rem" }}>
          <h3 className="col-title">
            《{v.title}》 <span className={`panel-tag ${v.status === "done" ? "tag-seal" : "tag-muted"}`}>{statusLabel[v.status] ?? v.status}</span>
          </h3>
          <div style={{ fontSize: "0.72rem", color: "var(--ink-soft)" }}>{v.goal}</div>
          {arcs.filter((a) => a.volumeId === v.id).map((a) => (
            <div key={a.id} style={{ margin: "0.4rem 0 0.4rem 0.4rem", borderLeft: "2px solid var(--line)", paddingLeft: "0.5rem" }}>
              <div style={{ fontSize: "0.76rem" }}>
                <b>{a.title}</b> <span className="panel-tag tag-muted">{a.arcType}·{statusLabel[a.status] ?? a.status}·约{a.estChapters}章</span>
                {a.status === "skeleton" && (
                  <button className="btn-save btn-xs" style={{ marginLeft: "0.4rem" }} disabled={busyArc === a.id || p.taskActive} title={p.taskActive ? "任务运行中已禁止（大纲操作）" : undefined} onClick={() => expandArc(a.id)}>
                    {busyArc === a.id ? "展开中…" : "展开章纲"}
                  </button>
                )}
              </div>
              <div style={{ fontSize: "0.7rem", color: "var(--ink-soft)" }}>{a.goal}</div>
              {plans.filter((pl) => pl.arcId === a.id).map((pl) => (
                <div key={pl.index} style={{ fontSize: "0.72rem", marginTop: "0.2rem" }}>
                  <span className={`fs-status ${pl.status === "done" ? "fs-resolved" : "fs-active"}`}>{pl.status === "done" ? "✓" : "○"}</span>{" "}
                  第{pl.index}章 {pl.goal.slice(0, 40)}
                  {pl.mergeTasks?.length ? <span style={{ color: "var(--seal)" }}>（含弥合任务）</span> : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
