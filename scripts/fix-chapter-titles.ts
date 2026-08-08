// 一次性数据修复：章节标题曾被 plan.goal 截断成"半句长句"的存量章节。
// 判定：正文首行为模型自创标题行【XX】且当前标题不健全（长句/第N章）→
//   1. 提取【XX】为本章标题并从正文剥离该行；
//   2. 留版本快照（修复前状态可回滚）；
//   3. 同步重写 versions/ 基线快照（连载入册快照同为 bug 产物，避免回滚带回错标题）。
// 用法：bun scripts/fix-chapter-titles.ts [--dry]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorld, saveWorld, storyDir, slugify } from "../src/api/storage";
import { logChange } from "../src/api/steering";
import { isTitleLike } from "../src/api/writer";
import type { Chapter, WorldState } from "../src/api/world";
import { readdirSync, existsSync } from "node:fs";

const DRY = process.argv.includes("--dry");

function scanAllStories(): string[] {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of readdirSync(dir)) {
    if (existsSync(join(dir, d, "state.json"))) out.push(d);
  }
  return out;
}

/** 修复单个章节；返回是否变更 */
function fixChapter(w: WorldState, ch: Chapter): boolean {
  const first = ch.text.split("\n")[0]?.trim() ?? "";
  const m = first.match(/^【([^【】]+)】$/);
  // 条件收紧：正文首行是标题行 且 当前标题确实不健全（避免误伤正文真以【XX】起头的极端情况）
  if (!m || isTitleLike(ch.title)) return false;
  const realTitle = m[1].trim().slice(0, 60);
  console.log(`  第${ch.index}章：[${ch.title}] → [${realTitle}]`);
  if (DRY) return true;

  // 版本快照：保留修复前状态（与 director.snapshotVersion 同语义：内容一致不重复入快照）
  const versions = ch.versions ?? [];
  if (!versions.some((v) => v.title === ch.title && v.text === ch.text)) {
    versions.push({ title: ch.title, text: ch.text, review: ch.review, at: new Date().toISOString(), reason: "标题修复前快照" });
    ch.versions = versions.slice(-10);
  }
  ch.title = realTitle;
  ch.text = ch.text.split("\n").slice(1).join("\n").trim();
  ch.updatedAt = new Date().toISOString();
  return true;
}

/** 重写 versions/ 基线快照：title 同步 + text 剥离标题行（幂等：已正确的文件跳过） */
function fixVersionFiles(w: WorldState): void {
  if (DRY) return;
  const dir = join(storyDir(w.title), "versions");
  if (!existsSync(dir)) return;
  const files = new Set((w.chapters).flatMap((c) => c.versionFiles ?? []));
  for (const f of readdirSync(dir)) {
    if (!files.has(f)) continue;
    const p = join(dir, f);
    let v: { title?: string; text?: string };
    try {
      v = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const first = (v.text ?? "").split("\n")[0]?.trim() ?? "";
    const m = first.match(/^【([^【】]+)】$/);
    if (!m || isTitleLike(v.title ?? "")) continue;
    v.title = m[1].trim().slice(0, 60);
    v.text = (v.text ?? "").split("\n").slice(1).join("\n").trim();
    writeFileSync(p, JSON.stringify(v), "utf-8");
    console.log(`    基线快照已同步：${f} → [${v.title}]`);
  }
}

for (const slug of scanAllStories()) {
  const w = loadWorld(slug);
  if (!w) continue;
  const fixedIdx: number[] = [];
  console.log(`《${w.title}》（${slug}）`);
  for (const ch of w.chapters) {
    if (fixChapter(w, ch)) fixedIdx.push(ch.index);
  }
  if (!fixedIdx.length) {
    console.log("  无需修复");
    continue;
  }
  if (DRY) {
    console.log(`  [dry-run] 将修复 ${fixedIdx.length} 章（${fixedIdx.join("、")}）`);
    continue;
  }
  fixVersionFiles(w);
  logChange(w, {
    chapter: fixedIdx[fixedIdx.length - 1],
    actor: "system",
    kind: "chapter-title-repair",
    detail: `修复 ${fixedIdx.length} 个章节标题（第 ${fixedIdx.join("、")} 章）：plan.goal 截断长句 → 提取正文首行【XX】真实标题（一次性脚本）`,
    commandId: "CMD-N06",
    level: "L2",
  });
  saveWorld(w);
  console.log(`  已修复 ${fixedIdx.length} 章并落盘（data/${slugify(w.title)}/）`);
}
