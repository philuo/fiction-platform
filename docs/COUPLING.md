# 指令/动作的依赖与耦合 — UI 更新映射与资源影响（COUPLING）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（主脑中枢模型基线）、[docs/HARNESS.md](./HARNESS.md)（87 条指令注册表）、[docs/INTERVENTION.md](./INTERVENTION.md)（人工干预治理）、[docs/DEEP-DIVE.md](./DEEP-DIVE.md)、[docs/FLOWS.md](./FLOWS.md)
> 状态：**设计提案，尚未实现**。本文只整理架构与规则，不修改代码。
> 目的：在 HARNESS 指令注册表之上补两个既有文档缺失的维度：
> ① **指令/动作的 UI 更新映射**——每条指令执行后**哪些 UI 区域**需要更新、现状**以什么机制**更新、是否一致（第 1-2 章）；
> ② **资源依赖与耦合**——章节插画/视频随章节内容变更的判定、资源留存与**保存前预警**（第 3 章）；删除章节、版本切换、内容变更等操作与大纲/角色/关系/世界观/全局设定的**冲突矩阵与预警覆盖**（第 4 章）。
>
> **用户规则基线**（两条，正文逐条可追溯）：
> - **规则 1（媒体随章节变更）**：章节插画和视频完全属于对应的章节，当章节内容发生变更时要判定是否变更（对应的正文内容不存在则标记移除，**资源留存**以便版本切换时能恢复）；而在删除章节或内容变更等操作**保存之前**就应该**预警、记录、提示**插画、视频资源的变更。→ 第 3 章
> - **规则 2（章节操作与全局冲突）**：删除章节、章节版本切换、章节内容变更等操作可能会和大纲、角色的状态和设定、角色关系、世界观、全局设定产生冲突。→ 第 4 章

---

## 1. UI 区域 × 状态字段 × 刷新机制盘点

### 1.1 总体结论

- 前端**单一数据源**：所有区域的数据都来自 `pages/Home.tsx` 的单个 `world` state（SSR 注入 `window.__INITIAL_DATA__` 或 `POST /api/novel/state` 拉取），**无独立订阅、无区域级增量更新协议**（grep `EventSource` 零命中）。
- **全量刷新是主流**：统一走 `refreshWorld()`（`pages/Home.tsx:215-224`，POST `/api/novel/state`）或直接 `setWorld(data.world)`（多数写操作在响应里带回完整 world）。
- **仅两类局部更新**：① SSE 流式（`/api/novel/step`、`/api/novel/auto/start`，fetch 流式响应手工解析 `data:` 行）局部更新正文草稿预览与连载会话状态；② 5s 轮询（媒体任务 `/api/novel/media/status`、连载断线兜底 `/api/novel/auto/status`）。
- 因此现状下"指令 → UI 区域"没有映射账本：**任何写指令的结果都等价于全 UI 刷新**，区域级耦合靠约定而非协议。本文第 2 章建立该映射账本（目标态），作为未来 SSE 事件分区/区域订阅的设计依据。

### 1.2 UI 区域清单表（19 个区域）

