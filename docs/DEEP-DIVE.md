# 主脑中枢模型 + 状态变更收敛 — 细致分析（DEEP-DIVE）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（v3 设计基线，本文是其展开）、[docs/BRAIN.md](./BRAIN.md)（中枢治理循环与 Goal 模型，本文触发点失败语义的遵循对象）
> 配套文档：[docs/FLOWS.md](./FLOWS.md)（可视化 flow，本文各章对应）
> 状态：**设计提案，尚未实现**。本文只整理架构、不修改代码。
> 目的：把 ARCHITECTURE.md 第 3 章（主脑中枢模型）与 3.6 节（状态变更收敛）从"设计蓝图"细化到"可直接实施"的粒度——每个触发点的输入/输出/失败语义、可复用机制清单、收编路径与优先级。

---

## 1. 主脑触发点细化（Brain Trigger Points）

ARCHITECTURE.md 提出五个候选触发点。本节逐一细化：**触发位置（现状代码）**、**输入上下文**、**输出**、**失败语义**、**成本与回滚**。

> 治理循环视角：五个触发点即中枢有界治理循环的事件源（每触发点=循环一步，跨事件连续性由治理任务通道承载）；失败语义被 [docs/BRAIN.md](./BRAIN.md) §7.1 作为降级基线遵循。

### 1.1 章末一致性审查（commitChapter 内，P1 窗口）

| 维度 | 内容 |
|---|---|
| 触发位置 | `director.commitChapter`（`director.ts:364-422`）在 ④ `settleChapter` 之后、⑤ `registerDebt` 之前（`:387-395`） |
| 输入上下文 | 定稿正文 `chapter.text`、`settleChapter` 返回的 `delta`（含全部账本旧值快照）、活跃伏笔账本、进行中弧线、本章 `plan.goal/beats` |
| 输出 | ① 批准 → 继续提交；② 修正指令 → 注入 `mergeTasks`（复用 `steering.applyStrategy` merge 语义）或记为 L2 干预；③ 否决 → 触发回滚 |
| 失败语义 | 中枢审查 LLM 调用失败 → **降级放行**（不阻塞提交），`changeLog.reason = "brain_unavailable"`；与 `impactReport` 现有 try-catch 降级为空（`steering.ts:96-116`）保持一致 |
| 回滚成本 | **P1 窗口：内存可回滚**——`chapterDeltas[index]` 已含全部旧值，可调用 `applyChapterDeltaRevert`（`integrity.ts:31-133`，git revert 语义：伏笔/角色 status/look/全局状态/弧线/关系/规则/提案，带字段级冲突检查 `hasLaterChange` `:15-21`）回滚账本，并自行移除 `world.chapters` 条目与 `chapterSummaries[index]`（参考 `deleteChapterCascade`，`integrity.ts:345`）；**尚未持久化** |

关键前提（来自调研）：流式写作在 `writeChapter`（`writer.ts:117-160`，chatStream）内完成，**先于** commitChapter（`writeOneChapter` 阶段②，`director.ts:250-256`）。因此 commitChapter 内任何点都不在低延迟流式关键路径上，插入同步审查不破坏流式体验。

### 1.2 弧边界审批（handleArcBoundary 前置）

| 维度 | 内容 |
|---|---|
| 触发位置 | `director.commitChapter` ⑥ `markChapterDone` → 弧全部章纲 done → `handleArcBoundary`（`director.ts:400`，失败被 catch 不阻塞 `:401-403`） |
| 现状成本 | `handleArcBoundary`（`planner.ts:206-232`）在 commit 同步路径上串行 3-4 次 LLM：① `arc.summary = summarizeRange`（`memory.ts:66-81`）→ ② 卷边界时 `vol.summary = summarizeRange`（`:220`）+ `updateCompass`（`planner.ts:240-263`）→ ③ `expandArc`（`planner.ts:118-170`，生成 3-6 章章纲，**内部 `saveWorld` `:168`**）→ ④ 末尾 `saveWorld` `:231` |
| 审查插入点 | **`expandArc` 之前**——批准展开骨架弧 / 修正展开方向（章数、节奏、与全局蓝图一致性） |
| 失败语义（现状缺陷） | `handleArcBoundary` 失败被 catch 后，章纲已核销 done，`markChapterDone` 下回合返回 `null` **不会自动重试**（注释"下回合重试"与实现不符）；弧 summary/卷 summary/compass 会永久缺失，仅靠 `ensureChapterPlan` 兜底章纲缺口（`planner.ts:182-189`） |
| 架构建议 | 把该块**拆出 commitChapter 主序列**：延迟到下一章 `ensureChapterPlan` 前补跑，或拆为可独立重试的异步任务；中枢审批在其中扮演"展开前放行"角色。这是 commit 主链路上最大延迟与持久化不确定性来源，是首选改造对象 |

