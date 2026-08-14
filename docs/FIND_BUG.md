# fiction-platform 重构后缺陷审计报告

## 2026-08-14 真实浏览器深度验收（第二批）

### BROWSER-BUG-023 [P3] 中枢伏笔账卡泄漏英文内部状态

- **首次发现**：2026-08-14 18:24（Asia/Shanghai）。
- **场景 / testId / Tab**：`BRAIN-QUERY-101`，Tab B，《雾港电台》，真实中枢输入“把目前所有伏笔按状态列出来”。
- **预期**：伏笔状态应使用与伏笔管理面板、记忆台账一致的中文业务文案（已埋设、推进中、已回收），不得向用户暴露内部枚举。
- **实际 / 证据**：权威 BrowseCard 正确列出 4 条伏笔，但每条元信息均显示“状态：planted｜埋于第 1/2 章”。同页伏笔管理组件已经使用“已埋设”，说明不是数据缺失而是该卡片分支遗漏映射；应用 console warning/error 为 0。
- **影响范围**：中枢 `read_foreshadow` 的所有伏笔列表；`active/resolved` 也会原样暴露，破坏中文界面一致性但不改变数据。
- **根因**：`src/components/brain-cards.tsx` 的 foreshadow browse 分支直接 `String(f.status)`，未复用仓库已有的伏笔状态中文映射。
- **严重度 / 状态**：P3；待修复。

### BROWSER-BUG-022 [P2] 分镜在刷新窗口完成后丢失待确认入口

- **首次发现**：2026-08-14 17:45（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-MEDIA-PLAN-REFRESH-02`，Tab B，同账号故事《雾港电台》第 1 章，通过真实“更多 → 生成插画 → 1张”提交分镜后立即刷新页面。
- **前置与复现**：章节正文已存在且没有活动媒体任务；真实 UI 提交一次插画分镜，页面出现“AI 分镜中”后刷新；provider 在刷新窗口内完成；重新进入同一 URL 并等待完整 sync snapshot。
- **预期**：页面应从服务端持久 job 恢复待确认分镜，显示场景、可编辑提示词以及“确认生成/取消”；确认或取消后持久标记已消费，后续刷新不得重复弹出历史计划。
- **实际**：刷新后页面直接恢复空闲，没有“分镜完成”“确认生成”或其他恢复入口，并允许再次提交分镜。job `plan-mssrhdb5nn8yu` 已为 `succeeded/ready`，command `8ec8119b-4710-4bf4-aba0-52f3df5cb6d2` 也为 succeeded，`result_json` 含完整 1 个 scene；服务端完成事实与页面可操作状态分叉。
- **证据**：SQLite job rowid `78`，`recovery_json={"chapterIndex":1,"mediaKind":"image","count":1}`，完成时间 `2026-08-14T09:45:34.227Z`；刷新后 DOM 仅有空闲的“推进剧情”和可再次打开的章节“更多”菜单，无媒体确认模态框；应用页面未观察到 console warning/error。
- **影响范围**：从章节菜单直接发起且没有 Brain session 卡作为替代入口的 image/video 分镜；刷新、关闭 Tab、浏览器休眠或短暂断线刚好跨过任务终态时，用户会永久丢失已付出 provider 调用的结果并可能重复调用。
- **根因**：`Home.consumeHomeMediaPlanStatus()` 只接受当前 Tab 内存 `pendingMediaPlanRef` 中匹配的 planId；刷新必然丢失该 ref。`listMediaTaskStates()` 虽返回历史 ready job 和 scenes，却不含 `chapterIndex/mediaKind`，也没有未消费标记；客户端既无法重建计划，又不能安全恢复全部历史 ready job。
- **修复**：direct-Home 分镜 job 在 recovery 持久保存 `chapterIndex/mediaKind/awaitingConfirmation`；sync 的活动/未消费计划投影携带完整恢复上下文和 scenes。Home 从完整快照恢复 running 锁或 ready 确认窗；确认生成携带 planId，确认、取消、关闭、Esc 和遮罩退出统一持久标记 `awaitingConfirmation=false`。消费后立即发布完整 brain snapshot，使其他 Tab 关闭同一确认窗；旧版无显式标记和 Brain session 自有倒计时卡不会被误弹。
- **回归与门禁**：`tests/home-media-plan.test.ts` 覆盖刷新后 running/ready 恢复以及 consumed/legacy/session/malformed 隔离；`tests/media-plan-task.test.ts` 覆盖 sync 元数据、Brain session 不进入 Home 恢复、ready 取消消费、确认消费幂等及账号/故事边界。定向测试 17 pass / 0 fail；最终 `bun run check` 为 720 pass / 0 fail（4017 assertions），49 个公开命令架构检查、typecheck、client/SSR build 和 `git diff --check` 均通过。
- **真实浏览器复验**：修复构建中重新通过“更多 → 生成插画 → 1张”提交 job `plan-msss08295itz9`（command `824deb39-3e85-4012-ba62-fd633bf2b8a3`），看到“AI 分镜中”后立即刷新；页面从 sync 恢复运行锁，provider 完成后自动显示 1 个可编辑场景和“确认生成/取消”。点击确认并再次刷新，计划持久变为 `awaitingConfirmation=false, consumedBy=generate`，旧确认窗未重弹；image-batch `ad47cdf2-737c-4b3c-a1f7-b00117cc96f1` 和子 job `136a8694-d556-4c91-9c8f-b629ae75b49a` 从 running 恢复进度并最终 succeeded/ready，文件 `images/ill-msss1d83krn.jpg` 的 SHA-256 为 `232d1e71bee2fa4f38424f1ef04dc58fd3052903517bffd2893e2065fbd5896d`。第三次 control job `plan-msss44tahm677`（command `f0d6757b-f68b-4256-aacb-60fb4f599cfa`）显示确认窗后点击取消，持久记录 `consumedBy=cancel`，刷新同样不重弹。截图 `/tmp/moshift-realqa-Dl0cXq/evidence/BROWSER-BUG-022-verify-ready.jpg`（SHA-256 `3b684bc12fa4178275384ebb2466d9ffe5b4be59d88e2b6915de927e83cdfcb2`）和 `BROWSER-BUG-022-verify-final.jpg`（SHA-256 `d9f4294efa61f932161a3f95ba2222e7b2321192d0f61e900aa7321c228a95dc`）；应用 console warning/error 为 0，Browser Statsig telemetry 超时单独排除。
- **commit / push**：`8eb7e35`；已推送到 `origin/codex/brain-reliability-ui`。
- **严重度 / 状态**：P2；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-021 [P1] 已停止连载的晚到 session 被误建为匿名新 job

- **首次发现**：2026-08-14 17:24（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-AUTO-CANCEL-LATE-NEW-JOB-01`，真实 UI 启动目标 1 章后点击“停止连载”，原 job/receipt 已 cancelled，继续等待真实 provider 返回。
- **预期**：同一运行轮次的晚到 `touchSession` 必须被终态会话丢弃；只有新的用户启动命令才能创建下一轮 auto job，且新 job 必须关联该命令。
- **实际 / 证据**：原 job `57423728-03d0-4604-a437-99d53e4427d9`（command `a7a14645-bb50-4ddf-8328-28ec6e877346`）保持 cancelled；真实 provider 晚到后，`saveAutoSession` 在 1ms 后创建匿名 running job `fe934776-d669-4ae9-a396-ee06b610f53b`，`command_id` 为空、phase=`连载开始`。权威章节仍为 0，但刷新会重新出现运行锁。
- **影响范围**：所有停止/取消后的连载晚到阶段更新；会产生无命令来源的幽灵任务、重复恢复和 UI 永久锁定，且绕过原 job 的终态单调保护。
- **后续真实结果**：继续等待 provider 后，匿名 job 最终变成 `succeeded/连载结束（done）` 并写入第 1 章；原 cancelled command 没有任何 receipt 能关联这次成功副作用，证明问题不只是短暂 UI 状态，而是命令审计和执行归属断裂。
- **根因 / 修复**：`saveAutoSession` 为支持“上一轮终态后重新开始”会在看到 terminal latest job 时创建新 job，但 `runAuto` 没有绑定路由已创建的 durable job，也没有区分“新用户命令”与“同一轮次晚到阶段”。新增 `AutoOptions.jobId`，真实路由和服务重启恢复都把 durable jobId 传入；provider 开始前若该 job 已 succeeded/failed/interrupted/cancelled，直接返回相应报告且 provider 调用数为 0。`touchSession` 同时拒绝 stopped/done 会话的晚到合并，封住执行中停止后的第二条复活路径。
- **回归与门禁**：`tests/autorun-fix.test.ts` 新增两条完整流程回归：执行器已进入后 stop，释放晚到章节阶段仍只有一条 cancelled job；绑定 job 在 provider 开始前已 cancelled 时执行器调用数为 0、不得创建新轮次。`tests/resume.test.ts` 的断点续跑、pause 和 stop 语义保持通过。最终 `bun run check` 为 717 pass / 0 fail（3995 assertions），49 个公开命令架构检查、typecheck、client/SSR build、额外 `bun run build` 与 `git diff --check` 全部通过。
- **真实浏览器复验**：修复构建中，《纸月邮局》已有 1 章，真实 UI 以绝对目标 2 章启动连载并在第 2 章 provider 阶段立即点击“停止连载”。唯一新 job `fc40b06e-df4f-4c8c-a863-ad0f56d2d71a` 始终关联 command `d19bda4e-f7ad-44b9-abc3-6a02ec820f62` 并为 cancelled；精确停止服务再重启后，auto job 最大 rowid 仍为 77，没有匿名新行，权威章节仍为 1，页面空闲且 console warning/error 为 0。
- **commit / push**：`8008c93`；已推送到 `origin/codex/brain-reliability-ui`。
- **严重度 / 状态**：P1；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-020 [P1] 已取消 auto job 被晚到审查帧回滚为 paused