| # | 区域 | 组件（文件:行号） | 读取的 WorldState 字段 | 现状刷新触发方式 |
|---|---|---|---|---|
| 1 | 落地页/书单 | `pages/Home.tsx:1423-1471` | 无（`/api/novel/list` → stories，含 `cover`） | fetchStories（初始/返回书单时） |
| 2 | 报头 Masthead | `components/Masthead.tsx:5-39` | `title`、`updatedAt`、当前章 `index/updatedAt` | 随 world 整体更新 |
| 3 | 左栏·目录 tab | `components/LeftPanel.tsx:45-61` | `chapters[]`（index/title/review.verdict） | 随 world |
| 4 | 左栏·规划 tab | `components/PlanPanel.tsx:5-83` | `blueprint`（compass/mainPlot/progressContract/volumes）、`storyArcs`、`chapterPlans` | expandArc 后自行 POST `/api/novel/plans` 再拉 `/api/novel/state`（:24-30） |
| 5 | 左栏·脉络 tab | `components/LeftPanel.tsx:71-195` | `characters[].appearedIn`、`timeline`、`foreshadowing`（plantedAt/resolvedAt/status）、`plotThreads` | 随 world |
| 6 | 中央正文区 | `components/ChapterView.tsx:243-287` | 选中章 `title/text/review/media/versions`；审查模式用 `review.findings` 渲染波浪线 | 随 world；写作中 liveDraft 由 SSE `delta` 局部填充（`Home.tsx:1578-1583`） |
| 7 | 媒体生成内联进度 | `pages/Home.tsx:1597-1607` | `chapters[].media`（pending 的 id）+ 本地 mediaGen 态 | `/api/novel/media/status` 每 5s 轮询（`Home.tsx:626-674`），完成 → refreshWorld |
| 8 | 右栏状态面板 | `components/StatusPanel.tsx:19-180` | `chapters`（数量/字数）、`foreshadowing`、`outline`、`characters`、`chapterSummaries[].appeared`（双轨判定 :38-52） | 随 world + 选中章节联动 |
| 9 | 新角色提案横幅 | `pages/Home.tsx:1999-2045` | `characterProposals`（pending，含 `reason` 推荐原因） | 折叠单行可关闭（✕）/可展开抽屉（200ms 覆盖三栏）；确认/拒绝走 POST `/api/novel/proposal` 返回 world 直接 setWorld；中枢对话「有哪些角色推荐」→ browse(proposal) 卡片内嵌确认/拒绝（`brain-chat.ts` executeQuery） |
| 10 | 底部控制条 | `pages/Home.tsx:1638-1682` | `nextChapter`（statusText :1331-1333）、`chapters`（revise 过滤 :982） | 随 world |
| 11 | 回溯重写队列横幅 | `pages/Home.tsx:1683-1689` | `rewriteQueue` | runRewrite / clearRewriteQueue 后 refreshWorld |
| 12 | 抽卡弹层 | `components/GachaModal.tsx` | 仅 `world.title`；卡池来自 `/api/novel/gacha` 响应（**不读** `world.cards`） | onApplied → refreshWorld（`Home.tsx:1309-1315`） |
| 13 | ⚙ 设置弹层（6 Tab） | `components/SettingsModal.tsx` | `title/author/current/gen/chapterGen/chapters/cover/characters/lockedFields/premise/setting/lore/outline` | onSave → `/api/novel/world` 返回 world setWorld（`Home.tsx:303-332`）；删章走 onWorldUpdate |
| 14 | 角色关系图弹层 | `components/RelationshipModal.tsx:117-150` | `characters`（useEffect 监听变化重建关系图） | saveWorld({characters}) |
| 15 | 评估弹层 | `components/EvalModal.tsx` | `world.title`；`qualityDebt` 走 `/api/novel/debt` | debt fix/ignore 返回 world → onWorldUpdate（:54-58） |
| 16 | 连载控制台 | `components/AutoRunPanel.tsx` | 非 WorldState：autoSession/autoPending（`/api/novel/auto/status`）+ `qualityDebt` open 计数（`Home.tsx:1702`） | SSE 事件局部更新 session.phase/written（`Home.tsx:1026-1029`）；断线后 5s 轮询（:944-955） |
| 17 | 干预弹层 / 一致性弹层 | `pages/Home.tsx:1789-1797, 2014-2038` | 读 API 返回的 report，不直接读 WorldState | 三选一后 saveWorld；repair 返回 world setWorld |
| 18 | 版本历史弹窗 | `pages/Home.tsx:1799-1862, 2093-2148` | 选中章 `versions`、`review`、`text`；内嵌 ReviewPanel 用 `foreshadowing/characters` | 回滚返回 world setWorld + integrity report（`Home.tsx:1248-1266`） |
| 19 | 审查抽屉 / 立绘 / 分镜确认 / 改词重生成弹窗 | `Home.tsx:1866-1896, 1915-1999, 2002-2012`；`ReviewPanel.tsx:129-218` | 选中章 `review`、`foreshadowing`、`characters`、`chapters[].text`（分镜 anchor 匹配 :1931-1935） | 随 world / refreshWorld / 轮询 |

**前端零消费的字段**（grep 于 `src/components`、`src/pages` 零命中）：`cards`、`changeLog`、`chapterDeltas`、`pendingCards`、`blueprintOptions`。其中 `changeLog` 服务端已有只读端点（`routes.ts:804`）但前端无调用——**审计数据已就绪、无可视化出口**（与 FEATURES.md 迭代建议 2 一致）。`cover` 仅在书单卡片（`Home.tsx:1440-1444`）与设置面板（`SettingsModal.tsx:253-258`）展示，报头不显示。

### 1.3 刷新机制分类（现状 5 类）

| 机制 | 说明 | 覆盖操作 |
|---|---|---|
| A. refreshWorld 全量 | POST `/api/novel/state` 整体替换 world | advance（写章）、generateOutline、imageAction（封面/头像/插画）、media 重生成(图)/删除/轮询完成、runRewrite、clearRewriteQueue、saveLore、skipAutoChapter、PlanPanel.expandArc、EvalModal debt 处置 |
| B. 响应内嵌 world | 写操作响应直接带回完整 world，`setWorld` | saveWorld（世界编辑）、proposalAction、saveEdit（章节编辑）、resettle、regenerate、reReview、confirmDeleteChapter、repairIntegrity、toggleLock、rollback |
| C. SSE 局部 | fetch 流式响应手工解析 `data:` 行 | `/api/novel/step`：phase 文案 + delta 打字机预览，结束仍 refreshWorld（`Home.tsx:232-300`）；`/api/novel/auto/start`：delta/phase + autoSession 局部更新（:996-1061） |
| D. 轮询 | 5s 定时 | 媒体任务 `/api/novel/media/status`（刷新页面自动续接 pending :591-601）；连载断线兜底 `/api/novel/auto/status` |
| E. 无刷新 | 纯只读/无 UI 出口 | changeLog 查询（无前端入口）、磁盘孤儿收集等 |

### 1.4 已知刷新/UI 缺口（本文后续章节的设计输入）

1. **失败媒体不可见、不可操作**：`status=failed` 的媒体被 `ChapterView` 的 `ready` 过滤器挡掉（`ChapterView.tsx:184`），轮询收到 failed 仅 toast 汇总（`Home.tsx:648-650, 661-662`）；重试/改词/删除入口只挂在已渲染的 ready 媒体上 → 失败媒体无 UI 处置路径（第 3 章规则 1 的预警设计覆盖）。
2. **无区域级订阅**：任何写指令 → 全量刷新；长篇下 state.json 增大后刷新成本线性上升，且无法表达"本次操作只影响哪些区域"（第 2 章映射账本的动机）。
3. **rollback 的一致性报告依赖响应内嵌**：回滚后按返回 integrity report 弹 `showChangeReport`（`Home.tsx:1248-1266`）——这是现状**唯一**的"操作后冲突提示"出口，删章/重写/编辑没有等价的前置或后置提示流（第 4 章补齐）。
4. **changeLog 无可视化**：干预审计日志无前端页签，"记录"有了、"提示"没有（规则 1 要求预警+记录+提示三位一体）。

