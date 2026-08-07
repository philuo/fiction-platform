// i2i 提示词保持前缀单测：bun test tests/i2i-prompt.test.ts
// 覆盖：i2iPreservePrefix 按 portrait/avatar/scene 产出官方 i2i [保持]+[改变] 结构，含明确保持子句；
// distinctiveLook 确定性容貌标识（弱模型区分度修复：同名复现一致、不同角色互斥）
import { test, expect } from "bun:test";
import { i2iPreservePrefix, ensureStyleSuffix, sceneGuardClause, distinctiveLook, nameSeed, genderPhrase, distinctLookForRoster } from "../src/api/media";

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

const mkChar = (name: string) => ({ id: name, name, role: "配角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });

test("genderPhrase：性别具体化（弱模型修复：「性别 男」会被忽略画出女相）", () => {
  expect(genderPhrase({ ...mkChar("沈青梧"), gender: "男", age: "二十出头" })).toBe("青年男子");
  expect(genderPhrase({ ...mkChar("魏无踪"), gender: "男", age: "四十许人" })).toBe("成年男子");
  expect(genderPhrase({ ...mkChar("温雪见"), gender: "女", age: "二十多岁" })).toBe("年轻女子");
  expect(genderPhrase({ ...mkChar("嬷"), gender: "女", age: "五十余岁" })).toBe("成年女子");
  expect(genderPhrase({ ...mkChar("少"), gender: "男", age: "十六岁" })).toBe("少年男子");
  expect(genderPhrase(mkChar("无性别"))).toBe(""); // 未知不强化
});

test("distinctiveLook：同名复现一致（头像重生成不变脸）", () => {
  expect(distinctiveLook(mkChar("沈青梧"))).toBe(distinctiveLook(mkChar("沈青梧")));
  expect(nameSeed("沈青梧")).toBe(nameSeed("沈青梧"));
});

test("distinctiveLook：《缄梦录》四个缺外貌字段的主角特征互斥（撞脸回归）", () => {
  const looks = ["沈青梧", "魏无踪", "温雪见", "赵崇"].map((n) => distinctiveLook(mkChar(n)));
  // 每个都是具体视觉词（弱模型可执行），带强约束前缀
  for (const l of looks) {
    expect(l.startsWith("容貌必须严格照此刻画：")).toBe(true);
    expect(l).toContain("脸");
    expect(l).toContain("身形");
  }
  // 四人特征串互不相同（组合互斥）
  expect(new Set(looks).size).toBe(4);
});

test("distinctiveLook：不含发型词（eraDress 时代发型约束优先，避免冲突）", () => {
  for (const n of ["沈青梧", "魏无踪", "温雪见", "赵崇", "刘二", "柳青霜"]) {
    const l = distinctiveLook(mkChar(n));
    expect(l).not.toContain("发髭");
    expect(l).not.toContain("束发");
    expect(l).not.toContain("披发");
  }
});

test("distinctiveLook：肤色只取实测稳定枚举（稳定优先：古铜/偏深/红润均不得出现）", () => {
  for (const n of ["沈青梧", "魏无踪", "温雪见", "赵崇", "刘二", "柳青霜", "顾昭", "谢婉", "老周", "秦夫人", "阿衡", "阿阮"]) {
    const l = distinctiveLook(mkChar(n));
    expect(l).not.toContain("古铜");
    expect(l).not.toContain("偏深");
    expect(l).not.toContain("红润");
    expect(/肤色白皙|小麦色肤色/.test(l)).toBe(true);
  }
});

test("distinctLookForRoster：同书脸型+眉眼撞车避让（池子收缩后防兄弟姐妹脸）", () => {
  // 构造两个 salt0 下脸型+眉眼相同的角色（遍历找一对碰撞名）
  const key = (n: string) => distinctiveLook(mkChar(n)).split("，").slice(0, 2).join("，");
  const names = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "子", "丑"];
  let a = "", b = "";
  outer: for (const x of names) for (const y of names) if (x !== y && key(x) === key(y)) { a = x; b = y; break outer; }
  if (a) {
    const roster = [mkChar(a), mkChar(b)];
    const la = distinctLookForRoster(roster[0], roster);
    const lb = distinctLookForRoster(roster[1], roster);
    expect(la.split("，").slice(0, 2).join("，")).not.toBe(lb.split("，").slice(0, 2).join("，"));
  }
  // 视觉自检六人：避让后脸型+眉眼两两互斥
  const six = ["顾昭", "谢婉", "老周", "秦夫人", "阿衡", "阿阮"].map(mkChar);
  const keys = six.map((c) => distinctLookForRoster(c, six).split("，").slice(0, 2).join("，"));
  expect(new Set(keys).size).toBe(6);
});

test("distinctiveLook：少年/少女身形不取 hash 池（防「十五岁书童」配「壮硕高大」年龄错配）", () => {
  expect(distinctiveLook({ ...mkChar("阿衡"), gender: "男", age: "十五岁" })).toContain("身形纤细瘦小");
  expect(distinctiveLook({ ...mkChar("阿阮"), gender: "女", age: "十六岁" })).toContain("身形纤细瘦小");
});

test("distinctiveLook：身形池按性别过滤（防老周配「娇小」/秦夫人配「宽肩魁梧」性别错配）", () => {
  for (const n of ["顾昭", "老周", "阿衡", "沈青梧", "魏无踪", "赵崇"]) {
    expect(distinctiveLook({ ...mkChar(n), gender: "男" })).not.toContain("娇小");
  }
  for (const n of ["谢婉", "秦夫人", "阿阮", "温雪见"]) {
    expect(distinctiveLook({ ...mkChar(n), gender: "女" })).not.toContain("魁梧");
    expect(distinctiveLook({ ...mkChar(n), gender: "女" })).not.toContain("壮硕");
  }
});
