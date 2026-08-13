# fiction-platform 重构后缺陷审计报告

## 2026-08-13 真实浏览器深度验收

### BROWSER-BUG-005 [P1] Brain 导出卡吞掉附件响应并把未下载误报为成功

- **首次发现**：2026-08-14 00:45（Asia/Shanghai）
- **场景**：`BRAIN-ACTION-EXPORT-01`，展开已有“导出全书”预览卡并点击“执行”。
- **复现**：在真实 Brain 历史会话展开导出卡；监听浏览器 download 事件后点击执行。
- **预期**：`/api/novel/export` 返回的 Markdown 附件触发浏览器下载，卡片只在下载已开始后进入 succeeded，并显示文件名。
- **实际**：卡片显示“执行成功”并持久为 succeeded，但浏览器没有 download 事件，也没有可验证文件。
- **浏览器证据**：执行按钮点击一次，`download=null`，卡片成功态；应用 console 无 warn/error。
- **服务 / SQLite / 磁盘证据**：服务端路由返回 `text/markdown` 和 `Content-Disposition: attachment`；该流程不创建 job/receipt，隔离故事目录也没有导出文件。
- **影响**：用户认为全书已经导出，实际没有获得任何文件；所有经 Brain 执行器返回附件的动作均可能假成功。
- **根因**：`fetchAction()` 只区分 SSE 与 JSON；附件响应被调用 `res.json()`，解析异常被吞为 `{}`，随后 `!data.error` 被判为成功，没有消费 Blob 或触发下载。
- **修复方案**：统一成功响应处理器识别 `Content-Disposition: attachment` 并解析 UTF-8 文件名；`/api/novel/export` 复用页面菜单已有的同源 GET 原生下载 URL，使浏览器下载管理器接管附件，避免先 fetch 再 Blob 的受限环境不可观测问题。
- **回归测试**：新增 `tests/brain-action-response.test.ts`，覆盖 RFC 5987 文件名、附件必须被消费后才成功以及导出原生 URL；与 `tests/brain-cards.test.ts` 合计 27 项通过，`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- **commit / push**：待提交；推送目标 `origin/codex/brain-reliability-ui`。
- **复验结果**：共三次导出动作且未超过上限。第一次复现旧实现假成功；第二次 Blob 实现显示开始下载但浏览器无下载事件、磁盘无文件；最终原生 URL 实现只点击一次即捕获真实 download 事件。页面保持在故事 SPA，卡片显示“已请求下载：雨夜档案.md”并进入已完成；应用 console 无 warn/error。`C:\Users\Administrator\Downloads\雨夜档案.md` 实际落盘 222 字节，UTF-8 可解码，首行为 `# 《雨夜档案》`，SHA-256 为 `16C98B8F03C2E52B441BCB5E4B611A3A1C6B97A87D58BD12D06DD1BECA5656B4`。
- **状态**：已修复并通过真实浏览器复验，待提交推送。

### BROWSER-BUG-004 [P2] 伏笔账二次删除确认态被父级点击立即清除

