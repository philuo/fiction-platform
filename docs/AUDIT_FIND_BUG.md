# AUDIT_FIND_BUG — 对 FIND_BUG.md 的独立审计复核

> 审计时间：2026-08-11（与 FIND_BUG.md 同日基线代码）
> 审计方法：6 个只读审计 agent 并行分组逐条核对源码（每组覆盖一个严重级别/文件域），对 agent 结论与 FIND_BUG.md 存在分歧或标注 partial 的条目（C1/H2/M3/L17/L18/L20）由主 agent 逐一人工复核原始代码，并抽查了 C2/C3/C4/C5/C9/H5/H8/H14/L15 等关键路径。
> 判定标准：
> - **属实（confirmed）**：行为描述与源码逐字吻合，行号在可接受偏移（≤20 行）内；
> - **部分属实（partial）**：核心缺陷/机制成立，但 FIND_BUG.md 中部分事实描述或后果断言与代码不符；
> - **不属实（false）**：理解有误或代码中不存在。
>
> 审计对象仅限 FIND_BUG.md 所列 58 条（C1-C9、H1-H15、M1-M10、L1-L24），未扩展扫描新问题。

---

## 总览

| 判定 | 数量 | 条目 |
|---|---|---|
| 属实 confirmed | **52** | C2-C9、H1、H3-H15、M1-M10、L1-L16、L19、L21-L24 |
| 部分属实 partial | **5** | C1、H2、L17、L18、L20 |
| 不属实 false | **0** | — |

- FIND_BUG.md 的缺陷清单**整体质量很高**：52/58 条完全属实，无一条是凭空捏造（false = 0）。
- 5 条 partial 的共同模式：**核心机制/缺陷真实存在，但触发条件或后果被夸大或描述不准**。其中 C1、H2 属"影响面描述错误"，L17、L18、L20 属"影响后果夸大/覆盖面夸大"。
- 行号引用整体准确：多数精确命中或偏移 ≤4 行（文件行号随时间微移所致），个别条目偏移 13-24 行（C7 +16、M8 Home.tsx +24、L17 +20、M9 +24），均在可接受范围，不影响结论。
- 额外发现 1 处 FIND_BUG.md 未覆盖的更严重情形（见 M10 补充）。

---

## Critical 逐条

### C1 — **partial**（核心注入缺陷属实；"恒返回非空串/必现"的触发描述错误）

**属实部分**：`${c}` 拼接整个 Character 对象已确认——
- `src/api/media.ts:801`（立绘）：`` `...无现代元素${idDress ? `；身份服饰：${idDress}${c}` : ""}...` ``，`c` 是 `Character` 对象，模板字符串 `${c}` 渲染为 `[object Object]`。
- `src/api/media.ts:845`（头像）：同样 `…${idDress}${c}`。
- `src/api/routes.ts:139`（`charHintFor`，强制拼入章节插画/视频提示词）：`segs.push(\`身份服饰 ${idDress}${c}\`)`，经 grep 确认用于章节插画与视频生成（routes.ts:2031/2109/2346/2358/2362）。
- 行号 801/845/139/591 全部准确。

**与文档不符**：文档称"`identityDress()` 恒返回非空串（media.ts:591 有 fallback），所以几乎是必现"。实际 `media.ts:428` `const IDENTITY_DRESS_FALLBACK = "";`，`:599` `return IDENTITY_DRESS_FALLBACK;`——**fallback 是空串**。`identityDress(c)` 仅在角色 `identity/role/name` 命中 `PRIMARY_DRESS_RULES`/`IDENTITY_DRESS_RULES`（官员/武将/侠客/僧道/医者/商贾等职业规则）时才返回非空服饰串。因此 `${c}` 注入只在**命中身份规则的角色**上触发（规则覆盖面较广，但绝非"必现"）；文档示例「身份服饰：素色长袍[object Object]」中的"素色长袍"也并非 fallback 值（fallback 为空串）。

**结论**：缺陷真实存在、修复建议（删除多余 `${c}`）正确，但触发条件与影响面描述需修正为"命中身份服饰规则的角色"。

### C2 — **confirmed**

`src/api/brain-chat.ts:1550/1604/1626/1655/1672` 四个角色/关系写操作均为 `loadWorld → 改内存 → saveWorld`，全文件 grep `withTitleLock` 零命中；对照 `routes.ts` 中 60+ 处写路径均用 `withTitleLock(slug(title), …)`（titlelock.ts:10 为 per-title 串行队列）。路由入口 `routes.ts:794-825` 直接调 `brainChatStream` 无锁。忙碌检测 `:1532-1549` 读取的 `ctx`（`routes.ts:790` 来自请求体）确为客户端自报软标志。**细节差异**：文档称只读 `autoRunning/writingRunning`，实际还读 `systemStatus` 与 `server.advanceTaskRunning/mediaGenerating`（同为请求体自报，不影响"软标志可过时/可省略"结论）。

