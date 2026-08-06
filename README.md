# 墨枢 — 故事创作引擎

像玩游戏一样智能生成小说：LLM（Agnes AI）担任"导演"，持续维护世界观 / 人物 / 时间线 / 伏笔，
每个回合观察状态 → 决策 → 生成正文 → 更新状态 → 存档；AnySearch 提供实时考据搜索增强。

## 技术栈

- **bun 1.4**（runtime / 包管理 / 脚本 / 开发服务器，零 node 脚本、零 vite）
- **react 19 + react-dom**（DOM / SSR 运行时，`renderToString` + `hydrateRoot`）
- **SSR**：dev 用 `bun --hot`（原生热重启，改代码即生效）；prod 用 `bun build` 打包 + **Bun.serve**

## 快速开始

```bash
bun install          # 安装依赖（缓存已配置到 .bun-cache，避开 ~/.bun TCC 限制）
bun run dev          # 开发服务器 http://localhost:5173（bun --hot 热重启）
bun run build        # 生产构建（dist/client + dist/server）
bun run start        # 生产服务器 http://localhost:3000（Bun.serve）
```

## 环境变量（.env，已 gitignore）

```
# 文本模型（中枢/写手/审查/记账等，可整体切换；端点须 OpenAI 兼容）
TEXT_BASE_URL=https://tokenrhythm.studio/v1
TEXT_API_KEY=sk_tr_...
TEXT_MODEL=deepseek-v4-flash-0731
# 未配置 TEXT_* 时回落以下 Agnes 配置（插画/视频固定使用）
AGNES_API_KEY=sk-...            # Agnes AI（https://agnes-ai.cn，免费额度）
AGNES_BASE_URL=https://api.agnes-ai.cn/v1
AGNES_MODEL=agnes-2.5-flash
ANYSEARCH_API_KEY=as_sk_...     # AnySearch（https://anysearch.com，可匿名）
```

bun 会自动加载项目根 `.env`。密钥不进入代码 / git。

## 核心玩法（游戏化创作闭环）

```
[抽卡] → [导演写一节] → [独立审查者对抗审查] → [伏笔/状态更新] → [存档]
              ↑                    │
              └──── 不通过 → 带着指摘意见重写（≤2 次）────┘
```

- **抽卡模式**：LLM 按当前世界状态生成候选卡池（人物/事件/道具/场景/伏笔卡，稀有度 N/R/SR/SSR），
  可手动选择或自动抽取；伏笔卡直接登记入伏笔账本，其余卡注入下一节写作指令
- **AI 写、AI 审（对抗性审查）**：导演（Writer）与审查者（Critic）是两个独立角色（参考 agent-writing：
  合作产生谄媚，必须对垒）。审查必须引用原文证据，5 维评分（连贯/张力/文笔/节奏/对话），
  地板机制：coherence 或 tension < 6 分强制驳回重写
- **伏笔记忆不断层**：伏笔账本状态机（埋设→呼应→回收），每轮注入导演上下文；
  上下文压缩（设定摘要+人物状态+时间线+活跃伏笔+上节结尾）保证长文一致

## API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 服务健康 + 密钥就绪状态 |
| `POST /api/chat` | Agnes 生成（`{prompt}` → `{text}`） |
| `POST /api/chat/stream` | SSE 流式生成 |
| `POST /api/search` | AnySearch 实时搜索（考据增强） |
| `POST /api/novel/new` | 立项：一句话灵感 → 世界设定 + 人物（LLM） |
| `POST /api/novel/step` | 回合：写→审→重写→存档（SSE 阶段事件） |
| `POST /api/novel/gacha` | 抽卡：生成卡池 / 自动抽取 / 指定抽取 |
| `POST /api/novel/state` | 世界状态 |
| `GET /api/novel/export?title=` | 导出全书 Markdown |

## 界面

日式报纸风格（纸色/衬线/报头双线/朱印/竖排标签）+ 游戏 HUD（左目录/中正文/右状态面板/底部控制条）。
人在界面上的操作极小：立项一句话 → [推进剧情] → 抽卡筛选 → 看审查报告；其余全部由 AI 完成。
恢复已存故事：`http://localhost:5173/?title=断梦录`

## 目录结构

```
server/dev.ts          开发服务器（bun --hot + Bun.serve + SSR，无 vite）
server/prod.ts         生产服务器（Bun.serve）
server/entry-server.tsx  SSR 入口（dev/prod 共用，react-dom/server）
server/render.ts       HTML 模板组装（SSR 注入 + 初始数据）
src/entry-client.tsx   客户端 hydrate（hydrateRoot）+ CSS 入口
src/App.tsx            根组件
src/pages/Home.tsx     启动页 + 游戏界面
src/components/        报头/状态面板/正文/审查报告/抽卡/印章
src/styles/newspaper.css  日式报纸风格
src/api/agnes.ts       Agnes LLM 客户端（streaming / tool calling / 重试回退）
src/api/anysearch.ts   AnySearch JSON-RPC 客户端
src/api/world.ts       世界状态类型 + 摘要压缩
src/api/writer.ts      导演（写作，结构化伏笔/人物输出）
src/api/critic.ts      审查者（对抗审查，evidence + 地板机制）
src/api/cards.ts       抽卡系统
src/api/director.ts    回合编排
src/api/routes.ts      /api/* 路由
data/                  小说存档（state.json + .bak）
docs/ENGINE.md         引擎设计
```

## 已知环境注意

- `~/.bun` 被 macOS TCC 保护不可写 → bun 缓存通过 `bunfig.toml [install.cache].dir` 指向 `.bun-cache`
- dev 使用 `bun --hot`：进程启动时 `Bun.build` 打包客户端（dist/dev/，无缓存头），代码改动自动重启并重建
- 客户端 CSS 由 `bun build` 打包（字体 base64 内联，自包含）；SSR 端不 import CSS，样式经 `<link>` 加载避免 FOUC

## 路线

- Phase 0 ✅ 技术栈 + SSR 骨架 + dev/prod + API 打通
- Phase 1 ✅ 叙事引擎（回合循环 / 世界状态 / 存档）
- Phase 2 ✅ 日式报纸游戏化界面（抽卡 / 对抗审查 / 伏笔账本）
- Phase 3 ✅ 增强（参数系统/世界书/弧线/图像/版本/脉络/流派模板）
- 详见 [PLAN.md](PLAN.md)

## 文档索引（后续 AI 迭代必读）

- **[docs/FEATURES.md](docs/FEATURES.md)** — 功能全记录（架构/模块/API/数据模型/限制/迭代建议）
- **[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)** — 详细需求计划表（M1-M8 + 参数字段 + 验收）
- **[docs/ENGINE.md](docs/ENGINE.md)** — 引擎设计（回合循环/抽卡/伏笔/上下文压缩）
