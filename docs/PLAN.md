# 中枢与状态同步高可靠重构计划

## 1. 已确认缺陷

- 服务监听后才通过 `setTimeout(0)` 启动恢复，且媒体恢复 fire-and-forget，首次 WS 快照可能早于恢复。
- 前端同时消费 WS、状态 HTTP、命令响应和局部定时器，存在多个权威来源。
- `planTasks`、`visualTasks`、`videoRegen` 等进程内结构保存不可丢失事实；视觉终态没有淘汰。
- JSON 单文件原子写不能覆盖跨文件/任务/事件事务，部分持久化错误被吞掉。
- sync revision 是进程内计数且仅覆盖 world event，没有纪元、hash、游标和持久 outbox。
- 弹窗打开仍拉 `/api/brain/context`，前端仍轮询 new/step/auto/media 状态。

## 2. 实施清单

- [x] 创建 HARNESS/BRAIN/PLAN 契约文档。
- [ ] 扩充 Harness 元数据并增加文档一致性测试。
- [ ] 新增 SQLite command/job/sync/outbox/world_commit 表与访问层。
- [ ] 把 `saveWorld` 接入写前 journal、持久 revision 和 outbox。
- [ ] 增加启动恢复屏障，恢复完成前不监听业务端口。
- [ ] 迁移 plan/image/video/visual/cover/regen/autorun/advance/new-story/brain 任务状态。
- [ ] 实现登录级单 WS、严格 snapshot/patch 协议和服务纪元。
- [ ] 实现用户/故事/中枢统一 store、revision/hash 校验和 resync。
- [ ] 移除前端状态轮询、HTTP 状态双写及弹窗 context 请求。
- [ ] 删除业务状态查询接口，provider 轮询只留服务端内部。
- [ ] 补齐重启、断线、乱序、幂等、多 Tab、损坏数据测试。
- [ ] 全量 typecheck、Bun tests、build 和 3000 端口网络验收。

## 3. 提交顺序

1. `docs: 梳理系统指令、中枢架构与可靠性计划`
2. `feat: 引入 SQLite 命令任务账本与世界写前日志`
3. `feat: 建立启动恢复屏障和持久任务调度器`
4. `refactor: 迁移媒体、写作、中枢及自动生成任务状态`
5. `refactor: sync 升级为用户级版本化投影协议`
6. `refactor: 前端统一使用 sync store 并移除状态双写`
7. `refactor: 删除客户端状态查询接口与全部轮询`
8. `test: 覆盖刷新、断线、重启和多 Tab 一致性`
9. `docs: 完成可靠性计划验收记录`

## 4. 验收条件

- 登录成功即只有一根 sync WS；开关中枢、切会话 Tab 不影响连接。
- 切书通过同连接换订阅；首个权威 snapshot 到达前不开放编辑。
- 插画参数确认后不出现任何 state/status/context HTTP 请求。
- 任意完整 snapshot 后，所有 loading 都有对应持久活动 job。
- 重启后安全任务续跑，其余任务核对产物后明确成功或失败。
- 重复 commandId 不重复调用模型；陈旧 expectedRevision 返回冲突。
- 乱序、重复、缺口、hash 不符和 serverInstanceId 变化均能收敛。
- 启动恢复完成前不发送业务快照；恢复异常在 health 中可见。
- 所有删除接口 404，前端及测试不再引用。

## 5. 实施记录

每完成一阶段，在此记录提交哈希、验证命令、失败与修复。最终记录浏览器网络验收结果。若实施中发现计划外数据风险，先补充 HARNESS/BRAIN 契约，再修改代码。
