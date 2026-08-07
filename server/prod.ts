// 生产服务器：bun run start（先 bun run build 生成 dist/）
// 纯 Bun.serve：静态资源（dist/client）+ API + SSR（bun build 的 server bundle）
import { handleApi, resumeAutoSessions } from "../src/api/routes";
import { loadWorld } from "../src/api/storage";
import { buildHtml } from "./render";

const port = Number(process.env.PORT) || 3000;
const clientDir = process.cwd() + "/dist/client";

// 加载 SSR 入口（bun build ./server/entry-server.tsx 的产物）
// 用 URL 动态导入：避免 TS 对构建产物的静态解析（dist 在 build 后生成）
const entryUrl = new URL("../dist/server/entry-server.js", import.meta.url).href;
const serverEntry = (await import(entryUrl)) as {
  render: (url: string, initialData?: unknown) => string;
};

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
  hostname: "0.0.0.0", // 监听所有网卡（局域网/容器可访问）
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // API 路由
    const apiRes = await handleApi(pathname, req);
    if (apiRes) return apiRes;

    // 静态资源（dist/client/ 下的 hashed/普通产物：JS / CSS / 字体）
    if (pathname.startsWith("/assets/")) {
      const file = Bun.file(clientDir + pathname.slice("/assets".length));
      if (await file.exists()) {
        const ext = pathname.slice(pathname.lastIndexOf("."));
        return new Response(file, {
          headers: {
            "Content-Type": MIME[ext] ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
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
      const chapterParam = url.searchParams.get("chapter");
      if (chapterParam) initialData.chapter = Number(chapterParam); // 刷新恢复选中章节
      const appHtml = serverEntry.render(pathname + url.search, initialData);
      const html = buildHtml(appHtml, {
        clientJs: "/assets/entry-client.js",
        clientCss: "/assets/entry-client.css",
        initialData,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" },
      });
    } catch (e) {
      console.error("[prod] SSR 错误:", e);
      return new Response("页面渲染失败，请查看服务端日志", { status: 500 });
    }
  },
});

console.log(`[prod] 墨枢 SSR 服务器: http://localhost:${port}`);

// 服务重启恢复：未被人工停止的自动连载会话自动续跑（不阻塞启动，失败仅记日志）
setTimeout(() => {
  try {
    resumeAutoSessions();
  } catch (e) {
    console.error("[prod] 连载会话恢复失败:", e);
  }
}, 0);