### 1.3 状态变更闸门（applyStateChange 内，分级 ≥ L2）

| 维度 | 内容 |
|---|---|
| 触发位置 | 新接口 `applyStateChange`（见第 2 章），复用 `classifyWorldPatch`（`steering.ts:61-63`）做分级 |
| 输入上下文 | 变更描述 `{ actor, field, value, meta }` + 既有状态引用 `w` |
| 输出 | ① 批准 → 继续写字段；② 修正指令 → 返回修正后的变更（不改状态）；③ 拒绝 → 记入 `changeLog`（`reason` 字段） |
| 失败语义 | `AGNES_BRAIN_GATE=on` 且审查失败 → 降级为**确定性预检通过即放行**（闸门是"加保险"不是"拦路虎"）；`off` 时零行为变化 |
| 成本控制 | 闸门只对 **L2+** 变更开；L0 直通。分级只产出 L0/L2（L1/L3 是预留枚举，`steering.ts:42`），因此开启成本可预期 |

### 1.4 整书评估（evaluateBook）

| 维度 | 内容 |
|---|---|
| 触发位置 | `eval.evaluateBook`（`eval.ts`），autorun 每 N 章调用（`autorun.ts:171` 关联） |
| 输入上下文 | 8 维评估 userMsg（含 open 质量债注入，`eval.ts:64`）；缓存指纹 `evalFingerprint`（`eval.ts:106-120`，open 债务变化 → 缓存失效重评） |
| 输出 | 8 维评分 + findings；可选升级为中枢模型（更强推理）提升判断质量 |
| 失败语义 | 评估失败不阻塞连载（现有 try-catch）；缓存兜底复用上次结果 |
| 说明 | 这是**可选**升级点——executor 已能评估，中枢模型只提升质量，收益/成本比最低，放 P2 后期 |

### 1.5 跨章候选池协调（分镜跨次去重）

| 维度 | 内容 |
|---|---|
| 触发位置 | `media.planScenesOnce`（`media.ts:819/861`，候选池 `candidate = max(3, remaining)`） |
| 现状 | 候选池去重是**单任务局部**的：`normalizeScenePlans` 收到 `usedAnchors` 排除集，但跨多次生成、跨章节的"已用段落"未全局共享（任务 2 已解决单次/相邻重复，跨章分布未做） |
| 中枢职责（新） | 把"已用段落"提升为**全局账本**（`chapters[].media[].anchorText` 汇总），中枢模型（或确定性层）在候选池择优前先过滤全局已用段，避免跨章/跨次重复选段 |
| 失败语义 | 确定性层兜底（现有去重逻辑保留），中枢模型仅做排序优化，失败零影响 |

### 1.6 commitChapter 三个可插入审查点对比（决策表）

| 审查点 | 位置 | 副作用 | 回滚成本 | 推荐用途 |
|---|---|---|---|---|
| **P0** | `director.ts:381-383` 之间（构造 chapter 后、`chapters.push` 前） | 零副作用 | 无需回滚（未动任何字段） | 确定性预检（结构/长度/锚点/越界） |
| **P1** | `director.ts:387-395` 之间（`settleChapter` 后、`registerDebt` 前） | 内存可回滚（`chapterDeltas` 已含旧值快照） | 低：`applyChapterDeltaRevert` + 移除 chapters 条目 + 移除 summary | **主脑审查主窗口**（本文 1.1） |
| **P2** | `director.ts:404-405` 之间（`handleArcBoundary` 后、`nextChapter++` 前） | 已有持久化副作用（`handleArcBoundary` 内部 `expandArc` 已 `saveWorld`，`planner.ts:168/231`） | 高：需额外回滚磁盘上的 chapterPlans/storyArcs | 不推荐做审查否决点；仅做"提交前最终一致性校验"（确定性） |

