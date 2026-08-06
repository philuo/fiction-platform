// 纯函数单元测试（P0/J1）：不依赖真实 API key，bun test tests/unit.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractJson, clampScore } from "../src/api/jsonutil";
import { slugify, allocateTitle, storyExists, migrateWorld, saveWorld, loadWorld } from "../src/api/storage";
import { autoPick } from "../src/api/cards";
import { recomputeAppearedIn, editWorld } from "../src/api/director";
import { normAnchor, styleAnchor, ensureStyleSuffix, planContext, findCharacterRef, identityDress } from "../src/api/media";
import { toAgnesSize } from "../src/api/images";
import { durationToNumFrames, normalizeNumFrames, VIDEO_WIDTH, VIDEO_HEIGHT } from "../src/api/videos";
import { activeLore } from "../src/api/lore";
import { estimateTokens, contextTier, buildWriterContext, retrieveRelevant, upsertSummary } from "../src/api/memory";
import { emptyWorld, genOf, activeForeshadows, DEFAULT_GEN, type Card, type WorldState } from "../src/api/world";

// 隔离 data/：切到临时目录，避免污染真实存档
let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-test-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("jsonutil.extractJson", () => {
  test("剥离 ```json 围栏", () => {
    const out = extractJson<{ a: number }>('前缀 ```json\n{"a":1}\n``` 后缀');
    expect(out.a).toBe(1);
  });
  test("平衡括号截取首个完整对象（尾部杂文）", () => {
    const out = extractJson<{ a: string }>('{"a":"含{括号}"} 还有一段废话');
    expect(out.a).toBe("含{括号}");
  });
  test("字符串内转义引号不破坏解析", () => {
    const out = extractJson<{ t: string }>('{"t":"他说\\"你好\\""}');
    expect(out.t).toBe('他说"你好"');
  });
  test("非法 JSON 抛错", () => {
    expect(() => extractJson("完全不是 json")).toThrow();
  });
});

describe("jsonutil.clampScore", () => {
  test("正常值四舍五入", () => expect(clampScore(7.6)).toBe(8));
  test("越界钳制", () => {
    expect(clampScore(0)).toBe(1);
    expect(clampScore(99)).toBe(10);
  });
  test("非法值回退下限", () => expect(clampScore("abc")).toBe(1));
});

describe("storage.slugify / allocateTitle", () => {
  test("特殊字符转连字符", () => expect(slugify("我的 小说/第一卷?")).toBe("我的-小说-第一卷-"));
  test("路径逃逸防御", () => {
    expect(slugify("..")).toBe("story");
    expect(slugify(".")).toBe("story");
  });
  test("同名立项自动追加后缀（修 G1）", () => {
    mkdirSync(join(tmp, "data", "测试书"), { recursive: true });
    writeFileSync(join(tmp, "data", "测试书", "state.json"), "{}");
    expect(storyExists("测试书")).toBe(true);
    expect(allocateTitle("测试书")).toBe("测试书-2");
    mkdirSync(join(tmp, "data", "测试书-2"), { recursive: true });
    writeFileSync(join(tmp, "data", "测试书-2", "state.json"), "{}");
    expect(allocateTitle("测试书")).toBe("测试书-3");
    expect(allocateTitle("新书")).toBe("新书");
  });
});

