# 系统指令总表（HARNESS）— 中枢统一审查/调度/控制/治理的指令注册表

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（主脑中枢模型设计基线）、[docs/DEEP-DIVE.md](./DEEP-DIVE.md)（触发点/状态闸门细化）、[docs/FLOWS.md](./FLOWS.md)（可视化 flow）、[docs/COUPLING.md](./COUPLING.md)（指令 → UI 更新映射与媒体资源耦合）
> 状态：**设计提案，尚未实现**。本文只整理架构、不修改代码。
> 目的：盘点系统内**所有可能影响小说**的行为、操作、动作、指令、方法，抽象成统一指令表（harness command registry），为后续重构"中枢"统一审查、调度、控制、治理提供完整清单。

---

## 1. 概念：harness 指令注册表

**harness** = 一个集中的指令注册表，每条"影响小说的行为"登记为一条指令（command），由中枢（brain/overseer）统一：

- **审查（gate）**：写状态前把关——冲突/既成事实/全局影响评估
- **调度（schedule）**：串行化、优先级、异步队列管理（现 `withTitleLock` / 限流池承担）
- **控制（control）**：可被打断/停止/重试（现 interrupt/stop 信号承担）
- **治理（audit）**：审计日志、分级记录（现 `changeLog` 承担）

**范围**：凡会改变 `WorldState`、会话文件、磁盘媒体文件、或影响后续生成内容的行为，一律登记。纯只读查询也登记（标注 `level: L0 / governance: none`），保证完整性。

**指令 Schema**：

```ts
type HarnessCommand = {
  id: string;              // CMD-{类别}-{序号}，唯一
  name: string;            // 中文名 + 英文标识
  category: Category;      // Narrative | World | Ledger | Media | Governance | System | Query
  trigger: Trigger;        // user（前端/API）| ai（管线内部）| system（定时器/钩子/自愈）| brain（中枢治理指令，定义见 docs/BRAIN.md §5：事件驱动触发点与干预修复小循环）
  entry: string;           // 现状入口：API 端点 或 函数（文件:行号）
  action: string;          // 一句话动作描述
  affects: string;         // 影响的 WorldState 字段 / 数据面（""=不写状态）
  llm: LLMDep;             // exec | brain | image | video | none | conditional
  level: Level;            // L0-L3（对已完成叙事/账本的破坏性）
  failure: string;         // 失败语义
  governance: GovPoint;    // gate | audit | schedule | control | none（可能组合，用 "+" 连接）
  uiImpact?: string[];     // 提案扩展（P0 仅登记）：完成后应更新的 UI 区域 ID（U01-U19），见 docs/COUPLING.md 第 2 章
};
```

**分级 L0-L3**（对已完成叙事/账本的破坏性）：

| 级 | 含义 | 例 |
|---|---|---|
| L0 | 不改变已落定状态或可随时重算/重建 | 媒体生成、草稿、只读、锁 |
| L1 | 改变未来计划（章纲/大纲/蓝图候选/世界书） | expandArc、outline、lore、伏笔增删 |
| L2 | 改变已落定账本/正文，但有 `chapterDeltas` 可回滚 | settleChapter、edit/regenerate/rollback、记账重算 |
| L3 | 全局不可逆/级联删除 | 删章提交、立项覆盖、删角色、世界规则重建 |

**触发源**：`user`（前端按钮/API 直接触发）、`ai`（管线内部 LLM 动作链触发）、`system`（定时器/启动钩子/读时自愈/连载循环）、`brain`（中枢模型下发的治理指令——事件驱动触发点与干预修复小循环，行动权限受 INTERVENTION_MODE×AGNES_BRAIN_GATE 矩阵约束，见 [docs/BRAIN.md](./BRAIN.md) §5-6）。

---

## 2. 指令总表（全量登记）

