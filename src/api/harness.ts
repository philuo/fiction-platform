// 系统指令总表（HARNESS 指令注册表，docs/HARNESS.md 的代码化实现）
// 中枢架构：所有「影响小说」的行为登记为一条指令，由中枢统一 审查(gate)/调度(schedule)/控制(control)/治理(audit)。
// 用途：① 每条写操作的 changeLog 落 commandId，实现「所有操作可追溯」；② 状态变更闸门（applyStateChange）
//      按指令查 level/affects 做分级；③ 前端操作日志面板展示指令名称/级别；④ 中枢审查取指令元数据。
import type { ChangeLevel } from "./steering";

// —— 指令类别（HARNESS §1）——
export type CommandCategory = "Narrative" | "World" | "Ledger" | "Media" | "Governance" | "System" | "Query";

// —— 触发源 ——
export type CommandTrigger = "user" | "ai" | "system" | "brain";

// —— LLM 依赖 ——
export type CommandLLM = "exec" | "brain" | "image" | "video" | "none" | "conditional";

// —— 治理点 ——
export type GovPoint = "gate" | "audit" | "schedule" | "control" | "none";

export type HarnessCommand = {
  id: string; // CMD-{类别}-{序号}，唯一
  name: string; // 中文名 + 英文标识
  category: CommandCategory;
  trigger: CommandTrigger;
  entry: string; // 现状入口：API 端点 或 函数
  action: string; // 一句话动作描述
  affects: string; // 影响的 WorldState 字段 / 数据面（""=不写状态）
  llm: CommandLLM;
  level: ChangeLevel; // L0-L3（对已完成叙事/账本的破坏性）
  failure: string; // 失败语义
  governance: GovPoint[]; // gate | audit | schedule | control | none（可组合）
  uiImpact?: string[]; // 完成后应更新的 UI 区域 ID（U01-U20，见 docs/COUPLING.md §1.2）
};

const C = (
  id: string,
  name: string,
  category: CommandCategory,
  trigger: CommandTrigger,
  entry: string,
  action: string,
  affects: string,
  llm: CommandLLM,
  level: ChangeLevel,
  failure: string,
  governance: GovPoint[],
  uiImpact?: string[],
): HarnessCommand => ({ id, name, category, trigger, entry, action, affects, llm, level, failure, governance, uiImpact });