### C3 — **confirmed**（行号偏移 +4）

`routes.ts:2333` 快照 `oldPath`；`:2373-2392` 锁内 swap 视频分支 `:2383-2386` 置 `m.videoId = newMedia.videoId; m.path = undefined; m.status = "pending"`；`:2399`（文档写 :2395）`if (snap.oldPath) deleteMediaFile(title, snap.oldPath)`——异步任务仅创建即删旧 mp4，新任务失败/超时永久丢失，无回滚。图片分支（:2380-2381）是"生成完成再替换"，与视频不同，文档对比描述正确。

### C4 — **confirmed**（行号偏移 +4）

swap（:2378-2386）只拷 `prompt/videoId/path/status`，**不写 `createdAt`、不清 `error`**；超时判定在 `routes.ts:2217`（文档写 :2213）：`media.status === "pending" && media.createdAt && Date.now() - media.createdAt > 30 * 60_000`；`createdAt` 仅在 `createSceneVideo`（media.ts:1177）设置。重生成旧视频立即被判定超时的链路成立；`media.createdAt &&` 的"缺 createdAt 永久 pending"反向问题也确认。

### C5 — **confirmed**

`cacheGetSession` 仅在 `src/components/brainCache.ts:44` 定义，全仓 grep **零调用**（只有 `cachePutSession` 被 useBrainSession.ts:375/418 调用），"只写不读"成立。`useBrainSession.ts:569` 先 `loadedTitleRef.current = title`（已更新为新书），`:576` `cacheClearBook(loadedTitleRef.current)` 清的是新书；`cacheClearBook` 按 `${title}::` 前缀匹配（brainCache.ts:78），清错书成立。

### C6 — **confirmed**

`useBrainSession.ts` 全文件仅 `:567` 一个 `useEffect`，无任何 `return () =>` 卸载 cleanup；`:571` `abortRef.current.clear()` 是 `Map.clear()`，不逐个调 `.abort()`（对照 :469/491/563 行 `abortRef.current.get(id)?.abort()`）。头部注释（:3）自称"abort 仅由停止/卸载触发"，卸载分支未实现。idleTimer（:273-275）只在流结束的 finally（:305）清理，卸载不清理。SSE 继续运行、服务端 `req.signal.aborted` 不置位的结论成立。

### C7 — **confirmed**（行号偏移约 +16）

`Home.tsx:793` `advance()` 与 `:1901` `startAutoRun()` 均为普通 async 函数，闭包捕获点击时的 `world`，fetch 无 `signal`；流完成收尾 `:858 await refreshWorld()` + `:861 setStoryUrl(world.title, …)`（文档写 :842/845）。`refreshWorld`（:630-646）用闭包 `world.title` 拉 `/api/novel/state` 后 `setWorld(dw)`。`backToList`（:412-421）/`openStory`（:378-409）无 `busy` 检查。切书竞态成立。

### C8 — **confirmed**

`media.ts:715-736` `findCharacterRef`：`:717-720` subject 有 portrait 才返回，无 portrait 时**不 return 继续向下**，`:722` `w.characters.filter(names.includes).map(portraitAsMedia).find(Boolean)` 抓任意有头像的角色；`findVideoFirstFrame`（:750-773）同款 :753-760。i2i 前缀 `i2iPreservePrefix`（:664）明确"不得改变样貌或换人"，与借脸直接冲突。使用链 routes.ts:2341/2353 确认他人头像作为 i2i 参考图。

### C9 — **confirmed**（对照行号偏移 +4）

`director.ts` 三条路径均无 `resetChapterLedger` 直接 `settleChapter` 后整体覆盖 `chapterDeltas[index]`：editChapter `:1093-1094`、rollback `:1138-1139`、regenerate `:1225-1226`（均已人工复核 :1093）。对照 `routes.ts:2652`（文档写 :2648）integrity resettle 先 `resetChapterLedger(w, index)`。`chronicler.ts:130-148` `applySettle` 对伏笔只 `push` 不删（回收 :159-161 是按 ID 匹配改 status 为 resolved，非删除）。伏笔残留 + delta 丢失链路成立。

---

## High 逐条

### H1 — **confirmed**

