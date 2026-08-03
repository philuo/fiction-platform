// Agnes AI 客户端（OpenAI 兼容 chat/completions）：streaming / tool calling / 重试回退
// 密钥从 .env / 环境变量读取（bun 自动加载 .env）

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type AgnesOptions = {
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  stream?: boolean;
};

export class LLMError extends Error {}

const BASE_URL = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const API_KEY = process.env.AGNES_API_KEY ?? "";
const MODEL = process.env.AGNES_MODEL ?? "agnes-2.5-flash";
const FALLBACK_MODEL = process.env.AGNES_FALLBACK_MODEL ?? "agnes-2.0-flash";

async function postJson(url: string, body: unknown, timeoutMs = 120_000): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

function isRetryable(msg: string): boolean {
  return (
    msg.startsWith("HTTP 429") || msg.startsWith("HTTP 5") || msg.includes("网络错误") || /timeout/i.test(msg)
  );
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      if (!isRetryable(lastErr.message)) throw lastErr;
      await Bun.sleep(2 ** attempt * 1000);
    }
  }
  throw lastErr ?? new LLMError("重试次数耗尽");
}

async function callOnce(model: string, messages: ChatMessage[], opts: AgnesOptions): Promise<Response> {
  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.tools) payload.tools = opts.tools;
  if (opts.maxTokens) payload.max_tokens = opts.maxTokens;
  if (opts.stream) payload.stream = true;
  return postJson(`${BASE_URL}/chat/completions`, payload);
}

async function parseMessage(res: Response): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  // 503 = 免费额度渠道暂满（上游限流），先判状态再解析 body（503 响应体可能非 JSON）
  if (res.status === 503) {
    throw new LLMError("AI 服务繁忙（免费额度渠道暂满），请稍等片刻重试");
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    error?: { message?: string };
  };
  if (!res.ok || data.error || !data.choices?.length) {
    throw new LLMError(`HTTP ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  }
  const msg = data.choices[0].message ?? {};
  return { content: (msg.content ?? "").trim(), tool_calls: msg.tool_calls };
}

/** 完整 message 返回（含 tool_calls），供叙事引擎的工具循环使用 */
export async function complete(messages: ChatMessage[], opts: AgnesOptions = {}): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const doCall = async () => {
    const res = await callOnce(MODEL, messages, opts);
    return parseMessage(res);
  };
  try {
    return await withRetry(doCall);
  } catch (e) {
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
      const res = await callOnce(FALLBACK_MODEL, messages, opts);
      return parseMessage(res);
    }
    throw e;
  }
}

/** 纯文本对话 */
export async function chat(messages: ChatMessage[], opts: AgnesOptions = {}): Promise<string> {
  const r = await complete(messages, opts);
  return r.content;
}

/** SSE 流式对话：onChunk(text) 回调，返回完整文本 */
export async function chatStream(
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  opts: AgnesOptions = {},
): Promise<string> {
  const res = await callOnce(MODEL, messages, { ...opts, stream: true });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new LLMError(`HTTP ${res.status}: ${data?.error?.message ?? "stream 请求失败"}`);
  }
  const full: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full.push(delta);
          onChunk(delta);
        }
      } catch {
        /* 忽略不完整 chunk */
      }
    }
  }
  return full.join("");
}
