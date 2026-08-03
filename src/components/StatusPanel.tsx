// 右栏状态面板：创作进度 / 人物 / 伏笔账本（CRUD）/ 已抽卡牌
import { useState } from "react";
import { PenLine, Plus, Trash2, X } from "../components/icons";
import type { WorldState, Foreshadow } from "../api/world";

export const StatusPanel: React.FC<{ world: WorldState; busyPhase?: string; onWorldUpdate?: (w: WorldState) => void }> = (p) => {
  const totalChars = p.world.chapters.reduce((n, c) => n + c.text.length, 0);
  const activeFs = p.world.foreshadowing.filter((f) => f.status !== "resolved").length;

  // 伏笔 CRUD 状态
  const [editingFs, setEditingFs] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addText, setAddText] = useState("");
  const [addNote, setAddNote] = useState("");
  const [editText, setEditText] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editStatus, setEditStatus] = useState<"planted" | "active" | "resolved">("planted");
  const [fsBusy, setFsBusy] = useState(false);

  async function fsApi(action: string, data: Record<string, unknown>) {
    setFsBusy(true);
    try {
      const res = await fetch("/api/novel/foreshadow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.world.title, action, ...data }),
      });
      const d = (await res.json()) as { ok?: boolean; foreshadowing?: Foreshadow[]; error?: string };
      if (!d.ok) throw new Error(d.error ?? "操作失败");
      // 更新父组件的 world
      if (d.foreshadowing && p.onWorldUpdate) {
        p.onWorldUpdate({ ...p.world, foreshadowing: d.foreshadowing });
      }
    } catch (e) {
      console.error("[foreshadow]", e);
    } finally {
      setFsBusy(false);
    }
  }

  function startEditFs(f: Foreshadow) {
    setEditingFs(f.id);
    setEditText(f.text);
    setEditNote(f.note ?? "");
    setEditStatus(f.status);
    setConfirmDel(null);
  }

  return (
    <>
      <div className="game-col right">
        <h3 className="col-title">创作进度</h3>
        <div className="progress-stats">
          <div className="progress-stat"><b>{p.world.chapters.length}</b><span>章节</span></div>
          <div className="progress-stat"><b>{totalChars}</b><span>字数</span></div>
          <div className="progress-stat"><b>{activeFs}</b><span>活跃伏笔</span></div>
          <div className="progress-stat"><b>{p.world.outline?.length ?? 0}</b><span>大纲要点</span></div>
        </div>
        {p.busyPhase && <div className="progress-phase">{p.busyPhase}</div>}

        <h3 className="col-title">人物</h3>
        <ul className="panel-list">
          {p.world.characters.map((c) => (
            <li className="panel-item" key={c.id}>
              <span className="panel-name">{c.name}</span>{" "}
              <span className="panel-tag tag-seal">{c.role}</span>
              <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)" }}>{c.status}</div>
            </li>
          ))}
        </ul>

        <h3 className="col-title">
          伏笔账
          <span className="panel-tag tag-muted">{activeFs} 活跃</span>
        </h3>
        {/* 新增伏笔按钮 */}
        <div style={{ marginBottom: "0.4rem" }}>
          <button className="btn-save" onClick={() => { setShowAdd(!showAdd); setConfirmDel(null); setEditingFs(null); }} disabled={fsBusy}>
            {showAdd ? (<><X size={12} /> 取消</>) : (<><Plus size={12} /> 新增伏笔</>)}
          </button>
        </div>
        {showAdd && (
          <div className="fs-add-form">
            <input className="fs-input" placeholder="伏笔内容…" value={addText} onChange={(e) => setAddText(e.target.value)} />
            <input className="fs-input" placeholder="备注（可选）" value={addNote} onChange={(e) => setAddNote(e.target.value)} />
            <button
              className="btn-save"
              disabled={fsBusy || !addText.trim()}
              onClick={() => {
                fsApi("add", { text: addText.trim(), note: addNote.trim() || undefined });
                setAddText(""); setAddNote(""); setShowAdd(false);
              }}
            >{fsBusy ? "保存中…" : "确认添加"}</button>
          </div>
        )}
        <ul className="panel-list">
          {p.world.foreshadowing.map((f) => (
            <li className={`panel-item fs-item ${f.status === "resolved" ? "fs-item-resolved" : f.status === "active" ? "fs-item-active" : "fs-item-planted"}`} key={f.id}>
              {editingFs !== f.id ? (
                <>
                  <span className={`fs-status ${f.status === "resolved" ? "fs-resolved" : "fs-active"}`}>
                    {f.status === "resolved" ? "✓ 回收" : f.status === "active" ? "● 活跃" : "○ 埋设"}·第{f.plantedAt}章
                  </span>
                  <div style={{ fontSize: "0.76rem" }}>{f.text}</div>
                  {f.note && (
                    <div style={{ fontSize: "0.68rem", color: "var(--ink-soft)", fontStyle: "italic" }}>{f.note}</div>
                  )}
                  {/* 操作按钮 */}
                  <div className="fs-actions">
                    <button className="btn-save btn-xs" onClick={() => startEditFs(f)} disabled={fsBusy}><PenLine size={11} /> 编辑</button>
                    {confirmDel === f.id ? (
                      <span className="fs-confirm-inline">
                        <button className="btn-save btn-xs btn-danger-sm" onClick={() => { fsApi("delete", { id: f.id }); setConfirmDel(null); }} disabled={fsBusy}>确认删除</button>
                        <button className="btn-save btn-xs" onClick={() => setConfirmDel(null)}>取消</button>
                      </span>
                    ) : (
                      <button className="btn-save btn-xs btn-danger-sm" onClick={() => { setConfirmDel(f.id); setEditingFs(null); }} disabled={fsBusy}><Trash2 size={11} /> 删除</button>
                    )}
                  </div>
                </>
              ) : (
                /* 行内编辑表单 */
                <div className="fs-edit-form">
                  <input className="fs-input" value={editText} onChange={(e) => setEditText(e.target.value)} />
                  <input className="fs-input" placeholder="备注" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                  <select className="fs-select" value={editStatus} onChange={(e) => setEditStatus(e.target.value as "planted" | "active" | "resolved")}>
                    <option value="planted">○ 埋设</option>
                    <option value="active">● 活跃</option>
                    <option value="resolved">✓ 回收</option>
                  </select>
                  <div className="fs-actions">
                    <button className="btn-save btn-xs" disabled={fsBusy || !editText.trim()} onClick={() => { fsApi("update", { id: f.id, text: editText.trim(), note: editNote.trim() || undefined, status: editStatus }); setEditingFs(null); }}>{fsBusy ? "保存中…" : "保存"}</button>
                    <button className="btn-save btn-xs" onClick={() => setEditingFs(null)}>取消</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {p.world.foreshadowing.length === 0 && (
          <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)", fontStyle: "italic" }}>（暂无伏笔，写作时导演会自动埋设）</div>
        )}

        <h3 className="col-title">
          已抽卡牌
          <span className="panel-tag tag-muted">{p.world.cards.length}</span>
        </h3>
        <ul className="panel-list">
          {p.world.cards.map((c) => (
            <li className="panel-item" key={c.id}>
              <span className={`card-rarity ${c.rarity}`}>{c.rarity}</span>{" "}
              <span className="panel-name">{c.title}</span>
              <div style={{ fontSize: "0.72rem", color: "var(--ink-soft)" }}>{c.type}</div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
};
