# 可视化 flow（FLOWS）

> 前置文档：[docs/ARCHITECTURE.md](./ARCHITECTURE.md)（设计基线）、[docs/DEEP-DIVE.md](./DEEP-DIVE.md)（细致分析，本文的图是其中各节的图示化）、[docs/COUPLING.md](./COUPLING.md)（指令 → UI 更新映射与媒体资源耦合）
> 渲染：Mermaid（GitHub / VS Code 直接渲染）。图例统一：
> - `flowchart` 节点：矩形=过程，菱形=判定，圆角=起止/终态
> - `sequenceDiagram`：实线箭头=同步调用，虚线箭头=返回
> - 高亮色：🟢 现状已有、🟡 目标态新增（中枢模型/闸门）、🔴 风险/失败路径

---

## flow 1：现状 writeOneChapter 完整管线（flowchart）

> 对应 DEEP-DIVE 1.6 与 ARCHITECTURE 1.3。展示 `director.writeOneChapter` 全流程：写作、审查循环、commitChapter 九步。

```mermaid
flowchart TD
    A(["writeOneChapter 开始"]) --> B["① 自动抽卡 gacha\ncards.ts / director.ts:502"]
    B --> C["② 历史考据 lore\nmemory.ts"]
    C --> D["③ 旧故事自愈\nplanner.ts"]
    D --> E["④ 取/展开章纲 ensureChapterPlan\nplanner.ts:173-189"]
    E --> F{"⑤ 打断检查\ncheckInterrupt\ndirector.ts:241"}
    F -->|"命中"| F1["抛 InterruptedError\n草稿未 commit 零污染"]
    F -->|"放行"| G["⑥ 流式写作 writer\nchatStream onDelta\ndirector.ts:250-256"]
    G --> H["⑦ 确定性自检"]
    H --> I{"⑧ 审查+修补 ≤2 轮\ncritic + patch/writer"}
    I -->|"findings 未清"| I2["patch.ts 局部修补\n未过则重写"]
    I2 --> I
    I -->|"通过"| J{"⑨ requirePass 检查"}
    I -->|"未过且轮次尽"| I3["registerDebt 记质量债\ndirector.ts:287"]
    I3 --> I4["抛 ReviewFailedError"]
    J -->|"未过"| J1["记 major+minor 质量债"]
    J1 --> J2["抛 ReviewFailedError"]
    J -->|"通过"| K["⑩ commitChapter\ndirector.ts:364-422"]
    K --> K1["① 构造 chapter 对象\n:380"]
    K1 --> K2["② snapshotVersion 版本快照\n:382"]
    K2 --> K3["③ chapters.push 首个内存副作用\n:383"]
    K3 --> K4["④ settleChapter 记账\nchronicler.ts:315-341\n13 子步骤 + chapterDeltas"]
    K4 --> K5["⑤ registerDebt\ndirector.ts:395"]
    K5 --> K6{"⑥ markChapterDone\n弧边界?"}
    K6 -->|"是"| K7["handleArcBoundary\nplanner.ts:206-232\n3-4 次串行 LLM + 中途 saveWorld"]
    K6 -->|"否"| K8["⑦ nextChapter++\n:405"]
    K7 --> K8
    K8 --> K9["⑧ saveWorld + appendCheckpoint\n:407-408"]
    K9 --> K10["⑨ done SSE 事件\n:409-420"]
    K10 --> Z(["结束"])
```

**要点**：流式写作（⑥）先于 commitChapter（⑩）完成，因此 commit 内任何审查插入点都不破坏低延迟流式；`handleArcBoundary`（K7）是主链路上最大延迟源（3-4 次串行 LLM），且失败被 catch 后不自动重试（DEEP-DIVE 1.2）。

---

## flow 2：目标态 writeOneChapter + 主脑审查（sequenceDiagram）

> 对应 DEEP-DIVE 1.1（章末审查 P1 窗口）与 1.2（弧边界审批）。🟡 为新增中枢模型介入点。

```mermaid
sequenceDiagram
    autonumber
    participant D as director.writeOneChapter
    participant W as writer
    participant C as critic
    participant CH as chronicler
    participant B as 🟡 brain 中枢模型
    participant P as planner

    D->>W: 写作指令（含 mergeTasks 弥合任务）
    W-->>D: 流式草稿（chatStream）
    D->>C: 审查 + 修补循环 ≤2 轮
    C-->>D: findings / 通过

    Note over D,CH: 进入 commitChapter
    D->>CH: settleChapter 记账（temp 0.2）
    CH-->>D: report.delta（含全部旧值快照）

    Note over D,B: 🟡 P1 审查窗口（DEEP-DIVE 1.1）
    D->>B: 章末一致性审查（正文 + delta + 活跃伏笔/弧线/计划）
    alt 批准
        B-->>D: ✅ 批准
    else 修正指令
        B-->>D: 🟡 修正指令
        D->>D: 注入 mergeTasks（复用 steering merge 语义）
    else 否决
        B-->>D: ❌ 否决
        D->>CH: applyChapterDeltaRevert 回滚账本<br/>(integrity.ts:31-133)
        D->>D: 移除 chapters 条目 + chapterSummaries[index]
        D-->>C: 回到审查/重写流程
    end

    D->>D: registerDebt
    D->>P: markChapterDone
    alt 弧边界
        Note over D,P: 🟡 弧边界审批（DEEP-DIVE 1.2，建议拆出主序列）
        D->>B: 审批弧/卷展开方向
        B-->>D: ✅ 放行 / 修正
        D->>P: summarizeRange / updateCompass / expandArc
    end
    D->>D: nextChapter++ / saveWorld + checkpoint
    D-->>D: done SSE 事件
```