- **首次发现**：2026-08-14 13:31（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-AUTO-RESTART-CANCEL-LATE-01`，服务重启恢复 auto 后，在真实连载控制台点击“停止连载”，继续等待当时已在 provider 内的章节流程完全退出。
- **预期**：`cancelled` 是不可回滚终态；任何晚到 saveSession、审查或路由收尾只能被丢弃，job/receipt/UI 必须保持取消且解除锁定。
- **实际 / 证据**：job `cdf070bd-0e1f-4883-ad53-43c8b7fd7301` 与 receipt 先一致进入 cancelled；约 9 分钟后 provider 返回 review-failed，`saveAutoSession` 通过通用 `updateJob` 把 job 改为 `paused/第 1 章审查未通过，等待处理`，receipt 因自身终态保护仍为 cancelled。权威章节仍为 0，但 job/receipt 分叉且页面会重新视为任务活动。
- **影响范围**：所有 cancelled/failed/interrupted/succeeded job 的晚到异步回调；当前 `updateJob` 没有终态单调保护，可能复活任务、重锁 UI 或覆盖审计结论。
- **根因**：`updateCommand` 已有终态保护，`updateJob` 却允许任意新状态覆盖；`saveAutoSession` 还会把新一轮 running 会话写回上一轮终态 job，同毫秒 job 仅按 `updated_at` 排序时也可能读到旧轮次。启动恢复只扫描 queued/running/waiting_external，无法修复已经回滚为 paused 的历史分叉；会话读取又优先信任旧 `progress_json`，即使顶层 job 已收敛仍可能显示幽灵运行态。
- **修复**：job 的 succeeded/failed/interrupted/cancelled 终态只允许同终态补充结果，不接受另一终态或非终态晚到帧；新一轮 running 会话在上一轮终态后创建独立 job，并以 `updated_at/created_at/rowid` 稳定选择最新轮次。启动恢复扫描 paused 并以终态 command receipt 收敛顶层 job、progress 和 recovery；`loadAutoSession` 再以顶层 job 终态规范化旧进度，覆盖历史及部分迁移数据。
- **回归与门禁**：`tests/control-plane.test.ts` 覆盖四类 job 终态、同终态结果补写、跨终态拒绝和 paused 幽灵任务启动收敛；`tests/autorun-fix.test.ts` 覆盖新连载轮次隔离及旧 progress 规范化；`tests/resume.test.ts` 的 stop/pause/断点续跑控制场景保持通过。最终 `bun run check` 为 715 pass / 0 fail（3987 assertions），49 个公开命令架构检查、typecheck、client/SSR build、额外 `bun run build` 与 `git diff --check` 全部通过。
- **真实浏览器复验**：修复构建首次启动即把历史分叉 job `cdf070bd…` 从 `paused/审查未通过` 收敛为 cancelled，与 receipt 一致；刷新《纸月邮局》后底部恢复“推进剧情”，任务中心显示“已停止”，无幽灵 loading。随后真实 UI 启动 1 章连载并点击“停止连载”，新 job `57423728-03d0-4604-a437-99d53e4427d9`、command `a7a14645-bb50-4ddf-8328-28ec6e877346` 进入 cancelled；在该真实 job 上注入等价晚到 `paused/late-review` 更新后，SQLite 仍保持 `cancelled/stopping`、错误“用户请求停止”，刷新页面仍空闲且权威章节为 0。应用 console warning/error 为 0。
- **commit / push**：`5edd1b7`；已推送到 `origin/codex/brain-reliability-ui`。
- **严重度 / 状态**：P1；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-019 [P2] 刷新或后台恢复的自动连载没有暂停/取消控制

- **首次发现**：2026-08-14 13:16（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-AUTO-REFRESH-CONTROL-01`，重启隔离服务后从持久 paused session 恢复自动连载，并立即打开任务中心。
- **预期**：只要权威 auto session 为 running，任务中心就应提供暂停和取消任务；这些控制是服务端持久命令，不应依赖当前 Tab 是否持有原 SSE reader。
- **实际 / 证据**：任务中心已正确显示“连载中 · 0/1 章 · 第 1 章重试中”，SQLite job `cdf070bd-0e1f-4883-ad53-43c8b7fd7301` 为 running；但任务中心没有“暂停/取消任务”，只剩“处理暂存章节”。
- **影响范围**：刷新、关闭重开、服务重启恢复以及由非消费式恢复请求启动的自动连载；用户无法从任务中心停止后台任务。
- **根因 / 修复**：任务中心把权威 `session.status=running` 与当前 Tab 的本地 `autoRunning`（仅原 SSE reader 存活时为 true）共同作为控制按钮条件，刷新或恢复后因此隐藏控制。移除该本地 prop 依赖：running session 始终提供暂停/取消，步骤阶段直接使用权威 session phase；Home 不再向任务中心传递连接局部状态。
- **回归与门禁**：新增 `tests/task-center-modal.test.tsx`，直接渲染“只有恢复 session、没有本地 SSE reader”的任务中心并断言暂停/取消与真实阶段均可见。最终 `bun run check` 为 715 pass / 0 fail（3987 assertions），49 个公开命令架构检查、typecheck、client/SSR build、额外 `bun run build` 与 `git diff --check` 全部通过。
- **真实浏览器复验**：在《纸月邮局》通过真实“推进剧情 → 章节连载”启动目标 1 章，运行中刷新页面以丢弃原 Tab SSE reader；刷新后的底栏从权威 snapshot 恢复“连载·第 1 章重试中”，打开任务中心显示 `连载中 · 0/1 章`、真实阶段以及“暂停”“取消任务”两个可用按钮。随后真实点击“取消任务”，页面立即解除只读锁并回到“推进剧情”；应用 console warning/error 为 0。
- **commit / push**：`4faff2b`；已推送到 `origin/codex/brain-reliability-ui`。
- **严重度 / 状态**：P2；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-018 [P2] 自动连载审查暂停被顶层 job 覆盖成 done

