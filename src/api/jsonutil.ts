// 鲁棒 JSON 提取：LLM 输出可能带 ```json 围栏、前后杂文、尾部附加说明
function balancedExtract(s: string): string | null {
  // 从第一个 { 开始做平衡括号扫描（跳过字符串内的 { }），返回第一个完整 JSON 对象
  const start = s.indexOf("{");
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
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
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
      /* 落到策略 3 */
    }
  }
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

// —— JSON 输出重试：LLM 输出不合法 JSON 时，回填其上次输出并要求修复（最多 1 次重试） ——
import type { ChatMessage } from "./agnes";
import { chat } from "./agnes";

const JSON_FIX_RULE =
  "要求：只输出一个合法 JSON 对象（不要 markdown 围栏）；字符串值内部一律使用中文引号「」或『』，禁止在字符串里使用英文双引号（\"）。";

export async function chatJson<T>(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  let msgs = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(msgs, opts);
    try {
      return extractJson<T>(raw);
    } catch (e) {
      if (attempt === 0) {
        msgs = [
          ...messages,
          { role: "assistant", content: raw.slice(0, 8000) },
          { role: "user", content: `上次输出不是合法 JSON：${(e as Error).message}。请重新输出。${JSON_FIX_RULE}` },
        ];
      } else {
        throw e;
      }
    }
  }
  throw new Error("unreachable");
}
