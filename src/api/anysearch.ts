// AnySearch 客户端：单一 JSON-RPC 2.0 端点（https://api.anysearch.com/mcp）
// 工具：search / batch_search / extract / get_sub_domains

const ENDPOINT = process.env.ANYSEARCH_ENDPOINT ?? "https://api.anysearch.com/mcp";
const API_KEY = process.env.ANYSEARCH_API_KEY ?? "";
const CLIENT_HEADER = "ai-novel/0.1";

export class AnySearchError extends Error {}

export type SearchArgs = {
  query: string;
  max_results?: number;
  domain?: string;
  sub_domain?: string;
  sub_domain_params?: Record<string, unknown>;
};

export type BatchQuery = {
  query: string;
  max_results?: number;
  domain?: string;
  sub_domain?: string;
  sub_domain_params?: Record<string, unknown>;
};

async function call(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<string> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Anysearch-Client": CLIENT_HEADER,
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AnySearchError(`网络错误: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    result?: { content?: { type: string; text?: string }[] };
  } | null;
  if (!res.ok || data?.error) {
    throw new AnySearchError(`HTTP ${res.status}: ${data?.error?.message ?? "请求失败"}`);
  }
  for (const item of data?.result?.content ?? []) {
    if (item.type === "text" && item.text) return item.text;
  }
  return JSON.stringify(data?.result ?? {}, null, 2);
}

export async function search(args: SearchArgs): Promise<string> {
  const a: Record<string, unknown> = {
    query: args.query,
    max_results: Math.max(1, Math.min(args.max_results ?? 5, 10)),
  };
  if (args.domain) a.domain = args.domain;
  if (args.sub_domain) a.sub_domain = args.sub_domain;
  if (args.sub_domain_params) a.sub_domain_params = args.sub_domain_params;
  return call("search", a);
}

export async function batchSearch(queries: BatchQuery[]): Promise<string> {
  return call("batch_search", { queries });
}

export async function extract(url: string): Promise<string> {
  return call("extract", { url });
}
