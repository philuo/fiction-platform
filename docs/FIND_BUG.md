# FIND_BUG — 系统缺陷盘点

> 生成时间：2026-08-11
> 方法：5 个审计 agent 并行深读 `src/api/**`、`src/components/**`、`server/**`，交叉验证调用链与边界条件；
> 关键 finding 由主 agent 复核源码确认。基线：`tsc --noEmit` 通过，`bun test` 551 pass / 0 fail
> （故下列均为测试未覆盖的真实缺陷，而非编译/显式失败）。
>
> 严重级别：**Critical**（数据丢失/串号/必现功能失效）> **High**（常见操作触发，状态或配额受损）
> > **Medium**（边界/并发触发，体验或一致性问题）> **Low**（健壮性/展示质量）。
> 标注 `[交叉确认]` 的条目被 ≥2 个审计 agent 独立命中。

---

## Critical

### C1. 所有人物主体的图片/视频/头像/立绘提示词被注入 `[object Object]` `[交叉确认]`
- **位置**：`src/api/routes.ts:139`、`src/api/media.ts:801`、`src/api/media.ts:845`
  ```ts
  if (idDress) segs.push(`身份服饰 ${idDress}${c}`);   // ${c} 是整个 Character 对象
  ...
  `...无现代元素${idDress ? `；身份服饰：${idDress}${c}` : ""}...`
  ```
- **触发**：生成/重生成任何带人物主体的章节插画、视频、角色立绘、头像——`identityDress()` 恒返回非空串（`media.ts:591` 有 fallback），所以几乎是必现。
- **后果**：提示词渲染为 `身份服饰：素色长袍[object Object]`。弱图片模型对措辞敏感（见记忆 `agnes-image-best-practices`），身份/服饰关键段被垃圾污染，直接拉低出图质量。
- **修复**：删除多余的 `${c}`。

### C2. 中枢聊天角色写操作完全绕过 title 锁，并发丢更新 `[交叉确认]`
- **位置**：`src/api/brain-chat.ts:1550,1604,1626,1655,1672`（`relationship_edit/create_character/edit_character/delete_character`）；路由入口 `src/api/routes.ts:794-825`
- **触发**：两个 tab 同时对同一本书发"新建角色"；或自动连载/推进进行中（客户端忙碌标志过期）时发角色增删改。前置"忙碌检测"（`brain-chat.ts:1532`）只读请求体里客户端自报的 `autoRunning/writingRunning`，软标志可过时也可被构造请求省略。
- **后果**：`loadWorld → 改内存 → saveWorld` 全程无 `withTitleLock`，两次保存基于同一旧快照，后写覆盖先写——一个新建角色被吞，或无锁保存覆盖连载刚提交的章节。`saveWorld` 是原子 rename 但基于旧快照，属典型 last-write-wins 数据丢失。
- **修复**：所有 world 写操作包进 `withTitleLock(slug(title))`，锁内重新 `loadWorld` 后再改。

### C3. 视频重生成先删旧 mp4、新任务失败即永久丢失 `[交叉确认]`
- **位置**：`src/api/routes.ts:2378-2395`
- **触发**：重生成任一视频。图片路径是"生成完成再替换"，视频路径 `createSceneVideo` 只创建异步任务，swap 立即把 `m.path=undefined, status="pending"`，并在 `:2395` 同步 `deleteMediaFile(snap.oldPath)`。
- **后果**：新任务随后失败/超时，旧视频已删，永久数据丢失，无回滚。
- **修复**：旧文件移到待清理，仅在 `/media/status` 收到完成回调、新 mp4 落盘后才删除。

### C4. 视频重生成不重置 `createdAt`，新视频立即被判超时 `[交叉确认]`
- **位置**：`src/api/routes.ts:2378-2382`（swap 只拷 `videoId/path/status`）；超时判定 `routes.ts:2213`（`Date.now() - media.createdAt > 30min`）；`createdAt` 仅在 `createSceneVideo`（`media.ts:1177`）设置。
- **触发**：重生成一个首次创建已超过 30 分钟的视频（回看旧章重滚视频很常见）。
- **后果**：下一次 `/media/status` 轮询立即命中 30 分钟超时，把刚提交的新任务标 failed（Agnes 端仍在跑，配额白烧）。与 C3 叠加：旧文件已删、新任务秒失败。遗留视频缺 `createdAt` 则有反向问题——超时被跳过，任务永久 pending。
- **修复**：swap 时写入 `m.createdAt = newMedia.createdAt`，并清 `m.error`。

