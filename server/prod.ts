// 生产服务器：bun run start（先 bun run build 生成 dist/）
// 纯 Bun.serve：静态资源（dist/client）+ API + SSR（bun build 的 server bundle）
import { handleApi, migrateLegacyOnBoot, resumeAutoSessions, startVisualSweep } from "../src/api/routes";
import { handleSyncUpgrade, syncWebsocket, attachSyncPublish } from "../src/api/sync-server";
import { cleanupStaleAdvanceTasks } from "../src/api/advancetask";
import { cleanupNewStoryTasks } from "../src/api/newtask";
import { loadWorld, runAsUser } from "../src/api/storage";
import { userFromRequest, getPropClosed } from "../src/api/auth";
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

const server = Bun.serve({
  hostname: "0.0.0.0", // 监听所有网卡（局域网/容器可访问）
  port,
  // idleTimeout：默认 10s 会切断 SSE 长连接（写+审+记账可达数分钟）；设 255s（Bun 允许最大值），配合 sseStream 8s 心跳保活
  idleTimeout: 255,
  websocket: syncWebsocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // WS 升级优先（独立路径，不落入 handleApi）
    const syncUp = handleSyncUpgrade(pathname, req, server);
    if (syncUp !== null) return syncUp;

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
      const appHtml = serverEntry.render(pathname + url.search, initialData);
      const html = buildHtml(appHtml, {
        clientJs: "/assets/entry-client.js",
        clientCss: "/assets/entry-client.css",
        initialData,
      });
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
      });
    } catch (e) {
      console.error("[prod] SSR 错误:", e);
      return new Response("页面渲染失败，请查看服务端日志", { status: 500 });
    }
  },
});

// 状态同步事件 → WS 广播（把事件总线接上本服务器实例的 pub-sub）
attachSyncPublish(server);

console.log(`[prod] 墨枢 SSR 服务器: http://localhost:${port}`);

// 服务重启恢复：未被人工停止的自动连载会话自动续跑（不阻塞启动，失败仅记日志）
setTimeout(() => {
  // 旧数据兜底迁移：data/ 根遗留书目录迁给第一个注册用户（首用户认领语义，幂等）
  try {
    migrateLegacyOnBoot();
  } catch (e) {
    console.error("[prod] 旧数据迁移失败:", e);
  }
  try {
    resumeAutoSessions();
  } catch (e) {
    console.error("[prod] 连载会话恢复失败:", e);
  }
  // 中枢视觉巡检：周期扫描所有故事角色，头像/立绘缺失自动补全（1 分钟冷却兜底防烧配额）
  try {
    startVisualSweep();
  } catch (e) {
    console.error("[prod] 中枢视觉巡检启动失败:", e);
  }
  // 单章推进任务：清理陈旧 running（服务重启中断，无执行上下文不自动续跑，标记 failed 让前端可见）
  try {
    cleanupStaleAdvanceTasks();
  } catch (e) {
    console.error("[prod] 推进任务清理失败:", e);
  }
  // 异步立项任务：running/ready 一律标 failed（服务重启后台执行已死，保留会让前端占位卡/「世界构建中」永久 loading），终态超期清理
  try {
    cleanupNewStoryTasks();
  } catch (e) {
    console.error("[prod] 立项任务清理失败:", e);
  }
}, 0);
