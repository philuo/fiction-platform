# 中枢治理循环与 Goal 模型设计（BRAIN）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（主脑中枢模型设计基线）、[docs/DEEP-DIVE.md](./DEEP-DIVE.md)（触发点/状态闸门细化）、[docs/INTERVENTION.md](./INTERVENTION.md)（人工干预治理）、[docs/HARNESS.md](./HARNESS.md)（87 条指令注册表）、[docs/COUPLING.md](./COUPLING.md)（UI 映射与媒体耦合）
> 状态：**设计提案，尚未实现**。本文只整理架构，不修改代码。
> 目的：回答一个设计问题——**中枢（brain/overseer）是否应该像现代编码 Agent（Claude Code / Codex / Reasonix 类工具）那样支持显式的 goal、plan、loop？** 结论（§2）：**采纳概念，不采纳机制**——goal/plan/loop 三个原语在本系统有高度映射且值得显式化，但自由 agent loop 机制因四个结构性差异不适用；中枢的正确形态是**事件驱动的有界治理循环 + 统一 Goal 对象 + 复用既有任务通道的治理计划**。

---

## 1. 背景：中枢现状定位

ARCHITECTURE §3.3 已定义中枢职责：章末一致性审查、弧边界审批、状态变更闸门、整书评估、跨章协调；且明确"**不写正文、只做决策/审批/把关**"。DEEP-DIVE 细化了 5 个触发点的输入/输出/失败语义。

但现有设计把中枢刻画为**无状态的一次性审查者**：每次触发独立审查、不记忆跨章意图、不主动发起任务。这留下三个未回答的问题：

1. 中枢"为这本书把关"，那么**这本书要走到哪里**（完结判定、质量目标、预算）由谁统一持有？现状散落四处（见 §3）。
2. 中枢审查产出的修正指令（mergeTasks/rewriteQueue）由谁**跟踪消费与再评估**？现状无主。
3. 干预后的对齐管线（INTERVENTION §4）是"跑一遍就完"还是"验证通过才完"？现状是前者。

本文用 goal/plan/loop 三个原语回答这三个问题。

---

## 2. 对比分析：goal/plan/loop 的映射与四个结构性差异

### 2.1 映射表：三个概念在本系统"暗含但分散"

| Agent 概念 | Claude Code/Codex/Reasonix 类工具 | 本系统现状 | 代码锚点 | 缺口 |
|---|---|---|---|---|
| **goal** | 用户请求 → 任务目标，终态可判定（测试绿/交付完成），每轮报告 disposition（continue/complete/blocked） | 散落四处：进度承诺、完结判定、连载停下策略、评估熔断线 | `progressContract`（world.ts:282，写作注入 planner.ts:130）、`isBookComplete`（planner.ts:281）、autorun 停下策略（autorun.ts:104-191）、评分熔断（autorun.ts:133） | 无统一显式 goal 对象；"结构完结"与"质量目标"与"预算"未收敛到一处；无 disposition 语义 |
| **plan** | todo list / plan 审批，多步任务的显式分解 | planner 已有完整计划层级：blueprint → storyArcs → chapterPlans（本质就是**叙事 todo list**）；另有干预弥合任务 mergeTasks、重写队列 rewriteQueue、质量债 qualityDebt | planner.ts（蓝图/弧/章纲）、world.ts:223-231（chapterPlans）、steering.ts:138-156（mergeTasks/rewriteQueue）、director.ts:163-187（qualityDebt） | 叙事计划已有且**不应由中枢重造**；缺的是**中枢自己的治理计划**（何时审查、何时对齐、谁进重写队列、修复是否验证通过） |
| **loop** | 自由 tool-calling 循环直至目标达成或预算耗尽 | 两个既有**有界**循环：章内 review-patch ≤2 轮（director.ts reviewFixLoop，HARNESS N10）+ autorun ≤30 章主循环（autorun.ts:104，HARNESS N03） | director.ts（N10）、autorun.ts:79-104（maxChapters ≤30 硬上限） | 中枢无循环语义——是触发点上的一次性函数，跨章治理意图无处安放 |

**实证结论**：本系统不是"缺 goal/plan/loop"，而是**三者已存在但未显式化、未归一**——goal 散在四个机制里，plan 分裂为"叙事计划（planner）"与"治理任务（steering/director）"两套互不感知的队列，loop 只存在于写作层（章内/连载）而治理层没有。

### 2.2 四个结构性差异：为什么自由 agent loop 不适用