---

## 2. 指令 → UI 更新映射表（HARNESS 的 UI 视角扩展）

### 2.1 映射模型

HARNESS 指令注册表（87 条）只登记"影响哪些 WorldState 字段"，未登记"影响哪些 UI 区域"。本章建立三级推导链：

```
指令（HARNESS CMD-*） → 影响字段（HARNESS affects 列） → 依赖该字段的 UI 区域（1.2 表反查） → 现状刷新机制（1.3 分类） → 一致性判定
```

并为 HARNESS 指令 Schema 提案一个扩展字段（P0 零行为变化，仅登记）：

```ts
type HarnessCommand = {
  // ...既有字段（见 HARNESS.md 第 1 节）
  uiImpact?: string[];   // 完成后应更新的 UI 区域 ID（U01-U19，见 1.2 表 # 列）；只读/无 UI 出口为 []
};
```

### 2.2 字段 → UI 区域反查表（由 1.2 表推导）

| WorldState 字段 | 依赖它的 UI 区域（# 见 1.2） |
|---|---|
| `chapters[]`（title/text/review） | U03 目录、U06 正文、U08 状态面板统计、U10 控制条、U13 设置·章节、U18 版本历史、U19 审查抽屉 |
| `chapters[].media` | U06 正文下方插画/视频、U07 媒体进度、U19 分镜确认/改词弹窗 |
| `chapters[].versions` | U18 版本历史 |
| `blueprint`/`storyArcs`/`chapterPlans` | U04 规划 |
| `characters`（含 appearedIn/relations/exit/portrait/image） | U05 脉络、U08 状态面板、U13 设置·角色、U14 关系图、U19 立绘 |
| `foreshadowing` | U05 脉络、U08 伏笔账、U19 ReviewPanel 引用 |
| `timeline`/`plotThreads` | U05 脉络 |
| `chapterSummaries[].appeared` | U08 本章人物（双轨判定） |
| `outline` | U08 状态面板、U13 设置·大纲 |
| `qualityDebt` | U15 评估弹层、U16 连载 open 计数 |
| `rewriteQueue` | U11 重写队列横幅 |
| `characterProposals` | U09 提案横幅（折叠单行/展开抽屉，`reason` 推荐原因；中枢对话 browse(proposal) 卡片可交互） |
| `cover` | U01 书单、U13 设置 |
| `gen`/`chapterGen`/`setting`/`lore`/`premise`/`lockedFields` | U13 设置 |
| `nextChapter` | U10 控制条 |
| `changeLog`/`cards`/`chapterDeltas`/`pendingCards`/`blueprintOptions` | **无**（前端零消费） |

### 2.3 指令分组表（按现状刷新机制）

| 组 | 机制 | 指令（HARNESS ID） |
|---|---|---|
| A. 完成后 refreshWorld 全量 | 机制 A | N02（advance 入口）、N14、W01、W05（PlanPanel）、W14、W18（gacha onApplied）、M02、M03、M05(图)、M06、M08、M09、M10、L13、G06、G07 |
| B. 响应内嵌 world → setWorld | 机制 B | W12、W03/W04、N05、N06、N07、N08、N09、L03、L04、L11、G03、S02 |
| C. SSE 局部更新 + 结束全量 | 机制 C | N02（step SSE）、N03（auto/start SSE） |
| D. 轮询驱动 | 机制 D | M04（媒体 5s）、Q05（连载断线兜底 5s） |
| E. 无独立 UI 出口（随宿主指令刷新或纯后台） | — | N04、N10-N13、N15、N16、W02、W06-W11、W13、W15-W17、L01、L02、L05-L10、L12、G01、G02（随 W12/intervene 宿主）、G04、G05、G08、M01（返回候选供弹窗）、M07（随宿主）、M11、M12（锁内回写随轮询可见）、S01、S03-S10、Q01-Q04、Q06-Q10 |

**要点**：E 组指令并非"不影响 UI"，而是**寄生在宿主指令的刷新里**——如 L01/L02（记账）寄生于 N02/N03 的结束刷新；W09（弧边界）改 `chapterPlans`/`storyArcs` 寄生于 N02 结束刷新；M12（异步批量生图）寄生于 M04 轮询。UI 映射账本必须记录宿主关系，否则"谁负责刷新 U04 规划区"这类问题无法回答（现状答案是"下一次任意全量刷新"）。

### 2.4 关键写指令 UI 更新明细（应更新区域 vs 现状）

