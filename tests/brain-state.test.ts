// 中枢四维状态机测试（brain-state.ts）：覆盖 presence/activity/governance/vitals 各分支派生
import { describe, expect, test } from "bun:test";
import { emptyWorld, type WorldState, type ChangeLogEntry } from "../src/api/world";
import type { EvalReport, EvalDimensionResult } from "../src/api/eval";
import type { ConsistencyFinding } from "../src/api/world";
import {
  deriveBrainState, matchActivity,
  PRESENCE_LABEL, ACTIVITY_LABEL, GOVERNANCE_LABEL,
  type BrainRuntimeInput,
} from "../src/api/brain-state";

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "brain-state-test";
  w.nextChapter = 3;
  w.blueprint = {
    theme: "t", mainPlot: "m", ending: "e", compass: "c", progressContract: "p",
    volumes: [{ id: "v1", title: "第一卷", goal: "g", status: "writing" }],
  };
  // 至少一章，使 presence 不落入 dormant
  w.chapters.push({ index: 1, title: "第一章", text: "正文", review: null });
  return w;
}

function mkEval(overall: number, coherenceScore?: number): EvalReport {
  const dims: EvalDimensionResult[] = [
    { name: "剧情逻辑", score: 7, evidence: "" },
    { name: "设定一致", score: coherenceScore ?? 7, evidence: "" },
  ];
  return { at: "2025-01-01T00:00:00Z", chaptersEvaluated: 1, dimensions: dims, overall, suggestions: [] };
}

function mkIntegrity(danger: number): ConsistencyFinding[] {
  return Array.from({ length: danger }, (_, i) => ({
    id: `d${i}`, level: "danger" as const, kind: "test", issue: "x", suggestion: "y",
  }));
}

function brainLog(partial: Partial<ChangeLogEntry> & { kind: string; detail: string }): ChangeLogEntry {
  return { at: "2025-01-01T00:00:00Z", chapter: 1, actor: "brain", ...partial };
}

// ============ matchActivity ============

describe("matchActivity（动作态映射）", () => {
  test("无信号 → idle", () => {
    expect(matchActivity(undefined, undefined)).toBe("idle");
  });
  test("导演写作文本 → directing", () => {
    expect(matchActivity("导演写作中…", false)).toBe("directing");
    expect(matchActivity("自动连载：第 3 章写作中（第 1 稿）…", false)).toBe("directing");
    expect(matchActivity("AI 重写中…", false)).toBe("directing");
  });
  test("审查文本 → reviewing", () => {
    expect(matchActivity("审查者对抗审查中（第 1 稿）…", false)).toBe("reviewing");
    expect(matchActivity("审查中…", false)).toBe("reviewing");
    expect(matchActivity("定向修补段落中…", false)).toBe("reviewing");
  });
  test("结算文本 → settling", () => {
    expect(matchActivity("本章结算中（伏笔/状态/摘要）…", false)).toBe("settling");
    expect(matchActivity("重算本章账本中…", false)).toBe("settling");
  });
  test("分镜/插画 → illustrating", () => {
    expect(matchActivity("AI 分镜中（挑选关键场景）…", false)).toBe("illustrating");
    expect(matchActivity("AI 重新生成插画中…", false)).toBe("illustrating");
  });
  test("visualGen 无 phase → illustrating", () => {
    expect(matchActivity("", true)).toBe("illustrating");
  });
  test("巡检/修复 → auditing", () => {
    expect(matchActivity("一致性巡检中…", false)).toBe("auditing");
    expect(matchActivity("修复一致性问题…", false)).toBe("auditing");
  });
  test("干预 → gating", () => {
    expect(matchActivity("执行干预策略中…", false)).toBe("gating");
  });
  test("立项/存档 → housekeeping", () => {
    expect(matchActivity("立项中…", false)).toBe("housekeeping");
    expect(matchActivity("存档中…", false)).toBe("housekeeping");
  });
  test("SSE phase 原始值兜底", () => {
    expect(matchActivity("writing", false)).toBe("directing");
    expect(matchActivity("settling", false)).toBe("settling");
    expect(matchActivity("review-failed", false)).toBe("reviewing");
  });
});

// ============ presence ============

