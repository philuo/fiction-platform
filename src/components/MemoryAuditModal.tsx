// 中枢弹窗一：分层持久化记忆（只读）· 台账 · 操作日志（审计时间线）
// 数据源：world（SSR/拉取）+ /api/novel/changelog（操作日志端点）
import { useEffect, useMemo, useState } from "react";
import type { ChangeLogEntry, WorldState } from "../api/world";
import { X } from "./icons";

type Tab = "memory" | "ledger" | "log";

const FS_STATUS_TEXT: Record<string, string> = { planted: "已埋设", active: "推进中", resolved: "已回收" };
const ACTOR_TEXT: Record<string, string> = { user: "用户", ai: "AI", brain: "中枢", system: "系统", integrity: "自检" };

export const MemoryAuditModal: React.FC<{ world: WorldState; onClose: () => void }> = (p) => {
  const w = p.world;
  const [tab, setTab] = useState<Tab>("memory");
  const [openLayer, setOpenLayer] = useState<Record<string, boolean>>({ L1: true, L2: true, L3: true });

  // 操作日志：挂载时拉取端点（world.changeLog 为只读快照，端点是权威数据）
  const [entries, setEntries] = useState<ChangeLogEntry[]>(w.changeLog ?? []);
  const [logLoading, setLogLoading] = useState(false);
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLogLoading(true);
        const res = await fetch("/api/novel/changelog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: w.title }),
        });
        const data = await res.json();
        if (alive && Array.isArray(data.entries)) setEntries(data.entries);
      } catch { /* 拉取失败用 world 快照兜底 */ } finally {
        if (alive) setLogLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [w.title]);

  const filteredEntries = useMemo(() => {
    const kw = kindFilter.trim().toLowerCase();
    return [...entries]
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .filter((e) => (actorFilter === "all" || e.actor === actorFilter))
      .filter((e) => !kw || (e.kind ?? "").toLowerCase().includes(kw) || (e.detail ?? "").toLowerCase().includes(kw));
  }, [entries, actorFilter, kindFilter]);

  const layer = (key: "L1" | "L2" | "L3", title: string, desc: string, body: React.ReactNode) => (
    <div className="mem-layer">
      <button className="mem-layer-head" onClick={() => setOpenLayer((s) => ({ ...s, [key]: !s[key] }))}>
        <span className="mem-layer-key">{key}</span>
        <b>{title}</b>
        <span className="mem-layer-desc">{desc}</span>
        <span className="mem-layer-toggle">{openLayer[key] ? "收起" : "展开"}</span>
      </button>
      {openLayer[key] && <div className="mem-layer-body">{body}</div>}
    </div>
  );

  const kv = (k: string, v: string) => (
    <div className="mem-kv"><span className="mem-kv-k">{k}</span><span className="mem-kv-v">{v || "—"}</span></div>
  );

  return (
    <div className="modal-overlay" onClick={p.onClose}>
      <div className="mem-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mem-modal-head">
          <b style={{ fontFamily: "var(--sans)" }}>中枢 · 记忆与审计</b>
          <div className="mem-tabs">
            <button className={tab === "memory" ? "mem-tab on" : "mem-tab"} onClick={() => setTab("memory")}>分层记忆</button>
            <button className={tab === "ledger" ? "mem-tab on" : "mem-tab"} onClick={() => setTab("ledger")}>台账</button>
            <button className={tab === "log" ? "mem-tab on" : "mem-tab"} onClick={() => setTab("log")}>操作日志</button>
          </div>
          <button className="mem-close" onClick={p.onClose} title="关闭"><X size={15} /></button>
        </div>

        <div className="mem-modal-body">
          {tab === "memory" && (
            <>
              {layer("L1", "设定层", "setting / 世界书 / 指南针 / 角色", (
                <>
                  <div className="mem-group-title">世界设定</div>
                  {kv("时间", w.setting.time)}
                  {kv("地点", w.setting.place)}
                  {kv("基调", w.setting.tone)}
                  {kv("规则", (w.setting.rules ?? []).join("；"))}
                  {kv("当前局势", w.current ?? "")}
                  {kv("指南针", w.blueprint?.compass ?? "")}
                  {kv("进度承诺", w.blueprint?.progressContract ?? "")}
                  <div className="mem-group-title">世界书条目（{(w.lore ?? []).length}）</div>
                  {(w.lore ?? []).length === 0 && <div className="mem-empty">暂无条目</div>}
                  {(w.lore ?? []).map((l) => (
                    <div key={l.id} className="mem-lore">
                      <b>{l.keywords.join(" / ")}</b>
                      {!l.enabled && <span className="mem-badge mem-badge-off">停用</span>}
                      {l.auto && <span className="mem-badge">自动</span>}
                      <p>{l.content}</p>
                    </div>
                  ))}
                  <div className="mem-group-title">角色（{w.characters.length}）</div>
                  {w.characters.map((c) => (
                    <div key={c.id} className="mem-char">
                      <b>{c.name}</b><span className="mem-char-role">{c.role}</span>
                      <span className="mem-char-status">{c.status}</span>
                      {c.exit && <span className="mem-badge mem-badge-off">离场·{c.exit.chapter}章</span>}
                      <span className="mem-char-meta">登场 {c.appearedIn?.length ?? 0} 章</span>
                    </div>
                  ))}
                </>
              ))}
              {layer("L2", "摘要层", "章摘要 / 弧摘要 / 卷摘要", (
                <>
                  <div className="mem-group-title">卷摘要（{(w.blueprint?.volumes ?? []).length} 卷）</div>
                  {(w.blueprint?.volumes ?? []).map((v) => (
                    <div key={v.id} className="mem-kv"><span className="mem-kv-k">{v.title}（{v.status}）</span><span className="mem-kv-v">{v.summary || v.goal || "—"}</span></div>
                  ))}
                  <div className="mem-group-title">章摘要（{(w.chapterSummaries ?? []).length}）</div>
                  {(w.chapterSummaries ?? []).slice().sort((a, b) => b.index - a.index).map((s) => (
                    <div key={s.index} className="mem-summary">
                      <b>第{s.index}章</b>
                      <p>{s.summary}</p>
                      {s.appeared.length > 0 && <span className="mem-char-meta">出场：{s.appeared.join("、")}</span>}
                    </div>
                  ))}
                  {(w.chapterSummaries ?? []).length === 0 && <div className="mem-empty">尚无摘要（写章后由记账产出）</div>}
                </>
              ))}
              {layer("L3", "检索线索", "情节弧线 / 时间线（写作时按相关度检索注入）", (
                <>
                  <div className="mem-group-title">情节弧线（{(w.plotThreads ?? []).length}）</div>
                  {(w.plotThreads ?? []).map((a) => (
                    <div key={a.id} className="mem-char"><b>{a.name}</b><span className={`mem-badge ${a.status === "已解决" ? "" : "mem-badge-warn"}`}>{a.status}</span><span className="mem-char-status">{a.note}</span></div>
                  ))}
                  <div className="mem-group-title">时间线（{(w.timeline ?? []).length}）</div>
                  {(w.timeline ?? []).slice().reverse().map((t) => (
                    <div key={t.chapter} className="mem-kv"><span className="mem-kv-k">第{t.chapter}章</span><span className="mem-kv-v">{t.summary}</span></div>
                  ))}
                </>
              ))}
            </>
          )}

          {tab === "ledger" && (
            <>
              <div className="mem-group-title">伏笔账（{w.foreshadowing.length}：活跃 {w.foreshadowing.filter((f) => f.status !== "resolved").length}）</div>
              <table className="mem-table">
                <thead><tr><th>内容</th><th>状态</th><th>埋设</th><th>回收</th><th>备注</th></tr></thead>
                <tbody>
                  {w.foreshadowing.map((f) => (
                    <tr key={f.id}>
                      <td>{f.text}</td>
                      <td><span className={`mem-badge ${f.status === "resolved" ? "" : f.status === "active" ? "mem-badge-warn" : "mem-badge-off"}`}>{FS_STATUS_TEXT[f.status] ?? f.status}</span></td>
                      <td>第{f.plantedAt}章</td>
                      <td>{f.resolvedAt ? `第${f.resolvedAt}章` : "—"}</td>
                      <td>{f.note ?? "—"}</td>
                    </tr>
                  ))}
                  {w.foreshadowing.length === 0 && <tr><td colSpan={5} className="mem-empty">暂无伏笔</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">时间线</div>
              <table className="mem-table">
                <thead><tr><th>章</th><th>事件</th></tr></thead>
                <tbody>
                  {(w.timeline ?? []).map((t) => (<tr key={t.chapter}><td>第{t.chapter}章</td><td>{t.summary}</td></tr>))}
                  {(w.timeline ?? []).length === 0 && <tr><td colSpan={2} className="mem-empty">暂无</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">情节弧线（{(w.plotThreads ?? []).length}）</div>
              <table className="mem-table">
                <thead><tr><th>弧线</th><th>状态</th><th>最近进展</th></tr></thead>
                <tbody>
                  {(w.plotThreads ?? []).map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td>
                      <td><span className={`mem-badge ${a.status === "已解决" ? "" : "mem-badge-warn"}`}>{a.status}</span></td>
                      <td>{a.note || "—"}</td>
                    </tr>
                  ))}
                  {(w.plotThreads ?? []).length === 0 && <tr><td colSpan={3} className="mem-empty">暂无弧线</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">质量债（{(w.qualityDebt ?? []).length}：未清 {(w.qualityDebt ?? []).filter((d) => d.status === "open").length}）</div>
              <table className="mem-table">
                <thead><tr><th>章</th><th>维度</th><th>问题</th><th>级别</th><th>状态</th></tr></thead>
                <tbody>
                  {(w.qualityDebt ?? []).map((d) => (
                    <tr key={d.id}>
                      <td>第{d.chapterIndex}章</td><td>{d.lens}</td><td>{d.issue}</td>
                      <td><span className={`mem-badge ${d.severity === "major" ? "mem-badge-warn" : "mem-badge-off"}`}>{d.severity}</span></td>
                      <td>{d.status === "open" ? "待处理" : d.status === "fixed" ? "已修复" : "已忽略"}</td>
                    </tr>
                  ))}
                  {(w.qualityDebt ?? []).length === 0 && <tr><td colSpan={5} className="mem-empty">暂无质量债</td></tr>}
                </tbody>
              </table>
            </>
          )}

          {tab === "log" && (
            <>
              <div className="mem-log-filter">
                <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
                  <option value="all">全部操作者</option>
                  <option value="user">用户</option>
                  <option value="ai">AI</option>
                  <option value="brain">中枢</option>
                  <option value="system">系统</option>
                </select>
                <input placeholder="筛选 kind / 内容关键字…" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} />
                <span className="mem-log-count">{logLoading ? "加载中…" : `${filteredEntries.length} / ${entries.length} 条`}</span>
              </div>
              <div className="mem-log-list">
                {filteredEntries.map((e, i) => (
                  <div key={`${e.at}-${i}`} className="mem-log-item">
                    <span className="mem-log-time">{e.at ? new Date(e.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"}</span>
                    <span className={`mem-badge ${e.actor === "user" ? "" : "mem-badge-off"}`}>{ACTOR_TEXT[e.actor] ?? e.actor}</span>
                    <span className="mem-log-kind">{e.kind}</span>
                    {e.strategy && <span className="mem-badge mem-badge-warn">{e.strategy}</span>}
                    <span className="mem-log-detail">第{e.chapter}章 · {e.detail}</span>
                  </div>
                ))}
                {filteredEntries.length === 0 && <div className="mem-empty">{logLoading ? "正在加载操作日志…" : "暂无操作日志（写操作后自动记录）"}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