`director.ts:472-483` `reviewFixLoop`：`:474` `if (verdict.action === "patch")` → `:476 if (pr.patched)`，**无 else 分支**；`patched=false` 时 verdict 保持 `"patch"`、fixRounds 已 +1，下一轮空转同一 patch 分支，2 轮后退出。`patch.ts:44/45/66/78` 返回 `patched:false` 的分支与文件头注释（:1-2、:38）"命中段落占比 >50% 时回退整章重生成"相符；`harness.ts:62` CMD-N11 登记同语义。空转两次白烧 LLM、退出时 action 仍为 patch 的后果成立。

### H2 — **partial**（机制全部成立；"弧/卷卡死无法收束"的后果断言不成立）

**属实**：`planner.ts:235-251` `ensureChapterPlan` 不检查缺口（:237 只 `find(p.index===index)`）；`:160` `startIdx = nextChapter + planned 数量`（删第 3 章后 = 3 + 2 = 5）；`:163-165` safeStart 跳过已占用的 5 → 6；`:181` prompt 用 `startIdx`（5）而非 safeStart（6），告诉 LLM"从第 5 章开始"；`:214` 实际创建 6/7；`:251` `created.find(p.index===3) ?? created[0]` 返回第 6 章计划。`markChapterDone`（:255-265）找不到 plan 3 → 返回 null，第 3 章完成不触发弧边界事件。`deleteChapterCascade`（integrity.ts:355-373）删 plan 3、回退 nextChapter=3、保留 plan 4/5，与文档一致。

**与文档不符**：文档称"弧/卷卡死无法收束"。但弧完成判定是 `arcPlans.every(p => p.status === "done")`（:262），而 `expandArc` 新建的 6/7 计划**挂在同一弧下**——第 4/5/6/7 章依次完成后该弧所有计划全 done，弧边界仍会触发，卷也能收束（只是从第 5 章延迟到第 7 章）。真正的后果是：**第 3 章拿着第 6 章的目标/节拍写作**、第 3 章完成时 `markChapterDone` 找不到 plan（弧边界事件不归位），即"章纲错位 + 章节与计划失配"，而非"永远无法完成"。

### H3 — **confirmed**

`director.ts:343-364` 抽卡（`applyCards`，cards.ts:104-111 以 `plantedAt: nextChapter`、note「抽卡预登记（待埋设…）」预登记进 `world.foreshadowing`）→ `:355 ensureResearch`（内部 `:277 saveWorld`）→ `:358-364 healLegacyStory`（planner.ts:392-394 expandArc + saveWorld）→ `:370 ensureChapterPlan`，**第一次打断检查在 :377**。所有 saveWorld 均位于打断检查之前，未 commit 即落盘成立。

### H4 — **confirmed**（行号 ±1）

`director.ts:995` `const rep = (s) => s.split(from).join(to);`（文档写 :994）朴素子串替换，应用于 :1037-1038 等全书字段；重名检查 `:929` 只做精确相等；`recomputeAppearedIn` → `shared/appearance.ts:19-21` 用 `text.includes(c.name)`。「王林之」→「王虎之」污染 + 花名册登场记录清空链路成立。

### H5 — **confirmed**

`routes.ts:910` `throw new AppError("故事不存在: " + title)`，`/api/novel/state` case 内无 try/catch；`handleApi`（:412-416）、`handleNovelApi`（:835 起，:839 直接 switch）、`runAsUser`（storage.ts:32-34）、`server/prod.ts:52` 均无兜底。AppError 逃逸到 Bun 返回非 JSON 通用 500。

### H6 — **confirmed**

`routes.ts:528-553` `/api/chat/stream`：`:538` `agnes.chatStream(...)` 未传 signal；`:539` `controller.enqueue` 无保护；`:542-547` 断连后 enqueue 抛错进 catch、catch 内再 enqueue、finally close 再抛。对照 `/api/brain/chat` `:816/820` 正确透传 `req.signal`。

### H7 — **confirmed**

`agnes.ts:117-143` `withSmartRetry` + `:302-343` `readStream`（:328 每个 delta 立即 `onChunk(delta)`）；`:346-362` `chatStream` 重试 = 重新完整读流，onChunk 从头重复回调。`brain-chat.ts:785-850` `streamChatReply`：`:787` `let acc = ""` 外层变量、`:820` `acc += delta` 重试不重置、`:835` `retries: 2`。前端收到重复文本、中枢落库"前半段+完整段"成立。

### H8 — **confirmed**（行号偏移 ≤6）

`routes.ts:1814` 队列排序过滤；`:1816-1823` 循环 try/catch，注释（:1821）"剩余保留在队列"；`:1824` `w.rewriteQueue = [];` **无条件清空**，与注释矛盾；`:1825` 日志写"回溯重写队列消费完成（重写 N 章）"。

### H9 — **confirmed**（行号偏移 +4）

