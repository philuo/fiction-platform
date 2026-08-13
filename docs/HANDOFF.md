# 重构与真实浏览器验收交接

> 当前开发规范仍以 `docs/INSTRUCTION.md` 为准；本文记录 `codex/brain-reliability-ui` 分支截至 2026-08-13 的真实验收结果。

## 2026-08-14 深度验收补充：《雨夜档案》

本节是新一轮独立验收，不覆盖下方《雨夜验尸簿》的历史结果。测试使用账号 `deep34506238`、独立端口 `3217`、临时 SQLite、临时数据/媒体/Brain 会话目录和临时 `.env` 副本；正式仓库 `data/` 从未被读取或修改。

### 覆盖与结论

- 通过真实 UI 累计提交超过 110 条 Brain 问法，覆盖导航、世界查询/编辑、角色、关系、伏笔、章节生成与治理、proposal、媒体以及自然语言变体。ask/form/confirm/preview/proposal 卡的可见提交、取消和拒绝路径均有真实交互；达到上限后停止批量 provider 调用。
- 认证、合规注册、自动登录、空书架、真实文本 provider 立项、封面及 4 个角色视觉资源通过；直接 URL、刷新、关闭重开和服务重启后均可恢复。
- 两个故事 Tab 同时工作：设置、角色/关系、伏笔 CRUD、proposal 关闭/重开/拒绝、章节和媒体写入均通过权威 sync 收敛。不存在已删除状态轮询接口；未观察到重复 job、重复章节或跨 Tab 分叉。
- 本轮共发现并修复 5 个真实缺陷：重启中断 job 进度分叉、设置查询误判、Brain 正文与权威卡片矛盾、伏笔删除确认不可达、Brain 导出附件假成功。对应提交为 `f411664`、`caa9598`、`e3034ee`、`838e8bb`、`02dbf5c`，均已推送。
- 角色/关系面板、关系图取消路径、伏笔账只读与编辑状态、任务中心、小说设置的全局/章节/设定/角色/大纲/导出页签、审查报告和版本相关入口均通过真实页面打开；未发现新的契约异常。

### Proposal、章节和故障恢复

- 真实角色抽卡 1 次，应用角色卡后形成 pending proposal；Tab A 关闭后 Tab B 同步关闭且刷新持久。Brain 输入“打开新角色提案”后两个 Tab 重开；最终拒绝，唯一 `CMD-L11` 成功，角色仍为 4 个且未触发新的视觉 job。
- 单章推进最多 3 次用户提交，最终第 1 章《差三分》成功入册并审查通过。自动连载只启动 1 次，目标新增 2 章；服务重启后从已提交边界恢复，最终章节索引恰好为 `[1, 2, 3]`，无重复入册，`CMD-N03` 和 autorun job 成功，运行锁释放。
- 故障注入实际发生在自动连载第 2 章写作早期，而不是“第 2 章已提交、第 3 章运行中”。最终恢复结果满足边界一致性，但该更精确时序没有在本轮复现，不能据此声称已覆盖。
- 重启、刷新和关闭 Tab 后，持久 job/receipt、Brain 卡、章节 world 和 UI 均收敛；不可恢复的单章任务明确进入 interrupted/failed，不保留幽灵 loading。

### 媒体与附件证据

- 插画分镜最初提交 1 次；插画 provider 共成功生成 3 次（首次、重生成、删除后最终恢复），达到允许的三次总提交上限。重生成期间原图保留到新图 ready；删除在 Tab B 执行后 Tab A 无刷新同步移除，最终恢复图片刷新后仍由浏览器加载。
- 视频分镜和视频 provider 各提交 1 次，未重试。最终 MP4 为 1,349,686 字节，`ftypisom`，SHA-256 `66E4F230AC32CF2410E1FB97FBA5DF255EA2D9B8E0CDAAE754DA763124E8B3F2`；浏览器 `readyState=4`、`1280x704`、时长 `8.041667s`。
- Brain 导出在修复后捕获真实 download 事件；`雨夜档案.md` 为 222 字节 UTF-8 文件，SHA-256 `16C98B8F03C2E52B441BCB5E4B611A3A1C6B97A87D58BD12D06DD1BECA5656B4`。
- 两个应用 Tab 的实际 console warning/error 均为 0。Browser 工具自身 Statsig telemetry 超时/队列警告不来自应用页面，单独归为工具环境噪声。

