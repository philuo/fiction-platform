// 存量角色视觉刷新（区分度修复迁移）：旧头像/立绘由旧 prompt 生成（无确定性容貌标识，弱模型画「默认脸」撞脸），
// 本脚本按新策略（distinctiveLook 容貌标识 + 立绘朝向定死正面）重新生成：头像 → 立绘（i2i 参考新头像），
// 每完成一项立即落盘（中断可重跑，已刷新角色不受影响），替换下来的旧图文件删除防磁盘孤儿。
// 运行：bun scripts/refresh-visuals.ts [书名子串过滤，缺省全部]
// 说明：会消耗真实生图配额（每角色 = 头像 1 张 + 立绘 1 张），串行执行不压限流。
import { listStoriesMeta, loadWorld, saveWorld } from "../src/api/storage";
import { generateCharacterAvatar, generateCharacterPortrait } from "../src/api/media";
import { deleteMediaFile } from "../src/api/images";

const filter = (process.argv[2] ?? "").trim();
const metas = listStoriesMeta().filter((m) => !filter || m.title.includes(filter) || m.slug.includes(filter));
if (!metas.length) {
  console.log(`没有匹配的故事（filter=${filter || "无"}）`);
  process.exit(0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;

for (const m of metas) {
  const w = loadWorld(m.title);
  if (!w) { console.log(`[跳过] ${m.title}：存档读取失败`); continue; }
  console.log(`\n=== 《${w.title}》${w.characters.length} 个角色 ===`);
  for (const c of w.characters) {
    const oldAvatar = c.image;
    const oldPortrait = c.portrait?.path;
    // 1) 头像：新 prompt（含确定性容貌标识，同名复现一致）
    try {
      const av = await generateCharacterAvatar(w.title, w, c);
      c.image = av.path;
      c.visualTriedAt = Date.now();
      if (oldAvatar && oldAvatar !== av.path) deleteMediaFile(w.title, oldAvatar);
      console.log(`  [头像✓] ${c.name} → ${av.path}`);
    } catch (e) {
      fail++;
      console.error(`  [头像✗] ${c.name}: ${(e as Error).message}（立绘跳过）`);
      saveWorld(w);
      continue;
    }
    // 2) 立绘：以新头像为容貌基准 i2i；仅当旧 looks 是用户改词过的描述（≠自动推导的 traits）才传入 description，
    // 否则走短改变 prompt（弱模型保持参考图的关键；旧 looks 存的是性格词，当描述传会重蹈覆辙）
    try {
      const autoLooks = c.traits.slice(0, 4).join("、");
      const userLooks = c.portrait?.looks && c.portrait.looks !== autoLooks ? c.portrait.looks : undefined;
      const pt = await generateCharacterPortrait(w.title, w, c, userLooks ? { description: userLooks } : {});
      c.portrait = { mediaId: pt.mediaId, path: pt.path, prompt: pt.prompt, looks: pt.looks || undefined };
      if (oldPortrait && oldPortrait !== pt.path) deleteMediaFile(w.title, oldPortrait);
      console.log(`  [立绘✓] ${c.name} → ${pt.path}`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  [立绘✗] ${c.name}: ${(e as Error).message}（头像已更新）`);
    }
    saveWorld(w); // 每角色落盘一次：中断可重跑
    await sleep(500); // 串行温和节流
  }
}

console.log(`\n完成：立绘成功 ${ok} 个，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
