// 角色关系图弹窗：Canvas 渲染 + 缩放/拖拽/编辑节点/编辑连线/新增删除连线
// 架构：Canvas 数据用 useRef（避免 React 渲染周期重建），仅 UI 用 useState
// 实时同步：useEffect 监听 world.characters 变化，自动重建图数据
import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "../components/icons";
import type { Character, WorldState } from "../api/world";
import { formatChapterRange } from "../shared/appearance";
import { RelationshipGraphCanvas } from "./RelationshipGraphCanvas";
import { extractRelationshipSubgraph } from "../shared/relationships";

type GNode = { id: string; name: string; role: string; x: number; y: number };
type GEdge = { from: string; to: string; label: string };

const ROLE_COLORS: Record<string, string> = {
  "主角": "#b03a2e",
  "反派": "#4a4a8a",
  "配角": "#4d7a4d",
};

function buildGraphData(chars: { id: string; name: string; role: string; relations?: Record<string, string> }[], w: number, h: number) {
  const cx = w / 2, cy = h / 2;
  // 半径自适应画布尺寸：窄屏（移动端）按 min(w,h) 收缩，保证全部节点首屏可见
  const radius = Math.max(60, Math.min(Math.min(w, h) / 2 - 30, 40 + chars.length * 30));
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
  /** 手动新增角色（服务端持久化）；返回 false 表示失败 */
  onAddCharacter?: (c: { name: string; role?: string; gender?: string; age?: string; identity?: string; traits?: string[]; motivation?: string; voice?: string; status?: string }) => Promise<boolean>;
  /** 点击角色查看全局立绘（大图预览 + 生成入口） */
  onViewPortrait?: (c: Character) => void;
  /** 只读模式：角色与关系图均不可编辑（审查面板复用）；缺省 false */
  readOnly?: boolean;
  /** 首次打开时选中的页签；人工入口缺省为角色，中枢关系图入口显式指定关系图。 */
  initialTab?: "角色" | "关系图";
  /** 受控选中角色 id（高亮列表项与关系图节点）；点击角色项时通过 onSelectCharacter 通知外部 */
  selectedCharId?: string | null;
  onSelectCharacter?: (id: string) => void;
}> = (p) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

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
    /** 当前布局对应的画布尺寸（clientWidth/clientHeight）：画布尺寸变化时按新尺寸重建布局 */
    layoutW: 0,
    layoutH: 0,
    /** 双指捏合状态：起始指距 / 起始 scale / 起始两指中心（canvas 相对坐标及其世界坐标） */
    pinch: null as null | { dist: number; scale: number; cx: number; cy: number; wx: number; wy: number },
  }).current;

  // === UI 状态 ===
  const [tab, setTab] = useState<"角色" | "关系图">(p.initialTab ?? "角色");
  const [uiSelEdge, setUiSelEdge] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("");
  const [nodeList, setNodeList] = useState<GNode[]>([]);
  const [saving, setSaving] = useState(false);
  /** 手动新增角色折叠表单 */
  const [showAddChar, setShowAddChar] = useState(false);
  const [acName, setAcName] = useState("");
  const [acRole, setAcRole] = useState("配角");
  const [acGender, setAcGender] = useState("");
  const [acAge, setAcAge] = useState("");
  const [acIdentity, setAcIdentity] = useState("");
  const [acTraits, setAcTraits] = useState("");
  const [acMotivation, setAcMotivation] = useState("");
  const [acStatus, setAcStatus] = useState("");
  const [acMsg, setAcMsg] = useState("");
  const [addingChar, setAddingChar] = useState(false);

  async function addCharacter() {
    if (addingChar || !p.onAddCharacter) return;
    if (!acName.trim()) { setAcMsg("请填写角色姓名"); return; }
    if (p.world.characters.some((c) => c.name === acName.trim())) { setAcMsg(`角色「${acName.trim()}」已存在`); return; }
    setAddingChar(true);
    try {
      const ok = await p.onAddCharacter({
        name: acName.trim(),
        role: acRole.trim() || undefined,
        gender: acGender || undefined,
        age: acAge.trim() || undefined,
        identity: acIdentity.trim() || undefined,
        traits: acTraits.split(/[、,，]/).map((s) => s.trim()).filter(Boolean),
        motivation: acMotivation.trim() || undefined,
        voice: undefined,
        status: acStatus.trim() || undefined,
      });
      if (ok) {
        setShowAddChar(false);
        setAcName(""); setAcRole("配角"); setAcGender(""); setAcAge(""); setAcIdentity("");
        setAcTraits(""); setAcMotivation(""); setAcStatus(""); setAcMsg("");
      } else {
        setAcMsg("保存失败");
      }
    } finally {
      setAddingChar(false);
    }
  }
  /** 非受控选中（未传 selectedCharId 时内部自管，点击角色项高亮） */
  const [localSel, setLocalSel] = useState<string | null>(null);
  const selectedId = p.selectedCharId ?? localSel;

  // 选中项变化：只读模式滚动列表到可见 + 关系图节点高亮（可拖拽/编辑模式不动节点选择，避免干扰编辑）
  useEffect(() => {
    if (selectedId == null || !p.readOnly) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-cid="${selectedId}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    g.selNode = selectedId;
    g.selEdge = null;
    setUiSelEdge(null);
    scheduleRedraw();
  }, [selectedId, p.readOnly]);

  /** 按画布尺寸重建图数据：保留已有节点位置（增删角色/改尺寸时位置稳定）与边标签 */
  function rebuildGraph(w: number, h: number) {
    const { nodes, edges } = buildGraphData(p.world.characters, w, h);
    const oldPosMap = new Map(g.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    g.nodes = nodes.map((n) => {
      const old = oldPosMap.get(n.id);
      return old ? { ...n, x: old.x, y: old.y } : n;
    });
    const oldEdgeMap = new Map(g.edges.map((e) => [`${e.from}-${e.to}`, e.label]));
    g.edges = edges.map((e) => {
      const key1 = `${e.from}-${e.to}`;
      const key2 = `${e.to}-${e.from}`;
      const oldLabel = oldEdgeMap.get(key1) || oldEdgeMap.get(key2);
      return oldLabel ? { ...e, label: oldLabel } : e;
    });
    setNodeList([...g.nodes]);
  }

  // === 实时同步：监听 world.characters 变化，重建图数据（保留位置/标签） ===
  useEffect(() => {
    const chars = p.world.characters;
    if (!chars || chars.length === 0) return;
    const canvas = canvasRef.current;
    const w = canvas ? canvas.clientWidth || 600 : 600;
    const h = canvas ? canvas.clientHeight || 400 : 400;
    if (!g.initialized) {
      g.initialized = true;
      g.layoutW = w;
      g.layoutH = h;
    }
    rebuildGraph(w, h);
    scheduleRedraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.world.characters]);

  /** 连线文字精简：取首个标点前的语义片段（如「敌对，以灭门案为筹码…」→「敌对」、
   * 「搭档，由她救治过重伤后…」→「搭档」），仅保留词语/标签级关系词，丢弃具体事件与原文；
   * 无标点时截前 6 字。仅用于图上显示，编辑/持久化仍保留原文 */
  function shortLabel(raw: string): string {
    const s = String(raw ?? "").trim();
    if (!s) return "关系";
    const cut = s.split(/[：:，,。；;！？!?、]/)[0].trim();
    const base = cut || s;
    return base.length > 6 ? base.slice(0, 6) + "…" : base;
  }

  /** 连线文字锚点：默认线段中点；依次避让节点圆 + 已放置的其他连线文字（含文字宽度），
   * 保证文字彼此不重叠。选中边最后绘制 → 天然覆盖其他文字，点击后必显示在最上层 */
  function labelPos(from: GNode, to: GNode, mx: number, my: number, w: number, placed: { x: number; y: number; w: number }[]) {
    const nodeR = 22 + 12; // 节点半径 22 + 文字背景边距
    const hits = (x: number, y: number) =>
      g.nodes.some((n) => (x - n.x) ** 2 + (y - n.y) ** 2 < nodeR * nodeR) ||
      placed.some((p) => Math.abs(x - p.x) < (p.w + w) / 2 + 8 && Math.abs(y - p.y) < 18);
    if (!hits(mx, my)) return { x: mx, y: my };
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // 从中点向两端各步进 14px，找第一个不压节点圆也不压其他文字的位置
    for (let step = 14; step < len / 2; step += 14) {
      if (!hits(mx + ux * step, my + uy * step)) return { x: mx + ux * step, y: my + uy * step };
      if (!hits(mx - ux * step, my - uy * step)) return { x: mx - ux * step, y: my - uy * step };
    }
    return { x: mx, y: my }; // 整条线都被覆盖（罕见）：退回中点
  }

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

    // 绘制边线（文字在节点之后单独绘制，保证连线文字永远在节点上层，不被遮挡）
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

    // 连线文字：最后绘制；选中边排在最后 → 点击后提到最上层，盖过任何重叠文字
    // 同时维护已放置文字矩形，后画文字避让先画文字，彼此不重叠
    const placed: { x: number; y: number; w: number }[] = [];
    const edgeOrder = g.edges.map((_, i) => i).sort((a, b) => (g.selEdge === a ? 1 : 0) - (g.selEdge === b ? 1 : 0));
    for (const i of edgeOrder) {
      const e = g.edges[i];
      const from = g.nodes.find((n) => n.id === e.from);
      const to = g.nodes.find((n) => n.id === e.to);
      if (!from || !to) continue;
      const isSel = g.selEdge === i;
      const labelText = shortLabel(e.label);
      ctx.font = isSel ? "bold 11px sans-serif" : "11px sans-serif";
      const tm = ctx.measureText(labelText);
      const pad = 3;
      const mid = labelPos(from, to, (from.x + to.x) / 2, (from.y + to.y) / 2, tm.width, placed);
      const mx = mid.x, my = mid.y;
      // 选中连线文字高亮（深底白字），未选中为纸色底深字
      ctx.fillStyle = isSel ? "rgba(176, 58, 46, 0.92)" : "rgba(250, 248, 244, 0.92)";
      ctx.fillRect(mx - tm.width / 2 - pad, my - 8 - pad, tm.width + pad * 2, 14 + pad * 2);
      ctx.strokeStyle = isSel ? "#b03a2e" : "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(mx - tm.width / 2 - pad, my - 8 - pad, tm.width + pad * 2, 14 + pad * 2);
      ctx.fillStyle = isSel ? "#fff" : "#444";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, mx, my);
      placed.push({ x: mx, y: my, w: tm.width });
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
      // 命中半径按屏幕像素（26px）换算成世界坐标，缩放后手指/鼠标命中范围一致
      const hitR = 26 / g.scale;
      if (dx * dx + dy * dy <= hitR * hitR) return n;
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
      // 阈值按屏幕像素（8px）换算成世界坐标，缩小后依然易点中
      if (dist < 8 / g.scale) return i;
    }
    return null;
  }

  /** 触点按下（鼠标/单指触摸共用）：命中节点→拖拽；只读模式空白→平移；编辑模式命中连线→选中，空白→平移 */
  function beginPointer(sx: number, sy: number, clientX: number, clientY: number) {
    const { x: wx, y: wy } = screenToWorld(sx, sy);
    const node = hitNode(wx, wy);
    if (node) {
      // 编辑/只读均允许拖拽节点（只读模式拖拽后节点位置为临时调整，不持久化；连线文字跟随线段移动，可见性不受影响）
      g.dragging = node.id;
      g.selNode = node.id;
      g.selEdge = null;
      setUiSelEdge(null);
      if (p.readOnly) {
        setLocalSel(node.id);
        p.onSelectCharacter?.(node.id);
      }
      scheduleRedraw();
      return;
    }
    // 只读模式：非节点区域仅平移，不支持连线编辑
    if (p.readOnly) {
      g.panning = true;
      g.panStart = { x: clientX - g.offsetX, y: clientY - g.offsetY };
      scheduleRedraw();
      return;
    }
    const edgeIdx = hitEdge(wx, wy);
    if (edgeIdx !== null) {
      g.selEdge = edgeIdx;
      g.selNode = null;
      setUiSelEdge(edgeIdx);
      setEditLabel(g.edges[edgeIdx].label);
    } else {
      g.panning = true;
      g.panStart = { x: clientX - g.offsetX, y: clientY - g.offsetY };
      g.selNode = null;
      g.selEdge = null;
      setUiSelEdge(null);
    }
    scheduleRedraw();
  }

  function onMouseDown(e: MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    beginPointer(e.clientX - rect.left, e.clientY - rect.top, e.clientX, e.clientY);
  }

  /** 触点移动（鼠标/单指触摸共用）：拖拽节点或平移画板 */
  function movePointer(sx: number, sy: number, clientX: number, clientY: number) {
    if (g.dragging) {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      const n = g.nodes.find((nd) => nd.id === g.dragging);
      if (n) { n.x = wx; n.y = wy; }
      scheduleRedraw();
    } else if (g.panning) {
      g.offsetX = clientX - g.panStart.x;
      g.offsetY = clientY - g.panStart.y;
      scheduleRedraw();
    }
  }

  function onMouseMove(e: MouseEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    movePointer(e.clientX - rect.left, e.clientY - rect.top, e.clientX, e.clientY);
  }

  function onMouseUp() {
    g.dragging = null;
    g.panning = false;
  }

  // === 移动端触摸：单指=点击/拖节点/平移，双指=以两指中心为锚点捏合缩放（附带平移） ===
  function onTouchStart(e: TouchEvent) {
    // 阻止浏览器默认滚动/双击缩放，同时避免合成 mousedown 导致双重触发
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ts = e.touches;
    if (ts.length === 2) {
      // 双指：取消其他交互，记录捏合起点（指距/scale/中心的世界坐标）
      g.dragging = null;
      g.panning = false;
      const dx = ts[0].clientX - ts[1].clientX;
      const dy = ts[0].clientY - ts[1].clientY;
      const cx = (ts[0].clientX + ts[1].clientX) / 2 - rect.left;
      const cy = (ts[0].clientY + ts[1].clientY) / 2 - rect.top;
      const { x: wx, y: wy } = screenToWorld(cx, cy);
      g.pinch = { dist: Math.max(1, Math.hypot(dx, dy)), scale: g.scale, cx, cy, wx, wy };
      scheduleRedraw();
      return;
    }
    if (ts.length !== 1) return;
    const t = ts[0];
    beginPointer(t.clientX - rect.left, t.clientY - rect.top, t.clientX, t.clientY);
  }

  function onTouchMove(e: TouchEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ts = e.touches;
    if (ts.length === 2 && g.pinch) {
      const dx = ts[0].clientX - ts[1].clientX;
      const dy = ts[0].clientY - ts[1].clientY;
      const curDist = Math.max(1, Math.hypot(dx, dy));
      const curCx = (ts[0].clientX + ts[1].clientX) / 2 - rect.left;
      const curCy = (ts[0].clientY + ts[1].clientY) / 2 - rect.top;
      const newScale = Math.max(0.3, Math.min(3, g.pinch.scale * (curDist / g.pinch.dist)));
      // 以两指中心为锚：捏合起点中心对应的世界坐标始终保持在当前两指中心处（缩放+平移一体）
      g.scale = newScale;
      g.offsetX = curCx - g.pinch.wx * newScale;
      g.offsetY = curCy - g.pinch.wy * newScale;
      scheduleRedraw();
      return;
    }
    if (ts.length === 1) {
      const t = ts[0];
      movePointer(t.clientX - rect.left, t.clientY - rect.top, t.clientX, t.clientY);
    }
  }

  function onTouchEnd() {
    g.pinch = null;
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
    const w = canvas.clientWidth || 600;
    const h = canvas.clientHeight || 400;
    // 首帧布局必须按真实画布尺寸：chars effect 在 canvas 未渲染时可能用 600×400 兜底，
    // 窄屏移动端会超出画布 → 检测到尺寸不匹配时按实际尺寸重建
    if (!g.initialized || g.layoutW !== w || g.layoutH !== h) {
      g.initialized = true;
      g.layoutW = w;
      g.layoutH = h;
      rebuildGraph(w, h);
    }
    // 同步直绘首帧：不依赖 rAF 调度（后台标签页 rAF 会被浏览器挂起）
    draw();
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("mouseleave", onMouseUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);
    // 旋转屏幕 / 窗口尺寸变化：按新尺寸重建布局（保留已拖拽节点位置）
    const onResize = () => {
      const cv = canvasRef.current;
      if (!cv) return;
      const nw = cv.clientWidth || 600;
      const nh = cv.clientHeight || 400;
      if (g.layoutW !== nw || g.layoutH !== nh) {
        g.layoutW = nw;
        g.layoutH = nh;
        rebuildGraph(nw, nh);
      }
      draw();
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (g.animFrame) cancelAnimationFrame(g.animFrame);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("mouseleave", onMouseUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("resize", onResize);
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
        <div className="modal-body" ref={bodyRef}>
        {tab === "角色" ? (
          /* Tab 1：角色列表（只读总览，编辑请前往「设置 · 角色」；审查面板只读复用） */
          <div>
            {!p.readOnly && p.onAddCharacter && (
              <>
                <button className="btn-save" onClick={() => { setShowAddChar(!showAddChar); setAcMsg(""); }} style={{ marginBottom: "0.5rem" }}>
                  <Plus size={13} /> {showAddChar ? "收起新增表单" : "新增角色"}
                </button>
                {showAddChar && (
                  <div style={{ border: "1px dashed var(--line-strong)", padding: "0.7rem", marginBottom: "0.7rem", background: "var(--paper-dark)" }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)", marginBottom: "0.4rem" }}>
                      手动新增角色（保存后可在设置面板继续编辑；保存后自动生成头像与立绘）
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <input className="rp-add-input" placeholder="姓名（必填）" value={acName} onChange={(e) => setAcName(e.target.value)} style={{ width: "8rem" }} />
                      <select value={acRole} onChange={(e) => setAcRole(e.target.value)} style={{ width: "6rem" }}>
                        <option value="主角">主角</option>
                        <option value="反派">反派</option>
                        <option value="配角">配角</option>
                        <option value="关键人物">关键人物</option>
                        <option value="待登场">待登场</option>
                        <option value="其他">其他</option>
                      </select>
                      <select value={acGender} onChange={(e) => setAcGender(e.target.value)} style={{ width: "5rem" }}>
                        {!acGender && <option value="" disabled>性别</option>}
                        <option value="男">男</option>
                        <option value="女">女</option>
                      </select>
                      <input className="rp-add-input" placeholder="年龄" value={acAge} onChange={(e) => setAcAge(e.target.value)} style={{ width: "6rem" }} />
                      <input className="rp-add-input" placeholder="身份/职业" value={acIdentity} onChange={(e) => setAcIdentity(e.target.value)} style={{ width: "9rem" }} />
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem", flexWrap: "wrap" }}>
                      <input className="rp-add-input" placeholder="特质（顿号分隔）" value={acTraits} onChange={(e) => setAcTraits(e.target.value)} style={{ flex: 1, minWidth: "10rem" }} />
                      <input className="rp-add-input" placeholder="当前状态" value={acStatus} onChange={(e) => setAcStatus(e.target.value)} style={{ flex: 1, minWidth: "8rem" }} />
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.4rem" }}>
                      <input className="rp-add-input" placeholder="动机（可选）" value={acMotivation} onChange={(e) => setAcMotivation(e.target.value)} style={{ flex: 1 }} />
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" }}>
                      <button className="btn-save" onClick={addCharacter} disabled={addingChar}>
                        {addingChar ? "创建中…" : "创建角色"}
                      </button>
                      <button className="btn-save" onClick={() => { setShowAddChar(false); setAcMsg(""); }}>取消</button>
                      {acMsg && <span className="form-msg" style={{ margin: 0 }}>{acMsg}</span>}
                    </div>
                  </div>
                )}
              </>
            )}
            {p.world.characters.map((c) => (
              <div
                className={`rp-char-item ${selectedId === c.id ? "rp-char-item-selected" : ""}`}
                data-cid={c.id}
                key={c.id}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setLocalSel(c.id);
                  p.onSelectCharacter?.(c.id);
                  p.onViewPortrait?.(c);
                }}
                title={selectedId === c.id ? "已选中" : "点击选中"}
              >
                {c.image ? (
                  <img
                    className="rel-char-avatar-img"
                    src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(c.image)}`}
                    alt={`${c.name}头像`}
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
                      <span className="rp-char-role">登场 {formatChapterRange(c.appearedIn)} 章</span>
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
                    <div className="rp-char-traits">已离场（第{c.exit.chapter}章）：{c.exit.reason}</div>
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
          /* Tab 2：关系图（可编辑；审查面板只读复用：隐藏编辑工具，节点仅可选中） */
          <>
        {!p.readOnly && (
          <div className="rel-toolbar">
          <button className="btn-save" onClick={() => setShowAddEdge(!showAddEdge)}><Plus size={13} /> 新增连线</button>
          {uiSelEdge !== null && (
            <button className="btn-save btn-danger-sm" onClick={deleteEdge}><Trash2 size={13} /> 删除选中连线</button>
          )}
          <span style={{ fontSize: "0.7rem", color: "var(--ink-soft)" }}>滚轮/双指缩放 · 拖拽节点 · 空白拖动平移 · 点击连线编辑</span>
          </div>
        )}
        {!p.readOnly && showAddEdge && (
          <div className="rel-add-edge">
            <select value={edgeFrom} onChange={(e) => setEdgeFrom(e.target.value)}>
              <option value="" disabled>选择角色 A…</option>
              {nodeList.map((n) => (n.id === edgeTo ? null : <option value={n.id} key={n.id}>{n.name}</option>))}
            </select>
            <span>↔</span>
            <select value={edgeTo} onChange={(e) => setEdgeTo(e.target.value)}>
              <option value="" disabled>选择角色 B…</option>
              {nodeList.map((n) => (n.id === edgeFrom ? null : <option value={n.id} key={n.id}>{n.name}</option>))}
            </select>
            <input placeholder="关系描述" value={edgeLabel} onChange={(e) => setEdgeLabel(e.target.value)} />
            <button className="btn-save" onClick={addEdge}>确认</button>
          </div>
        )}
        {!p.readOnly && uiSelEdge !== null && (
          <div className="rel-edit-edge">
            <span style={{ fontSize: "0.75rem" }}>编辑连线标签：</span>
            <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
            <button className="btn-save" onClick={updateEdgeLabel}>更新</button>
          </div>
        )}
        <div className="rel-canvas-wrap">
          {p.readOnly ? (
            <RelationshipGraphCanvas
              graph={extractRelationshipSubgraph(p.world.characters) ?? { nodes: [], edges: [] }}
              className="relationship-graph-modal"
              ariaLabel="人物关系只读图"
            />
          ) : (
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "clamp(240px, 55vh, 400px)", cursor: "default", touchAction: "none" }}
            />
          )}
        </div>
          </>
        )}
        </div>
        {tab === "关系图" && (
          p.readOnly ? (null) : (
            <div style={{ padding: "0.8rem 1.2rem", borderTop: "1px solid var(--line-strong)", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button className="btn" onClick={p.onClose} disabled={saving}>取消</button>
              <button className="btn btn-primary" onClick={saveRelations} disabled={saving}>{saving ? "保存中…" : "保存关系到世界"}</button>
            </div>
          )
        )}
      </div>
    </div>
  );
};
