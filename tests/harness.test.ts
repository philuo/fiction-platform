// HARNESS 指令注册表完整性（docs/HARNESS.md 代码化验证）
// 覆盖：注册表总数、ID 唯一性、ID 格式、7 类别分布、写指令/只读统计、L3 不可逆条数
import { describe, expect, test } from "bun:test";
import { COMMANDS, COMMAND_COUNTS, getCommand, commandsByGovernance, levelOf } from "../src/api/harness";

describe("HARNESS 指令注册表", () => {
  test("统计总数由注册表实时派生", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    expect(COMMAND_COUNTS.total).toBe(COMMANDS.length);
  });

  test("ID 唯一且格式为 CMD-{类别}-{序号}", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(COMMANDS.length);
    for (const id of ids) {
      expect(id).toMatch(/^CMD-(N|W|L|M|G|S|Q)\d+$/);
    }
  });

  test("7 类别分布与 HARNESS 统计一致", () => {
    const sum = Object.values(COMMAND_COUNTS.byCategory).reduce((a, b) => a + b, 0);
    expect(sum).toBe(COMMANDS.length);
    for (const category of ["Narrative", "World", "Ledger", "Media", "Governance", "System", "Query"] as const) {
      expect(COMMAND_COUNTS.byCategory[category]).toBe(COMMANDS.filter((c) => c.category === category).length);
    }
  });

  test("写指令/只读统计动态派生，L3 不可逆包含删章/删书", () => {
    expect(COMMAND_COUNTS.writers).toBe(COMMANDS.filter((c) => ["L1", "L2", "L3"].includes(c.level)).length);
    expect(COMMAND_COUNTS.readOnly).toBe(COMMANDS.filter((c) => c.level === "L0").length);
    expect(COMMAND_COUNTS.l3).toBe(3);
    const l3 = COMMANDS.filter((c) => c.level === "L3").map((c) => c.id).sort();
    expect(l3).toEqual(["CMD-N08", "CMD-S03", "CMD-S12"]);
  });

  test("getCommand / commandsByGovernance / levelOf 工作", () => {
    expect(getCommand("CMD-N06")?.name).toContain("editChapter");
    expect(getCommand("CMD-XXX")).toBeUndefined();
    expect(commandsByGovernance("gate").length).toBeGreaterThan(0);
    expect(levelOf("CMD-N08")).toBe("L3");
    expect(levelOf("CMD-未知")).toBe("L0"); // 未登记保守 L0
  });

  test("关键指令元数据完备（影响字段/失败语义/治理点）", () => {
    for (const c of COMMANDS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.action.length).toBeGreaterThan(0);
      expect(c.affects.length).toBeGreaterThan(0);
      expect(c.failure.length).toBeGreaterThan(0);
      expect(c.governance.length).toBeGreaterThan(0);
    }
  });
});
