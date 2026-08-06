# AI 小说 — 功能模块规划（bun + React 19）

> 核心理念：**把小说生成做成一个"游戏会话"**，而不是一次性 prompt。
> LLM 既是作者也是"导演"：维护持续的世界状态，每个回合观察状态 → 决策 → 生成 → 更新状态 → 存档，
> 用户像玩家一样随时下达指令干预剧情。AnySearch 提供"考据/素材"增强，让 LLM 写作时能主动查真实资料。

## 技术栈（用户指定）

| 层 | 选型 |
|---|---|
| 运行时/包管理/脚本 | **bun 1.4**（bun install / bun run / Bun.serve，零 node 脚本、零 vite） |
| 前端框架 | **react 19** + react-dom（DOM / SSR 运行时） |
| 构建 | `bun build`（客户端 browser target + SSR bun target） |
| 渲染模式 | **SSR**：dev = `bun --hot` 原生热重启；prod = `bun build` + Bun.serve |
| 热更新 | dev 下 `bun --hot`：静态 import 链变化 → 自动重启进程 + 重建客户端 bundle |

### 重构要点（Solid 2.0 → React 19，2026-08 完成）
- `createSignal` → `useState`；`createEffect` → `useEffect`；`createMemo` → `useMemo`；`onCleanup` → effect cleanup
- `<For>` → `map`；`<Show>` → 三元/`&&`；`class` → `className`；style 对象转 camelCase
- SSR：`renderToString`（react-dom/server）+ `hydrateRoot`（react-dom/client），初始数据仍走 `window.__INITIAL_DATA__`
- dev 服务器：`bun --hot server/dev.ts` 启动时 `Bun.build` 打包客户端到 `dist/dev/`（无缓存头，刷新即最新）
- prod：`bun build` 产出 `dist/client`（JS+CSS 自包含，字体 base64 内联）与 `dist/server/entry-server.js`
- CSS 只在 `src/entry-client.tsx` import（SSR 端不加载 CSS，样式经 `<link>` 引用避免 FOUC）

## 外部服务（已确认接入方式）

| 服务 | 端点 | 认证 | 说明 |
|---|---|---|---|
| Agnes AI | `https://api.agnes-ai.cn/v1` | `Authorization: Bearer <key>` | OpenAI 兼容 chat/completions，`agnes-2.5-flash`（512K ctx、streaming、tool calling、免费额度，唯一模型无回退） |
| AnySearch | `https://api.anysearch.com/mcp` | `Authorization: Bearer <key>`（可选匿名） | JSON-RPC 2.0，`tools/call`；工具：`search` / `batch_search` / `extract` |

## 目录结构

```
ai-novel/
├── package.json            # 全 bun 脚本：dev / build / start
├── index.html              # 客户端模板（#root + 客户端 bundle 占位符）
├── server/
│   ├── dev.ts              # bun --hot dev：Bun.serve + SSR + API + 客户端即时构建
│   ├── prod.ts             # bun run start：Bun.serve 静态 + SSR + API
│   ├── entry-server.tsx    # SSR 入口（react-dom/server renderToString）
│   └── render.ts           # HTML 模板组装
├── src/
│   ├── entry-client.tsx    # 客户端 hydrateRoot + CSS 入口
│   ├── App.tsx             # 根组件（SSR/CSR 共用）
│   ├── api/
│   │   ├── agnes.ts        # Agnes LLM 客户端（OpenAI 兼容，重试/回退）
│   │   ├── anysearch.ts    # AnySearch JSON-RPC 客户端
│   │   └── routes.ts       # /api/* 路由处理
│   └── pages/              # 页面组件
├── data/                   # 小说存档（gitignore）
└── .env                    # 密钥（gitignore）
```

## 功能模块清单

### M1 配置与密钥管理
- [x] bun 原生 `.env` 自动加载（`AGNES_*` / `ANYSEARCH_*`），密钥不入库
- [x] `.env.example` 模板 + `.gitignore` 防护