**要点**：中枢模型只做决策/审批，不写正文；否决路径依赖 `chapterDeltas`（P1 窗口内存可回滚，未持久化）；弧边界审批建议在 `expandArc`（内部 `saveWorld`）之前。

---

## flow 3：applyStateChange 状态变更闸门（flowchart）

> 对应 DEEP-DIVE 第 2 章。所有写 WorldState 的路径收敛到单一接口，闸门默认 off 零行为变化。

```mermaid
flowchart TD
    A(["变更请求\n{ actor, field, value, meta }"]) --> B["① 分级判定\n复用 classifyWorldPatch\nsteering.ts:61-63"]
    B -->|"L0（非回溯）"| D["② 确定性预检\n复用 chronicler 守卫\nisLocked/别名/ID/clamp/去重"]
    B -->|"L2（回溯：已登场角色 / 已写章节改规则）"| G{"🟡 AGNES_BRAIN_GATE\n= on ?"}
    G -->|"off"| D
    G -->|"on"| H["🟡 ③ 中枢模型审查\n冲突 / 既成事实 / 全局影响\n（brain 模型 temp 0.2）"]
    H -->|"批准"| D
    H -->|"修正指令"| R1(["返回修正后的变更\n（不改状态）"])
    H -->|"拒绝"| R2(["返回 { applied:false, reason }\n记入 changeLog.reason"])
    H -->|"审查失败"| D2["降级放行\n确定性预检通过即写\nchangeLog.reason = brain_unavailable"]
    D -->|"通过"| E["④ 写字段 + logChange\n（actor/strategy + reason）"]
    D -->|"未通过"| R3(["返回 { ok:false }\n不改状态"])
    E --> F["⑤ 收尾\nalignWorld + saveWorld"]
    F --> Z(["WorldState 已更新"])
```

**要点**：L0 直通（低开销）；L2 才触发闸门；审查失败降级放行（闸门是"加保险"非"拦路虎"）；收尾统一 alignWorld（现状仅 3 端点对齐，见 DEEP-DIVE 3.3）。

---

## flow 4：steering L2 干预治理（flowchart）

> 对应 DEEP-DIVE 4（复用清单）与 ARCHITECTURE 2.2。现状已实现，是 applyStateChange 策略落地的参照。

```mermaid
flowchart TD
    A(["用户世界补丁\n/world 或 /intervene"]) --> B{"isRetroactivePatch\nsteering.ts:45-59"}
    B -->|"否 → L0"| C["director.editWorld + saveWorld\nroutes.ts:628,643"]
    B -->|"是 → L2"| D{"带 strategy ?"}
    D -->|"否"| E["返回 needIntervention:true\n影响报告（前端三选一）"]
    D -->|"带 strategy"| F{"strategy 类型"}
    F -->|"abort"| G["applyStrategy abort\n仅 logChange + saveWorld\nsteering.ts:133-137"]
    F -->|"merge"| H["applyStrategy merge\n注入 mergeTasks ≤3\n前 2 个 planned 章纲\n无章纲挂 outline\nsteering.ts:138-149"]
    F -->|"rewrite"| I["applyStrategy rewrite\naffectedChapters 写 rewriteQueue\nsteering.ts:151-156"]

    E --> J["impactReport 双通道\nsteering.ts:82-124"]
    J --> J1["确定性：appearedIn 章集合\n+ foreshadow 埋设/回收章\n:84-93"]
    J --> J2["LLM：冲突评估 1 次\nchatJson temp 0.2\n失败降级为空 :96-116"]
    J --> J3["返回 affectedChapters +\nconflicts + 三选项"]
    J3 --> F

    H --> K["消费：writer 写作指令\nwriter.ts:68-72\ncritic 审查附带 :85-87"]
    I --> L["消费：regenerateChapter\nroutes.ts:1004\n单章失败即停、剩余保留"]
    G --> M["changeLog 记录\n上限 500 条\nsteering.ts:34-39"]
    K --> M
    L --> M
    C --> M
```

**要点**：分级只产出 L0/L2（L1/L3 预留枚举）；mergeTasks 与 rewriteQueue 是干预落地的两条消费通道，已被 writer/critic 贯通——中枢模型的修正指令可直接复用同一通道（DEEP-DIVE 第 4 章复用清单）。

---

## 图与文档交叉索引

| 图 | 对应 DEEP-DIVE 章节 | 对应 ARCHITECTURE 章节 |
|---|---|---|
| flow 1 | 1.6（commitChapter 审查点） | 1.3（单章管线） |
| flow 2 | 1.1（章末审查）、1.2（弧边界审批） | 3.3（中枢职责） |
| flow 3 | 2（applyStateChange 设计） | 3.6（状态变更收敛） |
| flow 4 | 4（复用清单） | 2.2（状态变更多写者） |
