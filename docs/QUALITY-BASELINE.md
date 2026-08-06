# 质量验收基线（QUALITY-BASELINE）— 重构启动前提（P-1）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（重构基线）、[docs/BRAIN.md](./BRAIN.md)（中枢治理循环与 Goal 模型）、[docs/COUPLING.md](./COUPLING.md)（影响矩阵）、[docs/FEATURES.md](./FEATURES.md)
> 状态：**前置门禁，未执行**。本文是 P0-P3 重构的**启动前提**——在动任何重构代码之前，先固化"当前版本能写出多好的小说"的基准，使每个 P 阶段完成后"质量不退化 + 一致性提升"成为**可测量的验收条款**，而非信念。
>
> **为什么是 P-1（在所有 P0 之前）**：六项判定（见 COUPLING/BRAIN 交叉评审）确认——现有全部机制（critic/eval/审查/记账）都在保"过程质量"，**没有任何机制对"结果质量"负责并验收**。整个中枢重构做完，文章质量是升是降无法回答。没有基线，所有 P 阶段验收标准（`bun test` 全绿、行为等价）都只能证明"没改坏代码"，**证明不了"文章更好或至少不差"**。

---

## 1. 背景：质量验收的缺失诊断

| 现状机制 | 保证什么 | 不保证什么 |
|---|---|---|
| critic 5 维审查（critic.ts:37）+ 地板/重写轮数 | 单章过程质量、反谄媚 | 全书整体质量、跨章累积效应 |
| eval 8 维评估（eval.ts:14）+ eval.json 落盘缓存 | 全书 LLM-as-Judge 度量 | **度量不回流**——分数低不会自动改善后续写作；无外部基准校准 |
| 记账 chronicler + 完整性 integrity | 账本一致性、无孤儿数据 | 叙事质量本身 |
| qualityDebt 质量债闭环 | 问题登记与修复通道 | 债务清零 ≠ 质量达标 |

**核心结论**：eval 是度量，不是闭环；critic 是单章闸门，不是全书验收。重构要改的恰恰是 critic/eval/记账的调用架构（P1 任务画像、P2 中枢接入、P3 收编），**改度量与被度量物同时变**——若不先固化改造前的度量快照，改造后无法归因"分数变化是重构带来的还是波动"。

---

## 2. 基线作品集与生成协议

### 2.1 作品规模与题材（固定，复测不变）

| 槽位 | 规模 | 题材 | 依据 |
|---|---|---|---|
| B-SHORT | 短篇：≤30 章、1-2 卷 | 古风悬疑（对齐 engine-test.ts 既有 idea 与测试惯例） | 短篇验证"一气呵成"质量；低成本可多次复测 |
| B-LONG | 长篇：≥2 卷、≥60 章 | 由立项模板决定（固定 idea 文本，见 2.3） | 长篇验证分层摘要/弧边界/指南针在规模下的质量保持（ENGINE.md tiered 档位的实际压力区） |

> 题材与 idea **逐字固定并落盘存档**（2.3），确保基线期与每次复测用**同一输入**——否则质量对比无意义。

### 2.2 生成模式（零人工干预）

基线作品的生成必须满足：
- `INTERVENTION_MODE` 等效于 **autopilot 无人值守**：不手动编辑章节、不删章、不回滚、不手改世界/角色/伏笔；
- 自动抽卡可开（`autoGacha`），但抽卡结果随机——**为可复现性，基线期关闭 autoGacha**（纯写章管线），复测同样关闭；
- 审查严格度、温度、字数等 `genProfile` 参数取**当前默认值并记录快照**（见 2.3），复测不得调参。

**理由**：基线衡量的是"引擎自动产出"的质量上限；任何人工干预都会污染归因。干预类能力（steering/删章/回滚）的质量影响由 COUPLING/INTERVENTION 的一致性指标单独验收（§3.3），不混入文本质量基线。

### 2.3 基线快照（每部作品固化以下产物）