### C5. 前端 IndexedDB 会话缓存"只写不读"，且切书时清错书
- **位置**：`src/components/brainCache.ts:44`（`cacheGetSession` 导出但全仓零调用，已 grep 确认）；清错书 `src/components/useBrainSession.ts:569-576`
  ```ts
  loadedTitleRef.current = title;                 // 已更新为新书
  ...
  void cacheClearBook(loadedTitleRef.current);    // 清的是新书，不是上一本
  ```
- **触发**：每次切书/打开对话舱。
- **后果**：(a) 宣称的"秒开"完全失效——每个会话永远走网络；(b) 清缓存逻辑清的是新书而非旧书，跨书串扰防护形同虚设。
- **修复**：先捕获旧 title 再 clear；在 `openSession` 拉取前先 `cacheGetSession` 命中则用缓存做首屏。

### C6. BrainCabin 卸载时 SSE 不 abort，关弹窗后服务端继续烧配额
- **位置**：`src/components/useBrainSession.ts`（全 hook 仅 `:567` 一个 useEffect，无 unmount cleanup）；`abortRef.current.clear()`（`:571`）只清空 Map 不调 `.abort()`。
- **触发**：中枢流式回复中途关闭对话舱/切书。
- **后果**：所有 AbortController 被丢弃，SSE fetch 继续运行；服务端 `req.signal.aborted` 永不置位，LLM 继续生成到完（白烧 token）；30s 空闲定时器、idleTimer 也泄漏。hook 头部注释 `:3` 自称"abort 仅由停止/卸载触发"，但卸载分支未实现。
- **修复**：加 unmount effect 遍历 `abortRef` 逐个 abort 并 clearInterval。

### C7. 切书竞态：推进/连载流完成后把旧书状态覆盖到新书
- **位置**：`src/pages/Home.tsx:842,845`（advance）、`:1927`（autoRun）
- **触发**：点击推进/开始连载（数分钟流式），中途点报头返回或故事卡片打开另一本书。`advance/startAutoRun` 是普通函数，闭包捕获点击时的 `world`，无 AbortController；`backToList/openStory` 不检查 `busy`。
- **后果**：流完成时 `await refreshWorld()` 拉的是旧书状态并 `setWorld`，把用户拽回旧书；`setStoryUrl(world.title)` 也写旧书名到 URL。
- **修复**：请求携带当前 title 作为守卫，回包时比对当前选中书，不符则丢弃；导航期间禁止/中止进行中的流。

### C8. 主体角色无立绘时借用他人头像做 i2i 参考——换脸
- **位置**：`src/api/media.ts:717-723`（`findCharacterRef`）、`:753-760`（`findVideoFirstFrame`）
- **触发**：章节结算后新角色尚无 portrait，而该场景 anchor 里同时提到一个已有 portrait 的旧角色。代码在 subject 无 portrait 时不 bail out，而是 `w.characters.filter(...names.includes...).map(portrait).find(Boolean)` 抓任意一个有 portrait 的角色（roster 顺序优先）。
- **后果**：i2i 前缀明确要求"不得改变样貌或换人"，结果新角色被画成旧角色的脸。新章结算后立即触发媒体生成时概率很高。
- **修复**：subject 无 portrait 时返回 undefined，回退纯文生，不要借脸。

### C9. 编辑/回滚/重生成章节不撤旧账就重结算，伏笔残留 + delta 丢失
- **位置**：`src/api/director.ts:1091-1093`（editChapter）、`:1136`（rollback）、`:1224`（regenerate）；对照正确实现 `src/api/routes.ts:2648`（integrity resettle 先 `resetChapterLedger`）
- **触发**：一章 commit 后埋设了伏笔 F、把角色状态 A→B 并写入 delta；之后编辑/回滚/重生成使新正文不再埋设 F 或状态不再变 B。三条路径直接再调 `settleChapter`，再用新结果整体覆盖 `chapterDeltas[index]`。
- **后果**：
  - `applySettle` 只增/改伏笔不删除（`chronicler.ts:130`），F 残留在账本里而正文已无；
  - 新 delta 基于"已被首次 commit 改过的世界"生成，旧值 A 永久丢失；
  - 将来删章用被覆盖的空 delta 做逆操作，无法回退到 A，回滚不完整。
