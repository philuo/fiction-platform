// Agnes AI 客户端：优先官方 Responses API（/v1/responses，思考型模型预算更规范），chat/completions 兼容兜底
// 密钥从 .env / 环境变量读取（bun 自动加载 .env）
import { textLimiter } from "./limiter";

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
  /** 模型名覆盖（中枢架构 P0：exec/brain 双模型路由，缺省回落 TEXT_MODEL/AGNES_MODEL） */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  stream?: boolean;
  /** 单次请求超时毫秒（缺省 120s）；交互式任务（分镜等）可收紧避免长时间无反馈 */
  timeoutMs?: number;
  /** 主模型+回退模型各自的失败重试次数上限（缺省 4 次；分镜等交互任务建议 1 次） */
  retries?: number;
  /** 思考强度（agnes-2.5-flash 为思考型模型，reasoning 与正文共享输出预算）：high/medium/low；
   * 缺省读环境变量 AGNES_REASONING_EFFORT，再缺省不传（服务端默认思考，实测稳定）。
   * 注意：high 思考量无上界（实测 1000~32000+），会间歇性吃光预算导致空输出/超时，需配合极大 max_tokens 兜底 */
  reasoningEffort?: "low" | "medium" | "high";
};

export class LLMError extends Error {
  /** 空内容时的 finish_reason（诊断/重试策略用）：length=思考或正文吃光预算；stop 或 undefined=上游偶发 */
  finishReason?: string;
  /** usage.completion_tokens_details.reasoning_tokens（思考 token 数，判断预算分配） */
  reasoningTokens?: number;
  /** usage.completion_tokens_details.text_tokens（正文 token 数） */
  textTokens?: number;
}

// —— 文本模型配置分离：TEXT_* 专用（可切换到任意 OpenAI 兼容端点，如基元 tokenrhythm），未配置时回落 AGNES_* 保持现状；
// 插画/视频仍读 AGNES_BASE_URL/AGNES_API_KEY（images.ts/videos.ts），互不干扰 ——
const AGNES_BASE = (process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const BASE_URL = (process.env.TEXT_BASE_URL ?? process.env.AGNES_BASE_URL ?? "https://api.agnes-ai.cn/v1").replace(/\/$/, "");
const API_KEY = process.env.TEXT_API_KEY ?? process.env.AGNES_API_KEY ?? "";
// 文本模型：TEXT_MODEL → AGNES_MODEL → agnes-2.5-flash（用户可在 .env 随时更换）
const MODEL = process.env.TEXT_MODEL ?? process.env.AGNES_MODEL ?? "agnes-2.5-flash";
// Responses API 仅 Agnes 端点支持；其他 OpenAI 兼容端点直接走 chat/completions，避免无效降级重试
const USE_RESPONSES_API = BASE_URL === AGNES_BASE;

async function postJson(url: string, body: unknown, timeoutMs = 120_000): Promise<Response> {
  // 全局文本限流（并发 + RPM）：排队不触发 429；超时在拿到槽位后才起算
  return textLimiter.run(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }),
  );
}

function isRetryable(msg: string): boolean {
  return (
    msg.startsWith("HTTP 429") ||
    msg.startsWith("HTTP 5") ||
    msg.includes("网络错误") ||
    msg.includes("空内容") ||
    msg.includes("空输出") ||
    /timeout/i.test(msg)
  );
}

/** 可感知错误的智能重试：失败可重试则按指数退避重试；
 * 空内容且 finish_reason=length（思考/正文吃光预算）时，下一次请求自动降档 reasoning_effort=low，
 * 把预算让给正文输出——避免相同参数盲重试全部失败。返回最后一次错误。 */
async function withSmartRetry(
  doCall: (attemptOpts: AgnesOptions) => Promise<unknown>,
  opts: AgnesOptions,
  maxRetries = 4,
): Promise<unknown> {
  let lastErr: Error | null = null;
  let curOpts = opts;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await doCall(curOpts);
    } catch (e) {
      lastErr = e as Error;
      if (!isRetryable(lastErr.message)) throw lastErr;
      // 思考吃光预算：降档思考强度重试（显式 reasoning_effort 时不覆盖用户配置）
      if (lastErr instanceof LLMError && lastErr.finishReason === "length" && !curOpts.reasoningEffort) {
        console.warn(`[agnes] 空内容疑似思考吃光预算（finish_reason=length，reasoning=${lastErr.reasoningTokens ?? "?"} text=${lastErr.textTokens ?? "?"}），重试降档 reasoning_effort=low`);
        curOpts = { ...curOpts, reasoningEffort: "low" };
      }
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
  // 思考强度：优先调用级配置，其次环境变量 AGNES_REASONING_EFFORT；不传则服务端默认思考（实测稳定）。
  // 注意：服务端默认输出上限 4096，思考型任务思考可吃光全部预算导致空输出，各调用点必须显式传大 max_tokens 兜底
  const effort = opts.reasoningEffort ?? (process.env.AGNES_REASONING_EFFORT as "low" | "medium" | "high" | undefined);
  if (effort) payload.reasoning_effort = effort;
  return postJson(`${BASE_URL}/chat/completions`, payload, opts.timeoutMs ?? 120_000);
}