`routes.ts:2056-2063` 锁外 `loadWorld` 读 `existingImgs` 校验 `<= MAX_IMAGES_PER_CHAPTER`；`:2066` 锁内重新 loadWorld；`:2084` 锁内 append **无重新计数**。并发两个请求各读 0、各 append 3 张 → 6 张。TOCTOU 成立。

### H10 — **confirmed**（行号偏移 +4）

图片分支 `routes.ts:2196` 有 failed 早返回；视频分支 :2216 起无；超时回收 :2217 只匹配 `pending`；`:2232-2233` 每次轮询 `pollVideoTask`（videos.ts:111 为外部网络请求）；`:2240` 置 failed 时**不写 `m.error`**；远端过期 catch :2268-2270 返回 502 `{error}` 而非 `{ok:true,status:"failed"}`。

### H11 — **confirmed**（行号偏移 +4）

`routes.ts:1900` `withTitleLock` 内 `:1911` cover `await generateImage`、`:1923` avatar `await generateCharacterAvatar`（网络生成持锁）；对照立绘 `:1950-1962` 锁外生成、锁内落盘，章节媒体同款"锁外生成、锁内短事务"。长持锁阻塞该书所有写操作成立。

### H12 — **confirmed**

`brain-sessions.ts:60` 模块级 `cache` Map，`:81-95` `loadSessions` 命中即返回，全文件 grep `cache.delete` 仅 :410 的 `t.emitters.clear()`（SSE emitter，非此 cache）；删书路径 `routes.ts:947-976` 无任何 brain-sessions 清理调用；`deleteStory`（storage.ts:410-415）只删磁盘目录。同书名重建 slug 相同 → 继承被删书会话，成立。

### H13 — **confirmed**

`storage.ts:245` meta.json 普通 `writeFileSync`（对照 state.json :233-236 tmp+rename 原子写）；`listStoriesMeta` :431-432 parse 失败落入 :438 catch `continue`，不回退读 state.json（回退分支 :435-437 仅 metaPath 不存在时可达）。损坏后书从书架消失成立。

### H14 — **confirmed**

`storage.ts:287` `JSON.parse(readFileSync(...))` 无 try/catch（loadWorld 只查 :286 existsSync）；`:212` 每次 saveWorld 前 `copyFileSync` 写 `.bak`；全仓 grep `.bak` 仅命中 :1（注释）与 :212（写入），**零读取点**。.bak 是死代码成立。

### H15 — **confirmed**

`director.ts:189-190` 立项段 2 `mergeConcurrentMedia(w); saveWorld(w)` 持段 1 旧快照；`storage.ts:300-316` `mergeConcurrentMedia` 只合并 cover（:304）与角色 `image/portrait.path/visualTriedAt`（:305-311），**无 changeLog 合并**；后台 ensureCharacterVisuals/ensureCover 锁内写 `avatar-auto/portrait-auto/cover-auto/visual-fail` 日志（routes.ts:239/243/246/264/309/324），段 2 保存覆盖回空。审计日志丢失成立（媒体字段因 merge 不丢）。

---

## Medium 逐条

### M1 — **confirmed**

`media.ts:486-499`：`:490` 男性分支 `if (/中年|四十|五十|老年|六十|老妪|老丈/.test(hay)) return "成年男子"`（误含女性称谓"老妪"）；`:496` 女性老年分支只含 `中年|四十|五十|老年|六十`，`老妪/七十/八十/老妇/婆婆` 落入 `:497 return "年轻女子"`。正则缺陷为代码事实（token 来源为用户手填 age/identity 或 AI 文本）。

### M2 — **confirmed**（行号偏移 +4）

`director.ts:974-977` 删角色循环内 `deleteMediaFile(world.title, c.portrait.path / c.image)` 同步执行；路由 `routes.ts:1432 editWorld` → `:1451 saveWorld`（文档写 :1447）。saveWorld 失败则盘上文件已删而 state.json 仍引用 → 裂图。

### M3 — **confirmed**（subagent 曾误判 partial，人工复核后维持文档描述正确）

- ensureCharacterVisuals 部分：`routes.ts:230-244` 锁内复查 `:235 aOk = Boolean(avatar) && !cc.image`、`:236 pOk = portraitFresh && !cc.portrait?.path`，`:237/241` 仅 aOk/pOk 为真才落盘，为假时刚生成的 `avatar.path/portrait.path` **不删除** → 泄漏。属实。
- ensureCover 部分：`routes.ts:295-313`。竞态输家路径 `:306` `if (!w2 || w2.cover) return { path: w2?.cover ?? p, oldRel: w2?.cover ? "" : p };`——注意三目：当 `w2.cover` 已存在（竞态输家）时 `oldRel` 为**空串 `""`**（不是 `p`），`:313` `if (oldRel && oldRel !== path)` 条件不成立，**新生成的封面文件 p 不会被删除** → 泄漏。FIND_BUG.md 对 ensureCover 的描述（"竞态输家不删自己刚写的文件"）**正确**；审计 agent 一度误读为"313 行会删新图"，经人工复核驳回。仅当 `loadWorld` 返回 null（书已删）时 `oldRel = p`，313 行 `p !== p` 也为 false，同样不删（但书已删场景无意义）。

