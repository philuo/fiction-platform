# AI 小说 — 功能全记录（供后续 AI 迭代参考）

> 本文档是项目的**权威功能清单与架构说明**。后续任何 AI 迭代前先读本文件 + `docs/REQUIREMENTS.md`（需求计划表）+ `docs/ENGINE.md`（引擎设计）；
> 涉及指令/UI 耦合、章节媒体资源留存与变更预警、章节操作与全局状态冲突时另读 `docs/COUPLING.md`。
> 并在改动后更新本文件。最后更新：2026-08-03（长篇架构 v2 重构）。

---

## 1. 技术栈与运行

| 项 | 值 |
|---|---|
| 运行时/包管理 | **bun 1.4**（零 node 脚本；`bun install` / `bun run` / Bun.serve） |
| 前端框架 | **react 19** + react-dom（SSR：renderToString + hydrateRoot） |
| 构建 | `bun build`（客户端 browser target + SSR bun target，零 vite） |
| 渲染 | **SSR**：dev = `bun --hot` 热重启；prod = `bun build` + Bun.serve |
| 密钥 | `.env`（bun 自动加载，gitignore） |

```bash
bun run dev      # http://localhost:3000（开发，bun --hot 热重启）
bun run build    # dist/（client + SSR bundle）
bun run start    # http://localhost:3000（生产，监听 0.0.0.0）
bun run typecheck
bun test tests/  # 单测 + mock 管线测试（不消耗真实 API 额度）
```

**环境坑（已踩过，勿重踩）**：见 `../README.md`「已知环境注意」：
- `~/.bun` 被 macOS TCC 拦截 → `bunfig.toml [install.cache].dir = ".bun-cache"`（**字段是 `[install.cache].dir`，不是 `[install] cacheDir`**）

---

## 2. 核心架构

### 2.1 每章管线（v2：写审记解耦 + 干预可打断）

```
[取章纲(缺→展开弧)] → [上下文组装(自适应档位+预算)] → [导演流式写正文]
→ [确定性自检(词表/字数)] → [审查者动态准则审查] → [pass / patch定向修补≤1轮 / rewrite整章兜底]
→ [commit：记账结算(摘要+伏笔+角色+时间线) + 质量债务] → [存档+checkpoint + 章纲核销 + 弧/卷边界]
阶段边界可被人工干预立即打断（草稿未 commit，零污染）。
```

### 2.2 模块清单（src/api/）

