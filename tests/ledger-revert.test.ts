// 删除章节账本恢复（git 式变更快照）：bun test tests/ledger-revert.test.ts
// 覆盖：有 delta 时角色 status/look/当前状态/弧线/伏笔回收恢复；后续章冲突保留；无 delta 降级提示
import { describe, expect, test } from "bun:test";
import { emptyWorld, type ChapterDelta, type WorldState } from "../src/api/world";
import { applyChapterDeltaRevert, deleteChapterCascade } from "../src/api/integrity";

/** 构造 3 章世界 + 第 2 章结算快照（模拟结算结果：沈夜 look 变更、离场、伏笔回收、当前状态、弧线） */
function buildWorld(): WorldState {
  const w = emptyWorld();
  w.title = "断梦录";
  w.current = "第一章后：京师暗流涌动";
  w.characters.push({
    id: "c1", name: "沈夜", role: "主角", traits: [], motivation: "", status: "初入京城",
    look: "青衫负剑", relations: {}, introducedAt: 1,
  });
  w.characters.push({
    id: "c2", name: "柳青霜", role: "配角", traits: [], motivation: "", status: "医馆坐诊",
    relations: {}, introducedAt: 1,
  });
  w.foreshadowing.push({ id: "f1", text: "黄帖之谜", plantedAt: 1, status: "active" });
  w.plotThreads = [{ id: "t1", name: "追查黄帖", status: "进行中", note: "第一章线索浮现" }];
  w.chapterDeltas = {
    2: {
      chapter: 2,
      at: "2026-08-03T00:00:00.000Z",
      plantedForeshadowIds: ["f2"],
      resolvedForeshadows: [{ id: "f1", prevStatus: "active", prevResolvedAt: undefined, prevNote: undefined }],
      characterUpdates: [
        { id: "c1", name: "沈夜", status: { old: "初入京城", neu: "重伤昏迷" }, look: { old: "青衫负剑", neu: "面色惨白，额上青筋暴起" } },
      ],
      exitIds: [],
      worldCurrent: { old: "第一章后：京师暗流涌动", neu: "第二章后：沈夜昏迷，柳青霜施针救治" },
      plotThreadUpdates: [{ id: "t1", oldStatus: "进行中", newStatus: "已解决", oldNote: "第一章线索浮现", newNote: "黄帖现世，线索汇聚" }],
      proposalIds: [],
    },
  };
  w.foreshadowing.push({ id: "f2", text: "纸屑中的秘密", plantedAt: 2, status: "planted" });
  w.foreshadowing.find((f) => f.id === "f1")!.status = "resolved";
  w.foreshadowing.find((f) => f.id === "f1")!.resolvedAt = 2;
  w.foreshadowing.find((f) => f.id === "f1")!.note = "第2章回收：黄帖现世";
  w.characters[0].status = "重伤昏迷";
  w.characters[0].look = "面色惨白，额上青筋暴起";
  w.current = "第二章后：沈夜昏迷，柳青霜施针救治";
  w.plotThreads[0].status = "已解决";
  w.plotThreads[0].note = "黄帖现世，线索汇聚";
  w.chapters = [
    { index: 1, title: "一", text: "…", review: null },
    { index: 2, title: "二", text: "…", review: null },
    { index: 3, title: "三", text: "…", review: null },
  ];
  return w;
}