### M4 — **confirmed**

`routes.ts:2189` 锁前快照 → `:2233 pollVideoTask`（videos.ts 无状态查询、不领取任务）→ `:2249 downloadVideo` 锁外双下载 → `:2250-2258` 锁内 `saveVideo` 各自写不同文件名、后写覆盖 `m.path` 无 status 复查；失败分支 :2235-2247 同样无复查。双倍带宽 + 先写 mp4 成孤儿成立。

### M5 — **confirmed**

视频路径 :2235-2266（failed/超时/中断/ready）均无 `publishSync`；图片路径 `:2160-2169` 与视觉完成 `:2299-2306` 都有。其他 tab 停在"生成中"直到自己轮询。

### M6 — **confirmed**

`routes.ts:2094-2122` 章节图后台任务调用 `generateSceneImage`（:2106）前无 `deleted()` 短路（对照 ensureCharacterVisuals :200/212、ensureCover :299 均有），删书后图片仍生成、结果才在锁内 :2127 丢弃。

### M7 — **confirmed**

项目确有真实 SSR 链路（`server/entry-server.tsx:6-7` renderToString、`server/render.ts:9` 注入 index.html）。`Masthead.tsx:26-27` 用 `toLocaleDateString/toLocaleTimeString`（运行时本地时区），SSR 用服务器时区、hydrate 用浏览器时区 → hydration mismatch 成立。

### M8 — **confirmed**（Home.tsx 行号偏移 +24）

`BrainCabin.tsx:974` `if (e.key === "Enter" && !e.shiftKey)` 无 isComposing 检查；`Home.tsx:2665`（文档写 :2641）onKeyDown 同样无检查；`ForeshadowModal.tsx:103/105/107` 三个输入框均 `if (e.key === "Enter")` 无检查。三处均无 `isComposing || keyCode === 229` 防护。

### M9 — **confirmed**（行号偏移约 +24）

`Home.tsx:2271-2273` Effect 1 按 `anyOpen` 布尔设 `overflow:hidden`；`:2314` Effect 2 cleanup 在依赖（chapterMenu/advanceMenu 等）变化时**无条件** `document.body.style.overflow = ""`。Settings 打开时开章节下拉 → cleanup 复位滚动锁，冲突成立。Effect 1 依赖清单不含 `showBrainCabin/showTaskCenter/showForeshadow/showEval` 等，这些弹窗确实不锁滚动。

### M10 — **confirmed**

`useSyncChannel.ts:48` `lastVersionRef = useRef(0)`；`:62` effect 内 `connect()`（:73-85）创建新连接**不重置**；唯一重置点 `:110` 收到 `subscribed` 时；`:117` `if (obj.version <= lastVersionRef.current) return`。订阅生效→ack 到达的窄窗口内低版本 `world-changed` 被丢弃。**额外发现（比文档更严重）**：`useRef` 跨 title 持久，换书后残留旧书高版本戳，而服务端 `worldVersions` 按 per-title 独立递增（sync.ts:160-162），新书收到 `subscribed` 前的事件（version 从低值起）会全部被误丢——换书丢事件窗口大于文档所述的重连场景。

---

## Low 逐条

### L1-L12 — 全部 confirmed