### 2.1 叙事生成类（Narrative）— 直接产生/改写正文

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-N01 | 立项建世界 `newStory` | user | `/api/novel/new` → director.ts:87 | 灵感→世界设定+人物+自动蓝图确认 | 全字段新建 | exec 0.9 | L1 | 抛错不落盘 | gate+audit |
| CMD-N02 | 写一章 `step/writeOneChapter` | user | `/api/novel/step` → director.ts:195 | 完整写章管线（抽卡→考据→写→审→修补→commit） | chapters/nextChapter/账本全集 | exec 全链 | L2 | ReviewFailed 抛错零落盘 | schedule+gate(P1)+audit |
| CMD-N03 | 自动连载写章 `runAuto` | user/system | `/api/novel/auto/start` → autorun.ts:71 | ≤30 章主循环，每章 writeOneChapter+commit | 同上 | exec 全链 | L2 | 熔断/暂存/停 | schedule+gate+control |
| CMD-N04 | 重试暂存草稿 `retryChapter` | system | director.ts:428 | 暂存区草稿按审查意见重写→pass 才 commit | 同上 | exec | L2 | 不过则留暂存区 | schedule+gate |
| CMD-N05 | 原位重写章节 `regenerateChapter` | user | `/api/novel/chapter/regenerate`(:1587)、`/rewrite`(:985) | 版本快照→重写→审→记账 | ch.text/review/versions/账本 | exec | L2 | 失败保留旧版 | gate+audit |
| CMD-N06 | 手动编辑章节 `editChapter` | user | `/api/novel/chapter/edit`(:494) → director.ts:808 | 改正文留版本→自动审查→记账重算 | ch.text/review/versions/appearedIn/账本 | exec 0.4/0.2 | L2 | 审查失败仍保存 | gate+audit |
| CMD-N07 | 回滚章节版本 `rollbackChapter` | user | `/api/novel/chapter/rollback`(:1610) → director.ts:843 | 回滚历史版本+记账重算 | ch.versions/账本/chapterSummaries | exec 0.2 | L2 | 记账失败降级摘要 | gate+audit |
| CMD-N08 | 删章 `deleteChapter` | user | `/api/novel/chapter/delete`(:1631) → director.ts:965 | 两阶段（预览/merge/abort）级联删除 | chapters/伏笔/时间线/章纲/delta/媒体 | exec 条件(impactReport) | **L3** | 预览仅只读 | gate+audit |
| CMD-N09 | 单章重审 `reReviewChapter` | user | `/api/novel/chapter/review`(:515) → director.ts:983 | 仅重审不重写 | ch.review | exec 0.4 | L1 | 审查失败不写 | audit |
| CMD-N10 | 审查+修补循环 `reviewFixLoop` | ai | director.ts:309（N02 内部） | 审查→patch/rewrite ≤2 轮 | 不写状态（产出 verdict） | exec 0.4 | L0 | 轮尽未过走 requirePass | none |
| CMD-N11 | 段落修补 `patchChapter` | ai | patch.ts:39 | 按 evidence 只重写命中段 | 不写状态（产出 text） | exec min(t,1.0) | L0 | patched=false 回退整章 | none |
| CMD-N12 | 流式写正文 `writeChapter` | ai | writer.ts:117 | 流式写章+字数治理（short 续写 1 次） | 不写状态（产出草稿） | exec chatStream | L0 | 空正文重试一次 | none |
| CMD-N13 | 停止连载 `stopAuto` | user | `/api/novel/auto/stop`(:910) | 置停止标志 | 会话文件 | none | L0 | — | control |
| CMD-N14 | 跳过暂存草稿 `auto/skip` | user | `/api/novel/auto/skip`(:925) | 放弃暂存区草稿 | chapterPlans/nextChapter | none | L1 | — | control+audit |
| CMD-N15 | 关闭连载会话 `clear-session` | user | `/api/novel/auto/clear-session`(:949) | 清会话/暂存区 | 会话文件 | none | L0 | — | control |
| CMD-N16 | 立即打断写作 `requestInterrupt` | user | `/api/novel/intervene`(interrupt) → steering.ts:11 | 内存打断信号 | 内存 Map（非 WorldState） | none | L0 | — | control |

