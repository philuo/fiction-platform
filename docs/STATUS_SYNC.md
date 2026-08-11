# 墨枢 状态同步盘点与演进方案（STATUS_SYNC）

> 定位：**推送/同步机制的决策文档**。扫描统计本项目当前的状态同步实现（以**前端轮询**为主），
> 评估更优方案（轻量 WebSocket 等），目标——**中枢聊天、列表、三栏、各类弹窗面板的全局状态一致**。
>
> 关联文档：现状耦合盘点见 [COUPLING.md](./COUPLING.md) §1（单一数据源/全量刷新/无订阅），
> 本文件聚焦「同步手段」本身并给出演进方案；FEATURES.md §8 为功能限制，BRAIN.md 为中枢设计提案（无同步机制描述，
> 中枢聊天的 SSE/重连机制实际实现在代码与测试中，见 §2.3.2）。
>
> 版本记录：v2（本轮深挖）——补充服务端写路径全图（§2.1）、前端状态流与启动链路（§2.2）、数据模型全图（§2.5）、
> 前端全局事件机制（§2.6）、测试基建与 mock 模式（§2.7）、广播点分级（§5.5）、问题清单扩充（§3）。

---

## 1. 结论摘要（TL;DR）

- **现状**：前端**无任何推送订阅**（无 WebSocket、无 EventSource、无 BroadcastChannel、无 React Context、无 CustomEvent），
  一切服务端→客户端的状态变化最终靠 **7 个前端轮询点**（3s×3、5s×3、3s×1 在聊天舱内）兜底发现，
  配合「轮询检测变化 → 手动刷新 world + 注入聊天系统条」的补偿链（§2.3.4）。
  长时任务（单章推进 / 连载 / 中枢对话）有各自的 **SSE 长连接**，但 SSE 全部是「客户端先发起」的请求-响应流，
  不能跨请求推送（唯一"写后广播"是 brain-sessions 的会话级任务注册表，§2.3.2）。
- **核心问题**：异步后台任务（立项构建 / 连载续跑 / 媒体生成 / 角色视觉）的感知**只有轮询**；
  服务重启后 `resumeAutoSessions` 的 onEvent 是空实现（`routes.ts:2617-2633`），连轮询都只能靠落盘文件比对。
- **推荐方案**：**轻量 WebSocket（Bun.serve 原生支持，零新依赖）承担「状态事件推送」，SSE 继续承担流式文本**。
  理由与对比见 §4，目标架构见 §5，迁移路线见 §6。
- **关键设计前提（本轮深挖结论）**：
  1. `saveWorld`（storage.ts:207）是 state.json 的**唯一落盘函数**，是覆盖度最高的广播挂载点，但**无 actor/字段语义**；
  2. `finalizeStateChange`（statechange.ts:118）带 actor/commandId/field 语义，但**媒体类路径绕开它直接 saveWorld**，且中枢 LLM 直改（brain-chat.ts:1550-1672）**不经锁不经 statechange**——广播设计必须覆盖这两类盲区（§5.5）；
  3. 前端 `world` 是**唯一真相源且服务端权威**，任何推送都必须合并进 `setWorld`/`refreshWorld` 语义，不能另起状态树（§5.2 注意点）。

---

## 2. 现状盘点（扫描统计）

### 2.1 服务端状态真相源与写路径全图

**写锁与落盘机制**：所有 state.json 写路径经 `withTitleLock`（titlelock.ts:10-22，per-title+per-user 串行化）互斥；
`saveWorld`（storage.ts:207-249）原子写 tmp+rename、写前备份 `.bak`、同步写 `meta.json`（storage.ts:242-244）、
`externalizeVersions` 外置章节版本（storage.ts:123-137）、`pruneVersionFiles` 清理孤儿版本（storage.ts:237-240）。
写锁内还有"封面保留保护"（storage.ts:213-221，防无 cover 的内存快照覆盖已生成封面）与读磁盘 merge（storage.ts:216-221）。
**不是所有写路径都持锁**（brain-chat 直改不经锁，见下）。

**持久化文件（账号隔离在 `data/<username>/<slug>/` 下）**

| 状态 | 位置 | 唯一写函数 | 调用方（写点） | 触发时机 |
|---|---|---|---|---|
| WorldState | `state.json` | **`saveWorld`**（storage.ts:207） | director.ts:178/190/277/436/592/707/719/737/767/1080/1105/1144/1231/1269、planner.ts:142/230/297/394、steering.ts:156/169/176、autorun.ts:196、brain-chat.ts:1604/1626/1655/1672、routes.ts:190/245/262/307/322/355/1014/1397/1619/1649/2082/2096/2140/2158/2174/2193/2310/2349/2509/2554/2577、statechange.ts:121 | 用户操作、后台任务、定时器（60s 视觉巡检） |
| 列表页快读 meta | `meta.json` | `saveWorld` 内部（storage.ts:242-244） | 同 saveWorld | 同 saveWorld |
| 章节版本外置 | `versions/chX-N-TS.json` | `externalizeVersions`（storage.ts:123-137） | `saveWorld` 内部触发 | 同 saveWorld |
| 连载暂存区草稿 | `pending-chapter.json` | `savePendingChapter/clearPendingChapter`（storage.ts:320-348） | autorun.ts:146/182、routes 各 pending 入口 | 审查未过 commit 被拒 / 重试成功清空 |
| auto 连载会话 | `autorun-session.json` | `saveAutoSession`（storage.ts:369） | `touchSession`（autorun.ts:63-67）在 autorun.ts:46/106-117/125/140/149/169/202-208/70-78 | 连载各阶段（见 §2.1.1） |
| 中枢聊天会话 | `brain-sessions.json` | `saveSessions`（brain-sessions.ts:97-106） | `mutateSession`（brain-sessions.ts:113-123，persist 参数节流）→ createSession/deleteSession/truncateSession/appendMessage/appendSystemNote/updateMessageText/updateMessageThinking/markSessionCompleted/markMessageDone/markMessageInterrupted/markStreaming | 会话 CRUD 与流式关键节点 |
| 单章推进任务 | `advance-task.json` | advancetask.ts（taskPath:36） | start/updatePhase/complete/fail | 推进任务生命周期 |
| 异步立项任务 | `data/<user>/newstory-tasks.json` | newtask.ts（tasksPath:34） | markReady/stage/complete/fail | 立项后台链 |
| 整书评估报告 | `eval.json` | eval.ts:138/162（evaluateBookCached 原子写缓存） | runAuto 每 N 章（autorun.ts:163-170）/ 手动评估 | 连载定期 / 手动 |
| 断点日志 | `checkpoint.jsonl` | `appendCheckpoint`（storage.ts:252） | 连载每章 commit | 连载 |

**内存态真相源（进程级，重启即丢）**：`activeAuto`（routes.ts:103）、`imageGenTasks: Map<mediaKey, boolean>`（routes.ts:123）、
`visualTasks: Map<tKey, Map<roleId, VisualTaskResult>>`（routes.ts:153，**任务结束不清表**：failed/done 须由 `/api/novel/visual/status` 读取后才删，routes.ts:270-272）、
`visualInFlight`/`coverInFlight`（routes.ts:155-157）、`deletedStories`（routes.ts:106）、`regenBusy`（routes.ts:108）、
`stopFlags`/`pauseFlags`（autorun.ts:38-39，连载停止/暂停意图，**重启丢失**）、
**brain 会话任务注册表 `tasks: Map<user::slug::sessionId, SessionTask>`**（brain-sessions.ts:305）——全项目唯一"广播"设施（§2.3.2）。

#### 2.1.1 连载会话状态机（autorun-session.json 全部写点）

`runAuto`（autorun.ts:86-226）主循环，`touchSession` 合并写 `{...prev, ...patch, updatedAt}`：

| 阶段 | 写点 | 写入字段 |
|---|---|---|
| 开始 | autorun.ts:106-117 | status=running、target、written、phase、startedAt（保留历史）、lastEval |
| 每章 commit | autorun.ts:149 | written+1、phase=`第 N 章已提交` |
| 用户暂停 | autorun.ts:125 | status=paused、phase/pauseReason |
| 重试中 | autorun.ts:140 | phase=`第 N 章重试中…` |
| 定期评估 | autorun.ts:169 | lastEval |
| 审查未过 | autorun.ts:202-208 | status=paused、failedChapter、failedFindings |
| 终态 | autorun.ts:70-78（finish） | status=done/stopped、phase=`连载结束（reason）` |
| 停止意图即时持久化 | autorun.ts:46（stopAuto） | status=stopped（防重启误续跑） |

`onEvent(e: AutoEvent)` 调用点：autorun.ts:144/145（每章 StepEvent 包装 `{auto:true, chapter, written, ...e}`）、
:170（auto-status 评估）、:209（review-failed）。**事件先于/伴随 touchSession 落盘**（如 commit 后 :147-149 先 written++ 再 touchSession，onEvent 在 exec 内部先发）。

#### 2.1.2 statechange 审计层语义

