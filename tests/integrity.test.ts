// 一致性治理单元测试：markOrphanMedia / deleteChapterCascade / auditWorld / autoRepair / resetChapterLedger
// 纯函数为主，不依赖真实 API key：bun test tests/integrity.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditWorld, autoRepair, deleteChapterCascade, collectOrphanMediaFiles } from "../src/api/integrity";
import { markOrphanMedia } from "../src/api/media";
import { resetChapterLedger } from "../src/api/chronicler";
import { saveImage } from "../src/api/images";
import { storyDir } from "../src/api/storage";
import { emptyWorld, type WorldState } from "../src/api/world";

// 隔离 data/：切到临时目录（logChange 等不写盘，但保持与其他测试一致）
let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-integrity-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** 构造带两章正文+账本的测试世界 */
function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "治理测试";
  w.chapters.push({ index: 1, title: "一", text: "沈夜贴着墙根穿行。\n\n暗巷深处传来脚步声。", review: null });
  w.chapters.push({ index: 2, title: "二", text: "刀光骤起。\n\n陆青崖挡在巷口。", review: null });
  w.nextChapter = 3;
  w.chapterSummaries = [
    { index: 1, summary: "第一节", events: [], appeared: ["沈夜"], stateChanges: [] },
    { index: 2, summary: "第二节", events: [], appeared: ["陆青崖"], stateChanges: [] },
  ];
  w.timeline = [
    { chapter: 1, summary: "夜行" },
    { chapter: 2, summary: "遇袭" },
  ];
  w.foreshadowing = [
    { id: "f1", text: "黄帖之谜", plantedAt: 1, status: "planted" },
    { id: "f2", text: "断蛇纹银针", plantedAt: 1, status: "resolved", resolvedAt: 2, note: "第二节回收" },
  ];
  w.characters.push({ id: "c1", name: "沈夜", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 1 });
  return w;
}

describe("media.markOrphanMedia（失配检测可逆）", () => {
  test("正文变更后失配标记，恢复后清除", () => {
    const w = mkWorld();
    const ch = w.chapters[0];
    ch.media = [{ id: "m1", kind: "image", anchor: "沈夜贴着墙根穿行", path: "images/a.png", status: "ready" }];
    expect(markOrphanMedia(ch)).toBe(0); // 原正文匹配
    ch.text = "全新的一段文字。\n\n另一段完全不同的内容。";
    expect(markOrphanMedia(ch)).toBe(1);
    expect(ch.media![0].orphan).toBe(true);
    ch.text = "沈夜贴着墙根穿行。\n\n暗巷深处传来脚步声。"; // 恢复
    expect(markOrphanMedia(ch)).toBe(0);
    expect(ch.media![0].orphan).toBeUndefined();
  });
});

