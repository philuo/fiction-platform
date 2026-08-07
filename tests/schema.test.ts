// P4 jsonschema：chatJson 的 schema 注入 + 输出校验 + 修复重试；validateJsonSchema 子集单测。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installMockAgnes } from "./mocks";

// —— 可切换 responder：bad-json（非法 JSON）/ bad-schema（缺字段）/ always-bad-schema（永远缺字段）/ ok ——
let mode: "ok" | "bad-json" | "bad-schema" | "always-bad-schema" = "ok";
let calls = 0;
installMockAgnes(() => {
  calls++;
  if (mode === "bad-json" && calls < 2) return "这不是 JSON 输出，只是一段话。";
  if (mode === "bad-schema" && calls < 2) return JSON.stringify({ name: "阿青" }); // 缺 role/traits
  if (mode === "always-bad-schema") return JSON.stringify({ name: "阿青" }); // 永远缺字段
  return JSON.stringify({ name: "阿青", role: "主角", traits: ["机警"] });
});

const { validateJsonSchema, chatJson } = await import("../src/api/jsonutil");

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-schema-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

const SCHEMA = {
  type: "object",
  required: ["name", "role", "traits"],
  properties: {
    name: { type: "string" },
    role: { type: "string", enum: ["主角", "反派", "配角"] },
    traits: { type: "array", items: { type: "string" } },
    age: { type: "integer" },
  },
};

describe("P4 validateJsonSchema（draft-07 子集）", () => {
  test("合法对象零错误", () => {
    expect(validateJsonSchema({ name: "阿青", role: "主角", traits: ["机警"], age: 20 }, SCHEMA)).toEqual([]);
  });
  test("缺必填 → 报错", () => {
    const errs = validateJsonSchema({ name: "阿青" }, SCHEMA);
    expect(errs.some((e) => e.includes("role 缺失"))).toBe(true);
    expect(errs.some((e) => e.includes("traits 缺失"))).toBe(true);
  });
  test("类型不符 → 报错（含路径）", () => {
    const errs = validateJsonSchema({ name: 42, role: "主角", traits: [] }, SCHEMA);
    expect(errs.some((e) => e.includes("$.name 期望 string"))).toBe(true);
  });
  test("枚举不符 → 报错", () => {
    const errs = validateJsonSchema({ name: "阿青", role: "路人", traits: [] }, SCHEMA);
    expect(errs.some((e) => e.includes("$.role 不在枚举内"))).toBe(true);
  });
  test("数组项类型 → 递归报错", () => {
    const errs = validateJsonSchema({ name: "阿青", role: "主角", traits: ["机警", 42] }, SCHEMA);
    expect(errs.some((e) => e.includes("$.traits[1] 期望 string"))).toBe(true);
  });
  test("integer 接受整数 number、拒绝小数", () => {
    expect(validateJsonSchema(20, { type: "integer" })).toEqual([]);
    expect(validateJsonSchema(20.5, { type: "integer" })).toHaveLength(1);
  });
});

describe("P4 chatJson + schema", () => {
  test("合法输出直接返回（不重试）", async () => {
    mode = "ok";
    calls = 0;
    const out = await chatJson<{ name: string; role: string; traits: string[] }>(
      [{ role: "user", content: "测试" }],
      { schema: SCHEMA },
    );
    expect(out.name).toBe("阿青");
    expect(calls).toBe(1);
  });
  test("非法 JSON → 修复重试成功", async () => {
    mode = "bad-json";
    calls = 0;
    const out = await chatJson<{ name: string }>([{ role: "user", content: "测试" }], { schema: SCHEMA });
    expect(out.name).toBe("阿青");
    expect(calls).toBeGreaterThanOrEqual(2); // 首次坏 + 修复
  });
  test("缺字段（schema 不符）→ 回填错误修复重试成功", async () => {
    mode = "bad-schema";
    calls = 0;
    const out = await chatJson<{ name: string; role: string; traits: string[] }>(
      [{ role: "user", content: "测试" }],
      { schema: SCHEMA },
    );
    expect(out.role).toBe("主角");
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  test("持续不符合 schema → 二次重试后抛错（不静默接受坏数据）", async () => {
    mode = "always-bad-schema";
    calls = 0;
    let threw = "";
    try {
      await chatJson<{ name: string }>([{ role: "user", content: "测试" }], { schema: SCHEMA });
    } catch (e) {
      threw = (e as Error).message;
    }
    expect(threw).toContain("不符合 JSON Schema");
    expect(calls).toBeGreaterThanOrEqual(2); // 首次 + 修复重试（仍坏 → 抛错）
    mode = "ok";
  });
  test("不传 schema：行为与旧版一致（无注入无校验）", async () => {
    mode = "ok";
    const out = await chatJson<{ name?: string }>([{ role: "user", content: "测试" }]);
    expect(out.name).toBe("阿青");
  });
});
