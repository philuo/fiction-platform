// 用 happy-dom 模拟浏览器加载页面，捕获客户端运行时错误
import { Window } from "happy-dom";

const window = new Window();
const document = window.document;

// 捕获所有错误
const errors: string[] = [];
window.console.error = (...args: unknown[]) => {
  errors.push("console.error: " + args.map(String).join(" "));
};
window.addEventListener("error", (e: ErrorEvent) => {
  errors.push("window.error: " + e.message + (e.error ? "\n" + (e.error as Error).stack : ""));
});
window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  errors.push("unhandledrejection: " + String(e.reason));
});

// 设置全局
(globalThis as Record<string, unknown>).window = window;
(globalThis as Record<string, unknown>).document = document;
(globalThis as Record<string, unknown>).navigator = window.navigator;
(globalThis as Record<string, unknown>).location = window.location;

// 抓取 SSR HTML 并注入 happy-dom
const res = await fetch("http://127.0.0.1:3000/?title=缄梦录");
const html = await res.text();

// 解析 HTML
document.write(html);
await window.happyDOM.waitUntilComplete();

// 尝试加载并执行客户端 JS
const jsRes = await fetch("http://127.0.0.1:3000/dev/entry-client.js");
const jsCode = await jsRes.text();

// 模拟 window.__INITIAL_DATA__
const initDataMatch = html.match(/__INITIAL_DATA__\s*=\s*({[^<]+)/);
if (initDataMatch) {
  console.log("Found __INITIAL_DATA__");
}

// 执行客户端 JS
try {
  // 用 Function 构造器在 window 上下文执行
  const fn = new Function("window", "document", "navigator", "location", "self", "globalThis", jsCode);
  fn(window, document, window.navigator, window.location, window, globalThis);
  console.log("Client JS executed successfully");
} catch (e) {
  errors.push("JS execution error: " + (e as Error).message + "\n" + (e as Error).stack);
}

// 等待异步
await new Promise((r) => setTimeout(r, 2000));

console.log("\n=== ERRORS CAPTURED (" + errors.length + ") ===");
for (const err of errors) {
  console.log(err);
  console.log("---");
}
if (errors.length === 0) {
  console.log("No errors captured");
}

window.happyDOM.close();