- **首次发现**：2026-08-14 00:33（Asia/Shanghai）
- **场景**：`FORESHADOW-CRUD-01`，通过 Brain 表单新增伏笔后，在伏笔账将状态依次改为“推进中”“已回收”，再点击“删除”。
- **复现**：关闭 Brain，点击底栏“伏笔账（增删改）”；对已回收伏笔点击一次“删除”。
- **预期**：按钮切换为“确认删除？”，第二次点击才调用删除接口；点击遮罩、关闭或切换筛选时取消确认。
- **实际**：第一次点击后按钮仍显示“删除”，确认态不可见且第二次点击仍不会调用删除接口，导致 UI 删除路径不可达。
- **浏览器证据**：真实伏笔 `fs_msrqksmr_kbss` 已经由 UI 改为 `resolved`，弹窗显示“已回收 1”；点击“删除”后 DOM 仍为同一“删除”按钮，无“确认删除？”且记录仍存在。应用 console 无 warn/error。
- **服务 / SQLite / 磁盘证据**：`state.json` 中该伏笔仍存在且 `status=resolved`；没有 delete changeLog，证明请求未发出。
- **影响**：用户无法从可见 UI 删除符合服务端约束的已回收伏笔；新增、修改不受影响，有安全绕过但 CRUD 不完整。
- **根因**：删除按钮把 `confirmDelId` 设为伏笔 ID 后，点击事件继续冒泡到 `.fs-modal`；其 `onClick` 无条件执行 `setConfirmDelId(null)`，在同一交互中立即清除确认态。
- **修复方案**：弹窗内容区只阻止冒泡，不再清除确认态；遮罩、关闭和筛选仍负责取消确认。
- **回归测试**：新增 `tests/foreshadow-modal.test.tsx`，覆盖第一次点击只显示确认、第二次点击才发 `delete` 请求；`bun test tests/foreshadow-modal.test.tsx`、`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- **commit / push**：待提交；推送目标 `origin/codex/brain-reliability-ui`。
- **复验结果**：隔离生产实例加载修复构建后，真实点击第一次出现“确认删除？”，第二次删除成功；`state.json.foreshadowing=[]`，changeLog 完整记录新增、推进中、已回收、删除，Tab B 不刷新同步到活跃伏笔 0，两个应用页面无 warn/error。
- **状态**：已修复并复验。

### BROWSER-BUG-003 [P1] 只读查询正文与同回合权威卡片事实分叉

- **首次发现**：2026-08-14 00:12（Asia/Shanghai）
- **场景**：`BRAIN-QUERY-041/042/046/071/072/073/074`，真实中枢查询封面、媒体、世界书、角色、卷与弧线规划。
- **复现**：在隔离故事已生成封面、4 个角色视觉并已确认 2 卷/4 弧/5 条章纲后，通过 Brain 逐条询问“封面是否已经生成”“世界书目前有哪些条目”“林砚是什么角色”“第一卷叫什么名字”“第二卷的目标是什么”“首弧预计几章”“下一弧叫什么”。
- **预期**：正文和同回合 BrowseCard 均从当前 world projection 读取事实，刷新、多 Tab 或 provider 表述变化都不得产生矛盾。
- **实际**：正文分别声称“封面尚未生成”“世界书暂无条目”“林砚是核心主角”“尚未规划卷/弧”；同回合权威卡片却显示 4 个角色视觉、完整设定规则、林砚定位为配角、2 卷与 4 弧及首弧约 5 章。
- **浏览器证据**：`tabB` 的持久 Brain 历史中矛盾正文与权威卡片同时可见；刷新和关闭重开后仍可见该已持久化分叉。应用 console 无 warn/error。
- **服务 / SQLite / 磁盘证据**：隔离 `state.json` 含 `cover`、4 个角色视觉、2 个 volume、4 个 storyArc、5 个 chapterPlan；SQLite 当前无活动 job，排除任务尚未完成导致的短暂差异。
- **影响**：中枢以正文向用户陈述错误事实，即使卡片正确也无法判断哪一份可信；会误导后续写入、重复生成媒体，并破坏“projection 是展示唯一权威”的契约。
- **根因**：L0 查询先从实时 world 构造权威卡片，但 `l0QueryReply()` 除章节和少量角色模板外仍优先保留 provider 的自由文本；provider 使用的摘要或推断可能遗漏字段，因此同一回合出现两套事实。`read_media` 卡片数据同时漏掉封面状态，使封面问法没有可用于纠偏的结构化事实；指定卷问法还可能在 `read_outline` / `read_plans` 间波动，旧逻辑没有按卡片内容统一回答。
- **修复方案**：所有结构化 L0 查询正文改由已构造的权威卡片确定性生成；角色问法继续按状态/形象/关系侧重，媒体卡补充封面状态，指定卷/弧问法从 `read_outline` 或 `read_plans` 的同构数据统一提取。provider 只负责意图识别，不再覆盖查询事实；权威文本已有终止符时不重复追加标点。
- **回归测试**：`bun test tests/brain-chat.test.ts tests/brain-e2e.test.ts`（114 pass）、`bun run typecheck`、`bun run build`、`git diff --check` 通过。新增冲突 provider 回复、封面状态、角色定位、指定卷目标、首弧章数和下一弧名称断言。
- **commit / push**：待提交；推送目标 `origin/codex/brain-reliability-ui`。
- **复验结果**：隔离生产实例加载修复构建后真实复问“封面是否已经生成”“林砚是什么角色”“第二卷目标是什么”，分别得到“封面已生成 / 4 位角色有视觉资源”“林砚：配角”“第 2 卷『真相终验』及其真实目标”；Tab B 刷新并重开 Brain 后恢复同一会话，应用 console 无 warn/error。旧错误回合作为审计证据保留，新回合不再分叉。
- **状态**：已修复并复验。

### BROWSER-BUG-002 [P2] 明确的生成参数状态查询被误判为意见征询

- **首次发现**：2026-08-13 23:47（Asia/Shanghai）
- **场景**：`BRAIN-QUERY-038/039`，真实中枢连续问“当前是否开启自动抽卡”“当前是否需要人工确认入册”。
- **复现**：在故事设置中确认两个开关均为关闭；通过 Brain 输入上述问法并等待真实 provider 终态。
- **预期**：中枢读取权威 world 配置并明确回答“自动抽卡：关”“人工确认入册：关”，只读且不创建写命令。
- **实际**：前者返回“不建议现在开启”的方案卡，后者返回“建议先不急着做”的意见卡；均未回答当前事实。
- **证据**：真实会话用户消息和错误回复均持久化于隔离 `brain-sessions.json`；同期设置表单显示 `每章自动抽卡=关`，`gen.commitPolicy=auto`。
- **影响**：用户无法可靠查询当前生成参数，可能把建议误当作已生效配置，并在多 Tab/刷新后错误判断系统行为。
- **根因**：意图体系只有写入型 `settings`，没有只读参数查询；这类问法完全依赖模型分类，容易落入 `opinion/plan`。
- **修复**：新增只读 `read_settings` 意图；在调用意图 provider 前确定性识别明确的当前参数查询，直接从 `genOf(world)` 生成事实卡。修改/开启/关闭类表达仍进入原写入表单流程。
- **回归测试**：`bun test tests/brain-chat.test.ts tests/brain-e2e.test.ts`（113 pass），`bun run typecheck`、`git diff --check` 通过。真实浏览器复问两种表达，持久卡片 detail 为“自动抽卡：关；人工确认入册：关”，未创建写命令；重复事实卡按既有去重策略不重复铺开。
- **commit / push**：本缺陷提交完成后回填 SHA；推送目标 `origin/codex/brain-reliability-ui`。
- **状态**：已修复并复验。

### BROWSER-BUG-001 [P1] 服务重启后 job 顶层终态与 progress 状态分叉

- **首次发现**：2026-08-13 23:31（Asia/Shanghai）
- **场景**：`RESTART-ADVANCE-01`，真实单章推进进入 `reviewing/delta` 后精确终止服务 PID 11336 并重启。
- **复现**：真实 UI 点击“推进剧情 → 本章续写”，运行中刷新；SQLite 确认 `advance/running` 与 `CMD-N02/running` 后重启服务，再刷新直接故事 URL。
- **预期**：不可续跑的单章任务统一收敛为 interrupted/failed，顶层 job、`progress_json`、receipt 和 UI 对终态的描述一致。
- **实际**：UI 已解除只读，`jobs.status/phase=interrupted`，CMD-N02 receipt=`failed`；但同一行 `progress_json.status=running`、`phase=delta`，持久状态相互矛盾。
- **证据**：job `6b703f0d-ccd8-4642-a77e-f440f76dcb61`；command `2b200845-d15c-437f-8730-82cfd2ab2d12`；重启前 PID 11336，重启后 PID 9528。两个浏览器 Tab 的应用 console 均无 warn/error。
- **影响**：任何直接消费 job progress 的 UI、Brain 卡片或运维查询都可能在任务已中断后继续显示 running，形成幽灵 loading 或错误恢复判断。
- **根因**：`settleOrphanedJobs()` 只更新 job 顶层 status/phase/error，不同步 progress；随后 `cleanupStaleAdvanceTasks()` 只处理活动任务，无法修正已经 interrupted 的行。
- **修复**：`settleOrphanedJobs()` 在收敛不可恢复任务时保留原 progress 业务字段，同时把 `status/phase/error` 原子更新为 interrupted 语义；command receipt 继续由关联 job 的终态收敛。
- **回归测试**：`bun test tests/control-plane.test.ts tests/advancetask.test.ts`（28 pass），`bun run typecheck`、`git diff --check` 通过。真实浏览器第二次启动单章推进后重启服务，job `d429eb21-0b33-42d8-a4ab-ee7df62ff042` 的顶层与 `progress_json` 均为 interrupted，UI 解除只读。
- **commit / push**：本缺陷提交完成后回填 SHA；推送目标 `origin/codex/brain-reliability-ui`。
- **状态**：已修复并复验。


> 审计基线：分支 `codex/brain-reliability-ui`，提交 `8cbbf33`，审计日期 2026-08-13。
>
> 修复状态：2026-08-13 已按本报告实施修复；原始问题描述保留作为审计证据，当前状态见下节。

## 0. 修复后复验

本轮已修复 BUG-001 至 BUG-008 及 RISK-001、RISK-002 的当前实现缺口，未改变数据库 schema。主要落点如下：

- 命令回执保留完整终态、结果与错误，新增 `GET /api/commands/:commandId` 用户隔离查询；同步 JSON 业务端点可按原 HTTP 状态和 body 幂等重放。
- 命令状态转换改为单调终态，启动时收敛没有活动 job 承接的孤立 `queued/running` 命令，健康检查暴露收敛数量。
- 分镜只有成功创建持久 job 后才可启动模型调用；重复请求返回已有 `planId`，不会产生第二个内存任务。
- 图片生成增加关联顶层 `commandId` 的批次聚合 job；视频命令关联最终 provider watcher job，由真实 `ready/failed` 收敛命令，而非在 provider 接受时提前成功。
- 故事 tombstone 改为生命周期 generation：删除与同名重建均推进 generation，分镜、图片、视频、封面和角色视觉的晚到结果必须匹配原 generation 才可写回。
- `worldVersion` key 增加用户维度；WebSocket 订阅读取对应用户版本。
- `updateJob` 未显式传租约字段时保留原值，只有显式 `null` 才清理租约。
- 测试模型替身改为显式调用 override，不再用不可恢复的 `mock.module` 替换整个 Agnes 模块；WebSocket 用例清理订阅阶段异步帧，测试夹具不再触发真实图片 provider。

修复后验证：

```text
bun run typecheck  -> 通过
bun run build      -> 通过
bun test           -> 672 pass / 0 fail / 672 total
git diff --check   -> 通过
```

仍保留的边界：流式响应正文没有持久化重放，重放时通过 command receipt/任务结果收敛；多进程 claim/lease、精确 kill 点和真实 provider 晚到行为仍需第 9 节所列故障注入。`scope_tombstones` 复用现有字段保存 generation，后续若引入正式 `storyId`，应迁移为显式故事实例外键。

## 1. 执行摘要

本轮重点审计了最近重构最集中的统一命令入口、持久任务、世界存档提交、WebSocket 投影、中枢会话、媒体生成和启动恢复链路。以下统计是提交 `8cbbf33` 的原始审计结果；上述已确认实现缺陷已在本次修复中关闭。

| 级别 | 已确认 | 高风险 | 含义 |
| --- | ---: | ---: | --- |
| P0 | 0 | 0 | 暂未发现可直接证明的数据灾难或越权漏洞 |
| P1 | 6 | 0 | 核心流程失效、重复副作用或永久悬挂 |
| P2 | 1 | 2 | 有明确规避方式的功能错误或潜伏一致性风险 |
| P3 | 1 | 1 | 测试、文档和可维护性问题 |

最优先处理的不是 UI，而是控制面协议：客户端已默认给公开写请求附加命令契约，但服务端的幂等重放、异步终态关联和任务判重尚未形成闭环。当前“请求已被接受”不等于调用方能可靠获知结果，也不保证相同业务只执行一次。

## 2. 验证基线

执行结果：

```text
bun run typecheck  -> 通过
bun run build      -> 通过
bun test           -> 654 pass / 9 fail / 663 total
```

修复前全量测试失败项：

```text
3 个 Agnes SSE reasoning/content 解析断言失败
5 个 Agnes 可重试错误分类/重试接线断言失败
1 个 WebSocket 同名书用户隔离断言失败
```

对照执行：

```text
bun test tests/agnes-reasoning.test.ts tests/agnes-retry.test.ts
-> 13 pass / 0 fail

