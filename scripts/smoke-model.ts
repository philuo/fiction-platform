// 冒烟测试：验证 TEXT_* 配置端点下 chat/chatStream 真实可用（运行：bun scripts/smoke-model.ts）
// 用法：切换 TEXT_* 后先跑本脚本确认端点可用，再跑完整管线
import { chat, chatStream } from "../src/api/agnes.ts";

const msgs = [{ role: "user" as const, content: "用一句话介绍你自己。" }];

// 1) chat（非流式）
const r1 = await chat(msgs, { temperature: 0.5, retries: 1 });
console.log("[chat] 返回长度:", r1.length, "| 前80字:", r1.slice(0, 80).replace(/\n/g, " "));
if (!r1.trim()) throw new Error("chat 返回空内容");

// 2) chatStream（写手主路径：SSE 流式）
let chunks = 0;
const r2 = await chatStream(msgs, () => { chunks++; }, { temperature: 0.5, retries: 1 });
console.log("[chatStream] chunks:", chunks, "| 长度:", r2.length, "| 前80字:", r2.slice(0, 80).replace(/\n/g, " "));
if (!r2.trim() || chunks < 1) throw new Error("chatStream 返回空或无增量");

console.log("SMOKE OK");