- **修复**：三条路径在 settle 前统一先 `resetChapterLedger(w, index)`。

---

## High

### H1. `reviewFixLoop` 在 `patched=false` 时从不回退整章重写
- **位置**：`src/api/director.ts:472-483`
- **触发**：critic 判 `patch`，但 major findings 命中段落占比 >50%（`patch.ts:45`）、LLM 未返回 `【段落N】`、或定位不到段落，`patchChapter` 返回 `{patched:false}`。`patch.ts` 文件头（`:1-2,38`）和 harness 表（`harness.ts:62`）都声明此时应回退整章重写，但代码缺 else 分支。
- **后果**：空转两次相同的失败 patch（白烧 2 次 LLM 调用）；退出时 `verdict.action` 仍是 `patch`——step 模式直接 commit 本应整章重写的稿子，autorun 模式则误判审查失败进暂存。
- **修复**：`if (!pr.patched) { verdict = { action: "rewrite", findings, ...}; continue; }`。

### H2. 删尾章后重写：章纲错位、弧永远无法完成
- **位置**：`src/api/planner.ts:157-251`（关键 `:160,163-165,181,214,250-251`）
- **触发**：某弧展开为章纲 3/4/5 → 写完第 3 章 → 删除第 3 章（尾章，`deleteChapterCascade` 回退 nextChapter=3、删 plan 3、保留 plan 4/5）→ 重新推进写第 3 章。`ensureChapterPlan(w,3)` 找不到 index=3 的 plan，不检查缺口直接对当前弧 `expandArc`；`expandArc` 算 `startIdx=3+2=5`，safeStart 跳过已占用的 5 → 6，在 6/7 创建计划但 prompt 告诉 LLM"从第 5 章开始"；最终 `created.find(p=>p.index===3) ?? created[0]`（`:251`）返回第 6 章计划。
- **后果**：第 3 章拿着第 6 章的目标/节拍写作；`markChapterDone(w,3)` 找不到 plan 3，弧边界永不触发，弧/卷卡死无法收束。
- **修复**：`ensureChapterPlan` 发现缺口章号时应先填补该 index，而不是追加到尾部。

### H3. 自动抽卡/考据/展开弧在打断检查之前就落盘，违反"未 commit 零污染"
- **位置**：`src/api/director.ts:344-381`（抽卡应用 `:344`，而第一次打断检查在 `:377`）；`ensureResearch` 内部 save `:277`；`healLegacyStory` `planner.ts:394`；`expandArc` `planner.ts:230`
- **触发**：autoGacha 开启时管线先把伏笔卡以 `plantedAt=nextChapter`、note「待埋设」预登记进 `world.foreshadowing`，随后子函数 `saveWorld`；此时若 steering 打断已置位、审查未通过、或弧边界展开后被打断，副作用已落盘。
- **后果**：未 commit 的章节留下"待埋设"伏笔、已用卡、角色提案、考据世界书条目；跳过该章后预登记伏笔 plantedAt 落到空洞章号且 `< nextChapter`，变成 dangling orphan，并让 `isBookComplete` 永远 false。
- **修复**：把打断检查前移到任何 saveWorld 之前；或抽卡/考据改为 commit 阶段才落盘。

### H4. 改名用朴素子串替换，污染其他角色/地名/物品名
- **位置**：`src/api/director.ts:993-1040`，核心 `const rep = (s) => s.split(from).join(to);`（`:994`）
- **触发**：把角色「王林」改名为「王虎」，而书中另有「王林之」「王林楼」。重名检查（`:928`）只做精确相等判断，挡不住子串。
- **后果**：正文里「王林之」→「王虎之」；花名册里「王林之」仍在，但 `recomputeAppearedIn` 按 `includes` 匹配不到，登场记录被清空；中文 2-3 字名互为子串很常见。
- **修复**：对人名用分词/边界感知替换（至少按非名字字符边界），替换后重算 appearedIn 并校验花名册冲突。

### H5. `/api/novel/state` AppError 无 try/catch，变成非 JSON 500
- **位置**：`src/api/routes.ts:910`（`throw new AppError("故事不存在")`），`handleApi/handleNovelApi` 与 `server/prod.ts:52` 均不包该层。
- **触发**：轮询/打开一本刚被另一 tab 删除的书，或任何不存在 title。
- **后果**：Bun 返回通用 500 无 JSON body，前端拿不到 `{error:"故事不存在"}`，与其他路由的 404 行为不一致。
- **修复**：该路由包 try/catch 或在统一错误处理层兜住 AppError。