### 2.2 世界构建类（World）— 设定层

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-W01 | 生成大纲要点 `generateOutline` | user | `/api/novel/outline`(:392) → director.ts:538 | 生成 3-6 条情节要点 | outline | exec 0.8 | L1 | 失败不写 | gate+audit |
| CMD-W02 | 生成蓝图候选 `buildBlueprint` | user/ai | `/api/novel/blueprint`(generate) → planner.ts:38 | 生成 2-3 套蓝图 | 不写（返回 options） | exec 0.9 | L0 | — | none |
| CMD-W03 | 确认蓝图 `confirmBlueprint` | user | `/api/novel/blueprint`(confirm) → planner.ts:89 | 写蓝图+弧骨架+卷1 writing+expandArc | blueprint/storyArcs/chapterPlans | exec 0.8 | L2 | — | gate+audit |
| CMD-W04 | 编辑蓝图 `blueprint edit` | user | `/api/novel/blueprint`(edit)(:434-437) | 直接改蓝图字段 | blueprint.compass/contract/mainPlot/ending | none | L2 | — | gate+audit |
| CMD-W05 | 展开弧章纲 `expandArc` | ai | `/api/novel/plans`(expand) → planner.ts:118 | 生成 3-6 章章纲追加 | chapterPlans/arc.status | exec 0.8 | L1 | — | gate（中枢审批点） |
| CMD-W06 | 补章纲 `ensureChapterPlan` | ai | planner.ts:173 | 缺章纲时选弧并展开 | 同 expandArc | exec 0.8 | L1 | — | gate |
| CMD-W07 | 编辑章纲 `plans edit` | user | `/api/novel/plans`(edit)(:479-481) | 直接改章纲 | chapterPlans[].goal/beats/hookType | none | L1 | — | gate+audit |
| CMD-W08 | 核销章纲 `markChapterDone` | ai | planner.ts:193 | 章纲置 done，弧全 done 发边界事件 | chapterPlans[].status | none | L1 | — | audit |
| CMD-W09 | 弧边界处理 `handleArcBoundary` | ai | planner.ts:206 | 弧/卷摘要+compass+下一卷+展开下一弧（3-4 次 LLM） | arc.summary/vol.summary/compass/chapterPlans | exec 0.3/0.5/0.8 | L2 | 失败被 catch 不重试（缺陷） | gate+schedule |
| CMD-W10 | 更新指南针 `updateCompass` | ai | planner.ts:240 | 卷边界校准 compass | blueprint.compass | exec 0.5 | L1 | 失败静默 | gate(可选) |
| CMD-W11 | 旧故事自愈 `healLegacyStory` | ai | planner.ts:289 | 补最小蓝图+回填 done 章纲+展开首弧 | blueprint/storyArcs/chapterPlans | exec 0.8 | L1 | — | gate |
| CMD-W12 | 世界编辑 `editWorld` | user | `/api/novel/world`(:574) → director.ts:559 | 手动改设定/角色/参数（L2 需策略三选一） | author/premise/setting/characters/gen/outline | exec 条件(impactReport) | L2/L3 | L2 无策略返 needIntervention | gate+audit |
| CMD-W13 | 角色改名传播 `applyRename` | ai | director.ts:739（W12 内部） | 改名全书传播（关系/设定/正文/摘要） | 多字段+versions+appearedIn | none | L2 | — | gate+audit |
| CMD-W14 | 世界书 `lore auto/save` | user | `/api/novel/lore`(:535) | 自动生成/保存世界书 | lore | none(确定性) | L1 | — | gate+audit |
| CMD-W15 | 历史考据 `ensureResearch` | ai | director.ts:145 | 真实模式自动考据 | lore（考据条目） | none(anysearch) | L1 | — | audit |
| CMD-W16 | 风格指纹 `style` | user | `/api/novel/style`(:814) → style.ts:61 | 样章提取风格指纹 | gen.styleSample/styleFingerprint | exec | L1 | — | gate+audit |
| CMD-W17 | 生成卡池 `gachaGenerate` | user/ai(autoGacha) | `/api/novel/gacha`(generate) → director.ts:502 | LLM 生成候选卡池 | pendingCards | exec 1.0 | L0 | — | audit |
| CMD-W18 | 应用卡牌 `gachaApply/applyCards` | user/ai | director.ts:513 / cards.ts:73 | 伏笔卡入账/角色卡入提案/其余入 cards | foreshadowing/characterProposals/cards | none | L1 | — | gate+audit |

