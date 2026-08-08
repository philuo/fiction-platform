// 角色登场/出场一致性（修「角色卡登场章节与出场角色统计不一致」）+ 登场章节区间显示
// 覆盖：recomputeAppearedIn 与 appearedChars 双轨同源（LLM 名单 / 正文别名归一）、formatChapterRange 区间压缩
import { describe, expect, test } from "bun:test";
import { recomputeAppearedIn } from "../src/api/chronicler";
import { appearedChars, appearedInChapter, normCharName } from "../src/shared/appearance";
import { formatChapterRange } from "../src/shared/chapterRange";
import { emptyWorld, type WorldState } from "../src/api/world";

const ch = (index: number, text: string) => ({ index, title: `第${index}章`, text, review: null });

/** 角色列表：c1 沈追 / c2 小飞侠（正文可用别名"飞侠"） */
function baseWorld(): WorldState {
  const w = emptyWorld();
  w.characters.push(
    { id: "c1", name: "沈追", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 1 },
    { id: "c2", name: "小飞侠", role: "配角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 1 },
  );
  return w;
}

describe("formatChapterRange（登场章节区间压缩）", () => {
  test("连续区间合并 + 单章独立（用户示例数据）", () => {
    expect(formatChapterRange([1, 2, 3, 4, 5, 6, 7, 10, 12, 15, 16, 17, 18, 20])).toBe("1~7、10、12、15~18、20");
  });
  test("相邻 2 章合并为区间", () => {
    expect(formatChapterRange([3, 4])).toBe("3~4");
  });
  test("单章 / 未登场", () => {
    expect(formatChapterRange([7])).toBe("7");
    expect(formatChapterRange([])).toBe("0");
    expect(formatChapterRange(undefined)).toBe("0");
  });
  test("乱序去重后仍正确", () => {
    expect(formatChapterRange([20, 3, 3, 1, 2])).toBe("1~3、20");
  });
});

describe("recomputeAppearedIn 与出场角色同源（修统计不一致）", () => {
  test("LLM 名单判定出场但正文只用代词 → appearedIn 不漏章", () => {
    const w = baseWorld();
    w.chapters.push(ch(1, "他蹲下查看尸体，她在一旁发抖")); // 正文无角色名
    w.chapterSummaries = [{ index: 1, summary: "速览", appeared: ["沈追", "小飞侠"], events: [], stateChanges: [] }];
    recomputeAppearedIn(w);
    expect(w.characters.find((c) => c.name === "沈追")!.appearedIn).toEqual([1]);
    expect(w.characters.find((c) => c.name === "小飞侠")!.appearedIn).toEqual([1]);
    // 与「本章出场角色」面板判定一致
    expect(appearedChars(w, 1).map((c) => c.name).sort()).toEqual(["小飞侠", "沈追"]);
  });

  test("正文用别名（飞侠）→ 登场记录命中（与左栏正文兜底同款归一）", () => {
    const w = baseWorld();
    w.chapters.push(ch(1, "飞侠从天而降，沈追接住他")); // 无结算名单 → 正文匹配
    recomputeAppearedIn(w);
    expect(w.characters.find((c) => c.name === "小飞侠")!.appearedIn).toEqual([1]);
    expect(w.characters.find((c) => c.name === "沈追")!.appearedIn).toEqual([1]);
  });

  test("名单空（结算失败降级）→ 回退正文匹配，不漏正文现身的角色", () => {
    const w = baseWorld();
    w.chapters.push(ch(2, "沈追独自在城南发现尸体"));
    w.chapterSummaries = [{ index: 2, summary: "降级摘要", appeared: [], events: [], stateChanges: [] }];
    recomputeAppearedIn(w);
    expect(w.characters.find((c) => c.name === "沈追")!.appearedIn).toEqual([2]);
    expect(w.characters.find((c) => c.name === "小飞侠")!.appearedIn).toBeUndefined();
  });

  test("appearedIn 与 appearedChars 逐章一致（同一 world 双轨口径）", () => {
    const w = baseWorld();
    w.chapters.push(ch(1, "他走进客栈，她在门口等候"));
    w.chapters.push(ch(2, "飞侠与沈追在桥上相遇"));
    w.chapters.push(ch(3, "夜色深沉，无人说话")); // 无人出场
    w.chapterSummaries = [
      { index: 1, summary: "速览", appeared: ["沈追", "小飞侠"], events: [], stateChanges: [] }, // 名单判定（正文无名字）
      { index: 2, summary: "速览2", appeared: ["沈追"], events: [], stateChanges: [] }, // 名单缺小飞侠（正文有飞侠）→ 双方一致走名单
    ];
    recomputeAppearedIn(w);
    for (const c of w.characters) {
      for (const chapter of w.chapters) {
        const inList = (c.appearedIn ?? []).includes(chapter.index);
        const inPanel = appearedChars(w, chapter.index).some((x) => x.id === c.id);
        expect(inList).toBe(inPanel); // 角色卡登场章节 ⇔ 出场角色面板，逐章严格一致
      }
    }
  });
});

describe("appearedInChapter 单章判定", () => {
  test("章节不存在 / 名单为空且正文无名字 → 不登场", () => {
    const w = baseWorld();
    w.chapters.push(ch(5, "无关内容"));
    expect(appearedInChapter(w, w.characters[0], 99)).toBe(false);
    expect(appearedInChapter(w, w.characters[0], 5)).toBe(false);
  });
  test("normCharName 共享实现可用", () => {
    expect(normCharName("小飞侠")).toBe("飞侠");
  });
});
