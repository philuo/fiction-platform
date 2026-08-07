// 生图词汇遵循度实验场（docs 计划：≥200 对头像+立绘对照样本）。
// 产物落项目根 lab/（不落 data/，避免被 listStoriesMeta 扫进书单）；lab/manifest.json 断点续跑。
// 用例矩阵：A 容貌单变量27 / B 身份服饰60 / C 时代7 / D 表情20 / E 姿态16 / F 配饰16 /
//           G 组合预期20 / H 稳定性24 / I 画风7 / J 禁帽对照6 = 203 对（406 张）。
// prompt 组装复用生产函数（eraDress/styleAnchor/identityDress/genderPhrase/genderFaceHint/
// NO_HAT_CLAUSE/i2iPreservePrefix/ensureStyleSuffix），测即用；D/E/F 为候选新槽位。
// 运行：bun scripts/prompt-lab.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { emptyWorld, type Character, type WorldState } from "../src/api/world";
import { generateImage, compressToJpeg } from "../src/api/images";
import {
  i2iPreservePrefix, ensureStyleSuffix,
  eraDress, styleAnchor, identityDress, genderPhrase, genderFaceHint,
  NO_HAT_CLAUSE, IDENTITY_DRESS_RULES, distinctiveLook,
} from "../src/api/media";

const LAB = join(process.cwd(), "lab");
const IMG = join(LAB, "images");
mkdirSync(IMG, { recursive: true });
const MANIFEST = join(LAB, "manifest.json");

export type LabCase = {
  id: string; cat: string; word: string; gender?: string; repeatGroup?: string;
  avPrompt: string; ptPrompt: string;
  aFile?: string; pFile?: string; status?: "ok" | "failed"; err?: string;
};

// —— 基底世界/角色 ——
const mkWorld = (time: string, genre: string, tone = "冷峻"): WorldState => {
  const w = emptyWorld();
  w.title = "词汇实验";
  w.genre = genre;
  w.setting = { time, place: "京城", rules: [], tone };
  return w;
};
const MING = () => mkWorld("明朝", "古风悬疑");

type AvOpts = {
  name: string; gender?: string; age?: string; identity?: string;
  look?: string; expression?: string; accessory?: string; idDress?: string; withHatClause?: boolean;
};

