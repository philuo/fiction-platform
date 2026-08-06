# 人工干预治理与高质全自动设计（INTERVENTION）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（主脑中枢模型基线）、[docs/DEEP-DIVE.md](./DEEP-DIVE.md)（触发点/状态闸门细化）、[docs/FLOWS.md](./FLOWS.md)（可视化 flow）、[docs/HARNESS.md](./HARNESS.md)（87 条指令注册表）、[docs/COUPLING.md](./COUPLING.md)（指令 → UI 更新映射与媒体资源耦合）
> 状态：**设计提案，尚未实现**。本文只整理架构、不修改代码。
> 目的：在"AI 全自动生成高质量短篇/长篇各题材小说 + 人工可干预"之间建立可治理的平衡——重点化解人工干预（角色、角色关系、伏笔、大纲、设定、世界观、世界书、章节删减、人工修订、版本切换）对整书规划、脉络、逻辑及 AI 写手后续决策的破坏。

---

## 1. 核心矛盾与设计原则

**核心矛盾**：人工干预本质是对"已落定状态"的补丁（patch），而 AI 写手（writer/critic/planner）的每次决策都基于这些状态**即时拼装**上下文（调研确认：`memory.ts:202-280` 每请求从磁盘 `loadWorld` 重读，无内存缓存）。补丁语义与既有叙事不一致时，写手就在错误的地基上继续盖楼——破坏的不是某一章，而是**后续所有决策的上下文前提**。

**三条设计原则**：

1. **干预语义化**：人工干预必须是结构化变更（`{ field, op, value, reason }`），而非无界自由文本——中枢才能计算影响面。自由文本修订归约为 `ch.text` 的 `replace` 操作并自动触发账本重算。
2. **影响可知化**：每次干预先计算影响传播链（影响哪些字段 → 哪些下游上下文 → 哪些陈旧缓存），用户与中枢都先"看见破坏面"再决定。
3. **可逆与对齐**：干预前快照、干预后账本对齐（reset 重算）、写手上下文差异标记——改错可回滚，且不给写手留下"陈异地基"。

---

## 2. 干预类型学（10 类）与破坏面分析

| # | 干预类型 | HARNESS 指令 | 影响字段 | 下游传播链（对写手决策的影响） | 级 | 陈旧风险 |
|---|---|---|---|---|---|---|
| 1 | 角色 增/删/改 | `W12`/`L11`/`N01` | `characters[]` 字段组 | `buildWriterContext` 角色块（memory.ts:159-169）、critic 全量角色（:254-257）、`expandArc` 角色状态（planner.ts:132）、`appearedIn` 重算（chronicler.ts:84-104）、提案入册 | L2/L3(删) | **eval.json 指纹不覆盖 characters** |
| 2 | 角色关系 | `W12`/`W13` | `relations` | writer 角色块"参与方筛选"（memory.ts:161）、伏笔关联方、对话互动 | L2 | — |
| 3 | 伏笔 增/删/改 | `L07` | `foreshadowing[]` | writer `activeForeshadows` 注入（writer.ts:235-238）、critic **全账本**（:258）、`expandArc` 未 resolved（planner.ts:124）、`retrieveRelevant` 查询词（memory.ts:107）、eval 指纹 | L1 | 伏笔改动已入 eval 指纹（活性伏笔），缓存自动失效；但**账本残留**风险在正文重算路径 |
| 4 | 大纲/蓝图 | `W01`/`W03`/`W04` | `outline`/`blueprint` | `expandArc` 骨架（planner.ts:118-170）、`progressContract`/`compass`（:129-130）、`progressGuard`（:266-278）、writer 章纲段 | L2 | **弧/卷摘要快照仅边界刷新**（planner.ts:213/220） |
| 5 | 章纲 | `W07`/`N14` | `chapterPlans[]` | writer `plan.goal/beats/mergeTasks`（writer.ts:68-72）、critic plan（critic.ts:85-87）、`progressGuard` | L1 | — |
| 6 | 设定/世界观 | `W12`(setting) | `setting.*` | memory `setting` 块（:156-157）、`fidelityRules` 分组（writer.ts:86-98）、tone | L2 | **auto lore 惰性重建**（仅 `/api/novel/lore` action=auto 时，lore.ts:5-28） |
| 7 | 世界书 | `W14` | `lore[]` | `loreBlock` top8 关键词命中（lore.ts:39-60，writer 独立注入） | L1 | 同上，重建时机缺失 |
| 8 | 章节正文编辑/重写/回滚 | `N05`/`N06`/`N07` | `ch.text/review/versions` | `settleChapter` 重算（director.ts:831/864/950）→ `upsertSummary` 覆盖摘要（memory.ts:55-62）、`chapterDeltas[index]` 覆盖、`timeline`、`appearedIn` | L2 | **重结算不先 `resetChapterLedger`** → 伏笔"旧残留+新叠加"（chronicler.ts:344 无去重）、rollback 摘要降级（director.ts:855-861） |
| 9 | 章节删减 | `N08` | `chapters` 全集 | `deleteChapterCascade` 逆操作（integrity.ts:293-359）：按 `chapterDeltas` 恢复角色/弧线/伏笔回收/current/关系/规则、`plantedAt`/`resolvedAt` 伏笔处置、`exit` 清除、索引空洞、尾章回退 `nextChapter` | **L3** | 空洞 index 不重排、后续章 `appearedIn` 依赖重算 |
| 10 | 版本切换 | `N05`/`N07` | `versions` | 正文回历史版本 → 摘要/账本/伏笔时间线整体回退 | L2 | 需完整对齐管线，否则账本与正文错位 |

