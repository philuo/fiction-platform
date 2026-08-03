# 引擎设计（参考开源项目学习结论）

参考：NovelForge（卡片化）、StorySmith（多 agent）、Book Genesis（对抗审查+证据评分+地板）、
agent-writing（writer/editor 对抗，反 sycophancy）、lit-critic（多镜头 findings）。

## 回合循环（"边写边做对抗性审查"）

```
[抽卡] → [导演写一节] → [独立审查者对抗审查] → [伏笔/状态更新] → [存档]
              ↑                    │
              └──── 不通过 → 带着 findings 重写（≤2 轮）────┘
```

- 每节写完**立即**审查（不是全书后审）
- 审查者与写作者是两个独立角色（同一模型、不同人设与职责，互不奉承）
- 审查必须引用原文证据；地板机制：任何关键维度 < 6 分 → 不通过

## 抽卡系统（卡片化创作）

- 卡池类型：人物卡 / 事件卡 / 道具卡 / 场景卡 / 伏笔卡
- LLM 按当前世界状态生成 3~5 张候选卡（稀有度 N/R/SR/SSR）
- 抽中的卡注入下一节写作指令；伏笔卡直接登记入账本；已抽卡记录防重复
- 自动模式：无用户操作时按稀有度自动抽取（AI 全权干活）

## 伏笔记忆（不断层核心）

- `foreshadowing[]`：状态机 `planted → active → resolved`，记录埋设章节
- 每轮 writer 上下文注入：**活跃伏笔列表**（含埋设章节与内容）
- writer 写作时结构化输出：新埋设 / 回收哪些伏笔
- critic 检查：该回收的没回收？埋设是否有回应？→ findings

## 上下文压缩（防断层）

每轮给 writer 的上下文 = 设定摘要 + 人物状态 + 时间线摘要 + 活跃伏笔 + 上一节结尾 + 本节指令。
章节全文不进上下文，只进摘要（Book Genesis checkpoint 思路）。

## 世界状态

`setting / characters / foreshadowing / timeline / chapters / cards`，JSON 持久化 `data/<title>/`，
每节存档并保留 `.bak`。
