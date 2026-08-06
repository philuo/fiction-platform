// 中枢指示器（报头常驻）：实时显示中枢当前动作 + 已运行时长，点击打开记忆·台账·操作日志弹窗
// 时长四档格式（用户规范）：0-99s → Ns；≥100s → Mm Ss；≥1h → Hh Mm Ss；≥1d → Dd Hh Mm
// SSR 兼容：初始渲染不依赖 interval（elapsed 初值 0），hydrate 后才开始 tick
import { useEffect, useRef, useState } from "react";

/** 四档时长格式化：0-99s / Mm Ss / Hh Mm Ss / Dd Hh Mm */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 100) return `${total}s`;
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export const BrainIndicator: React.FC<{
  /** 当前动作描述：推进/写章的 busyPhase 优先，其次连载 autoSession.phase；空串 = 待命 */
  action: string;
  busy: boolean;
  onClick: () => void;
}> = (p) => {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const running = p.busy && Boolean(p.action);

  // 动作起点跟踪：busy+action 出现 → 记起点；消失 → 清零回待命
  useEffect(() => {
    if (running) {
      if (startRef.current === null) startRef.current = Date.now();
    } else {
      startRef.current = null;
      setElapsed(0);
    }
  }, [running]);

  // 每秒 tick（仅运行中；hydrate 后启动，SSR 初始为 0）
  useEffect(() => {
    if (!running || startRef.current === null) return;
    const t = setInterval(() => setElapsed(Date.now() - (startRef.current ?? Date.now())), 1000);
    setElapsed(Date.now() - (startRef.current ?? Date.now())); // 立即刷新一次
    return () => clearInterval(t);
  }, [running]);

  return (
    <button
      className={running ? "brain-indicator busy" : "brain-indicator"}
      onClick={p.onClick}
      title="中枢：点击查看分层记忆 · 台账 · 操作日志"
    >
      <span className="brain-dot" />
      <span className="brain-label">中枢</span>
      {/* 动作名：有动作就显示（含连载暂停态）；计时仅在 busy（真正运行中）时展示 */}
      <span className="brain-action">{p.action || "待命"}</span>
      {running && <span className="brain-timer">{formatElapsed(elapsed)}</span>}
    </button>
  );
};