---

## 2. applyStateChange 单一写接口设计

### 2.1 接口签名（提案）

```ts
// src/api/statechange.ts（新文件）
type ChangeActor = "user" | "ai" | "brain" | "integrity" | "system";

type StateChange = {
  actor: ChangeActor;
  field: string;        // 目标字段路径，如 "foreshadowing[3].status"、"characters[柳青霜].look"
  value: unknown;
  meta?: {
    route?: string;     // 来源端点，如 "/api/novel/foreshadow"
    chapterIndex?: number;
    reason?: string;    // 业务语义说明（供中枢审查与 changeLog）
    original?: unknown; // 变更前旧值（可选，缺省由实现按 field 路径快照）
  };
};

type ChangeResult =
  | { ok: true; applied: true }
  | { ok: true; applied: false; reason: string }      // 拒绝/被闸门修正，未写字段
  | { ok: false; error: string };                      // 预检失败/异常

function applyStateChange(w: WorldState, change: StateChange): ChangeResult;
```

### 2.2 执行流水线（5 步）

```
applyStateChange(w, change)
  ├─ ① 分级判定  — 复用 classifyWorldPatch（steering.ts:61-63）扩展为通用变更描述
  ├─ ② 确定性预检 — 复用 chronicler 守卫清单（见 2.3），不通过 → { ok:false }
  ├─ ③ 闸门审查  — AGNES_BRAIN_GATE=on 且分级 ≥ L2 → 中枢模型审查（冲突/既成事实/全局影响）
  │                · 批准 → 继续；修正 → 返回修正指令（不改状态）；拒绝 → { applied:false, reason }
  ├─ ④ 写字段 + logChange（steering.ts:34-39，actor/strategy + 新 reason 字段）
  └─ ⑤ 收尾     — alignWorld + saveWorld（统一收尾一致性，见 3.3）
```

### 2.3 确定性预检清单（复用 chronicler 现有守卫）

| 守卫 | 位置 | 适用字段 |
|---|---|---|
| `isLocked` 字段锁 | `chronicler.ts:79-81`（消费 `lockedFields`，`world.ts:309/354`） | `characters[].status/look` |
| 别名归一 `normCharName` | `chronicler.ts:66-68`（「阿/小/老」前缀+空白） | 所有按角色名索引的变更 |
| `findCharacter` 精确匹配 | `chronicler.ts:70-77` | 角色相关字段 |
| 伏笔 ID 精确匹配 | `chronicler.ts:155` | `foreshadowing` 回收 |
| 弧线 ID 精确匹配 | `chronicler.ts:251` | `plotThreads` 更新 |
| 长度 clamp | 散落 `chronicler.ts`：status/look 120（`:181`）、relations desc 40（`:207`）、rules 80（`:222`）、world current 200（`:246`）、plotThreads note 120（`:260`）、exit reason 100（`:231`） | 对应文本字段 |
| 数量上限 | `slice(0, g.maxForeshadowPerChapter)`（`:147`）、rules ≤3/章 ≤12/总（`:222`）、qualityDebt ≤200（`director.ts:187`） | 数组类字段 |
| 文本去重 | 伏笔 key 去空白（`:147`）、ruleSet 去重（`:222`） | 新增类字段 |

> 原则：**新增接口不新造守卫**，全部复用 chronicler/integrity 已有逻辑；applyStateChange 只做编排。

### 2.4 分级判定（classifyWorldPatch 的扩展）