### H6. `/api/chat/stream` 未传 AbortSignal、enqueue 无保护，断连后继续烧配额
- **位置**：`src/api/routes.ts:538-547`（对比 `/api/brain/chat` 正确接了 `req.signal`：`:816,820`）
- **触发**：开始流式回复后中途关 tab。
- **后果**：上游 LLM 继续读完（白烧配额）；断连后 `controller.enqueue` 抛错进 catch，catch 里再向已关闭 controller enqueue error、finally close 又抛。
- **修复**：把 `req.signal` 透传给 `agnes.chatStream`，enqueue 前检查 `controller.desiredSize` 或 try/catch。

### H7. 流式重试把已输出内容重复推给前端
- **位置**：`src/api/agnes.ts:117-143,302-343`；受影响 `routes.ts:538`（chat/stream）、`brain-chat.ts:814-850`（streamChatReply retries:2，`acc += delta` 不重置）
- **触发**：流式生成中途网络抖动/上游断流，`isRetryableError` 判真触发重试。
- **后果**：前半段 delta 已回调过，重试从头再回调一遍——chat/stream 客户端收到重复文本；中枢会话落库成"前半段+完整段"重复拼接。
- **修复**：重试前重置累计缓冲，或用 SSE 序列号让客户端去重。

### H8. 回溯重写队列在首章失败/打断时被整盘清空
- **位置**：`src/api/routes.ts:1812-1820`
  ```ts
  for (const i of queue) {
    try { await regenerateChapter(...); rewritten++; }
    catch { break; /* 注释称"剩余保留在队列" */ }
  }
  w.rewriteQueue = [];   // 无论从哪 break 都无条件清空
  ```
- **触发**：对 ≥2 章应用"rewrite"干预策略，首章被用户干预打断（抛 `InterruptedError`）或 LLM 失败。
- **后果**：后续待重写章节静默丢失，日志却写"消费完成（重写 N 章）"。
- **修复**：`w.rewriteQueue = queue.slice(rewritten + 1)`（break 时）或循环内直接 shift 已完成项。

### H9. 每章插画上限校验是 TOCTOU，可被并发绕过
- **位置**：`src/api/routes.ts:2055-2059`（锁外读 `existingImgs` 校验）vs `:2062-2085`（锁内 append）
- **触发**：对同一章并发两个 `/media/generate`（各带 3 个有效场景）。
- **后果**：两请求都读到 `existingImgs=0` 通过 `<=3` 校验，各自追加 3 张，章节出现 6 张，突破 `MAX_IMAGES_PER_CHAPTER=3`。
- **修复**：计数检查移到锁内、对新加载的 w 做。

### H10. failed 视频每次轮询都重复打外部 API，且错误不持久化
- **位置**：`src/api/routes.ts:2190-2242`（图片分支 `:2192` 有 failed 早返回，视频没有；超时分支只匹配 `pending`；`:2236` 置 failed 时未写 `m.error = st.error`）
- **触发**：视频失败后前端继续轮询/刷新。
- **后果**：每次轮询都调一次 Agnes 状态接口；远端 task 过期后 catch 返回 502 `{error}`，而非前端预期的稳定 `{ok:true,status:"failed"}`。
- **修复**：视频分支加 failed 早返回；失败时持久化 error。

### H11. 手动生成封面/头像把网络生成放在 title 锁内，长持锁阻塞所有写
- **位置**：`src/api/routes.ts:1896-1928`（cover `:1907`、avatar `:1919` 都在 `withTitleLock` 内 `await generateImage`）；同文件立绘生成（`:1954`）和章节媒体都是"锁外生成、锁内短事务"。
- **触发**：点"生成封面/头像"时同时有自动连载/推进排队。
- **后果**：该书所有写操作被阻塞 30-150s；JSON POST 无心跳，超过 Bun idleTimeout(255s) 可能连接重置而服务端仍在干活。
- **修复**：照立绘路径改成锁外生成、锁内落盘。

