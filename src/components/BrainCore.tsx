// 中枢大脑（BrainCore）：使用 lucide 专业设计的大脑 SVG 路径 + canvas-confetti 粒子 + CSS 动画
// 由 BrainState 的 presence（色相/发光强度）+ activity（脉冲频率/粒子流速）驱动
// size="mini"（报头胶囊，纯 SVG）/ size="full"（对话舱，SVG + Canvas 粒子 + confetti 爆发）
// SSR 兼容：SVG 静态渲染，Canvas/confetti 在 hydrate 后 useEffect 启动
import { useEffect, useRef } from "react";
import confetti from "canvas-confetti";
import type { Presence, Activity } from "../api/brain-state";

// presence → 色相
const HUE: Record<Presence, string> = {
  dormant: "#55504a",
  standby: "#191817",
  awake: "#b03a2e",
  focused: "#3b4d8f",
  pondering: "#3a6d8c",
  alert: "#a67c2e",
  weary: "#7a6f5e",
};

// presence → 发光强度（filter drop-shadow 不透明度）
const GLOW: Record<Presence, number> = {
  dormant: 0.1, standby: 0.3, awake: 0.6, focused: 1, pondering: 0.8, alert: 0.9, weary: 0.2,
};

// activity → 脉冲动画周期（秒，越小越快）
const PULSE_PERIOD: Record<Activity, number> = {
  idle: 3, directing: 0.8, reviewing: 1.5, settling: 2, gating: 1,
  gacha: 1.8, researching: 1.5, illustrating: 1.2, auditing: 1,
  evaluating: 1.4, foreshadowing: 2.2, housekeeping: 2,
};

// activity → 粒子流速倍率
const PARTICLE_SPEED: Record<Activity, number> = {
  idle: 0.3, directing: 2.2, reviewing: 1.2, settling: 1, gating: 1.8,
  gacha: 1.4, researching: 1.2, illustrating: 1.5, auditing: 1.6,
  evaluating: 1.3, foreshadowing: 0.8, housekeeping: 0.9,
};

// lucide Brain 图标的 SVG path（专业设计，24x24 viewBox，等比缩放到 100x100）
const BRAIN_PATHS = [
  "M12 18V5",
  "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4",
  "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
  "M17.997 5.125a4 4 0 0 1 2.526 5.77",
  "M18 18a4 4 0 0 0 2-7.464",
  "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
  "M6 18a4 4 0 0 1-2-7.464",
  "M6.003 5.125a4 4 0 0 0-2.526 5.77",
];

export const BrainCore: React.FC<{
  presence: Presence;
  activity?: Activity;
  size?: "mini" | "full";
  /** 自定义尺寸（覆盖 size 默认值，供对话舱头部用 72） */
  px?: number;
}> = ({ presence, activity = "idle", size = "full", px }) => {
  const hue = HUE[presence];
  const glow = GLOW[presence];
  const pulseDur = PULSE_PERIOD[activity] ?? 2;
  const speedMul = PARTICLE_SPEED[activity] ?? 1;
  const isFull = size === "full";
  const containerRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Canvas 神经元粒子层（仅 full 模式）：突触闪烁 + 神经信号流动
  useEffect(() => {
    if (!isFull) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const DPR = 2;
    canvas.width = 100 * DPR;
    canvas.height = 100 * DPR;
    ctx.scale(DPR, DPR);

    const N = 16;
    const neurons = Array.from({ length: N }, (_, i) => {
      const angle = (i / N) * Math.PI * 2;
      const r = 20 + (i % 3) * 7;
      return {
        x: 50 + Math.cos(angle) * r * 0.8,
        y: 48 + Math.sin(angle) * r * 0.7,
        phase: (i / N) * Math.PI * 2,
        speed: 0.02 + (i % 4) * 0.008,
        size: 1.2 + (i % 3) * 0.5,
      };
    });

    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 0.016;
      ctx.clearRect(0, 0, 100, 100);
      for (let i = 0; i < neurons.length; i++) {
        const n1 = neurons[i];
        n1.phase += n1.speed * speedMul;
        const flicker = (Math.sin(n1.phase) + 1) / 2;
        ctx.beginPath();
        ctx.arc(n1.x, n1.y, n1.size * (0.5 + flicker * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = hue + Math.round(flicker * 200 + 55).toString(16).padStart(2, "0");
        ctx.fill();
        const target = neurons[(i + 2 + (i % 2)) % neurons.length];
        const synapse = (Math.sin(t * speedMul * 3 + i) + 1) / 2;
        if (synapse > 0.65) {
          ctx.beginPath();
          ctx.moveTo(n1.x, n1.y);
          ctx.lineTo(target.x, target.y);
          ctx.strokeStyle = hue + Math.round(synapse * 100).toString(16).padStart(2, "0");
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [isFull, speedMul, hue]);

  // confetti 状态爆发（仅 full 模式）
  const prevPresence = useRef<Presence>(presence);
  useEffect(() => {
    if (!isFull) return;
    if (prevPresence.current === presence) return;
    const from = prevPresence.current;
    prevPresence.current = presence;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ox = (rect.left + rect.width / 2) / window.innerWidth;
    const oy = (rect.top + rect.height / 2) / window.innerHeight;
    if (presence === "alert" && from !== "alert") {
      confetti({ particleCount: 30, spread: 60, origin: { x: ox, y: oy }, colors: [HUE.alert, "#d4a843"], scalar: 0.7, ticks: 70, startVelocity: 18 });
    } else if (presence === "focused" && from !== "focused") {
      confetti({ particleCount: 20, spread: 45, origin: { x: ox, y: oy }, colors: [HUE.focused, "#5a6db5"], scalar: 0.6, ticks: 55, startVelocity: 14 });
    } else if (presence === "awake" && (from === "dormant" || from === "standby")) {
      confetti({ particleCount: 16, spread: 40, origin: { x: ox, y: oy }, colors: [HUE.awake], scalar: 0.6, ticks: 50, startVelocity: 12 });
    }
  }, [presence, isFull]);

  const dim = px ?? (isFull ? 128 : 22);
  const glowColor = `${hue}${Math.round(glow * 255).toString(16).padStart(2, "0")}`;
  return (
    <span
      ref={containerRef}
      className={`brain-core${isFull ? " brain-core-full" : " brain-core-mini"}`}
      style={{ width: dim, height: dim, position: "relative", display: "inline-flex", flexShrink: 0 }}
      data-presence={presence}
    >
      <svg viewBox="0 0 24 24" width={dim} height={dim} style={{ display: "block", overflow: "visible" }}>
        {/* 外脑波环：CSS 旋转脉冲 */}
        <circle
          className="brain-core-wave"
          cx={12} cy={12} r={11} fill="none" stroke={hue} strokeWidth={0.3}
          strokeDasharray="1 3" opacity={0.3 + glow * 0.3}
          style={{ transformOrigin: "12px 12px", animationDuration: `${pulseDur}s` }}
        />
        {/* lucide Brain 路径：专业设计的大脑轮廓（沟回+脑叶），缩放到 24x24 viewBox */}
        <g
          className="brain-core-glyph"
          stroke={hue}
          strokeWidth={1.5}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ filter: `drop-shadow(0 0 ${2 + glow * 4}px ${glowColor})`, animationDuration: `${pulseDur}s` }}
        >
          {BRAIN_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </svg>
      {isFull && (
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", inset: 0, width: dim, height: dim, pointerEvents: "none" }}
        />
      )}
    </span>
  );
};