| 文件 | 职责 |
|---|---|
| `agnes.ts` | Agnes AI 客户端（OpenAI 兼容）：chat / chatStream(SSE) / complete、退避重试、模型回退、**主动 RPM 节流**（免费额度 30RPM） |
| `anysearch.ts` | AnySearch JSON-RPC 客户端：search / batchSearch / extract |
| `world.ts` | WorldState 全部类型（含长篇新字段：blueprint/storyArcs/chapterPlans/chapterSummaries/qualityDebt/characterProposals/lockedFields/changeLog/rewriteQueue）+ genOf + worldSummary |
| `writer.ts` | 导演：**纯写作**（流式，首行【标题】，不夹带状态 JSON）+ 字数治理（short→续写补足） |
| `critic.ts` | 审查者：**动态准则**（instance-specific 5 条）+ 静态一致性；verdict 决策表（pass/patch/rewrite）由代码确定性覆盖 LLM |
| `chronicler.ts` | 记账者：章末 1 次调用合并产出摘要+7 类状态 delta，字段级守卫丢弃坏数据；伏笔仅按 ID 精确匹配；新角色入提案区 |
| `patch.ts` | 定向修补：evidence 定位段落只重写命中段（>50% 则回退整章重写） |
| `style.ts` | 去 AI 味：疲劳词表+禁用句式确定性检测；风格指纹提取；字数守卫 |
| `memory.ts` | 记忆层：章摘要/弧卷归并 + 相关章节检索（bigram Jaccard）+ 自适应档位（full/window/tiered）+ 带预算上下文组装 |
| `planner.ts` | 分层滚动规划：蓝图（2-3 套候选+指南针+进度承诺）→ 卷骨架 → 弧滚动展开 → 章纲核销；progressGuard 节奏守卫；旧故事自愈 |
| `steering.ts` | 干预治理：L0-L3 分级 + 影响评估（确定性+LLM）+ 三选一策略（弥合/回溯重写/放弃）+ 立即打断 + 字段锁 + 变更日志 |
| `director.ts` | 编排：writeOneChapter 统一管线（step/regenerate/autorun 共用）+ newStory 自动导演 + editWorld/编辑/回滚 |
| `autorun.ts` | 自动连载循环 + 停下策略（配额/评分熔断/用户停止/打断/完结） |
| `eval.ts` | 整书 8 维评估（WebNovelBench 式 LLM-as-Judge） |
| `cards.ts` | 抽卡：六类卡池；**角色卡提案化**（结构化人物→待确认）；伏笔卡带回收时机；去重 title+description |
| `lore.ts` | 世界书：**关键词匹配注入**（命中优先，上限 8）+ 自动生成/手动保留 |
| `images.ts` | 图像生成（Agnes 云端生图）、saveImage、readImage（防穿越） |
| `storage.ts` | 持久化：**原子写 tmp+rename**、同名书防覆盖（allocateTitle）、versions 外置、meta.json 列表快读、checkpoint.jsonl、EPUB（含卷题） |
| `jsonutil.ts` | 鲁棒 JSON 提取（围栏剥离 + 平衡括号）+ chatJson（不合法时回填修复重试） |
| `routes.ts` | 全部 /api/* 路由，per-title 并发锁，AppError 业务错误，SSE 心跳 15s |

### 2.3 前端结构（src/）

| 文件 | 职责 |
|---|---|
| `entry-client.tsx` | hydrate + 读取 `window.__INITIAL_DATA__`（**SSR/客户端初始状态必须一致，否则 hydrate 崩溃**） |
| `pages/Home.tsx` | 启动页（流派模板）+ 游戏界面（HUD）；回合 SSE 消费、指令输入、编辑/重写/插画/版本/审查按钮、礼花彩蛋 |
| `components/LeftPanel.tsx` | 3 标签左栏：目录 / 规划 / 脉络（世界观/设定/角色/世界书/大纲/导出等配置统一并入 ⚙ 设置弹层） |
| `components/SettingsModal.tsx` | ⚙ 6 Tab 设置弹层（全局 / 章节 / 设定 / 角色 / 大纲 / 导出）；**章节/设定/角色均为左右两列**（左列表或导航 + 右表单滚动区 + 底部固定保存）；角色面板默认选中首角色、左侧显示性别/年龄/身份、右侧只读登场章节 |
| `components/GachaModal.tsx` | 抽卡弹层：类型多选 + 皇帝翻牌动画 + 自动抽取 |
| `components/ReviewPanel.tsx` | 审查报告（评分/findings 切水果动画/印章弹跳） |
| `components/ChapterView.tsx` | 正文（报纸排版 + 通过印章） |
| `components/StatusPanel.tsx` | 右栏状态面板：创作进度统计 + **本章人物**（被提及或出场，LLM 语义判定为主 + 文本匹配兜底）+ **本章伏笔账**（本章埋设/触发，只读，随选中章节联动） |
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
- **角色-章节对应**：`appearedIn: number[]`（写作自动登记登场章节，服务端持久化，用于"已登场角色禁止移除"等保护）；**已登场角色禁止移除**（editWorld 强校验 + 前端禁用）
- **本章人物判定（右栏，双轨）**：① 已结算章节用 LLM 记账语义名单 `chapterSummaries[].appeared`（= 本章被提及或出场，含旁白提及/回忆/他人转述，随结算/编辑/回滚自动刷新）→ 避免"小雨"类子串误判；② 未结算章节（草稿/降级）回退实时文本匹配（全名 + 去"阿/小/老"前缀的 ≥2 字别名宽松匹配）
- **离场/死亡记录**：writer 输出 `character_exits` → `Character.exit {chapter, reason}`；摘要注入 + 脉络面板展示
- **分层摘要**：worldSummary = 即时（上节结尾 120 字）+ 工作记忆（时间线最近 5 节）+ 长期（弧线/世界书/活跃伏笔）

### M5 对抗性审查
独立 critic（与 writer 对手关系，反谄媚）；5 维评分（连贯/张力/文笔/节奏/对话）+ 弧线推进检查；**地板机制**（严格度 4/6/7 → coherence 或 tension 低于地板强制 revise）；重写轮数按严格度（1/2/3 次）；findings 必须引用原文证据，上限 5 条 major 优先；**评审记录随版本历史留存**。

### M6 章节编辑
- ✎ 手动编辑（自动留版本快照，审查重置）
- ✨ AI 重写本节（保持剧情方向，重新对抗审查，留版本）
- 🎨 章节插画（Agnes 生成，正文下方展示）
- 📚 版本历史：编辑/重写/回滚前自动快照（≤10 版/章，含标题/文本/审查/时间/原因）；弹层回滚
- **回滚语义**：仅还原文本/标题/审查；角色登场/离场、时间线不随回滚还原

### M7 界面与交互
- **日式报纸风格**：纸/墨/线/朱印 + 报头（第 N 期 + 日期 + 状态）
- **中枢指示器**（报头右上角常驻）：实时显示中枢当前动作（推进/连载阶段）+ 已运行时长（四档格式 Ns / Mm Ss / Hh Mm Ss / Dd Hh Mm），运行中朱印脉冲；点击打开「中枢 · 记忆与审计」弹窗
- **中枢弹窗（记忆·台账·操作日志）**：① 分层记忆——L1 设定层（setting/世界书/指南针/角色）、L2 摘要层（卷/章摘要）、L3 检索线索（弧线/时间线），按层折叠只读；② 台账——伏笔账/时间线/弧线/质量债四表；③ 操作日志——`/api/novel/changelog` 时间线倒序 + 操作者/kind 筛选（审计完备：20 写点落日志，含章节编辑/重写/回滚/删除、媒体、蓝图、章纲、伏笔、债务、风格、封面、抽卡、提案等）
- **任务中心弹窗**：自动连载/推进剧情两类任务进度步骤可视化（准备→考据→章纲→写作→审查→修补→结算→存档）；连载支持暂停/恢复/取消任务，推进支持取消与 commitPolicy=confirm 待确认入册条；取消任务 = 立即打断+停止+清理会话与暂存区，回空闲状态
- **运行锁（用户决策）**：任务运行中（含暂停态）一切编辑类操作全面禁止（编辑/删章/版本切换/角色/伏笔/关系/设定/大纲/抽卡/评估/AI修复/重算账本，AI 与手工均不可）——必须取消任务回空闲才可手动操作；统一 requireIdle/taskActive 守卫覆盖全部编辑入口与弹窗内操作
- **伏笔账编辑弹窗**：底部控制条角色与关系旁入口，支持增删改（复用 `/api/novel/foreshadow` 三 action），状态筛选 tabs，已埋入正文的伏笔不可删除（需先回收），保存后右栏伏笔账/脉络联动
- **commitPolicy 完成策略**（⚙ 全局 tab）：auto=审查通过直接作为新版本提交（默认）；confirm=审查通过后暂存待人工确认才入册（连载不受影响，始终自动入册）
- **3 标签左栏**：目录 / 规划 / 脉络（世界观/设定/角色/世界书/大纲/导出等配置统一并入 ⚙ 设置弹层）
- **脉络总览**：章节/角色/伏笔统计、封面、角色一览（登场/离场/作用）、**人物关系链**、大纲方向、世界观规则、伏笔明细（已回收/未生效）
- **⚙ 6 Tab 设置弹层**（滚动吸顶）：全局（含遵循设定细则 + 封面生成/上传）/ 章节 / 设定（世界观·世界书）/ 角色 / 大纲 / 导出；章节/设定/角色左右两列（左列表或导航 + 右表单滚动区 + 底部固定保存）；角色面板默认选中首角色、左侧显示性别/年龄/身份、右侧只读登场章节
- **右栏状态面板**（随选中章节联动）：创作进度统计 + 本章人物（被提及或出场，LLM 语义判定为主）+ 本章伏笔账（本章埋设/触发，只读）；切换章节/新增删除章节/版本回滚后自动更新
- **游戏特效**（纯 CSS）：抽卡皇帝翻牌（3D 翻转+金光）、审查切水果（斜线扫过+stagger）、通过印章弹跳、章节完成礼花彩蛋（42 粒子）
- **控制条**：指令输入 + 抽卡 + 设置 + 大纲 + 导出(MD/EPUB) + 推进（窄屏 <900px 自动换行）

### M8 增强
- **流派模板**：启动页 5 预置模板一键填充（古风悬疑/科幻/武侠/都市怪谈/奇幻）
- **图像生成**：Agnes 云端生图（agnes-image-2.1-flash，1K 档），书籍封面（AI 生成/上传）/角色头像/章节插画；防穿越 + 魔数校验 + 10MB 上限
- **角色视觉自动生成**：立项初始角色 / 抽卡·记账新角色「确定入册」/ 手动新增角色 / 打开已有故事（读时自愈）后，**自动生成头像 + 立绘**（先头像 → 再以头像为参考图生成立绘，容貌一致；fire-and-forget 不阻塞返回）；**中枢巡检兜底**：服务启动后每 60s 扫描所有故事角色，头像/立绘缺失自动补全（任何路径进入世界的角色都不会漏）；中枢指示器显示「自动生成角色头像/立绘中…」，完成后恢复待命；操作日志留痕（头像 CMD-M08 / 立绘 CMD-M07，actor=system）；失败不静默——操作日志记录 visual-fail 带原因、前端提示可在角色面板手动生成，自动重试有 **1 分钟冷却**（visualTriedAt）防烧配额
- **角色视觉渠道单一**：头像仅来源于角色自身字段属性（性别/年龄/身份/外貌 traits/身份服饰）+ 时代服饰 + 全书画风锚点，纯文生不参考任何其他图像；立绘必须以头像为参考图（无头像时提示先生成头像，不降级纯文生）——头像与立绘容貌一致、来源可预期
- **导出**：Markdown / EPUB（标准结构，中文文件名 RFC5987 编码）

---

## 4. API 清单（全部 POST JSON，除标注外）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康 + 密钥就绪 |
| `POST /api/chat` / `POST /api/chat/stream` | Agnes 生成 / SSE 流式 |
| `POST /api/search` | AnySearch 搜索 |
| `POST /api/novel/new` | 立项（灵感+题材 → 世界+人物，**自动导演生成蓝图候选并默认确认首套**） |
| `POST /api/novel/state` | 世界状态（sanitize：章节含 versions/media；新增字段随 …w 透传） |
| `POST /api/novel/step` | 回合（SSE v2：writing/delta/selfcheck/reviewing/patching/settling/saving/interrupted/result；心跳 15s） |
| `POST /api/novel/gacha` | 抽卡（auto/pick/count≤6/types 白名单；角色卡入提案区） |
| `POST /api/novel/outline` | 兼容端点：大纲生成（新架构下建议用 plans） |
| `POST /api/novel/blueprint` | 蓝图：generate（2-3 套候选）/ confirm（选套）/ edit（指南针/承诺） |
| `POST /api/novel/plans` | 章纲：list / expand（展开弧）/ edit（仅未写章纲，L1） |
| `POST /api/novel/world` | 世界编辑（**L2 回溯变更拦截 → needIntervention+影响报告**；携 strategy 重提则执行弥合/重写/放弃；status 手改自动上锁） |
| `POST /api/novel/intervene` | 干预：report（影响评估）/ apply（三选一执行）/ interrupt（写作中立即打断，不入锁） |
| `POST /api/novel/lock` | 字段锁：locked=true/false（chronicler 跳过锁定字段） |
| `POST /api/novel/proposal` | 新角色提案 confirm/reject（抽卡/记账新角色统一入口） |
| `POST /api/novel/changelog` | 干预审计日志（只读） |
| `POST /api/novel/auto/start` | 自动连载（SSE；maxChapters≤30；停下策略：配额/评分熔断/停止/打断/完结） |
| `POST /api/novel/auto/stop` | 停止自动连载（本章结束后停） |
| `POST /api/novel/eval` | 整书 8 维评估（LLM-as-Judge，约 1 次调用） |
| `POST /api/novel/debt` | 质量债务 list/fix（注入修复弥合）/ignore |
| `POST /api/novel/style` | 风格仿写：样章提取指纹注入全书 |
| `POST /api/novel/lore` | 世界书（action=auto/save） |
| `POST /api/novel/chapter/edit` | 章节编辑（留版本） |
| `POST /api/novel/chapter/regenerate` | AI 重写本节（留版本） |
| `POST /api/novel/chapter/rollback` | 版本回滚 |
| `POST /api/novel/image` | 图像生成（kind=cover/character/chapter） |
| `POST /api/novel/visual/status` | 角色视觉自动生成任务状态（pending=生成中 / failed 带原因 / done；前端轮询，完成后中枢恢复待命） |
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
  characters: [{ id, name, role, traits[], motivation, secret?, status, relations{}, voice?, appearedIn?: number[], exit?, image?, portrait?, visualTriedAt?（自动视觉最近尝试时间戳，读时自愈冷却用）, introducedAt }],
  foreshadowing: [{ id, text, plantedAt, status: planted|active|resolved, resolvedAt?, note?, dueHint? }],
  timeline: [{ chapter, summary }],
  chapters: [{ index, title, text, review, media?, versions?(运行时)/versionFiles?(落盘) }],
  cards: Card[]（含 dueHint/character 结构化人物）, outline: string[]（兼容）,
  gen?: Partial<GenProfile>（含 targetChapterWords/styleSample/styleFingerprint/contextMode）,
  chapterGen?, lore?, plotThreads?（原 arcs）, cover?, nextChapter, updatedAt, pendingCards?,
  // 长篇架构 v2 新增（全部可选，旧存档自愈兼容）
  blueprint?, blueprintOptions?, storyArcs?, chapterPlans?, chapterSummaries?,
  qualityDebt?, characterProposals?, lockedFields?, changeLog?, rewriteQueue?
}
```

**兼容性**：所有新增可选字段（gen/lore/arcs/cover/versions/appearedIn 等）对旧存档均 `?? 默认` 兜底；新增字段必须保持可选。

---

## 6. 环境变量（.env）

```
# 文本模型（中枢/写手/审查/记账等全部文本任务，可整体切换，改此处即可）
# 端点须 OpenAI 兼容（chat/completions + SSE）；Responses API 仅 Agnes 端点启用
TEXT_BASE_URL / TEXT_API_KEY / TEXT_MODEL（当前：https://tokenrhythm.studio/v1 / deepseek-v4-flash-0731）
# 未配置 TEXT_* 时回落：
AGNES_API_KEY / AGNES_BASE_URL(https://api.agnes-ai.cn/v1) / AGNES_MODEL(agnes-2.5-flash)
ANYSEARCH_API_KEY / ANYSEARCH_ENDPOINT
AGNES_IMAGE_MODEL(agnes-image-2.1-flash)
PORT(dev 3000 / prod 3000)
```

> 插画/视频固定读 `AGNES_BASE_URL/AGNES_API_KEY`（images.ts/videos.ts），不受 TEXT_* 影响；冲烟脚本 `bun scripts/smoke-model.ts` 可验证当前文本端点。

---

## 7. 测试与质量门禁

- `bun run typecheck`（tsc --noEmit，零容忍）
- `tests/engine-test.ts`：引擎端到端（立项→回合→审查→伏笔，需真实 API key）
- `tests/restore-chapter.ts`：章节恢复工具
- 每次功能变更：typecheck + SSR curl 冒烟 + review + security_review（无 git 仓库，审查以读文件为准）
- 已知安全终态：HIGH×1/MEDIUM×2/LOW×10 全部闭环（错误 fail-closed、参数钳制、路径防穿越、图片魔数+大小；绑定已改为 0.0.0.0 供局域网访问——若需仅本机，改回 `hostname: "127.0.0.1"` 即可）
- **双轨门禁**：`bun test`（代码正确性）+ `docs/QUALITY-BASELINE.md`（结果质量——基线作品复测对比），缺一不可；中枢重构（ARCHITECTURE P0-P3）未建基线前不得启动

---

## 8. 已知限制与迭代建议

### 限制
1. Agnes 免费额度 30 RPM：主动节流 + 退避重试；自动连载遇配额耗尽自动停下留痕
2. 无浏览器端自动化测试（hydrate 依赖人工验证）
3. 本地单用户：无账号（可用 `?title=` 直达）
4. 回溯重写队列（rewriteQueue）目前仅入队，逐章执行需手动触发 regenerate（后续可做自动消费）

### 迭代建议（优先级排序）
1. **rewriteQueue 自动消费**（干预选回溯重写后自动逐章 regenerate）
2. **rewriteQueue 与 changeLog 前端页签**（变更时间线可视化；COUPLING.md 2.6 建议的 U20 区域）
3. **章节媒体软删除与保存前预警**（删章/重写/回滚/编辑前提示插画视频变更，资源留存以便版本切换恢复，见 COUPLING.md 第 3 章）
4. **章节操作保存前冲突预警**（删章/回滚/重写/编辑与大纲/角色/世界观冲突检测，见 COUPLING.md 第 4 章）
5. **人物关系图 SVG 可视化增强**（relations 数据已有）
6. **多模型路由**（Agnes/本地模型按需切换）
7. **全局撤销/时间线回滚**（目前仅章节级版本）
8. **并行章节生成**（长上下文模型下观察，免费额度成本高）
