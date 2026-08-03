// 可复用双滑块范围组件（如章节字数范围）

type Props = {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  unit?: string;
};

export const RangeSlider: React.FC<Props> = (p) => {
  const lo = Math.min(p.value[0], p.value[1]);
  const hi = Math.max(p.value[0], p.value[1]);
  const pct = (v: number) => ((v - p.min) / (p.max - p.min)) * 100;
  const step = p.step ?? 50; // 固定步长，保证默认值在步进网格上
  const unit = p.unit ?? "";

  return (
    <div>
      <div className="range-wrap">
        <div className="range-track" />
        <div
          className="range-fill"
          style={{ left: `${pct(lo)}%`, width: `${Math.max(0, pct(hi) - pct(lo))}%` }}
        />
        {/* lo 在上层：优先可拖（交叉时值自动交换） */}
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={step}
          value={lo}
          style={{ zIndex: 2 }}
          onInput={(e) => p.onChange([Number((e.target as HTMLInputElement).value), hi])}
        />
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={step}
          value={hi}
          style={{ zIndex: 1 }}
          onInput={(e) => p.onChange([lo, Number((e.target as HTMLInputElement).value)])}
        />
      </div>
      <div className="range-labels">
        <span>{lo}{unit}</span>
        <span>{hi}{unit}</span>
      </div>
    </div>
  );
};