`applyStateChange`（statechange.ts:94-115）：分级（`classifyChange` :63-89，优先 HARNESS commandId 权威 level，否则字段启发式：媒体/封面/角色视觉 → L0，账本/章节 → L2，蓝图/lore → L1）→
确定性预检（`deterministicGuard` :41-59：字段锁 characters[].status/look 禁止 AI 覆盖）→ 写 changeLog（`logCommandChange`）→ 返回 `{ok, applied, level}`。
**注意：默认实现接受「调用方已应用变更」的 w 内存引用，field 仅作日志/分级描述**（:91-93 注释：最小侵入收编既有写点，保证 routes 现有逻辑不改行为）。
`finalizeStateChange`（statechange.ts:118-122）：`alignWorld` + `saveWorld` 统一收尾。
`applyStateChangeAsync`（:126-153）：L2 且 AGNES_BRAIN_GATE=on 时闸门审查，失败降级放行。
**盲区**：媒体类路径（routes.ts:2082/2096 等）绕开 finalizeStateChange 直接 `applyStateChange+saveWorld` 或直接 saveWorld；
brain-chat.ts:1550-1672 中枢 LLM 直改 world **不经锁、不经 statechange、无日志分级**（仅 logChange）——广播若只挂 finalize 会漏这两类变更。

#### 2.1.3 后台异步任务（fire-and-forget）清单——「无消费者」是核心痛点

| 任务 | 触发点 | 写入 | 完成信号 | 客户端感知 |
|---|---|---|---|---|
| 立项段 1/段 2 | routes.ts:804 `void (async…)` | newstory-tasks.json + saveWorld | 任务文件终态 | 轮询 `/api/novel/list` + `/new/status`（3s） |
| 角色视觉生成 | routes.ts:167-276 `ensureCharacterVisuals`（锁内）+ 读时自愈/巡检 | saveWorld 视觉字段 + 内存 visualTasks | **内存表 done**（不清表） | 轮询 `/api/novel/visual/status`（5s） |
| 封面 | routes.ts:281-322 `ensureCover`（锁内） | saveWorld cover/coverTriedAt | **无信号**（coverInFlight 仅去重） | 随下次读 state 生效 |
| 读时自愈 | routes.ts:339-355 `scheduleReadSelfHeal` | applyStateChange+saveWorld | 无信号（响应已返回） | 响应内嵌 |
| 插画批量 | routes.ts:2038 `void (async…)` | 每张锁内 saveWorld ready/failed（2082/2096）+ 内存 imageGenTasks（2100 删） | **内存表删除** | 轮询 `/api/novel/media/status`（5s） |
| 视频 | videos.ts:60/110 createVideoTask + pollVideoTask | state.json media.status + 下载落盘 | **无服务端事件** | 轮询 `/media/status`（routes.ts:2164） |
| 连载后台续跑 | routes.ts:2678 `void runAutoInBackground`（onEvent 空实现 routes.ts:2631-2633） | state.json + autorun-session.json | 落盘 | 轮询 `/auto/status`（3s sysPoll） |

**现有「写状态后通知」机制：没有通用钩子。** 仅有的通知手段：① `appendSystemNote`（brain-sessions.ts:186-199，幂等注入最近会话）——但由**前端**检测到轮询基线变化后主动 POST 触发（Home.tsx:1724-1737 → routes.ts:635-646），服务端不主动推；
② `broadcastToSession`（brain-sessions.ts:339）只服务中枢 chat 会话任务；③ 唯一服务端 setInterval 巡检 `startVisualSweep`（routes.ts:395-404，60s 视觉缺口扫描）。

### 2.2 客户端全局状态与启动数据流

**SSR hydrate 链**：`server/render.ts:13-16` 注入 `<script>window.__INITIAL_DATA__ = …</script>`（`</head>` 前，`<` 转义 `\u003c`）→
`server/dev.ts:126-138` / `server/prod.ts:67-80` 构造 initialData（serverTime/ssr、`?chapter=`→initialData.chapter、
`userFromRequest(req)` 读 httpOnly cookie → initialData.user、`runAsUser` 账号隔离加载 `?title=`→initialData.world/propClosed）→
`server/entry-server.tsx` `renderToString` → `src/entry-client.tsx:16-22` hydrateRoot。
**未登录不注入 world**（账号隔离），Home 渲染 AuthPage（Home.tsx:2288-2290）。

**Home.tsx 消费 initialData**：phase=world?"playing":"landing"（:128）、user（:130）、world（:131）、
activeIdx=resolveInitialChapter(w, chapter??localStorage 上次选中>第一章)（:136-140）、proposalClosed（:160）、
restoringTasks 初始 Boolean(initialData.world)（:258，SSR 首帧即置恢复锁）。

**全局 state（58 个 useState，均组件内，无 context/全局 store）**：核心为 `world`（:131，唯一真相源，整包替换）、
`phase`/`user`（:128/:130）、`busy`/`busyPhase`（:132/:133，运行锁）、`activeIdx`（:136）、
`autoRunning`（:235，**本页 SSE 直连标志非服务端权威**）、`autoSession`/`autoPending`（:239/:240）、
`advancePhase`（:247，轮询 /api/brain/context 同步）、`sysTick`（:249，系统事件注入信号）、
`restoringTasks`/`taskActive`（:258/:259，进入 playing 的恢复运行锁，三路查询后释放，15s 兜底 :282）、
`stories`/`creating`（:230/:310）、`currentTaskId`/`buildingStage`（:152/:153）、`brainState`（:1262-1270，前端 useMemo 派生）、
`mediaGen`/`mediaPlan`/`visualGen`/`portraitView`/`integrityView`/`deletePreview`/`pendingCommitIdx` 等 UI 局部态。

**关键 useEffect**：任务恢复协调（:270-302，三路查询 restoreAdvanceTask+fetchAutoStatus+novel/list，代次 ref 防旧回调误释放）；
creating→newTaskPoll（:559-562）；currentTaskId→buildPoll（:612-615）；world 含 pending 媒体→mediaPoll（:1290-1300）；
world→visual/status 探测续接（:1417-1432）；打开小说→startSysPoll（:1834-1845，`prevSysRef` 基线重置防串书）；
卸载清理全部轮询（:563/:616/:658/:1287/:1831）。

**更新入口函数**：`refreshWorld()`（:629-641，POST /api/novel/state 整包替换，visualPending 时启动视觉轮询）、
`refreshAllStates()`（:646-648，world+系统状态并行）、`pollSysStateOnce()`（:1755-1816，快照+变化检测，任一来源失败跳过判定 :1772）、
`fetchAutoStatus()`（:1708-1720）、`fetchStories()`（:311-318）、`saveWorld(patch)`（:959-991，写后 setWorld+needIntervention 弹窗+visualPending 轮询）、
`openStory()`（:377-408）、`injectSystemNote()`（:1724-1737，成功后 sysTick+1 通知聊天舱）。

### 2.3 同步手段现状（四类）

#### 2.3.1 请求-响应全量刷新（主路径）

所有手动编辑类 API（章节编辑/设定/伏笔 CRUD/蓝图/lore/intervene/lock 等）响应直接带 `sanitize(world)`，前端就地 `setWorld`；
聊天卡片执行后走 `onWorldUpdate → refreshAllStates`（Home.tsx:2685）。**任何写指令的结果等价于全 UI 刷新**（COUPLING.md:22）。

#### 2.3.2 SSE 长连接（仅"客户端先发起"的请求内流，不跨请求推送）

基座 `sseStream`（routes.ts:52-90）：`ReadableStream` + `data: <JSON>\n\n`，**8s 心跳 ping**（routes.ts:65），
配 `Bun.serve idleTimeout: 255`（dev.ts:99 / prod.ts:40）；客户端断开吞 enqueue 异常保证服务端回合完整落盘（routes.ts:57-62）。

| 端点 | 位置 | 用途 | 备注 |
|---|---|---|---|
| `POST /api/novel/step` | routes.ts:928-964 | 单章推进（写+审+修+记账） | 事件：writing/delta/reviewing/patching/settling/saving/done/interrupted |
| `POST /api/brain/chat` | routes.ts:724-776 | 中枢对话 | **会话级广播**（见下） |
| `POST /api/novel/auto/start` | routes.ts:1586-1657 | 连载全程（每章 5-15 分钟） | 事件带 `{auto:true,...}`，结束 `{phase:"auto-done",report}` |
| `POST /api/chat/stream` | routes.ts:525-550 | 简单流式对话 | **无心跳** |

**会话级任务注册表（全项目唯一的"广播"先例，WebSocket 频道的直接蓝本）**——`brain-sessions.ts:295-368`：

```ts
type SessionTask = {
  running: boolean;
  emitters: Set<(obj: unknown) => void>;   // 当前附加的 SSE 连接 emitter
  abort: AbortController;                    // 任务自身 abort（req.signal 取消时同步）
};
const tasks = new Map<string, SessionTask>(); // key: `${user}::${slug}::${sessionId}`
```

- `attachSessionTask`（:314-319）：已有 running 任务则注册 emitter，返回任务（新连接续收）；
- `registerSessionTask`（:322-336）：创建/复用任务 + 注册 emitter + 绑定 req.signal abort；
- `broadcastToSession`（:339-349）：向所有 emitter 广播（吞 enqueue 异常）；
- `detachSessionTask`（:352-358）：移除 emitter，空集删表（内存泄漏防护）；
- `finishSessionTask`（:361-368）：running=false + 清空 + 删表；
- 配套消息定位工具：`lastIncompleteMessage`/`lastPendingMessage`/`lastUserMessage`（:272-293，resume 重放目标）。

断线重连协议（routes.ts:735-764 + useBrainSession.ts:310-343）：断连不杀任务 → attach-only 重试（≤2 次，间隔递增）→
`{type:"reset",text}` 重放已生成文本 → 续收 delta；attach 0 事件 EOF 回显错误；测试覆盖 `tests/brain-reconnect.test.tsx`。
**但该注册表只服务 brain 对话本身，不广播其它后台任务状态。**

#### 2.3.3 前端轮询清单（核心问题区）

