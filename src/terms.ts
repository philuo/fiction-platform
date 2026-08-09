// 全局术语中文映射：审查维度（lens）/ 严重级别（severity）统一中文化。
// 审查报告（ReviewPanel）、中枢台账（MemoryAuditModal）、整书评估（EvalModal）、连载问题清单（AutoRunPanel）共用，
// 保证「维度/级别」术语全局一致，避免各组件各自维护出现差异。
// 数据层（critic 输出/qualityDebt.lens）仍存英文键，展示层统一在此映射。

export const LENS_CN: Record<string, string> = {
  // 审查静态检查维度（critic prompt 枚举）
  continuity: "连续性",
  character_state: "角色状态",
  logic: "逻辑",
  foreshadow: "伏笔",
  outline: "本章计划",
  aiTone: "AI 腔",
  intervention: "干预",
  // 评分维度（scores / 评估）
  coherence: "连贯",
  tension: "张力",
  prose: "文笔",
  pacing: "节奏",
  dialogue: "对话",
  // 兜底/其他
  style: "风格",
  arc: "弧线",
  general: "综合",
  quality: "质量",
};

/** 维度中文：已知键映射，未知键原样返回（保留数据可追溯），空值返回 —。
 * 支持斜杠组合键（如「连续性/outline」）逐段映射，避免混合键残留英文。 */
export const lensCn = (lens?: string): string => {
  if (!lens) return "—";
  const segCn = (seg: string): string => {
    const s = seg.trim();
    if (!s) return "";
    if (LENS_CN[s]) return LENS_CN[s];
    // 前缀匹配：按键长降序，避免短键误吞长键（如 outline 前缀带括号注释）
    const keys = Object.keys(LENS_CN).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (s.startsWith(k)) return LENS_CN[k] + s.slice(k.length);
    }
    return s;
  };
  return lens
    .split(/[/／]/)
    .map(segCn)
    .filter(Boolean)
    .join("·");
};

/** 严重级别：major=严重 minor=轻微（badge / 筛选 / 统计文本统一） */
export const SEVERITY_CN: Record<string, string> = { major: "严重", minor: "轻微" };

/** 级别中文：未知键原样返回 */
export const severityCn = (severity?: string): string => (severity ? (SEVERITY_CN[severity] ?? severity) : "—");