- 现状：`classifyWorldPatch(w, patch)`（`steering.ts:61-63`）只依据两个字段——`patch.characters[].id` 查 `appearedIn?.length` 非空（已登场 → 回溯）、`patch.setting.rules` 存在且 `w.chapters.length > 0`（改世界观规则 → 回溯）；返回 `"L2" : "L0"`。
- 扩展建议：保持 `isRetroactivePatch`（`steering.ts:45-59`）核心判定，把 patch 类型放宽为 `StateChange.field` 的通用描述（字段路径前缀 → 角色/设定/账本类别映射），L1/L3 预留枚举暂不启用。
- 分级结果：`L0` 直通（不触发闸门）、`L2` 走闸门；确定性部分（`appearedIn` 章集合 + `foreshadow.plantedAt/resolvedAt` 章集合，`steering.ts:84-93`）可继续作为影响报告确定性通道。

### 2.5 changeLog.reason 扩展

- 现状：`ChangeLogEntry = { at, chapter, actor: "user"|"ai", kind, detail, strategy?: "merge"|"rewrite"|"abort" }`（`world.ts:311-318`），上限 500 条（`steering.ts:34-39`）。
- 扩展：`ChangeLogEntry` 增加 `reason?: string`——中枢模型审查结论（批准依据/拒绝理由/降级原因），可选字段，向后兼容。

---

## 3. routes 写点收编清单（32 个写点 → applyStateChange）

### 3.1 风险分级总表

| 风险级 | 端点 | 改的字段 | 是否 alignWorld | 是否绕 director |
|---|---|---|---|---|
| **低（媒体类）** | `/api/novel/media/generate`（routes.ts:1222/1258） | `chapters[].media` | ❌ | 否 |
| | `/api/novel/media/status`（:1361-1362,1379,1394-1395） | `chapters[].media[].status/error/path` | ❌ | 否 |
| | `/api/novel/media/regenerate`（:1476-1484） | `chapters[].media[].prompt/path/videoId/status` | ❌ | 否 |
| | `/api/novel/media/delete`（:1522） | `chapters[].media`（filter） | ❌ | 否 |
| | `/api/novel/image` cover/character（:1098,1112） | `w.cover` / `characters[].image` | ❌ | 否 |
| | `/api/novel/character/portrait`（:1144） | `characters[].portrait` | ❌ | 否 |
| | `/api/novel/cover/upload`（:1574） | `w.cover` | ❌ | 否 |
| | `schedulePortraitFor`（:133，非端点） | `characters[].portrait` | ❌ | 否 |
| **中（账本/设定类）** | `/api/novel/foreshadow`（:359,364-366,376） | `w.foreshadowing` | ✅（:381） | 否 |
| | `/api/novel/lore`（:547,550） | `w.lore` | ✅（:563） | 否 |
| | `/api/novel/world`（:628-643） | characters/outline/setting/title/fieldLocks | ✅（:632） | 否（走 director.editWorld + steering） |
| | `/api/novel/style`（:827） | `w.gen.styleSample/styleFingerprint` | ❌ | 否 |
| | `/api/novel/debt` fix/ignore（:1055-1062） | `qualityDebt[].status` / `chapterPlans[].mergeTasks` / `outline` | ❌ | 否 |
| | `/api/novel/blueprint` edit（:434-437） | `blueprint.compass/progressContract/mainPlot/ending` | ❌ | 否 |
| | `/api/novel/plans` edit（:479-481） | `chapterPlans[].goal/beats/hookType` | ❌ | 否 |
| | `/api/novel/lock`（:707） | `lockedFields`（setFieldLock） | ❌ | 否 |
| | `/api/novel/proposal` confirm/reject（:735-753） | `characters` push / `characterProposals[].status` / `changeLog` | ❌ | 否 |
| **高（独立写入口）** | `/api/novel/blueprint` confirm（:429 → planner.confirmBlueprint :91-106） | blueprint/storyArcs/chapterPlans | ❌ | ✅（内部 saveWorld） |
| | `/api/novel/plans` expand（:471 → planner.expandArc :118-170） | chapterPlans / storyArcs[].status | ❌ | ✅（内部 saveWorld :168） |
| | `/api/novel/chapter/resettle`（:974 → chronicler.settleChapter :315-341） | 账本重写 + chapterDeltas | ❌ | ✅（routes 显式 saveWorld） |
| | `/api/novel/integrity` resettle（:1745-1746 → resetChapterLedger + settleChapter） | 账本重写 + chapterDeltas | ❌ | ✅（routes 显式 saveWorld） |

