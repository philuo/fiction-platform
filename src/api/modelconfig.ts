// 模型路由与任务画像（ARCHITECTURE P0/P1 落地）
// 中枢架构核心抽象：区分「执行模型（executor）」与「中枢模型（brain/overseer）」，
// 全部 LLM 调用点按任务名从 TASK_PROFILES 取参，删除内联 temperature/timeout/retries 散点。
// - 模型解析优先级：任务级 env 覆盖（AGNES_TASK_<name>__*）→ exec/brain 专用（AGNES_EXEC_MODEL/AGNES_BRAIN_MODEL）
//   → 全局文本模型（TEXT_MODEL）→ 全局回落（AGNES_MODEL）→ 默认 agnes-2.5-flash
// - 未配置任何 env 时行为与现状完全一致（文档 P0 验收：现有部署零改动跑通）
import type { AgnesOptions } from "./agnes";

export type ModelKind = "exec" | "brain";

/** 解析指定角色的模型名（exec=局部任务吞吐优先；brain=整书决策推理优先） */
export function resolveModel(kind: ModelKind): string {
  if (kind === "brain") {
    return process.env.AGNES_BRAIN_MODEL || process.env.TEXT_MODEL || process.env.AGNES_MODEL || "agnes-2.5-flash";
  }
  return process.env.AGNES_EXEC_MODEL || process.env.TEXT_MODEL || process.env.AGNES_MODEL || "agnes-2.5-flash";
}

/** 任务失败降级语义（对齐 ARCHITECTURE §3.5 的 fallback 列） */
export type TaskFallback =
  | "throw" // 失败直接抛错（写章/审查/抽卡等强约束任务）
  | "truncate" // 降级为截断文本（摘要/记账类）
  | "deterministic" // 降级为确定性部分（闸门/影响评估/中枢审查）
  | "default" // 使用内置兜底（规划类）

/** 任务画像：每个 LLM 任务的结构化配置（模型角色/温度/预算/重试/失败降级/是否 JSON 修复） */
export type TaskProfile = {
  /** 模型角色：exec | brain（或显式模型名） */
  model: ModelKind | string;
  temperature: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** 是否走 chatJson（JSON 输出修复） */
  json?: boolean;
  fallback?: TaskFallback;
};

/**
 * 全任务画像表（13+ 调用点，数值对齐现状代码，P1 验收：行为等价）。
 * 命名约定：任务名与 HARNESS 指令的 llm 角色对应，可被 AGNES_TASK_<name>__* env 覆盖。
 */
export const TASK_PROFILES: Record<string, TaskProfile> = {
  // —— 叙事生成类（N）——
  writer: { model: "exec", temperature: 0.9, maxTokens: 60000, timeoutMs: 240_000, fallback: "throw" }, // 流式写正文（字数治理保留）
  init: { model: "exec", temperature: 0.9, maxTokens: 60000, fallback: "throw" }, // 立项建世界（N01）
  outline: { model: "exec", temperature: 0.8, maxTokens: 60000, fallback: "default" }, // 大纲要点（W01）
  blueprint: { model: "exec", temperature: 0.9, maxTokens: 60000, fallback: "default" }, // 蓝图候选（W02/W03）
  patch: { model: "exec", temperature: 1.0, maxTokens: 60000, fallback: "default" }, // 段落修补（N11，温度由 gen 动态 min(t,1.0)）

  // —— 审查/记账/记忆（L/critic）——
  critic: { model: "exec", temperature: 0.4, maxTokens: 60000, json: true, fallback: "throw" }, // 对抗审查（N10）
  chronicler: { model: "exec", temperature: 0.2, maxTokens: 60000, json: true, fallback: "truncate" }, // 章末记账（L01/L03/L04）
  memory: { model: "exec", temperature: 0.3, maxTokens: 60000, json: true, fallback: "truncate" }, // 章/阶段摘要（L08/L09）
  style: { model: "exec", temperature: 0.3, maxTokens: 60000, json: true, fallback: "default" }, // 风格指纹（W16）

  // —— 规划类（W）——
  expandArc: { model: "exec", temperature: 0.8, maxTokens: 60000, fallback: "default" }, // 弧章节计划展开（W05/W06/W11）
  compass: { model: "exec", temperature: 0.5, maxTokens: 60000, fallback: "default" }, // 指南针校准（W10）

  // —— 抽卡/分镜（W17/M01）——
  cards: { model: "exec", temperature: 1.0, maxTokens: 60000, fallback: "throw" }, // 卡池生成（W17）
  media: { model: "exec", temperature: 0.5, maxTokens: 60000, timeoutMs: 150_000, retries: 2, fallback: "throw" }, // 分镜规划（M01）

  // —— 评估/治理（S09/G01）——
  eval: { model: "brain", temperature: 0.3, maxTokens: 60000, json: true, fallback: "default" }, // 整书评估（S09，可 exec）
  impactReport: { model: "exec", temperature: 0.2, maxTokens: 60000, json: true, fallback: "deterministic" }, // 干预影响评估（G01）

  // —— 中枢（brain）——
  brainGate: { model: "brain", temperature: 0.2, maxTokens: 60000, json: true, fallback: "deterministic" }, // 状态变更闸门（L2+ 审查）
  brainReview: { model: "brain", temperature: 0.2, maxTokens: 60000, json: true, fallback: "deterministic" }, // 章末一致性审查（P1 窗口）
};

/** 读取任务级 env 覆盖：AGNES_TASK_<name>__model / __temperature / __maxTokens / __timeoutMs / __retries */
function envOverride(task: string): Partial<TaskProfile> {
  const out: Partial<TaskProfile> = {};
  const key = (k: string) => `AGNES_TASK_${task}__${k}`;
  const m = process.env[key("model")];
  if (m) out.model = m;
  const t = process.env[key("temperature")];
  if (t && Number.isFinite(Number(t))) out.temperature = Number(t);
  const mt = process.env[key("maxTokens")];
  if (mt && Number.isFinite(Number(mt))) out.maxTokens = Number(mt);
  const tm = process.env[key("timeoutMs")];
  if (tm && Number.isFinite(Number(tm))) out.timeoutMs = Number(tm);
  const r = process.env[key("retries")];
  if (r && Number.isFinite(Number(r))) out.retries = Number(r);
  return out;
}

/** 解析任务画像（env 覆盖优先，未覆盖回落表内默认；未知任务回退 writer 级 exec 默认） */
export function resolveTaskProfile(task: string): TaskProfile {
  const base = TASK_PROFILES[task] ?? { model: "exec" as ModelKind, temperature: 0.9, maxTokens: 60000, fallback: "throw" as TaskFallback };
  return { ...base, ...envOverride(task) };
}

/** 便捷：把任务画像转成 AgnesOptions（调用点可选覆盖部分字段；writer/patch 需用 gen 温度时传入 override） */
export function taskOpts(task: string, override?: Partial<AgnesOptions> & { model?: string }): AgnesOptions {
  const p = resolveTaskProfile(task);
  const model = typeof p.model === "string" && (p.model === "exec" || p.model === "brain") ? resolveModel(p.model) : String(p.model);
  return {
    model,
    temperature: p.temperature,
    ...(p.maxTokens ? { maxTokens: p.maxTokens } : {}),
    ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.retries ? { retries: p.retries } : {}),
    ...(override ?? {}),
  };
}
