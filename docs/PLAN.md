# 中枢与状态同步高可靠重构计划

> 最后校准：2026-08-13。本文同时记录目标、已实施范围和未完成边界；未标记完成的项目不得被视为现有系统保证。

## 1. 缺陷证据与目标

本轮针对以下已确认问题：启动恢复晚于监听导致首帧陈旧；前端同时消费 WS、状态 HTTP、命令响应和本地定时器；业务事实保存在 `Map/Set`；JSON、任务和同步事件缺少跨介质提交协议；sync 缺少持久 revision、hash、服务纪元和断线游标；中枢弹窗生命周期会触发额外状态读取。

目标边界是：SQLite 保存控制面事实，文件保存大内容；登录后应用根部维持单根 sync WS；HTTP 负责提交动作而不成为客户端状态源；SSE 只提供可丢弃的文本增量；所有用户可见的活动态最终都能由持久事实重建或收敛。

## 2. 实施清单

- [x] 建立 `HARNESS.md`、`BRAIN.md`、`PLAN.md`，Harness 统计由代码注册表动态派生，不再依赖固定总数断言。
- [x] 新增 SQLite `command_receipts`、`jobs`、`sync_scopes`、`sync_outbox`、`world_commits` 及访问层。
- [x] `saveWorld` 接入 prepared journal、原子文件替换、持久 revision/outbox；启动恢复 prepared journal。
- [x] 增加启动恢复屏障；数据库迁移、journal/孤儿任务收敛和恢复钩子完成后才进入 ready/监听。
- [x] 建立登录级单根 WS；切书更换同一连接的订阅，中枢弹窗和会话 Tab 不拥有连接生命周期。
- [x] 实现 `serverInstanceId`、持久 revision/hash、完整 snapshot、RFC 6902 patch、同 revision/hash 冲突检测、缺口重同步、outbox cursor resume 和 `resync-required`。
- [x] 增加旧 socket 世代隔离，晚到的 open/message/close 不得覆盖新连接或启动第二条重连链。
- [x] 建立统一 sync store；完整投影以覆盖语义清除没有服务端活动任务支撑的 loading/pending。
- [x] 移除前端状态轮询、弹窗 `/api/brain/context` 请求及 HTTP 状态响应双写。
- [x] 删除客户端业务状态接口；第三方视频查询仅保留在服务端 watcher。
- [x] 将媒体规划、图片、视频创建、视觉、封面和部分自动生成活动态接入 SQLite job；视频创建使用数据库唯一约束仲裁跨 Tab/跨进程竞争。
- [x] 增加 Windows 会话文件原子替换有限重试，以及测试/热重载 SQLite 显式关闭能力。
- [x] 非 world 投影正文、revision/hash 与 RFC 6902 patch outbox 在同一 SQLite 事务提交；客户端按 base revision 应用后校验 SHA-256。
- [x] 新增严格白名单 `/api/commands`：N01/M01/M02 已支持 `commandId + requestHash` 幂等回执；旧端点保留兼容。
- [x] 视频重生成 old videoId/path 回滚上下文迁入 job recovery，互斥和删除冲突改由 SQLite 活动 job 仲裁。
- [x] 分镜完成后的自动生成从浏览器 Timer 迁为服务端持久 `media-auto-generate` job；重启恢复 deadline，手动触发/删卡原子取消 queued job。
- [x] 增加断线、游标、冲突、状态接口 404、任务恢复、快照收敛、多 Tab 相关自动化测试。
- [x] 完成 TypeScript、全量 Bun tests、生产构建和未登录页面浏览器冒烟。
- [x] 实现 RFC 6902 `patch` 生成和应用；对象字段递归、数组原子替换，非法路径/缺口/hash 冲突回退 snapshot。
- [ ] 将所有业务入口统一到单一 `CommandRequest/CommandReceipt` endpoint。当前入口与账本已建立并迁移 N01/M01/M02，其余旧入口仍逐步接入。
- [ ] 将 new-story、advance、autorun 等遗留 JSON 事实及所有剩余业务型内存表完整迁入 job/recovery 数据。
- [x] 将 library/system/brain 非 world 投影正文、revision/hash 与 patch outbox 纳入同一事务。
- [ ] 在具备测试账号的浏览器环境完成登录态网络验收。

## 3. 提交记录