**实证结论**（来自代码调研，非猜测）：
- 决策上下文**几乎全部即时拼装**：干预保存后，下一次写章/审查/规划自动读到新值——这是本设计可行性的地基。
- **4 处陈旧缺口**必须由对齐管线覆盖：① eval.json 指纹不覆盖 `characters/current/lore/setting.rules/chapterPlans/plotThreads/timeline`（eval.ts:107-120）；② edit/regenerate/rollback 重结算不 reset 账本（director.ts:831/864/950 vs 唯一先 reset 的 integrity resettle routes.ts:1745）；③ auto lore 仅手动重建；④ 弧/卷摘要快照仅边界刷新 + steering merge 挂 `w.outline` 而 writer 不注入（steering.ts:145）。
- **UI 区域与媒体影响面**（本表未展开的两个维度）：各干预类型影响哪些 UI 区域（U01-U19）、以及章节媒体资源随正文变更的判定/留存/保存前预警规则，见 [docs/COUPLING.md](./COUPLING.md) 第 1/3 章（类型 8/9/10 的媒体耦合对应其 3.2 现状处理表与 R1 规则）。

---

## 3. 中枢干预审查协议（gate 展开）

把 HARNESS 每条指令 `governance: gate` 的"写前审查"展开为四步协议，落点为 DEEP-DIVE 的 `applyStateChange` 单一闸门：

```
人工干预 → ① 干预识别 → ② 影响传播计算（确定性） → ③ 冲突评估（brain 可选） → ④ 三态裁决 → apply/needIntervention/reject
```

1. **干预识别**：从 HARNESS 指令注册表按入口定位指令 ID → 取该指令的 `level` 与 `affects`。零 LLM。
2. **影响传播计算（确定性，零 LLM）**：查"指令 → 影响字段 → 下游上下文 → 陈旧缓存"映射表（本文 2 节 + HARNESS 表格扩展），产出结构化 `impactReport`：
   ```ts
   type ImpactReport = {
     commandId: string;        // CMD-W12 等
     level: L0|L1|L2|L3;
     affectedFields: string[];          // characters[]、foreshadowing 等
     downstreamContexts: string[];      // writer 角色块、critic 全账本、expandArc…
     staleCaches: string[];             // eval.json、arcSummary、autoLore、ledger
     conflictCandidates: string[];      // 待冲突评估的具体对象（如将删除的角色名、被引用的伏笔 id）
   };
   ```
   该表复用 `classifyWorldPatch` 分级判定（DEEP-DIVE 第 2 章）与 steering `impactReport` 双通道结构（FLOWS flow 4）——确定性通道先行。
3. **冲突评估（可选 brain LLM，`AGNES_BRAIN_GATE=on` 时）**：对 L2/L3 干预，中枢审查 `conflictCandidates`，回答三类问题：
   - 引用冲突：要删的角色/伏笔/章节是否仍被后续叙事引用（`appearedIn`、未回收伏笔、`relations`、章纲 beats）？
   - 逻辑冲突：蓝图改方向后，已写章节的伏笔/弧线是否与新政矛盾？
   - 建议替代：删除 vs 软搁置（`status=archived`）、改动 vs 注释留痕？
   输出 `{ verdict: allow|needIntervention|reject, reason, suggestions }`。