| # | 轮询 | ref | 端点 | 间隔 | 启动条件 | 收尾动作 |
|---|---|---|---|---|---|---|
| 1 | newTaskPoll | Home.tsx:512-563 | GET `/api/novel/list` | 3s（:553） | `creating.length>0`（:559-562） | 自己任务 ready→`openStory`（:529）；不在列表→查终态（:535）；列表空停（:548） |
| 2 | buildPoll | Home.tsx:566-616 | POST `/api/novel/new/status` | 3s（:606） | `currentTaskId` 非空（:612-615） | done/failed→`refreshWorld()`（:592/:599）；404 清构建态（:577-582） |
| 3 | advanceRestoreTimer | Home.tsx:654-749 | POST `/api/novel/step/status` | 5s（:745） | 刷新后恢复检测到 running（:722） | 终态→`finishRestoreAdvance`→`refreshWorld`（:678/:682） |
| 4 | mediaTimer | Home.tsx:1283-1373 | POST `/api/novel/media/status`（逐 mediaId） | 5s（:1333） | 确认/重生成媒体（:1325）或 world 含 pending 媒体恢复（:1290-1300） | 全部 ready/failed→`refreshWorld()`+toast（:1354-1364） |
| 5 | visualTimer | Home.tsx:1250/1378-1432 | POST `/api/novel/visual/status` | 5s（:1381） | `visualPending`（refreshWorld 返回，:640）或刷新恢复检测（:1417-1432） | pending 空→`refreshWorld()`+中枢恢复待命（:1395-1398） |
| 6 | **sysPoll（统一系统轮询）** | Home.tsx:1818-1845 | POST `/api/brain/context` + GET `/api/novel/auto/status` | **3s 常驻**（:1821） | 打开小说（:1834-1845） | 变化检测（新章/连载转移/推进结束）→`refreshWorld`+`injectSystemNote`（§2.3.4） |
| 7 | BrainCabin pollMediaGen | BrainCabin.tsx:1274-1296 | POST `/api/novel/media/status` | 3s（:1275） | 聊天舱内发起媒体生成 | 收尾→`refreshWorld` + 结果卡 |

另有**服务端内部轮询**：`visualSweepTimer`（routes.ts:392-406，60s 冷却角色视觉巡检）、
`pollVideoTask`（videos.ts:110，远程视频任务轮询）。

#### 2.3.4 客户端缓存 + 系统事件注入链（轮询的补偿设计）

- **indexeddb 缓存** `brainCache.ts`：中枢会话消息缓存，「服务端始终权威，缓存只做秒开/离线回看」（brainCache.ts:1-6）；
  打开会话先缓存 → 拉 detail 覆盖 → 写回（useBrainSession.ts:396-418）。
- **统一轮询 → 聊天注入链**：`pollSysStateOnce`（3s）检测到状态转移 →
  `injectSystemNote(eventId, text)`（Home.tsx:1724-1737）→ `POST /api/brain/sessions/system-note`（routes.ts:635-646，服务端按 eventId 幂等去重）→
  注入成功 `sysTick+1` → BrainCabin `reloadActive(force=true)` 强制重拉会话（useBrainSession.ts:433-437）。
  即：**后台任务完成是靠"前端轮询发现 → 前端主动写聊天会话"回环的**，链路长、延迟 3s 起步、且注入依赖轮询在跑。

#### 2.3.5 中枢聊天记录中的「状态变更」同步现状（两条通道，覆盖不对称）

**通道 A —— 系统事件注入（有，但只覆盖服务端状态转移，且由前端轮询触发）**

`injectSystemNote` **全库仅 1 个调用点**（Home.tsx:1813，即 `pollSysStateOnce` 变化检测循环），
覆盖且仅覆盖 4 类「服务端状态转移」：

| 转移 | 判定（Home.tsx） | 注入文案 | eventId |
|---|---|---|---|
| 连载新章提交 | :1786 `now.written > prev.written` | `自动连载已提交第 N 章（phase）` | `auto-ch${written}` |
| 连载 running→终态 | :1791 `prev.autoRunning && !now.autoRunning` | `自动连载已暂停/已结束：…` | `auto-paused-${updatedAt}` / `auto-ended-${updatedAt}` |
| 连载 idle→running | :1803 `!prev.autoRunning && now.autoRunning` | `自动连载已开始：…` | `auto-started-${startedAt}` |
| 推进任务结束 | :1808 `prev.advanceRunning && !now.advanceRunning` | `推进任务已完成，正文已更新` | `advance-ended-${startedAt}` |

服务端侧 `appendSystemNote`（brain-sessions.ts:186-199）：按 `session.systemNotes[]`（上限 200）幂等去重，
把 `【系统】${text}` 以 `kind="system"` 消息追加到**最近更新的会话**（无会话则跳过不补录）；
该消息进入会话历史 → 意图识别 `hist.slice(-6)`（brain-chat.ts:1399-1400）自动携带，中枢 AI 感知系统动态。

**通道 B —— 回复时动态加载世界（AI 感知，总是新鲜，但不产生聊天记录）**

`streamChatReply`（brain-chat.ts:785-809）：每次中枢回复 `brainChatDeps.loadWorld(title)` **实时读 state.json**
（注释「动态读取，避免过期」）生成世界摘要，再用前端透传的 `ctx`（chatCtx）补选中章/系统状态（:797-805）。
意图识别 `recognizeIntent`（:263-266）同样用 `ctx + history`。→ **AI 回复时总能看到最新 world，不依赖注入。**

**缺口（用户手动交互不注入聊天记录）**

- grep 确认：`injectSystemNote` 只有 :1813 一处调用；**用户手动操作**（设置保存 `saveWorld`、抽卡 `onApplied`、
  伏笔/关系编辑 `onWorldUpdate`、删章、切章 `LeftPanel onSelectChapter` 等）全部只 `setWorld(data.world)` 刷 UI，
  **不写聊天记录**——聊天历史与 AI 上下文里没有这些交互痕迹；
- `serverCtx`（BrainCabin 打开时 `/api/brain/context` 快照，:358-374）只在打开面板时拉一次，外部更新后不刷新
  （`reloadActive` 只重拉会话详情，不重拉 serverCtx）；
- 跨 tab / 其他入口（列表页/三栏直接操作）的变更对聊天同样不可见，只能等下次回复时 AI 从动态 world 感知；
- 通道 A 的注入**依赖 sysPoll 在跑**：本页 SSE 直连连载时 `stopSysPoll`（Home.tsx:1859），期间后台任务完成不注入；
  注入延迟 3s+（轮询粒度）；服务端不主动推，全靠前端发现后 POST。

**改进方向**：① 交互统一打点——所有写操作（用户 + 卡片 + 后台）收敛到一处 `publish("brain-note", eventId, text)`，
覆盖「用户手动交互也进聊天记录」；② 用 WS 推送 `brain-note`（§5.3）替代「前端轮询发现 → 主动 POST」回环，
消除 3s 延迟与 sysPoll 停摆窗口；③ serverCtx 改为随 `world-changed` 事件刷新而非仅打开时拉取。

#### 2.3.6 聊天记录内卡片的就地更新（**现状：一次性快照，无就地更新能力**）

用户交互后/外部更新后，**已存在于聊天记录中的卡片**应就地更新其状态（如任务进度卡 running→done、浏览卡数据刷新），
而不是追加新消息。现状确认（grep 全库证据）：

| 能力 | 现状 | 证据 |
|---|---|---|
| 卡片稳定 id | **无**：`BrainChatCard = Record<string, unknown>`（brain-sessions.ts:19）透传任意字段，但全库无产出 `cardId` 的地方；卡片只能靠「消息内下标」定位（前端 `completed` key = `msgId:cardIdx[:itemId]`，BrainCabin.tsx:584） | brain-sessions.ts:19；brain-cards.tsx:143 |
| 服务端更新卡片接口 | **无**：brain-sessions.ts 只有 `updateMessageText`/`updateMessageThinking`（:202-225），**无 updateMessageCards**；`markMessageDone` 附 cards（:241-250）是一次性写入 | brain-sessions.ts:202-250 |
| 前端卡片到达 | **只追加**：SSE `onCard` → `cards: [...(m.cards ?? []), card]`（useBrainSession.ts:233），无按 id 替换；`{type:"card", messageId, card}` 事件（brain-chat.ts:1426-1837）不携带 cardId | useBrainSession.ts:228-236 |
| 回合结束后更新通道 | **无**：SSE 只在流式回合内有效；`reloadActive(force)` 重拉 detail（useBrainSession.ts:433-437）但**服务端存的 cards 就是旧快照**，重拉也更新不了卡片内容 | useBrainSession.ts:433-437 |
| 写作进度卡 | **是前端瞬态不是消息卡片**：`ProgressCard` 由 BrainCabin 独立的 `writing` state 渲染（BrainCabin.tsx:861-864），SSE 结束 2.5s 后 `setWriting(null)` 消失（:1210），**不进会话历史、刷新不恢复、多 tab 不可见** | BrainCabin.tsx:400/:861-864/:1210 |
| 卡片内容更新 | **仅 completed 标记**（前端本地 Set，服务端持久化 key），只把按钮换成「已执行/已处理」，不更新卡片内容本身 | useBrainSession.ts:522-538；brain-cards.tsx:163-215 |

**结论**：聊天记录里的卡片是「一次性快照」——产出即定格；系统状态变化后没有通道把它们就地更新。
`browse` 卡的 `data` 是读取时快照（如 tasks/media 列表），任务推进后卡片内容过期；`preview`/`form` 卡执行后只有「已完成」角标，卡面内容不变。
这正是「聊天记录中已有组件未与全局状态更迭保持一致」的技术根因。