### H12. 删书后 brain-sessions 内存缓存不失效，同名重建复活旧会话 `[交叉确认]`
- **位置**：`src/api/brain-sessions.ts:60,81-95`（模块级 `cache` Map，无任何 `cache.delete`）；删书 `src/api/routes.ts:947-971`
- **触发**：删一本书后用同书名重新立项（slug 相同即命中）。
- **后果**：新书继承被删书的全部中枢聊天历史/卡片/进度；即使不重建，删书后的中枢接口仍能读到"已删书"会话。数据串号/隐私问题。
- **修复**：删书路径调 `cache.delete(slug(title))`（需导出清理函数）。

### H13. meta.json 非原子写、损坏后吞书不回退 state.json `[交叉确认]`
- **位置**：`src/api/storage.ts:245`（普通 `writeFileSync`，无 tmp+rename）；列表读取 `storage.ts:428-440`（meta 存在但 `JSON.parse` 失败 → `continue` 跳过，不回退读 state.json）
- **触发**：写 meta.json 途中崩溃/掉电留下截断 JSON（state.json 本身是好的，且是原子写）。
- **后果**：该书从书架消失，用户进不去，直到下次 saveWorld 重写 meta。
- **修复**：meta.json 改 tmp+rename 原子写；解析失败时回退 state.json 重建 meta。

### H14. `loadWorld` 无 try/catch，`state.json.bak` 备份从不用于恢复 `[交叉确认]`
- **位置**：`src/api/storage.ts:284-292`（直接 `JSON.parse(readFileSync)`）；备份写于 `:212`（每次 saveWorld 都 `copyFileSync` 出 `.bak`）
- **触发**：state.json 损坏（磁盘错误/外部编辑/schema 异常）。
- **后果**：所有 `loadWorld` 抛错，该书 502 打不开；每次都写的 `.bak` 是死代码。
- **修复**：loadWorld 失败时尝试读 `.bak`，成功则告警并恢复。

### H15. 立项后台增强持旧快照 saveWorld，覆盖视觉任务写入的 changeLog `[交叉确认]`
- **位置**：`src/api/director.ts:189-190`；`mergeConcurrentMedia` 只合并 cover/image/portrait/visualTriedAt（`storage.ts:303-310`），不合并 `changeLog`
- **触发**：立项段 1 持旧快照，后台 `ensureCover/ensureCharacterVisuals` 在锁内写入 `avatar-auto/portrait-auto/cover-auto/visual-fail` 操作日志，段 2 保存时覆盖回空。
- **后果**：审计日志丢失（媒体字段本身因 merge 不丢）。
- **修复**：merge 函数把 changeLog 也按时间合并。

---

## Medium

### M1. `genderPhrase` 把老年女性错标成"年轻女子"
- **位置**：`src/api/media.ts:493-498`（女性老年分支只匹配 `中年|四十|五十|老年|六十`；`老妪/七十/八十/老妇/婆婆` 漏网落入"年轻女子"。男性分支 `:490` 甚至误含 `老妪`）
- **后果**：老年女性被画成年轻女性。
- **修复**：补全老年女性 token；从男性分支移除 `老妪`。

### M2. `editWorld` 删角色先删盘后存档，失败无回滚
- **位置**：`src/api/director.ts:974-977`（`deleteMediaFile` 在 editWorld 内同步执行）；路由 saveWorld 在 `routes.ts:1447`
- **触发**：删角色后 `saveWorld` 失败（磁盘满/权限）。
- **后果**：头像/立绘文件已删但 state.json 仍引用，重载后裂图。其他路由都是提交后才删文件，唯独此处相反。
- **修复**：editWorld 不做磁盘副作用，由路由在 saveWorld 成功后删。

### M3. 自动视觉生成竞态失败时孤儿文件残留
- **位置**：`src/api/routes.ts:227-250`（ensureCharacterVisuals：锁内发现 `cc.image/portrait` 已被并发手动生成填好，刚写的 `avatar.path/portrait.path` 不删）；`:304-313`（ensureCover 同理）
- **后果**：竞态输家的文件泄漏在盘上（违反记忆 `media-cleanup-on-regen-remove`），等 integrity 孤儿巡检才回收。
- **修复**：竞态输家分支删除自己刚写的文件。

### M4. 并发 `/media/status` 双重下载已完成视频
- **位置**：`src/api/routes.ts:2244-2260`（早返回用锁前快照；两个 tab 同时看到 pending 都 `pollVideoTask` 拿到 completed，都 download，锁内未复查 `m.status`）
- **后果**：双倍带宽、第二个下载覆盖 `m.path` 致第一个 mp4 孤儿；失败分支也有 ready→failed 竞态。
- **修复**：锁内复查 status，已 ready/failed 则跳过。