| 指令 | 影响字段 | 应更新 UI 区域 | 现状机制 | 一致性判定 |
|---|---|---|---|---|
| CMD-N02 写章 | chapters/账本全集/nextChapter | U03/U04/U05/U06/U08/U10 | SSE 局部（delta 预览）+ 结束 refreshWorld | ✅ 一致 |
| CMD-N05 重写 | ch.text/review/versions/media(标记)/账本 | U03/U06/U08/U18/U19 | 响应内嵌 world | ✅ 一致 |
| CMD-N06 编辑 | 同 N05 | 同上 | 响应内嵌 world | ✅ 一致 |
| CMD-N07 回滚 | ch.versions/text/review/账本 | U03/U06/U08/U18 + 冲突报告弹窗 | 响应内嵌 world + showChangeReport | ⚠️ 有后置提示，**无前置预警**（第 4 章） |
| CMD-N08 删章 | chapters/账本/媒体/章纲/nextChapter | U03/U04/U05/U06/U08/U10/U11 + 媒体预警 | 预览 needIntervention → 确认内嵌 world | ⚠️ 预览不报 delta 回退效果、不报媒体资源处置明细（第 3/4 章） |
| CMD-W12 世界编辑 | characters/setting/outline 等 | U05/U08/U13/U14 + L2 三选一弹层 | classifyWorldPatch → needIntervention → setWorld | ✅ 前置分级已有（唯一完整样板） |
| CMD-W05 展开弧 | chapterPlans/storyArcs | U04 | PlanPanel 自行 POST + 拉 state | ✅ 一致 |
| CMD-L07 伏笔 CRUD | foreshadowing | U05/U08 | intervene 入口 → 响应 world | ✅ 一致 |
| CMD-L13 质量债处置 | qualityDebt/chapterPlans/outline | U04/U15 | 返回 world | ⚠️ fix 注入 mergeTasks 影响 U04，依赖全量刷新可见 |
| CMD-M02/M03 生成插画/视频 | chapters[].media | U06/U07 | 提交即 refreshWorld + M04 轮询 | ⚠️ failed 媒体无 UI 处置路径（1.4 缺口 1） |
| CMD-M05 改词重生成 | media[].prompt/path/status | U06/U07 | 图即回 world；视频走轮询 | ⚠️ 同上 |
| CMD-M06 删除媒体 | chapters[].media + 磁盘文件 | U06 | refreshWorld | ⚠️ 物理删盘无留存（第 3 章规则 1 目标态改为软删除） |
| CMD-G06 重写队列消费 | chapters/rewriteQueue/账本 | U03/U06/U08/U11 | runRewrite 后 refreshWorld | ✅ 一致（单章失败即停，剩余保留） |
| CMD-S02 自动修复 | 孤儿账本/appearedIn | U03-U08 视修复内容 | 返回 world | ✅ 一致 |
| CMD-G05 写变更日志 | changeLog | **应新增 U20 变更时间线页签** | 无 UI 出口 | ❌ 记录有、提示无（FEATURES 迭代建议 2） |

### 2.5 指令 × UI 区域覆盖矩阵（压缩版）

行为指令大类（HARNESS 第 2 章分类），列为 UI 区域；`●`=该大类存在指令更新该区域，`○`=仅寄生/间接，空=不影响。

| 指令大类 | U01 书单 | U03 目录 | U04 规划 | U05 脉络 | U06 正文 | U07 媒体进度 | U08 状态 | U09 提案 | U10 控制条 | U11 重写队列 | U13 设置 | U14 关系图 | U15 评估 | U18 版本 | U19 审查/立绘 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Narrative（N01-N16） | | ● | ● | ● | ● | | ● | | ● | | | | | ● | ● |
| World（W01-W18） | ● | | ● | ● | | | ● | ● | | | ● | ● | | | ● |
| Ledger（L01-L13） | | ● | ○ | ● | | | ● | ● | | | | | ● | | ● |
| Media（M01-M12） | ● | | | | ● | ● | | | | | ● | | | | ● |
| Governance（G01-G08） | | ● | ○ | ○ | ● | | ● | | | ● | | | | | |
| System（S01-S10） | | ● | ○ | ● | | | ● | | ● | | | | | | |

**矩阵用途**：任何新增指令先查本矩阵确定 `uiImpact`；任何 UI 区域改版先查本矩阵确定"哪些指令会刷新我"。两表互为正反查。

### 2.6 目标态建议（不改变现有协议）

1. **HARNESS 登记 `uiImpact`**（P0，零行为变化）：按 2.4/2.5 表为 87 条指令补列，作为未来区域级刷新的数据源。
2. **SSE 事件分区（远期可选）**：在 step/auto 既有 SSE 之上增加 `ui:update { regions: ["U04","U08"] }` 事件，前端按区域局部刷新；未实现前全量刷新兜底，协议向后兼容。
3. **changeLog 可视化**（对齐 FEATURES 迭代建议 2）：新增 U20 变更时间线页签消费 `changeLog`（含第 3/4 章要求的媒体预警与冲突记录），使"记录 → 提示"闭环。

---

## 3. 章节媒体（插画/视频）生命周期与预警规则（规则 1 落地）

### 3.1 归属与绑定模型（现状）

**归属**：插画/视频条目 `ChapterMedia`（`world.ts:138-152`）完全挂在 `Chapter.media?: ChapterMedia[]`（`world.ts:177`）——**媒体 1:1 属于章节**，不存在跨章共享的媒体条目（磁盘文件除外，见引用守卫）。

