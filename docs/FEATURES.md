# AI 小说 — 功能全记录（供后续 AI 迭代参考）

> 本文档是项目的**权威功能清单与架构说明**。后续任何 AI 迭代前先读本文件 + `docs/REQUIREMENTS.md`（需求计划表）+ `docs/ENGINE.md`（引擎设计），
> 并在改动后更新本文件。最后更新：2026-08-02。

---

## 1. 技术栈与运行

| 项 | 值 |
|---|---|
| 运行时/包管理 | **bun 1.4**（零 node 脚本；`bun install` / `bun run` / Bun.serve） |
| 前端框架 | **solid-js 2.0.0-beta** + `@solidjs/web`（DOM/SSR 运行时拆分包） |
| 构建 | **vite 8** + `vite-plugin-solid@3.0.0-next` |
| 渲染 | **SSR**：dev = Vite dev server（HMR）；prod = `vite build --ssr` + Bun.serve |
| 密钥 | `.env`（bun 自动加载，gitignore） |

```bash
bun run dev      # http://localhost:5173（开发，HMR）
bun run build    # dist/（client + SSR bundle）
bun run start    # http://localhost:3000（生产，绑定 127.0.0.1）
bun run typecheck
```

**环境坑（已踩过，勿重踩）**：见 `../README.md`「已知环境注意」与记忆 `bun-solid-2-0-项目环境约束`：
- `~/.bun` 被 macOS TCC 拦截 → `bunfig.toml [install.cache].dir = ".bun-cache"`（**字段是 `[install.cache].dir`，不是 `[install] cacheDir`**）
- vite-plugin-solid 必须 `solid({ ssr: true })`，否则 SSR 环境编译成 DOM 代码
- Vite 8 的 middleware mode 不能 `listen()` → dev 用自带 dev server + `appType: "custom"`

---

## 2. 核心架构

### 2.1 回合循环（游戏化创作闭环）

```
[可选抽卡] → [历史考据(若历史真实)] → [导演写一节] → [独立审查者对抗审查] → [伏笔/弧线/状态更新] → [存档]
                    ↑                                                        │
                    └──────────── 不通过 → 带指摘意见重写（按严格度 1-3 次）─────────┘
```

### 2.2 模块清单（src/api/）