4. **三态裁决**：`allow` → 走 `applyStateChange` 落盘 + 对齐管线；`needIntervention` → 返回影响预览给用户确认（同 steering L2 无策略返 `needIntervention`）；`reject` → 返回原因，不改状态。

**变更语义模型**（原则 1 落地）：

```ts
type StateChange = {
  field: string;              // 顶层字段路径，如 "characters" / "foreshadowing" / "chapters[3].text"
  op: "set" | "merge" | "delete" | "move" | "replace";
  value?: unknown;
  reason: string;             // 人工填写/自动生成——写入 changeLog.reason（DEEP-DIVE 扩展点）
  interventionId: string;     // 关联干预快照
};
```

---

## 4. 干预后对齐管线（context reconciliation）

干预被批准后，中枢**自动调度对齐**，而不是让写手"带着脏数据继续写"：

> 验证闭环：本管线执行后由 BRAIN.md §5.3 的干预修复小循环（apply→auditWorld verify→≤2 轮）验证修复效果；执行权限按 INTERVENTION_MODE×AGNES_BRAIN_GATE 矩阵（BRAIN.md §6：supervised 默认先验后修）。

1. **账本 reset 重算**：凡改动已提交正文（`N05`/`N06`/`N07`/`L03`/`L04`），先 `resetChapterLedger`（把 integrity resettle 的 reset 逻辑抽为共享函数，统一 `L03` 与 `L04` 行为差异）再 `settleChapter`——根治"旧残留+新叠加"。伏笔回收后不回退的问题由 reset 一并解决。
2. **陈旧缓存失效**：按 `impactReport.staleCaches` 逐项处理：
   - `eval.json` → 指纹不足，`force` 重算；
   - `arcSummary`/`volSummary` → 受影响弧范围 `summarizeRange` 重算（planner.ts:66-81）；
   - `autoLore` → 受影响角色/设定条目标 `stale`，下一章写前重建；
   - `rollback 摘要降级` → 重算摘要，消除"正文前 300 字"降级态。
3. **写手上下文差异标记（changed-marker）**：干预后把变更写入 `contextDelta`（steering 注入通道扩展），writer/critic/planner 的上下文注入在受影响段落后附注：
   > ⚠ 本段数据在第 N 章后由人工修改：`{字段} {变更摘要}`。与既有叙事衔接时请注意本变更。
   让写手**带着变更意识**写作，而非静默采用新值——这是"人工可干预"与"不破坏写手决策"的关键平衡点。
4. **伏笔链校验**：增删伏笔/删章后校验：未回收伏笔 `plantedAt` 是否指向已删章？`resolvedAt` 是否失效？孤儿伏笔标记（复用 integrity 孤儿检测模式）。删章场景 `deleteChapterCascade` 已处理 `plantedAt==index` 删除留痕、`resolvedAt==index` 保留留痕——校验只需确认无跨章引用残留。

---

## 5. 版本与分支策略

- **干预快照**：每次 L2/L3 干预前自动快照（`world.interventions[]` 或独立 `interventionLog`）：`{ at, type, commandId, beforeHash, afterHash, change }`。`changeLog` 记录审计（现结构扩展 `reason`，DEEP-DIVE 第 2 章）。
- **回滚语义**：回滚 = 恢复到干预前快照 + **重跑对齐管线**（账本 reset、缓存失效、伏笔校验）。关键约束——**回滚窗口在"干预完成"与"下一章写入"之间**；一旦干预后已写新章，回滚需级联评估（`chapterDeltas` 逆操作 + 后续章 `appearedIn`/摘要重算），否则造成状态与正文错位。
- **分支试运行（可选，长线干预专用）**：改蓝图方向、删多章等高破坏干预，提供 sandbox 模式——克隆 world 到内存，跑 N 章模拟（复用 director 只读管线），评估产出后 `merge` 或 `discard`。控制成本：仅用户显式启用，模拟上限章数可配。
- **版本切换（N07）**：本质是"正文回到历史版本"，必须走完整对齐管线（含 reset 重算），与普通编辑同权。

---

## 6. 人机协作模式（全自动 / 半自动 / 手动）

