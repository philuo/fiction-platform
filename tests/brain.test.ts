// 中枢 brain 模块测试（BRAIN.md / DEEP-DIVE.md 落地验证）
// 覆盖：goal disposition 三态、闸门开关、闸门 LLM 审查（拒绝/放行）、失败降级放行、revise 注入 mergeTasks
import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { emptyWorld, type WorldState } from "../src/api/world";
import {
  brainGateEnabled, computeDisposition, gateChange, applyBrainReview, interventionMode, type BrainReviewOutput,
} from "../src/api/brain";
import { isBookComplete } from "../src/api/planner";

// —— mock LLM：chat 返回可配置的 JSON ——
let nextChatContent = "";
mock.module("../src/api/agnes", () => ({
  chat: async () => nextChatContent,
  complete: async () => ({ content: nextChatContent }),
  chatStream: async (_m: unknown, onChunk: (d: string) => void) => {
    onChunk(nextChatContent);
    return nextChatContent;
  },
  ChatRole: {},
}));

beforeAll(() => { nextChatContent = ""; });
afterAll(() => { delete process.env.AGNES_BRAIN_GATE; delete process.env.INTERVENTION_MODE; });

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "brain-test";
  w.nextChapter = 3;
  w.blueprint = {
    theme: "t", mainPlot: "m", ending: "e", compass: "c", progressContract: "p",
    volumes: [{ id: "v1", title: "第一卷", goal: "g", status: "writing" }],
  };
  return w;
}

describe("computeDisposition（goal 三态）", () => {
  test("结构未完结 → continue", () => {
    const w = mkWorld();
    expect(computeDisposition(w)).toBe("continue");
  });

  test("全卷 done + 伏笔全回收 → complete", () => {
    const w = mkWorld();
    w.blueprint!.volumes[0].status = "done";
    w.foreshadowing.push({ id: "f1", text: "伏笔", plantedAt: 1, status: "resolved", resolvedAt: 2 });
    expect(isBookComplete(w)).toBe(true);
    expect(computeDisposition(w)).toBe("complete");
  });

  test("目标章数超限 → blocked", () => {
    const w = mkWorld();
    w.goal = { structure: { targetChapters: 5 } };
    w.nextChapter = 6;
    expect(computeDisposition(w)).toBe("blocked");
  });
});

describe("权限开关", () => {
  test("AGNES_BRAIN_GATE=on 启用闸门；缺省 off", () => {
    delete process.env.AGNES_BRAIN_GATE;
    expect(brainGateEnabled()).toBe(false);
    process.env.AGNES_BRAIN_GATE = "on";
    expect(brainGateEnabled()).toBe(true);
  });

  test("INTERVENTION_MODE 默认 supervised", () => {
    delete process.env.INTERVENTION_MODE;
    expect(interventionMode()).toBe("supervised");
    process.env.INTERVENTION_MODE = "autopilot";
    expect(interventionMode()).toBe("autopilot");
  });
});

describe("gateChange（状态变更闸门）", () => {
  test("闸门 off → 直通（零行为变化）", async () => {
    delete process.env.AGNES_BRAIN_GATE;
    const w = mkWorld();
    const r = await gateChange(w, { actor: "user", field: "foreshadowing", reason: "x", level: "L2" });
    expect(r.allow).toBe(true);
  });

  test("闸门 on + L2：LLM 拒绝 → allow:false", async () => {
    process.env.AGNES_BRAIN_GATE = "on";
    nextChatContent = '{"verdict":"reject","reason":"与既成事实冲突"}';
    const w = mkWorld();
    const r = await gateChange(w, { actor: "user", commandId: "CMD-L07", field: "foreshadowing", reason: "删伏笔", level: "L2" });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("冲突");
  });

  test("闸门 on + L2：LLM 批准 → allow", async () => {
    process.env.AGNES_BRAIN_GATE = "on";
    nextChatContent = '{"verdict":"allow","reason":"合理"}';
    const w = mkWorld();
    const r = await gateChange(w, { actor: "user", commandId: "CMD-L07", field: "foreshadowing", reason: "登记伏笔", level: "L2" });
    expect(r.allow).toBe(true);
  });

  test("闸门 on：LLM 失败 → 降级放行（闸门是加保险不是拦路虎）+ 记录 brain_unavailable", async () => {
    process.env.AGNES_BRAIN_GATE = "on";
    nextChatContent = "非法输出!!!";
    const w = mkWorld();
    const r = await gateChange(w, { actor: "user", commandId: "CMD-L07", field: "foreshadowing", reason: "登记伏笔", level: "L2" });
    expect(r.allow).toBe(true);
    expect(w.changeLog?.some((e) => e.reason === "brain_unavailable")).toBe(true);
  });

  test("闸门 on + L0/L1 → 直通（成本控制，不触发 LLM）", async () => {
    process.env.AGNES_BRAIN_GATE = "on";
    nextChatContent = '{"verdict":"reject"}';
    const w = mkWorld();
    const r = await gateChange(w, { actor: "user", field: "chapters[].media", reason: "媒体", level: "L0" });
    expect(r.allow).toBe(true);
  });
});

describe("applyBrainReview（章末审查落地）", () => {
  test("revise：建议注入后续 planned 章纲的 mergeTasks", () => {
    const w = mkWorld();
    w.chapterPlans = [
      { index: 3, arcId: "a", goal: "g", beats: [], hookType: "悬念", status: "planned" },
      { index: 4, arcId: "a", goal: "g2", beats: [], hookType: "悬念", status: "planned" },
    ];
    const out: BrainReviewOutput = { verdict: "revise", reason: "伏笔与设定冲突", suggestions: ["在下章弥合伏笔 A"] };
    applyBrainReview(w, 2, out, "章末审查（revise）");
    expect(w.changeLog?.some((e) => e.kind === "brain-review" && e.reason === "伏笔与设定冲突")).toBe(true);
    expect(w.chapterPlans[0].mergeTasks).toContain("在下章弥合伏笔 A");
    expect(w.chapterPlans[1].mergeTasks).toContain("在下章弥合伏笔 A"); // 注入到前 2 个 planned 章纲的每个
  });

  test("approve：仅记录日志，不注入任务", () => {
    const w = mkWorld();
    w.chapterPlans = [{ index: 3, arcId: "a", goal: "g", beats: [], hookType: "悬念", status: "planned" }];
    applyBrainReview(w, 2, { verdict: "approve", reason: "一致" }, "章末审查（approve）");
    expect(w.chapterPlans[0].mergeTasks ?? []).toHaveLength(0);
    expect(w.changeLog?.some((e) => e.kind === "brain-review" && e.reason === "一致")).toBe(true);
  });
});
