# 墨枢系统指令总表

本文是系统指令的运行契约。治理目录位于 `src/api/harness.ts`，canonical 命令注册表位于 `src/contracts/commands.ts`；凡会读取或改变小说、任务、会话、媒体、审计数据的入口，都必须先登记再接入执行器。HTTP 是命令提交通道，sync WebSocket 是状态发布通道，SSE 只传输可丢弃的文本增量。治理目录当前为 88 条，公开命令注册表为 49 条；测试从代码动态计算分类和总数，不把数量当作不可变协议。

## 1. 通用指令契约

每条指令必须声明以下字段：

| 字段 | 含义 |
|---|---|
| `id/name/category/trigger` | 稳定指令编号、名称、类别和触发者 |
| `entry/action/affects` | 入口、动作及影响的数据面 |
| `level/governance/llm` | L0-L3 风险、治理点和外部模型依赖 |
| `idempotency` | 幂等键来源；用户命令统一使用客户端 `commandId` |
| `conflict` | 同书活动任务唯一约束或 `expectedRevision` 乐观并发策略 |
| `persistence` | 成功返回前必须提交的权威数据与任务记录 |
| `timeout/cancel/restart` | 超时、取消和服务重启后的确定行为 |
| `projection` | 完成后影响的 sync 文档 |
| `failure` | 可回显终态；禁止以永久 `pending/running` 代替异常 |

风险级别：L0 为只读或可重建产物，L1 改变未来计划，L2 改变已落定正文或账本但可回滚，L3 为删除或全局级联操作。

## 2. 对外命令

### 2.1 账号与基础设施

| 入口 | 语义 | 权威持久化 | sync/失败 |
|---|---|---|---|
| `POST /api/auth/register` | 注册并登录 | SQLite `users/sessions` | 建立用户 sync；冲突返回 409 |
| `POST /api/auth/login` | 登录 | SQLite `sessions` | 建立用户 sync；认证失败 401 |
| `POST /api/auth/logout` | 注销 | 删除服务端 session | 客户端清空全部投影 |
| `GET /api/auth/me` | 当前账号 | 只读 | 不进入业务投影 |
| `GET /api/health` | 服务/配置/恢复就绪度 | 只读 | 恢复屏障未完成时报告 not-ready |
| `POST /api/chat`, `/api/chat/stream`, `/api/search` | 无书级状态的通用模型能力 | 无或外部缓存 | HTTP/SSE 自包含，不写小说投影 |

### 2.2 叙事与连载（CMD-N01—CMD-N16）

| 指令 | 入口/动作 | 持久事实与并发 | 重启/投影 |
|---|---|---|---|
| N01 立项 | `novel/new`：灵感生成世界壳并增强 | `jobs(new-story)` 唯一活动任务；世界提交日志 | 壳已提交则保留，未完成增强标中断；用户投影+故事投影 |
| N02 单章推进 | `novel/step`：写作、审查、修补、结算 | `jobs(advance)`；同书写任务唯一；世界 revision | 无安全断点时核对目标章，不能证明完成则失败 |
| N03 自动连载 | `auto/start` | `jobs(autorun)` + 会话检查点；同书唯一 | 从最后已提交章节边界续跑 |
| N04 暂存稿重试 | 自动连载内部 | `pending-chapter` + autorun job | 草稿存在才允许重试 |
| N05/N06 重写/编辑 | `chapter/regenerate|edit|rewrite` | 必须匹配 `expectedRevision`；版本快照+世界提交 | 未提交不生效；故事投影 |
| N07 版本回滚 | `chapter/rollback` | expectedRevision；正文版本与账本同一提交 | 失败保持旧版本 |
| N08 删章 | `chapter/delete` 两阶段 | L3，预览 token + expectedRevision | 提交后不可由旧客户端覆盖 |
| N09-N12 审查、修补、写作内部步骤 | director/writer/patch | 结果只在所属 job 中间态保存，最终由世界提交发布 | 中断不得产生半章 |
| N13/N14/N15 | stop/skip/clear-session | 停止/跳过/清理意图持久化 | 重启不得误续跑已停止任务 |
| N16 立即打断 | `intervene:interrupt` | 持久取消意图；内存 AbortController 仅执行镜像 | 重启后不重复执行旧指令 |

### 2.3 世界、计划和账本（CMD-W01—W18、L01—L13）

这些指令覆盖大纲、蓝图、章纲、世界字段、世界书、风格、抽卡、伏笔、角色提案、质量债及章末结算。所有写操作遵守相同规则：