**方案（补进 §5）**：① **卡片稳定标识**——服务端产卡统一带 `cardId`（uuid），`BrainCard` 类型加 `cardId?: string`（向后兼容），
前端按 cardId 定位；② **服务端接口** `updateMessageCard(title, sessionId, messageId, cardId, patch)`（brain-sessions.ts 新增，persist）——
系统事件处理器就地更新已落盘卡片的字段；③ **WS 事件** `{type:"card-update", sessionId, messageId, cardId, patch}`（§5.3 新增）推给订阅该书的所有连接，
前端就地 `setMessages` 替换该卡（多 tab 一致，无需 reloadActive）；④ **progress 卡升级（可选）**：把聊天内写作进度卡从「前端瞬态」改为「服务端消息卡片」（带 cardId），
刷新/多 tab 看到同一张进度卡，SSE 回合结束由系统事件就地更新到 done/failed——正是本需求的典型场景；⑤ **事件→卡片关联表**（§5.3）：
task-status/build/advance/media → 更新对应 progress/browse 卡；auto-chapter → 更新连载卡 written。

#### 2.3.7 通读 brain-chat.ts 的补充结论（卡片产出全清单 + 边界修正）

本轮通读 `brain-chat.ts` 全文（1-1852 行）后，对 §2.3.6 的修正与补充：

**① 卡片产出完整清单（服务端持久化的卡片类型）**

| 意图分支 | 卡片 | 位置 | 是否快照 |
|---|---|---|---|
| L0 查询（read_* 15 类） | browse / result | executeQuery（:432-690） | **读取时快照**（data 定格） |
| 写操作（有 action） | preview + confirm（L2/L3 才加） | :1813-1838 | 一次性 |
| 角色写操作（relationship/create/edit/delete） | result / ask | :1531-1686 | 一次性 |
| 表单类（edit_world/foreshadow/task_ops/draft_confirm/expand_arc/settings） | form / ask | :1500-1526 | 一次性 |
| 媒体 | form（media/plan） | buildMediaCard（:1189-1236） | 一次性（生成进度靠前端 pollMediaGen 轮询，**无服务端进度卡**） |
| plan / opinion | plan / opinion 选项卡 | :1412-1429 | 一次性 |
| gacha | browse（gacha） | gachaBrowseCard（:332-355） | 快照 |
| open_* | result（带 open） | :1700-1731 | 一次性 |
| busy 冲突拒绝 | result（fail） | :1447/:1541/:1801 | 一次性 |
| 纯对话 / chat | 无卡 | :1404-1409 | — |

**确认：服务端从不产出 `kind:"progress"` 卡**——`ProgressCard` 纯前端瞬态（BrainCabin.tsx:861-864，writing state），
聊天记录里真正可"就地更新"的候选只有 **browse 快照卡**（tasks/media/chapters/characters/plans/outline/timeline/proposals 等）。

**② P20 修正（attach 重放不重放卡片——断线重连的瞬时卡片丢失）**

`/api/brain/chat` attach 重放逻辑（routes.ts:750-763）：`{type:"reset", messageId, text, thinking}` **不带卡片**，
等任务结束补发 done/interrupted。前端 `onReset`（useBrainSession.ts:240-243）**清空 `cards: []`**。
→ 回合进行中断线重连时：已广播的卡片（如 preview/confirm）在重连后前端丢失、服务端落盘仍在（attach 不重放卡）——
**前端与刷新后服务端瞬时不一致**（刷新拉 detail 才恢复）。这不是持久不一致（服务端始终权威），但加重了"聊天记录组件与全局状态脱节"的观感。

**③ 跨消息卡片去重对 card-update 的约束**

brain-chat.ts:1770-1783：同会话最近 3 条 assistant 消息含**整卡 JSON 相同**时不再重发卡。
→ card-update 就地更新会改变卡片 JSON，天然绕过去重；但若只 patch 少量字段（如 status），title/summary 未变，
与「整卡 JSON 比较」逻辑兼容（JSON 变了即视为新卡）。**注意：card-update 方案不能让卡片 JSON 回到与旧卡完全相同的值，否则可能被 dupCard 误判为重复**（设计上 eventId/版本号需使 JSON 必然不同）。

**④ 写操作不经锁的竞态实证（P13 加强）**

角色写操作（relationship/create/edit/delete，brain-chat.ts:1531-1686）：`loadWorld → 改 → saveWorld`（:1550-1674）
只做**前置冲突检测**（:1532-1549，读前端 ctx + serverCtx 快照），**不持 `withTitleLock`**——
检测通过到写盘之间的窗口内连载/推进可能已开始写章，load-modify-save 会基于旧快照覆盖新章。
这是广播设计（§5.5 A 级挂 saveWorld）必须覆盖的高危路径：即使不做锁改造，**至少应在 saveWorld 后广播 world-changed**，
让前端尽快感知并重拉（弱一致性补偿）。

### 2.4 UI 区域 × 数据来源/刷新方式矩阵

| 区域 | 组件 | 数据来源 | 刷新方式 |
|---|---|---|---|
| **中枢聊天（对话舱）** | BrainCabin.tsx | `useBrainSession`（会话列表/消息）+ `serverCtx` 打开时 `/api/brain/context` 快照（BrainCabin.tsx:358-374） | 会话内 SSE 流式 + attach 重连；`sysTick` 强制重拉；卡片执行后 `onWorldUpdate→refreshAllStates`（:2685）；打字机 24ms tick 纯 UI |
| **中枢指示器（报头印灵）** | Masthead.tsx / BrainCore.tsx | `brainState` = `deriveBrainState(world, runtime)` 前端派生（Home.tsx:1262-1270，api/brain-state.ts:366） | 随 `world`/`autoSession`/`visualGen`/`buildingStage` 变化自动重算；`brainBusy` 口径见 Home.tsx:1253 |
| **列表页（landing）** | Home.tsx | `stories`/`creating`（`/api/novel/list`） | `fetchStories`（登录/返回/删除后）+ **newTaskPoll 3s** |
| **左栏（目录）** | LeftPanel.tsx | `world.chapters` props | 父级 `world` 整包替换 |
| **中栏（正文）** | ChapterView.tsx | `world` props | 父级 `world` 整包替换 |
| **右栏（状态面板）** | StatusPanel.tsx / PlanPanel.tsx / ReviewPanel.tsx | `world` + `review` props | 父级 state 驱动 |
| **连载控制台** | AutoRunPanel.tsx / TaskCenterModal.tsx | `autoSession`/`autoPending` props（fetchAutoStatus）+ `autoRunning` 本页 SSE 标志 | 本页 SSE 事件 + **sysPoll 3s** 校正 |
| **设置弹窗** | SettingsModal.tsx | `world` props；保存走 `onSave→saveWorld`；删章直接 apiFetch（SettingsModal.tsx:392/413）→`onWorldUpdate` | 打开时 Home 已 `refreshWorld`（Home.tsx:2436） |
| **抽卡弹窗** | GachaModal.tsx | 挂载时 `POST /api/novel/gacha`（:38/:87） | 打开挂载拉取一次 |
| **评估弹窗** | EvalModal.tsx | 挂载时 `Promise.all`(eval, debt)（:29-48） | 打开挂载一次；债务操作后本地 setDebt |
| **伏笔/记忆审计弹窗** | ForeshadowModal.tsx / MemoryAuditModal.tsx | 挂载时各自 API（ForeshadowModal.tsx:41、MemoryAuditModal.tsx:40） | 打开挂载一次 |
| **立绘弹窗** | PortraitModal.tsx | `world.characters.find`（:3051） | 生成后 `refreshWorld`（Home.tsx:1314） |
| **一致性巡检/删章预览** | IntegrityModal.tsx | `report` props（`setIntegrityView`/`setDeletePreview` 一次性驱动） | 事件驱动 |
| **干预弹窗** | InterveneModal.tsx | `report`/`changeDesc`（saveWorld 返回 `needIntervention` 时，Home.tsx:969-973） | 事件驱动 |
| **人物关系弹窗** | RelationshipModal.tsx | `world.characters` props | `world` 变化实时同步（useEffect 重建 Canvas） |

**要点**：三栏/大部分弹窗是 `world` 的 props 投影，**它们的一致 = `world` 的一致**；而 `world` 的更新要么靠写操作响应、要么靠轮询发现异步任务。中枢聊天/连载控制台是少数有独立通道的区域。

### 2.5 数据模型全图（与状态同步直接相关）

**WorldState**（world.ts:367-406）：title/author/genre/premise/setting/characters/foreshadowing/timeline/chapters/cards/outline/
gen/chapterGen/lore/plotThreads/cover/coverTriedAt/current/nextChapter/updatedAt/pendingCards + 长篇架构字段
（blueprint/blueprintOptions/storyArcs/chapterPlans/chapterSummaries/chapterDeltas/qualityDebt/characterProposals/lockedFields/
changeLog/rewriteQueue/goal，全可选兼容旧存档）。

**与异步任务状态直接相关的字段**（**需要前端轮询才能发现变化的字段**）：

| 字段 | 位置 | 轮询机制 |
|---|---|---|
| `ChapterMedia.status` = `"pending"\|"ready"\|"failed"` | world.ts:147-162（含 videoId/error/path） | `/api/novel/media/status`（routes.ts:2113-2200）；ready 直接返回，429 容忍；超 30 分钟自动 failed |
| `Character.portrait`/`image`/`visualTriedAt` | world.ts:22-27 | `visualPending` 非空→`startVisualPolling`→`/api/novel/visual/status`（routes.ts:2205-2229，返回 `{pending, failed, done, count}`） |
| `coverTriedAt` | world.ts:385 | 读时自愈触发 ensureCover，无独立轮询（随下次打开生效） |

