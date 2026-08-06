// 共享「本章出场角色」判定逻辑（左栏脉络 / 右栏人物共用）
// 覆盖：LLM 语义名单优先、别名归一映射、名单为空/未结算回退实时文本匹配、
// 章节内容变更、版本回滚、删除章节后（world 变化）判定跟随新正文
import { test, expect, describe } from "bun:test";
import { normCharName, appearsInChapter, appearedChars } from "../src/components/charAppearance";
import type { WorldState, Character } from "../src/api/world";

const mkChar = (id: string, name: string): Character =>
  ({ id, name, role: "测试", traits: [], motivation: "", secret: "", status: "", relations: {}, voice: "", introducedAt: 1 }) as Character;

const mkWorld = (partial: Partial<WorldState>): WorldState =>
  ({
    title: "测试",
    genre: "",
    premise: "",
    setting: { time: "", place: "", rules: [], tone: "" },
    characters: [mkChar("c1", "沈追"), mkChar("c2", "小飞侠"), mkChar("c3", "谢三娘")],
    foreshadowing: [],
    timeline: [],
    chapters: [],
    cards: [],
    outline: [],
    nextChapter: 1,
    ...partial,
  }) as WorldState;

const ch = (index: number, text: string) => ({ index, title: `第${index}章`, text, review: null, versions: [], media: [] });

describe("normCharName", () => {
  test("去空白 + 去 阿/小/老 前缀", () => {
    expect(normCharName("小飞侠")).toBe("飞侠");
    expect(normCharName(" 沈 追 ")).toBe("沈追");
    expect(normCharName("老周")).toBe("周");
    expect(normCharName("阿青")).toBe("青");
  });
});

describe("appearsInChapter", () => {
  test("全名命中", () => {
    expect(appearsInChapter(mkChar("c1", "沈追"), "沈追在街上巡逻")).toBe(true);
    expect(appearsInChapter(mkChar("c1", "沈追"), "追风少年路过")).toBe(false);
  });
  test("别名归一宽松匹配（小飞侠→飞侠），单字不做宽松匹配", () => {
    expect(appearsInChapter(mkChar("c2", "小飞侠"), "飞侠从天而降")).toBe(true);
    const one = mkChar("c9", "小雨");
    expect(appearsInChapter(one, "雨下得很大")).toBe(false);
  });
});

describe("appearedChars 双轨判定", () => {
  test("无结算快照（未结算/草稿章）→ 实时正文匹配", () => {
    const w = mkWorld({ chapters: [ch(1, "沈追与谢三娘在城南发现尸体")] });
    const got = appearedChars(w, 1);
    expect(got.map((c) => c.name).sort()).toEqual(["沈追", "谢三娘"]);
  });

  test("LLM 记账名单优先：名单含但正文用代词不出现名字 → 仍按名单展示", () => {
    const w = mkWorld({
      chapters: [ch(1, "他蹲下查看尸体，她在一旁发抖")],
      chapterSummaries: [{ index: 1, summary: "速览", appeared: ["沈追", "谢三娘"], events: [], stateChanges: [] }],
    });
    const got = appearedChars(w, 1);
    expect(got.map((c) => c.name).sort()).toEqual(["沈追", "谢三娘"]);
  });

  test("名单空（结算失败降级 / 判定无人出场）→ 回退实时正文匹配，不沿用旧名单", () => {
    // 回滚/编辑后旧名单被清空（appeared=[]），正文已含新角色 → 必须按正文展示
    const w = mkWorld({
      chapters: [ch(1, "沈追和小飞侠在城中相遇")],
      chapterSummaries: [{ index: 1, summary: "第1章《第1章》：旧摘要", appeared: [], events: [], stateChanges: [] }],
    });
    const got = appearedChars(w, 1);
    expect(got.map((c) => c.name).sort()).toEqual(["小飞侠", "沈追"]);
  });

  test("名单用别名时按归一映射回名册角色（飞侠→小飞侠）", () => {
    const w = mkWorld({
      chapters: [ch(1, "沈追进城")],
      chapterSummaries: [{ index: 1, summary: "速览", appeared: ["沈追", "飞侠"], events: [], stateChanges: [] }],
    });
    const got = appearedChars(w, 1);
    expect(got.map((c) => c.name).sort()).toEqual(["小飞侠", "沈追"]);
  });

  test("删除章节/切换章节后判定跟随新正文", () => {
    // 模拟删除第 1 章后：world 只剩第 2 章，旧章角色不再出现
    const w = mkWorld({
      chapters: [ch(2, "秦仵作验尸后摇头")],
      chapterSummaries: [{ index: 1, summary: "旧章", appeared: ["沈追"], events: [], stateChanges: [] }],
    });
    const got = appearedChars(w, 2);
    expect(got.map((c) => c.name)).toEqual([]); // 名册里没有「秦仵作」，正文也未提及名册角色
    expect(appearedChars(w, 1)).toEqual([]); // 已删除章节 → 无内容
  });

  test("chapterIdx < 0（无章节）→ 空", () => {
    const w = mkWorld({ chapters: [ch(1, "沈追在城里")] });
    expect(appearedChars(w, -1)).toEqual([]);
  });
});