describe("presence 存在态派生", () => {
  test("无章节无任务 → dormant", () => {
    const w = emptyWorld();
    expect(deriveBrainState(w, {})!.presence).toBe("dormant");
  });
  test("有章节无任务 → standby", () => {
    const w = mkWorld();
    expect(deriveBrainState(w, {})!.presence).toBe("standby");
  });
  test("导演写作 → focused", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { busy: true, phase: "导演写作中…" });
    expect(r!.presence).toBe("focused");
    expect(r!.activity).toBe("directing");
  });
  test("审查中 → pondering", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { busy: true, phase: "审查者对抗审查中（第 1 稿）…" });
    expect(r!.presence).toBe("pondering");
    expect(r!.activity).toBe("reviewing");
  });
  test("存档中（一般事务）→ awake", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { busy: true, phase: "存档中…" });
    expect(r!.presence).toBe("awake");
    expect(r!.activity).toBe("housekeeping");
  });
  test("完整性 danger → alert（优先于 busy）", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { busy: true, phase: "导演写作中…", integrityReport: mkIntegrity(2) });
    expect(r!.presence).toBe("alert");
    expect(r!.vitals.integrityDanger).toBe(2);
  });
  test("闸门驳回（latestVerdict reject）→ alert", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { latestVerdict: { kind: "gate", verdict: "reject" } });
    expect(r!.presence).toBe("alert");
    expect(r!.governance).toBe("rejected");
  });
  test("major 质量债 >=3 → alert", () => {
    const w = mkWorld();
    w.qualityDebt = [
      { id: "1", chapterIndex: 1, lens: "continuity", issue: "x", severity: "major", status: "open" },
      { id: "2", chapterIndex: 1, lens: "logic", issue: "x", severity: "major", status: "open" },
      { id: "3", chapterIndex: 2, lens: "prose", issue: "x", severity: "major", status: "open" },
    ];
    expect(deriveBrainState(w, {})!.presence).toBe("alert");
  });
  test("eval overall <5 且无任务 → weary", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { evalReport: mkEval(4) });
    expect(r!.presence).toBe("weary");
    expect(r!.vitals.evalOverall).toBe(4);
  });
});

// ============ governance ============

describe("governance 治理裁决态派生", () => {
  test("无 brain 日志 → passthrough", () => {
    const w = mkWorld();
    expect(deriveBrainState(w, {})!.governance).toBe("passthrough");
  });
  test("brain-review 日志无 suggestions → approved", () => {
    const w = mkWorld();
    w.changeLog = [brainLog({ kind: "brain-review", detail: "章末审查通过", reason: "一致" })];
    expect(deriveBrainState(w, {})!.governance).toBe("approved");
  });
  test("brain-review 日志含 suggestions → revise", () => {
    const w = mkWorld();
    w.changeLog = [brainLog({ kind: "brain-review", detail: "建议修正", reason: "伏笔冲突", meta: { suggestions: ["弥合A"] } })];
    const r = deriveBrainState(w, {});
    expect(r!.governance).toBe("revise");
  });
  test("brain_unavailable → degraded", () => {
    const w = mkWorld();
    w.changeLog = [brainLog({ kind: "brain-review", detail: "审查不可用，降级放行", reason: "brain_unavailable" })];
    expect(deriveBrainState(w, {})!.governance).toBe("degraded");
  });
  test("rewriteQueue 非空 → pendingIntervention（最高优先）", () => {
    const w = mkWorld();
    w.changeLog = [brainLog({ kind: "brain-review", detail: "通过", reason: "ok" })];
    w.rewriteQueue = [3];
    expect(deriveBrainState(w, {})!.governance).toBe("pendingIntervention");
  });
  test("latestVerdict 覆写优先于 changeLog", () => {
    const w = mkWorld();
    w.changeLog = [brainLog({ kind: "brain-review", detail: "通过", reason: "ok" })];
    const r = deriveBrainState(w, { latestVerdict: { kind: "review", verdict: "reject" } });
    expect(r!.governance).toBe("rejected");
  });
  test("governanceRecent 倒序取最近 5 条", () => {
    const w = mkWorld();
    w.changeLog = Array.from({ length: 7 }, (_, i) =>
      brainLog({ kind: "brain-review", detail: `审查${i}`, reason: "ok", chapter: i + 1 }),
    );
    const r = deriveBrainState(w, {});
    expect(r!.governanceRecent).toHaveLength(5);
    expect(r!.governanceRecent[0].detail).toBe("审查6"); // 最新在前
  });
});

// ============ vitals ============