**API 响应级同步信号（不在 state.json，服务端派生）**：`visualPending: boolean`（routes.ts:885/1411/1545，读时自愈/删章/入册后）→ Home.tsx:636-640 据此启动视觉轮询。

**`/api/brain/context` 响应结构**（routes.ts:706-722）：`{ autoRunning, autoPhase, pendingCommit: {index,title}|null, advanceTaskRunning, advancePhase, advanceStartedAt, mediaGenerating, visualRunning, pendingProposals, pendingCards, openDebt, reviseChapters }`——服务端权威聚合快照，前端 Home/BrainCabin 共用（§2.2/§2.4）。

**`/api/brain/state` 响应**（routes.ts:660-678）：`deriveBrainState(bw, {busy, phase, autoRunning, evalReport, integrityReport})` → presence/activity/governance/vitals 四维（brain-state.ts:108-114）。

**AutoSession**（storage.ts 定义）：`{ status: running|paused|stopped|done, target, written, phase, pauseReason?, failedChapter?, failedFindings?, lastEval?, startedAt, updatedAt }`。

**BrainSession**（brain-sessions.ts:40-53）：`{ id, title, createdAt, updatedAt, messages: BrainChatMsg[], streaming, completed?: string[], systemNotes?: string[] }`；
BrainChatMsg（:21-38）：`{ id, role: user|assistant, text, thinking?, cards?, at, pending?, interrupted?, kind?: "system" }`；
SessionMeta = routes.ts 内联构造的列表项（title/时间/streaming/messageCount，非独立命名类型）。
卡片 `BrainCard`：kind 含 query/browse/confirm/preview/plan/opinion/ask/form/result 等，`action.endpoint` 是卡片执行入口
（BrainCabin executeCard :1107-1263），写操作执行前有系统状态冲突前置检测（brain-chat.ts:1787-1809：autoRunning/writingRunning/advanceTaskRunning/mediaGenerating 任一为真拒绝写操作防双跑）。

**推进/立项任务**：advance-task.json `{ status: running|done|failed, phase, startedAt, … }`；newstory-tasks.json `{ id, idea, genre, status: running|ready|done|failed, title?, stage?, error? }`。

### 2.6 前端全局事件机制（现状无"实时通道"）

1. **模块级订阅（唯一跨组件广播）**：`onAuthChange`（client.ts:26-34，`Set<AuthChangeListener>`，注册返回 unsubscribe），
   唯一订阅方 Home（:353-363）：apiFetch 401 → clearToken → notifyAuthChange → Home 清 user/world/phase 回 landing。
2. **props 穿透回调（主要机制）**：Home→BrainCabin 2680-2698（onWorldUpdate/onProposalTalk/onOpenPanel/currentChapter/autoRunning/buildingStage/sysTick）；
   Home→各 Modal（SettingsModal onSave 2790、ForeshadowModal onWorldUpdate 2725、GachaModal onApplied 2729、EvalModal onWorldUpdate 2822、TaskCenterModal 2703-2720、RelationshipModal onSaveRelations/onAddCharacter 2809-2810、InterveneModal onChoose 2833）。
3. **sysTick 数字信号**：Home:249 → injectSystemNote 成功自增（:1734）→ BrainCabin effect（:550-552）重拉会话——用数字 state 模拟"跨组件事件"。
4. **URL 路由状态**：`setStoryUrl`（:366-374，replaceState 同步 `?title=&chapter=`）、`readUrlChapter`（:80-85）。
5. **window/document 原生事件**：Home keydown/mousedown/scroll（:2230-2270）、AuthPage resize/mousemove、BrainCabin pointermove/up（:1017-1018）。
6. **客户端持久化（跨刷新恢复，非事件）**：localStorage `ms_token`/`fp_reading_prefs`（:99）/`fp_cabin_prefs`（BrainCabin:69）/`bc.thinking`（:380）；
   sessionStorage `brain-ask-answered-{activeId}`（BrainCabin:603-604）；indexedDB `fp-brain-cache`（brainCache.ts:9）。
7. **零命中确认**：`createContext`/`useSyncExternalStore`/`EventSource`/`new WebSocket` 全库 grep 零命中。

**对 `useSyncChannel` 设计的关键约束**：(a) `world` 是唯一真相源且服务端权威，任何推送应合并进 `setWorld`/`refreshWorld` 语义；
(b) 运行锁 `taskActive`（Home.tsx:259）是全局写保护的唯一闸门，推送触发的刷新不得绕过它造成 UI 状态与锁不一致；
(c) BrainCabin 的 `completed` 持久化 key 体系（`msgId:cardIdx[:itemId]`）与 pollMediaGen 是本地闭环；
(d) 401 广播已能驱动全局回登录页，channel 层需与 `onAuthChange` 共存（WS 断线/401 时关闭连接）。

### 2.7 测试基建与 mock 模式（WebSocket 测试蓝本）

- 框架 **bun:test** + **happy-dom**（无 jsdom），无全局 setup（无 bunfig.toml）；bun test 默认同进程并发跑文件 → 全局替换（fetch/window/env）**必须在文件内恢复**（tests/log-panel.test.ts:28 注释）。
- **SSE/fetch mock 模式**（tests/use-brain-session.test.tsx:33-113）：beforeAll 整体替换 `globalThis.fetch` 为按 URL 分发的 async 函数，afterAll 恢复。SSE 流 mock 三种写法：
  A. 一次性逐条发射后 close（brain-reconnect.test.tsx:74-82）；
  B. 手动释放（capture controller，测试控制断线/续发，use-brain-session.test.tsx:95-105）；
  C. 预置事件队列参数化（use-brain-session.test.tsx:83-92）。
  模拟断线：`c.error(new Error("network disconnected"))`；`readSSE` 收集工具（brain-e2e.test.ts:98）。
- **React 渲染**：happy-dom Window + `createRoot` + `act` + 挂载 window/document/global 到全局（`__harness` 模式）；`tick/sleep` 辅助（brain-reconnect.test.tsx:92-93）。
- **服务端路由级测试**：直接调用 `handleApi(pathname, req)`（构造 Request），如 brain-e2e.test.ts；依赖注入用 `brainChatDeps` 对象替换（brain-chat.test.ts:1-3，**不用 mock.module 防跨文件污染**）。
- **LLM mock**：tests/mocks.ts `installMockAgnes(responder)` + `routeByKeyword`，`mock.module` 须在 import 任何 src/api 模块之前（:2-3）。
- **WebSocket 现状**：零实现零测试。测试可用环境：bun:test 运行在 Bun 运行时 `WebSocket` 全局可用（服务端集成测试可直接连真实 Bun.serve 的 websocket 端口）；happy-dom Window 不提供 WebSocket → 客户端 hook 级测试需像 mock fetch 一样挂 `globalThis.WebSocket` 假实现（暴露 close/error 触发、onmessage 注入）。

- **心跳健康检测（HA1）**：服务端 60s 无消息断开僵尸连接（30s 扫描），前端 30s 周期 ping 保活——断网/挂起连接及时释放，快速切换为重连路径。
- **重连全量补偿（HA2）**：WS 断线指数退避重连，`onReconnected` → `refreshAllStates()` 全量补偿（不只 world，含连载/任务/聊天状态）。
- **进度卡服务端兜底翻转（HA3）**：推进任务完成/失败时服务端主动翻转最近 running progress 卡（`finalizeProgressForTask` + card-update 广播）——刷新/SSE 断开后任务由轮询感知完成，卡片仍能翻转到终态（不永久 running）。

#### 2.7.1 测试全绿基线（本轮修复 + 补充）

**历史问题**：此前有 2 个固定失败测试——`tests/brain-cards.test.ts:265`（form 卡提交携带填写值）与
`tests/tmp-form-debug.test.ts`（ESM vs CJS 对比调试）。根因：**happy-dom 20.11.1 下 React 19 的 `input` 合成事件不触发**
（实测：React 在 mount 上注册了 input 监听、dispatch 后 listener 被调用且不抛错，但 `onChange` 永不触发；
`MouseEvent` 合成事件正常）。用原生 setter + `_valueTracker` 失步均无法修复——是环境层限制，非测试逻辑错误。

**修复策略（测试设计改进）**：
1. 删除 `tests/tmp-form-debug.test.ts`（临时调试遗留，注释自述「临时调试」，无引用）；
2. `tests/brain-cards.test.ts` 改造失败测试：受控表单的「键入后提交新值」改为「渲染初始值（text/textarea/select 三类 DOM value 断言）+ 提交携带受控初始值」——
   值变换核心逻辑由 `flattenFormValues` 纯函数单测覆盖（点路径扁平化 / textarea 数组拆分 / number 转换 / bool 转换 / 空串跳过）；
3. 顺带修复 `isAmbiguousChapterPrompt` 动作词表缺陷（缺「生成/配图/插图/画」，导致「给第二章生成插画」被误判为含糊章节追问）。

**本轮新增测试（按 STATUS_SYNC 关键机制补缺）**：

