// 引擎端到端测试：newStory → step（写+审）→ 验证伏笔/审查闭环
import { newStory, step } from "../src/api/director";

const idea = "明朝末年，一个小捕快能梦见未来的凶案现场，但梦里总是看不清凶手的脸。";
console.log("=== 1) 立项 newStory ===");
const w = await newStory(idea, "古风悬疑");
console.log("书名:", w.title, "| 题材:", w.genre);
console.log("设定:", w.setting.time, "/", w.setting.place, "| 规则:", w.setting.rules.join(";"));
console.log("人物:", w.characters.map((c) => `${c.name}(${c.role})`).join(", "));

console.log("\n=== 2) 回合 step（写 + 对抗审查） ===");
const result = await step(w, "", (e) => {
  if (e.phase === "writing") console.log(`  [阶段] 导演写作 round ${e.round} …`);
  if (e.phase === "reviewing") console.log(`  [阶段] 审查者对抗审查 round ${e.round} …`);
  if (e.phase === "saving") console.log("  [阶段] 存档");
});
console.log("章节:", result.chapter.index, result.chapter.title, `(${result.chapter.text.length}字)`);
console.log("正文开头:", result.chapter.text.slice(0, 80).replace(/\n/g, " "));
console.log("审查结论:", result.review.verdict, "| 评分:", JSON.stringify(result.review.scores));
for (const f of result.review.findings) {
  console.log(`  [${f.severity}/${f.lens}] ${f.issue.slice(0, 60)}（证据: ${f.evidence.slice(0, 40)}）`);
}
console.log("写作轮数:", result.rounds);

console.log("\n=== 3) 伏笔账本 ===");
for (const f of w.foreshadowing) {
  console.log(`  [${f.id}] ${f.status} 埋于第${f.plantedAt}章: ${f.text.slice(0, 60)}`);
}
console.log("时间线:", w.timeline.map((t) => `第${t.chapter}章 ${t.summary.slice(0, 40)}`).join(" | "));
console.log("章节数:", w.chapters.length, "| 下一章:", w.nextChapter);
console.log("\n测试完成 ✅");
