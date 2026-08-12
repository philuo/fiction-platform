import { useEffect, useRef } from "react";
import type { RelationshipSubgraph } from "../shared/relationships";
export type { RelationshipSubgraph } from "../shared/relationships";

type LayoutNode = RelationshipSubgraph["nodes"][number] & { x: number; y: number };

const ROLE_COLORS: Record<string, string> = {
  主角: "#a43a32", 反派: "#53527f", 配角: "#44735a", 关键人物: "#9a6b27",
};

function shortLabel(value: string): string {
  const text = String(value ?? "").trim().split(/[：:，,。；;！？!?、]/)[0] || "关系";
  return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

/** Read-only relationship graph for chat cards and read-only relationship views.
 * Nodes may be dragged for inspection; wheel/touchpad zoom and blank-space pan are local only. */
export function RelationshipGraphCanvas({ graph, className = "", ariaLabel = "人物关系子图" }: {
  graph: RelationshipSubgraph;
  className?: string;
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const state = useRef({
    nodes: [] as LayoutNode[], scale: 1, ox: 0, oy: 0, dragging: "" as string, panning: false,
    px: 0, py: 0, width: 0, height: 0,
  }).current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const layout = () => {
      const width = canvas.clientWidth || 520;
      const height = canvas.clientHeight || 280;
      const old = new Map(state.nodes.map((node) => [node.id, node]));
      const radius = Math.max(54, Math.min(Math.min(width, height) / 2 - 42, 45 + graph.nodes.length * 16));
      state.nodes = graph.nodes.map((node, index) => old.get(node.id) ?? {
        ...node,
        x: width / 2 + radius * Math.cos((Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2),
        y: height / 2 + radius * Math.sin((Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2),
      });
      state.width = width;
      state.height = height;
    };
    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const width = canvas.clientWidth || 520;
      const height = canvas.clientHeight || 280;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.translate(state.ox, state.oy);
      ctx.scale(state.scale, state.scale);
      for (const edge of graph.edges) {
        const from = state.nodes.find((node) => node.id === edge.from);
        const to = state.nodes.find((node) => node.id === edge.to);
        if (!from || !to) continue;
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y);
        ctx.strokeStyle = "#a59d91"; ctx.lineWidth = 1.4; ctx.stroke();
        const label = shortLabel(edge.label);
        const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
        ctx.font = "11px sans-serif";
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(250,248,244,.96)"; ctx.fillRect(mx - tw / 2 - 4, my - 9, tw + 8, 18);
        ctx.fillStyle = "#514a43"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, mx, my);
      }
      for (const node of state.nodes) {
        const focused = graph.focus === node.id;
        ctx.beginPath(); ctx.arc(node.x, node.y, focused ? 25 : 22, 0, Math.PI * 2);
        ctx.fillStyle = ROLE_COLORS[node.role] ?? "#68645e"; ctx.fill();
        ctx.strokeStyle = focused ? "#c7902f" : "#fff"; ctx.lineWidth = focused ? 4 : 2; ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "600 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(node.name.slice(0, 4), node.x, node.y);
        ctx.fillStyle = "#514a43"; ctx.font = "10px sans-serif"; ctx.textBaseline = "top"; ctx.fillText(node.role, node.x, node.y + 29);
      }
      ctx.restore();
    };
    const schedule = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(draw); };
    const point = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const down = (event: MouseEvent) => {
      const p = point(event); const wx = (p.x - state.ox) / state.scale; const wy = (p.y - state.oy) / state.scale;
      const node = [...state.nodes].reverse().find((item) => Math.hypot(item.x - wx, item.y - wy) <= 28 / state.scale);
      if (node) state.dragging = node.id;
      else { state.panning = true; state.px = event.clientX - state.ox; state.py = event.clientY - state.oy; }
    };
    const move = (event: MouseEvent) => {
      const p = point(event);
      if (state.dragging) {
        const node = state.nodes.find((item) => item.id === state.dragging);
        if (node) { node.x = (p.x - state.ox) / state.scale; node.y = (p.y - state.oy) / state.scale; schedule(); }
      } else if (state.panning) { state.ox = event.clientX - state.px; state.oy = event.clientY - state.py; schedule(); }
    };
    const up = () => { state.dragging = ""; state.panning = false; };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top;
      const next = Math.max(.45, Math.min(2.5, state.scale * (event.deltaY < 0 ? 1.1 : .9)));
      state.ox = x - (x - state.ox) * next / state.scale; state.oy = y - (y - state.oy) * next / state.scale; state.scale = next; schedule();
    };
    const resize = () => { layout(); draw(); };
    layout(); draw();
    canvas.addEventListener("mousedown", down); canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseup", up); canvas.addEventListener("mouseleave", up); canvas.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", resize);
    return () => {
      window.cancelAnimationFrame(frame); canvas.removeEventListener("mousedown", down); canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("mouseup", up); canvas.removeEventListener("mouseleave", up); canvas.removeEventListener("wheel", wheel); window.removeEventListener("resize", resize);
    };
  }, [graph, state]);

  return <canvas ref={canvasRef} className={`relationship-graph-canvas ${className}`.trim()} aria-label={ariaLabel} role="img" />;
}