describe("storage.migrateWorld / versions 外置", () => {
  test("arcs 迁移为 plotThreads 并补 id", () => {
    const w = emptyWorld();
    (w as unknown as { arcs: unknown[] }).arcs = [{ name: "主线", status: "进行中", note: "" }];
    expect(migrateWorld(w)).toBe(true);
    expect(w.plotThreads?.[0]?.id).toBe("pt1");
    expect((w as unknown as { arcs?: unknown }).arcs).toBeUndefined();
  });
  test("saveWorld 原子写 + versions 外置 + loadWorld hydrate", () => {
    const w = emptyWorld();
    w.title = "存档测试";
    w.chapters.push({
      index: 1,
      title: "第一节",
      text: "正文内容",
      review: null,
      versions: [{ title: "第一节", text: "旧稿", review: null, at: "2026-08-01T00:00:00.000Z", reason: "测试" }],
    });
    saveWorld(w);
    const loaded = loadWorld("存档测试");
    expect(loaded).not.toBeNull();
    expect(loaded!.chapters[0].versions?.[0]?.text).toBe("旧稿");
    // state.json 本体不含 versions 全文（已外置）
    const raw = readFileSync(join(tmp, "data", "存档测试", "state.json"), "utf-8");
    expect(raw.includes("旧稿")).toBe(false);
    expect(raw.includes("versionFiles")).toBe(true);
  });
  test("loadWorld 存量版本表去重：内存合并、saveWorld 收敛磁盘孤儿文件、幂等", () => {
    const w = emptyWorld();
    w.title = "去重存量测试";
    const mk = (text: string, at: string) => ({ title: "第一章", text, review: null, at, reason: "r" });
    w.chapters.push({
      index: 1,
      title: "第一章",
      text: "正文A",
      review: null,
      versions: [
        mk("正文A", "2026-01-01T00:00:00.000Z"), // 与当前内容一致
        mk("正文B", "2026-01-02T00:00:00.000Z"),
        mk("正文A", "2026-01-03T00:00:00.000Z"), // 重复（at 较新 → 内容重复时保留较新元数据）
        mk("正文B", "2026-01-04T00:00:00.000Z"), // 重复
      ],
    });
    saveWorld(w);
    const vDir = join(tmp, "data", "去重存量测试", "versions");
    expect(readdirSync(vDir).length).toBe(4); // 落盘 4 个版本文件

    // loadWorld 只改内存：去重为 2 条，但只读路径不触发任何磁盘写
    const loaded = loadWorld("去重存量测试")!;
    const vs = loaded.chapters[0].versions ?? [];
    expect(vs.map((v) => v.text)).toEqual(["正文A", "正文B"]); // 内容唯一
    expect(vs[0].at).toBe("2026-01-03T00:00:00.000Z"); // 内容重复时保留 at 较新者
    expect(loaded.chapters[0].versionFiles?.length).toBe(2); // versionFiles 同步收缩
    expect(readdirSync(vDir).length).toBe(4); // 磁盘文件未被动（纯内存去重）

    // 下一次 saveWorld 收敛磁盘孤儿文件
    saveWorld(loaded);
    expect(readdirSync(vDir).length).toBe(2); // 孤儿版本文件已清理

    // 幂等：再加载再保存不再变化
    const again = loadWorld("去重存量测试")!;
    expect(again.chapters[0].versions?.map((v) => v.text)).toEqual(["正文A", "正文B"]);
    saveWorld(again);
    expect(readdirSync(vDir).length).toBe(2);
  });
  test("旧格式存量（state.json 内嵌 versions、无 versionFiles）加载即去重", () => {
    const w = emptyWorld();
    w.title = "内嵌存量测试";
    w.chapters.push({
      index: 1,
      title: "第一章",
      text: "正文X",
      review: null,
      versions: [
        { title: "第一章", text: "正文X", review: null, at: "2026-02-01T00:00:00.000Z", reason: "r" },
        { title: "第一章", text: "正文Y", review: null, at: "2026-02-02T00:00:00.000Z", reason: "r" },
        { title: "第一章", text: "正文X", review: null, at: "2026-02-03T00:00:00.000Z", reason: "r" }, // 重复
      ],
    });
    // 手工写旧格式存档：versions 内嵌在 state.json，无 versionFiles 字段
    const dir = join(tmp, "data", "内嵌存量测试");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(w), "utf-8");

    const loaded = loadWorld("内嵌存量测试")!;
    const vs = loaded.chapters[0].versions ?? [];
    expect(vs.map((v) => v.text)).toEqual(["正文X", "正文Y"]); // 内嵌存量同样去重
    expect(vs[0].at).toBe("2026-02-03T00:00:00.000Z"); // 保留 at 较新者
    expect(loaded.chapters[0].versionFiles?.length).toBe(2); // versionFiles 补齐，可正常外置
    saveWorld(loaded); // 首次保存：外置 + 无孤儿可清
    expect(readdirSync(join(dir, "versions")).length).toBe(2);
  });
});

describe("cards.autoPick", () => {
  const mk = (id: string, rarity: Card["rarity"], type: Card["type"]): Card => ({
    id, type, rarity, title: id, description: "", effect: "",
  });
  test("优先稀有度，同级优先伏笔/角色", () => {
    const pool = [mk("a", "R", "章节"), mk("b", "SSR", "道具"), mk("c", "SSR", "伏笔"), mk("d", "N", "角色")];
    const picked = autoPick(pool, 2);
    expect(picked.map((c) => c.id)).toEqual(["c", "b"]);
  });
});

