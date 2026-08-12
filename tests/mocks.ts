// Mock LLM 测试基建（P0/J2）：用 bun:test 的 mock.module 替换 agnes 客户端。
// 使用方式：测试文件在 import 任何 src/api 模块【之前】调用 installMockAgnes(responder)，
// responder 按 messages 内容返回脚本化文本（通常为 JSON 字符串）。
import { mock } from "bun:test";

export type ChatMessage = { role: string; content: string };
export type AgnesResponder = (messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) => string;

/** 替换 ../src/api/agnes 模块；必须在被测模块加载前调用 */
export function installMockAgnes(responder: AgnesResponder): void {
  mock.module("../src/api/agnes", () => {
    class LLMError extends Error {}
    return {
      LLMError,
      isRetryableError: () => false,
      withSmartRetry: async <T>(fn: () => Promise<T>) => fn(),
      chat: async (messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) => responder(messages, opts),
      complete: async (messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) => ({ content: responder(messages, opts) }),
      chatStream: async (messages: ChatMessage[], onChunk: (d: string) => void, opts?: { temperature?: number; maxTokens?: number }) => {
        const full = responder(messages, opts);
        // 分段回调，验证流式拼接
        for (let i = 0; i < full.length; i += 64) onChunk(full.slice(i, i + 64));
        return full;
      },
      readStream: async () => "",
    };
  });
}

/** 关键词路由助手：按 system/user 消息中的关键词选择脚本响应（找不到返回 fallback） */
export function routeByKeyword(routes: Record<string, string>, fallback = "{}"): AgnesResponder {
  return (messages) => {
    const all = messages.map((m) => m.content).join("\n");
    for (const [kw, resp] of Object.entries(routes)) {
      if (all.includes(kw)) return resp;
    }
    return fallback;
  };
}
