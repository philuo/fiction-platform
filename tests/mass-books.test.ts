// P1 全流程长跑测试：从 newStory 立项开始，mock LLM 跑 10 本 × 10-30 章自动连载。
// 断言：立项产物（角色含性别/蓝图/世界书）→ 章节数达标 → 账本一致性（摘要/时间线/伏笔/角色状态/章纲核销）
// → checkpoint 落盘 → loadWorld 重载数据完整 → 伏笔状态机合法。
// 耗时：mock 全同步，秒级；单测超时 120s 兜底。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOOK_SPECS, installFullMock } from "./mass-common";
import { closeDb } from "../src/api/db";

let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-mass-"));
  process.chdir(tmp);
});
afterAll(() => {
  closeDb();
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("P1 全流程长跑：10 本 × 10-30 章", () => {
  for (const spec of BOOK_SPECS) {
    test(`《${spec.title}》${spec.targetChapters} 章（${spec.strictness}·${spec.charCount} 角色）`, async () => {
      installFullMock(spec);

      const { newStory } = await import("../src/api/director");
      const { runAuto } = await import("../src/api/autorun");
      const { writeOneChapter } = await import("../src/api/director");
      const { loadWorld } = await import("../src/api/storage");

      // ① 从初始化开始：一句话立项（自动导演：蓝图确认 + 首弧展开）
      const w = await newStory(`${spec.genre}题材：${spec.title}的主角${spec.idx}追查一场阴谋。`, spec.genre);
      expect(w.title).toBe(spec.title);
      expect(w.characters.length).toBe(spec.charCount);
      // 性别必须全部明确为男/女（无未知/AI 推断）
      for (const c of w.characters) {
        expect(["男", "女"]).toContain(c.gender);
        expect(c.name.length).toBeGreaterThan(0);
      }
      // 立项自动导演产物：蓝图 + 卷 + 弧 + 已展开章纲
      expect(w.blueprint).toBeDefined();
      expect((w.blueprint?.volumes ?? []).length).toBeGreaterThanOrEqual(2);
      expect((w.storyArcs ?? []).length).toBeGreaterThanOrEqual(2);
      expect((w.chapterPlans ?? []).length).toBeGreaterThan(0);
      // 生成参数：未显式设置时为空（genOf 兜底 DEFAULT_GEN）
      expect(w.gen ?? null).toBeNull();

      // ② 自动连载跑满目标章数
      const report = await runAuto(
        spec.title,
        { maxChapters: spec.targetChapters, runEvalEvery: 0 },
        (_w, onEvent) => writeOneChapter(loadWorld(spec.title)!, "", (e) => onEvent(e), null),
        () => loadWorld(spec.title),
        () => {},
      );
      expect(report.reason).toBe("done");
      expect(report.written).toBe(spec.targetChapters);

      // ③ 章节与核心账本
      const after = loadWorld(spec.title)!;
      expect(after.chapters.length).toBe(spec.targetChapters);
      expect(after.nextChapter).toBe(spec.targetChapters + 1);
      const badCh = after.chapters.filter((c) => !c.title || !c.text || c.text.length < spec.minWords);
      expect(badCh).toEqual([]); // 每章都有标题与达标正文
      // 章摘要 / 时间线逐章入账
      expect((after.chapterSummaries ?? []).length).toBe(spec.targetChapters);
      expect(after.timeline.length).toBe(spec.targetChapters);
      // 伏笔状态机合法：状态枚举合法、埋设章 ≤ 当前章；每章 1 条全部入账（≤ maxForeshadowPerChapter）
      expect(after.foreshadowing.length).toBe(spec.targetChapters);
      for (const f of after.foreshadowing) {
        expect(["planted", "active", "resolved"]).toContain(f.status);
        expect(f.plantedAt).toBeGreaterThan(0);
        if (f.status === "resolved") expect(f.resolvedAt).toBeGreaterThan(0);
      }
      // 角色状态被记账更新
      const hero = after.characters.find((c) => c.role === "主角");
      expect(hero?.status).toContain("调查中");
      // 章纲核销：至少 1 个 done
      const donePlans = (after.chapterPlans ?? []).filter((p) => p.status === "done");
      expect(donePlans.length).toBeGreaterThan(0);
      // 弧/卷边界真实触发：≥1 弧 done；第 1 卷（2 弧 × 3 章 = 6 章内完成）done + 卷摘要 + 指南针已更新
      expect((after.storyArcs ?? []).filter((a) => a.status === "done").length).toBeGreaterThanOrEqual(1);
      const vol0 = after.blueprint?.volumes?.[0];
      expect(vol0?.status).toBe("done");
      expect(vol0?.summary?.length).toBeGreaterThan(0);
      expect(after.blueprint?.compass).toContain("真相");
      // 每章结算变更快照落盘（删章回滚用）
      expect(Object.keys(after.chapterDeltas ?? {}).length).toBe(spec.targetChapters);
      // 质量债为空（mock findings 全 pass）
      expect((after.qualityDebt ?? []).length).toBe(0);

      // ④ checkpoint 落盘
      const ckPath = join(tmp, "data", spec.title, "checkpoint.jsonl");
      expect(existsSync(ckPath)).toBe(true);
      const ckLines = readFileSync(ckPath, "utf-8").split("\n").filter(Boolean);
      expect(ckLines.length).toBeGreaterThanOrEqual(spec.targetChapters);

      // ⑤ 重新加载数据完整（模拟重启）
      const reloaded = loadWorld(spec.title)!;
      expect(reloaded.chapters.length).toBe(spec.targetChapters);
      expect(reloaded.chapters.map((c) => c.index)).toEqual(Array.from({ length: spec.targetChapters }, (_, i) => i + 1));
      expect(reloaded.characters.length).toBe(spec.charCount);
      expect(reloaded.title).toBe(spec.title);
    }, 120_000);
  }
});