1. **步成本与配额**：编码 agent 的多数 step（读文件/grep/lsp）近乎免费，只有生成消耗 token，自由探索成本可控；本系统**每个 step 都是一次 LLM 调用**，且免费额度仅 30 RPM（`limiter` 全局限流，HARNESS S10）。自由 loop 的"多试几步"会直接烧穿配额——autorun 的熔断策略（quota/score，autorun.ts:29）和 maxChapters≤30 硬上限恰恰是被迫加上的配额护栏，证明该约束是硬性的。
2. **可逆性**：代码有 git，试错近零成本，"尝试→失败→回滚"是自由 loop 的根基；小说的已提交章节**半不可逆**——`chapterDeltas` 只回退账本（integrity.ts:31-141），正文回退要走 versions 管线，且回滚窗口受"干预完成～下一章写入"约束（INTERVENTION §5）。中枢不能"先改了再说"。
3. **验证信号**：代码靠**确定性测试**收敛（"全绿即停"是 loop 的天然终止条件）；小说只有**统计性评估**——critic 5 维（verdict 决策表由代码覆盖 LLM）、eval 8 维（eval.ts，LLM-as-Judge）。loop 终止只能靠**阈值 + 预算**双约束，无法靠"验证通过"单条件。
4. **任务开放性**：编码任务开放异构（读码/写码/调试/重构各不相同），值得自由规划；写章是**高度结构化的重复劳动**（每章同一条管线，HARNESS N02 十步）。固定管线 + 治理介入点的收益/复杂度比远优于自由循环。

### 2.3 结论：采纳概念，不采纳机制（混合形态）

- **采纳**：显式 goal 对象（§3）、中枢自己的治理计划（§4）、有界治理循环（§5）——补齐"目标归一、任务有主、治理有环"三个缺口。
- **不采纳**：自由 tool-calling loop、开放式 replanning、"尝试→回滚"探索范式——四个结构性差异决定了其成本不可控。
- **中枢形态不变**：保持 ARCHITECTURE §3.3 定位（决策/审批/调度，不写正文）；goal/plan/loop 是**治理层的三个数据结构**，不是让中枢变成写作 agent。

---

## 3. BookGoal 原语：统一目标对象

### 3.1 现状散落与收编

| 现状机制 | 位置 | 承担的 goal 片段 | 收编后角色 |
|---|---|---|---|
| `progressContract`（进度承诺） | world.ts:282；注入 planner.ts:130；编辑 routes.ts:435 | 前 N 章节奏约定（结构目标） | BookGoal.structure 的派生文本 |
| `isBookComplete` | planner.ts:281 | 结构完结判定（弧全 resolved） | BookGoal.complete 判定之一 |
| autorun 停下策略 | autorun.ts:14-15（maxChapters/stopAvgScore）、:29（reason 枚举）、:104-191 | 连载预算（章数上限）+ 质量熔断线 | BookGoal.budget + BookGoal.quality 的执行端 |
| eval 8 维 | eval.ts（dimensions/overall） | 质量度量 | BookGoal.quality 的度量来源 |
| 审查地板/严格度 | critic（genProfile.reviewStrictness 驱动地板 4/6/7） | 单章质量下限 | BookGoal.quality 的章级分量 |

### 3.2 BookGoal 结构（提案，可选字段向后兼容）

```ts
type BookGoal = {
  // 结构目标
  structure: {
    targetChapters?: number;        // 目标章数（缺省 = 蓝图 estChapters 汇总）
    targetVolumes?: number;         // 目标卷数
    progressContract?: string;      // 收编既有字段
  };
  // 质量目标
  quality: {
    minOverall?: number;            // eval overall 下限（对齐 stopAvgScore 语义）
    floorDimensions?: { name: string; min: number }[];  // 单维地板（对齐 eval 8 维名）
    chapterFloor?: number;          // 单章 critic 地板（对齐严格度 4/6/7）
  };
  // 预算
  budget: {
    maxChaptersPerRun?: number;     // 收编 maxChapters（≤30）
    quotaGuard?: boolean;           // 配额熔断开关（收编 autorun quota 语义）
  };
  // 完结条件（complete = structure 达成 ∧ quality 达标；blocked = budget 耗尽或熔断）
  completion: "structure" | "structure+quality";
};
```

挂载 `WorldState.goal?: BookGoal`（可选字段，旧存档无感；未设置时各字段回落现状默认——progressContract 读 blueprint、熔断读 autorun 入参，**行为零变化**）。

> `quality.minOverall/floorDimensions` 的初始默认**以 QUALITY-BASELINE.md 基线作品的读数为基准**（P-1 产出）——goal 与基线同源，避免目标值凭空设定。

### 3.3 goal disposition 映射（Reasonix goal 语义的本地化）