- L1-L3 命令携带 `commandId`；覆盖性修改携带 `expectedRevision`。
- `withTitleLock` 仅是单进程执行互斥，SQLite command/job 唯一约束才是权威冲突判断。
- 世界、账本、审计日志和新 revision 通过一次世界 Unit of Work 提交。
- HTTP 返回回执或只读预览；客户端世界只能由 sync 投影替换/增量更新。
- LLM 失败不得落半成品；允许的降级（例如摘要降级）必须写入审计日志。

### 2.4 媒体（CMD-M01—M12）

| 指令 | 持久任务 | 恢复策略 |
|---|---|---|
| M01 分镜规划 | `jobs(media-plan)`，场景结果写 job result | 重启后无结果则 interrupted，不自动重跑 LLM |
| M02 插画生成 | 每个 mediaId 一个 `jobs(image)`；章节 media 先写 pending | 有有效文件则补成功，否则失败 |
| M03 视频生成 | `jobs(video)` 保存 provider `videoId` | 有 videoId 则服务端恢复查询；客户端不轮询 provider |
| M04 视频状态回写 | 服务端 watcher 内部指令 | 终态写世界+job+outbox；无公开 status API |
| M05 重生成 | job 保存旧/new videoId、path 和交换阶段 | 新任务失败或超时可恢复旧视频 |
| M06 删除媒体 | expectedRevision + 删除墓碑 | 后台晚到产物读取墓碑并丢弃 |
| M07/M08/M09 | 立绘、头像、封面 | job 唯一约束 + 尝试时间 | 产物核对后成功/失败，不保留内存终态 |
| M10 上传封面 | 同步世界提交 | 文件与 world 引用均成功才完成 |
| M11/M12 自动补视觉/批量生图 | 服务端持久调度 | 刷新、弹窗、客户端定时器不影响执行 |

### 2.5 治理、系统与查询（CMD-G01—G08、S01—S11、Q01—Q10）

- 干预策略、字段锁、重写队列和自动修复统一走世界 Unit of Work，并记录 commandId、actor、level、reason。
- 完整性扫描、影响报告、导出、变更日志和评估报告属于只读结果，可继续使用 HTTP；它们不能成为运行状态来源。
- 启动迁移、journal 恢复、孤儿任务收敛、autorun 安全续跑和视觉巡检均登记为 system command，并写明确的恢复审计结果。
- 小说列表、任务状态、会话列表/详情、世界状态及中枢上下文属于 sync 投影，不提供独立状态 HTTP 接口。

## 3. WS 上行命令

| 消息 | 作用 | 幂等/权限 |
|---|---|---|
| `subscribe` | 在登录后单连接上订阅 user/story/brain 文档 | 服务端校验用户所有权；重复订阅幂等 |
| `unsubscribe` | 切书时移除不再需要的故事文档 | 不影响后台任务 |
| `resync` | revision 缺口/hash 不符时请求完整快照 | 只读、幂等 |
| `resume { cursor }` | 重连后请求补发该用户 cursor 之后的 outbox | 只读、幂等；缺口或不可补发时返回 `resync-required` |
| `media-form-values` | 保存中枢媒体表单值 | 转换为持久命令，按 commandId 去重 |
| `ping` | 保活 | 不改变业务状态 |

### 3.1 当前服务端帧

| 帧 | 含义 |
|---|---|
| `hello { serverInstanceId, ready }` | 声明服务纪元和恢复屏障状态 |
| `library-snapshot/system-snapshot/brain-snapshot` | 带 `scope/document/revision/hash/cursor/data` 的权威完整投影 |
| `document-changed` | outbox 中的轻量变更信号；客户端按 revision 拉取/重订阅完整投影 |
| `patch` | library/system/brain 的 RFC 6902 增量；携带 baseRevision/revision/hash/ops/cursor |
| `resync-required` | cursor 不连续、revision 缺口或 hash 冲突时要求完整重同步 |
| `pong/error` | 心跳或明确协议错误 |

RFC 6902 `patch` 已用于 library/system/brain；world 文件提交仍发送 `document-changed`，两者语义不可混用。M04 是服务端 provider watcher 的内部指令，不存在公开媒体状态查询 API。

### 3.3 中枢卡片命令契约