describe("vitals 全书健康脉象派生", () => {
  test("伏笔回收率", () => {
    const w = mkWorld();
    w.foreshadowing = [
      { id: "f1", text: "a", plantedAt: 1, status: "resolved", resolvedAt: 2 },
      { id: "f2", text: "b", plantedAt: 1, status: "planted" },
      { id: "f3", text: "c", plantedAt: 1, status: "active" },
    ];
    const v = deriveBrainState(w, {})!.vitals;
    expect(v.foreshadowResolution).toBeCloseTo(1 / 3);
    expect(v.activeForeshadowCount).toBe(2); // planted+active（均非 pending，因为 plantedAt=1 < nextChapter=3）
  });
  test("待埋设预登记不计入活跃伏笔", () => {
    const w = mkWorld();
    w.foreshadowing = [{ id: "f1", text: "a", plantedAt: 5, status: "planted" }]; // plantedAt >= nextChapter(3)
    const v = deriveBrainState(w, {})!.vitals;
    expect(v.activeForeshadowCount).toBe(0);
  });
  test("质量债计数", () => {
    const w = mkWorld();
    w.qualityDebt = [
      { id: "1", chapterIndex: 1, lens: "x", issue: "x", severity: "minor", status: "open" },
      { id: "2", chapterIndex: 1, lens: "x", issue: "x", severity: "major", status: "open" },
      { id: "3", chapterIndex: 2, lens: "x", issue: "x", severity: "major", status: "fixed" },
    ];
    const v = deriveBrainState(w, {})!.vitals;
    expect(v.qualityDebtOpen).toBe(2);
    expect(v.qualityDebtMajor).toBe(1);
  });
  test("coherence 优先取 eval「设定一致」", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { evalReport: mkEval(7, 8) });
    expect(r!.vitals.coherence).toBe(8);
    expect(r!.vitals.evalOverall).toBe(7);
  });
  test("无 eval 时 coherence 取最近章审查均值", () => {
    const w = mkWorld();
    w.chapters = [
      { index: 1, title: "一", text: "", review: { verdict: "pass", scores: { coherence: 6, tension: 5, prose: 5, pacing: 5, dialogue: 5 }, findings: [], round: 1 } },
      { index: 2, title: "二", text: "", review: { verdict: "pass", scores: { coherence: 8, tension: 5, prose: 5, pacing: 5, dialogue: 5 }, findings: [], round: 1 } },
    ];
    const v = deriveBrainState(w, {})!.vitals;
    expect(v.coherence).toBe(7); // (6+8)/2
    expect(v.evalOverall).toBeNull();
  });
  test("无 eval 无审查 → coherence null", () => {
    const w = mkWorld();
    expect(deriveBrainState(w, {})!.vitals.coherence).toBeNull();
  });
  test("disposition：结构未完结 → continue", () => {
    const w = mkWorld();
    expect(deriveBrainState(w, {})!.vitals.disposition).toBe("continue");
  });
  test("targetChapters 从 goal 派生", () => {
    const w = mkWorld();
    w.goal = { structure: { targetChapters: 20 } };
    expect(deriveBrainState(w, {})!.vitals.targetChapters).toBe(20);
  });
  test("integrityDanger 取 integrityReport", () => {
    const w = mkWorld();
    expect(deriveBrainState(w, { integrityReport: mkIntegrity(3) })!.vitals.integrityDanger).toBe(3);
    expect(deriveBrainState(w, {})!.vitals.integrityDanger).toBeNull();
  });
});

// ============ 标签常量完整性 ============

describe("中文标签常量", () => {
  test("PRESENCE_LABEL 覆盖全部 presence", () => {
    const states: BrainRuntimeInput = {};
    const w = mkWorld();
    const r = deriveBrainState(w, states)!;
    expect(PRESENCE_LABEL[r.presence]).toBeTruthy();
  });
  test("ACTIVITY_LABEL 覆盖全部 activity", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, { phase: "导演写作中…" })!;
    expect(ACTIVITY_LABEL[r.activity]).toBeTruthy();
  });
  test("GOVERNANCE_LABEL 覆盖全部 governance", () => {
    const w = mkWorld();
    const r = deriveBrainState(w, {})!;
    expect(GOVERNANCE_LABEL[r.governance]).toBeTruthy();
  });
});

// ============ null 安全 ============

describe("边界安全", () => {
  test("world=null → null", () => {
    expect(deriveBrainState(null, {})).toBeNull();
  });
  test("空 world（无可选字段）不抛错", () => {
    const w = emptyWorld();
    expect(() => deriveBrainState(w, {})).not.toThrow();
  });
});
