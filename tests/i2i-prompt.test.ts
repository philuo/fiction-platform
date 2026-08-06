// i2i 提示词保持前缀单测：bun test tests/i2i-prompt.test.ts
// 覆盖：i2iPreservePrefix 按 portrait/avatar/scene 产出官方 i2i [保持]+[改变] 结构，含明确保持子句
import { test, expect } from "bun:test";
import { i2iPreservePrefix, ensureStyleSuffix, sceneGuardClause } from "../src/api/media";

test("portrait：前缀含容貌基准 + 保持五官发型身形 + 不照搬背景 + 重绘引导", () => {
  const p = i2iPreservePrefix("portrait", "沈夜");
  expect(p).toContain("「沈夜」");
  expect(p).toContain("容貌基准");
  expect(p).toContain("保持面部五官、发型、身形");
  expect(p).toContain("不得改变样貌或换人");
  expect(p).toContain("不照搬参考图背景");
  expect(p).toContain("重绘全身立绘");
  // 拼接 T2I 提示词后，整体是 [保持] + [改变] 结构
  const full = p + ensureStyleSuffix("全身立绘描述", "电影级动漫插画");
  expect(full.indexOf("容貌基准")).toBeLessThan(full.indexOf("全身立绘描述"));
});

test("avatar：前缀含保持面部发型神态 + 正面头像特写引导", () => {
  const p = i2iPreservePrefix("avatar");
  expect(p).toContain("容貌基准");
  expect(p).toContain("面部五官、发型、神态");
  expect(p).toContain("不得改变样貌或换人");
  expect(p).toContain("正面头像特写");
});

test("scene：前缀含参考图作样貌基准 + 多角色禁复制 + 不照搬场景构图 + 生成新画面引导", () => {
  const p = i2iPreservePrefix("scene");
  expect(p).toContain("画面主体的样貌参考");
  expect(p).toContain("画面中该角色须与参考图保持一致");
  expect(p).toContain("不得改变样貌或换人");
  expect(p).toContain("严禁复制或复用参考图人物形象（禁止分身）");
  expect(p).toContain("每个角色只能出现一次");
  expect(p).toContain("不得照搬参考图的场景与构图");
  expect(p).toContain("生成新画面");
});

test("三个 target 的保持措辞互不相同（按用途区分）", () => {
  const portrait = i2iPreservePrefix("portrait", "X");
  const avatar = i2iPreservePrefix("avatar");
  const scene = i2iPreservePrefix("scene");
  expect(portrait).not.toBe(avatar);
  expect(avatar).not.toBe(scene);
  expect(portrait).toContain("身形"); // 立绘全身
  expect(avatar).toContain("神态"); // 头像特写
  expect(scene).toContain("服饰、身形"); // 场景含服饰
});

test("name 缺省时 portrait 不含书名号角色名", () => {
  const p = i2iPreservePrefix("portrait");
  expect(p).not.toContain("「");
  expect(p).toContain("容貌基准");
});

test("sceneGuardClause：多人→共 N 人名单+状态一一对应+禁名单外/分身；单人→仅一人+禁其他人物；纯场景→空", () => {
  const roster = ["沈夜", "魏无咎", "柳青霜"];
  // 多人：scene 点名 2 个角色名
  const multi = sceneGuardClause("沈夜被铁链锁于刑架，魏无咎立于阴影中", roster);
  expect(multi).toContain("画面中共 2 人");
  expect(multi).toContain("沈夜、魏无咎");
  expect(multi).toContain("状态与动作按上述描述一一对应");
  expect(multi).toContain("不得出现名单之外的额外人物");
  expect(multi).toContain("禁止复制分身");
  // 单人：只点名 1 个角色
  const single = sceneGuardClause("沈夜被铁链锁于刑架，腹部的伤口渗血", roster);
  expect(single).toContain("画面中仅 沈夜 一人");
  expect(single).toContain("不得出现任何其他人物");
  expect(single).toContain("禁止分身");
  // 纯环境场景：无角色名 → 空
  expect(sceneGuardClause("月色清冷的巷口，更夫的梆子声", roster)).toBe("");
  // 名单外人物名不识别（服饰/物件词不当角色）："织金蟒袍"含"蟒"但不属于名册
  expect(sceneGuardClause("沈夜身着青灰色短打，魏无咎身着玄色织金蟒袍", roster).length).toBeGreaterThan(0);
  expect(sceneGuardClause("织金蟒袍在月光下泛幽光", roster)).toBe("");
});