### 未完全覆盖

- 没有为每一种可见异步任务都消耗 3 次真实 provider 配额；高成本任务按风险选取代表性初次、重试和恢复路径，视频严格只提交 1 次。
- 没有执行真实系统断网切换，也没有在 SQLite commit、`state.json` rename 和 sync publish 的每一个精确指令边界强制 kill。
- 账本重算、章节重审和 AI 重写的入口及状态契约已覆盖，但为避免对已验收章节引入额外 provider 副作用，没有把三者全部重复执行到三次。
- 单根 `/api/sync` 由服务连接行为、客户端实现和无旧轮询请求交叉核验；Browser evaluate 沙箱没有提供可靠的 `performance` 资源计数，因此未伪造精确资源条目数量。

### 本轮最终自动化基线

- `bun run check:architecture`：133 files、409 imports、0 cycles、49 public commands。
- `bun run typecheck`：通过。
- `bun test`：693 pass、0 fail、3903 assertions、67 files。
- `bun run build`：client 与 SSR 均通过。
- `git diff --check`：通过。

## 本轮结论

本轮使用独立临时 SQLite、数据目录、Brain 会话、媒体目录和端口，以唯一临时账号和故事《雨夜验尸簿》完成真实浏览器验收。仓库 `data/` 未被使用。

非 provider 流程全部通过；真实文本、图片和视频 provider 均产出成功。两个浏览器 Tab 最终收敛到同一权威世界，无重复章节、幽灵 loading 或应用 console warning/error。

## 本轮修复

1. **新故事 ready 后自动打开偶发“故事不存在”**
   - 原因：ready library frame 触发 effect 后，`openStory` 又读取可能已切换的外部 store/React fallback。
   - 修复：把触发导航的 library frame 传入存在性判定；仍以 sync projection 为权威。
   - 回归：`tests/home-story-open.test.ts`。

2. **固定名生产 bundle 被浏览器长期缓存**
   - 原因：`/assets/entry-client.js` 与 CSS 使用固定文件名，却带一年 `immutable`，重建后浏览器仍执行旧代码，导致旧 world revision 发出 409。
   - 修复：生产 HTML 为 JS/CSS 附加基于内容的 `?v=<hash>`，保留原资源 URL 和构建结构。
   - 回归：`tests/prod-assets.test.ts`。

3. **Home 与持久异步分镜接口契约脱节**
   - 原因：后端 `/api/novel/media/plan` 已立即返回 `planId`，随后由 sync 发布 `ready/failed + scenes`；Home 仍按旧同步响应读取 `scenes`，把成功 job 误报为“场景规划失败”。
   - 修复：Home 登记当前 `planId`，只消费匹配的 sync 权威终态来打开确认弹窗或显示失败；继续兼容旧同步 `scenes` 响应，不新增 API 或轮询。
   - 回归：`tests/home-media-plan.test.ts`。

以上修复未改变公开 URL、命令类型、receipt、expectedRevision 或 projection 结构，因此未修改 BRAIN/HARNESS/INSTRUCTION 协议说明。

## 真实浏览器验收

### 认证、立项和资源

- 注册唯一账号后自动登录，空书架正确。
- 真实文本 provider 立项一次，ready projection 后自动打开成功。
- 封面、3 个角色头像和 3 个全身立绘均由真实 provider 生成并落盘。
- 直接 URL、刷新和服务重启后恢复正常。

### 多 Tab 写传播

- 两个 Tab 同时打开同一故事，每页由单根 `/api/sync` 收敛状态。
- Tab A 将作者改为“`双窗验收署名`”，Tab B 无刷新收到结果；刷新和直接 URL 后一致。
- SQLite 存在 `CMD-W12` 成功 receipt；world revision 单调增长。
- 客户端没有重新引入 `/api/novel/state`、`/api/novel/auto/status`、`/api/novel/media/status*`、`/api/novel/visual/status` 等已删除状态轮询。

### Proposal 关闭、重开和拒绝