借鉴 Reasonix 的 turn disposition（continue/complete/blocked），定义**每章提交后**中枢对 goal 的三态报告：

| disposition | 判定 | 现状对应 |
|---|---|---|
| **continue** | 未完结且未熔断 | autorun 循环继续（autorun.ts:104） |
| **complete** | `isBookComplete(w)` ∧ eval overall ≥ minOverall（若设置） | reason="complete"（autorun.ts:110），补质量合取 |
| **blocked** | 配额耗尽 / 评分熔断（连续 2 章低于地板，autorun.ts:133）/ 用户停止 / 审查未过暂存 | reason="quota"/"score"/"stopped"/"review" |

**价值**：现状 autorun 的 reason 枚举是"为什么停了"的事后描述；BookGoal disposition 是"离目标还有多远"的持续度量——中枢章末审查（DEEP-DIVE 1.1）的输出可附带 disposition，使连载控制台（AutoRunPanel，COUPLING U16）能展示"目标进度"而非仅"已写 N 章"。

---

## 4. 治理计划原语：中枢的任务队列（复用，不新造）

### 4.1 职责边界：叙事计划归 planner，治理计划归中枢

| 计划类别 | 所有者 | 内容 | 通道 |
|---|---|---|---|
| 叙事计划 | planner | blueprint/storyArcs/chapterPlans——"接下来写什么" | planner.ts（本文不触碰） |
| 治理计划 | 中枢 | "接下来要修什么/审什么/对齐什么"——审查修正、重写、对齐验证 | **复用既有三通道**（4.2） |

中枢**不重造叙事计划**（那是 W03-W11 的职责，重造即回到"多写者"老路，ARCHITECTURE §2.2 的诊断对象）。

### 4.2 复用既有三通道（生产者 + 调度者，零新机制）

| 通道 | 现状生产者 | 现状消费者 | 中枢新角色 |
|---|---|---|---|
| `mergeTasks`（弥合任务） | steering merge 策略（steering.ts:138-149）、debt fix（routes）、质量债 | writer 写作指令注入（writer.ts:68-72）、critic 附带（critic.ts:85-87） | **生产者**（章末审查修正指令，DEEP-DIVE 1.1 已规划）+ **核销者**（下一章 settle 后确认弥合任务被消费） |
| `rewriteQueue`（重写队列） | steering rewrite 策略（steering.ts:151-156） | `/api/novel/rewrite` 逐章 regenerate（routes.ts:978-1005，HARNESS G06，手动触发） | **调度者**（autopilot 下自动消费，FEATURES 迭代建议 1 的中枢化版本）+ **验收者**（重写后审查结果回填队列状态） |
| `qualityDebt`（质量债） | registerDebt（director.ts:163-187） | debt fix/ignore（用户）、eval 注入 open 债务（eval.ts:64） | **跟踪者**（debt 与 mergeTasks 的转化规则：fix 注入后 status 流转由中枢核销） |

**治理计划对象（提案）**：不新增存储结构，而是在 `changeLog` 之上定义视图——中枢产出的每条治理任务记 `changeLog`（kind=gov-task，detail 含通道与目标章号），治理计划 = changeLog 中未核销的 gov-task 集合。复用 changeLog 上限 500 与 reason 扩展（DEEP-DIVE 2.5），并为 COUPLING §2.6 建议的 U20 变更时间线页签提供数据源。

---

## 5. 有界治理 loop：事件驱动，不跑热循环

### 5.1 形态：触发点即循环步

中枢**不启动自己的 while 循环**（那是 autorun 的形态，且受 30 RPM 约束）。治理循环的每一步 = 既有 5 个触发点（ARCHITECTURE §3.3 / DEEP-DIVE §1）的一次事件驱动执行：

```
事件源（章提交/弧边界/状态变更请求/评估请求/分镜请求）
   → 中枢按触发点协议执行一步（审查/审批/闸门/评估/协调）
   → 产出：disposition（goal 度量）+ 治理任务（§4 三通道）+ changeLog 记录
   → 等待下一事件（无事件时零消耗）
```

**循环的"环"体现在跨事件的连续性**：本次审查产出的 mergeTasks 在下次写作时被消费、消费结果在下次 settle 审查时被核销——治理意图跨章传递，但每一步都是被动触发、有界、可预算的。

### 5.2 预算与终止条件（复用停下策略）

