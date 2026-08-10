// 鲁棒 JSON 提取：LLM 输出可能带 ```json 围栏、前后杂文、尾部附加说明、引号包裹、数组顶层
function balancedExtractCore(s: string, open: string, close: string): string | null {
  // 从第一个 open 开始做平衡括号扫描（跳过字符串内的括号），返回第一个完整 JSON 值
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
const balancedExtract = (s: string) => balancedExtractCore(s, "{", "}");
const balancedArrayExtract = (s: string) => balancedExtractCore(s, "[", "]");

/** 依次尝试 parse，返回第一个成功的值；全部失败返回 undefined */
function tryParseCandidates(candidates: string[]): unknown {
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return undefined;
}

export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  // 策略 1：去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // 策略 2：平衡括号截取第一个完整 JSON 对象
  const balanced = balancedExtract(s);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch {
      /* 落到策略 2.5 */
    }
  }
  // 策略 2.5：宽容候选链（逐个尝试，任一成功即返回）——
  //  a) 第一个 { 到最后一个 }：剥离尾缀（含截断的引号/附加说明）
  //  b) 整个输出被英文引号包裹：剥掉首尾引号后重试
  //  c) 顶层是数组（如 [{...}]）：平衡方括号截取首个完整数组
  const candidates: string[] = [];
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(s.slice(firstBrace, lastBrace + 1));
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    const unquoted = s.slice(1, -1).trim();
    const ub = balancedExtract(unquoted);
    if (ub) candidates.push(ub);
    candidates.push(unquoted);
  }
  if (s.startsWith("[")) {
    const arr = balancedArrayExtract(s);
    if (arr) candidates.push(arr);
  }
  const parsed = tryParseCandidates(candidates);
  if (parsed !== undefined) return parsed as T;
  // 策略 3：直接 parse（可能是严格 JSON）
  try {
    return JSON.parse(s) as T;
  } catch (e) {
    throw new Error(
      `输出不是合法 JSON: ${(e as Error).message}\n输出预览: ${JSON.stringify(s.slice(0, 200))}`,
    );
  }
}

export function clampScore(n: unknown, lo = 1, hi = 10): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

// —— JSON Schema 轻量校验（draft-07 子集：type/required/properties/items/enum，嵌套递归） ——
// 用于 chatJson 输出结构化约束：schema 注入 prompt + 校验失败走修复重试，提高 LLM 输出可控性。

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
};

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** 校验 value 是否符合 schema，返回错误路径列表（空 = 通过） */
export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const t = schema.type;
  if (t) {
    const actual = typeOf(value);
    if (actual !== t) {
      // integer 是 number 的子类型
      if (!(t === "integer" && actual === "number" && Number.isInteger(value))) {
        errors.push(`${path} 期望 ${t}，实际 ${actual}`);
        return errors; // 类型不符直接短路
      }
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path} 不在枚举内`);
  }
  if (t === "object" || (value !== null && typeof value === "object" && !Array.isArray(value))) {
    const obj = value as Record<string, unknown>;
    if (obj === null) {
      errors.push(`${path} 期望 object，实际 null`);
      return errors;
    }
    for (const req of schema.required ?? []) {
      if (!(req in obj) || obj[req] === undefined) {
        errors.push(`${path}.${req} 缺失`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        errors.push(...validateJsonSchema(obj[key], sub, `${path}.${key}`));
      }
    }
  }
  if (t === "array" && Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((item, i) => {
      errors.push(...validateJsonSchema(item, items, `${path}[${i}]`));
    });
  }
  return errors;
}

// —— JSON 输出重试：LLM 输出不合法 JSON 或不符合 schema 时，回填上次输出并要求修复（最多 1 次重试） ——
import type { ChatMessage } from "./agnes";
import { chat, chatStream, isRetryableError } from "./agnes";

/** 单次 JSON 生成调用：流式优先（长任务流式聚合，规避非流式网关 504）。
 * 但 tokenrhythm 等上游对流式有 ~30s 无首字节断开（ECONNRESET，推理模型思考期常见）——
 * 流式失败（可重试网络错误）时降级非流式 chat 兜底（非流式 504 同样走其内部重试），最大化成功率。 */
async function jsonCallOnce(msgs: ChatMessage[], opts: ChatJsonOpts): Promise<string> {
  try {
    return await chatStream(msgs, () => {}, opts);
  } catch (e) {
    if (isRetryableError(e)) {
      console.warn(`[jsonutil] 流式调用失败，降级非流式 chat 兜底: ${(e as Error).message.slice(0, 120)}`);
      return await chat(msgs, opts);
    }
    throw e;
  }
}

const JSON_FIX_RULE =
  "要求：只输出一个以 { 开头、以 } 结尾的合法 JSON 对象（不要 markdown 围栏，不要用英文引号包裹整个输出，不要输出任何解释、前缀或后缀文字）；字符串值内部一律使用中文引号「」或『』，禁止在字符串里使用英文双引号（\"）。";

export type ChatJsonOpts = {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** JSON Schema（draft-07 子集）：注入 prompt 强制输出结构 + 校验失败自动修复重试 */
  schema?: JsonSchema;
};

/** 把 schema 文本化追加进最后一条 user 消息（不新增轮次，最小扰动） */
function injectSchema(messages: ChatMessage[], schema: JsonSchema): ChatMessage[] {
  const schemaText = JSON.stringify(schema);
  const rule = `\n[输出约束·必须严格遵守] 只输出符合以下 JSON Schema 的 JSON（缺失字段/类型错误/枚举不符都会被拒绝并要求重试）：\n${schemaText}`;
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, content: last.content + rule }];
}

export async function chatJson<T>(
  messages: ChatMessage[],
  opts: ChatJsonOpts = {},
): Promise<T> {
  let msgs = opts.schema ? injectSchema(messages, opts.schema) : messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    // 流式聚合（chatStream）替代非流式 chat：流式持续返回数据，避开上游网关对长时非流式请求的空闲超时（504）——
    // 审查/记账/评估等 JSON 任务耗时可达数分钟，非流式极易被网关切断。
    // 流式失败（ECONNRESET 等）由 jsonCallOnce 降级非流式兜底（见上）
    const raw = await jsonCallOnce(msgs, opts);
    let parsed: T;
    try {
      parsed = extractJson<T>(raw);
    } catch (e) {
      if (attempt === 0) {
        msgs = [
          ...messages,
          { role: "assistant", content: raw.slice(0, 8000) },
          { role: "user", content: `上次输出不是合法 JSON：${(e as Error).message}。\n上次输出预览（前 300 字符）：${JSON.stringify(raw.slice(0, 300))}\n请重新输出。${JSON_FIX_RULE}` },
        ];
        if (opts.schema) msgs = injectSchema(msgs, opts.schema);
      } else {
        throw e;
      }
      continue;
    }
    // schema 校验（可选）：不满足则回填具体错误要求修复
    if (opts.schema) {
      const errs = validateJsonSchema(parsed as unknown, opts.schema);
      if (errs.length) {
        if (attempt === 0) {
          msgs = [
            ...messages,
            { role: "assistant", content: raw.slice(0, 8000) },
            { role: "user", content: `上次输出不符合输出约束：\n${errs.slice(0, 8).join("\n")}\n请修正后重新输出。${JSON_FIX_RULE}` },
          ];
          if (opts.schema) msgs = injectSchema(msgs, opts.schema);
        } else {
          throw new Error(`输出不符合 JSON Schema：${errs.slice(0, 8).join("；")}`);
        }
        continue;
      }
    }
    return parsed;
  }
  throw new Error("unreachable");
}
