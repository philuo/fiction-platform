# 功能架构设计（v3 提案：主脑中枢模型 + 状态变更收敛）

> 状态：**设计提案，尚未实现**。本文只整理架构、不修改代码。
> 目的：诊断当前"文本模型使用太傻 / 架构分散"的问题，为 `.env` 可配置的**主脑中枢模型**（把控整本小说与状态变更）提供完整设计蓝图。

---

## 1. 现状架构盘点

### 1.1 技术栈与运行

- **运行时**：Bun（`bun --hot server/dev.ts`），`Bun.serve()` 路由（见 `server/`）。
- **前端**：`index.html` + `src/entry-client.tsx`，SSR（`server/entry-server.tsx`），样式 `src/styles/newspaper.css`。
- **LLM 出口**：`src/api/agnes.ts`（OpenAI 兼容客户端）。文本模型端点由 `TEXT_BASE_URL/TEXT_API_KEY/TEXT_MODEL` 配置（当前指向基元 `https://tokenrhythm.studio/v1`，模型 `deepseek-v4-flash-0731`），未配置时回落 `AGNES_BASE_URL/AGNES_API_KEY/AGNES_MODEL`；Responses API 仅 Agnes 端点启用，其余端点直走 chat/completions。
- **媒体模型**：`src/api/images.ts`（`agnes-image-2.1-flash`）、`src/api/videos.ts`（`agnes-video-v2.0`），固定读 `AGNES_BASE_URL/AGNES_API_KEY`（不受 TEXT_* 影响），各自独立限流池。
- **持久化**：JSON 文件世界状态（`src/api/storage.ts`，`saveWorld/loadWorld` + `appendCheckpoint` 检查点）。

### 1.2 模块全景（`src/api/`）

| 模块 | 职责 | 读状态 | 写状态 |
|---|---|---|---|
| `routes.ts` | HTTP 路由 + 30+ 处**直接**改 WorldState 字段 | ✅ | ✅（最大散改点） |
| `director.ts` | 主编排：立项/写章/审查循环/提交/重写/编辑/回滚/删章 | ✅ | ✅（统一管线） |
| `writer.ts` | 流式写一章正文（记忆层/世界书/风格指纹注入） | ✅ | ❌（只产草稿） |
| `critic.ts` | 章节审查（动态准则 + 评分 + findings） | ✅ | ❌ |
| `patch.ts` | 按 findings 局部修补段落 | ✅ | ❌ |
| `chronicler.ts` | 章末记账（摘要/伏笔/角色/时间线/弧线/提案/出场） | ✅ | ✅（字段级守卫） |
| `planner.ts` | 蓝图/弧展开/章纲/指南针更新 | ✅ | ✅ |
| `steering.ts` | 干预治理 L0–L3（打断/影响评估/策略/字段锁/变更日志） | ✅ | ✅（changeLog/lockedFields/rewriteQueue） |
| `eval.ts` | 整书 8 维 LLM-as-Judge 评估（带持久化缓存） | ✅ | ❌（只写缓存文件） |
| `cards.ts` | 抽卡池生成/自动抽卡/应用 | ✅ | ✅（foreshadowing/proposals/cards） |
| `memory.ts` | 摘要（L2/弧/卷）、检索（bigram+Jaccard）、上下文拼装 | ✅ | ✅（仅 chapterSummaries） |
| `media.ts` | 分镜规划/插画/视频/肖像/头像生成、i2i 前缀、风格后缀 | ✅ | ✅（chapters[].media） |
| `integrity.ts` | 数据完整性自检与自动修复（删章级联、resettle） | ✅ | ✅ |
| `limiter.ts` | 全局限流（textLimiter 5 并发/40 RPM；媒体各自池） | — | — |
| `autorun.ts` | 自动连载主循环（每 N 章整书评估） | ✅ | ❌（只写会话文件） |

### 1.3 单章管线（`director.ts writeOneChapter`）