```ts
type ChapterMedia = {
  id: string;                 // mediaId()（media.ts:913）
  kind: "image" | "video";
  anchor: string;             // ★ 所锚定段落的【原文片段】（12-40 字连续原文，一字不改），仅用于渲染定位，不进 prompt
  prompt?: string;            // 分镜 LLM 转写的视觉描述（生成用，非原文）
  caption?: string;
  sceneType?: "人物"|"场景"|"事件";
  subject?: string;           // 画面主体角色名
  path?: string;              // 就绪后的磁盘相对路径
  videoId?: string;           // video 异步任务 id
  status?: "pending"|"ready"|"failed";
  error?: string;
  orphan?: boolean;           // ★ 锚定失配标记（可逆，重新命中即清除）
};
```

**绑定链**：`planScenes`（M01）让 LLM 从正文原样摘抄 anchor（`media.ts:708-710`）→ `normalizeScenePlans`（`media.ts:745`）校验 anchor 必须是正文段落归一化子串（失配即丢弃）→ 生成（M02/M03）后渲染时按 anchor 归一化匹配插回对应句子后方（`ChapterView.tsx:174-241`，失配媒体末尾兜底 + orphan 警告 :236-238）。

**失配判定（现状已有，确定性零 LLM）**：`markOrphanMedia`（`media.ts:921-935`）——正文变更后对每条媒体做 anchor 归一化子串匹配，失配打 `orphan=true`、重新命中清除；经 `chapterChangeReport`（`director.ts:804-814`）接入 editChapter（:826）/regenerateChapter（:964）/rollbackChapter，orphan 随存档持久化，API 响应带 `orphanMedia` 清单（`world.ts:167`），前端 `Home.tsx:799` 展示预警。

### 3.2 现状处理表（章节变更 × 媒体）

| 章节操作 | media 条目 | 磁盘文件 | 位置 |
|---|---|---|---|
| N06 编辑 editChapter | 全保留 + markOrphanMedia 打/清 orphan，报告返回 orphanMedia | 不动 | `director.ts:817-847` |
| N05 重写 regenerateChapter | 全保留 + markOrphanMedia（重写后 anchor 大概率失配） | 不动 | `director.ts:885-968` |
| N07 回滚 rollbackChapter | 全保留（**versions 不含 media**），markOrphanMedia 重标；回滚到生成时的文本版本可逆清除 orphan | 不动 | `director.ts:852-882` |
| N08 删章 deleteChapterCascade | **条目随章节整体删除** | 收集 mediaPaths → 路由层锁外 `deleteMediaFile` **物理删盘**（仅删不被其他章引用的 path，引用守卫 `integrity.ts:298-304`，删盘 `routes.ts:1679`） | `integrity.ts:293-358`、`routes.ts:1624-1683` |
| M06 media/delete | 锁内移除条目 | 锁外物理删盘 | `routes.ts:1498-1520` |
| M05 media/regenerate | 原地替换（id/anchor/kind 不变，换 path/prompt） | 新文件落盘后删旧文件 | `routes.ts:1402-1496` |
| 磁盘巡检 collectOrphanMediaFiles | 只读扫描 images/videos/versions，未被引用的文件列为孤儿，供 repair 删盘 | repair 时删 | `integrity.ts:257-278`、`routes.ts:1725` |

**版本快照不含媒体**：`ChapterVersion = { title, text, review, at, reason }`（`world.ts:127-133`，snapshotVersion `director.ts:797-802`）。因此**回滚/误删无法恢复媒体条目与其 prompt**——这是规则 1"资源留存以便版本切换时能恢复"的直接缺口。

### 3.3 目标态规则（规则 1：判定 + 留存 + 保存前预警）

**R1-1 变更判定（正文变 → 媒体判定）**：章节内容变更（edit/regenerate/rollback/resettle/rewrite 队列消费）保存前，确定性执行 anchor 重匹配（复用 `markOrphanMedia`，零 LLM）：
- anchor 仍命中 → 保留，无标记；
- anchor 失配 → **标记移除展示**（`orphan=true`，正文区不再渲染该媒体），但条目与磁盘文件**保留**；
- 判定结果进入保存前预警（R1-3）与响应 `orphanMedia`。

**R1-2 资源留存（软删除，禁止保存时物理删盘）**：
- 删除章节/删除媒体条目时，条目置 `status="archived"`（或移入 `world.mediaTrash[]` 回收站清单：`{ path, kind, prompt, caption, chapterIndex, removedAt, reason }`），**磁盘文件不动**；
- 版本快照扩展为含媒体清单：`ChapterVersion` 增加 `media?: ChapterMediaRef[]`（只存 `id/anchor/kind/prompt/path/status` 引用，不复制文件）→ **版本切换时按清单恢复 media 条目**（磁盘文件仍在则直接挂回，缺失则标 missing 提示）；
- 物理删盘只保留两个出口：① 巡检 repair 的磁盘孤儿清理（`collectOrphanMediaFiles`，确认无条目/无版本引用/无回收站引用后才删）；② 用户显式"清空回收站"。删章引用守卫（`integrity.ts:298-304`）语义保留。

**R1-3 保存前预警（预警 + 记录 + 提示三位一体）**：删章（N08）、内容变更（N05/N06/N07/G06）在**保存之前**产出媒体变更预警并随预览/确认流返回：

```ts
type MediaImpactPreview = {
  kept: number;                 // anchor 仍命中，保留展示
  orphaned: { id, kind, anchor, caption }[];   // 将标记移除（资源留存）
  archived: { id, kind, path, prompt }[];      // 删章时将移入回收站（资源留存）
  diskFilesKept: number;        // 本次操作不动的磁盘文件数
};
```