（另有 4 个低风险非账本写点：`/api/novel/state` 自愈 :252-255、`/api/novel/auto/start` :869/885/899、`/api/novel/auto/skip` :939-940、`/api/novel/rewrite` :996/1010——改 `appearedIn`/`nextChapter`/`autoGacha`/`chapterPlans` splice/`rewriteQueue`，建议 P3 一并收编。）

### 3.2 收编优先级（对齐 ARCHITECTURE P0-P3）

| 阶段 | 收编范围 | 行为 |
|---|---|---|
| P0 | 不动 | 仅加 `AgnesOptions.model` + env 配置，零行为变化 |
| P1 | 中风险 8 个端点改走 `applyStateChange`（闸门 off） | 只收敛写路径，不引入审查；`bun test` 全绿即行为等价 |
| P2 | 高风险 4 个独立写入口 | 改包装：`planner.confirmBlueprint/expandArc` 内部改为调用 `applyStateChange` 或由 routes 统一走闸门；落盘机制三归一（见 3.3） |
| P3 | 全部 32 个写点 + 低风险 4 个 | 闸门分级接入；无 routes 直接改叙事字段 |

### 3.3 落盘机制归一 + alignWorld 收尾一致性规范

- **落盘三归一**：现状三种落盘并存——① planner 内部 `saveWorld`（`planner.ts:106,168`）、② chronicler 不落盘由 routes 显式 `saveWorld`（`routes.ts:974,1746`）、③ routes 直接 `saveWorld`。收编后统一为：**业务函数不落盘，由 `applyStateChange` 调用方（routes）统一 `saveWorld`**（与 director 管线一致），planner 内部 `saveWorld` 移除。
- **alignWorld 收尾**：现状仅 3 端点调用 `alignWorld`（foreshadow :381、lore :563、world :632），其余 24 个写点未对齐。规范：所有经 `applyStateChange` 的写点在落盘前统一 `alignWorld`（或由 `applyStateChange` 第 ⑤ 步统一收尾）；媒体类低风险写点（只碰 `chapters[].media`）可豁免——它们不涉全局账本，调用 `touchChapter` 同步 delta 快照即可（现状 `touchChapter` 已承担）。

---

## 4. 与现有机制的关系（复用清单）

| 已有机制 | 位置 | 在本文中的复用 |
|---|---|---|
| steering 分级/影响报告/三选一策略 | `steering.ts:45-156` | applyStateChange 分级与策略落地（不重写） |
| chronicler 字段级守卫 | `chronicler.ts:62-312` | applyStateChange 确定性预检（不重写） |
| `applyChapterDeltaRevert` | `integrity.ts:31-133` | P1 审查否决回滚（不重写） |
| `changeLog` 变更日志 | `world.ts:311-318` / `steering.ts:34-39` | 扩展 `reason` 字段（向后兼容） |
| `classifyWorldPatch` | `steering.ts:61-63` | 扩展为通用变更分级 |
| `mergeTasks` / `rewriteQueue` | `world.ts:223-231` / `steering.ts:141-156` | 中枢修正指令的落地通道（已贯通 writer `:68-72`、critic `:85-87`） |

## 5. 实施检查清单（对应 ARCHITECTURE P0-P3）

- [ ] P0：`AgnesOptions.model`、`AGNES_BRAIN_MODEL/AGNES_EXEC_MODEL`、`resolveModel`（回落 `AGNES_MODEL`）
- [ ] P1：`TASK_PROFILES` 表 + 13+ 调用点收编 + 新增 `src/api/statechange.ts`（applyStateChange，闸门 off 空转）
- [ ] P2：章末审查（1.1 P1 窗口）+ 弧边界审批（1.2，先拆出主序列）+ 评估升级（1.4）+ 跨章候选池（1.5）
- [ ] P3：32 写点全收编 + 落盘三归一 + alignWorld 全覆盖 + `changeLog.reason`
