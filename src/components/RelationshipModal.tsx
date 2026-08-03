// 角色关系图弹窗：Canvas 渲染 + 缩放/拖拽/编辑节点/编辑连线/新增删除连线
// 架构：Canvas 数据用 useRef（避免 React 渲染周期重建），仅 UI 用 useState
// 实时同步：useEffect 监听 world.characters 变化，自动重建图数据
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "../components/icons";
import type { Character, WorldState } from "../api/world";

type GNode = { id: string; name: string; role: string; x: number; y: number };
type GEdge = { from: string; to: string; label: string };

const ROLE_COLORS: Record<string, string> = {
  "主角": "#b03a2e",
  "反派": "#4a4a8a",
  "配角": "#4d7a4d",
};

function buildGraphData(chars: { id: string; name: string; role: string; relations?: Record<string, string> }[], w: number, h: number) {
  const cx = w / 2, cy = h / 2;
  const radius = Math.min(180, 40 + chars.length * 30);
  const nodes: GNode[] = chars.map((c, i) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    x: cx + radius * Math.cos((2 * Math.PI * i) / chars.length - Math.PI / 2),
    y: cy + radius * Math.sin((2 * Math.PI * i) / chars.length - Math.PI / 2),
  }));
  const edges: GEdge[] = [];
  const seen = new Set<string>();
  // 模糊匹配：关系目标名可能包含额外描述（如“魏无咎（东厂提督）”）
  function findChar(targetName: string) {
    // 精确匹配
    let c = chars.find((t) => t.name === targetName);
    if (c) return c;
    // 包含匹配：角色名包含在目标名中，或目标名包含在角色名中
    c = chars.find((t) => targetName.includes(t.name) || t.name.includes(targetName));
    return c ?? null;
  }
  for (const c of chars) {
    if (!c.relations) continue;
    for (const [key, val] of Object.entries(c.relations)) {
      // 兼容两种格式：新格式 {targetName: label}，旧格式 {label: targetName}
      let target = findChar(key);
      let label = String(val);
      if (!target) {
        // 旧格式：key 是标签，val 是目标名
        target = findChar(val);
        label = key;
      }
      if (!target || target.id === c.id) continue;
      const edgeKey = [c.id, target.id].sort().join("-");
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({ from: c.id, to: target.id, label });
    }
  }
  return { nodes, edges };
}