describe("删除章节账本恢复（git 式变更快照）", () => {
  test("有快照：角色形象/状态、当前状态、弧线、伏笔回收全部恢复旧值", () => {
    const w = buildWorld();
    const r = deleteChapterCascade(w, 2);
    const kinds = r.findings.map((f) => f.kind);
    // 角色 status/look 恢复
    expect(w.characters.find((c) => c.id === "c1")!.status).toBe("初入京城");
    expect(w.characters.find((c) => c.id === "c1")!.look).toBe("青衫负剑");
    // 当前状态恢复
    expect(w.current).toBe("第一章后：京师暗流涌动");
    // 弧线恢复
    expect(w.plotThreads![0].status).toBe("进行中");
    expect(w.plotThreads![0].note).toBe("第一章线索浮现");
    // 伏笔回收回退为 active
    const f1 = w.foreshadowing.find((f) => f.id === "f1")!;
    expect(f1.status).toBe("active");
    expect(f1.resolvedAt).toBeUndefined();
    // 本章埋设未回收的伏笔删除
    expect(w.foreshadowing.find((f) => f.id === "f2")).toBeUndefined();
    // 快照本身已移除
    expect(w.chapterDeltas?.[2]).toBeUndefined();
    // 报告含恢复项（伏笔回退 + 角色 status/look + 当前状态 + 弧线 = 5 项）
    expect(kinds.filter((k) => k === "delta-restored").length).toBeGreaterThanOrEqual(5);
    // 章节本体已删（允许空洞，不重排）
    expect(w.chapters.map((c) => c.index)).toEqual([1, 3]);
  });

  test("冲突：后续章更新过同一角色 look/status，删除中间章后保留后续值并报告", () => {
    const w = buildWorld();
    // 第 3 章结算快照：继续更新沈夜 look（冲突源）
    w.chapterDeltas![3] = {
      chapter: 3,
      at: "2026-08-03T00:00:01.000Z",
      plantedForeshadowIds: [],
      resolvedForeshadows: [],
      characterUpdates: [{ id: "c1", name: "沈夜", look: { old: "面色惨白，额上青筋暴起", neu: "苏醒，青衫染血" } }],
      exitIds: [],
      worldCurrent: { old: "第二章后：沈夜昏迷，柳青霜施针救治", neu: "第三章后：沈夜苏醒" },
      plotThreadUpdates: [],
      proposalIds: [],
    };
    // 应用第 3 章结算后的世界状态（与快照对应）
    w.characters[0].look = "苏醒，青衫染血";
    w.current = "第三章后：沈夜苏醒";
    const r = deleteChapterCascade(w, 2);
    // 沈夜 look 保留第 3 章的值（冲突）；status 无后续变更，恢复旧值
    expect(w.characters.find((c) => c.id === "c1")!.look).toBe("苏醒，青衫染血");
    expect(w.characters.find((c) => c.id === "c1")!.status).toBe("初入京城");
    // 当前状态被第 3 章继续更新 → 保留
    expect(w.current).toBe("第三章后：沈夜苏醒");
    // 报告含冲突项
    expect(r.findings.some((f) => f.kind === "delta-conflict" && f.issue.includes("形象"))).toBe(true);
    expect(r.findings.some((f) => f.kind === "delta-conflict" && f.issue.includes("当前状态"))).toBe(true);
    // 后续章快照保留（不受删除影响）
    expect(w.chapterDeltas?.[3]).toBeDefined();
  });

  test("无快照：降级为基础清理并提示 delta-missing", () => {
    const w = buildWorld();
    delete w.chapterDeltas;
    const r = deleteChapterCascade(w, 2);
    expect(r.findings.some((f) => f.kind === "delta-missing")).toBe(true);
    // 基础清理仍生效：该章时间线/摘要/伏笔（未回收）/登场重算
    expect(w.chapters.map((c) => c.index)).toEqual([1, 3]);
    expect(w.foreshadowing.find((f) => f.id === "f2")).toBeUndefined();
    // 无快照时不恢复覆盖值（保持现状）
    expect(w.characters.find((c) => c.id === "c1")!.status).toBe("重伤昏迷");
  });

  test("离场记录随删除清除（快照 exitIds 命中）", () => {
    const w = buildWorld();
    w.characters[1].exit = { chapter: 2, reason: "离京远行" };
    w.chapterDeltas![2].exitIds = ["c2"];
    const r = deleteChapterCascade(w, 2);
    expect(w.characters.find((c) => c.id === "c2")!.exit).toBeUndefined();
    expect(r.findings.some((f) => f.kind === "exit-cleared")).toBe(true);
  });

  test("applyChapterDeltaRevert 独立纯函数：pending 提案移除、confirmed 留痕", () => {
    const w = buildWorld();
    w.characterProposals = [
      { id: "cp1", name: "神秘老者", role: "配角", traits: [], motivation: "", source: "writer", status: "pending" },
      { id: "cp2", name: "药童", role: "配角", traits: [], motivation: "", source: "writer", status: "confirmed" },
    ];
    w.chapterDeltas![2].proposalIds = ["cp1", "cp2"];
    const r = deleteChapterCascade(w, 2);
    // pending 移除；confirmed 保留 + 留痕
    expect(w.characterProposals!.some((p) => p.id === "cp1")).toBe(false);
    expect(w.characterProposals!.some((p) => p.id === "cp2")).toBe(true);
    expect(r.findings.some((f) => f.kind === "delta-conflict" && f.issue.includes("已确认入册"))).toBe(true);
  });
});