```
① 自动抽卡(cards) → ② 历史考据(lore) → ③ 旧故事自愈(planner)
→ ④ 取/展开章纲(planner) → ⑤ 打断检查(steering)
→ ⑥ 流式写作(writer) → ⑦ 确定性自检 → ⑧ 审查+修补循环 ≤2 轮(critic+patch/writer)
→ ⑨ requirePass 未过则记质量债 → ⑩ commit(commitChapter)
```

`commitChapter` 序列：版本快照 → push 章节 → `chronicler.settleChapter`（写全部账本 + 返回 delta）→ 存 `chapterDeltas`（git 式逆操作）→ 质量债 → 章纲标记 done → 弧边界处理（卷摘要/指南针）→ `nextChapter++` → 保存 + 检查点。

### 1.4 状态模型（`src/api/world.ts`）

`WorldState` 顶层含：`title/genre/premise/setting/characters/foreshadowing/timeline/chapters/cards/outline/gen/lore/plotThreads/cover/current/nextChapter/blueprint/storyArcs/chapterPlans/chapterSummaries/chapterDeltas/qualityDebt/characterProposals/lockedFields/changeLog/rewriteQueue` 等 25+ 字段。

防护机制（已有）：
- `withTitleLock` 全局串行化（`routes.ts:348` 等）；
- `chapterDeltas` git 式逆操作（删章可还原）；
- chronicler 字段级守卫（`isLocked` 字段锁、长度 clamp、ID 精确匹配、别名归一）；
- steering 字段锁 `lockedFields` + 变更日志 `changeLog`（上限 500）。

### 1.5 文本模型使用现状（`src/api/agnes.ts` + 调用点）

> 时点说明：以下为 2026-08 调研快照。其后已完成文本模型配置分离（`TEXT_BASE_URL/TEXT_API_KEY/TEXT_MODEL` 可切换到任意 OpenAI 兼容端点，当前基元 `deepseek-v4-flash-0731`；未配置回落 `AGNES_*`；Responses API 仅 Agnes 端点启用），见 [docs/FEATURES.md](./FEATURES.md) §6。本节保留原貌作为问题诊断基线。

**出口集中**：全部文本调用汇入 3 个函数——`complete`（Responses→chat/completions 双端降级）、`chat`、`chatStream`（恒 chat/completions+SSE）。模型单一：`MODEL = AGNES_MODEL ?? "agnes-2.5-flash"`（`agnes.ts:54`），`AgnesOptions` **无 model 字段**，任何调用点都不能指定模型、无回退。限流统一（textLimiter）；重试统一（`withSmartRetry`：429/5xx/网络/空内容/timeout，指数退避，空内容自动降档 reasoning）。

**策略分散（"太傻"的根因）**：

| 维度 | 现状 | 问题 |
|---|---|---|
| temperature | 13 个 chatJson 调用点各自内联：0.2(chronicler/steering)、0.3(memory/eval/style)、0.4(critic)、0.5(planner/media)、0.8(director/planner)、0.9(director/planner/writer)、1.0(cards)，共 7 种取值 | 改一个任务参数要改 13 处；无统一配置表 |
| timeout | 默认 120s；writer 240s（流式放宽）、media 150s 显式覆盖 | 特例靠注释说明，无共享枚举 |
| retries | 默认 4；media 显式 2 | 与任务重要性/成本不成体系 |
| 失败降级 | 摘要类降级截断文本；规划类兜底章纲；抽卡/评估直接抛；分镜独立外层重试 3 次 | 同类型任务失败语义不一 |
| prompt 组织 | 每模块自带 system prompt + 各自 JSON schema（critic/writer/media planSystem 等） | 无共享 prompt 模板层 |
| 输出解析 | 纯文本正则（writer/patch/style）、JSON（chatJson+extractJson）、SSE（writer/routes）三类各自实现 | 同模块内可混用 |
| 字数治理 | 仅 writer 有（空正文重试 + 续写补足） | 其它生成任务无保护 |

**结论**："出口集中、策略分散"的中间态——单一模型（agnes-2.5-flash）被用于所有任务（写作/审查/记账/规划/评估/抽卡/分镜），没有区分**执行模型**与**中枢模型**，没有任务画像（task profile），没有统一预算/失败策略，也没有一个"主脑"在整本书层面把控一致性与状态变更。