### M5. 视频完成/失败不广播到其他 tab
- **位置**：`src/api/routes.ts:2228-2267`（图片路径 `:2156`、视觉完成 `:2295` 都有 `publishSync`，视频路径没有）
- **后果**：其他 tab 停在"生成中"直到自己下次轮询。
- **修复**：视频状态翻转后 `publishSync("task-status",...)`。

### M6. 后台章节图片生成不检查 `deletedStories` 就发付费请求
- **位置**：`src/api/routes.ts:2088-2118`（ensureCharacterVisuals/ensureCover 都在每步前 `deleted()` 短路，章节图任务没有）
- **后果**：删书时图片仍在生成，配额白烧，结果才在锁内丢弃。
- **修复**：调用 Agnes 前检查 deleted。

### M7. SSR  hydration mismatch：报头日期在服务端/浏览器时区不同
- **位置**：`src/components/Masthead.tsx:26-27`（`toLocaleDateString/toLocaleTimeString` 用运行时本地时区）
- **触发**：用户与服务器时区不同（近 UTC 午夜日期还会差一天）。
- **后果**：首屏文本不一致触发 hydration mismatch。
- **修复**：SSR 端渲染固定占位，挂载后再填本地时间；或统一 UTC 渲染。

### M8. 中文输入法按 Enter 选词会误触发发送/推进
- **位置**：`src/components/BrainCabin.tsx:974`、`src/pages/Home.tsx:2641`、`src/components/ForeshadowModal.tsx:103-107`
- **触发**：中文用户打拼音按 Enter 选候选词（`isComposing=true`）。
- **后果**：发送半句消息/提前推进/提前加伏笔。对目标用户群是高频痛点。
- **修复**：Enter 处理里检查 `e.nativeEvent.isComposing || e.keyCode === 229`。

### M9. body 滚动锁效果冲突，且多个弹窗根本不锁滚动
- **位置**：`src/pages/Home.tsx:2245-2292`（Effect 1 设 `overflow:hidden`，Effect 2 的 cleanup 在一堆不相关依赖变化时无条件复位 `overflow=""`）
- **触发**：Settings 打开时再开章节"更多"下拉（chapterMenu 变化触发 Effect 2 cleanup）。
- **后果**：弹窗开着背景却可滚动；`showBrainCabin/showTaskCenter/showForeshadow/showEval/intervene` 等弹窗完全不锁滚动。
- **修复**：合并成单一 effect，依赖"任一弹窗打开"布尔值。

### M10. WebSocket `lastVersionRef` 未在新连接起点重置，窄窗口丢事件
- **位置**：`src/components/useSyncChannel.ts:48,112-118`（只在收到 `subscribed` 时重置；发 subscribe 到收到 ack 之间若收到版本号低于上书末次 seen 的 `world-changed`，去重判定 `:117` 丢弃）
- **后果**：高事件负载或服务端在 ack 前先发排队事件时丢消息。
- **修复**：新连接发起时即把 lastVersionRef 置 0/-1。

---

## Low

### L1. 卷摘要只覆盖最后一个弧的章节范围
`src/api/planner.ts:272-283`：一卷多弧时，最后弧完成触发的 `summarizeRange(from,to)` 用的是该弧区间而非全卷，指南针校准（`updateCompass`）拿到不完整摘要。

### L2. critic 对"LLM 判 revise 但只有 minor"返回 patch，与决策表矛盾
`src/api/critic.ts:62-65`：注释声明 minor-only → pass（minor 记质量债不阻塞），但代码在 `llmVerdict!=="pass"` 时只要有 findings 就返回 patch，可能把好文字改坏。

### L3. `writeChapter` 连续两次空输出仍提交空章节
`src/api/writer.ts:179-189,218`：空正文只重试一次，仍为空不抛错；step 无 requirePass 时会 commit 空文本章。autorun 有保护。

### L4. `confirmPendingChapter` 对 `verdictJson` 直接 JSON.parse 无保护
`src/api/director.ts:697`：`pending-chapter.json` 的 verdictJson 截断/损坏时抛错，暂存草稿卡死需手动删文件。`loadPendingChapter`（`storage.ts:334`）只校验 chapterIndex/text。