| 产物 | 内容 | 落盘位置 |
|---|---|---|
| 输入快照 | idea 文本、题材、genProfile 全字段（字数/视角/温度/严格度/伏笔上限/hook/抽卡开关） | `data/baseline/<slot>/input.json` |
| 世界状态 | 完结时的完整 `state.json`（含 blueprint/storyArcs/chapterPlans/账本/changeLog） | `data/baseline/<slot>/state.json` |
| 质量报告 | `evaluateBookCached(force=true)` 的 8 维分 + overall + suggestions（见 eval.ts:154） | `data/baseline/<slot>/eval.json` |
| 章节审查 | 每章 critic verdict + 5 维分 + findings 数 | `data/baseline/<slot>/reviews.json` |
| 正文全文 | 供人工抽读与外部评审的导出 Markdown | `data/baseline/<slot>/book.md` |
| 成本与轮数 | 总 LLM 调用次数、重写轮数分布、质量债峰值 | `data/baseline/<slot>/cost.json` |

> `data/` 已 gitignore，基线目录建议**额外备份**（git annex 或手动归档）——基线丢失 = 验收体系失效。

---

## 3. 指标体系（全部复用现有机制，不新造度量）

### 3.1 文本质量指标（eval 8 维，eval.ts:14）

| 维度 | 说明 | 验收角色 |
|---|---|---|
| 剧情逻辑 / 节奏张力 / 爽点钩子 | 叙事主干质量 | 主指标 |
| 人物塑造 / 对话（critic）/ 文笔风格 | 角色与文笔 | 主指标 |
| 伏笔管理 / 设定一致 | 与账本/一致性机制强相关，重构重点影响区 | **重点监控**（P2/P3 改动直接影响记账与闸门） |
| 主题立意 | 全书立意 | 辅助 |
| **overall**（等权均值，eval.ts:86） | 单一总分 | 主判据 |

### 3.2 单章过程指标（critic 5 维，critic.ts:18）

- 复测时统计全书章节的 `coherence/tension/prose/pacing/dialogue` 均值与地板击穿率（触发 rewrite 的章占比）；
- **重写轮数分布**：rewrite 占比上升 = 单章一次成型率下降，是质量退化的早期信号。

### 3.3 一致性与完整性指标（确定性，零 LLM）

复用 integrity.auditWorld 的 findings（integrity.ts:147-204）与伏笔账本：
- `auditWorld` danger/warning 计数（孤儿摘要/时间线/伏笔悬挂/顺序倒置）；
- 伏笔回收率（resolved / 全部非 pending）、超期伏笔数；
- changeLog 条数与 L2 干预留痕完整性；
- **这组指标不依赖 LLM，复测成本几乎为零，应在每个 P 阶段都跑**（即使不重生成全文）。

### 3.4 成本指标（防"质量提升靠烧钱"）

- 每章平均 LLM 调用次数、总 token/RPM 占用；
- 中枢接入（P2）后单次审查新增调用数——**质量提升必须伴随成本可预期**，否则违反 BRAIN.md §2.2 步成本约束。

---

## 4. 复测对比协议

### 4.1 触发时机

| 阶段 | 必跑复测 | 内容 |
|---|---|---|
| P0 配置化 | 轻复测 | 仅 3.3 一致性指标 + `bun test`（验证零行为变化）；不重生成全文 |
| P1 任务画像 | 轻复测 + B-SHORT 重生成 | 验证参数收编未改变输出分布 |
| P2 主脑启用 | 全复测 | B-SHORT + B-LONG 重生成 + eval 对比 |
| P3 状态写收敛 | 全复测 | 同上 + 干预场景一致性专项（COUPLING 矩阵抽检） |

### 4.2 通过/回归判定规则