### 2.3 状态记账类（Ledger）— 账本层

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-L01 | 章末记账 `settleChapter` | ai | chronicler.ts:315 | 1 次 LLM 定稿结算（摘要+7 类 delta） | 账本全集（经 applySettle） | exec 0.2 | L2 | 失败降级纯文本摘要 | gate(P1)+audit |
| CMD-L02 | 应用记账 delta `applySettle` | ai | chronicler.ts:108 | 逐项应用：伏笔/角色/关系/规则/时间线/摘要/登场 | foreshadowing/characters/setting/timeline/current/plotThreads/chapterSummaries/appearedIn | none | L2 | — | gate（随 L01） |
| CMD-L03 | 单章账本重结算 `chapter/resettle` | user | `/api/novel/chapter/resettle`(:959) | 重跑 settleChapter 覆盖 delta | 账本+chapterDeltas | exec 0.2 | L2 | — | gate+audit |
| CMD-L04 | 完整性重结算 `integrity resettle` | user | `/api/novel/integrity`(resettle)(:1745) | resetChapterLedger+settleChapter | 账本+chapterDeltas | exec 0.2 | L2 | — | gate+audit |
| CMD-L05 | 撤章账本 `resetChapterLedger` | ai | chronicler.ts:348 | 撤销本章记账（伏笔/时间线/exit） | foreshadowing/timeline/characters[].exit | none | L2 | — | gate+audit |
| CMD-L06 | 重算登场 `recomputeAppearedIn` | ai/system | chronicler.ts:84 | 按正文重算登场章 | characters[].appearedIn | none | L1 | — | audit |
| CMD-L07 | 伏笔增删改 `foreshadow` | user | `/api/novel/foreshadow`(:342) | 零 LLM 伏笔 CRUD | foreshadowing | none | L1 | — | gate+audit |
| CMD-L08 | 生成章摘要 `summarizeChapter` | ai | memory.ts:23 | LLM 章摘要 | 不写（返回） | exec 0.3 | L0 | — | none |
| CMD-L09 | 归并阶段摘要 `summarizeRange` | ai | memory.ts:66 | LLM 阶段摘要归并 | 不写（返回，写入方在弧边界） | exec 0.3 | L0 | — | none |
| CMD-L10 | 落盘摘要 `upsertSummary` | ai | memory.ts:55 | 按 index 覆盖/追加摘要 | chapterSummaries | none | L1 | — | audit |
| CMD-L11 | 提案确认/拒绝 `proposal confirm/reject` | user | `/api/novel/proposal`(:718) | 新角色入册+立绘头像 | characterProposals[].status/characters/portrait/image | image | L2 | — | gate+audit |
| CMD-L12 | 质量债登记 `registerDebt` | ai | director.ts:163 | 登记质量债 | qualityDebt | none | L1 | — | audit |
| CMD-L13 | 质量债修复/忽略 `debt fix/ignore` | user | `/api/novel/debt`(:1039) | fix 注入 mergeTasks/ignore 置状态 | qualityDebt[].status/chapterPlans[].mergeTasks/outline | none | L1 | — | gate+audit |