- **首次发现**：2026-08-14 13:15（Asia/Shanghai）。
- **场景 / testId**：`ASYNC-AUTO-01`，目标 1 章的真实自动连载经过 provider 重试后审查未通过，草稿进入暂存区。
- **预期**：顶层 job 的 phase/result 应明确表达策略暂停，不得显示目标完成；额度、错误、取消、中断也必须映射到各自终态，receipt 不得虚假成功。
- **实际 / 证据**：job `e4fc94df-6a13-44de-aee1-6654e08ee68e` 的 `progress_json.status=paused`、`phase=第 1 章审查未通过，等待处理`、`result.reason=review`、章节仍为 0；路由随后无条件把顶层 job 覆盖成 `succeeded/done`，command receipt `39fcea23-757d-4f02-bfc2-055f743c8d12` 也为 succeeded。
- **影响范围**：所有 auto 的 review/paused/quota/error/interrupted/stopped 终止原因；任务中心、审计和命令回执可能把未完成或失败误报为 done。
- **根因**：`/api/novel/auto/start` 在 `runAuto` 返回后无条件 `updateJob(...succeeded, done)`，覆盖了 `saveAutoSession` 已持久化的 paused/stopped/interrupted/failed 阶段；同一 job 绑定的 command receipt 也因此收到错误终态。
- **修复**：新增 `autoReportJobOutcome`，按 `done/complete、review/paused、score、stopped、interrupted、quota、error` 分别映射 job 的终态与 phase；晚到的循环收尾不会把已取消 job 改写成成功。
- **回归与门禁**：`tests/autorun-fix.test.ts` 覆盖 5 类退出原因映射；定向 18 pass / 0 fail，typecheck、架构检查、client/SSR build 和 `git diff --check` 通过。此前完整门禁基线为 708 pass / 0 fail（3959 assertions）。
- **commit / push**：`248b7f8`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器复验**：服务重启恢复 auto job `cdf070bd-0e1f-4883-ad53-43c8b7fd7301` 后，通过真实“连载控制台 → 停止连载”发出持久停止命令；修复后的退出映射没有再把 review/stopped 写成 succeeded/done，权威章节数保持 0。继续等待完整 provider 晚到后发现 job 由 cancelled 回滚 paused，而 receipt 仍 cancelled；该通用终态单调性问题另立 `BROWSER-BUG-020`，不把异常计作本条通过项。审查暂停样本 `e4fc94df…` 的 `result.reason=review` 与 progress paused 证据保留在本条复现记录中。
- **严重度 / 状态**：P2；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-017 [P2] 自动连载首章运行期间任务中心显示“暂无连载任务”