| 指标 | 通过条件 | 回归判定 |
|---|---|---|
| eval overall | 复测 overall ≥ 基线 overall − 0.3（容忍 LLM 评估噪声） | 低于基线 − 0.3 → **阻断该阶段合入** |
| eval 单维（重点：伏笔管理/设定一致） | ≥ 基线该维 − 0.5 | 单维跌破 → 分析归因，必要时阻断 |
| critic 重写率 | ≤ 基线 +5% | 超出 → 单章成型退化，分析 |
| auditWorld danger 计数 | = 0 且不高于基线 | danger 增加 → 一致性回归，阻断 |
| 伏笔回收率 | ≥ 基线 − 5% | 跌破 → 账本机制回归 |
| 每章平均 LLM 调用 | ≤ 基线 × 1.3 | 超出 → 成本失控，需中枢预算调整（BRAIN §5.2） |

> **容忍带（−0.3 overall）的依据**：eval 是 LLM-as-Judge，同一文本重复评估本身有 ±0.2~0.4 波动（temperature 0.3 非零）。判定阈值必须大于评估噪声，否则误报。

### 4.3 归因规则（质量变化 ≠ 重构带来的）

复测出现回归时，按顺序排除：
1. **评估噪声**：同一 state 连跑 2 次 eval，若两次差 > 0.3 则本次对比无效，重跑；
2. **输入漂移**：核对 input.json 与基线逐字段一致；
3. **重构引入**：以上排除后仍回归 → 定位到具体 P 阶段改动，修复后重测。

### 4.4 LLM-as-Judge 的已知局限（必须声明）

- critic 与 eval **同源**（都是 Agnes 模型自评）——存在系统性偏袒风险；
- 缓解：基线期与关键复测（P2/P3）**人工抽读** B-SHORT 前 3 章 + B-LONG 跨卷 3 章，记录人评印象到 `data/baseline/<slot>/human-notes.md`，作为 LLM 分数的旁证；
- 长期：eval 指纹与外部基准（若有）对齐属后续演进，不在本基线范围。

---

## 5. P-1 执行清单（重构启动前提）

- [ ] 1. 固定 B-SHORT / B-LONG 的 idea 文本与 genProfile，写入 `data/baseline/*/input.json`；
- [ ] 2. 关闭 autoGacha，`INTERVENTION_MODE` 等效无人值守，按当前默认参数生成 B-SHORT 至完结；
- [ ] 3. 同法生成 B-LONG 至完结（成本较高，可分多次连载，但**中途零干预**）；
- [ ] 4. 对两部作品跑 `evaluateBookCached(force=true)` + 导出 reviews/cost/book.md，落盘基线快照（§2.3）；
- [ ] 5. 人工抽读并写 human-notes.md；
- [ ] 6. 将基线目录备份，确认 gitignore 不致丢失；
- [ ] 7. 在 ARCHITECTURE.md 验收标准中登记"每 P 阶段须通过 QUALITY-BASELINE §4 复测"。

**验收**：`data/baseline/B-SHORT` 与 `data/baseline/B-LONG` 六类产物齐全；overall/各维/一致性/成本指标读数记录在案。

---

## 6. 与既有文档/验收标准的挂接

| 文档 | 挂接点 |
|---|---|
| ARCHITECTURE §5 验收标准 | 追加"质量不退化"条款：每 P 阶段合入前须通过本文 §4 复测（轻/全按 §4.1） |
| BRAIN §3 BookGoal.quality | BookGoal 的 minOverall/floorDimensions **以基线读数为初始默认**，goal 与基线同源 |
| BRAIN §7 失败语义 | 复测回归视为最高优先级 blocked，优先于中枢任何治理动作 |
| COUPLING §4 冲突矩阵 | 干预类变更的一致性验收走 §3.3 确定性指标，与文本质量基线解耦 |
| FEATURES §7 测试门禁 | `bun test`（代码正确性）+ 本文（结果质量）= 双轨门禁，缺一不可 |

---

## 7. 与既有文档的关系

- 本文是**重构启动前提（P-1）**，不是又一个设计提案——其余 docs/ 是"要做什么"，本文是"如何证明做对了"。
- 不改变 P0-P3 的任何技术方案，只为其追加质量验收闭环。