describe("integrity.deleteChapterCascade（删章级联）", () => {
  test("尾章删除：账本清理 + nextChapter 回退 + 伏笔保守策略", () => {
    const w = mkWorld();
    w.chapters[1].media = [{ id: "m2", kind: "image", anchor: "刀光骤起", path: "images/b.png", status: "ready" }];
    w.chapters[1].versionFiles = ["ch2-0-t0.json", "ch2-1-t1.json"];
    const r = deleteChapterCascade(w, 2);
    expect(w.chapters.map((c) => c.index)).toEqual([1]);
    expect(w.nextChapter).toBe(2); // 尾章回退
    expect(w.chapterSummaries?.some((s) => s.index === 2)).toBe(false);
    expect(w.timeline.some((t) => t.chapter === 2)).toBe(false);
    expect(r.mediaPaths).toEqual(["images/b.png"]);
    // 本章版本快照随删盘（versions/<name> 相对路径，交路由删盘）
    expect(r.versionFilePaths).toEqual(["versions/ch2-0-t0.json", "versions/ch2-1-t1.json"]);
    // f2 回收章被删 → 保留记录留痕；f1 埋设章仍在 → 不动
    expect(w.foreshadowing.find((f) => f.id === "f2")?.note).toContain("源章节已删除");
    expect(w.foreshadowing.find((f) => f.id === "f1")?.plantedAt).toBe(1);
  });
  test("中间章删除：允许空洞（nextChapter 不回退），本章埋设的活跃伏笔删除并列明", () => {
    const w = mkWorld();
    w.chapters.push({ index: 3, title: "三", text: "后续剧情。", review: null });
    w.nextChapter = 4;
    const r = deleteChapterCascade(w, 2);
    expect(w.chapters.map((c) => c.index)).toEqual([1, 3]); // 空洞
    expect(w.nextChapter).toBe(4); // 不回退
    // 若第 2 章有埋设伏笔则随删：此处补一条验证
    const w2 = mkWorld();
    w2.chapters.push({ index: 3, title: "三", text: "后续。", review: null });
    w2.nextChapter = 4;
    w2.foreshadowing.push({ id: "f3", text: "第2章埋的雷", plantedAt: 2, status: "planted" });
    const r2 = deleteChapterCascade(w2, 2);
    expect(w2.foreshadowing.some((f) => f.id === "f3")).toBe(false);
    expect(r2.removedForeshadows).toBe(1);
    expect(r2.findings.some((f) => f.kind === "planted-foreshadow-lost" && f.level === "danger")).toBe(true);
    expect(r.mediaPaths.length).toBe(0);
  });
  test("删章弧状态回退：done 弧删最后一章 → 回退 writing + finding", () => {
    const w = mkWorld();
    w.storyArcs = [{ id: "a1", title: "追凶", volumeId: "v1", goal: "追查真凶", estChapters: 2, status: "done", summary: "追凶完成" }];
    w.chapterPlans = [
      { index: 1, arcId: "a1", goal: "起", beats: [], hookType: "悬念", status: "done" },
      { index: 2, arcId: "a1", goal: "承", beats: [], hookType: "转折", status: "done" },
    ];
    const r = deleteChapterCascade(w, 2);
    // 弧状态回退为 writing（摘要可能不准，需复核）
    expect(w.storyArcs![0].status).toBe("writing");
    expect(r.findings.some((f) => f.kind === "arc-status-revert")).toBe(true);
  });
});

describe("integrity.auditWorld / autoRepair（审计与幂等修复）", () => {
  test("孤儿引用被发现并可安全修复，修复幂等", () => {
    const w = mkWorld();
    // 制造孤儿：摘要/时间线/质量债务/章参覆盖指向不存在章节
    w.chapterSummaries?.push({ index: 9, summary: "幽灵章", events: [], appeared: [], stateChanges: [] });
    w.timeline.push({ chapter: 9, summary: "幽灵" });
    w.qualityDebt = [{ id: "qd1", chapterIndex: 9, lens: "prose", issue: "x", severity: "minor", status: "open" }];
    w.chapterGen = { 9: { temperature: 1 } };
    const findings = auditWorld(w);
    expect(findings.some((f) => f.kind === "orphan-summary")).toBe(true);
    expect(findings.some((f) => f.kind === "orphan-timeline")).toBe(true);
    expect(findings.some((f) => f.kind === "orphan-debt")).toBe(true);
    expect(findings.some((f) => f.kind === "dangling-chaptergen")).toBe(true);
    const fixed = autoRepair(w);
    expect(fixed.length).toBeGreaterThan(0);
    expect(w.chapterSummaries?.some((s) => s.index === 9)).toBe(false);
    expect(w.timeline.some((t) => t.chapter === 9)).toBe(false);
    // 幂等：第二次无修复项
    expect(autoRepair(w)).toEqual([]);
  });
  test("planned 章纲指向未来章节不算孤儿；done 孤儿才算", () => {
    const w = mkWorld();
    w.chapterPlans = [
      { index: 5, arcId: "a1", goal: "未来章纲", beats: [], hookType: "无", status: "planned" },
      { index: 9, arcId: "a1", goal: "幽灵核销", beats: [], hookType: "无", status: "done" },
    ];
    const findings = auditWorld(w);
    expect(findings.some((f) => f.kind === "orphan-plan" && f.chapterIndex === 9)).toBe(true);
    expect(findings.some((f) => f.chapterIndex === 5)).toBe(false);
  });
});