### L5. `regenerateChapter` 重写时硬编码 `plan:null`
`src/api/director.ts:1206`：同函数初次写作和共享 rewrite 路径都保留 plan，唯独重生成丢掉本章目标/节拍/弥合任务上下文，重写稿可能偏离章纲。

### L6. patch 修复轮不增加 round 计数
`src/api/director.ts:472-483`：patch 分支 `verdict.round=rounds` 但 rounds 不变（只有 rewrite 才 `rounds++`），审计日志"第 N 轮通过"和前端展示少计修补轮数。

### L7. 独立重结算端点漏调 `resetChapterLedger`
`src/api/routes.ts:1777-1784`（`/api/novel/chapter/resettle` 直接 settle，对照 integrity 的 resettle `:2648` 先 reset）：与 C9 同类但不同入口，伏笔/exit/delta 残留。

### L8. 改名目录会杀死进行中的自动连载
`src/api/routes.ts:1442`：`renameSync` 在旧 slug 锁内能等当前章写完，但 `runAuto` 闭包持旧 title，下一轮 `loadWorld(旧)` 返回 null，连载静默终止。`visualInFlight/visualTasks` 内存表也残留旧 key。

### L9. `mergeTasks` 上限 `slice(0,3)` 丢新不丢旧
`src/api/steering.ts:164`、`src/api/brain.ts:135`：`[...existing, new].slice(0,3)` 在已有 3 条时静默丢弃新注入的弥合任务（旧任务更可能过时）。

### L10. 伏笔 `status/plantedAt` 写入无校验
`src/api/routes.ts:1151,1161`：status 接受任意串（非法值被当作 active），plantedAt 接受负数/未来/不存在章号。

### L11. `savePendingChapter`/`saveAutoSession` 非原子写
`src/api/storage.ts:327,376`：直接 `writeFileSync` 无 tmp+rename，写盘中途崩溃致文件截断；load 端 catch 返回 null，草稿丢失或重启无法恢复连载。state.json 已是原子写，这两处未对齐。

### L12. `/api/novel/export` EPUB 失败是非 JSON 500
`src/api/routes.ts:1116`：EPUB 路径 `exportEpub` 在 zip 二进制缺失/失败时抛错到 Bun 成通用 500（PLAUSIBLE，取决于部署环境）。

### L13. `mediaId()` 用 `Math.random` 而非 crypto `uuid()`
`src/api/media.ts:1094-1096`：同毫秒并发（每章最多 3 图）有 ~1/168 万碰撞概率，碰撞会让媒体不可达/不可删。`src/shared/uuid.ts` 已有正确实现。

### L14. `scripts/refresh-visuals.ts` 删旧头像在 saveWorld 之前
`scripts/refresh-visuals.ts:30-54`：硬中断于 `:32` 与 `:54` 之间会让 state.json 指向已删旧头像、新头像孤儿，与脚本"中断可重跑"承诺矛盾。

### L15. 重生成交换失败时新文件泄漏
`src/api/routes.ts:2391`：只在 `oldPath===undefined` 时删新图；常态（oldPath 有值）下若 swap 失败新图泄漏，删书还可能重建旧 slug 目录。

### L16. Canvas DPR 硬编码为 2
`src/components/BrainCore.tsx:75-78`：非 Retina 屏过度渲染、3x 屏略糊，应用 `window.devicePixelRatio`。

### L17. 首页时 `sysPoll` 定时器仍在跑
`src/pages/Home.tsx:1856-1867`：world 变 null 回首页时 effect 提前 return 未调 `stopSysPoll()`，3s 间隔持续请求上一本书。

### L18. BrainCabin 媒体轮询/拖拽监听/打字机/弹窗动画未在卸载清理
- `BrainCabin.tsx:1330-1352`：媒体生成 3s setInterval 无 ref/cleanup，卸载后继续打网络并 setState
- `BrainCabin.tsx:1011-1035`：拖拽 window pointermove/pointerup 监听及 body cursor/userSelect 只在 pointerup 清，中途关弹窗泄漏
- `BrainCabin.tsx:417-437`：打字机 setInterval(24ms) 组件整个生命周期常驻，空闲也 41Hz 唤醒
- `BrainCabin.tsx:405,476,1266`：writingTimer/delTimer 未清理
- `GachaModal.tsx:50-58,104`：N 张卡的错峰揭晓 setTimeout 及自动关闭 setTimeout 未清理

