// 共享 HTML 组装：dev（bun --hot）与 prod（Bun.serve）共用
import { readFileSync } from "node:fs";

const template = readFileSync("index.html", "utf-8");

/** 组装最终 HTML：模板 + 服务端渲染内容 + 客户端 bundle 引用 + 初始数据 */
export function buildHtml(appHtml: string, opts: { clientJs: string; clientCss: string; initialData: Record<string, unknown> }): string {
  let html = template;
  html = html.replace("<!--app-html-->", () => appHtml);
  html = html.replace("{{CLIENT_JS}}", opts.clientJs);
  html = html.replace("{{CLIENT_CSS}}", opts.clientCss);
  // 客户端初始数据：SSR 与客户端初始状态必须一致（否则 hydration 冲突）
  html = html.replace(
    "</head>",
    `<script>window.__INITIAL_DATA__ = ${JSON.stringify(opts.initialData).replace(/</g, "\\u003c")}</script></head>`,
  );
  return html;
}