- **预警**：N08 preview 响应追加 `mediaImpact`（现状仅报"媒体数 info"，`routes.ts:1647-1654`）；N05/N06/N07 在保存前预演 markOrphanMedia（纯函数，不落盘）返回 orphan 清单；
- **记录**：预警结果写入 `changeLog`（kind=media-impact，含 orphaned/archived 明细），对齐 changeLog.reason 扩展（DEEP-DIVE 2.5）；
- **提示**：前端在确认弹窗/回滚确认中展示 MediaImpactPreview（N08 已有 needIntervention 确认流；N05/N06/N07 增加轻量确认——orphaned 非空时才弹，空则直过，避免打扰）；失败媒体（status=failed）一并列入提示，给重试/改词/删除入口（补 1.4 缺口 1）。

**R1-4 版本切换恢复（与 R1-2 联动）**：rollback 到历史版本 → 按该版本 media 清单恢复条目 → markOrphanMedia 复判（旧正文能命中则展示，否则 orphan 留存）→ 预警提示"本次回滚恢复 N 张插画/视频、M 张仍失配"。现状 orphan 可逆机制（回滚到生成时版本自动清 orphan）是该规则的部分实现，缺口在**条目与 prompt 本身不可恢复**。

### 3.4 现状 vs 目标缺口表

| # | 缺口 | 现状 | 目标态规则 | 涉及指令 |
|---|---|---|---|---|
| 1 | 删章/media delete 物理删盘 | 锁外直接 deleteMediaFile | R1-2 软删除 + 回收站，物理清理仅巡检/显式清空 | N08、M06、S03、S05 |
| 2 | 版本快照不含 media | ChapterVersion 只有 title/text/review | R1-2/R1-4 快照含 media 引用清单，回滚可恢复 | N07、N05、N06 |
| 3 | orphan 仅渲染级软标记 | 不提示重生成、不阻止 orphan 媒体被用作参考图（findCharacterRef/findAnchorImage 无 orphan 过滤，`media.ts:554-590`） | R1-1/R1-3 判定+预警；orphan 媒体禁止作为 i2i 参考图 | N05、N06、N07、M02 |
| 4 | 保存前无媒体预警 | 仅 N08 preview 报媒体数（info）；edit/regen/rollback 事后才知 orphan | R1-3 三态预警 + changeLog 记录 + 前端提示 | N05-N08、G06 |
| 5 | 失败媒体无 UI 处置 | failed 被 ready 过滤挡掉，无重试入口 | 媒体清单暴露 failed 项 + 重试/改词/删除 | M02-M05 |

### 3.5 落点阶段（对齐 ARCHITECTURE P0-P3 与 INTERVENTION 第 9 节）

- **P0**：`ChapterVersion.media` 引用清单 + 回收站数据结构（可选字段，向后兼容）；HARNESS 为 N05-N08/M05/M06 登记 mediaImpact 说明（零行为变化）。
- **P1**：删章/媒体删除改软删除；rollback 恢复 media 清单；orphan 媒体禁作参考图。
- **P2**：保存前 MediaImpactPreview 接入 N08 preview 与 N05/N06/N07 确认流；changeLog kind=media-impact。
- **P3**：前端 U20 变更时间线页签展示媒体预警记录；回收站管理界面；与 `applyStateChange` 闸门统一收尾（alignWorld + saveWorld）。

---

## 4. 章节操作 × 全局状态冲突矩阵与预警覆盖（规则 2 落地）

### 4.1 绑定模型前提（决定冲突面的结构事实）

- **chapterPlans 按章节号绑定**（`ChapterPlan.index`，`world.ts:223-231`）：写作/结算均 `find(p => p.index === index)`；删章只 `filter(p.index !== index)`（`integrity.ts:347`），**不 splice 不迁移**——章纲空洞与章节空洞对齐，这是"删中间章后规划区仍可读"的基础。
- **storyArcs 不引用章节号**（仅 `estChapters` 数量，`world.ts:212-221`）；**blueprint 的 `Volume.chapterRange` 类型存在但全代码库零读写**（仅 `world.ts:207` 定义）→ 删章对蓝图/弧零结构影响，但也意味着**弧进度不会因删章回退**（语义缺口）。
- **outline 是纯字符串列表**（`world.ts:333`，兼容保留），不引用章节号；仅 `planner.ts:304` 取 `outline[0]` 兜底、steering merge 无章纲时向头部注入。
- **chapterDeltas 是账本回退的唯一依据**（git 式逆操作 + 旧值快照），无 delta 的旧存档删章降级基础清理 + `delta-missing` warning（`integrity.ts:313-319`）。

### 4.2 冲突矩阵（4 类章节操作 × 全局状态）

图例：`↩`=按 delta 逆操作回退；`♻`=settle 覆盖式重算（**不先 resetChapterLedger**）；`✗`=不处理；`⚠`=部分处理/有已知缺口。