- **L1**：`planner.ts:273-275` 弧摘要 `summarizeRange(from,to)`（弧区间）；`:282` 卷摘要 `summarizeRange(w, from, Math.max(to, 1))` **复用当前弧的 from/to**，非全卷区间；`:284/318` updateCompass 拿到不完整卷摘要。属实。
- **L2**：`critic.ts:48-51` 注释决策表"minor-only → pass"；`:62-64` 实际 `if (llmVerdict !== "pass") return findings.length ? { action: "patch", floorFail } : { action: "pass", floorFail };`——LLM 判 revise 时只要有 findings（哪怕全 minor）就走 patch，注释与代码自相矛盾。属实。
- **L3**：`writer.ts:179-189` 空正文只重试一次、仍为空不抛错；`:218` 直接返回；`director.ts:421` 仅 `requirePass` 时抛错，step 路径（:684-691）不传 requirePass → commit 空文本章；autorun（routes.ts:1689）有 `requirePass: true` 保护。属实。
- **L4**：`director.ts:697-698` `JSON.parse(pending.verdictJson)` 无 try/catch；`storage.ts:334-343` loadPendingChapter 只校验 `chapterIndex/text`。属实。
- **L5**：`director.ts:1174-1178` regenerateChapter 初次写作保留 plan；`:1207`（文档写 :1206）重写分支 `plan: null` 硬编码；对照 reviewFixLoop rewrite 分支 :490-497 保留 plan。属实。
- **L6**：`director.ts:467-470` `rounds` 初值 0、`verdict.round = rounds`；`:474-483` patch 分支 rounds 不变；`:484-485` 仅 rewrite 分支 `rounds++`。属实。
- **L7**：`routes.ts:1785` `/api/novel/chapter/resettle` 直接 `settleChapter` 无 `resetChapterLedger`；对照 :2652 integrity resettle 先 reset（:2646 注释明示防重复埋设）。属实。
- **L8**：`routes.ts:1446/1448` 改名 `renameSync(storyDir(updated.title), storyDir(bookTitle))`；`autorun.ts:141-142` `const w0 = load(); if (!w0) return finish(...)`；load 闭包（routes.ts:1691）持启动时旧 title；改名后旧 slug 目录消失 → loadWorld 返回 null → 连载终止。`visualTasks/visualInFlight`（routes.ts:156/158/176）key 含旧 slug，改名不清理。**措辞修正**：终止并非完全"静默"——`finish` 会经 SSE 发 `auto-done`（routes.ts:1695）并以 `reason:"error"` 收尾，但"连载被杀"的断言成立。
- **L9**：`steering.ts:164`、`brain.ts:135` 均 `[...existing, task].slice(0, 3)`——已有 3 条时丢弃新注入任务。属实。
- **L10**：`routes.ts:1155-1156` plantedAt 仅 `typeof number` 判断无范围/章号存在性校验；`:1164-1166` status 任意串直接赋值，`world.ts:441-442` 按 `status !== "resolved"` 计活跃，非法值当作 active。属实。
- **L11**：`storage.ts:328` savePendingChapter、`:377` saveAutoSession 均直接 `writeFileSync` 无 tmp+rename（对照 :233-236 state.json 原子写）；load 端（:338/387）catch 返回 null。属实。
- **L12**：`routes.ts:1119-1120` EPUB 分支无 try/catch；`storage.ts:541-544` `exportEpub` 用系统 `zip` 二进制 `spawnSync`，status !== 0 抛错；异常逐层逃逸（handleNovelApi :839 switch 无全局 try → handleApi :412-416 → server/dev.ts:111、server/prod.ts:52 均无 try）→ 非 JSON 通用 500。文档自称"PLAUSIBLE"，实测链路全部落定，可升级为 confirmed。

### L13 — **confirmed**

`media.ts:1094-1096` `mediaId()` 返回 `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`；`shared/uuid.ts:7-24` 已有 `crypto.randomUUID` 优先的完整实现。随机段 4 位 base36（36⁴ = 1,679,616），同毫秒并发碰撞概率 ≈1/168 万，与文档数字吻合。

### L14 — **confirmed**

`scripts/refresh-visuals.ts:31` 只改内存 `c.image`，`:32` 立即 `deleteMediaFile` 删旧头像，`:54` 才 `saveWorld`（注释 :3 自称"每完成一项立即落盘（中断可重跑…）"）。:32 与 :54 之间硬中断 → state.json 指向已删文件。属实（重跑可重新生成恢复，但中断瞬间存在不一致，与承诺矛盾）。

### L15 — **confirmed**（行号偏移 +4；附加句存疑）

`routes.ts:2395`（文档写 :2391）`if (snap.kind === "image" && snap.oldPath === undefined && newMedia.path) deleteMediaFile(...)`——仅 image 且 oldPath 为 undefined 时删新图；常态（视频或 oldPath 有值）swap 失败（:2377 媒体已被删 → swapped=false）时新文件不删 → 泄漏。**附加句"删书还可能重建旧 slug 目录"无法证实**：删书路径（:947-971）登记 `deletedStories`（:969）且后台任务写盘前自查，现有代码未见可触发重建路径，此句存疑（不影响主断言）。

### L16 — **confirmed**

`BrainCore.tsx:75-78` `const DPR = 2; canvas.width = 100 * DPR; ... ctx.scale(DPR, DPR);` 硬编码 2，未用 `window.devicePixelRatio`。

### L17 — **partial**（定时器未停属实；"持续请求上一本书"不实）