| 文件 | 新增 | 覆盖 |
|---|---|---|
| tests/brain-sessions.test.ts | +6 | `appendSystemNote` 注入最近会话（kind=system/进历史/非目标不注入）、同 eventId 幂等、无会话 false、systemNotes 上限 200；`markSessionCompleted` 幂等；`lastIncompleteMessage`（pending+interrupted）vs `lastPendingMessage`（仅 pending）；detach 后连接失联广播 |
| tests/brain-chat.test.ts | +10 | `isHollowReply`（空话短句/>30 字不算）；`l0QueryReply`（read_chapter 模板、read_character 按问法侧重、LLM 实质回复优先/空话回退卡标题）；`isAmbiguousChapterPrompt`（纯章节号/带动作词/无章节）；`chapterAskCard`（4 选项、revise 加审查、index 非法 null） |
| tests/brain-e2e.test.ts | +2 | system-note 路由：注入成功 injected:true、重复 eventId injected:false、detail 可见 system 消息、缺参数 400、无会话不崩 |
| tests/brain-cards.test.ts | +1（改造 1） | `flattenFormValues` 纯函数；form 卡受控初始值渲染与提交 |

**基线**：`bun test` → **517 pass / 0 fail**（48 文件，3236 expect() calls，~15s）。
**测试环境限制（如实记录）**：happy-dom 无法触发 React 受控 `input` 的合成 onChange——依赖键入的交互测试需走
「纯函数（值变换）+ 组件受控渲染断言 + 提交回调断言」三层拆分；WS 集成测试须用 Bun 运行时真实 WebSocket（§2.7）。

---

## 3. 已知问题清单（可验证，附证据）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1 | **轮询延迟窗口**：3s（sysPoll/newTask/build）/5s（media/visual/advance）粒度，间隔内 `world` 过期；多轮询叠加下最坏 ~5s 才感知一次后台任务完成 | Home.tsx:1821/:553/:606/:745/:1333/:1381 | 新章/新媒体/任务完成不能即时呈现 |
| P2 | **多标签页/多入口无同步**：无 BroadcastChannel/WebSocket/storage 事件；双 tab 各自轮询，仅靠服务端 409 冲突与 buildPoll 404 兜底（注释自述「双 tab 删书场景」） | Home.tsx:576-582；startAutoRun 409（:1868） | 双 tab 状态互相覆盖/不一致；聊天注入可能重复或错书 |
| P3 | **SSE 与轮询混用**：本页 `startAutoRun` 暂停 sysPoll（:1859）、SSE 收尾才重启（:1926）；SSE 静默挂起但未抛错时进度冻结到 finally；SSE 中断 toast 仅提示「可能仍在服务端继续」（:1916） | Home.tsx:1859/:1916/:1926 | 连载进度展示可能冻结/误报 |
| P4 | **done 事件丢失需兜底**：流正常结束但最后消息仍 pending → 查 `/api/brain/sessions/detail` 覆盖（useBrainSession.ts:349-360）；断线 attach 最多 2 次、0 事件 EOF 回显错误（:310-343） | useBrainSession.ts:349-360/:310-343 | 中枢聊天「AI 已回复但一直 loading」已修复，但兜底逻辑复杂、依赖额外请求 |
| P5 | **brainCache 陈旧**：缓存只在 `openSession` 时刷新，`sysTick→reloadActive(force)` 是唯一强制覆盖路径；其他入口改会话后本地缓存过期 | useBrainSession.ts:396-418/:433-437；brainCache.ts:1-6 | 回看消息可能与服务端不一致 |
| P6 | **brainState 双源**：Home 的 `brainState`（前端 useMemo 派生）与 BrainCabin 的 `serverCtx`（打开时 `/api/brain/context` 快照）口径不一；BrainCabin 用 `liveActivity/livePresence` 前端即时覆盖弥补延迟（:562-572） | Home.tsx:1262-1270；BrainCabin.tsx:358-374 | 指示器与聊天舱对「中枢在做什么」可能给出不同结论 |
| P7 | **autoRunning 双轨语义**：Home `autoRunning`（本页 SSE 标志）≠ `autoSession?.status`（服务端权威）；`brainBusy` 用 `autoSession.status==="running"`（:1253）而 TaskCenterModal 暂停可用性用 `autoRunning`（:2710） | Home.tsx:235/:1253/:2710 | 同一时刻两个面板对「连载是否运行中」判断不同 |
| P8 | **媒体双通道轮询**：BrainCabin `pollMediaGen` 3s（BrainCabin.tsx:1275）与 Home `mediaTimer` 5s（Home.tsx:1372）可对同一 mediaId 并发轮询，收尾各自 `refreshWorld` 重复刷新 | BrainCabin.tsx:1274-1296；Home.tsx:1333 | 冗余请求/重复全量刷新 |
| P9 | **轮询恢复缝隙**：media/visual 轮询靠「world 中 pending 字段」effect 恢复（Home.tsx:1290-1300/:1417-1432），若服务端任务在跑但 world 快照 pending 缺失（旧数据），刷新后不续接 | Home.tsx:1290-1300/:1417-1432 | 生成结果丢失进度展示 |
| P10 | **服务重启后后台任务无消费者**：`resumeAutoSessions`→`runAutoInBackground` onEvent 为空实现（routes.ts:2617-2633），后台续跑只写文件，前端只能靠 sysPoll 比对 written 前进发现 | routes.ts:2617-2633 | 重启后连载进度依赖轮询被动发现 |
| P11 | **全量刷新成本**：`world` 整包替换，长篇 state.json 增大后刷新成本线性上升，无法表达「本次操作只影响哪些区域」 | COUPLING.md:63；Home.tsx:629-641 | 长篇性能损耗、无区域级增量 |
| P12 | **视频任务无限轮询风险**：`pollVideoTask` 对 429 一律返回 rate_limited，任务无服务端超时回收 → 前端可能永久轮询 | 架构分析.md:304-306；videos.ts:110 | 资源浪费/状态混乱 |
| **P13** | **广播盲区①——中枢 LLM 直改 world**：brain-chat.ts:1550-1672 的 `wLive = loadWorld → 改 → saveWorld` **不经锁、不经 statechange、无分级日志**（仅 logChange），任何基于 finalize 的广播会漏掉中枢直改（推进/抽卡/编辑类卡片操作） | brain-chat.ts:1550-1672 | 广播覆盖不全 |
| **P14** | **广播盲区②——媒体/视觉/封面路径绕开 finalize**：routes.ts:2082/2096/190/245/262/307/322 直接 saveWorld（或 applyStateChange+saveWorld），field 语义缺失；若广播挂在 finalizeStateChange 会漏媒体类变更 | routes.ts:190-322/:2082-2096 | 广播覆盖不全 |
| **P15** | **状态文件多源分散**：state.json / meta.json / autorun-session.json / brain-sessions.json / advance-task.json / newstory-tasks.json / eval.json / checkpoint.jsonl 八类文件各自独立写路径，无统一「变更事件」；前端需分别轮询 6 个端点才能拼出全貌 | §2.1 表 | 轮询端点膨胀、状态拼图易漏 |
| **P16** | **无 saveWorld 后钩子**：`saveWorld`（storage.ts:207）是 state.json 唯一落盘函数，但**内部无任何 postSave 回调/事件**——WebSocket 广播无法在单点挂接，需侵入 saveWorld 或收敛写点 | storage.ts:207-249；§2.1.3 结论 | 广播点设计必须先解决「在何处挂钩」 |
| **P17** | **前端无统一订阅层**：各区域同步机制混用（props 回调/轮询/SSE/挂载拉取/事件驱动/sysTick 信号），新增区域需要手写同步逻辑，无 useSyncExternalStore 式订阅 | §2.6 零命中确认 | 耦合随区域增长，重构面大 |
| **P18** | **用户手动交互不注入聊天记录**：`injectSystemNote` 仅 Home.tsx:1813 一处调用，只覆盖 4 类服务端状态转移（连载/推进）；设置保存、抽卡、伏笔/关系编辑、删章、切章等用户操作只 `setWorld` 刷 UI，不写会话历史——聊天记录与 AI 上下文（hist.slice(-6)）无这些交互痕迹；`serverCtx` 快照仅打开面板时拉一次 | §2.3.5 缺口清单 | 中枢对话中刚做的操作聊天无痕；跨 tab/多入口变更对聊天不可见 |
| **P19** | **聊天记录内卡片是"一次性快照"，无就地更新**：卡片无稳定 id（只能靠消息内下标定位）、服务端无 `updateMessageCards` 接口、前端 `onCard` 只追加不替换、SSE 回合结束后无更新通道（`reloadActive` 重拉的还是旧快照）；`ProgressCard` 写作进度卡是前端瞬态（SSE 结束 2.5s 消失，不进会话历史，刷新/多 tab 不可见）；卡片内容只有 `completed` 前端本地标记，不更新卡面 | §2.3.6 证据表 | 聊天记录中已存在的组件状态与全局状态脱节：任务进度卡永远定格、browse 快照卡过期、刷新后进度卡消失 |

**根因归纳**：① 服务端**没有任何"主动推送"能力**（无 pub/sub、无 WS、SSE 均为请求内流、saveWorld 无钩子）；
② 前端**无统一订阅层**，各区域各自为政；③ 异步后台任务的完成**只能靠轮询发现**，再用「前端主动注入聊天」回环，链路长。

---

## 4. 方案评估

### 4.1 需求分级（同步什么）

- **P0 服务端主动推送状态变化**：新章提交（连载/推进）、任务完成（立项构建/媒体/视觉/评估）、连载开始·暂停·结束、
  服务重启后恢复的续跑。消除 3s/5s 轮询延迟与 P10 的空窗。
- **P1 多标签页/多入口一致性**：P2 问题（双 tab 覆盖、聊天注入错乱）的根治。
- **P2 局部刷新**：把「任何写指令 → 全 UI 刷新」收敛为「事件 → 受影响区域刷新 + 全量兜底」。

### 4.2 候选方案对比

