// 开发服务器：bun --hot server/dev.ts
// 纯 Bun 方案（无 Vite）：
// - 热更新：bun --hot 热替换服务端模块（entry-server → 组件树 / src/api），改动即时生效
// - 客户端 bundle：进程启动时 Bun.build 输出到 dist/dev/；由于 --hot 不重跑顶层代码，
//   需额外监听 src 变化自动重建 bundle（否则浏览器拿到的仍是旧前端代码）
import { render } from "./entry-server";
import { buildHtml } from "./render";
import { handleApi, migrateLegacyOnBoot, resumeAutoSessions, startVisualSweep } from "../src/api/routes";
import { cleanupStaleAdvanceTasks } from "../src/api/advancetask";
import { loadWorld, runAsUser } from "../src/api/storage";
import { userFromRequest, getPropClosed } from "../src/api/auth";
// 仅注册到 --hot 监听图（客户端代码 / CSS 变化触发重建）；SSR 环境下无副作用（内部有 window 保护）
import "../src/entry-client";

const port = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";

if (isProd) {
  console.error("dev.ts 仅用于开发，生产请用 bun run start");
  process.exit(1);
}

// 构建客户端 bundle（浏览器 target：JS + CSS + 字体资源）
async function buildClient(): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: ["./src/entry-client.tsx"],
    outdir: "./dist/dev",
    target: "browser",
    minify: false,
    sourcemap: "inline",
  });
  if (!result.success) {
    console.error("[dev] 客户端构建失败:", result.logs);
    throw new Error("客户端构建失败");
  }
  return result.outputs.map((o) => o.path?.split("/").pop()).filter((x): x is string => !!x);
}

let devOutputs: string[];
try {
  devOutputs = await buildClient();
} catch {
  process.exit(1);
}
console.log("[dev] 客户端 bundle:", devOutputs.join(", "));

// 客户端 bundle 自动重建：bun --hot 只热替换服务端模块、不重跑顶层 Bun.build，
// 因此监听 src 变化（组件/CSS/共享模块）防抖重建，保证浏览器刷新即拿到最新前端代码
import { watch } from "node:fs";
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(async () => {
    try {
      const outs = await buildClient();
      console.log("[dev] 客户端 bundle 已重建（src 变更）:", outs.join(", "));
    } catch (e) {
      console.error("[dev] 客户端重建失败，等待下次变更重试:", e);
    }
  }, 300);
}
const srcWatcher = watch("src", { recursive: true }, () => scheduleRebuild());
// 进程退出时清理监听（--hot 热替换本模块时不触发；Ctrl+C 正常退出）
process.on("exit", () => {
  try { srcWatcher.close(); } catch { /* 忽略 */ }
});

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
  // idleTimeout：默认 10s 会切断 SSE 长连接（写+审+记账可达数分钟）；设 255s（Bun 允许最大值），配合 sseStream 8s 心跳保活
  idleTimeout: 255,
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
      const chapterParam = url.searchParams.get("chapter");
      if (chapterParam) initialData.chapter = Number(chapterParam); // 刷新恢复选中章节
      // 账号：按会话 cookie 注入登录用户；已登录才按用户加载世界数据（账号隔离，未登录不读任何书）
      const user = userFromRequest(req);
      if (user) {
        initialData.user = { id: user.id, username: user.username, displayName: user.displayName };
        runAsUser(user.username, () => {
          if (title) initialData.world = loadWorld(title) ?? undefined;
          if (title) initialData.propClosed = getPropClosed(user.id, title);
        });
      }
      const appHtml = render(pathname + url.search, initialData);
      const html = buildHtml(appHtml, {
        clientJs: "/dev/entry-client.js",
        clientCss: "/dev/entry-client.css",
        initialData,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
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

console.log(`[dev] 墨枢 SSR 服务器: http://localhost:${port}（bun --hot 热重启，Ctrl+C 停止）`);

// 服务重启恢复：未被人工停止的自动连载会话自动续跑（bun --hot 重启 / 手动重启均生效；不阻塞启动）
setTimeout(() => {
  // 旧数据兜底迁移：data/ 根遗留书目录迁给第一个注册用户（首用户认领语义，幂等）
  try {
    migrateLegacyOnBoot();
  } catch (e) {
    console.error("[dev] 旧数据迁移失败:", e);
  }
  try {
    resumeAutoSessions();
  } catch (e) {
    console.error("[dev] 连载会话恢复失败:", e);
  }
  // 中枢视觉巡检：周期扫描所有故事角色，头像/立绘缺失自动补全（1 分钟冷却兜底防烧配额）
  try {
    startVisualSweep();
  } catch (e) {
    console.error("[dev] 中枢视觉巡检启动失败:", e);
  }
  // 单章推进任务：清理陈旧 running（服务重启中断，无执行上下文不自动续跑，标记 failed 让前端可见）
  try {
    cleanupStaleAdvanceTasks();
  } catch (e) {
    console.error("[dev] 推进任务清理失败:", e);
  }
}, 0);