---

## 2. 问题诊断

### 2.1 文本模型"太傻"的表现

1. **无中枢统筹**：每个任务独立调用 LLM，各自为政。章末记账、弧展开、指南针更新、评估各问各的，模型没有"这本书的全局状态"的整体视图来消解矛盾、安排伏笔、控制节奏。
2. **参数策略散落**：temperature/timeout/retries 内联在 13+ 处，无法按任务画像调优，也无法按模型能力差异化。
3. **单模型万能论**：agnes-2.5-flash 既要写正文又要做精确记账（0.2 低温）又要创意抽卡（1.0 高温）又要结构化分镜——同一模型在不同温度下反复横跳，效果上限受限于单一模型。
4. **状态变更缺闸门**：状态被 5 个模块 + routes 30+ 处直接改写，缺少一个"变更前把关"的中央决策点——没有地方在写入前检查"这个改动是否符合全局设定/主线/伏笔计划"。
5. **失败与重试不成体系**：分镜 3×2×2 次请求、writer 240s 超时、评估无兜底——成本与稳健性策略随实现者心情。

### 2.2 状态变更多写者（"director 居中 + 多个并行写者"）

- 叙事写入主路径已收敛（writeOneChapter→commitChapter→settleChapter，未 commit 零污染）。
- 但 chronicler/planner 的写函数被 routes 直接调用（resettle/blueprint/plans），绕开 director 完整序列；routes 自身 30+ 处直接改字段后 saveWorld；integrity.autoRepair 在任意全局变更后被反复调用；收尾不一致（部分调 alignWorld 部分不调）。

---

## 3. 目标架构：主脑中枢模型（Brain / Overseer）

### 3.1 设计原则

1. **角色分层**：区分**执行模型**（executor：写作/审查/记账/分镜等局部任务，追求吞吐与成本）与**中枢模型**（brain/overseer：整本书层面的决策，追求推理质量与一致性）。
2. **配置驱动**：全部模型与参数从 `.env` 读取，默认值保持当前行为（agnes-2.5-flash），不配置即可用。
3. **单一状态变更闸门**：所有写 WorldState 的路径收敛到一个接口，中枢模型在此把关（可选开关）。
4. **任务画像（TaskProfile）**：每个 LLM 任务一个结构化配置（模型/温度/预算/重试/失败降级策略），替代内联硬编码。
5. **渐进落地**：先 P0 配置化（无行为变化），再 P1 任务画像，再 P2 主脑启用，最后 P3 收敛状态写。

### 3.2 `.env` 配置方案（提案）

```env
# —— 文本模型路由（v3 新增）——
# 中枢模型：把控整本书、状态变更、跨任务一致性；默认回落到 AGNES_MODEL
AGNES_BRAIN_MODEL=agnes-2.5-flash
# 执行模型：局部任务（写作/审查/记账/分镜/抽卡/评估）；默认回落到 AGNES_MODEL
AGNES_EXEC_MODEL=agnes-2.5-flash
# 主脑开关：状态变更闸门（写入前由中枢模型审查）；off=纯配置化兼容
AGNES_BRAIN_GATE=off
# 任务画像覆盖（可选）：按任务名覆盖模型/温度，如
# AGNES_TASK_writer__model=agnes-2.5-flash
# AGNES_TASK_writer__temperature=0.9
# AGNES_TASK_chronicler__temperature=0.2
```

- `AgnesOptions` 增加 `model?: string`（当前缺失，`agnes.ts` 中 `MODEL` 常量改为默认值）。
- 新增 `src/api/modelconfig.ts`：`resolveModel(task)`、`resolveTaskProfile(task)`，从 env 读取，未配置则用默认。
- 保留 `AGNES_MODEL` 作为全局回落，保证现有部署零改动。

### 3.3 中枢模型职责（`brain` / `overseer`）