- **属实**：`Home.tsx:1879-1890` 轮询 effect，`:1880 if (!world || autoCheckedRef.current === world.title) return;`——world 变 null 回首页时提前 return，**未调 `stopSysPoll()`**，`:1866` 的 3s `setInterval` 继续运行（组件未卸载，:1876 的卸载 cleanup 不触发）。
- **与文档不符**：文档称"3s 间隔持续请求上一本书"。实际 `pollSysStateOnce` 首行 `:1801 if (!world) return;`——world 为 null 时**直接返回，不发任何网络请求**，定时器只是空转。另 `autoCheckedRef` 已置为旧 title，重开同一本书时 :1880 也提前 return，不会重复 startSysPoll。影响为"空转定时器 + 重开书时轮询未重启"，远轻于"持续请求上一本书"。

### L18 — **partial**（4 项属实，打字机子项不成立）

- **媒体轮询 `BrainCabin.tsx:1330-1352` confirmed**：`pollMediaGen` 用 `window.setInterval(..., 3000)`，timer 为函数局部变量，仅全部完成（:1346 clearInterval）或单次请求非 2xx 时清理，无 ref、无卸载 cleanup。
- **拖拽监听 `BrainCabin.tsx:1011-1035` confirmed**：window `pointermove/pointerup`（:1031-1032）与 body cursor/userSelect（:1033-1034）只在 `onUp`（:1022-1029）移除/还原，无卸载清理。
- **打字机 `BrainCabin.tsx:417-437` partial**：effect 依赖 `[]`、`setInterval(..., 24)` 常驻（41.7Hz 空转属实），但 **`:435 return () => clearInterval(t);` 存在卸载清理**——它不泄漏。FIND_BUG.md 正文"组件整个生命周期常驻"描述准确，但放在"未在卸载清理"标题下不成立。
- **writingTimer/delTimer `BrainCabin.tsx:405/476/1266` confirmed**：仅 :1152（新任务开始）清 writingTimer、:494/501（下次交互）清 delTimer，无卸载 cleanup 引用，卸载后仍触发 setState。
- **GachaModal `:50-58, :104` confirmed**：错峰揭晓与自动关闭的 `setTimeout` 返回值未保存，全文件无 useEffect/clearTimeout，卸载后照常触发。

### L19 — **confirmed**

`BrainCabin.tsx:841-853` `msg.cards?.filter(c => c.kind !== "ask").map((card, i) => <BrainCardView key={i} completed={completed.has(\`${msg.id}:${i}\`)} ...`——过滤后 index 作 key 且 completed 键用过滤后索引；标记侧 `confirmChoose`（:1355-1364）的 `cards.findIndex(...)` 用**未过滤**数组，ask 卡位于 confirm/preview 之前时（如 `[ask, preview]`）标记存 `msgid:1`、渲染读 `msgid:0`，完成态不显示。**细节修正**：`executeCard` 路径（:848）传入的也是过滤后索引，与渲染一致；索引不一致仅存在于 `confirmChoose` 路径。文档行号准确。

### L20 — **partial**（核心不变量存在，覆盖面被夸大）

- **成立**：`routes.ts:373-377` `sweepVisualGaps()` 调 `sweepVisualGapsFor("")` → `listStories()` 无参 → `storage.ts:42-45 dataDirFor()` 依赖 ALS `currentUser()`——ALS 为空才扫根目录，若在请求上下文内误调用会扫当前用户目录。`advancetask.ts:163-167` `cleanupStaleAdvanceTasks()` 调 `cleanupStaleForDir("")` 扫根（userDir("") 显式根，不依赖 ALS），但回写 `:180 saveAdvanceTask(slug, ...)` → `taskPath` → `storyDir` → `dataDirFor` → `currentUser()` **依赖 ALS**，ALS 为空时恰好一致。
- **不成立（夸大）**：`routes.ts:2731` `migrateLegacyOnBoot` → `storage.ts:64-65` **显式** `join(process.cwd(), "data")` 扫根，不依赖 ALS；`newtask.ts:147` `cleanupForDir("")` 用 `userDir("")` 显式扫根、回写 `saveNewStoryTasksForDir(next, username)` 显式传 username，完全不依赖 ALS。文档把四个位置统一概括为"靠 ALS 上下文为空工作"过宽；脆弱不变量（sweepVisualGapsFor 扫描 + advancetask 回写）本身存在。

### L21 — **confirmed**

`anysearch.ts:54-60` 只查 `res.ok`（:54）与顶层 `data?.error`（:55），遍历 content 只看 `type === "text"`（:58），不检查 `content[].isError`——`content[{type:"text", isError:true}]` 被当成功文本返回。行号准确。