### L19. 卡片列表用数组 index 作 key，且 ask 卡过滤后索引错位
`src/components/BrainCabin.tsx:841-853`：过滤掉 ask 卡后用 index 作 key，后续卡片状态/动画可能错挂；`completed.has(\`${msg.id}:${i}\`)` 的 i 是过滤后索引，与标记时的原始索引不一致。

### L20. 遗留根目录扫描依赖 `currentUser()` 恰为 null
`src/api/routes.ts:374,2731`、`advancetask.ts:164`、`newtask.ts`：启动/定时器扫描 data 根靠 ALS 上下文为空工作，一旦未来从请求上下文内误调用就改成扫当前用户目录。脆弱不变量，非当前可触发。

### L21. AnySearch 忽略 per-content `isError`
`src/api/anysearch.ts:54-60`：只查顶层 JSON-RPC error 和 HTTP ok，MCP 工具以 `content[{isError:true}]` 返回的错误被当成成功字符串。`batch_search/extract` 当前未使用，影响仅限 search（结果入 LLM 前截到 900 字）。

### L22. 视频轮询 host 推导对自定义端点失效
`src/api/videos.ts:12`：`AGNES_VIDEO_HOST = BASE.replace(/\/v1$/,"")`；若 `AGNES_BASE_URL` 是不以 `/v1` 结尾的代理，创建任务走 `<base>/videos` 而轮询走 `<base>/agnesapi`。默认配置正常。

### L23. `downloadVideo` 在 100MB 检查前已整包缓冲
`src/api/videos.ts:140-144`：>100MB 响应先全量读入内存再拒绝，叠加 M4 并发轮询有瞬时内存尖峰。URL 由 Agnes 签发（可信），风险低。

### L24. `saveImage/saveVideo` 写入路径无 path-traversal 防护
`src/api/images.ts:82`、`src/api/videos.ts:148`：当前调用方都传内部生成名/受约束扩展名，不可直接触发，但相较 `readImage/deleteMediaFile` 缺深度防御。

---

## 修复优先级建议

1. **立即修（一行/几行级，影响面最大）**：C1（`${c}`）、C4（createdAt）、H5/H6（state 500 / chat stream abort）、M8（IME isComposing）。
2. **数据安全批次**：C2（中枢写加锁）、C3（视频重生成删盘时机）、C9/H7/L7（重结算撤账统一）、H12（删书清会话缓存）、H13/H14/L11（原子写 + .bak 恢复）。
3. **状态机/管线批次**：H1（patched=false 回退）、H2（章纲缺口填补）、H3（落盘时机前移打断检查）、H4（改名边界替换）、H8（rewriteQueue 保留尾段）。
4. **并发/配额批次**：H9（插画上限锁内校验）、H10（视频 failed 早返回）、H11（封面/头像锁外生成）、C6/C7（前端 SSE abort + 切书守卫）、M4/M5/M6（视频轮询/广播/删书检查）。
5. **前端体验批次**：C5（缓存只读不写修复）、M7（时区）、M9（滚动锁）、L18（定时器/监听清理）。

---

## 经核查未发现问题的方向（避免重复劳动）

- **SQL 注入**：全部参数化 `?` 占位；WAL + busy_timeout 配置正确；单进程同步访问无真并发写冲突。
- **路径穿越**：`readImage/deleteMediaFile` 有 norm 基目录前缀守卫，`slugify` 拦 `.`/`..`，asset 接口 path 受保护。
- **限流器**：`run` 的 try/finally 正确释放并发槽，未见槽泄漏；RPM 窗口计数正确。
- **级联删章**：`deleteChapterCascade` 是纯函数，允许章号空洞不重排，delta 逆操作恢复，媒体引用全书校验，逻辑健全。
- **账号隔离**：`storyDir/loadWorld`/brain-sessions/newtask/advancetask 全部以 ALS `currentUser()` 为键，端点不信任客户端用户名/路径。
- **jsonutil**：提取/校验/单次修复链健壮；eval 缺维默认 5 分、clampScore 收敛；chatJson 流式失败降级非流式。
- **图片 1K 约束**：`toAgnesSize` 硬编码 `size:"1K"` 只映射比例，不可绕过。
- **i2i [保持] 子句**：存在（前缀含"严格保持...不得改变样貌或换人"），符合记忆 `agnes-image-best-practices`。
