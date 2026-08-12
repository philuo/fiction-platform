# 墨枢中枢与同步架构

> 本文区分“当前已实施”与“后续演进”。中枢只负责意图、预览、命令和状态展示，不拥有第二份世界状态，也不通过弹窗生命周期控制同步连接。

## 1. 当前已实施架构

系统按三层组织：SQLite 控制面保存 command/job/revision/outbox/world journal；`state.json`、会话 JSON 和媒体文件保存大内容；HTTP 提交动作，sync WS 发布权威状态，SSE 只提供聊天/写作的低延迟文本增量。前端统一 store 是服务端投影缓存，组件局部 state 只负责临时交互。

登录态在应用根部立即建立一根用户级 `/api/sync`。打开或关闭中枢、切换会话 Tab 不创建或关闭它；切书在同一 socket 上订阅/退订故事 scope。服务端鉴权并按用户隔离频道。

### 1.1 状态分类

| 类别 | 当前示例 | 重启语义 |
|---|---|---|
| 持久权威事实 | WorldState、会话消息、command receipt、job、revision/hash、world journal、outbox | 恢复或明确收敛终态 |
| 可重建投影 | 书架、故事 system snapshot、中枢 session snapshot、任务卡 | 从持久事实和遗留存储重建 |
| 进程执行句柄 | socket/listener、Promise 锁、AbortController、provider timer、SSE emitter | 可丢失；不能单独证明业务成功 |
| 纯 UI 状态 | 当前 Tab、展开项、临时表单、短暂 submitting | 可丢失；不得成为服务端终态 |

### 1.2 当前 sync 协议

服务端首先发送 `hello { serverInstanceId, ready }`，随后按订阅发送带 `scope/document/revision/hash/cursor/data` 的 `library-snapshot`、`system-snapshot` 和 `brain-snapshot`。后续 library/system/brain 变化以 RFC 6902 `patch` 增量发送；world commit 仍以同事务 `document-changed` 通知触发完整 system 投影更新。连接可发送 `resume { cursor }` 补取 outbox；游标不可连续时服务端发送 `resync-required`，客户端重新订阅获得完整快照。

客户端遵循以下收敛规则：

1. 服务纪元变化时清空旧投影并等待新快照。
2. 旧 socket 的晚到 open/message/close 被世代检查丢弃。
3. 较旧 revision 被忽略；同 revision 但 hash 不同视为冲突并 resync；缺口同样 resync。
4. 完整任务集合采用覆盖语义，移除没有持久活动任务支撑的本地 loading/pending。
5. 中枢会话、任务卡和 system runtime 经 sync 更新；SSE 的断开或结束不定义权威 loading。
6. `brain-sessions.json` 采用唯一临时文件原子替换；Windows 短暂 `EPERM/EBUSY/EACCES` 会有限退避重试，失败继续向调用方传播。

投影正文以规范化 JSON 存入 `sync_scopes.document_json`，正文、revision/hash 和 patch outbox 在同一事务提交。客户端仅在 `baseRevision` 连续时应用 add/remove/replace，并重新计算 SHA-256；数组作为原子值替换，保证正确性并避免运行态心跳重复携带未变化的 world 正文。

### 1.3 世界提交与启动屏障

世界写入流程为：登记 prepared `world_commits` → 原子替换 `state.json` → SQLite 事务提交 revision、hash、outbox 和 journal 终态。启动时磁盘 hash 等于新值则补提交，等于旧值则中止；既不匹配新旧值则标 conflict，禁止静默覆盖未知内容。

启动顺序为：数据库迁移 → journal 恢复 → 孤儿 job 收敛 → 媒体/连载恢复钩子 → ready → 监听。可安全恢复的视频 watcher 和自动连载保留恢复态；无法证明完成的孤儿任务标 `interrupted`。WS 不在恢复屏障前提供业务快照。

## 2. 命令与任务状态机

```text
received -> queued -> running -> waiting_external -> succeeded
                    |              |
                    +-> paused     +-> failed
                    +-> interrupted/cancelled/failed
```

`commandId + requestHash` 支持同内容重试返回原回执、不同内容冲突；job 活动态由 SQLite 部分唯一索引仲裁。`createJob` 同时处理“先查后插”的跨进程竞争，唯一索引命中后返回胜出的既有 job。视频创建已用此约束替代进程内 busy Set。

`POST /api/commands` 已提供严格白名单的统一入口，当前开放 N01/M01/M02：请求先登记 `commandId + requestHash`，同内容重试返回原回执，不同内容或跨用户复用返回 409，后台执行与 HTTP 连接解耦。其余旧 HTTP 命令尚未全部迁入，覆盖性命令的 `expectedRevision` 也尚未在所有旧入口强制执行。

## 3. SSE 与中枢恢复

- `/api/brain/chat` 的 SSE 只传 reset/delta/done/error；断线移除订阅者，不应把业务终态改为成功。
- 会话正文和消息检查点持久化；sync 发布会话列表、消息状态、卡片状态和 completed keys。
- 打开/关闭中枢以及切换会话只改变 UI 选择，不请求已删除的 `/api/brain/context`。
- 刷新后以 sync 快照恢复权威状态；只有服务端仍显示活动任务时才允许继续附着文本流。
- 服务重启后无法安全续跑的模型调用标 interrupted，不自动重复消耗额度。

