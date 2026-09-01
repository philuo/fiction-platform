<div align="center">

# 🎴 墨枢 Moshi

**像玩游戏一样写小说 —— LLM 担任导演的智能故事创作引擎**

LLM「导演」持续维护世界观 / 人物 / 时间线 / 伏笔,每个回合
观察状态 → 决策 → 生成正文 → 更新状态 → 存档;
独立「审查者」与导演对抗把关,AnySearch 提供实时考据。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg?style=for-the-badge)](../../releases)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.4-FBF0DF.svg?style=for-the-badge&logo=bun&logoColor=black)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-75%20files-2EA043.svg?style=for-the-badge)](#-开发)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff6c60.svg?style=for-the-badge)](#-贡献)

[快速开始](#-快速开始) · [特性](#-特性) · [核心玩法](#-核心玩法) · [API](#api) · [Roadmap](#-roadmap) · [English](./README.en.md)

</div>

---

## ✨ 特性

- 🎴 **抽卡式创作** — LLM 按当前世界状态生成候选卡池(人物 / 事件 / 道具 / 场景 / 伏笔卡,稀有度 N/R/SR/SSR),手动挑选或自动抽取;伏笔卡直接登记入伏笔账本
- ⚔️ **AI 写、AI 审(对抗性审查)** — 导演与审查者是两个独立角色,合作会产生谄媚,必须对垒:审查必须引用原文证据,5 维评分(连贯 / 张力 / 文笔 / 节奏 / 对话),coherence 或 tension < 6 分强制驳回重写(≤ 2 次)
- 🧵 **伏笔记忆不断层** — 伏笔账本状态机(埋设 → 呼应 → 回收)每轮注入导演上下文;上下文压缩(设定摘要 + 人物状态 + 时间线 + 活跃伏笔 + 上节结尾)保证长篇一致
- 🧠 **中枢 Brain** — 报头常驻「中枢之眼·印灵」指示器,由四维状态驱动(存在态 / 动作态 / 治理裁决态 / 全书健康脉象),零 LLM 确定性派生
- 💬 **对话舱自然语言控制** — 与中枢聊天即可触发全部 16 类操作(推进 / 连载 / 抽卡 / 编辑 / 删章 / 导出…),supervised 半自动:L0/L1 直接执行,L2/L3 出确认卡三选一
- 🔍 **实时考据** — AnySearch 搜索增强,写作中随查随引
- 🖼 **插画与视频生成** — Agnes 多模态,同一 Key 免费额度,自动限流排队
- 📰 **日式报纸 × 游戏 HUD 界面** — 纸色 / 衬线 / 报头双线 / 朱印 / 竖排标签,配左目录、中正文、右状态面板、底部控制条
- ⚡ **全 Bun 技术栈** — 零 Node 脚本、零 Vite:React 19 SSR(`renderToString` + `hydrateRoot`),dev 用 `bun --hot`,prod 用 `bun build` + `Bun.serve`

## 🎮 核心玩法

人在界面上的操作极小:**立项一句话 → 推进剧情 → 抽卡筛选 → 看审查报告**,其余全部由 AI 完成。

```text
[抽卡] → [导演写一节] → [独立审查者对抗审查] → [伏笔/状态更新] → [存档]
              ↑                    │
              └──── 不通过 → 带着指摘意见重写(≤2 次)────┘
```

每一回合,引擎像跑一场游戏对局:

| 阶段 | 做什么 |
|---|---|
| 🎴 抽卡 | 生成候选卡池注入下一节写作指令;伏笔卡入账本 |
| ✍️ 写作 | 导演依据世界状态 + 活跃伏笔 + 上节结尾生成正文 |
| 🛡 审查 | 独立审查者按 5 维评分 + 原文证据裁决,地板机制强制驳回 |
| 📖 记账 | 伏笔状态机推进、人物状态与时间线更新、上下文压缩 |
| 💾 存档 | `data/<title>/state.json` 落盘,随时恢复与导出 |

## 🚀 快速开始

```bash
git clone https://github.com/philuo/fiction-platform.git
cd fiction-platform
cp .env.example .env    # 填入你的 API Key(至少 AGNES_API_KEY)
bun install
bun run dev             # 开发服务器 http://localhost:3000(bun --hot 热重启)
```

生产模式:

```bash
bun run build           # 产出 dist/client + dist/server
bun run start           # 生产服务器 http://localhost:3000(Bun.serve)
```

> 需要 [Bun](https://bun.sh) ≥ 1.4。`.env` 与 `data/` 已被 gitignore,密钥不会进入代码与 git;`data/` 目录由服务端自动创建。

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `AGNES_API_KEY` | ✅ | [Agnes AI](https://agnes-ai.cn) 密钥(OpenAI 兼容,有免费额度),文本 / 插画 / 视频共用 |
| `AGNES_BASE_URL` | — | 默认 `https://api.agnes-ai.cn/v1` |
| `AGNES_MODEL` | — | 默认 `agnes-2.5-flash` |
| `TEXT_BASE_URL` / `TEXT_API_KEY` / `TEXT_MODEL` | 可选 | 配置后中枢 / 写手 / 审查 / 记账等全部文本任务改走该 OpenAI 兼容端点;插画 / 视频仍固定使用 Agnes |
| `ANYSEARCH_API_KEY` | 可选 | [AnySearch](https://anysearch.com) 实时搜索(考据增强),可匿名 |
| `AGNES_*_CONCURRENCY` / `AGNES_*_RPM` | 可选 | 文本 / 图片 / 视频分模型限流,限流器排队、不主动触发 429 |

恢复已存故事:`http://localhost:3000/?title=断梦录` · 导出全书:`GET /api/novel/export?title=`

## API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 服务健康 + 密钥就绪状态 |
| `POST /api/chat` / `POST /api/chat/stream` | Agnes 生成 / SSE 流式生成 |
| `POST /api/search` | AnySearch 实时搜索(考据增强) |
| `POST /api/novel/new` | 立项:一句话灵感 → 世界设定 + 人物(LLM) |
| `POST /api/novel/step` | 回合:写 → 审 → 重写 → 存档(SSE 阶段事件) |
| `POST /api/novel/gacha` | 抽卡:生成卡池 / 自动抽取 / 指定抽取 |
| `POST /api/novel/state` | 世界状态(响应附带 `brainState` 中枢四维状态) |
| `POST /api/brain/state` | 中枢四维状态(presence / activity / governance / vitals) |
| `POST /api/brain/chat` | 中枢对话编排(SSE):意图识别 → 回复 + 卡片 |
| `GET /api/novel/export?title=` | 导出全书 Markdown |

## 🗂 目录结构

```
server/                dev / prod 服务器 + SSR 入口 + HTML 模板组装
src/api/               导演、写作、审查、抽卡、世界状态、LLM 客户端
src/contracts/         跨端契约(命令、世界、sync、认证)
src/application/       用例与端口
src/infrastructure/    SQLite、存档和 provider 适配
src/transport/         HTTP、SSE、WS 传输层
src/components/        报头 / 状态面板 / 正文 / 审查报告 / 抽卡 / 中枢对话舱
src/frontend/          前端功能迁移目录
data/                  小说存档(gitignore,运行时生成)
docs/                  开发规范、中枢协议、命令注册表等文档
```

## 🛠 开发

```bash
bun run check          # 架构检查 + 类型检查 + 测试 + 构建一条龙
bun test               # 75 个测试文件,覆盖叙事引擎 / 中枢 / 传输层
bun run check:architecture   # 仅分层架构检查
```

深入文档:

- **[docs/INSTRUCTION.md](docs/INSTRUCTION.md)** — 开发规范、模块边界、状态源和验收清单
- **[docs/BRAIN.md](docs/BRAIN.md)** — 中枢与 sync 协议详解
- **[docs/HARNESS.md](docs/HARNESS.md)** — 命令注册表、治理级别和恢复语义

> `src/api/routes.ts`、`src/pages/Home.tsx`、`src/components/` 是兼容入口和迁移中的旧实现;新增代码应按 `docs/INSTRUCTION.md` 归属到目标层。

## 🗺 Roadmap

- ✅ **Phase 0** — 技术栈 + SSR 骨架 + dev/prod + API 打通
- ✅ **Phase 1** — 叙事引擎(回合循环 / 世界状态 / 存档)
- ✅ **Phase 2** — 日式报纸游戏化界面(抽卡 / 对抗审查 / 伏笔账本)
- ✅ **Phase 3** — 增强(参数系统 / 世界书 / 弧线 / 图像 / 版本 / 脉络 / 流派模板)
- 🔜 下一阶段规划中,欢迎提 [Issue](../../issues) 讨论

## 🤝 贡献

欢迎 Issue 与 PR!提交前请跑 `bun run check` 确保架构检查、类型、测试与构建全绿。

## 📄 License

[MIT](./LICENSE) © 2025 Perfumere (philuo)