/** 全部 88 条指令（HARNESS §2 全量登记，与 docs/HARNESS.md 一一对应） */
export const COMMANDS: HarnessCommand[] = [
  // ===== 2.1 叙事生成类（Narrative）=====
  C("CMD-N01", "立项建世界 newStory", "Narrative", "user", "/api/novel/new → director.ts:87", "灵感→世界设定+人物+自动蓝图确认", "全字段新建", "exec", "L1", "抛错不落盘", ["gate", "audit"], ["U06", "U08", "U13"]),
  C("CMD-N02", "写一章 step/writeOneChapter", "Narrative", "user", "/api/novel/step → director.ts:195", "完整写章管线（抽卡→考据→写→审→修补→commit）", "chapters/nextChapter/账本全集", "exec", "L2", "ReviewFailed 抛错零落盘", ["schedule", "gate", "audit"], ["U03", "U04", "U05", "U06", "U08", "U10"]),
  C("CMD-N03", "自动连载写章 runAuto", "Narrative", "user", "/api/novel/auto/start → autorun.ts:71", "≤30 章主循环，每章 writeOneChapter+commit", "同上", "exec", "L2", "熔断/暂存/停", ["schedule", "gate", "control"], ["U03", "U06", "U16"]),
  C("CMD-N04", "重试暂存草稿 retryChapter", "Narrative", "system", "director.ts:428", "暂存区草稿按审查意见重写→pass 才 commit", "同上", "exec", "L2", "不过则留暂存区", ["schedule", "gate"], ["U06", "U16"]),
  C("CMD-N05", "原位重写章节 regenerateChapter", "Narrative", "user", "/api/novel/chapter/regenerate、/rewrite", "版本快照→重写→审→记账", "ch.text/review/versions/账本", "exec", "L2", "失败保留旧版", ["gate", "audit"], ["U03", "U06", "U08", "U18", "U19"]),
  C("CMD-N06", "手动编辑章节 editChapter", "Narrative", "user", "/api/novel/chapter/edit → director.ts:808", "改正文留版本→自动审查→记账重算", "ch.text/review/versions/appearedIn/账本", "exec", "L2", "审查失败仍保存", ["gate", "audit"], ["U03", "U06", "U08", "U18"]),
  C("CMD-N07", "回滚章节版本 rollbackChapter", "Narrative", "user", "/api/novel/chapter/rollback → director.ts:843", "回滚历史版本+记账重算", "ch.versions/账本/chapterSummaries", "exec", "L2", "记账失败降级摘要", ["gate", "audit"], ["U03", "U06", "U08", "U18"]),
  C("CMD-N08", "删章 deleteChapter", "Narrative", "user", "/api/novel/chapter/delete → director.ts:965", "两阶段（预览/merge/abort）级联删除", "chapters/伏笔/时间线/本章计划/delta/媒体", "conditional", "L3", "预览仅只读", ["gate", "audit"], ["U03", "U04", "U05", "U06", "U08", "U10", "U11"]),
  C("CMD-N09", "单章重审 reReviewChapter", "Narrative", "user", "/api/novel/chapter/review → director.ts:983", "仅重审不重写", "ch.review", "exec", "L1", "审查失败不写", ["audit"], ["U06", "U19"]),
  C("CMD-N10", "审查+修补循环 reviewFixLoop", "Narrative", "ai", "director.ts:309（N02 内部）", "审查→patch/rewrite ≤2 轮", "不写状态（产出 verdict）", "exec", "L0", "轮尽未过走 requirePass", ["none"], ["U06"]),
  C("CMD-N11", "段落修补 patchChapter", "Narrative", "ai", "patch.ts:39", "按 evidence 只重写命中段", "不写状态（产出 text）", "exec", "L0", "patched=false 回退整章", ["none"], []),
  C("CMD-N12", "流式写正文 writeChapter", "Narrative", "ai", "writer.ts:117", "流式写章+字数治理（short 续写 1 次）", "不写状态（产出草稿）", "exec", "L0", "空正文重试一次", ["none"], ["U06"]),
  C("CMD-N13", "停止连载 stopAuto", "Narrative", "user", "/api/novel/auto/stop", "置停止标志", "会话文件", "none", "L0", "—", ["control"], ["U16"]),
  C("CMD-N14", "跳过暂存草稿 auto/skip", "Narrative", "user", "/api/novel/auto/skip", "放弃暂存区草稿", "chapterPlans/nextChapter", "none", "L1", "—", ["control", "audit"], ["U04", "U10", "U16"]),
  C("CMD-N15", "关闭连载会话 clear-session", "Narrative", "user", "/api/novel/auto/clear-session", "清会话/暂存区", "会话文件", "none", "L0", "—", ["control"], ["U16"]),
  C("CMD-N16", "立即打断写作 requestInterrupt", "Narrative", "user", "/api/novel/intervene(interrupt) → steering.ts:11", "内存打断信号", "内存 Map（非 WorldState）", "none", "L0", "—", ["control"], ["U06"]),

  // ===== 2.2 世界构建类（World）=====
  C("CMD-W01", "生成大纲要点 generateOutline", "World", "user", "/api/novel/outline → director.ts:538", "生成 3-6 条情节要点", "outline", "exec", "L1", "失败不写", ["gate", "audit"], ["U08", "U13"]),
  C("CMD-W02", "生成蓝图候选 buildBlueprint", "World", "user", "/api/novel/blueprint(generate) → planner.ts:38", "生成 2-3 套蓝图", "不写（返回 options）", "exec", "L0", "—", ["none"], ["U04"]),
  C("CMD-W03", "确认蓝图 confirmBlueprint", "World", "user", "/api/novel/blueprint(confirm) → planner.ts:89", "写蓝图+弧骨架+卷1 writing+expandArc", "blueprint/storyArcs/chapterPlans", "exec", "L2", "—", ["gate", "audit"], ["U04"]),
  C("CMD-W04", "编辑蓝图 blueprint edit", "World", "user", "/api/novel/blueprint(edit)", "直接改蓝图字段", "blueprint.compass/contract/mainPlot/ending", "none", "L2", "—", ["gate", "audit"], ["U04"]),
  C("CMD-W05", "展开弧章节计划 expandArc", "World", "ai", "/api/novel/plans(expand) → planner.ts:118", "生成 3-6 章章节计划追加", "chapterPlans/arc.status", "exec", "L1", "—", ["gate"], ["U04"]),
  C("CMD-W06", "补章节计划 ensureChapterPlan", "World", "ai", "planner.ts:173", "缺章节计划时选弧并展开", "同 expandArc", "exec", "L1", "—", ["gate"], ["U04"]),
  C("CMD-W07", "编辑章节计划 plans edit", "World", "user", "/api/novel/plans(edit)", "直接改章节计划", "chapterPlans[].goal/beats/hookType", "none", "L1", "—", ["gate", "audit"], ["U04"]),
  C("CMD-W08", "核销章节计划 markChapterDone", "World", "ai", "planner.ts:193", "章节计划置 done，弧全 done 发边界事件", "chapterPlans[].status", "none", "L1", "—", ["audit"], ["U04"]),
  C("CMD-W09", "弧边界处理 handleArcBoundary", "World", "ai", "planner.ts:206", "弧/卷摘要+compass+下一卷+展开下一弧（3-4 次 LLM）", "arc.summary/vol.summary/compass/chapterPlans", "exec", "L2", "失败被 catch 不重试（缺陷）", ["gate", "schedule"], ["U04"]),
  C("CMD-W10", "更新指南针 updateCompass", "World", "ai", "planner.ts:240", "卷边界校准 compass", "blueprint.compass", "exec", "L1", "失败静默", ["gate"], ["U04"]),
  C("CMD-W11", "旧故事自愈 healLegacyStory", "World", "ai", "planner.ts:289", "补最小蓝图+回填 done 章节计划+展开首弧", "blueprint/storyArcs/chapterPlans", "exec", "L1", "—", ["gate"], ["U04"]),
  C("CMD-W12", "世界编辑 editWorld", "World", "user", "/api/novel/world → director.ts:559", "手动改设定/角色/参数（L2 需策略三选一）", "author/premise/setting/characters/gen/outline", "conditional", "L2", "L2 无策略返 needIntervention", ["gate", "audit"], ["U05", "U08", "U13", "U14"]),
  C("CMD-W13", "角色改名传播 applyRename", "World", "ai", "director.ts:739（W12 内部）", "改名全书传播（关系/设定/正文/摘要）", "多字段+versions+appearedIn", "none", "L2", "—", ["gate", "audit"], ["U05", "U08", "U13"]),
  C("CMD-W14", "世界书 lore auto/save", "World", "user", "/api/novel/lore", "自动生成/保存世界书", "lore", "none", "L1", "—", ["gate", "audit"], ["U13"]),
  C("CMD-W15", "历史考据 ensureResearch", "World", "ai", "director.ts:145", "真实模式自动考据", "lore（考据条目）", "none", "L1", "—", ["audit"], ["U13"]),
  C("CMD-W16", "风格指纹 style", "World", "user", "/api/novel/style → style.ts:61", "样章提取风格指纹", "gen.styleSample/styleFingerprint", "exec", "L1", "—", ["gate", "audit"], ["U13"]),
  C("CMD-W17", "生成卡池 gachaGenerate", "World", "user", "/api/novel/gacha(generate) → director.ts:502", "LLM 生成候选卡池", "pendingCards", "exec", "L0", "—", ["audit"], ["U12"]),
  C("CMD-W18", "应用卡牌 gachaApply/applyCards", "World", "user", "director.ts:513 / cards.ts:73", "伏笔卡入账/角色卡入提案/其余入 cards", "foreshadowing/characterProposals/cards", "none", "L1", "—", ["gate", "audit"], ["U05", "U08", "U09"]),

  // ===== 2.3 状态记账类（Ledger）=====
  C("CMD-L01", "章末记账 settleChapter", "Ledger", "ai", "chronicler.ts:315", "1 次 LLM 定稿结算（摘要+7 类 delta）", "账本全集（经 applySettle）", "exec", "L2", "失败降级纯文本摘要", ["gate", "audit"], ["U05", "U08"]),
  C("CMD-L02", "应用记账 delta applySettle", "Ledger", "ai", "chronicler.ts:108", "逐项应用：伏笔/角色/关系/规则/时间线/摘要/登场", "foreshadowing/characters/setting/timeline/current/plotThreads/chapterSummaries/appearedIn", "none", "L2", "—", ["gate"], ["U05", "U08"]),
  C("CMD-L03", "单章账本重结算 chapter/resettle", "Ledger", "user", "/api/novel/chapter/resettle", "重跑 settleChapter 覆盖 delta", "账本+chapterDeltas", "exec", "L2", "—", ["gate", "audit"], ["U05", "U08"]),
  C("CMD-L04", "完整性重结算 integrity resettle", "Ledger", "user", "/api/novel/integrity(resettle)", "resetChapterLedger+settleChapter", "账本+chapterDeltas", "exec", "L2", "—", ["gate", "audit"], ["U05", "U08"]),
  C("CMD-L05", "撤章账本 resetChapterLedger", "Ledger", "ai", "chronicler.ts:348", "撤销本章记账（伏笔/时间线/exit）", "foreshadowing/timeline/characters[].exit", "none", "L2", "—", ["gate", "audit"], ["U05", "U08"]),
  C("CMD-L06", "重算登场 recomputeAppearedIn", "Ledger", "ai", "chronicler.ts:84", "按正文重算登场章", "characters[].appearedIn", "none", "L1", "—", ["audit"], ["U05", "U08"]),
  C("CMD-L07", "伏笔增删改 foreshadow", "Ledger", "user", "/api/novel/foreshadow", "零 LLM 伏笔 CRUD", "foreshadowing", "none", "L1", "—", ["gate", "audit"], ["U05", "U08"]),
  C("CMD-L08", "生成章摘要 summarizeChapter", "Ledger", "ai", "memory.ts:23", "LLM 章摘要", "不写（返回）", "exec", "L0", "—", ["none"], []),
  C("CMD-L09", "归并阶段摘要 summarizeRange", "Ledger", "ai", "memory.ts:66", "LLM 阶段摘要归并", "不写（返回，写入方在弧边界）", "exec", "L0", "—", ["none"], []),
  C("CMD-L10", "落盘摘要 upsertSummary", "Ledger", "ai", "memory.ts:55", "按 index 覆盖/追加摘要", "chapterSummaries", "none", "L1", "—", ["audit"], ["U08"]),
  C("CMD-L11", "提案确认/拒绝 proposal confirm/reject", "Ledger", "user", "/api/novel/proposal", "新角色入册（自动生成头像/立绘，后台 CMD-M07/CMD-M08）", "characterProposals[].status/characters", "image", "L2", "—", ["gate", "audit"], ["U09", "U13"]),
  C("CMD-L12", "质量债登记 registerDebt", "Ledger", "ai", "director.ts:163", "登记质量债", "qualityDebt", "none", "L1", "—", ["audit"], ["U15"]),
  C("CMD-L13", "质量债修复/忽略 debt fix/ignore", "Ledger", "user", "/api/novel/debt", "fix 注入 mergeTasks/ignore 置状态", "qualityDebt[].status/chapterPlans[].mergeTasks/outline", "none", "L1", "—", ["gate", "audit"], ["U04", "U15"]),

  // ===== 2.4 媒体类（Media）=====
  C("CMD-M01", "分镜规划 planScenes", "Media", "user", "/api/novel/media/plan → media.ts:819", "LLM 从正文挑段转写视觉 prompt（候选池去重）", "只读（返回 ScenePlan[]）", "exec", "L0", "3 次重试", ["none"], ["U19"]),
  C("CMD-M02", "生成章节插画 generateSceneImage", "Media", "user", "/api/novel/media/generate → media.ts:952", "i2i 前缀+人数守卫+画风后缀→图像 API", "chapters[].media", "image", "L0", "异步失败置 error", ["audit", "schedule"], ["U06", "U07"]),
  C("CMD-M03", "生成章节视频 createSceneVideo", "Media", "user", "media.ts:989", "i2v 首帧/t2v，5-15s", "chapters[].media(videoId)", "video", "L0", "异步轮询", ["audit", "schedule"], ["U06", "U07"]),
  C("CMD-M04", "媒体状态回写 media/status", "Media", "user", "/api/novel/media/status", "轮询视频任务结果回写", "chapters[].media[].status/error/path", "none", "L0", "429 返 rate_limited", ["audit"], ["U06", "U07"]),
  C("CMD-M05", "改词重生成 media/regenerate", "Media", "user", "/api/novel/media/regenerate", "改 prompt 重生成", "media[].prompt/path/status", "image", "L0", "—", ["audit"], ["U06", "U07"]),
  C("CMD-M06", "删除媒体 media/delete", "Media", "user", "/api/novel/media/delete", "删除媒体条目+磁盘文件", "chapters[].media", "none", "L0", "—", ["audit"], ["U06"]),
  C("CMD-M07", "生成角色立绘 generateCharacterPortrait", "Media", "user", "/api/novel/character/portrait → media.ts:628", "i2i 参考（必须参考头像）→竖版立绘（角色创建后自动触发，actor=system）", "characters[].portrait", "image", "L0", "—", ["audit"], ["U13", "U19"]),
  C("CMD-M08", "生成角色头像 generateCharacterAvatar", "Media", "user", "/api/novel/image(character) → media.ts:671", "纯文生（仅角色自身字段属性）→方形头像（角色创建后自动触发，actor=system）", "characters[].image", "image", "L0", "—", ["audit"], ["U13"]),
  C("CMD-M09", "生成封面 image cover", "Media", "user", "/api/novel/image(cover)", "生成封面", "cover", "image", "L0", "—", ["audit"], ["U01", "U13"]),
  C("CMD-M10", "上传封面 cover/upload", "Media", "user", "/api/novel/cover/upload", "上传本地封面", "cover", "none", "L0", "—", ["audit"], ["U01", "U13"]),
  C("CMD-M11", "后台补角色视觉 schedulePortraitFor", "Media", "system", "routes.ts:120", "媒体生成后 fire-and-forget 补头像+立绘（委托 ensureCharacterVisuals）", "characters[].portrait/image", "image", "L0", "—", ["none"], ["U13"]),
  C("CMD-M12", "异步批量生图 imageGenTasks", "Media", "system", "routes.ts:1270", "插画异步批量生成锁内回写", "chapters[].media", "image", "L0", "—", ["schedule"], ["U06", "U07"]),

  // ===== 2.5 干预治理类（Governance）=====
  C("CMD-G01", "干预影响报告 impactReport", "Governance", "user", "/api/novel/intervene(report) → steering.ts:82", "确定性受影响章+LLM 冲突评估", "只读（返回 ImpactReport）", "exec", "L0", "LLM 失败降级确定性部分", ["none"], ["U17"]),
  C("CMD-G02", "应用干预策略 applyStrategy", "Governance", "user", "steering.ts:127", "abort/merge(mergeTasks)/rewrite(rewriteQueue)", "chapterPlans[].mergeTasks/outline/rewriteQueue/changeLog", "none", "L2", "—", ["gate", "audit"], ["U04", "U11"]),
  C("CMD-G03", "字段锁 setFieldLock", "Governance", "user", "/api/novel/lock → steering.ts:66", "角色字段锁增删", "lockedFields", "none", "L1", "—", ["audit"], ["U13"]),
  C("CMD-G04", "世界补丁分级 classifyWorldPatch", "Governance", "ai", "steering.ts:61", "L0/L2 分级判定", "只读", "none", "L0", "—", ["none"], []),
  C("CMD-G05", "写变更日志 logChange", "Governance", "ai", "steering.ts:34", "审计日志追加（上限 500）", "changeLog", "none", "L0", "—", ["audit"], ["U20"]),
  C("CMD-G06", "回溯重写队列消费 rewrite start", "Governance", "user", "/api/novel/rewrite", "按序 regenerateChapter 消费队列", "chapters/rewriteQueue/账本", "exec", "L2", "单章失败即停剩余保留", ["gate", "schedule"], ["U03", "U06", "U08", "U11"]),
  C("CMD-G07", "清空重写队列 rewrite clear", "Governance", "user", "/api/novel/rewrite(clear)", "清空队列", "rewriteQueue", "none", "L1", "—", ["audit"], ["U11"]),
  C("CMD-G08", "请求打断 requestInterrupt", "Governance", "user", "steering.ts:11（N16 同源）", "内存打断信号", "内存 Map", "none", "L0", "—", ["control"], ["U06"]),

  // ===== 2.6 系统机制类（System）=====
  C("CMD-S01", "完整性扫描 auditWorld", "System", "user", "/api/novel/integrity(scan) → integrity.ts:147", "零 LLM 确定性审计", "只读（产 findings）", "none", "L0", "—", ["none"], ["U17"]),
  C("CMD-S02", "自动修复 autoRepair", "System", "user", "/api/novel/integrity(repair) → integrity.ts:210", "幂等修复孤儿数据+重算登场", "孤儿摘要/时间线/本章计划/债务/appearedIn", "none", "L2", "绝不删正文/媒体/伏笔", ["gate", "audit"], ["U03", "U04", "U05", "U06", "U08"]),
  C("CMD-S03", "级联删章 deleteChapterCascade", "System", "ai", "integrity.ts:293", "delta 回退+媒体清理+登场重算+nextChapter--", "chapters/账本/媒体/nextChapter", "none", "L3", "—", ["gate", "audit"], ["U03", "U05", "U06"]),
  C("CMD-S04", "变更回退 applyChapterDeltaRevert", "System", "ai", "integrity.ts:31", "git revert 语义回退账本", "账本全集", "none", "L2", "后续章改过则保留+warning", ["gate"], ["U05", "U08"]),
  C("CMD-S05", "磁盘孤儿媒体收集 collectOrphanMediaFiles", "System", "system", "integrity.ts:257", "收集磁盘孤儿媒体", "只读收集", "none", "L0", "—", ["none"], []),
  C("CMD-S06", "旧存档对齐 alignWorld", "System", "system", "integrity.ts:247", "迁移旧存档字段", "多字段", "none", "L1", "—", ["audit"], []),
  C("CMD-S07", "启动恢复连载 resumeAutoSessions", "System", "system", "routes.ts:1816（dev.ts/prod.ts 触发）", "重启后自动续跑 running 会话", "同 N03", "exec", "L2", "—", ["schedule", "control"], ["U16"]),
  C("CMD-S08", "读时自愈钩子 state 钩子", "System", "system", "/api/novel/state", "打开后后台重算登场+媒体迁移+autoRepair（无锁读不阻塞，后台锁内落盘）", "appearedIn/ch.media（dirty 时 saveWorld）", "none", "L1", "—", ["audit"], ["U03", "U05", "U08"]),
  C("CMD-S09", "整书评估 evaluateBook", "System", "user", "/api/novel/eval → eval.ts:49", "8 维 LLM 评估（缓存指纹）", "只读（写 eval.json）", "brain", "L0", "缓存兜底", ["none"], ["U15"]),
  C("CMD-S10", "限流排队 limiter", "System", "system", "limiter.ts", "text 5/40、image 5/40、video 1/2 并发限流", "影响所有 LLM/媒体行为", "none", "L0", "排队不 429", ["schedule"], []),
  C("CMD-S11", "中枢视觉巡检 sweepVisualGaps", "System", "system", "routes.ts:236（dev.ts/prod.ts 启动触发，每 60s）", "扫描所有故事角色，头像/立绘缺失自动补全（1 分钟冷却）", "characters[].portrait/image", "image", "L1", "冷却兜底防烧配额", ["schedule", "audit"], ["U13"]),

  // ===== 2.7 查询只读类（Query）=====
  C("CMD-Q01", "读世界状态", "Query", "user", "/api/novel/state", "读世界+自愈钩子", "只读（条件写见 S08）", "none", "L0", "—", ["none"], ["U03", "U06", "U08"]),
  C("CMD-Q02", "故事列表", "Query", "user", "/api/novel/list", "列表", "只读", "none", "L0", "—", ["none"], ["U01"]),
  C("CMD-Q03", "导出 md/epub", "Query", "user", "/api/novel/export", "导出", "只读", "none", "L0", "—", ["none"], []),
  C("CMD-Q04", "变更日志", "Query", "user", "/api/novel/changelog", "审计日志读", "只读", "none", "L0", "—", ["none"], ["U20"]),
  C("CMD-Q05", "连载状态", "Query", "user", "/api/novel/auto/status", "会话/暂存区查询", "只读", "none", "L0", "—", ["none"], ["U16"]),
  C("CMD-Q06", "媒体资产读取", "Query", "user", "/api/novel/asset", "读图片/视频文件", "只读", "none", "L0", "—", ["none"], ["U06", "U13"]),
  C("CMD-Q07", "健康检查", "Query", "user", "/api/health", "key 配置检查", "只读", "none", "L0", "—", ["none"], []),
  C("CMD-Q08", "单轮对话", "Query", "user", "/api/chat", "通用对话", "无 WorldState", "exec", "L0", "—", ["none"], []),
  C("CMD-Q09", "流式对话", "Query", "user", "/api/chat/stream", "SSE 对话", "无 WorldState", "exec", "L0", "—", ["none"], []),
  C("CMD-Q10", "联网搜索", "Query", "user", "/api/search", "anysearch 搜索", "只读", "none", "L0", "—", ["none"], []),
];