### 3.1 卡片执行状态机与人工操作收敛

所有可执行卡在服务端进入会话前获得稳定 `cardId` 和初始 `executionState`。状态机为：

```text
idle -> submitting -> running -> succeeded|failed|interrupted|cancelled
  |          |
  +----------+-> waiting_confirmation -> submitting
```

- 同步命令在原卡更新状态、详情和时间，不追加成功/失败 result 卡；独立系统通知才允许新增消息。
- 终态更新幂等，终态卡拒绝晚到的 `running/submitting` 帧，防止乱序或重复 sync 重新激活指令。
- L2 干预表单原地转换成确认卡，沿用原 `cardId/commandId`；确认、放弃和失败继续更新同一卡片。
- 章节删除/回滚/重写/续写/账本重算、角色及关系变更、媒体删除会先取消匹配 job，再将关联未决卡收敛为 `interrupted/cancelled`，并发布 `card-replaced` 与完整 brain 投影。匹配基于章节、角色和媒体锚点，不中断无关会话任务。
- 完整 brain 快照覆盖本地消息、卡片和会话集合；没有服务端持久活动态支撑的本地 loading 必须消失。

### 3.2 面板意图与关系查询

自动打开弹窗使用持久 `panelIntent { intentId,target,opts,consumedAt,consumedBy }`。客户端只处理最新未消费意图，并在服务端原子消费成功后才打开；其它 Tab、刷新、切会话和服务重启看到 `consumedAt` 后不得重放。旧 `open` 卡和旧“新角色提案”标题卡在服务端快照阶段迁移，前端不保留依赖挂载次数的标题兜底。

关系查询输出规范化 `RelationshipSubgraph`，边以角色 id 表达；兼容旧 `label -> name` 与当前 `name -> label` 格式，双向关系去重。指定角色时只保留焦点及一跳邻居；中枢卡和关系弹窗只读模式复用 `RelationshipGraphCanvas`，编辑模式仍由关系弹窗持有写能力。

## 4. 内存对象与遗留存储审计

| 对象 | 当前用途 | 风险/结论 |
|---|---|---|
| `titleLocks` | 单进程书级串行化 | 可留作执行优化；跨进程冲突必须靠 revision/job 约束 |
| sync socket/listener/throttle timer、`videoWatchers` timer | 连接、合并通知、provider 查询句柄 | 可留内存；重启由持久 provider id/job 重建或收敛 |
| brain task emitter/AbortController、前端 abort/cache/展开集合 | 流式执行和 UI 缓存 | 可留内存；会话检查点/job 才能决定用户可见终态 |
| `panelConsumingRef`、Canvas 布局/缩放/拖拽状态 | 一次请求防抖和纯 UI 状态 | 可留内存；权威消费时间及关系数据均已持久化 |
| `activeAuto` | 连载循环执行镜像 | 可留内存；会话、checkpoint、暂停/停止意图和终态均由 auto job 持久化 |
| `planTasks`、`imageGenTasks` | 分镜/生图执行句柄和流内即时结果 | 可留内存；job/world 保存恢复依据与用户可见终态，重启恢复不依赖 Map |
| `visualInFlight`、`coverInFlight` | 单进程并发优化 | 可留内存；SQLite 活动 job 唯一约束负责权威仲裁，视觉终态缓存已移除 |
| 视频重生成 recovery job | 视频回滚上下文、重生成互斥 | 已迁入 SQLite；watcher 重启后按 dedupeKey 读取旧 id/path，成功/失败/超时收敛 job |
| `scope_tombstones`、读自愈 Set | 持久删除墓碑/短期去重 | 墓碑已迁入 SQLite；纯自愈执行锁可留内存 |
| `media-auto-generate` job / 前端倒计时展示 | 自动生成 deadline 与展示 | deadline/scenes/session 已持久并由服务端恢复；前端 interval 只更新剩余秒数，不触发业务命令 |
| new-story/advance/autorun 旧 JSON | 兼容导入源 | 首次读取一次性导入 job 后删除旧文件；不再作为运行时权威事实 |

由此可见，“内存中存在 Set/Map”本身不是问题；风险取决于它是否是用户可见业务事实的唯一副本。连接、锁和执行句柄可以留内存，任务状态、幂等键、取消意图、倒计时、provider id、删除墓碑和回滚数据必须持久化。

## 5. 多 Tab、故障和一致性不变量

- 每个 Tab 可有自己的用户级 WS，但单个应用实例只维持一根；所有 Tab 共享服务端 revision，命令靠幂等键和唯一活动 job 防重。
- logout/token 失效关闭 WS 并清空 store；订阅 scope 必须验证所有权。
- 任意完整快照后，本地不得保留服务端不存在的活动任务。
- 世界 revision 只在文件写成功后推进；world outbox 与 revision 同一 SQLite 事务提交。
- 持久化失败必须传播为任务失败，不能只打印 warning 后返回成功。
- 数据损坏或 revision/hash 冲突必须显式报错，不能用空对象覆盖客户端有效状态。

## 6. 后续演进顺序

1. 将进程内执行表继续收窄为 jobId 到 AbortController/timer/provider watcher 的句柄映射。
2. 增加租约续期与过期执行器接管，支持多进程安全恢复。
3. 增加 outbox 压缩/保留策略和故障注入。
4. 在具备测试账号后完成登录态浏览器网络验收。
