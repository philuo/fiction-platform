// 分镜场景归一化（循环分镜配套）：bun test tests/scene-normalize.test.ts
// 语义：normalizeScenePlans 只做结构性校验（anchor 匹配/去重），不做内容质量拦截--
// 串场检测/动作宾语缺失等密集规则已移除（与 few-shot 重复且粗暴拦截只制造失败），改由 planSystem few-shot 引导
import { describe, expect, test } from "bun:test";
import { emptyWorld, type WorldState } from "../src/api/world";
import { fuzzyMatchAnchor, normalizeScenePlans, sceneCharAudit, type ScenePlan } from "../src/api/media";

/** 3 段正文 + 2 角色 */
function buildWorld(): WorldState {
  const w = emptyWorld();
  w.title = "断梦录";
  w.genre = "武侠";
  w.characters.push({ id: "c1", name: "柳青霜", role: "主角", traits: ["清冷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
  w.characters.push({ id: "c2", name: "沈夜", role: "主角", traits: ["病弱"], motivation: "", status: "", relations: {}, introducedAt: 1 });
  w.chapters = [{
    index: 1, title: "一", review: null,
    text: "柳青霜在医馆烛光下为沈夜施针，银针入体。\n\n片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。\n\n窗外月色清冷，巷口传来更夫的梆子声。",
  }];
  return w;
}

describe("normalizeScenePlans（分镜场景校验与过滤，不补齐）", () => {
  test("LLM 输出 1 个合法 + 1 个 anchor 失配 -> 仅返回 1 个合法场景（失配被过滤，不模板凑数）", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "柳青霜用白布蘸去沈夜唇角溢出的黑血，烛火摇曳", type: "事件", subject: "柳青霜" },
      { anchor: "这一段在正文中完全不存在的内容片段。", scene: "月光下的巷口", type: "场景", subject: "沈夜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 2);
    expect(out.length).toBe(1);
    expect(out[0].anchor).toContain("黑血");
    expect(out[0].subject).toBe("柳青霜");
  });

  test("subject 不在角色名册 -> 置 undefined；重复 anchor 去重", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "黑血溢出", subject: "路人甲" },
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "重复场景", subject: "柳青霜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(1);
    expect(out[0].subject).toBeUndefined(); // 不在名册
    expect(out.filter((s) => s.anchor.includes("黑血")).length).toBe(1); // 重复 anchor 只保留第一条
  });

  test("excludeAnchors：已选用段落被排除（跨轮次去重，防 LLM 重复挑同一段落）", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "黑血溢出", type: "事件" },
      { anchor: "窗外月色清冷，巷口传来更夫的梆子声。", scene: "月色巷口", type: "场景" },
    ];
    // 第一轮已选「黑血」段落，第二轮输出含重复 -> 被排除，只剩新段落
    const out = normalizeScenePlans(raw, w, 1, 2, ["片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。"]);
    expect(out.length).toBe(1);
    expect(out[0].anchor).toContain("月色清冷");
  });

  test("LLM 输出为空 -> 返回空数组（不降级不兜底，由 planScenes 循环或报错处理）", () => {
    const w = buildWorld();
    const out = normalizeScenePlans([], w, 1, 2);
    expect(out.length).toBe(0);
  });

  test("返回数量不超过 n（上限截断）", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "柳青霜在医馆烛光下为沈夜施针，银针入体。", scene: "施针", type: "事件" },
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "蘸血", type: "事件" },
      { anchor: "窗外月色清冷，巷口传来更夫的梆子声。", scene: "月色", type: "场景" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 2);
    expect(out.length).toBe(2);
  });

  test("anchor 换序改写（LLM 把两句合并重排语序）-> 模糊匹配命中并回填正文原文", () => {
    const w = buildWorld();
    // 正文原文："片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。"
    // LLM 受转写示例句式误导，anchor 重排为"柳青霜用白布蘸去沈夜唇角溢出的黑血"
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "柳青霜用白布蘸去沈夜唇角溢出的黑血", scene: "柳青霜用白布蘸去沈夜唇角溢出的黑血，烛火摇曳", type: "事件", subject: "柳青霜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 2);
    expect(out.length).toBe(1);
    // 回填后的 anchor 必须是正文原文子串（渲染端可稳定定位）
    expect(w.chapters[0].text.includes(out[0].anchor)).toBe(true);
    expect(out[0].anchor).toContain("黑血");
  });

  test("anchor 轻改写（增删字）-> 模糊匹配命中", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "窗外月色清冷，巷口传来梆子声", scene: "月色巷口", type: "场景" }, // 原文"窗外月色清冷，巷口传来更夫的梆子声。"少了"更夫的"
    ];
    const out = normalizeScenePlans(raw, w, 1, 2);
    expect(out.length).toBe(1);
    expect(w.chapters[0].text.includes(out[0].anchor)).toBe(true);
    expect(out[0].anchor).toContain("更夫");
  });

  test("完全虚构的 anchor -> 模糊匹配拒绝，不滥配", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "一名黑衣人拔刀砍向柳青霜，血溅三尺", scene: "虚构打斗", type: "事件" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 2);
    expect(out.length).toBe(0);
  });

  test("fuzzyMatchAnchor：正文为空的边界", () => {
    expect(fuzzyMatchAnchor("", "沈夜唇角溢出")).toBeUndefined();
    expect(fuzzyMatchAnchor("短文本", "短")).toBeUndefined(); // <4 字
  });

  test("串场检测已移除：scene 含 anchor 段落外角色不再拦截，保留（交 few-shot 引导）", () => {
    // 4 段正文 + 3 角色：沈夜只在第 1 段出场，魏无咎只在第 4 段出场
    const w = emptyWorld();
    w.title = "断梦录";
    w.characters.push({ id: "c1", name: "柳青霜", role: "主角", traits: ["清冷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.characters.push({ id: "c2", name: "沈夜", role: "主角", traits: ["病弱"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.characters.push({ id: "c3", name: "魏无咎", role: "反派", traits: ["阴鸷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.chapters = [{
      index: 1, title: "一", review: null,
      text: "柳青霜在医馆烛光下为沈夜施针，银针入体。\n\n片刻后，一滴黑血从沈夜唇角溢出，柳青霜用白布蘸去。\n\n窗外月色清冷，巷口传来更夫的梆子声。\n\n魏无咎从阴影中走出，腰间玉佩在昏暗中泛着幽光。",
    }];
    const raw: (ScenePlan & { type?: string })[] = [
      // anchor 只含魏无咎，scene 混入沈夜受刑（其他段落情节）-- 串场检测已移除，不再拦截
      { anchor: "魏无咎从阴影中走出，腰间玉佩在昏暗中泛着幽光。", scene: "魏无咎从阴影中走出，沈夜双臂被铁链捆绑在刑架上脸色苍白", type: "事件", subject: "魏无咎" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(1);
    expect(out[0].subject).toBe("魏无咎");
  });

  test("混合输入：合法与跨段场景均保留（串场检测已移除）", () => {
    const w = emptyWorld();
    w.title = "断梦录";
    w.characters.push({ id: "c1", name: "柳青霜", role: "主角", traits: ["清冷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.characters.push({ id: "c2", name: "沈夜", role: "主角", traits: ["病弱"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.characters.push({ id: "c3", name: "魏无咎", role: "反派", traits: ["阴鸷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
    w.chapters = [{
      index: 1, title: "一", review: null,
      text: "柳青霜在医馆烛光下为沈夜施针，银针入体。\n\n片刻后，一滴黑血从沈夜唇角溢出，柳青霜用白布蘸去。\n\n窗外月色清冷，巷口传来更夫的梆子声。\n\n魏无咎从阴影中走出，腰间玉佩在昏暗中泛着幽光。",
    }];
    const raw: (ScenePlan & { type?: string })[] = [
      // 跨段：魏无咎段混入沈夜（不再拦截）
      { anchor: "魏无咎从阴影中走出，腰间玉佩在昏暗中泛着幽光。", scene: "魏无咎从阴影中走出，沈夜被捆绑在刑架上", type: "事件" },
      // 合法：月色场景（无角色名，纯场景）
      { anchor: "窗外月色清冷，巷口传来更夫的梆子声。", scene: "清冷月色下的巷口，更夫提着灯笼走过", type: "场景" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(2); // 均保留
  });

  test("动作宾语检测已移除：省略式 scene（蘸去+标点）不再拦截，保留（交 few-shot 引导）", () => {
    const w = buildWorld();
    // 正文承前省略："柳青霜用白布蘸去。"省略宾语"黑血"；scene 照抄省略式 -- 不再拦截
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "柳青霜用白布蘸去，烛火摇曳", type: "事件", subject: "柳青霜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(1);
  });

  test("补全宾语（蘸去沈夜唇角的黑血）-> 保留", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "柳青霜用白布蘸去沈夜唇角溢出的黑血，烛火摇曳", type: "事件", subject: "柳青霜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(1);
    expect(out[0].scene).toContain("黑血");
  });

  test("把字句宾语前置（把血迹擦去）-> 合法保留", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "柳青霜用白布把沈夜唇角的黑血擦去，烛火摇曳", type: "事件", subject: "柳青霜" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(1);
  });

  test("省略式与补全式均保留（动作宾语检测已移除）", () => {
    const w = buildWorld();
    const raw: (ScenePlan & { type?: string })[] = [
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "柳青霜用白布蘸去，烛火摇曳", type: "事件" },
      { anchor: "柳青霜在医馆烛光下为沈夜施针，银针入体。", scene: "柳青霜在医馆烛光下为沈夜施针", type: "事件" },
    ];
    const out = normalizeScenePlans(raw, w, 1, 3);
    expect(out.length).toBe(2); // 均保留
  });

  test("sceneCharAudit：scene 点名段落未出场角色 -> 返回该角色；只点段落内角色 -> 空", () => {
    const w = buildWorld();
    // 段落「窗外月色清冷，巷口传来更夫的梆子声。」未点名任何角色
    const para = "窗外月色清冷，巷口传来更夫的梆子声。";
    expect(sceneCharAudit(w, 1, para, "柳青霜立于月下，沈夜被锁")).toEqual(["柳青霜", "沈夜"]);
    expect(sceneCharAudit(w, 1, para, "月色清冷的巷口")).toEqual([]);
    // 段落「片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。」点名沈夜、柳青霜
    const para2 = "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。";
    expect(sceneCharAudit(w, 1, para2, "柳青霜为沈夜蘸去黑血")).toEqual([]);
    expect(sceneCharAudit(w, 1, para2, "柳青霜与魏无咎对峙")).toEqual([]); // 魏无咎不在本故事名册：不审计（避免非角色词误报）
    // anchor 无法定位到段落 -> 保守空（不误报）
    expect(sceneCharAudit(w, 1, "正文中不存在的片段", "沈夜")).toEqual([]);
  });

  test("normalizeScenePlans 透传 extraChars：scene 含段落外角色 -> 非空；只含段落内角色 -> undefined", () => {
    const w = buildWorld();
    // 段落「片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。」出场沈夜+柳青霜
    const outExtra = normalizeScenePlans([
      { anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", scene: "沈夜被铁链锁于刑架，柳青霜立于阴影中", type: "事件" },
    ], w, 1, 2);
    // 该段落未写铁链/刑架，但两角色都在段落出场 → 不产生额外角色审计
    expect(outExtra[0].extraChars).toBeUndefined();
    // 段落「窗外月色清冷…」无角色，scene 点名角色 → extraChars 非空
    const out = normalizeScenePlans([
      { anchor: "窗外月色清冷，巷口传来更夫的梆子声。", scene: "柳青霜立于月下，沈夜被锁于刑架", type: "事件" },
    ], w, 1, 2);
    expect(out.length).toBe(1);
    expect(out[0].extraChars).toEqual(["柳青霜", "沈夜"]);
    // subject 校验不受 extraChars 影响（subject 不在名册置 undefined）
    const out2 = normalizeScenePlans([
      { anchor: "窗外月色清冷，巷口传来更夫的梆子声。", scene: "月色清冷的巷口", type: "场景", subject: "路人甲" },
    ], w, 1, 2);
    expect(out2[0].extraChars).toBeUndefined();
  });
});
