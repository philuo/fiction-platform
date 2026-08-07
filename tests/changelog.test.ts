// changeLog 覆盖单测：写操作后审计日志非空且 kind/actor 正确（弹窗一"操作日志"的数据基础）
// 纯函数路径（deleteChapter/gachaApply/logChange），不依赖真实 API key：bun test tests/changelog.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteChapter, gachaApply } from "../src/api/director";
import { logChange, logCommandChange } from "../src/api/steering";
import { emptyWorld, type Card, type WorldState } from "../src/api/world";

// 隔离 data/：切到临时目录（saveWorld 落盘到临时区，不污染真实存档）
let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-changelog-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "审计测试";
  w.chapters.push({ index: 1, title: "一", text: "沈夜贴着墙根穿行。", review: null });
  w.chapters.push({ index: 2, title: "二", text: "刀光骤起。", review: null });
  w.nextChapter = 3;
  return w;
}

describe("changeLog 覆盖", () => {
  test("删章落 chapter-delete 日志（actor=user，含章节与级联摘要）", () => {
    const w = mkWorld();
    deleteChapter(w, 2);
    const entry = (w.changeLog ?? []).find((e) => e.kind === "chapter-delete");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("user");
    expect(entry!.chapter).toBe(2);
    expect(entry!.detail).toContain("删除第 2 章");
  });

  test("抽卡应用落 gacha-apply 日志（actor=user，含卡牌名）", () => {
    const w = mkWorld();
    const card: Card = { id: "c1", type: "章节", rarity: "R", title: "雨夜追踪", description: "推进追踪戏", effect: "下一节推进追踪" };
    w.pendingCards = [card];
    const out = gachaApply(w, { pick: ["c1"] });
    expect(out.applied.length).toBe(1);
    const entry = (w.changeLog ?? []).find((e) => e.kind === "gacha-apply");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("user");
    expect(entry!.detail).toContain("雨夜追踪");
  });

  test("logChange 不截断（完整保留审计记录）", () => {
    const w = mkWorld();
    for (let i = 0; i < 510; i++) {
      logChange(w, { chapter: 1, actor: "ai", kind: "stress", detail: `第${i}条` });
    }
    expect((w.changeLog ?? []).length).toBe(510);
    // 最早的记录仍保留
    expect((w.changeLog ?? [])[0].detail).toBe("第0条");
    expect((w.changeLog ?? []).at(-1)?.detail).toBe("第509条");
  });

  test("日志条目含完整字段（at/chapter/actor/kind/detail）", () => {
    const w = mkWorld();
    logChange(w, { chapter: 1, actor: "user", kind: "unit-test", detail: "校验字段完整性" });
    const e = (w.changeLog ?? []).at(-1)!;
    expect(e.at).toBeTruthy();
    expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    expect(e.chapter).toBe(1);
    expect(e.actor).toBe("user");
    expect(e.kind).toBe("unit-test");
    expect(e.detail).toBe("校验字段完整性");
  });

  test("logCommandChange 未知 commandId 不崩溃且降级（有效 ID 正常记 level）", () => {
    const w = mkWorld();
    // 有效 commandId：level 从指令表取
    logCommandChange(w, { chapter: 1, actor: "user", kind: "test", detail: "有效 ID", commandId: "CMD-L07" });
    const valid = (w.changeLog ?? []).at(-1)!;
    expect(valid.commandId).toBe("CMD-L07");
    expect(valid.level).toBe("L1"); // L07 伏笔 CRUD = L1
    // 未知 commandId：不崩溃，commandId 原样记录，level 降级 undefined
    logCommandChange(w, { chapter: 1, actor: "user", kind: "test", detail: "未知 ID", commandId: "CMD-TYPO" });
    const invalid = (w.changeLog ?? []).at(-1)!;
    expect(invalid.commandId).toBe("CMD-TYPO");
    expect(invalid.level).toBeUndefined(); // getCommand 返回 undefined → level 不填
  });
});
