# 墨枢开发说明

> 本文是当前开发规范和模块边界的唯一事实来源。`BRAIN.md` 详述同步协议，`HARNESS.md` 是指令目录；`PLAN.md`、`FIND_BUG.md` 仅保存历史计划与审计证据。

## 1. 开发基线

- 使用 Bun，不引入 Node 专用开发服务器、Vite、Express 或额外状态管理框架。
- 安装：`bun install`；开发：`bun run dev`；类型检查：`bun run typecheck`。
- 测试：`bun test`；生产构建：`bun run build`；完整检查：`bun run check`。
- 文本模型读取 `TEXT_*`，未设置时回退 `AGNES_*`；搜索读取 `ANYSEARCH_API_KEY`。密钥只放 `.env`。
- 测试必须使用临时目录和 `APP_DB_PATH`，不得读取或修改正式 `data/`。

## 2. 模块与依赖

```text
src/contracts       跨端数据结构、命令和同步协议，无环境依赖
src/domain          故事、章节、计划、账本、治理、媒体纯规则
src/application     用例、端口、命令和任务编排
src/infrastructure  SQLite、JSON 存档及外部 provider 适配
src/transport       HTTP/SSE/WS 解析、鉴权和响应映射
src/frontend        应用壳及按业务功能组织的客户端代码
server              Bun 启动与依赖装配
```

依赖只允许从外向内：transport/frontend/infrastructure -> application -> domain -> contracts/shared。contracts 不得引用 React、Bun、SQLite、文件系统或 provider；application 不得引用具体基础设施；前端不得引用基础设施或服务端 transport。

`src/api`、`src/components` 和 `src/pages` 是兼容入口。迁移期间旧入口可重导出新模块，但新增业务不得继续扩大这些目录。`bun run check:architecture` 会检查循环依赖、跨层导入及命令注册完整性。

当前迁移状态：认证 HTTP 已迁入 `src/transport/http/auth-routes.ts`；统一命令总线位于 `src/transport/http/command-bus.ts`；`src/transport/http/routes/` 已按 brain/query/story/chapter/planning/governance/media/autorun 建立 handler 和唯一的路径归属表；sync transport 通过 `ProjectionSnapshotPort` 读取兼容投影适配器。composition root 已装配文件存档、SQLite job store、sync publisher、Agnes 模型及媒体 provider 适配器。第一轮 handler 仍委托 `src/api/routes.ts` 中的兼容业务实现，因此 `routes.ts` 尚未成为纯 transport，不能在调用方和特征测试迁完前删除旧入口。

前端已建立 typed command client，并将 Home 的故事、章节、媒体、自动连载和治理调用接入独立 feature command hooks；`Home.tsx` 仍是迁移中的组合壳。新增调用必须进入对应 `src/frontend/features/<feature>`，不得重新在 Home 内直接拼装命令协议。

## 3. 唯一事实来源

| 数据 | 权威来源 | 客户端规则 |
|---|---|---|
| 小说正文、世界、账本 | `state.json` + World Unit of Work | 只从 story system sync projection 更新 |
| 命令结果与幂等 | SQLite `command_receipts` | 相同 `commandId` 只重放，不自行推断终态 |
| 覆盖写版本 | SQLite `sync_scopes(scope=story/<title>, document=world)` | system snapshot 的 `worldRevision` 才是 `expectedRevision`；system 自身 revision 只管理非 world 投影 |
| 后台运行状态 | SQLite `jobs` | loading 必须能对应非终态 job |
| 书架、故事、Brain 投影 | `/api/sync` 单根 WebSocket | snapshot 覆盖，patch 校验 revision/hash |
| 流式正文 | SSE delta | 仅作可丢弃展示，不覆盖权威 world/store |
| system 非 world 字段失效 | `system-invalidated` + 新 system snapshot | 客户端重新请求权威快照，不在本地猜测字段 |
| React 本地状态 | 表单、选择、弹窗和动画 | 不保存服务端任务终态或世界副本 |

