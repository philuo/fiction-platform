// 存量角色字段补全（迁移脚本）：旧存档角色缺 gender/age/identity（旧 schema 未强制），
// 导致头像 prompt 写「性别未知、年龄未知、身份—」，弱模型只能画「默认脸」。
// 本脚本用 LLM 按故事背景+正文线索补齐三项字段（仅写空字段、不覆盖已有值），完成后请重跑 refresh-visuals 刷新视觉。
// 运行：bun scripts/backfill-characters.ts [书名子串过滤，缺省全部]
import { listStoriesMeta, loadWorld, saveWorld } from "../src/api/storage";
import { fillMissingCharacterFields } from "../src/api/director";

const filter = (process.argv[2] ?? "").trim();
const metas = listStoriesMeta().filter((m) => !filter || m.title.includes(filter) || m.slug.includes(filter));
if (!metas.length) {
  console.log(`没有匹配的故事（filter=${filter || "无"}）`);
  process.exit(0);
}

let total = 0;
for (const m of metas) {
  const w = loadWorld(m.title);
  if (!w) { console.log(`[跳过] ${m.title}：存档读取失败`); continue; }
  const before = w.characters.map((c) => `${c.name}[${c.gender ?? "?"}/${c.age ?? "?"}/${c.identity ?? "?"}]`).join("，");
  try {
    const n = await fillMissingCharacterFields(w);
    if (n > 0) {
      saveWorld(w);
      total += n;
      console.log(`[补全] 《${w.title}》${n} 个角色：${w.characters.map((c) => `${c.name}[${c.gender ?? "?"}/${c.age ?? "?"}/${c.identity ?? "?"}]`).join("，")}`);
    } else {
      console.log(`[无需] 《${w.title}》字段齐全：${before}`);
    }
  } catch (e) {
    console.error(`[失败] 《${w.title}》：${(e as Error).message}`);
  }
}
console.log(`\n完成：共补全 ${total} 个角色（请重跑 bun scripts/refresh-visuals.ts 按新字段刷新头像/立绘）`);
