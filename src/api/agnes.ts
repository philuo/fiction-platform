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
  /** 外部取消信号（"停止生成"）：abort 时终止 LLM 请求（与超时合并，不覆盖超时） */
  signal?: AbortSignal;
  /** DeepSeek 思考模式开关（OpenAI 协议 thinking:{type:...}）：enabled=开（输出思维链），disabled=关。
   *  tokenrhythm 中转实测：reasoning_effort 不透传但 thinking:{type} 生效（关闭后 reasoning_tokens=0）。
   *  不传 = 服务端默认（DeepSeek 默认开启思考）。 */
  thinking?: "enabled" | "disabled";
  /** 思考内容流式回调（delta.reasoning_content，与正文 onChunk 分离）：思考开启时收到 */
  onReasoning?: (delta: string) => void;
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

/** Fail fast when the text provider is not configured. Background jobs must settle
 * to a durable failed state instead of waiting for a network timeout. */
function ensureTextProviderConfigured(): void {
  const key = process.env.TEXT_API_KEY ?? process.env.AGNES_API_KEY ?? "";
  if (!key.trim()) throw new LLMError("未配置文本模型 API key，请在 .env 设置 TEXT_API_KEY 或 AGNES_API_KEY");
}

async function postJson(url: string, body: unknown, timeoutMs = 120_000, signal?: AbortSignal): Promise<Response> {
  // 全局文本限流（并发 + RPM）：排队不触发 429；超时在拿到槽位后才起算
  return textLimiter.run(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TEXT_API_KEY ?? process.env.AGNES_API_KEY ?? API_KEY}` },
      body: JSON.stringify(body),
      // 外部取消信号与超时合并：任一触发即中止（AbortSignal.any 需同时兼容两者）
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }),
  );
}

/** 网络层瞬时错误码（fetch 抛 TypeError：socket 断开/重置/拒绝/超时/DNS 解析等）——重试可恢复，必须重试 */
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE",
  "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "ENOTCONN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_HTTP2_STREAM_ERROR", "ERR_HTTP2_INVALID_SESSION",
]);

/** 错误是否可安全重试（瞬时故障）。
 *  - AbortError（外部取消）绝不重试——用户主动停止，重试无意义且浪费配额；
 *  - 检查 e.code / e.cause.code 网络错误码（ECONNRESET 等 fetch 底层 TypeError），命中即重试；
 *  - 其余按消息特征：HTTP 429/5xx、空内容/空输出、网络错误、超时、fetch 底层异常文本。
 *  ——修 ECONNRESET 等网络抖动一次即立项失败：retries 配置此前形同虚设（消息不含可识别模式直接抛）。 */
export function isRetryableError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return false;
  const err = e as { code?: unknown; cause?: unknown; message?: string };
  const codes = [err.code, (err.cause as { code?: unknown } | undefined)?.code];
  if (codes.some((c) => typeof c === "string" && NETWORK_ERROR_CODES.has(c))) return true;
  const msg = `${err.message ?? ""}`;
  return (
    msg.startsWith("HTTP 429") ||
    msg.startsWith("HTTP 5") ||
    msg.includes("空内容") ||
    msg.includes("空输出") ||
    msg.includes("网络错误") ||
    msg.includes("fetch failed") ||
    msg.includes("socket connection was closed") ||
    msg.includes("other side closed") ||
    msg.includes("terminated") ||
    /timeout/i.test(msg)
  );
}

/** 可感知错误的智能重试：失败可重试则按指数退避重试；
 * 任何异常（503/504/空内容/超时/网络断开）先输出诊断分析日志（HTTP 状态/finish_reason/token 用量），
 * 再常规退避重试，不修改任何请求参数（不使用 reasoning_effort）。返回最后一次错误。
 * 导出供测试直测重试接线（不依赖全局 fetch，避免并发测试文件互相污染）。 */
export async function withSmartRetry(
  doCall: (attemptOpts: AgnesOptions) => Promise<unknown>,
  opts: AgnesOptions,
  maxRetries = 4,
  /** 额外重试闸门：返回 false 时即便错误可重试也直接抛出（流式首字节已交付后用于禁止重放） */
  canRetry?: (err: unknown) => boolean,
): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await doCall(opts);
    } catch (e) {
      lastErr = e as Error;
      if (!isRetryableError(lastErr)) throw lastErr;
      // 流式首字节已交付则不再重试：前半段已通过 onChunk 发出，重试会整段重放导致重复累加
      if (canRetry && !canRetry(lastErr)) throw lastErr;
      // 诊断分析：汇总错误特征供运维定位（不改变请求参数，仅常规指数退避重试）
      const diag: string[] = [`第${attempt + 1}/${maxRetries}次尝试失败`, `err=${lastErr.message.slice(0, 120)}`];
      if (lastErr instanceof LLMError) {
        if (lastErr.finishReason) diag.push(`finish_reason=${lastErr.finishReason}`);
        if (lastErr.reasoningTokens != null || lastErr.textTokens != null) diag.push(`reasoning=${lastErr.reasoningTokens ?? "?"} text=${lastErr.textTokens ?? "?"} tokens`);
      }
      if (/HTTP 503/.test(lastErr.message)) diag.push("上游限流/渠道暂满，等待后重试");
      else if (/HTTP 504|非 JSON/.test(lastErr.message)) diag.push("上游网关超时，等待后重试（chatJson 已走流式规避）");
      else if (/空内容|空输出/.test(lastErr.message)) diag.push("模型空输出，可能输入过大或服务端异常，等待后重试");
      console.warn(`[agnes] 诊断 ${diag.join(" | ")}`);
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
  // DeepSeek 思考模式开关（OpenAI 协议）：thinking:{type:"enabled"/"disabled"}
  // 不传 thinking 时不加该字段（服务端默认策略）；显式 disabled 关闭思维链（tokenrhythm 实测生效，首字节提速 90%+）
  if (opts.thinking) payload.thinking = { type: opts.thinking };
  return postJson(`${BASE_URL}/chat/completions`, payload, opts.timeoutMs ?? 120_000, opts.signal);
}

async function parseMessage(res: Response, ctx?: { model?: string; msgChars?: number }): Promise<{ content: string; tool_calls?: ToolCall[] }> {
  // 503 = 免费额度渠道暂满（上游限流），先判状态再解析 body（503 响应体可能非 JSON）
  if (res.status === 503) {
    throw new LLMError("AI 服务繁忙（免费额度渠道暂满），请稍等片刻重试");
  }
  // 上游偶发返回非 JSON（网关错误页/截断响应）：SyntaxError 转为可重试 LLMError，避免不重试直接失败
  let data: {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
    error?: { message?: string };
  };
  try {
    data = (await res.json()) as typeof data;
  } catch (e) {
    throw new LLMError(`HTTP ${res.status} 响应非 JSON（上游异常），网络错误请重试: ${(e as Error).message.slice(0, 100)}`);
  }
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
  return postJson(`${BASE_URL}/responses`, payload, opts.timeoutMs ?? 120_000, opts.signal);
}

async function parseResponses(res: Response, ctx?: { model?: string; msgChars?: number }): Promise<{ content: string }> {
  // 503 = 免费额度渠道暂满（上游限流），先判状态再解析 body
  if (res.status === 503) {
    throw new LLMError("AI 服务繁忙（免费额度渠道暂满），请稍等片刻重试");
  }
  // 上游偶发返回非 JSON（网关错误页/截断响应）：解析失败转可重试 LLMError，避免不重试直接失败
  const data = (await res.json().catch(() => null)) as {
    status?: string;
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    error?: { message?: string } | null;
    incomplete_details?: unknown;
  } | null;
  if (data === null && res.ok) {
    throw new LLMError(`HTTP ${res.status} 响应非 JSON（上游异常），网络错误请重试`);
  }
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
  ensureTextProviderConfigured();
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

/** 读取一条 SSE 流并逐 delta 回调；流式无输出同样按可重试错误处理。
 *  onReasoning：DeepSeek 思考内容（delta.reasoning_content）回调，与正文 content 分离。
 *  导出供测试直测（避免 mock 全局 fetch 污染同进程其他测试文件）。 */
export async function readStream(res: Response, onChunk: (delta: string) => void, onReasoning?: (delta: string) => void): Promise<string> {
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new LLMError(`HTTP ${res.status}: ${data?.error?.message ?? "stream 请求失败"}`);
  }
  const full: string[] = [];
  const fullReasoning: string[] = [];
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
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string; reasoning_content?: string } }[] };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full.push(delta);
          onChunk(delta);
        }
        const reasoning = chunk.choices?.[0]?.delta?.reasoning_content;
        if (reasoning) {
          fullReasoning.push(reasoning);
          onReasoning?.(reasoning);
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
  ensureTextProviderConfigured();
  const retries = opts.retries ?? 4;
  const t0 = Date.now();
  const model = opts.model ?? MODEL;
  // H7：流式一旦交付过首字节就禁止重试——前半段已通过回调发出，重试会整段重放，
  // 导致前端重复文本、brain-chat 的 acc += delta 落库成"前半段+完整段"
  let streamStarted = false;
  const handleChunk = (delta: string) => { streamStarted = true; onChunk(delta); };
  const handleReasoning = opts.onReasoning
    ? (delta: string) => { streamStarted = true; opts.onReasoning!(delta); }
    : undefined;
  try {
    const r = (await withSmartRetry(
      (attemptOpts) => {
        const streamOpts = { ...attemptOpts, stream: true };
        return callOnce(model, messages, streamOpts).then((res) => readStream(res, handleChunk, handleReasoning));
      },
      opts,
      retries,
      () => !streamStarted,
    )) as string;
    console.log(`[agnes] chatStream 完成 耗时${((Date.now() - t0) / 1000).toFixed(1)}s model=${model} 重试上限${retries} msgChars=${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`);
    return r;
  } catch (e) {
    console.error(`[agnes] chatStream 失败 耗时${((Date.now() - t0) / 1000).toFixed(1)}s:`, (e as Error).message);
    throw e;
  }
}