### 2.4 媒体类（Media）— 视觉/视频产物

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-M01 | 分镜规划 `planScenes` | user | `/api/novel/media/plan`(:1155) → media.ts:819 | LLM 从正文挑段转写视觉 prompt（候选池去重） | 只读（返回 ScenePlan[]） | exec | L0 | 3 次重试 | none（跨章协调候选） |
| CMD-M02 | 生成章节插画 `generateSceneImage` | user | `/api/novel/media/generate`(:1175) → media.ts:952 | i2i 前缀+人数守卫+画风后缀→图像 API | chapters[].media | image | L0 | 异步失败置 error | audit+schedule |
| CMD-M03 | 生成章节视频 `createSceneVideo` | user | media.ts:989 | i2v 首帧/t2v，5-15s | chapters[].media(videoId) | video | L0 | 异步轮询 | audit+schedule |
| CMD-M04 | 媒体状态回写 `media/status` | user | `/api/novel/media/status`(:1338) | 轮询视频任务结果回写 | chapters[].media[].status/error/path | none | L0（条件写） | 429 返 rate_limited | audit |
| CMD-M05 | 改词重生成 `media/regenerate` | user | `/api/novel/media/regenerate`(:1409) | 改 prompt 重生成 | media[].prompt/path/status | image/video | L0 | — | audit |
| CMD-M06 | 删除媒体 `media/delete` | user | `/api/novel/media/delete`(:1505) | 删除媒体条目+磁盘文件 | chapters[].media | none | L0 | — | audit |
| CMD-M07 | 生成角色立绘 `generateCharacterPortrait` | user | `/api/novel/character/portrait`(:1126) → media.ts:628 | i2i 参考（必须参考头像）→竖版立绘 | characters[].portrait | image | L0 | — | audit |
| CMD-M08 | 生成角色头像 `generateCharacterAvatar` | user | `/api/novel/image`(character)(:1076) → media.ts:671 | 纯文生（仅角色自身字段属性）→方形头像 | characters[].image | image | L0 | — | audit |
| CMD-M09 | 生成封面 `image cover` | user | `/api/novel/image`(cover)(:1076) | 生成封面 | cover | image | L0 | — | audit |
| CMD-M10 | 上传封面 `cover/upload` | user | `/api/novel/cover/upload`(:1553) | 上传本地封面 | cover | none | L0 | — | audit |
| CMD-M11 | 后台补角色视觉 `schedulePortraitFor` | system | routes.ts:120 | 媒体生成后 fire-and-forget 补头像+立绘（委托 ensureCharacterVisuals） | characters[].portrait/image | image | L0 | — | none |
| CMD-M12 | 异步批量生图 `imageGenTasks` | system | routes.ts:1270 | 插画异步批量生成锁内回写 | chapters[].media | image | L0 | — | schedule |

### 2.5 干预治理类（Governance）— 用户干预/审计

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-G01 | 干预影响报告 `impactReport` | user/ai | `/api/novel/intervene`(report) → steering.ts:82 | 确定性受影响章+LLM 冲突评估 | 只读（返回 ImpactReport） | exec 0.2 | L0 | LLM 失败降级确定性部分 | none |
| CMD-G02 | 应用干预策略 `applyStrategy` | user/ai | steering.ts:127 | abort/merge(mergeTasks)/rewrite(rewriteQueue) | chapterPlans[].mergeTasks/outline/rewriteQueue/changeLog | none | L2 | — | gate+audit |
| CMD-G03 | 字段锁 `setFieldLock` | user | `/api/novel/lock`(:696) → steering.ts:66 | 角色字段锁增删 | lockedFields | none | L1 | — | audit |
| CMD-G04 | 世界补丁分级 `classifyWorldPatch` | ai | steering.ts:61 | L0/L2 分级判定 | 只读 | none | L0 | — | none |
| CMD-G05 | 写变更日志 `logChange` | ai/system | steering.ts:34 | 审计日志追加（上限 500） | changeLog | none | L0 | — | audit（本身） |
| CMD-G06 | 回溯重写队列消费 `rewrite start` | user | `/api/novel/rewrite`(:985) | 按序 regenerateChapter 消费队列 | chapters/rewriteQueue/账本 | exec | L2 | 单章失败即停剩余保留 | gate+schedule |
| CMD-G07 | 清空重写队列 `rewrite clear` | user | `/api/novel/rewrite`(clear)(:1000) | 清空队列 | rewriteQueue | none | L1 | — | audit |
| CMD-G08 | 请求打断 `requestInterrupt` | user | steering.ts:11（N16 同源） | 内存打断信号 | 内存 Map | none | L0 | — | control |