/** 按 ID 查指令（未知 ID 返回 undefined） */
export function getCommand(id: string): HarnessCommand | undefined {
  return COMMANDS.find((c) => c.id === id);
}

// —— 指令标签悬浮中文解释（全局统一：UI 渲染 CMD 标签处悬浮即用此文案，见 docs/HARNESS.md §1）——
const GOV_CN: Record<GovPoint, string> = { gate: "写前审查", audit: "审计留痕", schedule: "排队调度", control: "可打断/停止", none: "免治理" };
const LEVEL_CN: Record<ChangeLevel, string> = { L0: "只读/不破坏已落定状态", L1: "改变未来计划", L2: "改变已落定内容（可回滚）", L3: "全局不可逆" };
const TRIGGER_CN: Record<CommandTrigger, string> = { user: "用户触发", ai: "管线内部触发", system: "系统自动触发", brain: "中枢治理指令" };

/** 指令标签悬浮中文解释（多行）：指令名 / 动作 / 级别含义 / 触发源 / 治理点 */
export function commandTooltip(cmd: HarnessCommand): string {
  const gov = cmd.governance.filter((g) => g !== "none").map((g) => GOV_CN[g]).join(" + ") || GOV_CN.none;
  return [
    `${cmd.id} · ${cmd.name}`,
    cmd.action,
    `级别：${cmd.level}（${LEVEL_CN[cmd.level]}）｜触发：${TRIGGER_CN[cmd.trigger]}｜治理：${gov}`,
  ].join("\n");
}

/** 按治理点过滤 */
export function commandsByGovernance(g: GovPoint): HarnessCommand[] {
  return COMMANDS.filter((c) => c.governance.includes(g));
}

/** 指令级分级判定（写操作定位指令后取 level；未登记指令按 L0 保守处理） */
export function levelOf(id: string): ChangeLevel {
  return getCommand(id)?.level ?? "L0";
}

/** 指令统计（HARNESS §4：88 条 = N16 + W18 + L13 + M12 + G08 + S11 + Q10） */
export const COMMAND_COUNTS = {
  total: COMMANDS.length,
  byCategory: Object.fromEntries(
    ["Narrative", "World", "Ledger", "Media", "Governance", "System", "Query"].map((cat) => [
      cat,
      COMMANDS.filter((c) => c.category === cat).length,
    ]),
  ) as Record<CommandCategory, number>,
  writers: COMMANDS.filter((c) => ["L1", "L2", "L3"].includes(c.level)).length,
  readOnly: COMMANDS.filter((c) => c.level === "L0").length,
  l3: COMMANDS.filter((c) => c.level === "L3").length,
};