| 全局状态面 | N08 删除章节 | N07 版本切换（回滚） | N05 重写 | N06 编辑 |
|---|---|---|---|---|
| 伏笔 foreshadowing | ↩ 本章回收的恢复 prevStatus/resolvedAt/note（`integrity.ts:35-42`）；本章埋设的删除+danger 留痕（:322-333） | ♻ settle 覆盖（伏笔按文本去重防重复埋，`chronicler.ts:129-134`） | ♻ 同左 | ♻ 同左 |
| 角色 status/look | ↩ 恢复旧值或报 `delta-conflict`（后续章改过同字段则保留，`integrity.ts:45-69`） | ♻ settle 覆盖（字段锁 isLocked 守卫仍生效） | ♻ | ♻ |
| 角色关系 relations | ↩ 增量逆操作：恢复旧值或删该向关系（`integrity.ts:97-113`） | ♻ settle 覆盖 | ♻ | ♻ |
| 全局 current | ↩（`integrity.ts:72-80`） | ♻ | ♻ | ♻ |
| plotThreads 弧线状态 | ↩ status/note（`integrity.ts:83-94`） | ♻ settle 覆盖 | ♻ | ♻ |
| setting.rules 世界观规则 | ↩ 仅删本章新增的 rules（`integrity.ts:116-126`）；既有 rules ✗ | ♻ settle 只增（≤3/章 ≤12/总，去重） | ♻ | ♻ |
| 角色设定本体（name/traits/motivation/secret/voice） | ✗ 不回退（confirmed 提案角色保留留痕，:129-138） | ✗ | ✗ | ✗ |
| 角色 exit 离场 | ↩ 清除本章 exit（:337-342） | ✗ 不还原（`director.ts:850` 注释明说）；settle 只增不删 | ✗ settle 只增 | ✗ |
| timeline | ↩ 删本章条目（:345-349） | ♻ 覆盖式写（`chronicler.ts:236-238`） | ♻ | ♻ |
| chapterSummaries | ↩ 删本章条目 | ⚠ 先降级正文前 300 字，settle 成功才覆盖（`director.ts:864-870`） | ♻ | ♻ |
| chapterDeltas | ↩ 移除本章 delta | ♻ 覆盖新 delta | ♻ | ♻ |
| chapterPlans | ⚠ filter 该 index，**不 splice**（空洞保留，:347）；status 不迁移 | ✗ 保持 done | ✗ 保持 done | ✗ 保持 done |
| blueprint / storyArcs | ✗ 不回退（弧状态/摘要不随删章回退，即使弧章全删） | ✗ | ✗ | ✗ |
| outline | ✗ | ✗ | ✗ | ✗ |
| qualityDebt / chapterGen | ↩ 删本章条目（:345-349） | ✗ | ✗（重写另 registerDebt :961） | ✗ |
| characters.appearedIn | ↩ recomputeAppearedIn 全书重算（:352-353） | ↩ 重算（:863） | ↩（:963） | ↩（:825） |
| nextChapter | ⚠ 仅尾章 --；中间章留空洞绝不重排（:356） | ✗ | ✗ | ✗ |
| 媒体 chapters[].media | ⚠ 物理删盘（见第 3 章 R1-2 目标态） | ⚠ 条目保留、版本快照不含 | ⚠ markOrphanMedia | ⚠ markOrphanMedia |

**矩阵读出的三个结构性结论**：
1. **只有 N08 是"回退语义"（↩ 依赖 chapterDeltas）**，N05/N06/N07 全部是"覆盖式重算语义"（♻），且重算**不先 `resetChapterLedger`**——伏笔"旧残留+新叠加"、回收后不回退等问题的根因（INTERVENTION 第 2 章缺口 ②，唯一先 reset 的是 integrity resettle，`routes.ts:1738-1739`）。
2. **规划层（chapterPlans/blueprint/storyArcs/outline）对所有四类操作免疫**——安全但失真：删光弧内章节后弧仍显示进行中；重写/编辑后该章 plan 仍标 done。
3. **角色设定本体与既有世界观 rules 不受章节操作影响**——冲突只会从"全局 → 章节"方向产生（世界编辑 L2），章节操作不反向破坏设定；但章节操作**揭示**的冲突（如重写后伏笔链断裂）目前无前置检测。

### 4.3 冲突检测现状与覆盖矩阵

**现状检测工具（steering.ts）**：
- `classifyWorldPatch`/`isRetroactivePatch`（:61-63/:45-59）：**只看 characters + setting.rules**——已登场角色任意字段改 → L2；rules 改且已有章节 → L2；其余 L0。
- `impactReport`（:82-124）：确定性通道 = 角色 appearedIn 章集合 ∪ 伏笔 plantedAt/resolvedAt 章集合；LLM 通道 = 1 次冲突评估（premise+近 5 章摘要+近 5 时间线+活跃伏笔 → ≤6 条 conflicts + reverseRelationHint），失败降级为空；固定 options=[merge, rewrite, abort]。
- `applyStrategy`（:127-157）：merge → 弥合任务注入前 2 个 planned 章纲的 mergeTasks（无章纲塞 outline 头部）；rewrite → 受影响章入 rewriteQueue（G06 逐章消费）。

**覆盖矩阵（现状 vs 目标）**：

| 操作入口 | 现状前置分级/影响报告 | 现状事后审计 | 目标态（R2） |
|---|---|---|---|
| W12 世界编辑 `/api/novel/world` | ✅ classifyWorldPatch → L2 三选一（`routes.ts:592-611`） | ✅ alignWorld/autoRepair | 样板，保留 |
| intervene `/api/novel/intervene` | ✅ report/apply（`routes.ts:672-677`） | — | 保留 |
| N08 删章 preview | ⚠️ 仅非尾章调 1 次 impactReport 且只用 conflicts（`routes.ts:1656-1666`）；**不预览 delta 回退效果** | ✅ cascade findings + auditWorld（`director.ts:987`） | R2-1/R2-2 |
| N08 删章执行(merge) | ❌ | ✅ | R2-2 |
| N07 回滚 | ❌ | ✅ chapterChangeReport（`director.ts:879`） | R2-3 |
| N05 重写 | ❌ | ✅（`director.ts:964`） | R2-3 |
| N06 编辑 | ❌ | ✅（`director.ts:846`） | R2-3 |