### 2.6 系统机制类（System）— 自检/修复/钩子/评估

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-S01 | 完整性扫描 `auditWorld` | user | `/api/novel/integrity`(scan) → integrity.ts:147 | 零 LLM 确定性审计 | 只读（产 findings） | none | L0 | — | none |
| CMD-S02 | 自动修复 `autoRepair` | user/system | `/api/novel/integrity`(repair) → integrity.ts:210 | 幂等修复孤儿数据+重算登场 | 孤儿摘要/时间线/章纲/债务/appearedIn | none | L2 | 绝不删正文/媒体/伏笔 | gate+audit |
| CMD-S03 | 级联删章 `deleteChapterCascade` | ai | integrity.ts:293 | delta 回退+媒体清理+登场重算+nextChapter-- | chapters/账本/媒体/nextChapter | none | **L3** | — | gate+audit |
| CMD-S04 | 变更回退 `applyChapterDeltaRevert` | ai | integrity.ts:31 | git revert 语义回退账本 | 账本全集 | none | L2 | 后续章改过则保留+warning | gate（回滚工具） |
| CMD-S05 | 磁盘孤儿媒体收集 `collectOrphanMediaFiles` | system | integrity.ts:257 | 收集磁盘孤儿媒体 | 只读收集 | none | L0 | — | none |
| CMD-S06 | 旧存档对齐 `alignWorld` | system | integrity.ts:247 | 迁移旧存档字段 | 多字段 | none | L1 | — | audit |
| CMD-S07 | 启动恢复连载 `resumeAutoSessions` | system | routes.ts:1816（dev.ts:108/prod.ts:86 触发） | 重启后自动续跑 running 会话 | 同 N03 | exec | L2 | — | schedule+control |
| CMD-S08 | 读时自愈钩子 `state 钩子` | system | `/api/novel/state`(:247-257) | 每次打开重算登场+媒体迁移+autoRepair | appearedIn/ch.media（dirty 时 saveWorld） | none | L1（条件写） | — | audit |
| CMD-S09 | 整书评估 `evaluateBook` | user | `/api/novel/eval`(:1021) → eval.ts:49 | 8 维 LLM 评估（缓存指纹） | 只读（写 eval.json） | exec/brain(未来) | L0 | 缓存兜底 | none |
| CMD-S10 | 限流排队 `limiter` | system | limiter.ts | text 5/40、image 5/40、video 1/2 并发限流 | 影响所有 LLM/媒体行为 | none | L0 | 排队不 429 | schedule |
| CMD-S11 | 中枢视觉巡检 `sweepVisualGaps` | system | routes.ts:236（dev.ts/prod.ts 启动触发，每 60s） | 扫描所有故事角色，头像/立绘缺失自动补全（1 分钟冷却） | characters[].portrait/image | image | L1 | 冷却兜底防烧配额 | schedule+audit |

### 2.7 查询只读类（Query）