async function parseMessage(res: Response, ctx?: { model?: string; msgChars?: number }): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  // 503 = 免费额度渠道暂满（上游限流），先判状态再解析 body（503 响应体可能非 JSON）
  if (res.status === 503) {
    throw new LLMError("AI 服务繁忙（免费额度渠道暂满），请稍等片刻重试");
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
    error?: { message?: string };
  };
  if (!res.ok || data.error || !data.choices?.length) {
    throw new LLMError(`HTTP ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  }
  const msg = data.choices[0].message ?? {};
  const content = (msg.content ?? "").trim();
  // 200 但无任何输出（免费额度渠道偶发）：按可重试错误处理，避免空串进入 JSON 解析/写作管线；
  // 诊断日志含 usage.completion_tokens_details（reasoning/text token 比值）：
  // reasoning 占满预算（finish_reason=length 且 text=0）说明思考吃光 max_tokens，重试时需降档思考强度而非盲重试
  if (!content && !msg.tool_calls?.length) {
    const usage = (data as { usage?: { completion_tokens_details?: { reasoning_tokens?: number; text_tokens?: number } } }).usage;
    const detail = usage?.completion_tokens_details;
    const finishReason = data.choices[0]?.finish_reason;
    console.warn(
      `[agnes] LLM 空内容（HTTP 200）：choices=${data.choices?.length ?? 0} finish_reason=${finishReason ?? "?"} reasoningTokens=${detail?.reasoning_tokens ?? "?"} textTokens=${detail?.text_tokens ?? "?"} usage=${JSON.stringify(usage).slice(0, 200)} body=${JSON.stringify(data).slice(0, 200)} model=${ctx?.model ?? "?"} msgChars=${ctx?.msgChars ?? "?"}`,
    );
    const e = new LLMError("AI 服务暂时无输出（HTTP 200 空内容，免费渠道繁忙），正在重试");
    e.finishReason = finishReason;
    e.reasoningTokens = detail?.reasoning_tokens;
    e.textTokens = detail?.text_tokens;
    throw e;
  }
  return { content, tool_calls: msg.tool_calls };
}

/**
 * Responses API（/v1/responses）：官方为推理型模型提供的端点，用 max_output_tokens 统一管理
 * 思考+正文预算，status=incomplete 时携带 incomplete_details（比 chat/completions 的
 * finish_reason=length 空输出更可诊断）。结构化 input（input[].content[].type=input_text）。
 */
async function callResponsesOnce(model: string, messages: ChatMessage[], opts: AgnesOptions): Promise<Response> {
  const payload: Record<string, unknown> = {
    model,
    input: messages.map((m) => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })),
    temperature: opts.temperature ?? 0.8,
    // 思考型模型 reasoning 与正文共享输出预算：缺省给足 60000（服务端上限 65.5K），避免 incomplete
    max_output_tokens: opts.maxTokens ?? 60000,
  };
  return postJson(`${BASE_URL}/responses`, payload, opts.timeoutMs ?? 120_000);
}

async function parseResponses(res: Response, ctx?: { model?: string; msgChars?: number }): Promise<{ content: string }> {
  // 503 = 免费额度渠道暂满（上游限流），先判状态再解析 body
  if (res.status === 503) {
    throw new LLMError("AI 服务繁忙（免费额度渠道暂满），请稍等片刻重试");
  }
  const data = (await res.json().catch(() => null)) as {
    status?: string;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    error?: { message?: string } | null;
    incomplete_details?: unknown;
  } | null;
  if (!res.ok || !data || data.error) {
    throw new LLMError(`HTTP ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 300)}`);
  }
  // 官方 Warning：无顶层 output_text 便捷字段，须从 output[].type=message 的 content[].output_text 提取
  const content = (data.output ?? [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text" && c.text)
    .map((c) => c.text as string)
    .join("")
    .trim();
  // incomplete（思考/正文吃光 max_output_tokens）或空文本：按可重试错误处理，智能重试加大预算再来
  if (data.status === "incomplete" || !content) {
    console.warn(
      `[agnes] Responses 输出不完整：status=${data.status ?? "?"} incomplete_details=${JSON.stringify(data.incomplete_details ?? null)} model=${ctx?.model ?? "?"} msgChars=${ctx?.msgChars ?? "?"}`,
    );
    const e = new LLMError("Responses 空输出（status=incomplete，思考吃光预算），正在重试");
    e.finishReason = "length";
    throw e;
  }
  return { content };
}

/** 完整 message 返回（含 tool_calls），供叙事引擎的工具循环使用；模型由 TEXT_MODEL/AGNES_MODEL 配置，失败重试后直接抛错。
 * 无工具调用的任务优先走官方 Responses API，失败自动降级 chat/completions 兜底（功能不中断） */
export async function complete(messages: ChatMessage[], opts: AgnesOptions = {}): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  const retries = opts.retries ?? 4;
  const t0 = Date.now();
  const msgChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  // 工具循环（tools 定义 / tool 消息 / tool_calls 回填）仅 chat/completions 支持，不迁移
  const useResponses = USE_RESPONSES_API && !opts.tools && messages.every((m) => m.role !== "tool" && !m.tool_calls?.length);
  const model = opts.model ?? MODEL;
  if (useResponses) {
    try {
      const r = await withSmartRetry(
        (attemptOpts) =>
          callResponsesOnce(model, messages, attemptOpts).then((res) => parseResponses(res, { model, msgChars })),
        opts,
        retries,
      ) as { content: string };
      console.log(`[agnes] responses 完成 耗时${((Date.now() - t0) / 1000).toFixed(1)}s model=${model} 重试上限${retries} msgChars=${msgChars}`);
      return r;
    } catch (e) {
      console.warn(`[agnes] Responses API 失败，降级 chat/completions 兜底 耗时${((Date.now() - t0) / 1000).toFixed(1)}s: ${(e as Error).message}`);
    }
  }
  try {
    const r = (await withSmartRetry(
      (attemptOpts) =>
        callOnce(model, messages, attemptOpts).then((res) =>
          parseMessage(res, { model, msgChars }),
        ),
      opts,
      retries,
    )) as { content: string; tool_calls?: ToolCall[] };
    console.log(`[agnes] complete 完成 耗时${((Date.now() - t0) / 1000).toFixed(1)}s model=${model} 重试上限${retries} msgChars=${msgChars}`);
    return r;
  } catch (e) {
    console.error(`[agnes] complete 失败 耗时${((Date.now() - t0) / 1000).toFixed(1)}s:`, (e as Error).message);
    throw e;
  }
}

/** 纯文本对话 */
export async function chat(messages: ChatMessage[], opts: AgnesOptions = {}): Promise<string> {
  const r = await complete(messages, opts);
  return r.content;
}

/** 读取一条 SSE 流并逐 delta 回调；流式无输出同样按可重试错误处理 */
async function readStream(res: Response, onChunk: (delta: string) => void): Promise<string> {
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
  const out = full.join("");
  if (!out.trim()) throw new LLMError("AI 返回空内容（流式无输出），正在重试");
  return out;
}

/** SSE 流式对话：onChunk(text) 回调，返回完整文本；模型由 TEXT_MODEL/AGNES_MODEL 配置，失败重试后直接抛错 */
export async function chatStream(
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  opts: AgnesOptions = {},
): Promise<string> {
  const retries = opts.retries ?? 4;
  const t0 = Date.now();
  const model = opts.model ?? MODEL;
  try {
    const r = (await withSmartRetry(
      (attemptOpts) => {
        const streamOpts = { ...attemptOpts, stream: true };
        return callOnce(model, messages, streamOpts).then((res) => readStream(res, onChunk));
      },
      opts,
      retries,
    )) as string;
    console.log(`[agnes] chatStream 完成 耗时${((Date.now() - t0) / 1000).toFixed(1)}s model=${model} 重试上限${retries} msgChars=${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`);
    return r;
  } catch (e) {
    console.error(`[agnes] chatStream 失败 耗时${((Date.now() - t0) / 1000).toFixed(1)}s:`, (e as Error).message);
    throw e;
  }
}