### L22 — **confirmed**

`videos.ts:11-12` `AGNES_VIDEO_BASE = (env.AGNES_BASE_URL ?? 默认).replace(/\/$/,"")`、`AGNES_VIDEO_HOST = AGNES_VIDEO_BASE.replace(/\/v1$/, "")`；`:73` 创建任务走 `${AGNES_VIDEO_BASE}/videos`、`:111` 轮询走 `${AGNES_VIDEO_HOST}/agnesapi?video_id=...`。若 `AGNES_BASE_URL` 不以 `/v1` 结尾，两者路径体系不一致。默认配置正常。

### L23 — **confirmed**

`videos.ts:139-144` `downloadVideo`：`:142` `new Uint8Array(await res.arrayBuffer())` 先整包读入，`:143` 才检查 `> MAX_VIDEO_BYTES`（:22 定义 100MB）。先缓冲后拒绝成立。

### L24 — **confirmed**

`images.ts:82-87` `saveImage` 与 `videos.ts:148-152` `saveVideo` 均为 `join(storyDir(title), "images|videos") + writeFileSync(join(dir, name), data)`，无 norm/前缀守卫；对照 `readImage`（images.ts:90-102，:94-95 有 norm 前缀校验）、`deleteMediaFile`（:105-117，:108-109 同款守卫）。当前调用方传内部生成名不可直接触发，但缺深度防御属实。

---

## 与 FIND_BUG.md 的关键差异汇总（5 条 partial 的核心）

| 编号 | FIND_BUG.md 声称 | 实际代码 | 影响 |
|---|---|---|---|
| C1 | `identityDress()` 恒返回非空串，几乎必现 | `IDENTITY_DRESS_FALLBACK = ""`（media.ts:428/599），仅命中身份/职业规则时非空 | 注入缺陷真实，但只在命中规则的角色上触发，非必现；示例文案也不符 |
| H2 | 弧/卷永远无法完成（卡死） | expandArc 新计划挂同一弧，4-7 章全 done 后弧边界仍会触发 | 后果降级为"章纲错位 + 第 3 章完成不触发弧事件"，非永久卡死 |
| L17 | 3s 间隔持续请求上一本书 | `pollSysStateOnce` 首行 `if (!world) return`（Home.tsx:1801），无网络请求 | 仅定时器空转 + 重开书不重启轮询 |
| L18 | 打字机 setInterval 未在卸载清理 | `BrainCabin.tsx:435 return () => clearInterval(t);` 有 cleanup | 该子项不成立；其余 4 项（媒体轮询/拖拽/writingTimer/GachaModal）成立 |
| L20 | 四处根目录扫描均依赖 ALS 为空 | 仅 sweepVisualGapsFor 扫描与 advancetask 回写依赖 ALS；migrateLegacyOnBoot/newtask 显式扫根 | 脆弱不变量存在但覆盖面夸大 |

## 审计过程中的 agent 误读纠正（供参考）

- **M3 ensureCover**：审计 agent 一度判"文档描述与代码相反（ensureCover 竞态输家会删新图）"，主 agent 复核 `routes.ts:306` 三目 `oldRel: w2?.cover ? "" : p`——`w2.cover` 存在时 `oldRel` 为空串，`:313` 不删除新图，**FIND_BUG.md 描述正确**，维持 confirmed。
- **L15 附加句**"删书重建旧 slug 目录"经核查无触发路径，判定存疑（不影响主断言）。

## 复核中额外确认的 FIND_BUG.md 未提及细节

- M10 换书场景 `lastVersionRef` 跨 title 不重置，新书 ack 前事件被误丢，比文档所述重连场景更严重（见 M10）。
- C2 忙碌检测除 `autoRunning/writingRunning` 外还读 `systemStatus/server.advanceTaskRunning/mediaGenerating`（均为请求体自报，不影响结论）。
- L8 连载终止会经 SSE 发 `auto-done(reason:"error")`，"静默"一词略偏强。
- L12 文档自称 PLAUSIBLE，实测异常传播链路完整（spawnSync zip 失败 → 非 JSON 500），可升级为 confirmed。
- C3/C4/C9/H9/H10/H11/L7 等条目的对照行号普遍偏移 +4 行（文档基线较代码新 4 行左右），行为描述均一致。

## 结论

FIND_BUG.md 记录可信度高：**52/58 条完全属实，5 条部分属实（核心缺陷均真实，仅触发条件/后果/覆盖面描述有误），0 条误记**。未发现模型凭空捏造的缺陷。修复优先级建议总体合理；C1、H2、L17、L18、L20 五条在实施修复前应参照本文件修正对触发条件与影响范围的预期。