**触发点（候选）**：
- **章末**（`commitChapter` 后）：审查本章记账结果是否符合全局设定/主线/伏笔计划；发现矛盾返回修正指令（L2 干预或 mergeTasks）。
- **章纲/弧展开**（`expandArc` 前）：审批章纲与全局蓝图一致性（可选）。
- **状态变更**（`AGNES_BRAIN_GATE=on` 时）：对任何 L2+ 变更做影响评估闸门。
- **整书评估**（`eval.evaluateBook`）：已有 8 维评估，中枢模型可用更强推理模型提升判断质量。
- **分镜/多章节协调**：把"候选池择优"从单任务提升到"跨章分布"（避免重复选段，见下方状态变更章节关联）。

**不做什么**：中枢模型不写正文、不执行具体任务——只做**决策/审批/把关**，执行仍由 executor 完成。这样保持写管线低延迟（流式），只在中枢介入点增加一次串行审查。

**治理三原语（goal/plan/loop）**：中枢除触发点审查外，另需统一目标对象（BookGoal，收编 progressContract/停下策略/eval 地板）、治理计划（复用 mergeTasks/rewriteQueue/qualityDebt 三通道，不重造叙事计划）、有界事件驱动治理循环（含干预修复小循环）——完整设计见 [docs/BRAIN.md](./BRAIN.md)（结论：采纳 goal/plan/loop 概念，不采纳自由 agent loop 机制）。

### 3.4 执行模型 vs 中枢模型分工表

| 任务 | 模型 | 温度 | 说明 |
|---|---|---|---|
| 写作（writer/patch） | EXEC | 0.9 | 流式，240s 超时，字数治理保留 |
| 审查（critic） | EXEC | 0.4 | 动态准则 + 评分 |
| 记账（chronicler） | EXEC | 0.2 | 精确结构化，字段级守卫 |
| 摘要（memory） | EXEC | 0.3 | 失败降级截断 |
| 规划（planner） | EXEC | 0.5–0.8 | 兜底章纲 |
| 抽卡（cards） | EXEC | 1.0 | 高创意，可抛错 |
| 分镜（media） | EXEC | 0.5 | 候选池 + 去重，retries=2 |
| 评估（eval） | BRAIN（可选） | 0.3 | 整书判断，带缓存 |
| 状态变更闸门（steering+） | BRAIN | 0.2 | 冲突/影响评估，失败降级确定性部分 |
| 跨章一致性/节奏（新） | BRAIN | 0.5 | 每 N 章或弧边界 |

（数值沿用现状，作为默认画像；均可 env 覆盖。）

### 3.5 调用规范（TaskProfile 化）

`src/api/modelconfig.ts` 提供：

```ts
type TaskProfile = {
  model: "exec" | "brain";      // 或具体模型名
  temperature: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  fallback?: "throw" | "truncate" | "default";  // 失败降级语义
  json?: boolean;               // 走 chatJson 修复
};
const TASK_PROFILES: Record<string, TaskProfile> = {
  writer:    { model: "exec", temperature: 0.9, maxTokens: 60000, timeoutMs: 240_000, fallback: "retry-once+extend" },
  critic:    { model: "exec", temperature: 0.4, maxTokens: 60000, fallback: "throw" },
  chronicler:{ model: "exec", temperature: 0.2, maxTokens: 60000, json: true, fallback: "truncate" },
  // ... 13+ 任务全部入表
  brainGate: { model: "brain", temperature: 0.2, maxTokens: 60000, fallback: "deterministic" },
};
```

所有调用点改为 `chatJson(msgs, profileName)` / `chat(msgs, profileName)`，从表取参，删除内联硬编码。分镜独有外层重试收编进 `retries` 语义（统一"每任务一次重试契约"，不再 3×2×2 叠加）。

### 3.6 状态变更收敛设计

**目标**：所有写 WorldState 的路径收敛到单一接口，中枢模型在闸门点把关。

```
routes / director / chronicler / planner / steering / integrity / cards
        │  请求变更（描述 + 目标字段 + 既有状态引用）
        ▼
  applyStateChange(w, { actor, field, value, meta })
        │  ① 确定性预检（字段锁/长度/clamp/去重/ID 校验 —— 现 chronicler 守卫复用）
        │  ② AGNES_BRAIN_GATE=on 且变更分级 ≥ L2 → 中枢模型审查（冲突/既成事实/全局影响）
        │     · 通过 → 继续；   · 拒绝/修正 → 返回修正指令或记入 changeLog
        │  ③ 写字段 + 写 changeLog(actor/strategy) + 保存
        ▼
  WorldState
```

