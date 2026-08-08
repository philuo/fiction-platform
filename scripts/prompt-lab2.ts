// 头饰/身份分级/主身份/比例 完备测试场（第二轮）：验证 headwearOf 差异化头饰、官服分级、主身份优先、
// 立绘 2:3 比例（修垂直拉伸）、男性三式发型/女性多样发髻的区分度与稳定性。
// 产物落 lab2/（不污染书单）；manifest 断点续跑。运行：bun scripts/prompt-lab2.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { emptyWorld, type Character, type WorldState } from "../src/api/world";
import { generateImage, compressToJpeg, readImage } from "../src/api/images";
import { i2iPreservePrefix, ensureStyleSuffix, styleAnchor, headwearOf, nameSeed } from "../src/api/media";
import { generateCharacterAvatar, generateCharacterPortrait } from "../src/api/media";

const LAB = join(process.cwd(), "lab2");
const IMG = join(LAB, "images");
mkdirSync(IMG, { recursive: true });
const MANIFEST = join(LAB, "manifest.json");

type LabCase = { id: string; cat: string; word: string; aFile?: string; pFile?: string; pFileAlt?: string; status?: "ok" | "failed"; err?: string; repeatGroup?: string };
const cases: LabCase[] = [];

const MING = (): WorldState => {
  const w = emptyWorld();
  w.title = "头饰实验";
  w.genre = "古风悬疑";
  w.setting = { time: "明朝", place: "京城", rules: [], tone: "冷峻" };
  return w;
};
let seq = 0;
const mk = (name: string, gender: string, age: string, identity: string): Character =>
  ({ id: `c${++seq}`, name, role: "配角", gender, age, identity, traits: ["沉稳"], motivation: "实验", status: "登场", relations: {}, introducedAt: 0 });

// W1 头饰身份矩阵 16
const W1: [string, string, string, string][] = [
  ["高大人", "男", "四十多岁", "礼部侍郎"], ["低大人", "男", "三十许人", "知县"],
  ["将军甲", "男", "四十许人", "将军"], ["校尉甲", "男", "三十许人", "校尉"],
  ["书生甲", "男", "二十出头", "书生"], ["诗人束", "男", "三十许人", "诗人"],
  ["和尚甲", "男", "五十余岁", "和尚"], ["道士甲", "男", "四十许人", "道士"],
  ["乞丐甲", "男", "五十余岁", "乞丐"], ["皇帝甲", "男", "四十许人", "皇帝"],
  ["贵妃甲", "女", "二十多岁", "贵妃"], ["丫鬟甲", "女", "十五岁", "丫鬟"],
  ["少女甲", "女", "十六岁", "绣娘"], ["少妇甲", "女", "二十出头", "绣娘"],
  ["夫人甲", "女", "四十许人", "官媒"], ["画家甲", "男", "三十许人", "画家"],
];
W1.forEach(([n, g, a, id], i) => cases.push({ id: `W1-${String(i).padStart(2, "0")}`, cat: "W1", word: `${id}/${g}/${a}` }));

// W2 男性默认发型三式分化 6（同名册避让+hash 三式）
["陆一", "陆二", "陆三", "陆四", "陆五", "陆六"].forEach((n, i) => cases.push({ id: `W2-${i}`, cat: "W2", word: n }));
// W3 女性发髻多样 6
["苏一", "苏二", "苏三", "苏四", "苏五", "苏六"].forEach((n, i) => cases.push({ id: `W3-${i}`, cat: "W3", word: n }));
// W4 主身份优先 4
const W4: [string, string][] = [["诗官甲", "礼部侍郎，擅长写诗"], ["诗将甲", "致仕将军，爱好吟诗"], ["书诗甲", "秀才，擅长写诗"], ["诗人民", "诗人"]];
W4.forEach(([n, id], i) => cases.push({ id: `W4-${i}`, cat: "W4", word: id }));
// W5 比例对照 6（同 prompt 9:16 vs 2:3）
["比例甲", "比例乙", "比例丙", "比例丁", "比例戊", "比例己"].forEach((n, i) => cases.push({ id: `W5-${i}`, cat: "W5", word: n }));
// W6 稳定性 4×3
for (let g = 0; g < 4; g++) for (let r = 0; r < 3; r++) cases.push({ id: `W6-${g}-${r}`, cat: "W6", word: `组${g}`, repeatGroup: `W6-${g}` });

// —— 断点续跑 ——
const done = new Map<string, LabCase>();
if (existsSync(MANIFEST)) for (const c of JSON.parse(readFileSync(MANIFEST, "utf-8")) as LabCase[]) if (c.status === "ok") done.set(c.id, c);
const todo = cases.filter((c) => !done.has(c.id));
const saveManifest = () => writeFileSync(MANIFEST, JSON.stringify([...done.values(), ...cases.filter((c) => c.status === "failed")], null, 1));
console.log(`[lab2] 用例 ${cases.length}，已完成 ${done.size}，待跑 ${todo.length}`);