| 方案 | 推送方向 | Bun 支持 | 断线重连 | 实现成本 | 与现状衔接 | 结论 |
|---|---|---|---|---|---|---|
| **A. 轻量 WebSocket** | 双向 | **Bun.serve 原生 `websocket:` 配置 + `server.upgrade()`，零新依赖**（CLAUDE.md:14/18/52-53） | 需自建（心跳+重连+全量补偿） | 中（1 个连接管理 + 1 个频道注册表 + 事件协议） | 可复用 brain-sessions 的会话级广播模式推广为「书级频道」；轮询全部可下线为降级 | **推荐主通道** |
| B. SSE 全局频道（`GET /api/sync/events?title=` + EventSource 或 fetch 流） | 单向（服务端→客户端） | 复用现成 `sseStream` 模式 | 浏览器 EventSource **自动重连**内建 | 低（无升级流程、无连接写路径） | 与现有 SSE 一致；但 GET-only（需 query 传参）、每连接占一 TCP 流、多路复用困难 | 可作 A 的降级/无 WS 环境备选 |
| C. 轮询优化（降频 + version/etag 增量） | 无 | — | — | 低 | 改动最小 | **治标不治本**，P2/P10 依旧 |
| **D. 混合：WS 推状态事件 + SSE 保持流式** | 双向 + 单向 | 同时满足 | 各通道自理 | 中高 | 流式文本（step/chat/auto 的 delta）不动，只把「事件通知」迁到 WS | **推荐终态** |

### 4.3 推荐与理由

**推荐 D（务实落地序：先 A 后 D）——轻量 WebSocket 承担「状态事件推送」，SSE 继续承担「流式文本」。**

1. **状态事件天然契合 WS**：状态变化是低频离散事件（新章/任务完成/媒体就绪），WS 双向通道正是「服务端主动 + 客户端订阅」的标准形态；
   且**事件推送不需要请求-响应语义**，SSE 的「客户端先发起、GET-only」反而是负担。
2. **零新依赖、符合项目原则**：项目是「纯 Bun、零 vite、零额外运行时」（README §技术栈），
   Bun.serve 原生支持 WebSocket，不引入 `ws`/socket.io，与 CLAUDE.md 工具选型一致。
3. **已有可复用的先例**：brain-sessions 的会话级任务注册表 + 多连接 attach + 断线续收（§2.3.2）已验证「长连接 + 服务端任务不随客户端断开而终止」模式；
   推广为**书级频道**（`Map<user::slug, Set<Socket>>`）即可广播所有后台任务状态。
4. **直接取代 COUPLING.md:159 的「SSE 事件分区（远期可选）」计划**：SSE 分区仍需客户端保持 GET 长连接且单向，
   WS 是更强替代；若需兼容无 WS 环境，可保留 SSE 全局频道为降级（方案 B）。
5. **SSE 流式不动的理由**：step/chat/auto 的增量文本流已成熟（fetch 流式解析、attach 重连测试覆盖），
   迁移到 WS 无收益且风险高；**只把「通知/事件」迁到 WS，流式留在 SSE**，改动面最小、协议向后兼容。
6. **服务端重启恢复问题（P10）一并解决**：`resumeAutoSessions` 恢复的续跑会话通过 WS 频道广播进度，
   前端无需再靠轮询比对 written。

### 4.4 取舍说明

- 若团队对 WS 连接管理（心跳/重连/内存回收）顾虑大，可先做 **B（SSE 全局频道）**：
  复用 `sseStream`、浏览器自动重连、改动更小，但牺牲双向性与多路复用。B 与 A 的事件协议可完全一致，后续可平滑升级 A。
- 轮询不应全部立即删除：**保留 sysPoll 作为 WS 断线时的降级**（断线 → 恢复 3s 轮询；重连成功 → 全量 `refreshAllStates` 一次再停轮询），
  与现有 `brain-chat` attach 重连的「先重放再续收」哲学一致。

---

## 5. 目标架构设计（推荐方案 D）

### 5.1 服务端（routes.ts / 新模块 `src/api/sync.ts`）

```
Bun.serve({
  fetch(req, server) {
    // /api/sync 升级路径：校验 cookie（userFromRequest 同 SSR）+ title 参数 → server.upgrade(req, {data:{key}})
  },
  websocket: {
    open(ws), message(ws,msg), close(ws), drain(ws),
  },
})
```

- **频道模型**：**直接用 Bun 原生 pub-sub**（bun 1.4 已确认，`ws.subscribe(name)` / `server.publish(name, msg)` / `ws.unsubscribe`，见 node_modules/bun-types/docs/guides/websocket/pubsub.mdx）——
  不需要手写 `bookChannels: Map<key, Set<Socket>>`。topic 即书级频道：`<user>::<slug>`（另设用户级频道覆盖列表页 creating 跨书广播）；
  `close` 时 `ws.unsubscribe`，Bun 自动管理 socket 生命周期（无需自维护 Set、无空频道泄漏）。
- **事件协议**（与 brain-chat 的 `{type, messageId, ...}` 风格一致）：

```ts
// 服务端 → 客户端
{ type: "world-changed", reason: "advance-done" | "auto-chapter" | "media-ready" | "visual-done" | "build-done" | ...,
  version: <state.json 版本戳>, region: ["U01","U04"], detail?: {...} }
{ type: "auto-status", status, phase, written, updatedAt }   // 连载转移（含重启恢复的续跑）
{ type: "task-status", kind: "build"|"advance"|"media"|"visual", id, status, error? }
{ type: "brain-note", eventId, text }                        // 系统事件注入可直接经 WS 推给所有 tab，替代前端轮询后主动 POST
{ type: "ping" }                                             // 心跳（可复刻 sseStream 8s）
// 客户端 → 服务端（可选，当前最小集只需订阅/心跳）
{ type: "subscribe", title }, { type: "ping" }
```

- **幂等与防抖**：`world-changed` 带版本戳，客户端按版本去重；同类事件 1s 内合并（节流），避免媒体 5 张并发 → 5 条冗余广播。
- **安全**：升级前认证（cookie）；频道 key 由服务端从会话计算（防客户端伪造跨书订阅）；关闭时从频道摘除（`close` 回调）；
  定期清理空频道。

### 5.2 客户端（新 hook `useSyncChannel`，放 `src/components/`）

- 打开小说时连接 `/api/sync?title=<slug>`；`onmessage` 按事件类型分发：
  - `world-changed` → 按 `region` 局部更新（若未实现区域映射则先退化为 `refreshWorld()`，协议向后兼容）；
  - `auto-status` / `task-status` → `setAutoSession` / 更新任务中心、`advancePhase`；
  - `brain-note` → 直接追加/重拉聊天会话（替代 §2.3.4 的轮询注入回环）。
- **断线降级**：`onclose` → 启动现有 sysPoll（3s）；`onopen` 重连成功 → 停轮询 + `refreshAllStates()` 一次。
- **多 tab 一致性**：所有 tab 同收广播，天然一致；`world-changed` 版本戳防旧 tab 用旧快照覆盖（P2 根治）。
- 服务端渲染（SSR）无 `window` 时 hook 空转（与 brainCache 的静默降级同模式）。
- **与现有约束共存**（§2.6）：推送合并进 `setWorld`/`refreshWorld` 语义；不绕过 `taskActive` 运行锁；
  401/WS 鉴权失败时关闭连接并交由 `onAuthChange` 收尾；`completed` key 体系不动。

### 5.3 事件 → 刷新映射（第一阶段落地的区域，对应 §2.4 矩阵）

| 事件 | 影响区域 | 刷新动作 |
|---|---|---|
| `world-changed:advance-done` | 中栏正文 / 左栏目录 / 右栏状态 / 任务中心 / 聊天（系统条） | `refreshWorld()`（全量，暂不改局部）+ 聊天注入 |
| `world-changed:auto-chapter` | 同上 + 连载控制台 | `refreshWorld()` + `setAutoSession` |
| `world-changed:media-ready` / `visual-done` | 正文媒体 / 中枢指示器 | `refreshWorld()`（含媒体字段）+ 停轮询 |
| `task-status:build-*` | 列表页 creating / 三栏构建徽章 | `fetchStories()` / 局部 `setBuildingStage` |
| `auto-status:*` | 连载控制台 / 任务中心 / 中枢指示器 | `setAutoSession`（局部，无需全量） |
| `brain-note` | 中枢聊天 | `reloadActive()`（幂等由服务端 eventId 去重） |
| **`card-update`**（阶段 3a/3b 已落地） | 中枢聊天**已有卡片** | **基础设施**：BrainCard 加 `cardId`、`updateMessageCard` 服务端接口、`POST /api/brain/sessions/update-card` 路由、`card-update` 事件广播、前端 `patchCard` 就地替换（useBrainSession）+ `registerCardPatch` 注册（BrainCabin） |
| **`brain-note`**（阶段 2a 已落地） | 中枢聊天（**多 tab 一致**） | 服务端 `appendSystemNote` 注入成功即广播 `brain-note` 事件 → 所有订阅该书连接收到 → Home `setSysTick+1` → BrainCabin `reloadActive`（复用现有 sysTick 链路，替代"仅发起 tab 重拉"的单一通道） |
| **`progress` 进度卡**（阶段 3b 已落地） | 推进/连载的**持久进度卡** | 执行时 `POST /api/brain/sessions/progress` 建服务端持久 progress 卡（带 cardId，status:running）→ SSE 流式期间前端 `patchCard` 就地更新阶段/正文 → 完成后 `update-card` 翻转 done/failed + 广播 `card-update`（多 tab 一致、刷新可见；前端 writing 瞬态保留作动画） |

区域级局部刷新（P11）作为第二阶段：COUPLING.md §2 的「指令→UI 区域映射账本」是现成设计依据。