- **首次发现**：2026-08-14 12:59（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-AUTO-01` + `ASYNC-CONCURRENT-UI-01`，真实 UI 在《纸月邮局》启动目标 1 章的自动连载后立即打开任务中心。
- **预期**：任务中心立即显示 auto session 的目标、已写章数、当前阶段和可用控制；底部状态、任务中心与持久 job 必须一致。
- **实际 / 证据**：页面正文区与底部均显示“自动连载：第 1 章写作中（第 1 稿）…”，SQLite auto job `e4fc94df-6a13-44de-aee1-6654e08ee68e`、command `39fcea23-757d-4f02-bfc2-055f743c8d12` 为 `running/连载开始`；同一 Tab 的任务中心却显示“暂无连载任务 · 在底部『推进剧情』下拉选『章节连载』开始”。
- **影响范围**：每次新启动自动连载的首章运行窗口；用户无法从任务中心核对目标和进度，也无法使用其中的暂停/取消控制，且与底部运行锁互相矛盾。
- **根因**：`startAutoRun` 在提交请求前发出的 snapshot 请求早于服务端创建 auto session；`runAuto` 随后只调用 `saveAutoSession`，没有发布初始 `auto-status`。第一次 `touchSession` 要等到整章提交或暂停，导致首章运行期间所有订阅 Tab 都收不到包含 session 的新 system snapshot。
- **修复**：集中 `publishSessionStatus`，auto session 初次持久化后立即发布不可合并丢失的 `auto-status`；后续阶段仍走 1 秒节流。WS 随事件紧跟权威 system snapshot，任务中心和新 Tab 可立即恢复 `running/target/written/phase`。
- **回归与门禁**：`tests/autorun-fix.test.ts` 新增真实 `runAuto` 首帧广播断言；定向 13 pass / 0 fail。`bun run check` 708 pass / 0 fail（3959 assertions），架构检查确认 49 个公开命令，typecheck、client/SSR build、`git diff --check` 均通过。
- **commit / push**：`33e59e8`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器复验**：重启隔离生产服务后从持久 paused session 点击“恢复”；350ms 内重新打开任务中心，页面立即显示“连载中 · 0/1 章（0%）· 第 1 章重试中（上一稿审查未过）”，与新 auto job `cdf070bd-0e1f-4883-ad53-43c8b7fd7301` 的 `running` session 一致，不再出现“暂无连载任务”。
- **严重度 / 状态**：P2；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-016 [P2] 刷新重进后任务中心把正在运行的单章推进显示为空闲

- **首次发现**：2026-08-14 12:14（Asia/Shanghai）。
- **场景 / testId / Tab**：`ASYNC-ADVANCE-02` + `MULTITAB-CONCURRENT-UI-01`，Tab A 通过真实 UI 发起第二次单章推进并刷新，Tab B 同书重新进入后打开任务中心。
- **预期**：任务中心从权威 system snapshot 恢复单章 job 的阶段与进度，至少应与底部“进行中…”锁、SQLite job/progress 一致，不得提示用户再次开始。
- **实际 / 证据**：Tab B 底部按钮为 disabled 的“进行中…”；SQLite job `011ef487-f857-4b03-a19c-069543ccfafd`、command `edbbcfe4-2efd-49e5-8539-a41addd438df` 为 `running/reviewing`。同一页面的任务中心却显示“推进剧情（单章）—空闲 · 在底部控制条点『推进剧情』开始单章写作任务”。
- **影响范围**：所有在单章推进运行期间刷新、关闭或从另一 Tab 重进的用户；任务中心与页面锁自相矛盾，会导致错误恢复判断与重复操作。
- **根因**：`system-snapshot` 已把运行中的 `advanceTask` 恢复为页面 `advancePhase`，底部运行锁也使用该状态；但 `TaskCenterModal.advanceBusy` 仍只读取当前 Tab 发起 SSE 时设置的本地 `busy`。刷新或新 Tab 的 `busy=false`，因此同一页面出现“进行中”与“空闲”两套结论。
- **修复**：新增 `advanceTaskIsBusy`，任务中心统一以“本地 in-flight 或权威 snapshot phase”判定单章任务；自动连载期间仍保持互斥隔离。
- **回归与门禁**：`tests/home-task-center.test.ts` 覆盖刷新后仅有快照阶段、首个快照前仅有本地 busy、自动连载互斥三条路径；`bun run check` 707 pass / 0 fail（3958 assertions），架构检查确认 49 个公开命令、typecheck、client/SSR build 和 `git diff --check` 均通过。
- **commit / push**：`77565a1`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器复验**：修复后的生产 bundle 中，在《纸月邮局》真实发起单章推进，运行中刷新并重新打开任务中心；底部保持 disabled 的“进行中…”，任务中心同步显示准备/考据/本章计划/写作/审查/修补/结算/存档步骤、当前 `delta` 阶段和“取消推进”，不再出现空闲提示。应用 console warning/error 为 0。
- **严重度 / 状态**：P2；已修复、真实浏览器复验通过并已推送。

> `ASYNC-ADVANCE-RESTART-01`：为精确覆盖服务重启，在《纸月邮局》通过真实 UI 发起独立推进 job `deddc496-f65d-49a0-847a-f406ae91a92d`（command `1eadf24f-6838-45c5-86c7-bb69a5dccb8a`），确认其处于 `running/writing` 后停止服务。重启时 job 单调收敛为 `interrupted/interrupted`，receipt 收敛为 `failed`，错误均为“服务重启中断了任务；已核对持久状态，无法证明任务完成”；权威 `state.json` 仍为 0 章。重新进入真实页面后底部为“待机/推进剧情”，无半章、幽灵 loading 或应用 console 异常。此前用于 BUG-016 相邻复验的同书推进因 provider 失败明确收敛为 failed，未计作重启通过。

### BROWSER-BUG-015 [P1] 明确写入指令被上下文串话误分类

- **首次发现**：2026-08-14 11:42（Asia/Shanghai）。
- **场景 / testId**：`BRAIN-ACTION-020/024/029/030/032/036/038/040/041`，三个真实 UI Tab 交错提交，同账号《雾港电台》，部分同会话在前一条写操作后立即发生。
- **复现 / 实际分类**：“导出全书为Markdown”→ 新增伏笔；“展开首个故事弧的章纲”→ 确认草稿入册；“自动更一章，别多写”→ 普通推进；“先停下连载任务”→ 普通推进；“来一张事件卡试试”→ 整书评估；“加个人物叫许舟”在前一条关系解除后返回同一关系操作结论；“不要许舟这个角色了”→ 删除章节；“把第一章重新写一遍”→ 回溯重写队列；“第一章的账重新算一下”→ 生成章节插画。
- **预期**：明确且高风险写入句式应稳定命中对应 intent；当前会话历史只用于指代参数，不得改变当前强指令分类。如无法确定参数应追问，不得回复另一类写操作。
- **证据 / 影响**：用户输入与 assistant 卡片已持久写入 `/tmp/moshift-realqa-Dl0cXq/data/qa814r9k2/*/brain-sessions.json`；错误 action 虽多数需确认，但角色关系/角色创建分支可直接改写 world，错误确认会导致错写入，且与当前用户意图无关。属核心写入流程失效与数据污染风险。
- **根因**：除媒体与参数查询外，强写入指令也全部交给模型分类；`recognizeIntent` 把最近 6 条消息与当前输入置于同一分类请求，模型在连续写操作中过度延续上一 intent/params。服务端没有对当前明确指令做确定性优先约束。
- **修复**：新增 `explicitActionIntent`，仅接管语义强、参数可确定的导出、弧章纲、连载启停、抽卡、章节删除/重写/重算、关系解除与角色 CRUD 句式，并提取章号、角色名、定位、状态、数量等参数；含糊/故障询问仍交给上下文模型。快路径优先于 provider，因此不会被上一回合改写意图。
- **回归与门禁**：`bun test tests/brain-chat.test.ts` 94 pass / 0 fail，新增 10 条真实错分句式、参数提取、故障询问不误触发和“不调云端分类器”流程回归；`bun run check`、`bun run build`、`git diff --check` 通过。
- **commit / push**：`1f92ed9`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器复验**：重启隔离服务后在 A/B/C 三 Tab 重放 9 条原始错分句式，依次得到“导出全书 / 展开弧章纲 / 开始自动连载 / 停止连载 / 抽卡卡池 / 角色已创建 / 角色未找到 / AI 重写章节 / 重算本章账本”的正确权威卡。Tab C 在《纸月邮局》创建许舟后，Tab A 在《雾港电台》删除许舟明确返回“角色未找到”，权威 `state.json` 只在《纸月邮局》含许舟，跨故事隔离通过。证据图 `BROWSER-BUG-015-tabA/B/C.png`；三 Tab 应用 console warning/error 均为 0，Statsig 噪声已排除。
- **严重度 / 当前状态**：P1；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-014 [P1] 角色视觉的永久 provider 失败被巡检每分钟无界重试

- **首次发现 / 场景**：2026-08-14 11:15（Asia/Shanghai）；`ASYNC-VISUAL-FAIL-RECOVERY-01`，隔离实例 `127.0.0.1:32741`，账号 `qa814r9k2`，《纸月邮局》角色“纸月”（`c3`）。
- **复现与实际**：真实 UI 立项后，头像 provider 稳定返回 HTTP 400 `Unable to generate this content`。同一 `dedupeKey=visual:纸月邮局:c3` 终态 failed 后可再创建新 job；60 秒巡检与 60 秒 `visualTriedAt` 冷却叠加，每轮都再调 provider。SQLite `/tmp/moshift-realqa-Dl0cXq/data/app.db` 累计 **53 条**同角色 failed visual job；最新为 `b518b95a-4b6b-4186-b772-61a700055ba2`（2026-08-14T03:17:08.216Z），相邻 job 以约 60–120 秒间隔出现，服务日志每轮均为实际 provider 失败。
- **预期 / 影响**：永久 4xx/内容拒绝必须停止自动重试但保留可见 failed；瞬时失败应有持久退避与最大尝试数，手动重试不受限制。旧行为会无界消耗 provider 额度、污染 job/操作日志，属于重复 provider 副作用。
- **根因**：`ensureCharacterVisuals` 只依赖进程内 in-flight 去重和 1 分钟内存时间戳；任务结束后唯一活跃 job 约束释放，巡检无法根据持久 failed job 区分永久失败与瞬时故障。
- **修复**：以持久 `visual` job 作为权威尝试史：4xx（除 408/409/425/429）和内容拒绝直接停止自动重试；瞬时失败仅按 5/30 分钟退避自动尝试，总上限 3 次。读时自愈、定时巡检和所有自动入口共用此门禁，用户手动生成不受影响；同步修订 `WorldCharacter` 契约、`CMD-S11` harness 和 `docs/HARNESS.md`。
- **回归与门禁**：`bun test tests/media-auto.test.ts` 新增永久 HTTP 400 用例（读时自愈后 visual job 数和图片调用数均不增），9 pass / 0 fail；`bun run check`、`bun run build`、`git diff --check` 通过。
- **commit / push**：`8f0b9c1`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器 / 重启复验**：修复构建启动后运行超过 4 个巡检周期，SQLite 仍为 53 条，最新时间仍停在修复前 `03:17:08.405Z`；日志无新“纸月”图片调用。故障已在服务重启后持续收敛，不再产生重复 provider 副作用。
- **严重度 / 状态**：P1；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-013 [P2] 未执行的不可逆操作被中枢正文虚假宣称已完成

- **首次发现**：2026-08-14 11:11（Asia/Shanghai）。
- **场景 / testId / Tab**：`BRAIN-ACTION-012`，Tab B，同账号同故事《雾港电台》，当前世界尚无章节。
- **复现步骤**：通过真实中枢输入“删除第一章”；等待意图识别与卡片持久化；不点击执行或确认，对比正文、`preview/confirm` 卡和权威 world。
- **预期**：在用户确认和执行前，正文与预览摘要必须明确“尚未写入”，不得声称删除已完成；权威卡应保持 `CMD-N08 / L3 / 需确认`。
- **实际**：正文和 preview summary 同时显示“已删除第一章，当前《雾港电台》共 0 章，写作进度 0/32”；同回合 confirm 卡却显示 `CMD-N08 / L3·不可逆 / 需确认`，且用户未执行任何操作。
- **证据**：持久会话 `/tmp/moshift-realqa-Dl0cXq/data/qa814r9k2/雾港电台/brain-sessions.json` 中用户消息 `a1f0e6d4-eabd-42e4-a702-5bdf6707f1ab`、assistant 消息 `bd43b47b-c024-4b78-892a-d674f25a1658`；后者 `text` 和 preview `summary` 都是错误的已完成陈述，但 `confirmRequired=true`、action 仍为 `/api/novel/chapter/delete`。浏览器 DOM 同时显示错误正文、“删除章节 · 确认”卡和“放弃”按钮；无 command receipt，证明并未执行。
- **影响范围**：所有使用 provider `reply` 作为待执行 preview 正文/摘要的写操作，尤其是 L2/L3 章节重写、回滚、删除和重算；用户无法判断操作是“待确认”还是“已执行”，属于明确错误事实反馈。
- **根因**：通用 action 分支在任何业务请求发出前，直接把 provider 的自由 `reply` 同时写入 assistant 正文和 preview `summary`；代码只对 `edit_world` 表单做过中性化，没有覆盖通用 L0–L3 action。
- **修复**：所有带 action 的待执行意图统一生成确定性中性正文，明确“当前尚未执行”；preview summary 复用同一权威文案，终态仅允许由 action/result 卡给出；同时移除忙状态拒绝分支的重复 delta。
- **回归与门禁**：`bun test tests/brain-chat.test.ts`（91 pass / 0 fail）增强删章用例，使 provider 返回“已删除”冲突文案，断言正文、preview 摘要均为未执行语义；`bun run check`、`bun run build`、`git diff --check` 通过。
- **commit / push**：`26fc9ed`；已推送到 `origin/codex/brain-reliability-ui`。
- **真实浏览器复验**：重启隔离生产服务并通过真实 UI 提交“请删除第一章”；正文和 preview 均显示“已准备『删除章节』操作；请核对下方预览并确认后执行，当前尚未执行”，卡仍为 `CMD-N08 / L3 / 需确认`，无写回执。证据图 `/tmp/moshift-realqa-Dl0cXq/evidence/BROWSER-BUG-013-verify.png`；应用 console warning/error 为 0，Statsig 批队列警告为 Browser 工具噪声已排除。
- **严重度 / 当前状态**：P2；已修复、真实浏览器复验通过并已推送。

### BROWSER-BUG-012 [P1] 立项完成后当前 Tab 永久停留在“世界构建中”

- **首次发现**：2026-08-14 09:52（Asia/Shanghai）。
- **场景**：`ASYNC-NEW-STORY-01`，隔离生产实例 `127.0.0.1:32741`，账号 `qa814r9k2`，通过真实 UI 立项《雾港电台》。
- **复现步骤**：从空书架点击“+ 新建”，提交近未来悬疑灵感；等待 `ready` 后页面自动打开故事；继续等待后台蓝图增强、封面和角色视觉全部结束，不刷新当前 Tab。
- **预期**：`new-story` 进入 `succeeded/done` 后，页面自动清除世界构建横幅和运行锁，推进、抽卡、评估及编辑操作恢复可用。
- **实际**：SQLite job `e0f98d26-b589-466f-b945-dbccd79aea51` 已于 `2026-08-14T01:52:00.458Z` 进入 `succeeded/done`，封面及 3 个 visual job 也全部 succeeded；当前 Tab 超过十秒仍显示“世界构建中：世界已就绪，正在生成故事蓝图…”，创作按钮持续 disabled。
- **影响范围**：所有从书架提交立项并在 `ready` 帧自动进入故事的用户；必须刷新页面才能解除假运行锁，属于核心首用流程失效。
- **根因**：`Home` 在消费 `ready` 帧并自动导航时清空 `lastTaskIdRef`；后续 library `done` 帧只通过该 ref 查任务，未使用仍保存于页面的 `currentTaskId`，因此永远跳过清锁分支。
- **修复**：新增 `trackedNewStoryTask`，以“本次提交 id → 页面当前任务 id”为追踪优先级；完整 library snapshot 中任务终态或任务已被清理时统一清除 `currentTaskId/buildingStage`。
- **回归测试**：`bun test tests/home-story-open.test.ts`（3 pass / 0 fail）覆盖 ready 导航清空提交 ref 后仍按页面 task id 消费 done；`bun run check`（700 pass / 0 fail，3931 assertions）、`bun run build`、`git diff --check` 通过。
- **commit / push**：`7cb2274`；已推送到 `origin/codex/brain-reliability-ui`。
- **复验结果**：用同一隔离数据第二次真实立项《纸月邮局》，在 `running` 阶段刷新并从书架重新进入；页面恢复构建锁。job `5621facb-e990-451a-aef2-514c273c0baf` 进入 `succeeded/done` 后，当前 Tab 未刷新即自动移除构建横幅，抽卡和推进按钮恢复可用。一个角色视觉因 provider 内容拒绝明确进入 failed，不影响 new-story 终态，未伪装为成功。
- **状态**：已修复、真实浏览器复验通过并已推送。

## 2026-08-14 中枢问答与 UI 深度验收

### BROWSER-BUG-009 [P2] 时间线/蓝图查询没有回答记录内容，并泄漏英文内部状态

- **首次发现**：2026-08-14 02:11（Asia/Shanghai）
- **场景/testId**：`BRAIN-UI-QUERY-01/02`，真实询问“时间线现在记录了什么”“查看全书蓝图结构”。
- **复现步骤**：真实注册 `uiqa0814`；通过 provider 立项《雨夜档案》并等待蓝图任务成功；打开中枢，依次提交上述问题并等待卡片终态。
- **预期**：正文直接回答时间线实际记录；无章节事件时明确说明。蓝图卡应以紧凑、稳定层级展示全书结构，所有业务状态使用有意义的中文。
- **实际**：时间线正文只回答“2 卷、下一章、目标 30 章”，没有说明时间线实际没有已入册事件；卡片展示 `雨夜降临 · writing`、`expanded`、`skeleton`、`planned`。蓝图卡将长达一整句的指南针与“已写章/目标章”挤入三列统计区，随后再次原样展示 `writing/planned/expanded/skeleton`，字号、列宽和信息层级混乱。
- **浏览器/服务/SQLite/磁盘证据**：隔离端口 `3229`；同一真实会话 DOM 同时保留用户问题、确定性正文和 BrowseCard；权威 `state.json` 有 2 卷、6 弧、0 章、空 `timeline`，证明正文没有回答可用事实而非 provider 缺数据。应用 console 无 warn/error；Browser Statsig telemetry 警告为工具噪声。
- **影响范围**：`read_timeline`、`read_outline` 以及使用同一卷/弧状态展示的查询卡；用户无法区分“时间线没有事件”和“系统没有回答”，内部枚举降低可读性，长指南针破坏窄中枢面板布局。
- **根因**：`executeQuery(read_timeline)` 没有把 `world.timeline` 放入卡片，`l0QueryReply` 仅统计卷数；`BrowseCardView` 的 timeline/outline 分支直接 `String(status)`，且 outline 把自由长度指南针错误复用数字统计格。
- **修复方案**：时间线查询增加权威事件列表和空态，正文优先概括实际事件；集中映射卷/弧状态为中文业务语义；蓝图只保留两项数字进度，指南针改为独立摘要，卷/弧条目使用稳定的标题、状态和目标层级。
- **回归测试**：`bun test tests/brain-chat.test.ts tests/brain-cards.test.ts`，113 pass / 0 fail；覆盖权威时间线事件、空时间线正文、时间线/蓝图英文枚举隔离、中文阶段、两格统计和独立指南针布局。`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- **commit / push**：本条缺陷独立提交；实际 SHA 与 push 结果见本批次最终记录。
- **复验结果**：刷新故事页并关闭/重新打开中枢后，旧历史卡立即按新版组件重渲染，`writing/planned/expanded/skeleton` 全部中文化；新提交“时间线上现在有哪些已记录的事件？”明确回复“时间线目前还没有已入册事件”，且展示同义空态；新提交“请简要展示全书蓝图结构，并告诉我每卷和每条故事弧的当前阶段。”返回 2 卷、6 弧的权威结构和中文阶段。441px 实际中枢宽度下，卡片 `clientWidth === scrollWidth === 441`，统计区恰有两格且 `356 === scrollWidth`，独立创作方向 `353 === scrollWidth`，无横向溢出或元素重叠。两条问法各真实调用文本 provider 一次，均自然完成，未重试。应用页面无 console warn/error 或网络失败；Browser 插件 Statsig 批处理警告仅来自工具脚本，单独排除。
- **最终状态**：已修复，真实浏览器复验通过，待本条提交推送。

> `BRAIN-UI-NEW-STORY-STATE-01` 曾在立项 `ready` 阶段观察到顶层 job 仍为 running；继续等待后真实蓝图/首弧 provider 在既定时限内完成，job 收敛为 succeeded，刷新解除只读。`ready` 在现协议中明确表示“基础世界可进入、后台增强仍运行”，因此该过程归为预期运行态，不登记缺陷。

### BROWSER-BUG-010 [P1] 作者编辑问答遗漏目标字段并产生成功假回执

- **首次发现**：2026-08-14 02:25（Asia/Shanghai）
- **场景/testId**：`BRAIN-UI-FORM-STATE-01`，真实询问“请把故事作者署名改为测试作者”。
- **复现步骤**：在《雨夜档案》当前中枢会话提交上述问句；等待真实文本 provider 返回；展开“编辑设定与全局信息”卡；检查字段后按页面顺序在唯一空文本框输入“测试作者”，只点击一次“保存设定”；刷新页面、关闭并重开中枢，再展开同一持久卡。
- **预期**：问题明确指定作者和值，卡片应只呈现或至少预填作者字段，并以写操作级别说明影响；提交后权威 `state.json.author` 为“测试作者”，回复只能陈述实际保存结果。完成态刷新后不可再次提交。
- **实际**：卡片没有作者字段，唯一空文本框实际标注“全局当前状态”；卡片却使用 `CMD-W12 / L0·只读`。提交后 UI 显示“已将故事作者署名改为「测试作者」”“已保存”“✓ 已执行”，但 `state.json` 完全没有 `author`，实际把 `current` 写成了“测试作者”。刷新后 `executionState=succeeded` 能阻止重复提交，但错误业务结果和假成功摘要被持久保留。
- **浏览器/服务/SQLite/磁盘证据**：真实卡 `card-87663393-7503-4cff-81fd-d134c769cece`、消息 `35aa98ea-397d-4345-8dff-e6efff4f1580`；字段依次为 `premise/current/setting.time/setting.place/setting.tone/setting.rules`，无 `author`；持久卡终态 `executionState=succeeded, detail=已保存`。SQLite receipt `07e8ec69-b580-4686-a1cf-e516ad39ccde` 为 succeeded，证明错误字段写入成功而非请求失败。磁盘 `state.json` 无 `author`/“测试作者”作者值。刷新、关闭重开后保存按钮未复活，完成态恢复这一子项通过。
- **影响范围**：所有通过中枢修改作者的问法；用户会误以为作者已修改，同时无意污染全局当前状态。卡片风险级别错误会弱化写操作提示。
- **根因**：`buildFormCard(edit_world)` 的全局表单遗漏 `/api/novel/world` 已支持的 `author` 字段；作者问法因此落入无关的“全局当前状态”字段。provider 生成的开场 `reply` 被同时用作表单 summary，在真正提交前就可能声称操作已完成。
- **修复方案**：新增作者参数结构化提示和明确“作者/署名”句式兜底；作者问法走只含“作者署名”字段的专用表单，预填目标值并标为 `CMD-W12/L2`；编辑类回合统一发送“提交前不会写入故事”的中性正文，不再把 provider 的已完成句子当作事实。普通设定表单保持 `L0` 只读影响等级，避免改变既有契约。
- **回归测试**：`bun test tests/brain-chat.test.ts tests/brain-cards.test.ts`，115 pass / 0 fail；新增作者参数/句式预填、专用字段、L2 标识和 provider 误报中性正文回归。`bun run typecheck`、`bun run check:architecture`、`bun run build`、`git diff --check` 通过。
- **commit / push**：本条独立提交；实际 SHA 与 push 结果见本批次最终记录。
- **复验结果**：隔离实例 PID `12684`、端口 `3229` 加载修复构建；真实新问法“请把故事作者署名改为修复后作者”只调用文本 provider 一次。浏览器卡片显示“请核对下方待修改内容；提交前不会写入故事”、标题“修改作者署名”、`CMD-W12`、`L2·回溯`，唯一字段“作者署名”预填“修复后作者”。只点击一次“保存署名”后页面显示“已保存/✓ 已执行”；磁盘 `state.json.author=修复后作者` 且 `current` 未变化，SQLite receipt `81b44fdf-9d0c-4de8-a618-ef1c96cb1050` 为 succeeded。刷新、关闭重开、继续只读聊天、新建并切换会话 Tab 后卡片仍只有完成标记，按钮没有复活。应用页面无 console/network 异常；Statsig POST 超时属于 Browser 插件工具噪声，单独排除。
- **最终状态**：已修复，真实浏览器复验通过，待本条提交推送。

### BROWSER-BUG-011 [P1] 全局当前状态表单保存成功但服务端丢弃字段

- **首次发现**：2026-08-14 02:38（Asia/Shanghai）
- **场景/testId**：`BRAIN-UI-FORM-STATE-02`，真实询问“请把全局当前状态改为雨季档案馆开放”以及“将全局当前状态设置为档案馆暂停开放”。
- **复现步骤**：在修复后的作者场景会话中逐条提交上述当前状态问法；等待真实 provider；展开“编辑设定与全局信息”；第一次直接点击“保存设定”；第二次在标注“全局当前状态”的输入框手工填写“档案馆暂停开放”，只点击一次“保存设定”；查询服务端磁盘和 SQLite receipt。
- **预期**：明确目标值应预填到“全局当前状态”字段；提交一次后 `state.json.current` 应保存该值，receipt result 应包含该值，刷新/重开后卡片终态保持且世界事实一致。
- **实际**：目标问法没有预填；第一次空提交仍显示“已保存/✓ 已执行”。第二次手工填入“档案馆暂停开放”后同样显示成功，但 `state.json.current` 仍为空，receipt `915af08a-d140-4ad0-b0a5-65ad52eab105` 为 succeeded 且 result 不含目标值。卡片刷新前后完成态不复活，但权威世界没有变化。
- **浏览器/服务/SQLite/磁盘证据**：隔离端口 `3229`、临时账号 `uiqa0814`、故事《雨夜档案》；两次提交各一次，无 provider 重试。磁盘 `state.json.author=修复后作者`、`current` 为空且无“档案馆暂停开放”；receipt status=succeeded、error=null。应用页面无 console/network 异常；Statsig 超时为 Browser 插件工具噪声。
- **影响范围**：所有通过中枢“全局当前状态”编辑的请求；用户会得到成功假回执，状态看似完成但权威世界不变。
- **根因**：`buildFormCard(edit_world)` 的通用设定表单没有根据 `current` 问法预填；`/api/novel/world` 路由构造 patch 时遗漏 `current`，尽管 `director.editWorld` 已支持该字段。
- **修复方案**：增加当前状态目标值提取并只在明确“当前状态”问法中预填；路由把 `body.current` 传入导演 patch；普通设定卡摘要明确“提交前不会写入”，保持 `L0` 只读影响等级。
- **回归测试**：`bun test tests/brain-chat.test.ts tests/command-endpoint.test.ts`，98 pass / 0 fail；覆盖结构化参数与明确中文问句的当前状态提取、角色状态误匹配隔离、表单预填，以及 `/api/novel/world` 标量白名单透传 `current`。`bun run typecheck`、`bun run check:architecture`、`bun run build`、`git diff --check` 通过。
- **commit / push**：本条缺陷独立提交；实际 SHA 与 push 结果见本批次最终记录。
- **复验结果**：隔离实例端口 `3229` 加载修复构建；真实新问法“请把全局当前状态改为修复验证状态”只调用文本 provider 一次。浏览器卡片以中性正文提示“提交前不会写入故事”，`CMD-W12 / L0·只读` 通用设定卡的“全局当前状态”字段准确预填“修复验证状态”。只点击一次“保存设定”后显示“已完成 / 已保存 / ✓ 已执行”；磁盘 `state.json.current=修复验证状态`，SQLite receipt `ea482183-94dc-4897-9491-ab8059eefc79` 为 `succeeded` 且 result 含该值。刷新页面、关闭后重新打开中枢、继续询问“当前状态是什么？”、切换到另一中枢会话再切回后，卡片仍保持完成终态，页面中“保存设定”按钮数量为 0，不能重复提交。应用页面无 console/network 异常；Browser 插件 Statsig telemetry 噪声单独排除。
- **最终状态**：已修复，真实浏览器复验通过，待本条提交推送。

## 2026-08-13 真实浏览器深度验收

### 2026-08-14 批次收尾

- 本批次使用隔离账号 `deep34506238`、故事《雨夜档案》、临时 SQLite/数据目录和端口 `3217`，累计通过真实 UI 提交超过 110 条 Brain 问法；仓库正式 `data/` 未进入测试范围。
- 共确认并关闭 5 个浏览器缺陷。每个缺陷均先登记证据，再完成最小修复、相关自动化回归、真实浏览器复验、独立提交和立即推送。
- 真实插画 provider 共生成 3 次：首次生成、一次重生成、删除后最终恢复；均进入明确成功终态。视频分镜和视频 provider 各提交 1 次，未重试。
- 插画删除在 Tab B 执行后，Tab A 无刷新移除对应媒体；最终恢复生成后刷新仍显示新文件。角色/关系、伏笔账、任务中心和小说设置全部页签均完成真实 UI 覆盖，未发现新的产品缺陷。
- Browser 工具自身 Statsig telemetry 超时/队列警告与应用页面 console 分开记录；两个应用 Tab 的实际 warning/error 均为 0。

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
- **commit / push**：`02dbf5c`；已推送到 `origin/codex/brain-reliability-ui`。
- **复验结果**：共三次导出动作且未超过上限。第一次复现旧实现假成功；第二次 Blob 实现显示开始下载但浏览器无下载事件、磁盘无文件；最终原生 URL 实现只点击一次即捕获真实 download 事件。页面保持在故事 SPA，卡片显示“已请求下载：雨夜档案.md”并进入已完成；应用 console 无 warn/error。`C:\Users\Administrator\Downloads\雨夜档案.md` 实际落盘 222 字节，UTF-8 可解码，首行为 `# 《雨夜档案》`，SHA-256 为 `16C98B8F03C2E52B441BCB5E4B611A3A1C6B97A87D58BD12D06DD1BECA5656B4`。
- **状态**：已修复、真实浏览器复验通过并已推送。

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
- **commit / push**：`838e8bb`；已推送到 `origin/codex/brain-reliability-ui`。
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
- **commit / push**：`e3034ee`；已推送到 `origin/codex/brain-reliability-ui`。
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
- **commit / push**：`caa9598`；已推送到 `origin/codex/brain-reliability-ui`。
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
- **commit / push**：`f411664`；已推送到 `origin/codex/brain-reliability-ui`。
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