- 真实角色抽卡一次，生成 3 张角色卡；应用 1 张产生“白无常” pending proposal。
- Tab A 关闭提示后 Tab B 同步关闭，刷新仍关闭。
- Brain 真实输入“打开新角色提案”一次，两个 Tab 均重新显示。
- 最终从可见抽屉点击“拒绝”，`CMD-L11` receipt 成功，两个 Tab 同步移除；没有创建新的角色视觉 job。
- 早先“拒绝按钮无反应”是自动化选中了高度为 0 的折叠抽屉 DOM，真实可见按钮没有事件缺陷。

### 两章自动连载和重启恢复

- 自动连载仅启动一次，目标 2 章。期间上游出现一次 HTTP 503，代码内有限重试后第 1 章成功提交。
- 在第 2 章生成期间精确终止隔离服务；重启日志识别 `target=2, written=1`，从最后提交边界恢复。
- 恢复期间 provider 有若干 120 秒内部超时，未做人工重提；最终第 2 章成功提交。
- `checkpoint.jsonl` 恰好只有 chapter 1、2 各一条 commit；世界恰好 2 章，无重复入册。
- `CMD-N03` receipt 为 `succeeded`；autorun job 为 `written=2/target=2`、`phase=连载结束（done）`，运行锁释放。
- Tab A 的旧 SSE 因服务重启显示一次 `network error` toast，但权威 world 未被草稿覆盖；最终两个 Tab 均显示 2 章且中枢待命。

### 插画与视频

- 插画分镜仅提交一次；真实文本 provider 在 7.0 秒生成 1 个场景。该成功 job 暴露并促成“异步分镜契约”修复，没有重复分镜调用。
- 修复后复用已持久场景，插画 provider 仅进入生成一次；约 9.8 秒完成，`CMD-M02`、image-batch 和 image job 均成功。
- 视频分镜仅提交一次，4.2 秒成功；视频生成仅提交一次，约 3 分 20 秒从 `waiting_external/provider-poll` 收敛到 ready，`CMD-M03` 与 video job 成功。
- 两个 Tab 刷新后均真实解码插画（896×560），视频 `readyState=4` 且无 media error；媒体文件存在于隔离磁盘。
- 插画确认曾有一条请求在 provider 前因 `expectedRevision 18 -> 19` 被 CommandBus 拒绝；按 revision 19 重基线后才创建唯一图片 provider job。该 409 不计 provider 调用，也未绕过并发控制。

## 用户提交与 provider 计数

- 故事立项：1 次。
- 角色抽卡：1 次。
- Brain 打开提案：1 次。
- 两章自动连载启动：1 次（仅使用代码已有有限内部重试）。
- 插画分镜：1 次；插画 provider 生成：1 次。
- 视频分镜：1 次；视频 provider 生成：1 次。
- 没有通过重复点击消耗 provider 配额。

## 浏览器与持久状态证据

- 两个 Tab 应用 console 的 warning/error 均为 0；工具自身 Statsig telemetry 超时不属于应用页面日志。
- 两个 Tab 刷新后章节、proposal、作者、插画和视频一致。
- command receipt 覆盖立项、设置、抽卡、proposal 偏好/拒绝、autorun、媒体分镜与生成。
- 所有 autorun/media job 均处于持久终态；无 running/interrupted 悬挂项。

## 最终自动化基线

- `bun run check:architecture`：133 files、409 imports、0 cycles、49 public commands。
- `bun run typecheck`：通过。
- `bun test`：687 pass、0 fail、3873 assertions、65 files。
- `bun run build`：client 与 SSR 均通过。
- `git diff --check`：通过。

## 后续重构边界

- `src/api/routes.ts` 与 `src/pages/Home.tsx` 仍然较大，后续可继续按 application use case / feature 拆分。
- 不得删除 canonical/legacy URL、兼容重导出、既有命令契约或 sync 唯一权威约束。
- 每个迁移域继续运行 architecture、typecheck、test、build 和 diff-check，并做隔离浏览器回归。

## 清理

验收完成后关闭两个测试 Tab，精确停止端口 3100 的测试 PID，并删除包含账号、故事、媒体、Brain 会话、SQLite、日志和临时 `.env` 的整个隔离目录。仓库不保留测试凭证或 provider 密钥。