**结论**：只有世界编辑与 intervene 有完整前置治理；删章半覆盖；**回滚/重写/编辑零前置检测**，全靠事后零 LLM 的 `auditWorld`（`integrity.ts:147-204`）兜底——事后 findings 能发现问题，但状态已落盘，用户只能再发起一轮干预补救。

### 4.4 目标态规则（规则 2：保存前冲突预警）

**R2-1 删章预览增强（N08 preview）**：在现有 findings（活跃伏笔 danger/离场角色 warning/媒体数 info/空洞 warning/非尾章 conflicts）之上追加：
- **delta 回退预演**：对 `chapterDeltas[index]` 跑一遍纯函数 `applyChapterDeltaRevert` 的干跑（dry-run，不落盘），预览"角色 status/look 将恢复为 X、relations 将撤销 Y 条、伏笔将回退 Z 项"——补上现状"预览不报回退效果"缺口；
- **规划影响**：若本章是某弧最后的未完成章/弧内章节将全删 → warning"弧线『…』将无剩余章节"；章纲空洞提示；
- **媒体影响**：接入第 3 章 R1-3 的 `mediaImpact`（archived 清单）。

**R2-2 删章执行前闸门**：merge 确认时若 dry-run 出现 `delta-conflict`（后续章改过同一字段）→ 升级为需显式确认的 findings（现状是回退时保留后续值，用户不知情）。

**R2-3 回滚/重写/编辑前置检测（N05/N06/N07）**：保存前执行确定性冲突检查（零 LLM，复用现有原语）：
- **伏笔链校验**（复用 INTERVENTION 第 4 节第 4 条 + auditWorld 的 foreshadow-orphan/order 逻辑）：新正文 settle 预演后，活跃伏笔 plantedAt/resolvedAt 是否悬空、回收早于埋设；
- **既成事实检查**：新正文若移除了已在后续章被引用的角色出场/离场/规则 → 列出后续章引用（appearedIn/relations 引用），提示"将影响第 X 章既成事实"；
- **账本叠加入口统一**：N05/N06/N07/L03 全走 `resetChapterLedger` 再 settle（对齐 INTERVENTION P1），从根上消除"旧残留+新叠加"，前置检查才有干净的基线；
- LLM 冲突评估（brain 可选，`AGNES_BRAIN_GATE=on` 时）按 INTERVENTION 第 3 节四步协议：干预识别 → 影响传播（确定性）→ 冲突评估（可选 LLM）→ 三态裁决（allow/needIntervention/reject）；off 时仅确定性部分，零行为回归。

**R2-4 记录与提示闭环**：所有前置预警结果写 `changeLog`（kind=conflict-preview）；前端复用 rollback 已有的 `showChangeReport` 弹窗模式（`Home.tsx:1248-1266`）扩展为"保存前预览弹窗"——N08 已有 needIntervention 确认流，N05/N06/N07 仅在 findings 非空时弹出，空则直过。

**R2-5 规划层失真治理（低优先级）**：删章后 auditWorld 增加 finding kind `arc-emptied`（弧内章节全删但弧仍 writing）；重写/编辑不改变 plan done 语义（保留现状，避免误触发重新展开），仅在审查 findings 中提示"正文与章纲目标偏离"。

### 4.5 与既有设计的挂接

| 既有机制/文档 | 本章规则的挂接方式 |
|---|---|
| steering `impactReport`/`applyStrategy` | R2-1/R2-3 的确定性与 LLM 双通道直接复用，不新造 |
| `applyChapterDeltaRevert` dry-run | R2-1 delta 回退预演（纯函数已有，仅需 dry-run 包装） |
| INTERVENTION 三态裁决/四步协议 | R2-3 的协议骨架；本章补的是其在**章节级操作**（N05-N08）的覆盖 |
| `applyStateChange` 闸门（DEEP-DIVE 第 2 章） | R2 全部前置检查最终收敛为闸门的"确定性预检"组成部分；闸门 off 时仍独立可用 |
| auditWorld findings | R2-5 新增 arc-emptied；既有 10 类 findings（`integrity.ts:147-204`）作为事后兜底保留 |
| changeLog.reason 扩展 | R2-4 冲突记录载体 |

### 4.6 落点阶段

- **P0**：HARNESS 为 N05-N08 登记冲突影响面（本文 4.2 矩阵入表，零行为变化）。
- **P1**：账本 reset 统一（R2-3 前置条件）+ 删章 preview dry-run 回退预演（R2-1）。
- **P2**：N05/N06/N07 确定性前置检查（伏笔链/既成事实）+ changeLog kind=conflict-preview + 保存前预览弹窗（R2-3/R2-4）；`INTERVENTION_MODE` 决定弹或不弹（supervised 全弹、manual 静默记录、autopilot 自动裁决）。
- **P3**：LLM 冲突评估接入 `AGNES_BRAIN_GATE`；arc-emptied finding；与 applyStateChange 闸门统一。
