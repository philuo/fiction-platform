// applyStateChange 单一写接口（DEEP-DIVE §2 落地验证）
// 覆盖：分级判定（commandId 权威 / 字段启发式）、确定性预检（字段锁）、日志落 commandId/level、闸门拒绝、收尾对齐
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWorld, type WorldState } from "../src/api/world";
import { applyStateChange, applyStateChangeAsync, classifyChange } from "../src/api/statechange";
import { closeDb } from "../src/api/db";

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-statechange-"));
  process.chdir(tmp);
});
afterAll(() => {
  closeDb();
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "statechange-test";
  w.characters.push({
    id: "c1", name: "沈夜", role: "主角", traits: [], motivation: "", status: "京城捕快",
    relations: {}, introducedAt: 1, appearedIn: [1],
  });
  w.nextChapter = 2;
  return w;
}

describe("classifyChange 分级", () => {
  test("commandId 命中时取 HARNESS 指令 level（删章 L3 / 编辑 L2）", () => {
    const w = mkWorld();
    expect(classifyChange(w, { actor: "user", field: "chapters", commandId: "CMD-N08", reason: "删章" })).toBe("L3");
    expect(classifyChange(w, { actor: "user", field: "chapters", commandId: "CMD-N06", reason: "编辑" })).toBe("L2");
  });

  test("字段启发式：账本类 L2、设定类 L1、媒体类 L0", () => {
    const w = mkWorld();
    expect(classifyChange(w, { actor: "ai", field: "foreshadowing", reason: "伏笔" })).toBe("L2");
    expect(classifyChange(w, { actor: "user", field: "blueprint.compass", reason: "蓝图" })).toBe("L1");
    expect(classifyChange(w, { actor: "system", field: "chapters[].media", reason: "媒体" })).toBe("L0");
  });

  test("显式 level 优先于一切", () => {
    const w = mkWorld();
    expect(classifyChange(w, { actor: "user", field: "x", level: "L1", reason: "r" })).toBe("L1");
  });
});

describe("applyStateChange 写接口", () => {
  test("写字段 + 日志携带 commandId/level（可追溯）", () => {
    const w = mkWorld();
    const r = applyStateChange(w, {
      actor: "user", commandId: "CMD-L07", field: "foreshadowing",
      reason: "手动登记伏笔", chapter: 1,
    });
    expect(r.ok).toBe(true);
    expect(w.changeLog?.length).toBe(1);
    const e = w.changeLog![0];
    expect(e.commandId).toBe("CMD-L07");
    expect(e.level).toBe("L1"); // L07 伏笔 CRUD
    expect(e.actor).toBe("user");
  });

  test("确定性预检：字段锁阻止 status/look 覆盖", () => {
    const w = mkWorld();
    w.lockedFields = [{ characterId: "c1", field: "status" }];
    const r = applyStateChange(w, {
      actor: "ai", field: "characters", reason: "记账覆盖 status",
      value: { id: "c1", status: "新状态" },
    });
    expect(r.ok).toBe(false);
    expect(w.changeLog ?? []).toHaveLength(0); // 未写日志未改状态
  });

  test("闸门拒绝：applied:false 且日志记 brain-gate-reject", async () => {
    const w = mkWorld();
    const r = await applyStateChangeAsync(
      w,
      { actor: "user", commandId: "CMD-W04", field: "blueprint", reason: "改蓝图方向" },
      { gate: async () => ({ allow: false, reason: "与已写章节矛盾" }) },
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(false);
    expect(w.changeLog?.some((e) => e.kind === "brain-gate-reject" && e.reason === "与已写章节矛盾")).toBe(true);
  });

  test("闸门放行：写字段 + 日志", async () => {
    const w = mkWorld();
    const r = await applyStateChangeAsync(
      w,
      { actor: "user", commandId: "CMD-L07", field: "foreshadowing", reason: "登记伏笔" },
      { gate: async () => ({ allow: true }) },
    );
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(w.changeLog?.[0].commandId).toBe("CMD-L07");
  });

  test("finalizeStateChange：对齐 + 落盘", () => {
    const w = mkWorld();
    const r = applyStateChange(w, { actor: "user", field: "outline", reason: "大纲" });
    finalizeStateChangeSafe(w, r);
    // 落盘后能加载
    const { loadWorld } = require("../src/api/storage") as typeof import("../src/api/storage");
    const loaded = loadWorld(w.title);
    expect(loaded?.outline).toBeDefined();
  });
});

// 避免在测试中重复 import 循环问题的小包装
import { finalizeStateChange } from "../src/api/statechange";
function finalizeStateChangeSafe(w: WorldState, r: { ok: boolean }): void {
  finalizeStateChange(w, r);
}
