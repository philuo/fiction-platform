// 中枢弹窗一：分层持久化记忆（只读）· 台账 · 操作日志（审计时间线）
// 数据源：world（SSR/拉取）+ /api/novel/changelog（操作日志端点）
import { useEffect, useMemo, useState } from "react";
import type { ChangeLogEntry, WorldState } from "../api/world";
import { getCommand } from "../api/harness";
import { lensCn, severityCn } from "../terms";
import { X } from "./icons";

type Tab = "memory" | "ledger" | "log";

const FS_STATUS_TEXT: Record<string, string> = { planted: "已埋设", active: "推进中", resolved: "已回收" };
const ACTOR_TEXT: Record<string, string> = { user: "用户", ai: "AI", brain: "中枢", system: "系统", integrity: "自检" };
/** 指令级别徽章样式（L0-L3，对已完成叙事/账本的破坏性） */
const LEVEL_TEXT: Record<string, string> = { L0: "L0·只读", L1: "L1·前瞻", L2: "L2·回溯", L3: "L3·不可逆" };
/** 操作者筛选三档：全部 / 用户 / AI（含中枢·系统·自检等自动操作） */
const ACTOR_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "全部操作者" },
  { value: "user", label: "用户" },
  { value: "auto", label: "AI" },
];

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
      // 操作者筛选合并为三档：全部 / 用户（user）/ AI（其余全部归 AI 组：ai/brain/system/integrity 等自动操作）
      .filter((e) => actorFilter === "all" || (actorFilter === "user" ? e.actor === "user" : e.actor !== "user"))
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
              {layer("L1", "设定层", "基础 / 自定义", (
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
              <table className="mem-table fs-ledger">
                <thead><tr><th className="mem-col-main">内容</th><th className="mem-col-narrow">状态</th><th className="mem-col-narrow">埋设</th><th className="mem-col-narrow">回收</th><th className="mem-col-main">备注</th></tr></thead>
                <tbody>
                  {w.foreshadowing.map((f) => (
                    <tr key={f.id}>
                      <td className="mem-col-main">{f.text}</td>
                      <td className="mem-col-narrow"><span className={`mem-badge ${f.status === "resolved" ? "" : f.status === "active" ? "mem-badge-warn" : "mem-badge-off"}`}>{FS_STATUS_TEXT[f.status] ?? f.status}</span></td>
                      <td className="mem-col-narrow">第{f.plantedAt}章</td>
                      <td className="mem-col-narrow">{f.resolvedAt ? `第${f.resolvedAt}章` : "—"}</td>
                      <td className="mem-col-main">{f.note ?? "—"}</td>
                    </tr>
                  ))}
                  {w.foreshadowing.length === 0 && <tr><td colSpan={5} className="mem-empty">暂无伏笔</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">时间线</div>
              <table className="mem-table tl-ledger">
                <thead><tr><th className="mem-col-narrow">章</th><th className="mem-col-main">事件</th></tr></thead>
                <tbody>
                  {(w.timeline ?? []).map((t) => (<tr key={t.chapter}><td className="mem-col-narrow">第{t.chapter}章</td><td className="mem-col-main">{t.summary}</td></tr>))}
                  {(w.timeline ?? []).length === 0 && <tr><td colSpan={2} className="mem-empty">暂无</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">情节弧线（{(w.plotThreads ?? []).length}）</div>
              <table className="mem-table arc-ledger">
                <thead><tr><th className="mem-col-main">弧线</th><th className="mem-col-narrow">状态</th><th className="mem-col-main">最近进展</th></tr></thead>
                <tbody>
                  {(w.plotThreads ?? []).map((a) => (
                    <tr key={a.id}>
                      <td className="mem-col-main">{a.name}</td>
                      <td className="mem-col-narrow"><span className={`mem-badge ${a.status === "已解决" ? "" : "mem-badge-warn"}`}>{a.status}</span></td>
                      <td className="mem-col-main">{a.note || "—"}</td>
                    </tr>
                  ))}
                  {(w.plotThreads ?? []).length === 0 && <tr><td colSpan={3} className="mem-empty">暂无弧线</td></tr>}
                </tbody>
              </table>
              <div className="mem-group-title">质量债（{(w.qualityDebt ?? []).length}：未清 {(w.qualityDebt ?? []).filter((d) => d.status === "open").length}）</div>
              <table className="mem-table qd-ledger">
                <thead><tr><th className="mem-col-narrow">章</th><th className="mem-col-narrow">维度</th><th className="mem-col-main">问题</th><th className="mem-col-narrow">级别</th><th className="mem-col-narrow">状态</th></tr></thead>
                <tbody>
                  {(w.qualityDebt ?? []).map((d) => (
                    <tr key={d.id}>
                      <td className="mem-col-narrow">第{d.chapterIndex}章</td>
                      <td className="mem-col-narrow">{lensCn(d.lens)}</td>
                      <td className="mem-col-main">{d.issue}</td>
                      <td className="mem-col-narrow"><span className={`mem-badge ${d.severity === "major" ? "mem-badge-warn" : "mem-badge-off"}`}>{severityCn(d.severity)}</span></td>
                      <td className="mem-col-narrow">{d.status === "open" ? "待处理" : d.status === "fixed" ? "已修复" : "已忽略"}</td>
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
                  {ACTOR_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <input placeholder="筛选 kind / 内容关键字…" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} />
                <span className="mem-log-count">{logLoading ? "加载中…" : `${filteredEntries.length} / ${entries.length} 条`}</span>
              </div>
              <div className="mem-log-list">
                {filteredEntries.map((e, i) => {
                  const cmd = e.commandId ? getCommand(e.commandId) : undefined;
                  return (
                    <div key={`${e.at}-${i}`} className="mem-log-item">
                      <span className="mem-log-time">{e.at ? new Date(e.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"}</span>
                      <span className={`mem-badge ${e.actor === "user" ? "" : "mem-badge-off"}`}>{ACTOR_TEXT[e.actor] ?? e.actor}</span>
                      {cmd && <span className="mem-badge mem-badge-cmd" title={cmd.name}>{e.commandId}</span>}
                      {e.level && <span className={`mem-badge ${e.level === "L3" ? "mem-badge-warn" : e.level === "L2" ? "" : "mem-badge-off"}`} title="对已完成叙事/账本的破坏级别">{LEVEL_TEXT[e.level] ?? e.level}</span>}
                      <span className="mem-log-kind">{e.kind}</span>
                      {e.strategy && <span className="mem-badge mem-badge-warn">{e.strategy}</span>}
                      <span className="mem-log-detail">第{e.chapter}章 · {e.detail}</span>
                      {e.reason && <div className="mem-log-reason">中枢：{e.reason}</div>}
                    </div>
                  );
                })}
                {filteredEntries.length === 0 && <div className="mem-empty">{logLoading ? "正在加载操作日志…" : "暂无操作日志（写操作后自动记录）"}</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
