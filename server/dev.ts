// 开发服务器：bun --hot server/dev.ts
// 纯 Bun 方案（无 Vite）：
// - 热重启：bun --hot 监听本文件的静态 import 链（entry-server → 组件树 / src/api），
//   代码改动 → 自动重启进程 → 服务端渲染与客户端 bundle 均为最新
// - 客户端 bundle：进程启动时 Bun.build 输出到 dist/dev/（无缓存头，刷新即最新）
import { render } from "./entry-server";
import { buildHtml } from "./render";
import { handleApi } from "../src/api/routes";
import { loadWorld } from "../src/api/storage";
// 仅注册到 --hot 监听图（客户端代码 / CSS 变化触发重建）；SSR 环境下无副作用（内部有 window 保护）
import "../src/entry-client";

const port = Number(process.env.PORT) || 5173;
const isProd = process.env.NODE_ENV === "production";

if (isProd) {
  console.error("dev.ts 仅用于开发，生产请用 bun run start");
  process.exit(1);
}

// 构建客户端 bundle（浏览器 target：JS + CSS + 字体资源）
const buildResult = await Bun.build({
  entrypoints: ["./src/entry-client.tsx"],
  outdir: "./dist/dev",
  target: "browser",
  minify: false,
  sourcemap: "inline",
});
if (!buildResult.success) {
  console.error("[dev] 客户端构建失败:", buildResult.logs);
  process.exit(1);
}
const devOutputs = buildResult.outputs.map((o) => o.path.split("/").pop());
console.log("[dev] 客户端 bundle:", devOutputs.join(", "));

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

Bun.serve({
  hostname: "127.0.0.1", // 仅本机访问：避免 API 无认证暴露到局域网
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // API 路由优先
    const apiRes = await handleApi(pathname, req);
    if (apiRes) return apiRes;

    // 客户端 bundle 静态资源（dist/dev/）
    if (pathname.startsWith("/dev/")) {
      const file = Bun.file("dist/dev" + pathname.slice("/dev".length));
      if (await file.exists()) {
        const ext = pathname.slice(pathname.lastIndexOf("."));
        return new Response(file, {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            // dev 不缓存：bun --hot 重启后 bundle 更新，浏览器刷新即拿最新
            "Cache-Control": "no-cache",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }

    // 页面 SSR
    try {
      const initialData: Record<string, unknown> = { serverTime: new Date().toISOString(), ssr: true };
      const title = url.searchParams.get("title");
      if (title) initialData.world = loadWorld(title) ?? undefined;
      const appHtml = render(pathname + url.search, initialData);
      const html = buildHtml(appHtml, {
        clientJs: "/dev/entry-client.js",
        clientCss: "/dev/entry-client.css",
        initialData,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" },
      });
    } catch (e) {
      console.error("[dev] SSR 错误:", e);
      return new Response("SSR 错误: " + (e as Error).message, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
});

console.log(`[dev] AI 小说 SSR 服务器: http://localhost:${port}（bun --hot 热重启，Ctrl+C 停止）`);
