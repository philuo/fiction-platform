// scripts/baseline.ts — 质量验收基线生成器（docs/QUALITY-BASELINE.md §2/§5 P-1）
//
// 零干预跑完一部作品并采集六类快照产物（input/state/eval/reviews/book.md/cost）：
//   newStory → director.step 循环（手动连载语义：审查未过仍 commit + 记质量债——引擎"自动产出"的真实面貌）
//   → 完结（isBookComplete）或达目标章数或连续 3 章失败熔断 → 快照落盘 data/baseline/<slot>/
// 注：不用 runAuto+requirePass 路径——实测该模式下默认严格度（地板 6）反复拒 commit，
// 基线衡量的是引擎自然产出，而非审查门禁能力（门禁能力由 bun test 与 P 阶段专项验收）。
//
// 用法：
//   bun scripts/baseline.ts --dry-run --idea "..." --genre "古风悬疑" --max 30   # 只打印配置，不调 API
//   bun scripts/baseline.ts --idea "..." --genre "古风悬疑" --max 30 [--slot B-SHORT]
//   bun scripts/baseline.ts --title 既有书名 --max 60 [--slot B-LONG]             # 续跑（长篇分次串行）

import { newStory, step as directorStep, type StepResult } from "../src/api/director";
import { isBookComplete } from "../src/api/planner";
import { evaluateBookCached } from "../src/api/eval";
import {
  exportMarkdown,
  loadWorld,
  saveWorld,
  storyDir,
} from "../src/api/storage";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorldState } from "../src/api/world";

// ---------- 参数解析 ----------
type Args = {
  idea?: string;
  genre?: string;
  max: number;
  slot: string;
  title?: string; // 续跑既有作品（长篇分次）
  dryRun: boolean;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    idea: get("--idea"),
    genre: get("--genre"),
    max: Math.max(1, Math.min(Number(get("--max")) || 30, 120)),
    slot: get("--slot") || "B-SHORT",
    title: get("--title"),
    dryRun: a.includes("--dry-run"),
  };
}

// ---------- 成本/轮数追踪 ----------
type CostTracker = {
  startedAt: string;
  finishedAt?: string;
  stopReason: "complete" | "target" | "error-streak";
  steps: { chapter: number; rounds: number; verdict: string | null; at: string }[];
  errorStreakMax: number;
  rounds: number[]; // 每章写作轮数（1 = 一次通过）
};