describe("chronicler.resetChapterLedger（重结算前置）", () => {
  test("本章埋设伏笔删除、回收回退、时间线/离场清理，且幂等", () => {
    const w = mkWorld();
    w.foreshadowing = [
      { id: "f1", text: "本章埋的", plantedAt: 2, status: "planted" },
      { id: "f2", text: "本章收的", plantedAt: 1, status: "resolved", resolvedAt: 2, note: "回收" },
      { id: "f3", text: "他章伏笔", plantedAt: 1, status: "planted" },
    ];
    w.characters[0].exit = { chapter: 2, reason: "死亡" };
    resetChapterLedger(w, 2);
    expect(w.foreshadowing.some((f) => f.id === "f1")).toBe(false); // 本章埋设 → 删
    const f2 = w.foreshadowing.find((f) => f.id === "f2");
    expect(f2?.status).toBe("planted"); // 本章回收 → 回退
    expect(f2?.resolvedAt).toBeUndefined();
    expect(w.foreshadowing.some((f) => f.id === "f3")).toBe(true); // 他章不动
    expect(w.timeline.some((t) => t.chapter === 2)).toBe(false);
    expect(w.characters[0].exit).toBeUndefined();
    // 幂等
    resetChapterLedger(w, 2);
    expect(w.foreshadowing.length).toBe(2);
  });
});

describe("integrity.collectOrphanMediaFiles（磁盘孤儿扫描）", () => {
  test("返回 state 未引用的磁盘文件，排除已引用与 .DS_Store", () => {
    const w = emptyWorld();
    w.title = "孤儿扫描测试";
    w.chapters.push({ index: 1, title: "一", text: "正文。", review: null });
    w.cover = "images/cover.png";
    w.characters.push({ id: "c1", name: "沈夜", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 1, image: "images/avatar-a.jpg", portrait: { mediaId: "m1", path: "images/portrait-a.jpg", prompt: "p", looks: "l" } });
    w.chapters[0].media = [{ id: "m2", kind: "image", anchor: "正文", path: "images/ill-a.jpg", status: "ready" }];
    w.chapters[0].versionFiles = ["ch1-0-t0.json"];
    // 落盘：被引用的 + 孤儿
    saveImage(w.title, "cover.png", new Uint8Array([1]));
    saveImage(w.title, "avatar-a.jpg", new Uint8Array([2]));
    saveImage(w.title, "portrait-a.jpg", new Uint8Array([3]));
    saveImage(w.title, "ill-a.jpg", new Uint8Array([4]));
    saveImage(w.title, "orphan-1.jpg", new Uint8Array([5]));
    saveImage(w.title, "orphan-2.jpg", new Uint8Array([6]));
    const vdir = join(storyDir(w.title), "versions");
    mkdirSync(vdir, { recursive: true });
    writeFileSync(join(vdir, "ch1-0-t0.json"), "{}"); // 被引用
    writeFileSync(join(vdir, "ch9-0-ghost.json"), "{}"); // 孤儿版本

    const orphans = collectOrphanMediaFiles(w).sort();
    expect(orphans).toEqual(["images/orphan-1.jpg", "images/orphan-2.jpg", "versions/ch9-0-ghost.json"].sort());
  });

  test("目录不存在时返回空数组（不抛错）", () => {
    const w = emptyWorld();
    w.title = "空扫描测试";
    expect(collectOrphanMediaFiles(w)).toEqual([]);
  });
});