/** 头像 prompt（镜像生产 generateCharacterAvatar 结构，支持单变量覆盖） */
function composeAvatar(w: WorldState, o: AvOpts): string {
  const c = { id: "x", name: o.name, role: "配角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0, gender: o.gender, age: o.age, identity: o.identity } as Character;
  const gp = genderPhrase(c);
  const gLead = gp ? `${gp}，` : "";
  const gFace = genderFaceHint(c);
  const gClause = gp ? `；此人是${gp}，${gFace ? `${gFace}，` : ""}必须画出鲜明的${gp}相貌与体态，严禁画成异性` : "";
  const baseAttrs = `性别 ${o.gender ?? "未知"}，年龄 ${o.age ?? "未知"}，身份 ${o.identity ?? "—"}`;
  const look = o.look ?? distinctiveLook(c);
  const idDress = o.idDress ?? identityDress(c);
  const hat = o.withHatClause === false ? "" : `；${NO_HAT_CLAUSE}`;
  const expr = o.expression ? `；表情${o.expression}` : "";
  const acc = o.accessory ? `；${o.accessory}` : "";
  return `${gLead}${o.name}的方形头像：${baseAttrs}；${look}${gClause}${expr}${acc}；时代背景 ${w.setting.time || "—"}，时代服饰：${eraDress(w)}，无现代元素${idDress ? `；身份服饰：${idDress}` : ""}${hat}；背景为干净的纯色背景（单一色调，无场景、无图案、无文字）；正面头像特写，面向观者，神情姿态符合其身份，${styleAnchor(w)}，画面中不要出现文字，无水印`;
}

/** 立绘 prompt（镜像生产短改变 prompt，支持姿态/表情候选槽位） */
function composePortrait(w: WorldState, o: AvOpts, pose?: string, expression?: string): string {
  const base = `《词汇实验》角色「${o.name}」的全身立绘：与参考头像完全同一人，性别与参考头像一致，容貌、发型、服饰全部保持参考图原样不变；仅将头像特写改为竖版单人全身像：正面站立面向观者，全身完整入画${pose ? `，${pose}` : ""}${expression ? `，表情${expression}` : ""}；${NO_HAT_CLAUSE}；背景为干净的纯色背景（单一色调，无场景、无图案、无文字）`;
  return i2iPreservePrefix("portrait", o.name) + ensureStyleSuffix(base, styleAnchor(w));
}

// —— 用例矩阵 ——
const cases: LabCase[] = [];
const push = (id: string, cat: string, word: string, w: WorldState, o: AvOpts, pose?: string, expression?: string, repeatGroup?: string, gender?: string) =>
  cases.push({ id, cat, word, gender, repeatGroup, avPrompt: composeAvatar(w, o), ptPrompt: composePortrait(w, o, pose, expression) });

// A 容貌单变量 27（固定基底：明·男·二十出头，每次只换一词）
const A_FACE = ["鹅蛋脸", "瓜子脸", "方圆脸", "长脸", "菱形脸", "圆脸", "方脸"];
const A_EYES = ["剑眉星目", "浓眉大眼", "细长眉眼", "柳叶眉杏眼", "平眉深眼窝", "挑眉凤眼"];
const A_SKIN = ["肤色白皙", "小麦色肤色"];
const A_BUILD = ["身形高挑清瘦", "身形壮硕高大", "身形娇小", "身形中等匀称", "身形宽肩魁梧", "身形修长挺拔"];
const lookOf = (f: string, e: string, s: string, b: string) => `容貌必须严格照此刻画：${f}，${e}，${s}，${b}`;
A_FACE.forEach((v, i) => push(`A-face-${i}`, "A", v, MING(), { name: "甲", gender: "男", age: "二十出头", look: lookOf(v, "浓眉大眼", "肤色白皙", "身形高挑清瘦") }, undefined, undefined, undefined, "男"));
A_EYES.forEach((v, i) => push(`A-eyes-${i}`, "A", v, MING(), { name: "甲", gender: "男", age: "二十出头", look: lookOf("长脸", v, "肤色白皙", "身形高挑清瘦") }, undefined, undefined, undefined, "男"));
A_SKIN.forEach((v, i) => push(`A-skin-${i}`, "A", v, MING(), { name: "甲", gender: "男", age: "二十出头", look: lookOf("长脸", "浓眉大眼", v, "身形高挑清瘦") }, undefined, undefined, undefined, "男"));
A_BUILD.forEach((v, i) => push(`A-build-${i}`, "A", v, MING(), { name: "甲", gender: "男", age: "二十出头", look: lookOf("长脸", "浓眉大眼", "肤色白皙", v) }, undefined, undefined, undefined, "男"));
// 性别档位 5（+1 未知=6）
const A_GENDER: [string | undefined, string | undefined][] = [["男", "二十出头"], ["男", "四十许人"], ["男", "十五岁"], ["女", "二十出头"], ["女", "四十许人"], [undefined, undefined]];
A_GENDER.forEach(([g, a], i) => push(`A-gender-${i}`, "A", g ? `${g}·${a}` : "未知", MING(), { name: "甲", gender: g, age: a }, undefined, undefined, undefined, g));

// B 身份服饰抽样 60（步进取 45 + 疑似臆想 15，去重）
const SUS_KEYS = ["丹修", "相师", "星际商人", "修表", "催眠", "驱魔", "炼金", "海盗", "厨师", "书店", "美容师", "健身", "僧", "皇帝", "乞丐"];
const bPicked: typeof IDENTITY_DRESS_RULES = [];
const step = Math.max(1, Math.floor(IDENTITY_DRESS_RULES.length / 45));
for (let i = 0; i < IDENTITY_DRESS_RULES.length && bPicked.length < 45; i += step) bPicked.push(IDENTITY_DRESS_RULES[i]);
for (const k of SUS_KEYS) {
  const r = IDENTITY_DRESS_RULES.find((r) => r.keys.includes(k));
  if (r && !bPicked.includes(r) && bPicked.length < 60) bPicked.push(r);
}
bPicked.slice(0, 60).forEach((r, i) => {
  const female = /裙|褙子|襦|女|绣娘|丫鬟|媒婆|嫔|嬷|舞|钗|花钿/.test(r.dress);
  const gender = female ? "女" : "男";
  push(`B-${String(i).padStart(2, "0")}`, "B", `${r.keys[0]}→${r.dress}`, MING(), { name: "乙", gender, age: "三十许人", identity: r.keys[0], idDress: r.dress }, undefined, undefined, undefined, gender);
});

// C 时代服饰 7
const C_ERAS: [string, string][] = [["明朝", "古风悬疑"], ["唐朝", "古风悬疑"], ["宋朝", "古风悬疑"], ["西汉", "古风悬疑"], ["民国", "年代传奇"], ["现代", "都市现实"], ["未来", "科幻星际"]];
C_ERAS.forEach(([t, g], i) => push(`C-${i}`, "C", t, mkWorld(t, g), { name: "丙", gender: "男", age: "三十许人" }, undefined, undefined, undefined, "男"));

// D 表情 20（候选槽位：男10+女10）
const D_M = ["微笑", "冷峻", "愁苦", "怒目", "温和", "狡黠", "警惕", "茫然", "从容", "凶悍"];
const D_F = ["微笑", "冷峻", "愁苦", "嗔怒", "温柔", "狡黠", "警惕", "茫然", "从容", "羞涩"];
D_M.forEach((v, i) => push(`D-m-${i}`, "D", v, MING(), { name: "丁", gender: "男", age: "二十出头", expression: v }, undefined, v, undefined, "男"));
D_F.forEach((v, i) => push(`D-f-${i}`, "D", v, MING(), { name: "丁", gender: "女", age: "二十出头", expression: v }, undefined, v, undefined, "女"));

// E 姿态 16（立绘侧评分）
const E_POSE = ["负手而立", "拱手作揖", "手持长剑", "捧书于胸", "执折扇", "抱臂而立", "双手交叠于身前", "背负药篓", "手按腰间刀柄", "怀抱古琴", "手执长弓", "肩扛扁担", "手托托盘", "手提灯笼", "腰佩长剑", "手捻佛珠"];
E_POSE.forEach((v, i) => push(`E-${String(i).padStart(2, "0")}`, "E", v, MING(), { name: "戊", gender: "男", age: "三十许人" }, v, undefined, undefined, "男"));

// F 配饰物件 16
const F_ACC = ["腰间佩玉佩", "腰间佩刀", "肩挎药箱", "手持算盘", "颈戴长命锁", "左眼戴眼罩", "脸上有一道长疤", "额头点朱砂痣", "腰悬酒葫芦", "腰插竹笛", "背负长弓", "手执拂尘", "颈挂念珠", "鬓簪红花", "耳戴银环", "手戴玉镯"];
F_ACC.forEach((v, i) => {
  const g = i % 2 ? "女" : "男";
  push(`F-${String(i).padStart(2, "0")}`, "F", v, MING(), { name: "己", gender: g, age: "二十出头", accessory: v }, undefined, undefined, undefined, g);
});

// G 组合预期 20（性别+年龄+身份+表情+姿态完整卡）
const G_COMBOS: { g: string; a: string; id: string; e: string; p: string }[] = [
  { g: "女", a: "二十出头", id: "女捕快", e: "冷峻", p: "手按腰间刀柄" },
  { g: "男", a: "四十许人", id: "老船工", e: "沧桑", p: "负手而立" },
  { g: "男", a: "二十出头", id: "书生", e: "温和", p: "捧书于胸" },
  { g: "女", a: "四十许人", id: "官媒", e: "精明", p: "执折扇" },
  { g: "男", a: "十五岁", id: "书童", e: "机灵", p: "捧书于胸" },
  { g: "女", a: "十六岁", id: "丫鬟", e: "羞涩", p: "双手交叠于身前" },
  { g: "男", a: "五十余岁", id: "仵作", e: "沉稳", p: "肩挎药箱" },
  { g: "男", a: "三十许人", id: "将军", e: "威严", p: "手按腰间刀柄" },
  { g: "女", a: "二十多岁", id: "绣娘", e: "温柔", p: "双手交叠于身前" },
  { g: "男", a: "四十多岁", id: "东厂提督", e: "阴鸷", p: "负手而立" },
  { g: "男", a: "二十出头", id: "剑客", e: "冷峻", p: "手持长剑" },
  { g: "女", a: "三十许人", id: "道姑", e: "淡然", p: "手执拂尘" },
  { g: "男", a: "六十余岁", id: "老郎中", e: "慈祥", p: "肩挎药箱" },
  { g: "女", a: "五十余岁", id: "稳婆", e: "热忱", p: "手托托盘" },
  { g: "男", a: "三十许人", id: "铁匠", e: "豪爽", p: "抱臂而立" },
  { g: "女", a: "二十出头", id: "卖唱女", e: "哀婉", p: "怀抱古琴" },
  { g: "男", a: "二十出头", id: "捕快", e: "警惕", p: "手按腰间刀柄" },
  { g: "男", a: "四十许人", id: "账房先生", e: "精明", p: "手持算盘" },
  { g: "女", a: "三十许人", id: "镖师", e: "干练", p: "腰佩长剑" },
  { g: "男", a: "二十出头", id: "乞丐", e: "茫然", p: "肩扛扁担" },
];
G_COMBOS.forEach((c, i) => push(`G-${String(i).padStart(2, "0")}`, "G", `${c.g}/${c.a}/${c.id}/${c.e}/${c.p}`, MING(), { name: "庚", gender: c.g, age: c.a, identity: c.id, expression: c.e }, c.p, c.e, undefined, c.g));

// H 稳定性 24（8 组 × 3 次，同 prompt 重复）
for (let gI = 0; gI < 8; gI++) {
  const c = G_COMBOS[gI];
  const w = MING();
  const o: AvOpts = { name: "辛", gender: c.g, age: c.a, identity: c.id, expression: c.e };
  const av = composeAvatar(w, o);
  const pt = composePortrait(w, o, c.p, c.e);
  for (let r = 0; r < 3; r++) cases.push({ id: `H-${gI}-${r}`, cat: "H", word: `${c.g}/${c.id}`, gender: c.g, repeatGroup: `H-${gI}`, avPrompt: av, ptPrompt: pt });
}

// I 画风锚点 7（同一角色，七档 genre/tone）
const I_STYLES: [string, string][] = [["古风", "仙侠"], ["科幻", "赛博"], ["悬疑", "暗黑"], ["奇幻", "史诗"], ["都市", "现代"], ["言情", "浪漫"], ["武侠", "江湖"]];
I_STYLES.forEach(([g, t], i) => push(`I-${i}`, "I", `${g}/${t}`, mkWorld("明朝", g, t), { name: "壬", gender: "男", age: "二十出头" }, undefined, undefined, undefined, "男"));

// J 禁帽对照 6（3 配置 × 有/无 NO_HAT_CLAUSE）
const J_CFG: [string, string | undefined][] = [["明朝", "男"], ["明朝", "女"], ["宋朝", "男"]];
J_CFG.forEach(([t, g], i) => {
  const w = mkWorld(t, "古风悬疑");
  const base: AvOpts = { name: "癸", gender: g, age: "三十许人" };
  push(`J-${i}a`, "J", `${t}${g}·有禁帽`, w, { ...base, withHatClause: true }, undefined, undefined, undefined, g);
  push(`J-${i}b`, "J", `${t}${g}·无禁帽`, w, { ...base, withHatClause: false }, undefined, undefined, undefined, g);
});

// —— 执行：并发 4 + 启动间隔节流（≤40/min）+ 单次重试 + 断点续跑 ——
const done = new Map<string, LabCase>();
if (existsSync(MANIFEST)) {
  for (const c of JSON.parse(readFileSync(MANIFEST, "utf-8")) as LabCase[]) if (c.status === "ok") done.set(c.id, c);
}
const todo = cases.filter((c) => !done.has(c.id));
const saveManifest = () => {
  const all = [...done.values(), ...cases.filter((c) => c.status === "failed")];
  writeFileSync(MANIFEST, JSON.stringify(all, null, 1));
};
console.log(`[lab] 用例 ${cases.length} 对，已完成 ${done.size}，待跑 ${todo.length}`);

const toJpeg = async (buf: Uint8Array, w: number, h: number) => { try { return await compressToJpeg(buf, w, h); } catch { return buf; } };

async function runCase(c: LabCase): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const aBuf = await generateImage(c.avPrompt, "768x768");
      const aJpg = await toJpeg(aBuf, 384, 384);
      const aFile = `${c.id}-a.jpg`;
      writeFileSync(join(IMG, aFile), aJpg);
      const uri = `data:image/jpeg;base64,${Buffer.from(aJpg).toString("base64")}`;
      const pBuf = await generateImage(c.ptPrompt, "736x1312", { images: [uri] });
      const pJpg = await toJpeg(pBuf, 736, 1312);
      const pFile = `${c.id}-p.jpg`;
      writeFileSync(join(IMG, pFile), pJpg);
      c.aFile = aFile; c.pFile = pFile; c.status = "ok";
      done.set(c.id, c);
      saveManifest();
      console.log(`[ok] ${c.id} ${c.word}`);
      return;
    } catch (e) {
      c.err = (e as Error).message;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  c.status = "failed";
  saveManifest();
  console.error(`[fail] ${c.id}: ${c.err}`);
}

// 简易池：并发 4，启动间隔 1.5s（≤40/min）
let idx = 0;
async function worker() {
  for (;;) {
    const c = todo[idx++];
    if (!c) return;
    await runCase(c);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
saveManifest();
console.log(`\n[lab] 完成：ok=${done.size}，failed=${cases.filter((c) => c.status === "failed").length}`);