| 约束 | 来源 | 应用于治理循环 |
|---|---|---|
| 章数预算 | maxChapters（autorun.ts:79，≤30） | 治理任务的目标章号不得超出连载预算 |
| 配额熔断 | reason="quota"（autorun.ts:191） | 熔断后中枢只记录不产出新任务 |
| 评分熔断 | 连续 2 章低于地板（autorun.ts:133） | 熔断 → 治理计划升级为"暂停写作、先清质量债"建议（仍需按 §6 权限矩阵决定自动执行与否） |
| 单步成本 | 中枢每触发点 ≤1 次 LLM（DEEP-DIVE 各触发点成本表） | 治理循环不引入额外串行 LLM（干预修复小循环除外，§5.3 有独立预算） |

### 5.3 干预修复小循环：唯一借鉴 agentic loop 的场景

**为什么是它**：INTERVENTION §4 对齐管线（账本 reset→缓存失效→changed-marker→伏笔校验）现状是"跑一遍"，但修复是否成功只能靠 `auditWorld` 事后扫描（integrity.ts:147-204）发现——"尝试→验证→再修"的 agentic 模式在此收益最高、风险可控：**纯状态层操作，不产正文、不动正文**，失败可再跑。

**定义（有界小循环）**：

```
reconciliationLoop(w, intervention, maxRounds=2):
  round 1..maxRounds:
    ① apply：执行对齐管线（INTERVENTION §4 四步）
    ② verify：auditWorld 确定性扫描（零 LLM，integrity.ts:147）
    ③ 判定：findings 中与本次干预相关的条目为空 → complete；否则提取相关 findings → 下一轮
  超 maxRounds 仍有 findings → blocked：findings 挂 qualityDebt（kind=reconciliation）+ changeLog，交用户
```

- **预算**：maxRounds=2（对齐 reviewFixLoop ≤2 轮的既有惯例）；verify 零 LLM，apply 仅在需要重结算时消耗（settleChapter 0.2 低温），成本可预期。
- **适用范围**：N05/N06/N07/L03/L04 等改已提交正文的干预（INTERVENTION 类型学 8/10）与删章（N08）后的对齐；世界编辑（W12）L2 策略执行后同样适用。
- **与既有兜底的关系**：auditWorld/autoRepair（S01/S02）保留为**全局定期兜底**；小循环是**干预局部即时兜底**——前者扫全书，后者只验本次干预影响面。

---

## 6. 权限矩阵：INTERVENTION_MODE × AGNES_BRAIN_GATE

中枢"能自行做到哪一步"由两个既有开关（INTERVENTION §6 / ARCHITECTURE §3.2）的乘积决定。原则：**闸门管"要不要中枢审"，模式管"审完能不能自动执行"**。

### 6.1 行动权限矩阵

| 模式 \ 闸门 | GATE=off（中枢未启用） | GATE=on（中枢启用） |
|---|---|---|
| **autopilot**（全自动） | 现状行为：L0-L1 直通、L2 按 steering 自动裁决；治理任务入队但无人消费 | **中枢可自动执行**：章末审查修正指令直接注入 mergeTasks；rewriteQueue 自动消费（G06 调度化）；**干预修复小循环自动跑完**（complete 则静默，blocked 则挂 qualityDebt 暂停写作转人工） |
| **supervised**（默认） | 现状行为：全部干预先 impactReport 预览，用户三选一后才落盘 | **中枢产出计划等确认**：审查/审批结论与治理任务清单随预览返回（needIntervention 语义扩展）；小循环**只跑 verify 不跑 apply**——把"将要执行的修复轮次与预期 findings"展示给用户，确认后执行 |
| **manual**（手动） | 现状行为：干预即改，落盘后 autoRepair 兜底 | **中枢仅记录**：审查结论与修复建议写 changeLog（kind=brain-advice），不自动执行任何修复；用户自行触发 resettle/rewrite |

### 6.2 矩阵要点

- **supervised 下小循环"先验后修"**是本设计的核心约束：中枢的 agentic 能力（多轮修复）在默认模式下退化为"可预览的确定性建议"，与 steering L2 无策略返 needIntervention 的既有交互一致。
- **autopilot 的自动执行边界**仍受三约束：① 小循环 maxRounds=2；② 熔断后只记录不产出（§5.2）；③ 正文层操作（rewrite）逐章确认点保留——rewriteQueue 自动消费每章完成即 auditWorld 校验，单章失败即停（复用 G06 现状语义），不盲目续跑。
- **模式切换即时生效**：权限检查在每次触发点执行前读取（与 INTERVENTION_MODE 读取时机一致），切换模式不中断进行中的连载。

---

## 7. 失败语义与降级路径

### 7.1 与既有降级原则的对齐

