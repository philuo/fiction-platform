# 引擎设计 v2（长篇架构重构后，2026-08-03）

调研参考：ainovel-cli（确定性调度+卷弧滚动规划+三级摘要）、AI-Novel-Writing-Assistant（自动导演+停下策略）、
AI_NovelGenerator（章末状态结算）、inkos（动态审计+去 AI 味+字数治理）、WebNovelBench/WritingBench（评估）。

## 每章管线（writeOneChapter，step/regenerate/autorun 共用）

```
[取章纲 ensureChapterPlan(缺→expandArc 滚动展开)]
  → [上下文组装 memory.buildWriterContext：自适应档位 full/window/tiered + token 预算]
  → [导演 writer 流式写正文（纯正文，首行【标题】；字数治理 short→续写补足）]
  → [确定性自检 style.detectAiTone + wordCountGuard（零 LLM）]
  → [审查者 critic：动态准则(instance-specific 5条) + 静态一致性，单次调用]
  → verdict 决策表（代码确定性覆盖 LLM）：
      floor失败/chapter级major → rewrite 整章 1 次兜底
      paragraph级major → patch 定向修补≤1轮 → 复审
      minor-only → pass，minor 入质量债务不阻塞
  → [commit：chronicler 记账（摘要+伏笔+角色+时间线+弧线+新角色提案，1 次调用合并）]
  → [存档 saveWorld(原子) + checkpoint + 章纲核销 + 弧/卷边界（摘要归并+展开下一弧+指南针校准）]
每个阶段边界可被人工干预立即打断（未 commit 零污染）。
```

## 分层滚动规划（planner）

- 立项 → 自动导演：2-3 套蓝图候选（指南针 compass + 进度承诺 + 2 卷骨架 + 首弧）
- 弧边界 → 弧摘要 + 展开下一骨架弧；卷边界 → 卷摘要 + 更新指南针
- progressGuard：实际章数 > 弧预估×1.5 → 注入「放慢/收束」约束防节奏失控
- 旧故事自愈：无蓝图时自动补最小蓝图 + 回填章纲

## 三层记忆（memory）

- L1 设定层：compass + setting + 参与者角色（章纲筛选）+ 命中世界书
- L2 摘要层：章摘要（每章结算产出）/弧摘要/卷摘要；上一节结尾 400 字窗口
- L3 检索层：bigram Jaccard + 角色名/伏笔精确命中加权，Top-3 相关章节
- 档位：<6万字 full（近10章全文吃满长窗口）；6-20万 window；>20万 tiered（三级摘要+检索）；预算超限时按 检索→世界书→伏笔→近文 顺序确定性裁减

## 干预治理（steering，用户已确认决策）

- L0 纯增量（抽卡/走向 prompt/新伏笔/参数）→ 直通；L1 前瞻（未写章纲/卷结构）→ 直通+重检
- L2 回溯（已登场角色改/关系改/已埋伏笔改/设定规则改）→ **每次弹影响报告三选一**：弥合/回溯重写/放弃
- L3 已写正文 → 版本快照管线
- 写作中干预：**立即打断**（不入 title 锁，阶段边界丢弃草稿零污染）
- 角色 status 手改即**上锁**，chronicler 不再覆盖；伏笔**不允许放弃**，超期升 major 逼写手处理
- 所有干预记 changeLog 审计

## 世界状态（data/<slug>/）

`state.json`（原子写，同名防覆盖）+ `versions/`（外置快照）+ `meta.json`（列表快读）+ `checkpoint.jsonl`（断点日志）；
字段见 FEATURES.md §5。
