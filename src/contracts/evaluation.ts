export const EVAL_DIMENSIONS = ["剧情逻辑", "人物塑造", "节奏张力", "文笔风格", "爽点钩子", "伏笔管理", "设定一致", "主题立意"] as const;

export type EvalDimensionResult = {
  name: (typeof EVAL_DIMENSIONS)[number];
  score: number;
  evidence: string;
};

export type EvalReport = {
  at: string;
  chaptersEvaluated: number;
  dimensions: EvalDimensionResult[];
  overall: number;
  suggestions: string[];
};
