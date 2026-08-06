// 伏笔账编辑弹窗：全书伏笔增删改（复用 /api/novel/foreshadow 三 action）
// 后端守卫：已埋入正文的伏笔不可删除（需先回收为 resolved），报错以 toast 展示
// 数据同步：后端每次操作返回完整 world（含 alignWorld 修复/回收章联动），前端整包替换，避免局部浅合并丢字段
import { useEffect, useState } from "react";
import type { Foreshadow, WorldState } from "../api/world";
import { BookMarked, Plus, Trash2, X } from "./icons";

const STATUS_TEXT: Record<Foreshadow["status"], string> = { planted: "已埋设", active: "推进中", resolved: "已回收" };
const STATUS_ORDER: Foreshadow["status"][] = ["active", "planted", "resolved"];

type Props = {
  world: WorldState;
  onClose: () => void;
  onWorldUpdate: (w: WorldState) => void; // 保存成功后整包替换 world（右栏/脉络联动）
  showToast: (msg: string) => void;
  /** 运行锁：任务运行中禁止伏笔编辑（入口已守卫，此为弹窗内防御） */
  taskActive?: boolean;
};

export const ForeshadowModal: React.FC<Props> = (p) => {
  const [list, setList] = useState<Foreshadow[]>([...p.world.foreshadowing]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | Foreshadow["status"]>("all");
  // 删除两段确认：第一次点击变「确认删除？」，再点才执行；点别处恢复
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  // 新增表单
  const [newText, setNewText] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newPlantedAt, setNewPlantedAt] = useState<string>("");

  // 外部 world 变化（写作自动埋设/回收、其他入口修改）时同步本地列表；非受控输入框不受影响
  useEffect(() => {
    setList([...p.world.foreshadowing]);
  }, [p.world.foreshadowing]);

  async function call(action: string, payload: Record<string, unknown>): Promise<Foreshadow[] | null> {
    if (p.taskActive) { p.showToast("任务运行中，伏笔编辑已禁止——请先取消任务。"); return null; } // 运行锁
    setBusy(true);
    try {
      const res = await fetch("/api/novel/foreshadow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.world.title, action, ...payload }),
      });
      const data = (await res.json()) as { ok?: boolean; foreshadowing?: Foreshadow[]; world?: WorldState; error?: string };
      if (!data.ok) throw new Error(data.error ?? "操作失败");
      const next = data.foreshadowing ?? [];
      setList(next);
      // 整包替换 world（后端返回完整状态，含 alignWorld 修复），避免基于过期 world 浅合并丢字段
      p.onWorldUpdate(data.world ?? { ...p.world, foreshadowing: next });
      return next;
    } catch (e) {
      p.showToast((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function addForeshadow() {
    const text = newText.trim();
    if (!text) { p.showToast("伏笔内容不能为空"); return; }
    const plantedAt = newPlantedAt.trim() === "" ? undefined : Number(newPlantedAt);
    if (plantedAt !== undefined && (!Number.isInteger(plantedAt) || plantedAt < 1)) { p.showToast("埋设章节号无效"); return; }
    const ok = await call("add", { text, note: newNote.trim() || undefined, plantedAt });
    if (ok) { setNewText(""); setNewNote(""); setNewPlantedAt(""); setConfirmDelId(null); p.showToast("已新增伏笔"); }
  }

  async function updateForeshadow(f: Foreshadow, patch: Partial<Pick<Foreshadow, "text" | "note" | "status">>) {
    await call("update", { id: f.id, ...patch });
  }

  async function deleteForeshadow(f: Foreshadow) {
    const ok = await call("delete", { id: f.id });
    if (ok) setConfirmDelId(null);
  }

  const shown = list
    .filter((f) => filter === "all" || f.status === filter)
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.plantedAt - b.plantedAt);
  const activeCount = list.filter((f) => f.status !== "resolved").length;

  return (
    <div className="modal-overlay" onClick={() => { p.onClose(); setConfirmDelId(null); }}>
      <div className="fs-modal" onClick={(e) => { e.stopPropagation(); setConfirmDelId(null); }}>
        <div className="mem-modal-head">
          <b style={{ fontFamily: "var(--sans)" }}><BookMarked size={15} /> 伏笔账（{list.length}：活跃 {activeCount}）</b>
          <div className="mem-tabs">
            {(["all", ...STATUS_ORDER] as const).map((k) => (
              <button key={k} className={filter === k ? "mem-tab on" : "mem-tab"} onClick={() => { setFilter(k); setConfirmDelId(null); }}>
                {k === "all" ? `全部 ${list.length}` : `${STATUS_TEXT[k]} ${list.filter((f) => f.status === k).length}`}
              </button>
            ))}
          </div>
          <button className="mem-close" onClick={p.onClose} title="关闭"><X size={15} /></button>
        </div>

        <div className="mem-modal-body">
          {/* 新增表单：Enter 提交 */}
          <div className="fs-add">
            <input className="fs-add-text" placeholder="伏笔内容（必填）…" value={newText} onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addForeshadow(); }} disabled={busy || p.taskActive} />
            <input className="fs-add-note" placeholder="备注（可选）" value={newNote} onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addForeshadow(); }} disabled={busy || p.taskActive} />
            <input className="fs-add-ch" placeholder="埋设章（默认最新章）" value={newPlantedAt} onChange={(e) => setNewPlantedAt(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addForeshadow(); }} disabled={busy || p.taskActive} inputMode="numeric" />
            <button className="btn btn-primary" style={{ overflow: 'hidden' }} onClick={addForeshadow} disabled={busy || p.taskActive || !newText.trim()}><Plus size={14} /> 新增</button>
          </div>

          {/* 伏笔表 */}
          <table className="mem-table">
            <thead><tr><th>内容</th><th>状态</th><th>埋设</th><th>回收</th><th>备注</th><th style={{ width: "7rem" }}>操作</th></tr></thead>
            <tbody>
              {shown.map((f) => (
                <tr key={f.id} className={confirmDelId === f.id ? "fs-row-del-confirm" : undefined}>
                  <td>
                    <input className="fs-cell-input" defaultValue={f.text} key={`t-${f.id}`} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== f.text) void updateForeshadow(f, { text: v }); }} disabled={busy || p.taskActive} />
                  </td>
                  <td>
                    <select className="fs-cell-select" value={f.status} onChange={(e) => { setConfirmDelId(null); void updateForeshadow(f, { status: e.target.value as Foreshadow["status"] }); }} disabled={busy || p.taskActive}
                      title="切换状态：已回收 = 伏笔兑现（自动记录回收章，可删除）">
                      <option value="planted">已埋设</option>
                      <option value="active">推进中</option>
                      <option value="resolved">已回收</option>
                    </select>
                  </td>
                  <td>第{f.plantedAt}章</td>
                  <td>{f.resolvedAt ? `第${f.resolvedAt}章` : "—"}</td>
                  <td>
                    <input className="fs-cell-input" defaultValue={f.note ?? ""} key={`n-${f.id}`} placeholder="—" onBlur={(e) => { const v = e.target.value.trim(); if (v !== (f.note ?? "")) void updateForeshadow(f, { note: v || undefined }); }} disabled={busy || p.taskActive} />
                  </td>
                  <td>
                    {confirmDelId === f.id ? (
                      <button className="btn-save btn-danger-sm" style={{ fontSize: "0.68rem" }} onClick={() => void deleteForeshadow(f)} disabled={busy || p.taskActive}
                        title="再次点击确认删除">
                        确认删除？
                      </button>
                    ) : (
                      <button className="btn-save btn-danger-sm" style={{ fontSize: "0.68rem" }} onClick={() => setConfirmDelId(f.id)} disabled={busy || p.taskActive}
                        title={f.status !== "resolved" && f.plantedAt < p.world.nextChapter ? "已埋入正文的伏笔不可删除（需先回收为已解决）" : "删除该伏笔（需二次确认）"}>
                        <Trash2 size={12} /> 删除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={6} className="mem-empty">暂无伏笔（写作中会自动埋设，也可手动新增）</td></tr>}
            </tbody>
          </table>
          <div className="task-note" style={{ marginTop: "0.5rem" }}>
            ⚠ 已埋入正文的伏笔不可删除（用户决策：伏笔不允许放弃）——需先切换为「已回收」再删除；修改会记入操作日志并触发账本对齐；标为「已回收」自动记录当前最新章的回收章节。
          </div>
        </div>
      </div>
    </div>
  );
};
