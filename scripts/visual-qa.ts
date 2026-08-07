// 视觉自检（生成 → 人工/模型审查）：构造测试书《视觉自检》，覆盖 性别×年龄 六档矩阵，
// 逐角色生成头像+立绘并打印文件路径与容貌标识，供逐张与需求比对：
// 性别相符 / 肤色不出现深肤色 / 角色互斥 / 纯色背景 / 正面 / 禁帽子 / 立绘与头像同一人。
// 运行：bun scripts/visual-qa.ts
import { emptyWorld, type Character } from "../src/api/world";
import { saveWorld } from "../src/api/storage";
import { generateCharacterAvatar, generateCharacterPortrait, distinctiveLook, genderPhrase } from "../src/api/media";

const w = emptyWorld();
w.title = "视觉自检";
w.genre = "古风悬疑";
w.premise = "明代京城，一桩漕运命案牵出官场暗流。";
w.setting = { time: "明朝", place: "京城", rules: [], tone: "冷峻" };

const mk = (id: string, name: string, gender: string, age: string, identity: string, role: string, traits: string[]): Character =>
  ({ id, name, gender, age, identity, role, traits, motivation: "自检", status: "登场", relations: {}, introducedAt: 0 });

w.characters = [
  mk("c1", "顾昭", "男", "二十出头", "国子监学生", "主角", ["沉稳", "敏锐"]),
  mk("c2", "谢婉", "女", "十八岁", "绣坊绣娘", "关键人物", ["温婉", "心细"]),
  mk("c3", "老周", "男", "五十余岁", "漕帮老船工", "配角", ["寡言", "老练"]),
  mk("c4", "秦夫人", "女", "四十许人", "官媒", "配角", ["圆滑", "势利"]),
  mk("c5", "阿衡", "男", "十五岁", "书童", "配角", ["机灵", "胆小"]),
  mk("c6", "阿阮", "女", "十六岁", "丫鬟", "配角", ["怯生生", "忠心"]),
];
saveWorld(w);

for (const c of w.characters) {
  try {
    const av = await generateCharacterAvatar(w.title, w, c);
    c.image = av.path;
    const pt = await generateCharacterPortrait(w.title, w, c);
    c.portrait = { mediaId: pt.mediaId, path: pt.path, prompt: pt.prompt, looks: pt.looks || undefined };
    saveWorld(w);
    console.log(`[OK] ${c.name}（${genderPhrase(c)}）${distinctiveLook(c).replace("容貌必须严格照此刻画：", "")}\n  头像 data/${w.title}/${av.path}\n  立绘 data/${w.title}/${pt.path}`);
  } catch (e) {
    console.error(`[FAIL] ${c.name}: ${(e as Error).message}`);
  }
}
console.log("\n自检素材就绪，请逐张审查。");