| 既有原则 | 出处 | 本文的遵循 |
|---|---|---|
| 闸门是"加保险"不是"拦路虎" | DEEP-DIVE 1.3（审查失败 → 确定性预检通过即放行） | 中枢任何一步失败都不得阻塞写作/提交主链路 |
| 中枢审查失败降级放行 | DEEP-DIVE 1.1（changeLog.reason="brain_unavailable"） | BookGoal disposition 在中枢不可用时回落纯确定性判定（isBookComplete + autorun reason） |
| impactReport LLM 失败降级确定性部分 | steering.ts:96-116 | 小循环 verify 本身零 LLM（auditWorld），天然免疫 LLM 失败 |
| handleArcBoundary 失败不重试（现状缺陷） | DEEP-DIVE 1.2 | 治理任务核销机制顺带修复：弧边界产出挂 gov-task，下章触发点重试 |

### 7.2 干预修复小循环的失败语义

| 失败情形 | 处置 | 对主链路影响 |
|---|---|---|
| apply 中途失败（如 settleChapter 抛错） | 本轮记 incomplete，findings 挂 qualityDebt(kind=reconciliation) + changeLog，进入下一轮重试（≤maxRounds） | 无——干预本体已按 INTERVENTION 语义落盘，小循环是后置对齐 |
| verify 后 findings 超预算仍不清 | blocked：findings 明细挂 qualityDebt + changeLog；supervised/manual 下转用户，autopilot 下暂停后续治理任务产出（写作是否暂停由 INTERVENTION_MODE 决定） | 无阻塞；下一次 auditWorld 全局兜底仍会扫到 |
| auditWorld 自身异常 | 视为 verify 通过（保守放行）+ changeLog 记 verify_skipped | 无 |
| 小循环与 autoRepair 并发 | withTitleLock 串行（现状锁机制，HARNESS 3.3）；小循环在锁内执行，不与连载写章交错 | 排队不冲突 |

**核心不变量**：小循环是**后置、有界、可跳过**的对齐增强——任何失败路径都收敛到"记入 qualityDebt/changeLog，等全局兜底或用户处置"，绝不引入新的阻塞点。

---

## 8. 落点阶段（对齐 ARCHITECTURE P0-P3，增量而非替代）

| 阶段 | 本文增量 | 依赖的既有 P 阶段内容 | 行为变化 |
|---|---|---|---|
| **P0 配置化** | `WorldState.goal?: BookGoal` 可选字段 + 默认回落逻辑（未设置零行为变化）；HARNESS 触发源 `brain` 列标注本文定义 | P0：model 配置 | 零行为变化 |
| **P1 任务画像** | changeLog kind=gov-task 登记（治理计划视图的数据基础）；BookGoal disposition 的确定性版本（无中枢，仅 isBookComplete+reason 映射） | P1：TASK_PROFILES | 仅新增只读度量 |
| **P2 主脑启用** | 中枢章末审查附带 disposition 报告；治理任务生产/核销接入三通道；rewriteQueue 自动消费调度（FEATURES 迭代建议 1）；AutoRunPanel 目标进度展示（COUPLING U16） | P2：AGNES_BRAIN_GATE 可开关、章末审查接入 | 闸门 on 时生效 |
| **P3 收敛状态写** | 干预修复小循环（reconciliationLoop）接入 N05-N08/L03/L04/W12-L2；权限矩阵（§6）按 INTERVENTION_MODE 生效；qualityDebt kind=reconciliation | P3：applyStateChange 全收编、INTERVENTION 对齐管线落地 | supervised 默认"先验后修" |

**增量声明**：本文不修改 ARCHITECTURE P0-P3 的任何既有验收标准，只在各阶段追加 goal/plan/loop 三原语的对应交付；BRAIN.md 与 INTERVENTION.md 的实施路径（§9）互为引用——对齐管线是 INTERVENTION 的交付，小循环是本文在其之上的验证闭环。

---

## 9. 与既有文档的关系

| 文档 | 本文的衔接点 |
|---|---|
| ARCHITECTURE | §3.3 中枢职责的三原语展开（goal/plan/loop）；五触发点即治理循环的事件源 |
| DEEP-DIVE | 触发点失败语义的遵循（§7.1）；changeLog.reason 扩展承载 gov-task 与 disposition |
| INTERVENTION | §4 对齐管线 + 本文 §5.3 小循环 = "修复 + 验证闭环"；§6 三模式即 §6.1 权限矩阵的行 |
| HARNESS | 触发源 `brain` 列的定义依据；G06/G07（重写队列）是治理计划消费的登记指令 |
| COUPLING | disposition/治理任务的 UI 出口（U16 连载控制台、U20 变更时间线） |
| QUALITY-BASELINE | 复测回归视为最高优先级 blocked，优先于中枢任何治理动作；BookGoal.quality 初始默认以其基线读数为基准 |
