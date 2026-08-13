# 模块化迁移交接记录

> 用于跨设备或新 Codex 任务继续开发。当前开发规范仍以 `docs/INSTRUCTION.md` 为准；本文只记录本轮执行状态和下一步。

## 代码位置

- 仓库：`git@github.com:philuo/fiction-platform.git`
- 分支：`codex/brain-reliability-ui`
- 模块化检查点：`b1ae62c refactor: modularize server transport and command flow`
- 原 Codex 任务 ID：`019ff9c1-e143-7f81-a93c-ed11255c0c7c`

新设备先执行：

```bash
git fetch origin
git switch codex/brain-reliability-ui
git pull --ff-only
bun install
bun run check
```

## 已完成

1. 建立 `contracts / application / infrastructure / transport / frontend` 分层骨架和依赖检查。
2. 拆分模块化 HTTP 路径 owner：brain、query、story、chapter、planning、governance、media、autorun。
3. 旧公开写 URL 强制通过 CommandBus v1，统一 commandId、command type、expectedRevision、幂等重放及冲突响应。
4. 建立 StoryRepository、WorldCommitter、JobStore、ProjectionPublisher、ModelProvider、MediaProvider 端口及兼容适配器。
5. 前端建立 typed command client 和 story/chapter/media/autorun/governance feature hooks。
6. sync system projection 新增 `worldRevision`；CommandBus 的 expectedRevision 使用 world projection revision，不再误用 system projection revision。
7. proposalClosed、world、job、Brain 状态继续以 sync projection 为唯一权威；前端未重新引入旧状态 HTTP 轮询。
8. 更新 `docs/INSTRUCTION.md`、README、BRAIN、HARNESS 及历史计划状态。

## 真实浏览器验证发现及修复

真实验证使用隔离 SQLite、唯一账号和唯一故事，未使用正式数据。

发现并修复：

1. 新书 ready projection 与 React state 同帧更新时，`openStory` 读取旧 stories 闭包并误报“故事不存在”。现在直接读取权威 library sync store。
2. system projection revision 被误当成 state.json world revision，造成合法章节推进返回 409。现在 system snapshot 显式携带 `worldRevision`。

真实通过：

- 未登录页、注册、自动登录。
- 真实文本 provider 立项。
- 封面、三个角色头像和立绘真实生成并落盘。
- 刷新及直接 URL 恢复故事。
- 第一章 SSE 写作、审查、记账、入册，最终 1552 字、两个伏笔，运行锁正确释放。
- Brain 查询角色，返回三个角色及可展开卡片。
- 两个浏览器 Tab 恢复同一章节；两个 Tab 控制台均无 error/warn。
- 服务重启把未完成 media-plan job 收敛为 interrupted，并把 Brain running 卡收敛为失败卡。

未通过且不得声称通过：

- 插画分镜真实调用遇到上游 `ECONNRESET`；有限重试后通过重启恢复收敛，没有进入真实图片生成。
- 因分镜失败，没有继续发起真实视频 provider 调用。
- 自动连载、proposal 关闭/重开、多 Tab 实际写传播尚未完成完整真实浏览器验收。

测试数据、媒体目录、Brain 会话、临时 SQLite 和 dev server 已全部清理。

## 最终自动化基线

- `bun run check:architecture`：133 files、411 imports、0 cycles、49 public commands。
- `bun run typecheck`：通过。
- `bun test`：682 pass / 0 fail，62 files，3863 assertions。
- `bun run build`：client 与 SSR 均通过。
- `git diff --check`：通过。

## 尚未完成，估计剩余 35%～45%

1. 模块 handler 仍委托 `src/api/routes.ts`；要逐域迁移为 application use case + port 调用。
2. `routes.ts` 仍约 3600 行，需要收敛为认证、上下文、CommandBus、模块 dispatcher 和错误映射。
3. `Home.tsx` 仍约 2900 行，需要继续迁移到 `src/frontend/features/*`。
4. BrainCabin、brain-cards、brain-chat 尚需按会话编排、意图、查询、表单、renderer registry 拆分。
5. 全部调用方迁移前不得删除旧 URL 或兼容重导出。
6. provider 稳定后补完图片、视频、自动连载、proposal 和多 Tab 写传播的真实验收。

## 下一步建议顺序

1. 先选 chapter 或 story 中一个低耦合写域，建立 application use case，让对应模块 handler 不再委托 legacy route。
2. 为该域增加 handler method/body/auth/error、legacy/canonical 契约一致性和 command receipt 测试。
3. 迁移对应 Home 调用及状态派生，保持 sync 为唯一权威。
4. 每完成一个域运行：

```bash
bun run check:architecture
bun run typecheck
bun test
bun run build
git diff --check
```

5. 所有域及恢复流程切换后，最后删除兼容入口并重新执行隔离浏览器验收。