### 5.4 兼容与降级

- WS 不可用（老代理/受限网络）→ 自动回落现有轮询 + SSE，功能不退化（轮询代码保留，仅常驻改为降级触发）。
- 与 `/api/brain/chat` 的 attach 机制不冲突：chat 流式仍走 SSE；WS 只推「事件」，不承载增量文本。
- 服务端单进程（当前架构）下 WS 频道为进程内存；若未来多进程需 Redis pub/sub（`Bun.redis`），事件协议不变。

### 5.5 广播点分级（本轮深挖的设计结论）

**目标**：把「谁写状态」与「何时广播」解耦，按侵入性从小到大四级，每级独立可落地：

| 级 | 挂接点 | 覆盖 | 语义 | 代价 |
|---|---|---|---|---|
| **A（最高覆盖）** | **`saveWorld`（storage.ts:207）内加 postSave 钩子** | **全部** state.json 写路径（director/planner/steering/autorun/brain-chat 直改/媒体/视觉/封面） | 无 actor/字段语义；只知「world 变了」 | 侵入单点；**与锁内高频调用共存**（连载每章多次 saveWorld，需节流）；SSE 心跳期间也会触发 |
| **B（带语义）** | `finalizeStateChange`（statechange.ts:118） | 用户显式变更（HARNESS 指令路径） | actor/commandId/field/level 齐全 | **漏媒体类**（routes 绕开 finalize 直接 saveWorld）与中枢直改 |
| **C（任务进度）** | `touchSession`（autorun.ts:63）/`saveAutoSession`、advancetask、newtask、`saveSessions`（brain-sessions.ts:97） | 连载/推进/立项/聊天会话各自进度 | 结构化任务状态 | 4 处分别挂 |
| **D（任务完成翻转点）** | 内存任务表 done 翻转：visualTasks（routes.ts:268-272）、`imageGenTasks.delete`（routes.ts:2100）、`finishSessionTask`（brain-sessions.ts:361） | 后台任务完成（**无落盘文件、纯内存**） | 「任务 N 完成」即时信号 | 与内存表生命周期耦合 |

**推荐组合**：**A 为主通道**（`world-changed`，节流防抖 + 版本戳）+ **D 补后台任务即时完成**（避免等落盘再广播的延迟）
+ **C 覆盖非 world 状态文件**（auto/advance/brain 会话）。B 作为 A 的「带语义增强」：若 A 钩子能读到调用栈/上下文（如借助 AsyncLocalStorage 或传参），再逐步把 reason/field 语义化。
**P13/P14 盲区自动消除**：A 挂 saveWorld 天然覆盖中枢直改与媒体路径，无需改造这两类代码。

**实现注意**：A 级钩子需防递归/防多进程重复广播（当前单进程无碍）；saveWorld 在 `withTitleLock` 内高频调用（连载每章一次 + 媒体每张一次），
事件应**异步节流**（如 1s 合并窗口内只发一条 `world-changed`），并把「任务级 detail」由 D 级补发。

### 5.6 测试计划（基于 §2.7 基建）

- **服务端 WS 集成测试**：仿 `brain-e2e.test.ts:407-444` 双连接 attach 手法——起真实 `Bun.serve`（带 `websocket:`），
  用 Bun 原生 `WebSocket` 客户端连 `ws://localhost:port`；断言补发/广播/频道隔离（不同用户/书不串）、断线重连、版本去重。
- **客户端 hook 测试**：照抄 `brain-reconnect.test.tsx` 结构——beforeAll 挂 `globalThis.WebSocket = FakeWebSocket`
  （仿 SSE mock 写法 B/C，暴露 `emitMessage()`/`releaseError()` 控制点）；
  断言清单复用：恰好重连 N 次 / 断线降级轮询启动 / 重连后全量补偿一次 / 事件驱动下轮询停止。
- **广播点单测**：saveWorld 钩子（A 级）在 tests/storage 相关测试中注入假 publisher 断言调用次数与节流行为；
  finalizeStateChange（B 级）复用 tests/statechange.test.ts 现有断言扩展。

---

## 6. 迁移路线

- **阶段 0（打点）**：在 §5.5 四级广播点埋 `publish(event)` 空实现（无消费者，零行为变化，同 COUPLING.md:158 的 HARNESS 思路）。
  重点：saveWorld 内 postSave 钩子 + 节流器骨架。
- **阶段 1（最小闭环）**：`/api/sync` WS 端点 + `useSyncChannel`；先订阅最小集
  （auto-status / task-status / world-changed:auto-chapter），与 sysPoll 并存验证一致性（事件驱动 + 轮询双跑，轮询仅作校验）。
  新增 §5.6 的 WS 集成测试与 hook 测试。
- **阶段 2（全量异步任务）**：A 级 saveWorld 钩子广播 `world-changed`（含 P13/P14 盲区）；D 级补后台任务即时完成；
  C 级覆盖 auto/advance/brain 会话。前端对应轮询（mediaTimer/visualTimer/buildPoll/advanceRestore）改为「WS 事件驱动 + 断线降级」，sysPoll 降为降级通道。
- **阶段 3（收口）**：`brain-note` 改经 WS 广播（替代前端轮询后主动 POST 回环）；多 tab 一致性验证；
  区域级局部刷新（可选，接 COUPLING.md §2 映射账本）；评估删除常驻轮询。
- **每阶段验收**：`bun test` 全绿 + §5.6 新增测试；手工验证多 tab 双开连载/媒体生成一致。

---

## 7. 风险与权衡

| 风险 | 说明 | 缓解 |
|---|---|---|
| WS 连接管理成本 | 心跳/断线检测/内存回收需自建（Bun 不内置重连语义） | 复用 brain-sessions 已验证的 attach 模式（§2.3.2）；心跳协议同 sseStream 8s |
| 双通道一致性 | WS 事件与 SSE 流式并存，事件乱序/重复 | 事件带 version/eventId，客户端去重；先「双跑校验」再收口（阶段 1） |
| saveWorld 钩子副作用 | 锁内高频调用（连载/媒体）→ 广播风暴；递归风险 | 1s 合并窗口节流 + 异步发事件；§5.5 实现注意 |
| 多进程扩展 | 频道为进程内存，多实例需外部 pub/sub | 单进程现状可接受；预留 `Bun.redis` 抽象 |
| 代理/防火墙 | 部分企业网络禁 WS 升级 | SSE 全局频道（方案 B）作降级，轮询保底 |
| 服务端资源 | 每连接常驻 TCP + 内存；广播风暴 | 事件节流合并；空闲频道清理；连接上限 |
| 与运行锁/401 交互 | 推送刷新绕过 `taskActive` 锁或 401 流程 | §5.2 约束清单（合并进 refreshWorld 语义、onAuthChange 共存） |

---

## 8. 附录：证据索引

- 轮询全集：Home.tsx:512-563（newTask）、:566-616（build）、:654-749（advance）、:1283-1373（media）、:1378-1432（visual）、:1818-1845（sysPoll）；BrainCabin.tsx:1274-1296（chat 内 media）
- SSE 基座 `sseStream`：routes.ts:52-90；SSE 端点：step（:928-964）、brain/chat（:724-776）、auto/start（:1586-1657）、chat/stream（:525-550）
- 会话级广播（唯一先例，WS 蓝本）：brain-sessions.ts:295-368（tasks 注册表 / attachSessionTask / broadcastToSession / detachSessionTask / finishSessionTask）
- 无 WebSocket：dev.ts:95-156 与 prod.ts:36-94 的 `Bun.serve` 仅 `fetch`，无 `websocket:` 配置；grep `websocket` 仅 CLAUDE.md 文档提及
- 统一轮询→聊天注入链：Home.tsx:1755-1816（pollSysStateOnce）、:1724-1737（injectSystemNote）、routes.ts:635-646（system-note）、useBrainSession.ts:433-437（reloadActive）
- 写路径：saveWorld 唯一落盘 storage.ts:207-249；调用方 §2.1 表；statechange.ts:94-122（apply/finalize）、:126-153（async 闸门）；autorun.ts 状态机 §2.1.1
- 广播盲区：brain-chat.ts:1550-1672（中枢直改不经锁不经 statechange）；routes.ts:2082/2096/190-322（媒体/视觉/封面绕开 finalize）
- 重启续跑无消费者：routes.ts:2617-2633（runAutoInBackground onEvent 空实现）
- 前端入口链：render.ts:13-16（__INITIAL_DATA__ 注入）、dev.ts:126-138 / prod.ts:67-80（initialData 构造）、entry-client.tsx:16-22（hydrate）、Home.tsx:128-160/258（initialData 消费）
- 全局事件机制：client.ts:26-34（onAuthChange）、Home.tsx:353-363（订阅）、sysTick Home.tsx:249/:1734、props 回调 §2.4/§2.6
- 数据模型：world.ts:367-406（WorldState）、:147-162（ChapterMedia）、:22-27（Character 视觉字段）、routes.ts:706-722（brain/context）、routes.ts:660-678（brain/state）、brain-sessions.ts:40-53（BrainSession）、storage.ts（AutoSession）
- 测试基建：use-brain-session.test.tsx:33-113（fetch mock）、brain-reconnect.test.tsx:74-92（SSE 流 mock/断线）、brain-e2e.test.ts:98/:407-444（readSSE/双连接）、brain-chat.test.ts:1-3（依赖注入）、mocks.ts（LLM mock）
- 既有文档衔接：COUPLING.md:19-22/52-58/63/158-160；架构分析.md:304-306/333-340；FEATURES.md:233-247
