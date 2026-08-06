// 分镜候选池（一次交互挑多处）：bun test tests/plan-scenes-candidate.test.ts
// 语义：planScenesOnce 每轮让 LLM 输出 max(3, remaining) 个候选，normalizeScenePlans 去重后取前 remaining 个；
// 单张时首选与已选用段落重复 → 第 2/3 候选兑底，不再补轮/失败。复用 tests/mocks.ts 的 installMockAgnes mock chat。
import { describe, expect, test, mock } from "bun:test";
import { emptyWorld, type WorldState } from "../src/api/world";
import { planScenes } from "../src/api/media";

// 必须在 import media 之前安装 mock（media 依赖 agnes 的 chat）
import { installMockAgnes, type AgnesResponder } from "./mocks";

const responder = installMockAgnes as unknown as (r: AgnesResponder) => void;

/** 4 段正文 + 2 角色（每段独立，跨段不互斥） */
function buildWorld(): WorldState {
  const w = emptyWorld();
  w.title = "断梦录";
  w.genre = "武侠";
  w.characters.push({ id: "c1", name: "柳青霜", role: "主角", traits: ["清冷"], motivation: "", status: "", relations: {}, introducedAt: 1 });
  w.characters.push({ id: "c2", name: "沈夜", role: "主角", traits: ["病弱"], motivation: "", status: "", relations: {}, introducedAt: 1 });
  w.chapters = [{
    index: 1, title: "一", review: null,
    text: [
      "柳青霜在医馆烛光下为沈夜施针，银针入体。",
      "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。",
      "窗外月色清冷，巷口传来更夫的梆子声。",
      "沈夜在密室中翻看旧信，烛火忽明忽暗。",
    ].join("\n\n"),
  }];
  return w;
}

/** 构造 LLM JSON 输出（anchor 逐字摘抄正文，scene/caption/type 齐） */
function cand(anchor: string, scene: string, type = "事件"): Record<string, unknown> {
  return { anchor, scene, caption: scene.slice(0, 10), type };
}

describe("planScenes 候选池（一次交互挑多处，去重后择优）", () => {
  test("单张 + 已有媒体含首选段落：候选 3 个（首选重复）→ 返回 1 个新段落（候选兑底）", async () => {
    const w = buildWorld();
    // 已有插画：选中「黑血」段（跨次排除集）
    w.chapters[0].media = [{ kind: "image", anchor: "片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", path: "/x.jpg", prompt: "黑血", caption: "黑血" } as never];
    let sawUsed = false;
    responder((messages) => {
      const all = messages.map((m) => m.content).join("\n");
      sawUsed = sawUsed || all.includes("已被选用");
      // LLM 首选仍是黑血段（未遵守排除集），第 2/3 候选是新段落 → 候选池兜底
      return JSON.stringify({
        scenes: [
          cand("片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", "黑血从沈夜唇角溢出，烛火摇曳"),
          cand("窗外月色清冷，巷口传来更夫的梆子声。", "月色清冷的巷口，更夫梆子声由远及近", "场景"),
          cand("沈夜在密室中翻看旧信，烛火忽明忽暗。", "沈夜在密室烛光下翻看旧信"),
        ],
      });
    });
    const out = await planScenes(w, 1, "image", 1);
    expect(sawUsed).toBe(true); // 跨次排除集已传给 LLM
    expect(out.length).toBe(1);
    expect(out[0].anchor).toContain("月色清冷"); // 首选黑血被排除，候选 2 兜底（画面感排序靠前）
  });

  test("多张（count=2）：一次交互 3 候选 → 取满 2 个、互不重复", async () => {
    const w = buildWorld();
    responder(() =>
      JSON.stringify({
        scenes: [
          cand("柳青霜在医馆烛光下为沈夜施针，银针入体。", "柳青霜为沈夜施针，银针入体"),
          cand("片刻后，一滴黑血从沈夜唇角溢出。柳青霜用白布蘸去。", "黑血从沈夜唇角溢出"),
          cand("窗外月色清冷，巷口传来更夫的梆子声。", "月色清冷的巷口", "场景"),
        ],
      }),
    );
    const out = await planScenes(w, 1, "image", 2);
    expect(out.length).toBe(2);
    expect(out[0].anchor).not.toBe(out[1].anchor); // 候选间互不重复（施针/黑血两段）
  });

  test("候选间互重复：去重后仅返回不重复项（不补轮）", async () => {
    const w = buildWorld();
    responder(() =>
      JSON.stringify({
        scenes: [
          cand("窗外月色清冷，巷口传来更夫的梆子声。", "月色清冷的巷口", "场景"),
          cand("窗外月色清冷，巷口传来更夫的梆子声。", "月色清冷的巷口（重复）", "场景"),
          cand("沈夜在密室中翻看旧信，烛火忽明忽暗。", "沈夜在密室烛光下翻看旧信"),
        ],
      }),
    );
    const out = await planScenes(w, 1, "image", 2);
    expect(out.length).toBe(2); // 去重后取 2（月色 + 密室），不补轮
    expect(out[0].anchor).toContain("月色清冷");
    expect(out[1].anchor).toContain("密室");
  });
});