### M2 LLM 客户端（Agnes，`src/api/agnes.ts`）
- [x] OpenAI 兼容 `chat/completions`（fetch），支持 `stream`（SSE 解析）
- [x] `complete()` 返回含 tool_calls 的完整 message → 工具循环基础已具备（叙事引擎调用留 M6）
- [x] 免费额度友好：失败重试 + 退避（仅 `agnes-2.5-flash`，无回退模型）

### M3 搜索增强（AnySearch，`src/api/anysearch.ts`）
- [x] `search`（通用 + 垂直域）/ `batch_search`（并行多查询）/ `extract`（网页正文）

### M4 API 路由（`src/api/routes.ts`）
- [x] `GET /api/health`、`POST /api/chat`（Agnes 生成）、`POST /api/chat/stream`（SSE 流式）、`POST /api/search`（AnySearch）
- [x] `POST /api/novel/*`：new（立项）/ step（SSE 回合）/ gacha（抽卡）/ state / export
- [x] SSE 流式返回生成内容（`text/event-stream`）

### M5 前端（React 19，SSR）
- [x] SSR 渲染 + 客户端 hydrate（`renderToString` + `hydrateRoot`）
- [x] **日式报纸风格**（纸/墨/线/朱印：masthead 报头、栏线、印章、竖排标签）+ 游戏化 HUD（左目录/中正文/右状态面板/底部控制条）
- [x] 状态面板：人物 / 伏笔账本 / 已抽卡牌
- [x] 抽卡弹层（卡池选择/自动抽取）+ 审查报告弹层（评分+findings+印章）
- [ ] 章节流式展示（目前阶段事件 SSE + 整章返回）

### M6 世界状态与叙事引擎（服务端，`src/api/`）
- [x] 世界状态 `WorldState`：设定 / 人物 / 时间线 / 伏笔 / 章节 / 卡牌（JSON 持久化 `data/<slug>/state.json` + .bak）
- [x] **回合循环**：抽卡 → 导演写 → 对抗审查 → 重写（≤2 次）→ 状态更新 → 存档
- [x] **对抗性审查**：独立 critic（引用原文证据 + 5 维评分 + 地板机制 coherence/tension<6 必 revise）
- [x] **伏笔账本**：planted/active/resolved 状态机，每轮注入 writer 上下文，critic 核查
- [x] **抽卡系统**：LLM 生成候选卡池（人物/事件/道具/场景/伏笔 + N/R/SR/SSR），手动选择/自动抽取，伏笔卡直接入账
- [x] 上下文压缩：设定摘要 + 人物状态 + 时间线 + 活跃伏笔 + 上节结尾（防断层）
- [x] `data/<故事名>/state.json` 断点续写（`?title=` SSR 恢复）

### M7 部署形态
- [x] prod：`bun run build`（client + ssr bundle）→ `bun run start`（Bun.serve）

## 里程碑

- **Phase 0（✅ 已完成）**：技术栈切换（bun + React 19 + SSR + bun --hot 热重启）+ dev/prod 服务器 + Agnes/AnySearch API 打通（含 SSE 流式）
- **Phase 1（✅ 已完成）**：叙事引擎（抽卡 / 对抗审查 / 伏笔账本 / 世界状态 / 存档）
- **Phase 2（✅ 基本完成）**：日式报纸风游戏化前端（HUD / 抽卡 / 审查报告 / 状态面板）
- **Phase 3**：增强（章节流式正文、流派模板、角色扮演、Web 可视化、指令输入）
- **Phase 4（✅ 已完成）**：全量重构 SolidJS 2.0 + Vite → React 19 + 纯 Bun（零 vite，bun --hot / bun build / Bun.serve）

## 技术决策

- 全 bun：bun install / bun run / Bun.serve / bun build / bun --hot，无 node 脚本、无 vite
- dev 用 `bun --hot server/dev.ts`：静态 import 链变化自动重启，启动时 `Bun.build` 打包客户端到 dist/dev
- prod 用 `bun build`（客户端 browser target + SSR bun target）+ Bun.serve，dev/prod 共用同一套 entry-server 渲染逻辑
- 密钥只放 `.env`（gitignore），代码中不出现真实密钥
- 免费额度友好：RPM 节流、失败退避重试