describe("director.recomputeAppearedIn", () => {
  test("以正文出现为准重算登场章节", () => {
    const w = emptyWorld();
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
    w.chapters.push({ index: 1, title: "一", text: "阿青走进客栈。", review: null });
    w.chapters.push({ index: 2, title: "二", text: "夜色深沉。", review: null });
    expect(recomputeAppearedIn(w)).toBe(true);
    expect(w.characters[0].appearedIn).toEqual([1]);
    expect(recomputeAppearedIn(w)).toBe(false); // 幂等
  });
});

describe("director.editWorld 手动新增角色", () => {
  test("id 不存在时创建角色：默认值补齐，重名/缺名拒绝，已有 id 走更新", () => {
    const w = emptyWorld();
    w.nextChapter = 3;
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: [], motivation: "", status: "调查中", relations: {}, introducedAt: 1 });
    // 新增（性别仅男/女，非法值丢弃）
    editWorld(w, { characters: [{ id: "c-new", name: "沈夜", role: "反派", gender: "男", age: "三十", identity: "东厂提督", traits: ["冷峻", "缜密"], status: "待登场", motivation: "复仇" }] });
    expect(w.characters.length).toBe(2);
    const nc = w.characters.find((c) => c.id === "c-new")!;
    expect(nc.name).toBe("沈夜");
    expect(nc.role).toBe("反派");
    expect(nc.gender).toBe("男");
    expect(nc.age).toBe("三十");
    expect(nc.identity).toBe("东厂提督");
    expect(nc.traits).toEqual(["冷峻", "缜密"]);
    expect(nc.status).toBe("待登场");
    expect(nc.motivation).toBe("复仇");
    expect(nc.introducedAt).toBe(3); // 按 nextChapter 登记
    expect(nc.relations).toEqual({});
    expect(nc.appearedIn).toBeUndefined();
    // 重名拒绝（不静默跳过）
    expect(() => editWorld(w, { characters: [{ id: "c-new2", name: "沈夜" }] })).toThrow("已存在");
    expect(w.characters.length).toBe(2);
    // 缺名跳过（不创建）
    editWorld(w, { characters: [{ id: "c-new3", name: "   " }] });
    expect(w.characters.length).toBe(2);
    // 已有 id 走更新（不重复创建）
    editWorld(w, { characters: [{ id: "c1", name: "阿青", status: "结案" }] });
    expect(w.characters.length).toBe(2);
    expect(w.characters[0].status).toBe("结案");
    // 重命名撞名：把已有角色改成其他角色名 → 拒绝
    expect(() => editWorld(w, { characters: [{ id: "c1", name: "沈夜" }] })).toThrow("已存在");
    expect(w.characters.find((c) => c.id === "c1")?.name).toBe("阿青"); // 未被改名
  });
});

describe("media.normAnchor", () => {
  test("去空白与中文引号", () => {
    expect(normAnchor("他说「你好」 然后 离开")).toBe("他说你好然后离开");
  });
});

describe("media.styleAnchor / ensureStyleSuffix（画风一致性）", () => {
  test("题材关键词映射画风（中文）", () => {
    const w = emptyWorld();
    w.genre = "古风悬疑";
    expect(styleAnchor(w)).toContain("水墨");
    w.genre = "星际科幻";
    expect(styleAnchor(w)).toContain("科幻");
  });
  test("未命中题材时兜底通用风格", () => {
    const w = emptyWorld();
    w.genre = "小众题材";
    expect(styleAnchor(w).length).toBeGreaterThan(0);
  });
  test("缺风格签名强制拼接 + 补无水印要求", () => {
    const out = ensureStyleSuffix("一个女孩站在雨中", "电影级动漫插画，戏剧性光影");
    expect(out).toContain("电影级动漫插画");
    expect(out).toContain("无水印");
  });
  test("已含风格签名不重复拼接", () => {
    const out = ensureStyleSuffix("电影级动漫插画场景，画面中不要出现文字，无水印", "电影级动漫插画，戏剧性光影");
    expect(out.split("电影级动漫插画").length).toBe(2); // 仅出现一次
  });
});