| ID | 指令 | 触发 | 入口（现状） | 动作 | 影响字段 | LLM | 级 | 失败语义 | 治理 |
|---|---|---|---|---|---|---|---|---|---|
| CMD-Q01 | 读世界状态 | user | `/api/novel/state`(:247) | 读世界+自愈钩子 | 只读（条件写见 S08） | none | L0 | — | none |
| CMD-Q02 | 故事列表 | user | `/api/novel/list`(:259) | 列表 | 只读 | none | L0 | — | none |
| CMD-Q03 | 导出 md/epub | user | `/api/novel/export`(:316) | 导出 | 只读 | none | L0 | — | none |
| CMD-Q04 | 变更日志 | user | `/api/novel/changelog`(:805) | 审计日志读 | 只读 | none | L0 | — | none |
| CMD-Q05 | 连载状态 | user | `/api/novel/auto/status`(:917) | 会话/暂存区查询 | 只读 | none | L0 | — | none |
| CMD-Q06 | 媒体资产读取 | user | `/api/novel/asset`(:1535) | 读图片/视频文件 | 只读 | none | L0 | — | none |
| CMD-Q07 | 健康检查 | user/system | `/api/health`(:153) | key 配置检查 | 只读 | none | L0 | — | none |
| CMD-Q08 | 单轮对话 | user | `/api/chat`(:164) | 通用对话 | 无 WorldState | exec | L0 | — | none |
| CMD-Q09 | 流式对话 | user | `/api/chat/stream`(:178) | SSE 对话 | 无 WorldState | exec | L0 | — | none |
| CMD-Q10 | 联网搜索 | user | `/api/search`(:205) | anysearch 搜索 | 只读 | none | L0 | — | none |

---

## 3. 中枢治理映射（harness 挂载点）

### 3.1 按治理点汇总

| 治理点 | 指令集合 | 现状承担者 | 中枢接入（未来） |
|---|---|---|---|
| **gate**（写前审查） | 所有 L2/L3 写指令：N01-08、W03/04/09/12/13/18、L01-07/11/13、G02/06、S02/03/04 | `withTitleLock` 串行 + chronicler 字段守卫 | `applyStateChange` 闸门（AGNES_BRAIN_GATE=on 时 L2+ 审查） |
| **audit**（审计） | 全部写指令 + G05 | `changeLog`（上限 500，actor/strategy） | 扩展 `reason` 字段（中枢审查结论） |
| **schedule**（调度） | N02/03/04/05、W09、M02/03/12、G06、S07/10 | 限流池（text/image/video）+ 异步任务表 | 任务优先级/跨章分布协调（分镜候选池全局共享） |
| **control**（控制） | N03/13/14/15/16、G08、S07 | interrupt/stop 信号、内存 Map | 中枢下发"暂停/中止/重试"修正指令 |
| **none**（免治理） | 纯只读/草稿/媒体生成/锁 | — | 无需中枢介入 |

### 3.2 与主脑触发点对齐（ARCHITECTURE §3.3 / DEEP-DIVE §1）

| 中枢触发点 | 覆盖指令 | 说明 |
|---|---|---|
| 章末一致性审查（commit P1 窗口） | N02/03/04/05/06（经 commitChapter→L01/L02） | 审查 settleChapter 记账结果 vs 全局设定/伏笔/主线；否决走 applyChapterDeltaRevert（S04） |
| 弧边界审批（expandArc 前） | W05/06/09/10 | 审批展开方向/章数/节奏与全局蓝图一致性；顺带修复 handleArcBoundary 不重试缺陷 |
| 状态变更闸门（applyStateChange） | 全部 gate 指令 | L2+ 变更必经中枢审查（冲突/既成事实/全局影响） |
| 整书评估（eval） | S09 | 升级为 brain 模型提升判断质量 |
| 跨章候选池协调（分镜） | M01 | "已用段落"全局账本，避免跨次/跨章重复选段 |

### 3.3 指令 → 现有机制复用（不重写）