| 入口/事件 | 输入与幂等 | 持久化与投影 | 失败语义 |
|---|---|---|---|
| `POST /api/brain/sessions/update-card` | session/message/cardId + patch；同终态重放幂等 | 原卡写入会话 JSON并发布 `card-update` | 非法终态回滚返回 409；不得追加替代结果卡 |
| `POST /api/brain/sessions/replace-card` | messageId + cardIndex；替换后沿用稳定 cardId | 原位替换并发布 brain 变更 | 用于 form -> confirm、媒体阶段迁移；不存在返回 replaced=false |
| `POST /api/brain/sessions/consume-panel` | intentId + cardId；一次性 compare-and-set | 写 `consumedAt/consumedBy` 并立即发布 `card-update` | 已消费返回 consumed=false；客户端不得再次打开 |
| 人工领域写操作收敛 | commandId + 章节/角色/媒体影响范围 | 取消匹配 SQLite job，相关卡改 interrupted/cancelled，发布 `card-replaced` + brain snapshot | 持久化失败不得显示成功；无关卡不得误取消 |

所有 `preview/form/confirm/plan/opinion/browse/progress` 卡在服务端发送前获得稳定 `cardId`；执行态统一为 `idle/submitting/running/waiting_confirmation/succeeded/failed/interrupted/cancelled`。SSE 只能提前展示同一张卡，不得创建无 ID 的第二份卡片。

### 3.2 已删除的状态读取接口

下列路径固定返回 404，且客户端不得引用：

- `/api/novel/list`
- `/api/novel/new/status`
- `/api/novel/step/status`、`/api/novel/step/clear`
- `/api/novel/auto/status`
- `/api/novel/media/plan-status`
- `/api/novel/media/status`、`/api/novel/media/status-batch`
- `/api/novel/state`
- `/api/novel/visual/status`
- `/api/brain/context`

## 4. 内部状态与内存对象审计

| 对象 | 分类 | 结论 |
|---|---|---|
| title lock、限流等待队列 | 执行句柄 | 可留内存；重启释放，权威冲突由数据库约束 |
| WS socket、listener、timer | 连接句柄 | 可留内存；close 必须清理 |
| AbortController、SSE emitter、流式 delta buffer | 执行句柄 | 可留内存；持久 job/message checkpoint 决定终态 |
| React 展开项、选中项、临时表单 | UI 状态 | 可留内存或本地缓存，不得表示服务端任务终态 |
| `activeAuto/planTasks/imageGenTasks/visualTasks` 等 | 混合业务事实与句柄 | 已部分接入 SQLite jobs，但仍是迁移项；最终内存只保留 jobId→执行句柄镜像 |
| 视频重生成回滚、自动生成 deadline、幂等记录 | 业务事实 | 已进入 job recovery/command receipts；重启可恢复或收敛 |
| 删除墓碑、剩余取消意图 | 业务事实 | 仍需完整迁移，不能依赖进程内 Set/Map |

## 5. 一致性不变量

1. 目标不变量：任意用户可见 `pending/running` 都必须对应一条非终态持久 job；遗留任务尚在迁移，新增代码不得扩大例外。
2. 完整快照中不存在的活动任务会清除客户端 loading。
3. 世界 revision 只在文件提交成功后增加；outbox 与 revision 同一数据库事务提交。
4. 已接入命令账本的入口中，同一 commandId 不会重复产生外部调用或世界写入；旧入口仍需统一迁移。
5. 服务启动恢复完成前不监听业务请求、不发送业务快照。
6. sync 是状态唯一来源；HTTP/SSE 不能直接覆盖客户端权威 store。
7. 自动弹窗只能由未消费的持久 panelIntent 触发；组件重新挂载不是新意图。
8. 卡片终态不得被重复/乱序帧回滚；人工世界变更后，基于旧世界的关联 pending/running 卡必须立即收敛。

## 6. 当前实现边界

- 已实现：状态接口移除、登录级 sync、持久 revision/hash/outbox cursor、服务纪元、完整快照覆盖收敛、RFC 6902 patch、world journal、非 world 投影事务 outbox、统一命令入口骨架、视频回滚与自动生成 deadline 持久化。
- 统一入口已覆盖 `src/contracts/commands.ts` 中的 49 个公开命令；旧写 URL 仍作为兼容适配层存在，前端和测试尚未全部切换前不得删除。
- 遗留任务/取消/墓碑的持久化以 SQLite jobs、scope generation 和 recovery 字段为主，少数执行句柄仍在进程内 registry；多进程 claim/lease 属于后续可靠性阶段。
- 覆盖性旧 URL 的 `expectedRevision` 强制迁移仍按命令逐步收口；新增命令不得绕过统一入口。
- 因此 Harness 既是当前入口目录，也是迁移检查表；表中治理字段同时约束 canonical command 与兼容路由。
