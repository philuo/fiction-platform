// Mock LLM 测试基建（P0/J2）：只 override Agnes 模型调用，保留解析与重试真实实现。
// 使用方式：测试文件调用 installMockAgnes(responder)，
// responder 按 messages 内容返回脚本化文本（通常为 JSON 字符串）。
import { afterAll } from "bun:test";
import { setAgnesTestOverride } from "../src/api/agnes";

export type ChatMessage = { role: string; content: string };
export type AgnesResponder = (messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) => string;

afterAll(() => setAgnesTestOverride(null));

/** 注入模型调用；保留 agnes 的 SSE 解析、错误分类与重试实现，避免跨文件 mock.module 污染。 */
export function installMockAgnes(responder: AgnesResponder): void {
  setAgnesTestOverride({
    chat: async (messages, opts) => responder(messages, opts),
    complete: async (messages, opts) => ({ content: responder(messages, opts) }),
    chatStream: async (messages, onChunk, opts) => {
      const full = responder(messages, opts);
      for (let i = 0; i < full.length; i += 64) onChunk(full.slice(i, i + 64));
      return full;
    },
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