SSR 数据只负责首帧 bootstrap。首个相应 sync snapshot 到达后必须完全让位。HTTP 写响应表示命令提交/结果，不得直接双写 world、任务或 Brain store。

## 4. 核心不变量

1. 所有公开写操作必须登记在 `contracts/commands.ts` 和 HARNESS，客户端自动携带稳定 `commandId`。旧公开写 URL 同样必须带 `x-command-contract: v1`、`x-command-id` 和 `x-command-type`，不得绕过 CommandBus；需要 revision 的命令还必须提供 `expectedRevision`。
2. 覆盖性写操作必须带 `expectedRevision`；冲突返回 409，不使用旧快照覆盖新世界。
3. World Unit of Work 保持 prepared journal -> 原子替换 `state.json` -> revision/outbox 提交顺序。
4. 任意用户可见 pending/running 必须对应持久 job；进程内 Map/Set 只能保存 AbortController、timer、socket 和 watcher。
5. 任务终态单调，不得被晚到帧回滚；完整 snapshot 中不存在的任务必须清除客户端 loading。
6. 删除和同名重建通过 scope generation 隔离，旧 provider 结果不得写入新故事实例。
7. 已删除状态接口持续返回 404；禁止重新加入前端轮询。

## 5. 添加功能

### 新命令

1. 在 `contracts/commands.ts` 登记 id、canonical path、revision 要求和 `sync/job/stream` 执行模式。
2. 在 HARNESS 补充治理级别、影响区域和恢复语义。
3. 在 application 用例中实现行为，通过端口访问持久化/provider；transport 只校验输入并映射响应。
4. 添加首次执行、相同 commandId 重放、payload 冲突、revision 冲突和失败终态测试。
5. 将 canonical path 或兼容 URL 加入唯一的模块 route handler；架构检查必须能解析到且只能解析到一个 owner。preview、资源下载和只读查询不得登记成写命令。

### 新持久任务或同步字段

1. 任务先写 SQLite job，再启动外部副作用；记录 dedupe key、recovery、deadline 和关联 commandId。
2. 明确启动恢复策略和取消/晚到结果行为；内存 registry 不得成为事实来源。
3. 同步字段加入 contracts 和服务端 projection builder；客户端只通过 sync store 消费。
4. 添加重启、断线、多 Tab、重复帧、缺口和完整 snapshot 收敛测试。

### 新领域字段或前端功能

1. 在 contracts 定义兼容字段，并在存档迁移函数补默认值；禁止破坏旧 `state.json`。
2. 纯规则放 domain，用例放 application，具体 IO 放 infrastructure。
3. 前端代码归入 `frontend/features/<feature>`；只保留表单/弹窗等瞬时状态。
4. 覆盖旧夹具加载保存、SSR hydration、关键交互与构建。

## 6. 持久化边界

- `state.json`：正文、世界、计划和账本；章节版本外置在 `versions/`。
- `brain-sessions.json`：对话正文、卡片和完成标记；运行任务本身不以该文件为唯一依据。
- SQLite：用户/会话、偏好、command receipts、jobs、sync projections/outbox、world commits 和 scope generation。
- schema 变化必须提供幂等迁移、旧数据夹具、回滚说明；不得在业务模块临时执行散落 DDL。

## 7. 提交检查

提交前运行 `bun run check`、`bun run build` 和 `git diff --check`。涉及浏览器工作流时，再用唯一测试账号和隔离 `APP_DB_PATH` 验证登录、书架、切书、推进、自动连载、媒体、Brain 卡片和单根 `/api/sync` 连接；控制台不得出现 error/warn，网络中不得出现已删除状态接口。真实 provider 调用必须有次数和时间上限，外部配额、网络或 provider 故障要明确记录为环境失败，不得当作功能通过。测试结束必须删除测试故事、用户目录、媒体文件和临时数据库，并停止测试服务。

文档随行为同提交更新：开发约束改本文，协议改 BRAIN，命令改 HARNESS；历史计划只更新完成状态，不再作为当前实现说明。