describe("media.identityDress（身份服饰映射）", () => {
  const ch = (identity: string) => ({ id: "c", name: "某甲", role: "配角", identity, traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
  test("医疗细分身份优先于通用医生条目", () => {
    const d = identityDress(ch("外科医生"));
    expect(d).toContain("胸牌"); // 命中「外科」条目
    expect(d).not.toContain("听诊器"); // 未被通用「医生」条目抢占
  });
  test("星际身份命中星际服饰条目", () => {
    expect(identityDress(ch("星际舰长"))).toContain("星际舰服");
    expect(identityDress(ch("星际商人"))).toContain("全息账本"); // 早于古代「商人」条目
  });
  test("新增常见身份抽查命中", () => {
    expect(identityDress(ch("法官"))).toContain("法袍");
    expect(identityDress(ch("茶艺师"))).toContain("茶服");
    expect(identityDress(ch("黑客"))).toContain("连帽卫衣");
    expect(identityDress(ch("稳婆"))).toContain("粗布衣");
    expect(identityDress(ch("书童"))).toContain("书箱");
  });
  test("未命中身份返回空串（仅用时代底衣）", () => {
    expect(identityDress(ch("神秘旅人"))).toBe("");
  });
});

describe("media.planContext / findCharacterRef（分镜上下文与角色参考图）", () => {
  test("planContext 含出场角色外貌/状态与场景素材", () => {
    const w = emptyWorld();
    w.premise = "一个关于梦的故事";
    w.setting = { time: "明朝末年", place: "京城", rules: [], tone: "阴郁" };
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: "青衣,长发".split(","), motivation: "", status: "重伤昏迷", relations: {}, introducedAt: 0 });
    w.chapters.push({ index: 1, title: "一", text: "阿青醒来。", review: null });
    w.chapterSummaries = [{ index: 1, summary: "阿青醒来", events: [], appeared: ["阿青"], stateChanges: [] }];
    const ctx = planContext(w, 1);
    expect(ctx).toContain("阿青");
    expect(ctx).toContain("重伤昏迷");
    expect(ctx).toContain("明朝末年");
    expect(ctx).toContain("画风锚点");
  });
  test("findCharacterRef 匹配最近章角色图，无则 undefined", () => {
    const w = emptyWorld();
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
    w.chapters.push({
      index: 1, title: "一", text: "…", review: null,
      media: [{ id: "m1", kind: "image", anchor: "阿青提剑而立", prompt: "p", path: "images/a.png", status: "ready" }],
    });
    w.chapters.push({ index: 2, title: "二", text: "…", review: null });
    expect(findCharacterRef(w, 2, "阿青倒在血泊中")?.id).toBe("m1");
    expect(findCharacterRef(w, 2, "夜色深沉无一人")).toBeUndefined();
  });
});

describe("images.toAgnesSize（1K 硬限）", () => {
  test("尺寸恒为 1K，仅映射 ratio", () => {
    expect(toAgnesSize("896x560").size).toBe("1K");
    expect(toAgnesSize("896x560").ratio).toBe("3:2");
    expect(toAgnesSize("768x768").ratio).toBe("1:1");
    expect(toAgnesSize("4000x4000").size).toBe("1K");
  });
});

describe("videos 硬约束（720p 16:9 + 5~15s）", () => {
  test("宽高恒 1280x720", () => {
    expect(VIDEO_WIDTH).toBe(1280);
    expect(VIDEO_HEIGHT).toBe(720);
  });
  test("时长钳制 5~15s 且满足 8n+1", () => {
    expect(durationToNumFrames(5)).toBe(121);
    expect(durationToNumFrames(10)).toBe(241);
    expect(durationToNumFrames(15)).toBe(361);
    expect(durationToNumFrames(1)).toBe(121); // 下限钳制
    expect(durationToNumFrames(99)).toBe(361); // 上限钳制
    const v = durationToNumFrames(7);
    expect((v - 1) % 8).toBe(0);
    expect(v).toBeGreaterThanOrEqual(121);
    expect(v).toBeLessThanOrEqual(441);
  });
  test("normalizeNumFrames 下限 121、上限 441、合法 8n+1", () => {
    expect(normalizeNumFrames(1)).toBe(121);
    expect(normalizeNumFrames(9999)).toBeLessThanOrEqual(441);
    expect((normalizeNumFrames(200) - 1) % 8).toBe(0);
  });
});