| 模式 | 干预门槛 | 干预处理 | 适用 |
|---|---|---|---|
| **autopilot**（全自动） | L0-L1 直接应用；L2-L3 走冲突评估自动裁决 | 低危直放、高危自动挂起转人工 | 短篇、低干预需求、可信赖模型 |
| **supervised**（半自动，**默认**） | 全部干预先影响传播计算 + 预览 | 显示 `impactReport`，用户确认后才落盘 | 长篇、连载（干预影响面大） |
| **manual**（手动） | 干预即改，不前置阻断 | 落盘后自动跑对齐管线 + 审计留痕 | 快速修补、熟练用户 |

> 与 AGNES_BRAIN_GATE 的组合权限（何时自行执行修复小循环/何时产出计划等确认/何时仅记录）见 [docs/BRAIN.md](./BRAIN.md) §6 行动权限矩阵。

- 开关：`INTERVENTION_MODE=autopilot|supervised|manual`，默认 `supervised`；`AGNES_BRAIN_GATE=on` 时 L2/L3 加冲突评估。
- **高质全自动的支撑链**（不新增机制，复用现有）：自动抽卡（gacha）→ 考据（ensureResearch）→ 自愈（autoRepair）→ 章纲（expandArc）→ 写章（writeChapter）→ 审查修补（reviewFixLoop ≤2 轮）→ 记账（settleChapter）→ 质量债闭环（qualityDebt→mergeTasks）→ **干预对齐**（本文 4 节）→ 弧边界审批（DEEP-DIVE 触发点 2）。全自动模式 = 该链无人值守 + 干预口全部走审查协议。

---

## 7. 短篇 / 长篇 / 题材适配

- **短篇**（≤30 章、1-2 卷）：蓝图一次性确认（W03）、弧少、干预窗口小 → `autopilot` + 干预快照自动建。
- **长篇**（多卷连载）：弧边界审批（DEEP-DIVE 触发点 2）、每卷 compass 更新（planner.ts:240-263）、干预必须走 `supervised` + 影响传播计算；删章/改蓝图等高危干预建议分支试运行。
- **题材**：`fidelityRules` 史实/架空分组已支撑题材约束（writer.ts:86-98）；冲突评估的第三问"建议替代"按题材规则提示（史实题材：锚点字段加字段锁 `G03` 防误改；架空题材：软搁置优先于删除）。

---

## 8. 与既有文档的关系

| 文档 | 本文的衔接点 |
|---|---|
| HARNESS | 每条指令的 `governance: gate` 由本文 3 节展开为完整协议；`affects` 列扩展为"下游上下文/陈旧缓存"映射（影响传播计算的数据源） |
| DEEP-DIVE | `applyStateChange` 单一闸门 = 本文干预协议的**落地载体**；`classifyWorldPatch` 分级复用；`changeLog.reason` 扩展承载干预原因 |
| FLOWS | flow 3（applyStateChange 决策图）可扩展为含"干预识别→影响传播→冲突评估"的干预流程图 |
| ARCHITECTURE | 五触发点中"状态变更闸门"即本文；"章末一致性审查"承担干预后的上下文校验 |
| COUPLING | 本文四步协议的**章节级操作覆盖**（N05-N08 保存前冲突预警，其 R2 规则）；干预的 UI 区域影响面与媒体资源影响面由其第 1/3 章登记 |

---

## 9. 实施路径（对齐 ARCHITECTURE P0-P3）

- **P0**：`changeLog.reason` 扩展 + 干预快照 `world.interventions[]`（零行为变化）。
- **P1**：账本 reset 统一——`L03`/`L04`/`N05`/`N06`/`N07` 全走 `resetChapterLedger` 再 settle；eval 指纹补全 `characters/current/setting.rules/plotThreads/timeline`。
- **P2**：影响传播表落地（HARNESS 指令表加"下游/陈旧"列）+ `impactReport` 确定性通道 + `INTERVENTION_MODE` 开关。
- **P3**：冲突评估接入 `AGNES_BRAIN_GATE` + 写手上下文差异标记（`contextDelta`）+ 分支试运行 sandbox。

> 验收：全自动模式零干预生成短篇/长篇各 1 本质量达标（复用现有评估）；supervised 模式下对 10 类干预逐一执行"预览→确认→落盘→对齐"，干预后下一章写手上下文无陈旧引用（断言：无 `staleCaches` 未清、无账本叠加、changed-marker 出现于注入段）。