function snapshotDir(slot: string): string {
  return join("data", "baseline", slot);
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.idea && !args.title) {
    console.error("用法：bun scripts/baseline.ts --idea \"灵感\" --genre \"题材\" --max 30 [--slot B-SHORT] [--dry-run]");
    console.error("续跑：bun scripts/baseline.ts --title 书名 --max 60 [--slot B-LONG]");
    process.exit(1);
  }

  console.log(`[baseline] 配置：slot=${args.slot} max=${args.max}${args.title ? ` title=${args.title}（续跑）` : ` idea="${args.idea}" genre="${args.genre}"`}${args.dryRun ? " [DRY-RUN 不调 API]" : ""}`);
  if (args.dryRun) return;

  const dir = snapshotDir(args.slot);
  mkdirSync(dir, { recursive: true });

  // ① 立项（或续跑）
  let title: string;
  let w0: WorldState | null;
  if (args.title) {
    title = args.title;
    w0 = loadWorld(title);
    if (!w0) throw new Error(`续跑失败：找不到作品「${title}」`);
    console.log(`[baseline] 续跑「${title}」，已有 ${w0.chapters.length} 章，nextChapter=${w0.nextChapter}`);
  } else {
    console.log("[baseline] 立项 newStory …");
    const created = await newStory(args.idea!, args.genre);
    title = created.title;
    w0 = loadWorld(title);
    console.log(`[baseline] 立项完成：《${title}》（${created.genre}），人物 ${created.characters.map((c) => c.name).join("、")}`);
  }

  // ② 输入快照（idea + genProfile 全量，QUALITY-BASELINE §2.3）
  writeJson(join(dir, "input.json"), {
    slot: args.slot,
    idea: args.idea ?? null,
    genre: args.genre ?? null,
    title,
    resumedFromTitle: args.title ?? null,
    at: new Date().toISOString(),
    targetTotal: args.max,
    path: "director.step（手动连载语义：审查未过仍 commit + 记质量债，对齐前端推进按钮）",
    autoGacha: false, // 基线期强制关（§2.2 可复现性）
    intervention: "none", // 全程零干预（§2.2）
    genProfile: w0?.gen ?? null,
    chapterGenOverrides: Object.keys(w0?.chapterGen ?? {}).length,
  });

  // ③ 零干预连载（手动 step 语义：审查未过仍 commit + 记质量债——引擎"自动产出"的真实面貌，基线衡量对象）
  const cost: CostTracker = {
    startedAt: new Date().toISOString(),
    stopReason: "target",
    steps: [],
    errorStreakMax: 0,
    rounds: [],
  };

  let errStreak = 0;
  while (true) {
    const w = loadWorld(title);
    if (!w) throw new Error("世界读取失败: " + title);
    if (w.gen) { w.gen.autoGacha = false; saveWorld(w); } // 强制关抽卡（双保险）
    const done = w.chapters.length;
    if (done >= args.max) { cost.stopReason = "target"; break; }
    if (isBookComplete(w)) { cost.stopReason = "complete"; break; }
    console.log(`[baseline] 写第 ${w.nextChapter} 章（已有 ${done}/${args.max}）…`);
    try {
      const result: StepResult = await directorStep(w, "", (e) => {
        if (e.phase === "reviewing") console.log(`  [审查] round ${e.round} …`);
        if (e.phase === "patching") console.log(`  [修补] ${e.paragraphs} 段`);
      });
      errStreak = 0;
      cost.rounds.push(result.rounds);
      cost.steps.push({ chapter: result.chapter.index, rounds: result.rounds, verdict: result.review?.verdict ?? null, at: new Date().toISOString() });
      console.log(`  ✓ 第 ${result.chapter.index} 章《${result.chapter.title}》 ${result.chapter.text.length} 字，verdict=${result.review?.verdict}，轮数=${result.rounds}`);
    } catch (e) {
      errStreak += 1;
      cost.errorStreakMax = Math.max(cost.errorStreakMax, errStreak);
      console.error(`  ✗ 写章失败（连续 ${errStreak} 次）：`, e instanceof Error ? e.message.slice(0, 120) : e);
      if (errStreak >= 3) { cost.stopReason = "error-streak"; break; } // 熔断：连续 3 章失败即停，防烧配额
    }
  }

  // ④ 六类快照产物（QUALITY-BASELINE §2.3）
  const wf = loadWorld(title);
  if (!wf) throw new Error("终态世界读取失败");

  // 4a. eval.json（force=true 全量重评，§2.3）
  console.log("[baseline] 整书评估 evaluateBookCached(force) …");
  const { report: evalReport } = await evaluateBookCached(wf, undefined, true);
  writeJson(join(dir, "eval.json"), evalReport);
  console.log(`[baseline] eval overall=${evalReport.overall} | ${evalReport.dimensions.map((d) => `${d.name}:${d.score}`).join(" ")}`);

  // 4b. reviews.json（每章 verdict + 5 维分 + findings 数，§3.2）
  writeJson(
    join(dir, "reviews.json"),
    wf.chapters.map((c) => ({
      index: c.index,
      title: c.title,
      verdict: c.review?.verdict ?? null,
      scores: c.review?.scores ?? null,
      findingsCount: c.review?.findings?.length ?? 0,
      words: c.text.length,
    })),
  );

  // 4c. book.md（全文导出，供人工抽读 §4.4）
  writeFileSync(join(dir, "book.md"), exportMarkdown(wf), "utf-8");

  // 4d. state.json（终态完整世界状态）
  copyFileSync(join(storyDir(title), "state.json"), join(dir, "state.json"));

  // 4e. cost.json（成本与轮数，§3.4）
  cost.finishedAt = new Date().toISOString();
  writeJson(join(dir, "cost.json"), {
    ...cost,
    chapters: wf.chapters.length,
    avgRounds: cost.rounds.length ? cost.rounds.reduce((n, r) => n + r, 0) / cost.rounds.length : null,
    rewriteRate: cost.rounds.length ? cost.rounds.filter((r) => r > 1).length / cost.rounds.length : null,
    note: "LLM 调用次数近似=Σ轮数+审查+记账；精确计数待 limiter 暴露全局计数器（后续演进）",
  });

  console.log(`[baseline] ✅ ${args.slot} 完成：${wf.chapters.length} 章，overall=${evalReport.overall}，快照落盘 ${dir}/`);
  console.log(`[baseline] 产物：input.json state.json eval.json reviews.json book.md cost.json`);
}

main().catch((e) => {
  console.error("[baseline] ❌ 失败：", e instanceof Error ? e.message : e);
  process.exit(1);
});