describe("lore.activeLore 关键词匹配（修 B3）", () => {
  test("命中条目优先，补足到 8 条", () => {
    const w = emptyWorld();
    w.lore = [
      { id: "1", keywords: ["京城"], content: "京城设定", enabled: true, auto: true },
      { id: "2", keywords: ["不存在词"], content: "无关", enabled: true, auto: true },
      { id: "3", keywords: ["捕快"], content: "捕快制度", enabled: true, auto: true },
      { id: "4", keywords: ["禁用"], content: "已停用", enabled: false, auto: true },
    ];
    const list = activeLore(w, "主角是京城的一名捕快");
    expect(list.map((e) => e.id)).toEqual(["1", "3", "2"]); // 命中优先，enabled only
  });
  test("无上下文退化为顺序前 8", () => {
    const w = emptyWorld();
    w.lore = Array.from({ length: 12 }, (_, i) => ({ id: String(i), keywords: ["x"], content: `c${i}`, enabled: true, auto: true }));
    expect(activeLore(w).length).toBe(8);
  });
});

describe("memory 记忆层", () => {
  test("estimateTokens：CJK×1.5", () => {
    expect(estimateTokens("你好")).toBe(3);
    expect(estimateTokens("abcd")).toBe(1);
  });
  test("contextTier 按总字数切档", () => {
    const w = emptyWorld();
    expect(contextTier(w)).toBe("full");
    w.chapters.push({ index: 1, title: "t", text: "字".repeat(70_000), review: null });
    expect(contextTier(w)).toBe("window");
    w.chapters[0].text = "字".repeat(210_000);
    expect(contextTier(w)).toBe("tiered");
    w.gen = { contextMode: "tiered" };
    w.chapters[0].text = "短";
    expect(contextTier(w)).toBe("tiered"); // 手动覆盖 auto
  });
  test("buildWriterContext 超预算裁减检索/伏笔层", () => {
    const w = emptyWorld();
    w.title = "预算测试";
    w.setting = { time: "明朝", place: "京城", rules: [], tone: "冷峻" };
    w.chapters.push({ index: 1, title: "一", text: "第一章正文。".repeat(20), review: null });
    w.chapterSummaries = [{ index: 1, summary: "第一章发生了命案。", events: ["命案"], appeared: ["阿青"], stateChanges: [], hook: "" }];
    w.foreshadowing = [{ id: "f1", text: "神秘信件", plantedAt: 1, status: "planted" }];
    w.nextChapter = 2;
    const tight = buildWriterContext(w, null, 60); // 极小预算
    const loose = buildWriterContext(w, null, 60000);
    expect(tight.tokens).toBeLessThan(loose.tokens);
    expect(tight.segments.some((s) => s.label === "setting")).toBe(true); // 核心设定不可裁
  });
  test("retrieveRelevant 角色名命中加权", () => {
    const w = emptyWorld();
    w.characters.push({ id: "c1", name: "阿青", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
    w.chapterSummaries = [
      { index: 1, summary: "阿青在客栈遇到刺客。", events: [], appeared: ["阿青"], stateChanges: [], hook: "" },
      { index: 2, summary: "集市上热闹非凡。", events: [], appeared: [], stateChanges: [], hook: "" },
    ];
    w.nextChapter = 3;
    const rel = retrieveRelevant(w, { index: 3, arcId: "a1", goal: "阿青追查刺客", beats: ["阿青夜探客栈"], hookType: "悬念", status: "planned" }, 1);
    expect(rel[0]?.index).toBe(1);
  });
  test("upsertSummary 按 index 覆盖", () => {
    const w = emptyWorld();
    upsertSummary(w, { index: 1, summary: "旧", events: [], appeared: [], stateChanges: [] });
    upsertSummary(w, { index: 1, summary: "新", events: [], appeared: [], stateChanges: [] });
    expect(w.chapterSummaries?.length).toBe(1);
    expect(w.chapterSummaries?.[0].summary).toBe("新");
  });
});

describe("world.genOf / activeForeshadows", () => {
  test("章节覆盖合并 + 默认兜底", () => {
    const w = emptyWorld();
    w.gen = { temperature: 1.2 };
    w.chapterGen = { 3: { temperature: 0.5 } };
    expect(genOf(w, 3).temperature).toBe(0.5);
    expect(genOf(w, 4).temperature).toBe(1.2);
    expect(genOf(w).minWords).toBe(DEFAULT_GEN.minWords);
  });
  test("activeForeshadows 过滤已回收", () => {
    const w = emptyWorld();
    w.foreshadowing = [
      { id: "f1", text: "a", plantedAt: 1, status: "planted" },
      { id: "f2", text: "b", plantedAt: 1, status: "resolved", resolvedAt: 2 },
    ];
    expect(activeForeshadows(w).map((f) => f.id)).toEqual(["f1"]);
  });
});