- **收编范围**：routes 的 30+ 处直接改字段（伏笔增删改/蓝图/章纲/lore/debt fix/提案确认/autoGacha 覆盖等）改为调用 `applyStateChange`；chronicler/planner 保留内部守卫，但对外暴露的独立写入口（resettle/blueprint/plans 路由）也统一走闸门。
- **闸门默认 off**（`AGNES_BRAIN_GATE=off`）：P0/P1 阶段零行为变化，只做结构收敛；开启后才引入中枢模型审查，控制成本。
- **分级复用**：steering 的 `classifyWorldPatch`（L0/L2 判定）作为闸门分级基础。
- **变更日志增强**：`ChangeLogEntry` 已含 `actor/strategy`，扩展 `reason`（中枢模型审查结论）字段（可选）。

---

## 4. 落地路径

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 配置化** | `AgnesOptions.model`；`AGNES_BRAIN_MODEL/AGNES_EXEC_MODEL`；`resolveModel`；默认回落 AGNES_MODEL | 现有部署零改动跑通；`bun test` 全绿 |
| **P1 任务画像** | `TASK_PROFILES` 表；13+ 调用点改传 profileName；删内联 temperature/timeout/retries；分镜重试收编 | 行为等价（快照测试对比 prompt/参数）；全量测试绿 |
| **P2 主脑启用** | 中枢模型接入：章末一致性审查 + 评估模型升级 + 跨章分布择优（分镜候选池与"已用段落"全局共享） | `AGNES_BRAIN_GATE` 可开关；审查产生修正指令可回流 mergeTasks/干预 |
| **P3 收敛状态写** | `applyStateChange` 单一接口；routes 30+ 处收编；闸门分级接入；`changeLog.reason` | 无 routes 直接改叙事字段；闸门 on 时 L2+ 变更必经中枢审查 |

（P0–P3 均不改前端协议；媒体模型 images/videos 独立演进不受影响。）

## 5. 验收标准（整体）

1. `.env` 配置 `AGNES_BRAIN_MODEL / AGNES_EXEC_MODEL / AGNES_BRAIN_GATE` 生效，未配置时行为与现状一致。
2. 13+ 文本调用点无内联 temperature/timeout/retries（全部入 TASK_PROFILES）。
3. `AGNES_BRAIN_GATE=on` 时，L2+ 状态变更必经中枢模型审查并写 changeLog；`off` 时零行为变化。
4. `bun test` 全量 + `bun run typecheck` 全绿；前端分镜/插画/视频流程无回归。
5. 文档与本设计一致（本文即基线）。
6. **质量不退化**：每 P 阶段合入前须通过 [docs/QUALITY-BASELINE.md](./QUALITY-BASELINE.md) §4 复测（轻/全按 §4.1），overall/重点维/一致性/成本指标满足 §4.2 判定规则——未建基线（P-1）前不得启动 P0。

---

## 附：与现有文档的关系

- `docs/FEATURES.md`：功能清单（用户可见能力），本文不重复。
- `docs/REQUIREMENTS.md`：需求规格，本文补充"模型路由/中枢/状态闸门"非功能需求。
- `docs/ENGINE.md`：引擎机制，本文补充"模型调用架构"与"状态变更收敛"章节。
- `docs/COUPLING.md`：指令 → UI 更新映射（`uiImpact`）与章节媒体资源耦合/保存前预警，是本文"状态变更收敛"在 UI 与媒体资源维度的延伸。
- `docs/BRAIN.md`：中枢治理循环与 Goal 模型（BookGoal/治理计划/有界 loop/权限矩阵/失败语义），是本文 §3.3 中枢职责的三原语展开；各 P 阶段的增量交付见其 §8。
- `docs/QUALITY-BASELINE.md`：重构启动前提（P-1）——质量验收基线与每阶段复测判定规则，为本文验收标准第 6 条的执行依据。