| 阶段 | 提交 |
|---|---|
| 文档初稿 | `29ca0f8 docs: 梳理系统指令、中枢架构与可靠性计划` |
| SQLite 控制面与 WAL | `5b79270 feat: 引入 SQLite 命令任务账本与世界写前日志` |
| 启动恢复屏障 | `ef5a6a4 feat: 建立启动恢复屏障和持久任务调度器` |
| 登录级 sync 协议 | `d3f29a9 refactor: sync 升级为登录级版本化投影协议` |
| 删除状态接口/轮询 | `bea0b23 refactor: 删除客户端状态查询接口与全部轮询` |
| 媒体和自动任务迁移 | `e4a3eb4 refactor: 迁移媒体视觉及自动生成任务状态` |
| 前端 sync store | `f5db994 refactor: 前端统一使用 sync store 并移除状态双写` |
| 一致性测试 | `6244790 test: 覆盖刷新断线重启和多 Tab 一致性` |
| 游标与冲突收敛 | `7964002 refactor: sync 补齐游标恢复与冲突收敛` |
| 并发及测试可靠性 | `c77e407 fix: 收敛同步并发与全量测试可靠性` |
| RFC 6902 投影增量 | `24259cc feat: sync 使用事务化 RFC 6902 投影增量` |
| 视频回滚持久化 | `6d4ad65 refactor: 持久化视频重生成回滚状态` |
| 统一命令入口 | `ba09735 feat: 引入幂等统一命令回执入口` |
| 服务端定时生成 | `fb3e75c refactor: 服务端持久调度媒体自动生成` |
| 人工操作与中枢收敛 | `21a7b3f refactor: 统一人工操作与中枢任务失效收敛` |
| 面板意图持久消费 | `193faf9 fix: 持久化中枢弹窗意图一次性消费` |
| 指令卡原地状态机 | `2025769 refactor: 指令卡原地状态机与同步回执` |
| 关系查询只读子图 | `45197cb feat: 增加中枢关系查询只读子图` |
| 中枢聊天样式 | `b2f94db style: 优化中枢聊天卡片与滚动布局` |
| 中枢恢复测试 | `84b7343 test: 覆盖人工操作冲突与中枢恢复一致性` |

## 3.1 中枢聊天可靠性与交互计划执行记录

- [x] 章节/角色/关系/媒体人工操作统一收敛匹配 job 和中枢卡片，并发布权威 brain 快照。
- [x] `panelIntent` 持久一次性消费；兼容旧 `open` 和旧提案标题卡，移除组件本地标题重放兜底。
- [x] 可执行卡在 SSE 发送前获得稳定 cardId；同步命令成功、失败、中断和取消原卡迁移，不追加 result 卡。
- [x] L2 表单原地替换为 `waiting_confirmation` 确认卡，终态拒绝晚到 running 帧。
- [x] 关系查询输出基于角色 id 的一跳子图，兼容旧关系格式并去重；卡片与只读弹窗复用 Canvas。
- [x] 角色卡改为紧凑事实行、关系标签、出场徽章和默认折叠后续安排。
- [x] 聊天头部、Tab、消息区、上下文条和输入区尺寸稳定；长列表/正文/关系图独立滚动，移动端不溢出。
- [x] 新增人工变更收敛、终态乱序、面板消费、旧卡迁移、关系子图、空状态和紧凑角色卡测试。
- [ ] 登录态浏览器完成真实中枢操作与网络面板验收；当前环境没有既有测试账号，不能擅自创建账户。

## 4. 验证记录

- `bun test`：61 个测试文件，663 pass，0 fail，3721 assertions。
- `tsc --noEmit`：通过。
- `bun run build`：client 和 SSR 构建均通过。
- `git diff --check`：通过。
- 自动化网络契约：所有删除的状态接口返回 404；前端关键源码不再包含这些路径。
- 3000 端口浏览器冒烟：页面标题“墨枢”，登录/注册页正常，控制台无 error/warn。
- 浏览器限制：当前没有既有登录态，且不能擅自创建账号，因此尚未人工执行单根 `/api/sync`、开关中枢/切 Tab 连接数不变及插画确认后的真实网络面板断言。相关协议行为已有自动化覆盖，但不能替代这项人工验收。
- Bun 的 `--isolate` 与项目现有 `mock.module` 测试辅助方式不兼容，因此全量结论以普通隔离模型的 663/663 为准，不把 `--isolate` 设为默认。

## 5. 当前验收结论

本轮已消除用户最初报告的 `/api/novel/state`、`/api/novel/visual/status` 以及其他状态接口轮询，并将连接生命周期提升到登录级。刷新、WS 断线、服务纪元变化、重复/冲突帧和完整快照后的幽灵 loading 均有收敛机制。

系统可靠性仍是分阶段演进，而非一次性达到最终设计：RFC 6902、非 world 事务 outbox、统一命令入口骨架、视频回滚和服务端定时生成已完成；但在全部旧入口和遗留任务事实迁移前，不能宣称任意业务在任意崩溃点都严格 exactly-once。下一阶段应继续迁移 `activeAuto`、`planTasks`、`imageGenTasks`、`visualTasks`、删除墓碑及剩余取消意图，并扩大 `/api/commands` 白名单。