export const RelationshipModal: React.FC<{
  world: WorldState;
  onClose: () => void;
  onWorldUpdate?: (w: WorldState) => void;
  /** 保存关系到服务端（持久化 + 同步角色/写作 prompt）；返回 false 表示保存失败，弹窗不关闭 */
  onSaveRelations?: (characters: Character[]) => Promise<boolean>;
}> = (p) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // === Canvas 数据：useRef 持久化（跨渲染保留） ===
  const g = useRef({
    nodes: [] as GNode[],
    edges: [] as GEdge[],
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    dragging: null as string | null,
    panning: false,
    panStart: { x: 0, y: 0 },
    selNode: null as string | null,
    selEdge: null as number | null,
    animFrame: 0,
    initialized: false,
  }).current;

  // === UI 状态 ===
  const [tab, setTab] = useState<"角色" | "关系图">("角色");
  const [uiSelEdge, setUiSelEdge] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("");
  const [nodeList, setNodeList] = useState<GNode[]>([]);
  const [saving, setSaving] = useState(false);

  // === 实时同步：监听 world.characters 变化，重建图数据 ===
  useEffect(() => {
    const chars = p.world.characters;
    if (!chars || chars.length === 0) return;
    const canvas = canvasRef.current;
    const w = canvas ? canvas.clientWidth || 600 : 600;
    const h = canvas ? canvas.clientHeight || 400 : 400;
    const { nodes, edges } = buildGraphData(chars, w, h);

    if (!g.initialized) {
      // 首次初始化
      g.nodes = nodes;
      g.edges = edges;
      g.initialized = true;
    } else {
      // 增量同步：保留已有节点位置，新增节点放圆周，删除节点移除
      const oldPosMap = new Map(g.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
      g.nodes = nodes.map((n) => {
        const old = oldPosMap.get(n.id);
        return old ? { ...n, x: old.x, y: old.y } : n;
      });
      // 重建边（保留标签如果已存在）
      const oldEdgeMap = new Map(g.edges.map((e) => [`${e.from}-${e.to}`, e.label]));
      g.edges = edges.map((e) => {
        const key1 = `${e.from}-${e.to}`;
        const key2 = `${e.to}-${e.from}`;
        const oldLabel = oldEdgeMap.get(key1) || oldEdgeMap.get(key2);
        return oldLabel ? { ...e, label: oldLabel } : e;
      });
    }
    setNodeList([...g.nodes]);
    scheduleRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.world.characters]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(g.offsetX, g.offsetY);
    ctx.scale(g.scale, g.scale);

    // 绘制边
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i];
      const from = g.nodes.find((n) => n.id === e.from);
      const to = g.nodes.find((n) => n.id === e.to);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = g.selEdge === i ? "#b03a2e" : "#999";
      ctx.lineWidth = g.selEdge === i ? 2.5 : 1.2;
      ctx.stroke();
      // 边标签：带背景矩形防遮挡
      const mx = (from.x + to.x) / 2;
      const my = (from.y + to.y) / 2;
      const labelText = e.label || "关系";
      ctx.font = "11px sans-serif";
      const tm = ctx.measureText(labelText);
      const pad = 3;
      ctx.fillStyle = "rgba(250, 248, 244, 0.92)";
      ctx.fillRect(mx - tm.width / 2 - pad, my - 8 - pad, tm.width + pad * 2, 14 + pad * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(mx - tm.width / 2 - pad, my - 8 - pad, tm.width + pad * 2, 14 + pad * 2);
      ctx.fillStyle = "#444";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, mx, my);
    }

    // 绘制节点
    for (const n of g.nodes) {
      const isSelected = g.selNode === n.id;
      const r = 22;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = ROLE_COLORS[n.role] ?? "#666";
      ctx.globalAlpha = isSelected ? 1 : 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = isSelected ? "#b03a2e" : "#fff";
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();
      ctx.font = "bold 12px serif";
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(n.name.slice(0, 3), n.x, n.y);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#333";
      ctx.textBaseline = "top";
      ctx.fillText(n.role, n.x, n.y + r + 4);
    }

    ctx.restore();
  }

  function scheduleRedraw() {
    if (g.animFrame) return;
    g.animFrame = requestAnimationFrame(() => {
      g.animFrame = 0;
      draw();
    });
  }

  function screenToWorld(sx: number, sy: number) {
    return { x: (sx - g.offsetX) / g.scale, y: (sy - g.offsetY) / g.scale };
  }

  function hitNode(wx: number, wy: number): GNode | null {
    for (let i = g.nodes.length - 1; i >= 0; i--) {
      const n = g.nodes[i];
      const dx = wx - n.x, dy = wy - n.y;
      if (dx * dx + dy * dy <= 26 * 26) return n;
    }
    return null;
  }

  function hitEdge(wx: number, wy: number): number | null {
    for (let i = 0; i < g.edges.length; i++) {
      const e = g.edges[i];
      const from = g.nodes.find((n) => n.id === e.from);
      const to = g.nodes.find((n) => n.id === e.to);
      if (!from || !to) continue;
      const dx = to.x - from.x, dy = to.y - from.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let t = ((wx - from.x) * dx + (wy - from.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = from.x + t * dx, py = from.y + t * dy;
      const dist = Math.sqrt((wx - px) ** 2 + (wy - py) ** 2);
      if (dist < 8) return i;
    }
    return null;
  }

  function onMouseDown(e: MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const node = hitNode(wx, wy);
    if (node) {
      g.dragging = node.id;
      g.selNode = node.id;
      g.selEdge = null;
      setUiSelEdge(null);
    } else {
      const edgeIdx = hitEdge(wx, wy);
      if (edgeIdx !== null) {
        g.selEdge = edgeIdx;
        g.selNode = null;
        setUiSelEdge(edgeIdx);
        setEditLabel(g.edges[edgeIdx].label);
      } else {
        g.panning = true;
        g.panStart = { x: e.clientX - g.offsetX, y: e.clientY - g.offsetY };
        g.selNode = null;
        g.selEdge = null;
        setUiSelEdge(null);
      }
    }
    scheduleRedraw();
  }

  function onMouseMove(e: MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (g.dragging) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const n = g.nodes.find((nd) => nd.id === g.dragging);
      if (n) { n.x = wx; n.y = wy; }
      scheduleRedraw();
    } else if (g.panning) {
      g.offsetX = e.clientX - g.panStart.x;
      g.offsetY = e.clientY - g.panStart.y;
      scheduleRedraw();
    }
  }

  function onMouseUp() {
    g.dragging = null;
    g.panning = false;
  }

  function onWheel(e: WheelEvent) {
    // 阻止默认滚动：缩放仅作用于画布，不滚动弹窗/页面内容（需 passive:false 方可生效）
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(0.3, Math.min(3, g.scale * factor));
    g.offsetX = sx - (sx - g.offsetX) * (newScale / g.scale);
    g.offsetY = sy - (sy - g.offsetY) * (newScale / g.scale);
    g.scale = newScale;
    scheduleRedraw();
  }

  useEffect(() => {
    // 仅在「关系图」tab 可见时初始化/绑定（默认 tab 为「角色」，canvas 此时尚未渲染，
    // 若在挂载时一次性绑定会因 canvasRef 为 null 导致关系图空白）
    if (tab !== "关系图") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 同步直绘首帧：不依赖 rAF 调度（后台标签页 rAF 会被浏览器挂起）
    draw();
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      if (g.animFrame) cancelAnimationFrame(g.animFrame);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function addEdge() {
    const from = edgeFrom, to = edgeTo, label = edgeLabel.trim() || "关系";
    if (!from || !to || from === to) return;
    const exists = g.edges.some(
      (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
    );
    if (exists) return;
    g.edges.push({ from, to, label });
    setShowAddEdge(false);
    setEdgeFrom(""); setEdgeTo(""); setEdgeLabel("");
    scheduleRedraw();
  }

  function deleteEdge() {
    if (g.selEdge === null) return;
    g.edges.splice(g.selEdge, 1);
    g.selEdge = null;
    setUiSelEdge(null);
    scheduleRedraw();
  }

  function updateEdgeLabel() {
    if (g.selEdge === null) return;
    g.edges[g.selEdge].label = editLabel;
    scheduleRedraw();
  }

  async function saveRelations() {
    if (saving) return;
    const chars = p.world.characters.map((c) => ({ ...c }));
    for (const c of chars) { c.relations = {}; }
    for (const e of g.edges) {
      const fromNode = g.nodes.find((n) => n.id === e.from);
      const toNode = g.nodes.find((n) => n.id === e.to);
      if (!fromNode || !toNode) continue;
      const fromChar = chars.find((c) => c.id === e.from);
      const toChar = chars.find((c) => c.id === e.to);
      if (fromChar) fromChar.relations![toNode.name] = e.label;
      if (toChar) toChar.relations![fromNode.name] = e.label;
    }
    setSaving(true);
    try {
      if (p.onSaveRelations) {
        // 服务端持久化：relations 写入世界状态 → 注入后续写作/审查/大纲 prompt，角色列表同步更新
        const ok = await p.onSaveRelations(chars);
        if (!ok) return; // 保存失败：保持弹窗（错误 toast 由 Home 统一提示）
      } else if (p.onWorldUpdate) {
        p.onWorldUpdate({ ...p.world, characters: chars });
      }
      p.onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div className="modal" style={{ maxWidth: "720px", width: "95vw" }}>
        <div className="modal-head">
          <h3>角色与关系</h3>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <button className={`panel-tab ${tab === "角色" ? "active" : ""}`} onClick={() => setTab("角色")}>角色</button>
            <button className={`panel-tab ${tab === "关系图" ? "active" : ""}`} onClick={() => setTab("关系图")}>关系图</button>
          </div>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body">
        {tab === "角色" ? (
          /* Tab 1：角色列表（只读总览，编辑请前往「设置 · 角色」） */
          <div>
            {p.world.characters.map((c) => (
              <div className="rp-char-item" key={c.id}>
                {c.image ? (
                  <img
                    className="rel-char-avatar-img"
                    src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(c.image)}`}
                    alt={c.name}
                  />
                ) : (
                  <div className="rp-char-avatar" style={{ background: ROLE_COLORS[c.role] ?? "#666" }}>
                    {c.name.slice(0, 1)}
                  </div>
                )}
                <div className="rp-char-info">
                  <div className="rp-char-name">
                    {c.name}
                    <span className="rp-char-role">{c.role}</span>
                    {(c.appearedIn?.length ?? 0) > 0 && (
                      <span className="rp-char-role">登场 {c.appearedIn!.join("、")} 节</span>
                    )}
                  </div>
                  <div className="rp-char-status">{c.status}</div>
                  {c.traits.length > 0 && (
                    <div className="rp-char-traits">特质：{c.traits.join("、")}</div>
                  )}
                  {c.motivation && <div className="rp-char-motivation">动机：{c.motivation}</div>}
                  {Object.keys(c.relations ?? {}).length > 0 && (
                    <div className="rp-char-traits">
                      关系：{Object.entries(c.relations ?? {}).map(([k, v]) => `${k}→${v}`).join("；")}
                    </div>
                  )}
                  {c.exit && (
                    <div className="rp-char-traits">已离场（第{c.exit.chapter}节）：{c.exit.reason}</div>
                  )}
                </div>
              </div>
            ))}
            {p.world.characters.length === 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)", textAlign: "center", padding: "1.5rem 0" }}>
                （暂无角色，立项后导演会自动创建）
              </div>
            )}
          </div>
        ) : (
          /* Tab 2：关系图（可编辑） */
          <>
        <div className="rel-toolbar">
          <button className="btn-save" onClick={() => setShowAddEdge(!showAddEdge)}><Plus size={13} /> 新增连线</button>
          {uiSelEdge !== null && (
            <button className="btn-save btn-danger-sm" onClick={deleteEdge}><Trash2 size={13} /> 删除选中连线</button>
          )}
          <span style={{ fontSize: "0.7rem", color: "var(--ink-soft)" }}>滚轮缩放 · 拖拽节点 · 点击连线编辑</span>
        </div>
        {showAddEdge && (
          <div className="rel-add-edge">
            <select value={edgeFrom} onChange={(e) => setEdgeFrom(e.target.value)}>
              <option value="">选择角色A</option>
              {nodeList.map((n) => <option value={n.id} key={n.id}>{n.name}</option>)}
            </select>
            <span>↔</span>
            <select value={edgeTo} onChange={(e) => setEdgeTo(e.target.value)}>
              <option value="">选择角色B</option>
              {nodeList.map((n) => <option value={n.id} key={n.id}>{n.name}</option>)}
            </select>
            <input placeholder="关系描述" value={edgeLabel} onChange={(e) => setEdgeLabel(e.target.value)} />
            <button className="btn-save" onClick={addEdge}>确认</button>
          </div>
        )}
        {uiSelEdge !== null && (
          <div className="rel-edit-edge">
            <span style={{ fontSize: "0.75rem" }}>编辑连线标签：</span>
            <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
            <button className="btn-save" onClick={updateEdgeLabel}>更新</button>
          </div>
        )}
        <div className="rel-canvas-wrap">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "400px", cursor: "default" }}
          />
        </div>
          </>
        )}
        </div>
        {tab === "关系图" && (
          <div style={{ padding: "0.8rem 1.2rem", borderTop: "1px solid var(--line-strong)", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
            <button className="btn" onClick={p.onClose} disabled={saving}>取消</button>
            <button className="btn btn-primary" onClick={saveRelations} disabled={saving}>{saving ? "保存中…" : "保存关系到世界"}</button>
          </div>
        )}
      </div>
    </div>
  );
};
