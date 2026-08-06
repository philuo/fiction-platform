# 修复插画段落重复选取

## 根因（数据印证）

`data/断梦录` 第1章有 3 张 image，其中两张都选了段落#24（蘑菇血段），切法不同：
- [1] 长切片：`一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去，目光落在那白布上--…`
- [2] 短切片：`片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。`

两者归一化后**互不包含**，精确去重放行。两个根因：

1. **`planScenes` 不读该章已有媒体**--[1][2] 是两次独立 `/api/novel/media/plan` 调用产生，第二次完全不知道第一次选过段落#24。`planScenesOnce` 的 `usedAnchors` 每次从空开始。
2. **去重是 anchor 字符串级精确匹配**（`normalizeScenePlans` 的 `excluded`/`seen` 集合）--同段落不同切法归一化串不同，绕过去重。

## 方案：跨次排除（A）+ 段落级去重（B）

A、B 必须同时做：A 堵跨次生成（主因），B 堵同段不同切法（让 A 即使 LLM 不听"已选用段落"指令也兜底）。单独任一都无法修复 [1]/[2] 这类案例。

### A. `planScenes` 读取该章已有媒体作为初始排除集
- `planScenes(w, chapterIndex, kind, count)` 内部读取 `ch.media` 中**同 kind** 媒体的 anchor（原文，不分状态--都是"已选过的段落意图"，最防重复），构造 `existingAnchors: string[]`。
- 传给 `planScenesOnce(w, ch, kind, n, existingAnchors)`（新增参数）。
- image 排除已有 image；video 排除已有 video（不交叉--视频可能用插画首帧段落，不应被排除）。

### B. `normalizeScenePlans` 新增段落级去重
- 现有精确 `nfa` 去重保留（快速路径）。
- 新增：预计算 `excludeAnchors` 的段落索引集合 `excludedParaIdx`（复用现有 `paraTexts.findIndex(pt => pt.includes(nfa))` 逻辑）；本轮同样维护 `usedParaIdx`。
- 新 anchor 回填后算 `anchorParaIdx`，若 `excludedParaIdx.has(anchorParaIdx)` 或 `usedParaIdx.has(anchorParaIdx)` -> 丢弃（同段落已占用）。
- `anchorParaIdx === -1`（理论不会，fuzzyMatch 在段内回填）时不做段落去重，fallback 精确去重。

### 附带改善：`usedAnchors` 改存原文 anchor
- 现状 `usedAnchors.push(normAnchor(s.anchor))` 存归一化串，导致 LLM 消息"已选用段落"展示无标点串，LLM 难识别。
- 改为存原文 `s.anchor`（= 回填后的 finalAnchor）；`normalizeScenePlans` 内部仍 `.map(normAnchor)`（幂等，兼容）。LLM 消息展示原文，更易让 LLM 避开已选段落。
- `existingAnchors` 同样存原文，与 `usedAnchors` 语义一致。

## 文件改动
- `src/api/media.ts`：
  - `planScenes`：读取同 kind 已有媒体 anchor，传给 `planScenesOnce`。
  - `planScenesOnce`：新增 `existingAnchors` 参数，`usedAnchors` 初始化为 `[...existingAnchors]`，`push` 改存原文。
  - `normalizeScenePlans`：新增段落级去重（`excludedParaIdx` + `usedParaIdx`）。
- `tests/scene-normalize.test.ts`：新增段落级去重用例（同段不同切法 -> 丢弃；不同段 -> 保留）。

## 不改动
- `fuzzyMatchAnchor`、串场检测、宾语补全拦截、`findCharacterRef`/`findVideoFirstFrame`、`/api/novel/media/plan` 路由签名（仍 `planScenes(w, idx, kind, count)`）。
- 重新生成单张（用原 anchor，不调 plan）不受影响。

## 现有测试兼容性
已逐个核对 `scene-normalize.test.ts` 现有 16 用例 + few-shot 4 用例：段落级去重不影响它们（测试用例的 anchor 均落在不同段落，或单 anchor 场景）。新用例只增不减。

## 风险与回退
- **段落级去重过严**：很长的多画面段落若用户想要同段两张会被拦。但每章上限 3 张、段落通常足够，且符合"避免重复"诉求。若反馈过严，可放宽为"句子窗口级"重叠去重。
- **回退**：A/B 均为局部逻辑，不动 anchor 语义与渲染定位；可独立回退。

## 验证
- `bun test tests/scene-normalize.test.ts` 全绿（含新用例）。
- 构造"已有1张蘑菇血长切片"的 world，调 `normalizeScenePlans` 传入短切片 -> 验证被段落级去重丢弃。