| 文件 | 职责 |
|---|---|
| `agnes.ts` | Agnes AI 客户端（OpenAI 兼容）：chat / chatStream(SSE) / complete(含 tool_calls)、退避重试（4 次）、模型回退、503 友好提示（"免费额度渠道暂满"） |
| `anysearch.ts` | AnySearch JSON-RPC 客户端：search / batchSearch / extract |
| `world.ts` | WorldState 类型 + `genOf(w, chapterIndex?)`（全局 gen + 章节覆盖合并）+ `worldSummary()`（上下文压缩：设定/人物含登场离场/伏笔/时间线最近 5 条/上节结尾） |
| `writer.ts` | 导演：写章节（JSON 结构化输出），注入：世界摘要 + 世界书条目 + 写作参数 + 遵循设定细则 + 情节弧线 + 人物声线 + 大纲指引 + 指令 |
| `critic.ts` | 审查者：独立对抗审查（evidence + 地板机制 + 弧线检查），严格度 → 地板 4/6/7 |
| `director.ts` | 回合编排：step（写→审→重写→状态更新→存档）、newStory（立项）、generateOutline（大纲）、editWorld（含角色移除保护）、editChapter（版本快照）、regenerateChapter、rollbackChapter、gachaAndApply、ensureResearch（历史考据） |
| `cards.ts` | 抽卡：六类卡池（角色/发展方向/伏笔/章节/道具/场景）、autoPick、applyCards（伏笔卡入账、角色卡登记待登场） |
| `lore.ts` | 世界书：buildAutoLore（从设定/人物生成）、mergeLore（手动条目保留）、activeLore（≤15 注入）、loreBlock |
| `images.ts` | 本地图像生成：**mflux**（`mflux-generate-z-image-turbo`，参考 `~/mflux-gen.sh`）、saveImage、readImage（防穿越 + isFile） |
| `storage.ts` | 持久化 `data/<slug>/state.json`（写前 .bak）、exportMarkdown、**exportEpub**（系统 zip：mimetype stored 首文件 + OPF/NCX/XHTML） |
| `jsonutil.ts` | 鲁棒 JSON 提取（围栏剥离 + 平衡括号）+ `chatJson`（LLM 输出不合法时回填修复重试） |
| `routes.ts` | 全部 /api/* 路由（见 §4），per-title 并发锁 `withTitleLock`，AppError 业务错误（内部异常 fail-closed 通用文案） |

### 2.3 前端结构（src/）

| 文件 | 职责 |
|---|---|
| `entry-client.tsx` | hydrate + 读取 `window.__INITIAL_DATA__`（**SSR/客户端初始状态必须一致，否则 hydrate 崩溃**） |
| `pages/Home.tsx` | 启动页（流派模板）+ 游戏界面（HUD）；回合 SSE 消费、指令输入、编辑/重写/插画/版本/审查按钮、礼花彩蛋 |
| `components/LeftPanel.tsx` | 8 标签：目录/世界观/设定/角色（头像+声线+移除保护）/大纲/参数(已移除，并入齿轮)/世界书/弧线/脉络 |
| `components/SettingsModal.tsx` | ⚙ 两级设置（全局/章节两列）+ 遵循设定条目列表 + 封面生成/上传 |
| `components/GachaModal.tsx` | 抽卡弹层：类型多选 + 皇帝翻牌动画 + 自动抽取 |
| `components/ReviewPanel.tsx` | 审查报告（评分/findings 切水果动画/印章弹跳） |
| `components/ChapterView.tsx` | 正文（报纸排版 + 通过印章） |
| `components/RangeSlider.tsx` | 可复用双滑块范围组件 |
| `components/Stamp.tsx` | 印章（通过/需修改，pop 动画） |
| `styles/newspaper.css` | 日式报纸风格 + 全部游戏特效 |

---

## 3. 功能清单

### M1 生成参数系统（WorldState.gen，⚙ 设置 → 全局）
minWords/maxWords（滑杆 100-20000）、settingMode（历史真实/架空/混合）、**fidelityRules**（遵循设定条目列表：逐条"遵循史实/架空处理"）、pov、styleOverride、temperature（0-2）、reviewStrictness（宽松/标准/严格）、maxForeshadowPerChapter（0-4）、forceHook、autoGacha。

**章节级覆盖**：`WorldState.chapterGen: Record<章节号, Partial<GenProfile>>`——写作/审查/温度全部按 `genOf(world, chapterIndex)` 合并生效。**协议语义**：`undefined` 字段 = 保留（跟随全局）、`null` 字段 = per-key 删除、全空对象 = 清除整条覆盖。前端设置弹层仅发送变化字段。

### M2 抽卡系统
六类卡池（角色/发展方向/伏笔/章节/道具/场景），类型多选过滤；稀有度 N/R/SR/SSR；自动抽取（优先稀有度+伏笔/角色）；伏笔卡直接入账本；角色卡登记"待登场"角色（优先从「」提取名字，去重）；卡效果注入下一节写作指令；`autoGacha` 参数可每节自动抽 1 张。

### M3 世界书 / 设定库
条目化（keywords/content/enabled/auto），一键自动生成（时代/地点/基调/规则/人物），手动增删改，写作强制注入（≤15 条）。**历史考据**：settingMode=历史真实时自动 AnySearch 查证（时代/地点+官职/制度/风俗）→ 世界书「考据」条目（只查一次）。

### M4 记忆强化
- **伏笔账本**：planted/resolved 状态机 + 埋设章节 + 回收记录；每轮注入导演；审查核查该回收未回收
- **情节弧线**：导演每节输出 arcs（name/status/note），合并同名，≤12 条；写作/审查上下文注入；面板展示
- **人物声线**：Character.voice，立项 LLM 生成 + 面板编辑；写作注入"不得千人一面"
- **角色-章节对应**：`appearedIn: number[]`（写作自动登记登场章节）；**已登场角色禁止移除**（editWorld 强校验 + 前端禁用）
- **离场/死亡记录**：writer 输出 `character_exits` → `Character.exit {chapter, reason}`；摘要注入 + 脉络面板展示
- **分层摘要**：worldSummary = 即时（上节结尾 120 字）+ 工作记忆（时间线最近 5 节）+ 长期（弧线/世界书/活跃伏笔）

### M5 对抗性审查
独立 critic（与 writer 对手关系，反谄媚）；5 维评分（连贯/张力/文笔/节奏/对话）+ 弧线推进检查；**地板机制**（严格度 4/6/7 → coherence 或 tension 低于地板强制 revise）；重写轮数按严格度（1/2/3 次）；findings 必须引用原文证据，上限 5 条 major 优先；**评审记录随版本历史留存**。

### M6 章节编辑
- ✎ 手动编辑（自动留版本快照，审查重置）
- ✨ AI 重写本节（保持剧情方向，重新对抗审查，留版本）
- 🎨 章节插画（mflux 生成，正文下方展示）
- 📚 版本历史：编辑/重写/回滚前自动快照（≤10 版/章，含标题/文本/审查/时间/原因）；弹层回滚
- **回滚语义**：仅还原文本/标题/审查；角色登场/离场、时间线不随回滚还原

### M7 界面与交互
- **日式报纸风格**：纸/墨/线/朱印 + 报头（第 N 期 + 日期 + 状态）
- **8 标签左栏**：目录/世界观/设定/角色/大纲/世界书/弧线/脉络
- **脉络总览**：章节/角色/伏笔统计、封面、角色一览（登场/离场/作用）、**人物关系链**、大纲方向、世界观规则、伏笔明细（已回收/未生效）
- **⚙ 两级设置弹层**（滚动吸顶）：全局（含遵循设定细则 + 封面生成/上传）+ 章节两列（左列表右差异化设置）
- **游戏特效**（纯 CSS）：抽卡皇帝翻牌（3D 翻转+金光）、审查切水果（斜线扫过+stagger）、通过印章弹跳、章节完成礼花彩蛋（42 粒子）
- **控制条**：指令输入 + 抽卡 + 设置 + 大纲 + 导出(MD/EPUB) + 推进（窄屏 <900px 自动换行）

### M8 增强
- **流派模板**：启动页 5 预置模板一键填充（古风悬疑/科幻/武侠/都市怪谈/奇幻）
- **图像生成**：本地 mflux（z-image-turbo），书籍封面（AI 生成/上传）/角色头像/章节插画；防穿越 + 魔数校验 + 10MB 上限
- **导出**：Markdown / EPUB（标准结构，中文文件名 RFC5987 编码）

---

## 4. API 清单（全部 POST JSON，除标注外）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康 + 密钥就绪 |
| `POST /api/chat` / `POST /api/chat/stream` | Agnes 生成 / SSE 流式 |
| `POST /api/search` | AnySearch 搜索 |
| `POST /api/novel/new` | 立项（灵感+题材 → 世界+人物，含声线） |
| `POST /api/novel/state` | 世界状态（sanitize：章节含 versions/image） |
| `POST /api/novel/step` | 回合（SSE 阶段事件：writing/reviewing/saving/result；**客户端断开不中断服务端存档**） |
| `POST /api/novel/gacha` | 抽卡（auto/pick/count≤5/types 白名单） |
| `POST /api/novel/outline` | 大纲生成（hint≤500） |
| `POST /api/novel/world` | 世界编辑（premise/setting/characters/outline/gen/chapterGen/removeCharacterIds） |
| `POST /api/novel/lore` | 世界书（action=auto/save） |
| `POST /api/novel/chapter/edit` | 章节编辑（留版本） |
| `POST /api/novel/chapter/regenerate` | AI 重写本节（留版本） |
| `POST /api/novel/chapter/rollback` | 版本回滚 |
| `POST /api/novel/image` | 图像生成（kind=cover/character/chapter） |
| `POST /api/novel/cover/upload` | 封面上传（dataUrl，魔数校验） |
| `GET /api/novel/asset?title=&path=` | 图片读取（防穿越） |
| `GET /api/novel/export?title=&format=md\|epub` | 导出 |

**安全模式**（全 API 统一）：POST 方法校验 → 参数白名单/类型守卫/长度钳制 → `withTitleLock(slug(title))` 并发锁（锁内 load→改→save，防覆盖）→ AppError 业务错误回显 / 内部异常 console.error + fail-closed 通用文案 → slugify 防路径穿越。

---

## 5. 数据模型（data/<slug>/state.json）

```ts
WorldState {
  title, genre, premise,
  setting: { time, place, rules[], tone },
  characters: [{ id, name, role, traits[], motivation, secret?, status, relations{}, voice?, appearedIn?: number[], exit?: {chapter, reason}, image?, introducedAt }],
  foreshadowing: [{ id, text, plantedAt, status: planted|resolved, resolvedAt?, note? }],
  timeline: [{ chapter, summary }],
  chapters: [{ index, title, text, review: ReviewResult|null, image?, versions?: ChapterVersion[] }],
  cards: Card[], outline: string[],
  gen?: Partial<GenProfile>, chapterGen?: Record<number, Partial<GenProfile>>,
  lore?: LoreEntry[], arcs?: Arc[], cover?: string,
  nextChapter, updatedAt
}
```

**兼容性**：所有新增可选字段（gen/lore/arcs/cover/versions/appearedIn 等）对旧存档均 `?? 默认` 兜底；新增字段必须保持可选。

---

## 6. 环境变量（.env）

```
AGNES_API_KEY / AGNES_BASE_URL(https://api.agnes-ai.cn/v1) / AGNES_MODEL(agnes-2.5-flash) / AGNES_FALLBACK_MODEL(agnes-2.0-flash)
ANYSEARCH_API_KEY / ANYSEARCH_ENDPOINT
AGNES_IMAGE_MODEL(agnes-image-2.1-flash) / IMAGE_PROVIDER(agnes，失败回退 mflux)
IMAGE_STEPS(8) / IMAGE_QUANT(8)          # 仅 mflux 回退时生效
PORT(dev 5173 / prod 3000)
```

---

## 7. 测试与质量门禁

- `bun run typecheck`（tsc --noEmit，零容忍）
- `tests/engine-test.ts`：引擎端到端（立项→回合→审查→伏笔，需真实 API key）
- `tests/restore-chapter.ts`：章节恢复工具
- 每次功能变更：typecheck + SSR curl 冒烟 + review + security_review（无 git 仓库，审查以读文件为准）
- 已知安全终态：HIGH×1/MEDIUM×2/LOW×10 全部闭环（服务器绑 127.0.0.1、错误 fail-closed、参数钳制、路径防穿越、图片魔数+大小）

---

## 8. 已知限制与迭代建议

### 限制
1. Agnes 免费额度 30 RPM：回合约 2-4 次调用，连续操作可能 503（已退避重试 + 友好提示）
2. mflux 图像生成单张 1-3 分钟（本地 MLX），spawnSync 同步阻塞（单用户可接受）
3. 章节正文整章返回（SSE 阶段事件），无逐字流式
4. 无浏览器端自动化测试（hydrate 依赖人工验证）
5. 本地单用户：无账号/多故事切换面板（可用 `?title=` 直达）

### 迭代建议（优先级排序）
1. **章节正文 SSE 流式输出**（writer 流式 + 前端打字机效果）
2. **故事列表/管理页**（`/api/novel/list` 已存在，前端未用）
3. **人物关系图 SVG 可视化**（relations 数据已有）
4. **声线/分层摘要自动化测试**（engine-test 扩展）
5. **EPUB 封面/元数据完善**（cover 图片入 OPF）
6. **多模型路由**（Agnes/本地模型按需切换）
7. **全局撤销/时间线回滚**（目前仅章节级版本）
8. **指令模板库**（常用指令快捷按钮）