const toJpeg = async (buf: Uint8Array, w: number, h: number) => { try { return await compressToJpeg(buf, w, h); } catch { return buf; } };
const wr = (name: string, data: Uint8Array) => { writeFileSync(join(IMG, name), data); return name; };

// 诗人散发名探测（nameSeed%2=1 → 披肩）
const poetLoose = ["诗人束", "李白", "王维", "孟浩然", "苏轼", "杜牧"].find((n) => nameSeed(n) % 2 === 1) ?? "李白";

async function runCase(c: LabCase): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const w = MING();
      if (c.cat === "W1") {
        const [n, g, a, id] = W1[Number(c.id.slice(3))];
        const ch = mk(n, g, a, id);
        w.characters = [ch];
        const av = await generateCharacterAvatar(w.title, w, ch);
        ch.image = av.path; // 内存引用即可（i2i 读盘需要落盘——generateCharacterAvatar 已落盘到 data/头饰实验）
        const pt = await generateCharacterPortrait(w.title, w, ch);
        c.aFile = av.path; c.pFile = pt.path;
      } else if (c.cat === "W2") {
        const roster = W2names.map((n) => mk(n, "男", "三十许人", "镖师"));
        w.characters = roster;
        const ch = roster[Number(c.id.slice(3))];
        const av = await generateCharacterAvatar(w.title, w, ch);
        c.aFile = av.path;
      } else if (c.cat === "W3") {
        const roster = W3names.map((n) => mk(n, "女", "二十出头", "绣娘"));
        w.characters = roster;
        const ch = roster[Number(c.id.slice(3))];
        const av = await generateCharacterAvatar(w.title, w, ch);
        c.aFile = av.path;
      } else if (c.cat === "W4") {
        const [n, id] = W4[Number(c.id.slice(3))];
        const ch = mk(n, "男", "三十许人", id);
        w.characters = [ch];
        const av = await generateCharacterAvatar(w.title, w, ch);
        ch.image = av.path;
        const pt = await generateCharacterPortrait(w.title, w, ch);
        c.aFile = av.path; c.pFile = pt.path;
      } else if (c.cat === "W5") {
        const ch = mk(c.word, "男", "三十许人", "书生");
        w.characters = [ch];
        const av = await generateCharacterAvatar(w.title, w, ch);
        ch.image = av.path;
        const pt = await generateCharacterPortrait(w.title, w, ch); // 2:3
        // 9:16 对照：同 i2i prompt 旧尺寸
        const ref = readAsUri(w.title, av.path);
        const base = `《头饰实验》角色「${ch.name}」的全身立绘：与参考头像完全同一人，容貌、发型、服饰全部保持参考图原样不变；仅将头像特写改为竖版单人全身像：正面站立面向观者，全身完整入画；${headwearOf(ch, w)}；背景为干净的纯色背景`;
        const i2i = i2iPreservePrefix("portrait", ch.name) + ensureStyleSuffix(base, styleAnchor(w));
        const buf16 = await generateImage(i2i, "736x1312", { images: [ref!] });
        c.pFileAlt = wr(`${c.id}-p16.jpg`, await toJpeg(buf16, 736, 1312));
        c.aFile = av.path; c.pFile = pt.path;
      } else { // W6
        const cfg = [["稳甲", "男", "三十许人", "捕快"], ["稳乙", "女", "二十出头", "仵作"], ["稳丙", "男", "四十许人", "账房"], ["稳丁", "女", "四十许人", "官媒"]][Number(c.id.slice(3, 4))];
        const ch = mk(cfg[0], cfg[1], cfg[2], cfg[3]);
        w.characters = [ch];
        const av = await generateCharacterAvatar(w.title, w, ch);
        c.aFile = av.path;
      }
      c.status = "ok";
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

const W2names = ["陆一", "陆二", "陆三", "陆四", "陆五", "陆六"];
const W3names = ["苏一", "苏二", "苏三", "苏四", "苏五", "苏六"];
function readAsUri(title: string, rel: string): string | undefined {
  const buf = readImage(title, rel);
  return buf ? `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}` : undefined;
}

let idx = 0;
async function worker() {
  for (;;) {
    const c = todo[idx++];
    if (!c) return;
    await runCase(c);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
void poetLoose;
await Promise.all([worker(), worker(), worker(), worker()]);
saveManifest();
console.log(`\n[lab2] 完成：ok=${done.size}，failed=${cases.filter((c) => c.status === "failed").length}`);