bun test tests/sync-ws.test.ts
-> 14 pass / 0 fail
```

因此不能把上述 9 项解释为各被测函数本身的稳定回归；它们证明了全量测试存在跨文件共享状态污染。具体污染来源见 BUG-008。修复测试注入与 WebSocket 夹具后，全量测试为 `672 pass / 0 fail`。

## 3. 已确认缺陷（均已修复，保留原始证据）

### BUG-001 [P1] 失败或取消的命令被伪装成 `queued`，幂等重试永远不会再次执行

**位置**

- `src/api/control-plane.ts:53-58`
- `src/api/control-plane.ts:71-76`
- `src/api/routes.ts:1166-1168`

**问题**

`acceptCommandOnce` 读取已有回执时只保留 `succeeded` 和 `running`，其余状态全部映射为 `queued`：

```ts
const status = existing.status === "succeeded"
  ? "succeeded"
  : existing.status === "running"
    ? "running"
    : "queued";
```

这会把数据库中的 `failed` 和 `cancelled` 错报成 `queued`。同时函数返回 `created: false`，路由在 `!accepted.created` 时直接返回，绝不会重新启动任务。

**触发条件**

1. 某命令第一次执行进入 `failed` 或 `cancelled`。
2. 客户端因重试、断线恢复或重复点击，使用相同 `commandId` 和相同 payload 再次请求。

**错误结果**

服务端返回 `202 { accepted: true, status: "queued" }`，但没有执行者，也没有后续状态变化。调用方会永久等待一个不存在的任务。

**影响**

- 失败命令无法按同一幂等键恢复，也无法获得真实失败原因。
- “durable command” 的状态事实被响应层篡改，监控和 UI 都会误判。
- 对 `POST /api/commands` 和带 `x-command-contract: v1` 的公开写入口均有影响。

**复现**

1. 提交一个必然失败的命令，例如目标故事不存在的 `CMD-W12`。
2. 等待 `command_receipts.status` 变为 `failed`。
3. 原样重发相同 `commandId`。
4. 响应为 `queued`；再次查询数据库仍为 `failed`，且没有新任务启动。

**修复建议**

回执类型和响应必须覆盖完整终态，原样返回 `failed/cancelled`、`result/error`。如果产品允许重试失败命令，应显式定义“新 commandId 重试”或原子 CAS `failed -> queued` 的协议，不能在展示层把终态改名为 `queued`。

---

### BUG-002 [P1] 幂等重放返回通用 202 回执，破坏原业务端点响应契约

**位置**

- `src/api/client.ts:60-76`
- `src/api/routes.ts:1166-1168`
- 典型调用方：`src/pages/Home.tsx:869-886`、`src/pages/Home.tsx:971-985`

**问题**

`apiFetch` 已自动为几乎所有公开 POST 写操作生成 `x-command-id`。第一次请求正常时，服务端继续执行原业务路由并返回原格式，例如 `{ ok, world }`、`{ ok, planId }`。相同命令重放时，服务端却直接返回：

```json
{ "accepted": true, "commandId": "...", "status": "succeeded" }
```

HTTP 状态还被固定为 202。原端点的状态码、响应 body、SSE 流和错误信息均无法重放。

**触发条件**

最典型场景是服务端第一次已完成写入，但响应在网络中丢失；客户端使用同一 `commandId` 重试。

**错误结果**

调用方仍按原业务响应解析。例如编辑世界会检查 `data.ok` 和 `data.world`，于是把服务端已经成功完成的命令显示为“保存失败”。对流式端点，重放甚至不再返回 SSE。

**影响**

- 用户看到失败并再次发起新命令，可能产生二次副作用。
- 客户端无法区分“已成功但响应丢失”和“尚在排队”。
- 幂等机制反而降低了网络故障时的正确性。

**复现**

1. 带固定 `x-command-id` 调用任一同步写接口并让其成功。
2. 原样重发请求。
3. 比较两次响应：第一次是业务响应，第二次是通用 202 receipt。

**修复建议**

持久化并重放原始 HTTP 结果，至少保存业务状态码、content-type 和 JSON result；SSE/异步命令则返回稳定的任务资源协议，并让客户端按 command receipt 明确分支，不能让同一路径在首发和重放时返回不兼容结构。

---

### BUG-003 [P1] `/media/generate` 顶层命令未关联实际任务，回执可永久停留在 `running`

**位置**

- `src/api/routes.ts:1174-1182`
- `src/api/routes.ts:2977-3032`（视频任务）
- `src/api/routes.ts:3102-3105`、`src/api/routes.ts:3174-3177`（图片任务）
- `src/api/control-plane.ts:220-222`（仅关联了 `commandId` 的 job 才回写回执）

**问题**

命令包装层把 `/api/novel/media/generate` 标为 `asyncJob`，所以成功提交后不会直接把 receipt 置为 `succeeded`。按设计应由后台 job 到终态时经 `updateJob` 回写顶层命令。

但视频 `video-create` job 和每张图片的 `image` job 创建时都没有传入 `body.commandId`。因此它们完成或失败时，`updateJob` 找不到关联命令，顶层 `command_receipts` 会一直保持 `running`。

**触发条件**

通过正常前端 `apiFetch` 调用 `/api/novel/media/generate`。客户端会自动附加命令契约，服务端会把 `commandId` 写入转发 body，但媒体 job 没有接住它。

**错误结果**

媒体本身可能已经 ready/failed，世界状态也已保存，但统一命令回执永久 `running`。

**影响**

- 控制面无法可靠判断媒体生成是否结束。
- 相同命令重放只会得到 `running`，无法获得媒体 ID 或错误。
- 回执表持续积累伪运行任务，恢复和运维判断失真。

**修复建议**

为一次 `/media/generate` 建立一个顶层聚合 job 并关联 commandId；图片子任务作为 children，全部结束后汇总成功/部分失败/失败结果并一次性收敛回执。视频的“provider 任务已创建”和“最终媒体 ready”也应明确哪个阶段代表命令成功。

---

### BUG-004 [P1] 分镜持久判重结果被忽略，重复请求仍会启动第二个 LLM 任务

**位置**

- `src/api/control-plane.ts:123-144`
- `src/api/routes.ts:2839-2854`

**问题**

`createJob` 通过 `(user_name, dedupe_key)` 唯一索引返回 `{ created: false, job: existing }`，这是跨请求/跨进程的最终判重结果。分镜路由调用 `createJob(...)` 后丢弃返回值，随后无条件：

- 创建新的本地 `AbortController` 和 `PlanTask`；
- 设置新的 180 秒 timer；
- 写入 `planTasks`；
- 启动新的 `planScenes` LLM 调用；
- 向客户端返回新的 `planId`。

当数据库已有相同章节/媒体类型的活动分镜时，新的 `id` 根本没有插入数据库，却仍在内存和模型侧执行。

**触发条件**

同一用户、同一本书、同一章节、同一 `kind` 在首个分镜未结束时并发提交两次。跨 Tab 或网络重试均可触发。

**错误结果**

两个 LLM 分镜同时运行，第二个返回的 `planId` 没有对应持久 job；后续 `updateJob(id, ...)` 静默无效，取消、恢复和状态查询无法形成闭环。

**影响**

- 重复消耗模型配额。
- 同一会话卡可能被两个晚到结果相互覆盖。
- 内存状态、SQLite job 和客户端 planId 三者分叉。

**修复建议**

必须检查 `created`。`false` 时返回 409，或返回已有 job 的稳定 ID 并附真实状态；只有数据库成功创建者可以注册 timer、内存 task 和启动 LLM。新增跨请求并发测试，断言模型调用次数严格为 1。

---

### BUG-005 [P1] 删除故事的永久 tombstone 会污染后续同名新故事

**位置**

- `src/api/control-plane.ts:186-198`
- `src/api/routes.ts:1740-1759`
- `src/api/routes.ts:3095-3109`
- 新故事首次保存：`src/api/director.ts:177-178`

**问题**

删除成功后以 `(user, title)` 永久保存 `scope_tombstones`，注释明确要求重启后仍保留。代码只在“删除失败且故事仍存在”时清理 tombstone，创建/保存同名新故事时没有调用 `clearScopeDeleted`。

媒体后台任务用 `isScopeDeleted(currentUser(), title)` 判断是否应放弃生成。由于 tombstone 不包含故事实例 ID 或删除代次，同名新故事会继承旧故事的删除标记。

**触发条件**

1. 删除故事 `A`。
2. 之后创建一个标题仍为 `A` 的新故事，或通过迁移/恢复让同名目录重新出现。
3. 为新故事生成图片。

**错误结果**

图片任务在实际调用 provider 前命中 `deleted()` 并直接返回，随后 job 被记为失败或产生空错误；新故事会长期无法正常执行依赖 tombstone 守卫的后台媒体流程。

**影响**

- 删除行为跨越故事生命周期污染未来资源。
- 用户无法通过重启恢复，因为 tombstone 本来就是持久化的。
- 仅靠 title 作为 scope identity，无法区分旧故事的晚到任务和新故事的合法任务。

**修复建议**

给故事增加不可复用的 `storyId/generation`，tombstone 和 job 都绑定实例 ID。最低限度应在新故事首次持久化前原子清理同名墓碑，但这仍不能阻止旧 provider 结果误写新故事，因此实例 ID 才是完整修复。

---

### BUG-006 [P1] 非原子“回执判重 -> 业务执行”会让已接受命令永久丢失执行

**位置**

- `src/api/control-plane.ts:53-76`
- `src/api/routes.ts:1166-1172`

**问题**

两个并发请求使用同一 commandId 时，SQLite 主键能保证只插入一个 receipt，第二个请求会得到 `created: false`。单进程路径通常正确，但 receipt 创建和业务执行之间没有持久 dispatcher/lease。若创建 receipt 的进程在启动业务前崩溃，receipt 永久停在 `queued`；其他进程重放时看到 `created: false`，也不会接管执行。

同样，`POST /api/commands` 使用 fire-and-forget 进程内 Promise，服务重启后没有扫描 queued/running command receipt 并恢复或收敛的逻辑。

**触发条件**

进程在 `acceptCommandOnce` 成功后、业务 handler 或 durable job 建立前退出；部署重启和进程崩溃都可形成这个窗口。

**错误结果**

命令被持久标记为已接受，却没有任何 job 和执行者；后续同 commandId 请求不能接管，形成永久悬挂。

**影响**

这是 durable commands 核心承诺的断点。高风险窗口虽短，但发生后无法通过正常重试自愈。

**修复建议**

在同一 SQLite 事务内创建 receipt 和可 claim 的 job/outbox，由独立 dispatcher 通过租约执行。启动恢复必须扫描 `queued/running` receipt 与 job 的关联完整性：有安全恢复点则重新 claim，无恢复点则明确标记 `interrupted/failed`，不能保留假运行状态。

---

### BUG-007 [P2] `worldVersion` 缺少用户维度，同名书共享进程内版本号

**位置**

- `src/api/sync.ts:227-245`
- `src/api/sync-server.ts:275-278`

**问题**

事件节流 key 已包含 user，但 `worldVersions` 只使用 `slugify(title)`：

```ts
const key = slugify(title);
worldVersions.set(key, version);
```

WebSocket 订阅确认中的 `version: worldVersion(title)` 同样不传用户。两个用户拥有同名书时，共享同一个进程内版本计数。

**触发条件**

用户 A 和 B 各自拥有同名书，并在同一服务进程内交替保存或订阅。

**错误结果**

B 的 `subscribed.version` 可能来自 A；未传 committed revision 的遗留调用还会让 A/B 相互推进计数。实际投影 revision 已经按 user 存在 SQLite，因此这里形成两套不一致的版本事实。

**影响**

当前新客户端主要依赖持久 projection revision/hash，所以通常不会造成正文越权；但旧 `world-changed.version` 去重、测试断言和降级路径会出现跳号、误丢事件或错误恢复判断。

**修复建议**

移除这套进程内版本事实，统一使用 `sync_scopes.revision`；若暂时保留，key 必须为 `durableUser(user) + scope/title + document`，所有读写函数都必须显式接收 user。

---

### BUG-008 [P3] 全量测试存在模块 mock 和全局状态污染，测试结果随执行顺序变化

**位置**

- `tests/mocks.ts:10-27`
- `tests/agnes-reasoning.test.ts:4`
- `tests/agnes-retry.test.ts:6`
- `tests/sync-ws.test.ts:153-169`
- 其他共享项：多份测试对 `process.chdir`、`process.env.APP_DB_PATH`、`globalThis.fetch`、数据库单例和同步总线做进程级修改。

**问题与证据**

`installMockAgnes` 使用 `mock.module("../src/api/agnes", ...)`，其中把：

```ts
isRetryableError: () => false
withSmartRetry: fn => fn()
readStream: async () => ""
```

注册为全局模块 mock，未在测试结束恢复。全量执行时，真正导入 `agnes.ts` 的 reasoning/retry 测试拿到了这个 mock，精确导致 3 个空正文断言和 5 个重试断言失败。它们单独运行时 13/13 通过，说明生产实现并未在这些断言上稳定失败。

WebSocket 隔离用例也表现为全量失败、单文件 14/14 通过。仓库同时存在模块级 `listeners/pendingByKey/worldVersions/allSockets`、真实 Bun server、共享 cwd 和多个全局 mock，测试文件并行运行时缺乏统一隔离。该失败目前只能归类为测试污染信号，不能据此声称生产环境已发生跨用户消息泄漏。

**影响**

- CI 全量测试红灯，无法作为合并门禁。
- 真回归可能被 mock 覆盖，假回归则浪费排查时间。
- 测试运行还触发了真实封面生成日志，说明部分测试可能读取本机 `.env` 并访问外部 provider，存在额度消耗和不可重复性。

**修复建议**

1. 将 Agnes 依赖改为显式注入，避免不可恢复的 `mock.module`。
2. 需要模块 mock 的测试拆到独立 Bun 进程。
3. 禁止并行测试直接修改进程 cwd/env/global fetch；使用每文件独立进程或统一 sandbox helper。
4. 为数据库、sync bus、brain cache、WebSocket server 提供严格 `beforeEach/afterEach` reset。
5. 测试环境强制清空 provider key，并让任何真实网络请求立即失败。

## 4. 高风险问题（RISK-001/002 已修复，RISK-003 仍需持续治理）

### RISK-001 [P2] `updateJob` 的普通进度更新会无条件清空租约字段

**位置**：`src/api/control-plane.ts:201-218`

当调用方没有传 `leaseOwner/leaseExpiresAt` 时，SQL 参数仍写入 `NULL`，而不是保留 `prev` 值。当前仓库尚未实现实际 claim/renew 流程，所以本轮不能证明已有重复消费者；但一旦启用 schema 中已经预留的租约，任意 phase/progress 更新都会释放租约，另一进程可以错误接管同一任务。

建议改成动态 UPDATE、`COALESCE` 加显式清空标记，或把 lease 更新拆成独立 CAS API，并增加“持有租约时更新进度不丢 lease”的测试。

### RISK-002 [P2] 图片子任务没有继承父级 commandId，聚合失败语义缺失

BUG-003 已确认顶层 receipt 会悬挂；进一步的风险是当前每张图片独立成功/失败，但没有持久父子关系和明确的“部分成功”结果。进程在若干图片完成后重启时，控制面无法仅凭 command receipt 重建聚合结果。修复时不应简单把同一个 commandId 填进所有子 job，否则任一子任务先结束就会过早终结整条命令。

### RISK-003 [P3] 后台异步链大量依赖 AsyncLocalStorage 隐式用户上下文

图片生成、视频 watcher、自动连载和中枢任务在 fire-and-forget Promise 中多次调用 `currentUser()`。Bun 当前通常能沿 Promise 链保留 AsyncLocalStorage，但任务跨 timer、启动恢复或未来队列进程后很容易丢失上下文并落入 `__legacy__`/空用户。建议持久任务从 job 明确读取 user/title/storyId，并把它们作为函数参数传递，不能让授权边界依赖环境上下文。

## 5. 架构与维护风险

### 5.1 控制面存在重复事实来源

目前同时存在：

- `command_receipts.status`；
- `jobs.status/progress/recovery`；
- `world_commits` 与 `sync_scopes.revision`；
- 进程内 `worldVersions`；
- 进程内 `activeAuto/planTasks/imageGenTasks/videoWatchers`；
- 世界文件中的媒体状态和中枢会话卡状态。

这些事实没有统一状态转换表。例如媒体可以已经 ready，但 command receipt 仍 running；分镜可以在内存执行，但 SQLite 不存在对应 ID。建议明确单一权威：命令负责请求与结果，job 负责执行，projection 负责展示；每个状态转换必须在事务或可恢复 outbox 中连接。

### 5.2 核心模块体积过大，审计边界不清

当前主要文件行数：

```text
src/api/routes.ts                 3736
src/pages/Home.tsx                3004
src/components/BrainCabin.tsx     1809
src/api/control-plane.ts           424
```

该问题已进入迁移态：命令协议已由 `src/contracts/commands.ts` 和 `src/transport/http/command-bus.ts` 统一处理，认证路由已迁至 `src/transport/http/auth-routes.ts`，sync transport 通过 projection port 访问旧快照构建器。`routes.ts` 仍承载故事业务、媒体调度和兼容 URL，后续按功能继续拆分；新增端点不得再扩大其职责。

### 5.3 文档已经明显漂移

README、BRAIN、HARNESS 和 INSTRUCTION 已完成一次状态校准；已删除状态端点继续固定返回 404，后续新增协议必须同时更新对应文档和兼容性测试。

## 6. 安全与持久化审查结论

本轮没有发现可直接证明的跨用户文件读取或路径逃逸。以下实现方向是正确的：

- API 入口统一通过 `userFromRequest` 和 `runAsUser` 注入账号目录上下文。
- WebSocket 频道 key 包含 user 和 story slug。
- 媒体读取最终经过故事目录约束，账号目录由当前用户决定。
- `saveWorld` 已采用 prepared journal、同目录原子 rename 和启动恢复，类型检查与相关单测通过。
- 客户端投影使用 revision/hash，并在 server instance 变化时清理旧缓存。

但这些局部正确性不能抵消 BUG-001 至 BUG-006 的命令/任务状态断裂。当前最大的风险不是直接越权，而是系统告诉用户“已接受、运行中或失败”，实际执行事实却与之不同。

## 7. 建议修复顺序

1. **重建命令回执契约**：完整终态、原响应重放、查询接口、queued/running 启动恢复。
2. **建立命令与聚合 job 的一对一关系**：尤其 `/media/generate`，子任务不得直接终结父命令。
3. **修复分镜判重**：数据库 `created` 是唯一启动许可，补并发和跨进程测试。
4. **引入 story instance ID**：job、tombstone、sync scope 和媒体晚到结果都绑定实例，解决删除后同名重建污染。
5. **统一同步 revision**：移除无用户维度的 `worldVersions`，只使用持久 projection revision。
6. **隔离测试运行时**：先让全量 `bun test` 稳定全绿，再继续可靠性重构。
7. **拆分超大模块并同步文档**：使用声明式命令注册表，减少遗漏终态和 revision policy 的概率。

## 8. 建议新增的验收用例

1. 同 commandId 首次成功、响应丢失后重放，必须得到等价业务结果且副作用只发生一次。
2. 同 commandId 首次失败后重放，必须返回真实 failed/error；若允许重试，要通过显式协议重新 claim。
3. 在 receipt 插入后、业务 job 创建前模拟进程退出，重启后命令必须收敛而非永久 queued/running。
4. 两个请求并发提交同章节分镜，模型调用次数和持久 job 数均为 1。
5. 图片全部成功、部分失败、全部失败和进程中断时，父命令分别得到明确定义的终态。
6. 删除故事、同名重建、旧媒体结果晚到时，旧结果不得写入新故事，新故事媒体生成正常。
7. 两用户同名书交替保存和重连，projection revision、旧 worldVersion 降级帧和频道消息均严格隔离。
8. 全量测试连续运行至少 10 次结果一致，且测试期间禁止任何真实外部模型请求。

## 9. 未覆盖范围

以下场景需要专门故障注入或真实部署环境，本轮未声称已完成验证：

- 多 Bun 进程同时消费同一 SQLite job 的实际行为；
- 在 `state.json` rename、SQLite commit、outbox 广播各精确断点强制 kill 后的恢复；
- 真实 Agnes/兼容模型的长时间超时、429、SSE 半包和 provider 任务晚到；
- 浏览器多 Tab 在系统休眠、网络切换和服务滚动升级期间的端到端恢复；
- 大型真实书库下外置版本、outbox 和会话文件的性能及磁盘增长。

这些项目应在上述 P1 修复后进行，否则故障注入得到的结果会被已知控制面缺陷干扰。
