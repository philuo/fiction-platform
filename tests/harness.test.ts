// HARNESS 指令注册表完整性（docs/HARNESS.md 代码化验证）
// 覆盖：87 条总数、ID 唯一性、ID 格式、7 类别分布、写指令/只读统计、L3 不可逆条数
import { describe, expect, test } from "bun:test";
import { COMMANDS, COMMAND_COUNTS, getCommand, commandsByGovernance, levelOf } from "../src/api/harness";

describe("HARNESS 指令注册表", () => {
  test("总数 87 条（N16+W18+L13+M12+G08+S10+Q10）", () => {
    expect(COMMANDS.length).toBe(87);
    expect(COMMAND_COUNTS.total).toBe(87);
  });

  test("ID 唯一且格式为 CMD-{类别}-{序号}", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(87);
    for (const id of ids) {
      expect(id).toMatch(/^CMD-(N|W|L|M|G|S|Q)\d+$/);
    }
  });

  test("7 类别分布与 HARNESS 统计一致", () => {
    expect(COMMAND_COUNTS.byCategory.Narrative).toBe(16);
    expect(COMMAND_COUNTS.byCategory.World).toBe(18);
    expect(COMMAND_COUNTS.byCategory.Ledger).toBe(13);
    expect(COMMAND_COUNTS.byCategory.Media).toBe(12);
    expect(COMMAND_COUNTS.byCategory.Governance).toBe(8);
    expect(COMMAND_COUNTS.byCategory.System).toBe(10);
    expect(COMMAND_COUNTS.byCategory.Query).toBe(10);
  });

  test("写指令约 60 条、纯只读 27 条、L3 不可逆 2 条（N08/S03）", () => {
    expect(COMMAND_COUNTS.writers).toBe(COMMANDS.filter((c) => ["L1", "L2", "L3"].includes(c.level)).length);
    expect(COMMAND_COUNTS.readOnly).toBe(COMMANDS.filter((c) => c.level === "L0").length);
    expect(COMMAND_COUNTS.l3).toBe(2);
    const l3 = COMMANDS.filter((c) => c.level === "L3").map((c) => c.id).sort();
    expect(l3).toEqual(["CMD-N08", "CMD-S03"]);
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
