# 墨枢中枢与同步架构

## 1. 职责边界

中枢负责理解意图、生成预览、提交 Harness 指令、展示权威状态和治理结果。它不拥有第二份世界状态，也不通过弹窗生命周期控制任务或同步连接。

系统采用控制面/内容面分离：

- 控制面：SQLite 保存命令回执、任务生命周期、同步 revision/outbox、世界提交 journal。
- 内容面：`state.json`、章节版本、会话正文与媒体文件保存大对象。
- 传输面：HTTP 提交命令，sync WS 发布权威投影，SSE 只传实时文本增量。
- 客户端：统一 store 是服务端投影缓存；组件局部 state 只负责交互。

## 2. 状态分类

| 类别 | 示例 | 重启语义 |
|---|---|---|
| 持久权威事实 | WorldState、会话消息、command、job、revision、取消意图、providerId | 必须恢复或明确收敛终态 |
| 可重建运行态 | 书架元信息、待办统计、中枢 context、任务卡投影 | 从权威事实重建，不独立写入 |
| 进程执行句柄 | Promise 锁、AbortController、socket、listener、provider timer | 可丢失，由 job 恢复策略重新建立或收敛 |
| UI 状态/缓存 | 当前 Tab、展开消息、草稿输入、IndexedDB 文本缓存 | 可丢失，不参与业务一致性 |

## 3. 命令和任务状态机

```text
received -> queued -> running -> waiting_external -> succeeded
                    |              |                 
                    +-> paused     +-> failed
                    +-> interrupted/cancelled/failed
```

- 命令先以 `commandId + requestHash` 持久化，再允许执行外部调用。
- 同 commandId、同 hash 返回已有回执；不同 hash 冲突。
- 活动任务持有租约和 heartbeat。进程死亡后，恢复器按 job kind 判断安全续跑或核对后失败。
- 所有终态都写入 job、投影 revision 和 outbox；UI 不从“内存里是否还有 Promise”推导终态。
- 覆盖性命令使用 `expectedRevision`，防止旧 Tab 覆盖新事实。

## 4. 世界提交 Unit of Work

1. 在书级锁内加载最新世界并校验 expectedRevision。
2. 将新世界、旧/新 hash、目标 revision 记录为 prepared `world_commits`。
3. 原子替换 `state.json`，必要时保存版本/媒体引用。
4. 在 SQLite 事务内标记 journal committed，推进 `sync_scopes.revision` 并写 outbox。
5. 发布器读取 outbox 发送 patch；失败留在 outbox，重连可补发。

启动时若发现 prepared journal：磁盘 hash 等于新 hash 则补提交，等于旧 hash 则中止；其他情况进入恢复失败并拒绝对该书发布不可信快照。

## 5. sync 协议

登录后立即建立一根用户级连接。连接与书架页面、中枢弹窗、会话 Tab 无关；打开书仅改变订阅集合。

```ts
type ServerFrame =
  | { type: "hello"; serverInstanceId: string; ready: boolean }
  | { type: "snapshot"; scope: string; document: string; revision: number; hash: string; data: unknown }
  | { type: "patch"; scope: string; document: string; baseRevision: number; revision: number; hash: string; ops: JsonPatch[] }
  | { type: "pong" }
  | { type: "error"; code: string; error: string };
```

投影文档：

- `user/library`：书架和立项任务。
- `story/<slug>/system`：世界、autorun、pending chapter、advance 和所有活动/终态任务。
- `story/<slug>/brain`：会话元数据、消息检查点、卡片状态、completed keys。

客户端规则：

- snapshot 无条件替换同纪元、同文档旧状态。
- patch 仅在 `baseRevision === localRevision` 时应用；重复 revision 忽略，缺口或 hash 不符发送 resync。
- serverInstanceId 变化后先冻结交互，等待新 snapshot，不接受旧连接晚到帧。
- 完整任务集合是覆盖语义；本地多出的 pending/loading 必须删除。
- 大正文不随任务心跳重复传输。world、system runtime 和 brain 分文档发布。

## 6. SSE 与聊天恢复

- `/api/brain/chat` 和写作 SSE 只提供低延迟 delta，不拥有任务状态。
- 客户端断开只移除 emitter；任务继续执行并定期保存消息检查点。
- sync 推送 message pending/terminal 和持久正文检查点。刷新后先恢复 sync；任务仍活跃时才重新 attach SSE。
- 服务重启后未完成文本标 interrupted，保留最后检查点，不重新调用模型。
- 关闭中枢只卸载视图；不会断开 sync、取消任务或丢失卡片终态。

## 7. 启动恢复屏障

启动严格按以下顺序执行：数据库迁移 → world journal 恢复 → 孤儿 job 租约回收 → 媒体/会话卡核对 → autorun 安全续跑 → 构建初始投影 → ready → `Bun.serve`。

恢复规则：

- autorun 从最后已提交章节边界恢复。
- provider 视频凭 videoId 恢复 watcher；视频重生成恢复旧资源上下文。
- 分镜、生图、视觉、封面核对产物后成功或失败，不自动重耗额度。
- advance/new-story 核对目标事实，无法证明完成则失败。
- 无持久 job 对应的所有 pending/running 会话卡统一收敛为 interrupted/failed。

## 8. 多 Tab、切书与鉴权

- scope 包含 userId；logout/token 失效时关闭 WS 并清空 store。
- 多 Tab 共享服务端 revision，各 Tab 独立 cursor；命令依靠 commandId 和唯一活动 job 防重。
- 切书先订阅新 scope，收到首个 snapshot 后再解除旧 scope，避免 UI 空窗。
- 服务端校验订阅所有权和 WS 上行命令的 scope，不信任客户端 title。

## 9. 可观测与失效安全

- health 暴露 ready、恢复错误数、未提交 journal、活动/过期 job、outbox backlog。
- 任务日志至少包含 commandId/jobId/user/title/kind/status/revision，禁止记录密钥和完整正文。
- 数据损坏或 revision/hash 冲突时停止该 scope 写入并返回明确错误，不以空对象覆盖有效客户端状态。
- 定期清理终态 job/outbox，但保留审计窗口；内存执行句柄在终态立即删除。

