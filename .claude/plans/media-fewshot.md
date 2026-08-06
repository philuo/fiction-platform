# 分镜 few-shot 示例驱动改造（提升主客精度）

## 背景与问题诊断

生图链路：`agnes-2.5-flash`（弱思考文本模型）经 `planSystem(kind)` 把章节正文转写为 `{anchor,scene,caption,type,subject}` JSON → `scene` 字段喂给 `agnes-image-2.1-flash` 生图。

**实测产出问题（来自 `data/断梦录` 真实 prompt）**：
1. 主客混淆：主体标 `魏无咎`，scene 却大段描摹 `沈夜`，视觉焦点错位。
2. 弱模型语序崩坏：`"头穿青布护额身穿青灰色短打公服"`（头戴/身穿混搭）。
3. 段落重复选取：两 scene anchor 几乎相同（`…柳青霜用白布蘸去…`），跨轮去重未充分生效。
4. scene 过长堆砌，超出弱图像模型解析力。

**根因**：`planSystem` 现有 ~20 条抽象规则（语义精度/分型/宾语补全…）。agnes-2.5-flash 是弱模型，规则越抽象越难稳定遵循，反而干扰产出——正是用户判断。

**关键安全前提**：`normalizeScenePlans` 是确定性校验网（anchor 必须匹配正文、串场拦截、`INCOMPLETE_ACTION_RE` 宾语补全拦截、subject 名册校验）。**即使弱模型照抄示例，失配项会被自动过滤**，故 few-shot 不会污染输出——可放心加示例。

## 方案：例子驱动 + 精简规则（hybrid）

用户提议方向正确，采用 **精简规则 + few-shot 示例** 的混合策略（纯示例无显式格式契约风险高，hybrid 最稳）。

### 1. 精简 `planSystem(kind)` 规则段
- 保留铁律（少量）：anchor 逐字复制正文连续片段（12~40 字，不改写）；scene 转写非摘抄、忠于 anchor 段落及紧邻上下文，不虚构；服饰只用上下文身份/时代服饰；输出合法 JSON（中文引号）；scene 引用画风锚点 + 结尾"无水印"。
- **删除**冗长的"语义精度细则/分型策略细则"文字——改由示例承载教学。
- 保留 `structure` 行（已对齐官方 [主体]+[场景/环境]+[风格]+[光照]+[构图]+[质量要求]）。

### 2. 新增 few-shot 示例常量（`src/api/media.ts`）
`SCENE_EXAMPLES_IMAGE`（3 例，覆盖三型 + 主客精度关键案例）：
- **例1 事件型（多角色 + 去除动词宾语补全 + 主客同框位置）**——canonical 蘑血案例：
  - 正文片段：`片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。`
  - anchor：照抄原句
  - scene：`清冷女子柳青霜俯身用白布蘸去榻上沈夜唇角溢出的黑血，烛火摇曳，水墨风动漫插画，电影级光影，近景构图，画面中不要出现文字，无水印`
  - type:`事件` / subject:`柳青霜`
  - 要点注解：`蘸去后补全宾语"黑血"；柳青霜施动、沈夜受事同框并写明相对位置"俯身/榻上"，主客不颠倒。`
- **例2 人物型（静态肖像，仅取段落内状态）**：
  - 正文片段：`沈夜躺在床上，脸色骤然变得惨白，额上青筋暴起。`
  - scene：`脸色惨白、额上青筋暴起的青年男子沈夜躺在床上，水墨风动漫插画，电影级光影，半身特写构图，画面中不要出现文字，无水印`
  - type:`人物` / subject:`沈夜`
  - 注解：`无动作情节判"人物"；状态"脸色惨白/青筋暴起"取自本段，不串入他段。`
- **例3 场景型（纯环境）**：
  - 正文片段：`窗外月色清冷，巷口传来更夫的梆子声。`
  - scene：`清冷月色下的京师暗巷，更夫提灯笼走过，水墨风动漫插画，淡雅绸缎色调，电影级光影，远景构图，画面中不要出现文字，无水印`
  - type:`场景` / subject:省略
  - 注解：`纯环境描写判"场景"，以地点/光线/纵深为主体，人物仅点缀。`

`SCENE_EXAMPLES_VIDEO`（1~2 例）：在事件型基础上加 `[镜头运动]`（如"镜头缓推近沈夜唇角"），结构行用 video 版。

示例采用古风注册（匹配主流题材与现有测试夹具）；**转写模式跨题材通用**——模型学的是"如何转写"而非题材本身。每例附一句要点注解直击主客精度教学（弱模型对"为什么"比纯规则更易迁移）。

### 3. 示例自洽性测试（`tests/scene-normalize.test.ts` 新增块）
- 构造 fixture world（含示例角色名），把每个示例的 `{anchor,scene,type,subject}` 喂入 `normalizeScenePlans`，断言：
  - 事件型示例保留且 subject 正确（验证宾语补全通过 `INCOMPLETE_ACTION_RE`）。
  - 示例 scene 不触发 `INCOMPLETE_ACTION_RE`（证明示例本身合规，不会自过滤）。
- 目的：锁死示例质量，防止后续改坏示例导致"示例自己都过不了校验"。

## 文件改动
- `src/api/media.ts`：重写 `planSystem(kind)`（精简规则 + 拼接示例）；新增 `SCENE_EXAMPLES_IMAGE` / `SCENE_EXAMPLES_VIDEO` 常量。
- `tests/scene-normalize.test.ts`：新增"few-shot 示例自洽性"测试块。

## 不改动（保持确定性安全网与现有链路）
- `normalizeScenePlans` 校验逻辑、`planScenes` 循环、`fuzzyMatchAnchor`、`findCharacterRef`/`findVideoFirstFrame` 参考图链路、`charHintFor`（工作树已简化）、图像模型/尺寸/画风锚点拼接。

## 风险与回退
- **token**：3 例 ~500 字，远小于 maxTokens 60000 预算，可忽略；system prompt 总长因删规则而净增很小。
- **示例照抄**：被 `normalizeScenePlans`（anchor 须匹配正文 / 串场拦截 / subject 名册）自动过滤，无污染风险。
- **回退**：示例为纯 prompt 字符串常量，不动确定性逻辑；效果不佳可调示例或恢复规则。

## 验证
- `bun test tests/scene-normalize.test.ts` 全绿（含新示例自洽性块）。
- 对 `断梦录` 第 1 章跑一次 `/api/novel/media/plan`，人工核对 scene 主客归属、宾语补全、长度是否改善。