| 机制 | 位置 | 复用指令 |
|---|---|---|
| `withTitleLock` 串行化 | routes.ts:348 | 所有 gate/schedule 指令 |
| chronicler 字段守卫 | chronicler.ts:62-312 | L02 确定性预检 |
| `classifyWorldPatch` 分级 | steering.ts:61 | gate 分级（L0/L2） |
| `applyChapterDeltaRevert` | integrity.ts:31 | gate 否决回滚（S04） |
| `changeLog` | world.ts:311/steering.ts:34 | audit 全部 |
| `mergeTasks`/`rewriteQueue` | world.ts:223/steering.ts:141 | 中枢修正指令落地通道（G02/G06） |

---

## 4. 完整性核对（覆盖矩阵）

**盘点来源与指令映射**：

| 来源 | 数量 | 映射到 |
|---|---|---|
| routes.ts 全部 45 端点 | 45 | CMD-N/W/L/M/G/S/Q 全覆盖（N01-16、W01-18、L03/04/07/11/13、M01-10、G03/06/07、S01/02/07/08/09、Q01-10） |
| director/writer/critic/patch 动作 | 25 | N01-N16、W01/12/13/16/17/18（内部原子 N10/11/12 保留） |
| planner/chronicler/cards/memory/eval/steering 动作 | 26 | W02-11、L01/02/05/06/08/09/10/12、G01/02/04/05/08 |
| media/integrity/autorun/limiter | 17 | M01-12、S01-06、S10 |
| 后台钩子/定时器/启动钩子 | 3 | M11/M12、S07、S08 |
| 前端用户操作入口 | 30+ | 全部映射到对应端点指令 |

**负向确认**（排除项）：`progressGuard`/`isBookComplete`/`evalFingerprint`/`cardKey`/`normCharName` 等为纯只读函数不登记；`autoGacha` 为 `GenProfile` 布尔开关（非函数），触发链为 W17→autoPick→W18；限流排队不产生业务副作用（S10 登记为调度机制）。

**统计**：指令共 **87 条**（N16 + W18 + L13 + M12 + G08 + S10 + Q10）。其中写指令（L1-L3）约 60 条、纯只读/无状态 27 条；L3 不可逆 2 条（N08 删章、S03 级联删章）。

---

## 5. 后续落地路径（对齐 ARCHITECTURE P0-P3）

1. **P0 配置化**：`AGNES_BRAIN_MODEL/AGNES_EXEC_MODEL`，指令表仅作登记无行为变化。
2. **P1 任务画像**：指令表 → `TASK_PROFILES`（每指令 llm/temperature/retries/failure 落表），gate 指令接入 `applyStateChange`（off 空转）。
3. **P2 主脑启用**：章末审查（N02-06 经 L01）、弧边界审批（W05/06/09）、评估升级（S09）、跨章分布（M01）接入；`AGNES_BRAIN_GATE` 可开关。
4. **P3 收敛状态写**：全部 gate 指令统一走 `applyStateChange`，audit 统一 changeLog+reason，schedule 统一调度层，control 统一信号层——harness 注册表成为唯一入口。

**验收**：指令表与代码盘点交叉核对无遗漏（第 4 章覆盖矩阵）；`src/` 零改动；本文档与 ARCHITECTURE/DEEP-DIVE/FLOWS 引用一致。

## 6. 与现有文档的关系

- `docs/ARCHITECTURE.md`：主脑中枢模型设计基线（本文是其"指令注册表"实例化）。
- `docs/DEEP-DIVE.md`：触发点/applyStateChange/32 写点收编（本文指令的治理映射依据）。
- `docs/FLOWS.md`：4 个 Mermaid flow（本文指令在管线/闸门中的位置图示）。
- `docs/COUPLING.md`：指令 → UI 更新映射（`uiImpact` 列数据源）与章节媒体资源耦合（N05-N08/M05/M06 的留存与预警规则）。
- `docs/BRAIN.md`：触发源 `brain` 列的定义依据（治理循环与权限矩阵）；G06/G07（重写队列）是治理计划消费的登记指令。
