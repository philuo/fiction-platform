// 中枢对话编排（brain-chat）测试：意图映射完整性 + L0 查询执行 + 事件协议 v2（intent/delta/card/done/interrupted）
// 隔离策略：不用 mock.module（Bun 进程级注册会污染同进程其他测试文件），
// 而是替换 brain-chat 的依赖注入点 brainChatDeps + BRAIN_SESSIONS_DATA_DIR 临时目录。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyWorld, type WorldState } from "../src/api/world";
import type { Card as WorldCard } from "../src/api/world";
import { executeQuery, INTENTS, brainChatStream, brainChatDeps, buildFormCard, flattenFormValues, buildMediaCard, chapterIndexFromPrompt, extractNameFromHistory, isHollowReply, l0QueryReply, isAmbiguousChapterPrompt, chapterAskCard } from "../src/api/brain-chat";
import { getSession as sessGet, lastPendingMessage as sessLastPending } from "../src/api/brain-sessions";
import type { ChatMessage } from "../src/api/agnes";

// —— 注入替身（替代 mock.module）：chatJson 返回 nextChatContent（JSON 字符串）；chatStream 逐字符真流式 + abort 检查 ——
let nextChatContent = "";
let chatJsonQueue: string[] = [];
const originalDeps = { ...brainChatDeps };

brainChatDeps.chatJson = (async (_msgs: ChatMessage[], _opts?: unknown) => {
  if (chatJsonQueue.length) return JSON.parse(chatJsonQueue.shift() ?? "{}");
  return JSON.parse(nextChatContent);
}) as typeof brainChatDeps.chatJson;
brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: { signal?: AbortSignal }) => {
  const text = nextChatContent;
  let acc = "";
  for (const ch of text) {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    acc += ch;
    onChunk(ch);
  }
  return acc;
}) as typeof brainChatDeps.chatStream;

// loadWorld 注入：返回内存 mockWorld（不触碰真实磁盘）
let mockWorld: WorldState | null = null;
brainChatDeps.loadWorld = (() => mockWorld) as typeof brainChatDeps.loadWorld;

// gachaGenerate 注入：返回内存 mockPool（不触碰真实 LLM/磁盘）
let mockPool: WorldCard[] = [];
brainChatDeps.gachaGenerate = (async () => ({ pool: mockPool })) as typeof brainChatDeps.gachaGenerate;

// 会话持久化隔离：BRAIN_SESSIONS_DATA_DIR 指向临时目录，不污染真实 data/
let sessDataDir = "";
beforeAll(() => {
  sessDataDir = mkdtempSync(join(tmpdir(), "brain-chat-sess-"));
  process.env.BRAIN_SESSIONS_DATA_DIR = sessDataDir;
});
afterAll(() => {
  rmSync(sessDataDir, { recursive: true, force: true });
  delete process.env.BRAIN_SESSIONS_DATA_DIR;
  // 还原真实依赖（同进程内后续文件不受影响）
  brainChatDeps.chatJson = originalDeps.chatJson;
  brainChatDeps.chatStream = originalDeps.chatStream;
  brainChatDeps.loadWorld = originalDeps.loadWorld;
  brainChatDeps.gachaGenerate = originalDeps.gachaGenerate;
});

/** 收集一次回合的全部事件 */
async function runTurn(prompt: string, opts: { sessionId?: string; resume?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  await brainChatStream({
    title: "brain-chat-test",
    prompt,
    sessionId: opts.sessionId ?? "test-session",
    send: (o) => events.push(o as Record<string, unknown>),
    signal: opts.signal,
    resume: opts.resume,
  });
  return events;
}

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "brain-chat-test";
  w.nextChapter = 3;
  w.chapters.push({ index: 1, title: "第一章", text: "林墨走入夜色中…", review: null });
  w.characters.push({ id: "c1", name: "林墨", role: "主角", traits: ["冷静"], motivation: "查明真相", status: "调查中", introducedAt: 1 });
  w.foreshadowing.push({ id: "f1", text: "神秘玉佩", plantedAt: 1, status: "planted" });
  return w;
}

describe("INTENTS 意图映射", () => {
  test("覆盖 16 类手动入口的核心操作", () => {
    const keys = Object.keys(INTENTS);
    // 推进/连载/抽卡/查询/评估/编辑/删章/重写/重算/媒体/巡检/导出/伏笔/对话
    expect(keys).toContain("advance");
    expect(keys).toContain("autostart");
    expect(keys).toContain("autostop");
    expect(keys).toContain("gacha");
    expect(keys).toContain("read_chapter");
    expect(keys).toContain("read_character");
    expect(keys).toContain("read_foreshadow");
    expect(keys).toContain("eval");
    expect(keys).toContain("edit_world");
    expect(keys).toContain("delete_chapter");
    expect(keys).toContain("regenerate");
    expect(keys).toContain("media_image");
    expect(keys).toContain("integrity");
    expect(keys).toContain("export");
    expect(keys).toContain("chat");
  });

  test("每个意图有 commandId + level + title", () => {
    for (const [k, v] of Object.entries(INTENTS)) {
      expect(v.commandId).toMatch(/^CMD-/);
      expect(["L0", "L1", "L2", "L3"]).toContain(v.level);
      expect(v.title.length).toBeGreaterThan(0);
    }
  });

  test("read_proposals：L0 只读意图（无 action，查询直接执行）", () => {
    expect(INTENTS.read_proposals.level).toBe("L0");
    expect(INTENTS.read_proposals.action).toBeUndefined();
    expect(INTENTS.read_proposals.title).toContain("提案");
  });

  test("open_proposals：打开类意图（无 action，纯 UI 动作不列列表）", () => {
    expect(INTENTS.open_proposals.level).toBe("L0");
    expect(INTENTS.open_proposals.action).toBeUndefined();
    expect(INTENTS.open_proposals.title).toContain("打开");
  });

  test("L2/L3 写操作有 action 端点", () => {
    expect(INTENTS.advance.level).toBe("L2");
    expect(INTENTS.advance.action?.endpoint).toBe("/api/novel/step");
    expect(INTENTS.delete_chapter.level).toBe("L3");
    expect(INTENTS.delete_chapter.action?.endpoint).toBe("/api/novel/chapter/delete");
  });

  test("rewrite/autoskip：聊天补齐回溯重写与跳过连载章手动入口", () => {
    expect(INTENTS.rewrite.level).toBe("L2");
    expect(INTENTS.rewrite.commandId).toBe("CMD-G06");
    expect(INTENTS.rewrite.action?.endpoint).toBe("/api/novel/rewrite");
    expect(INTENTS.rewrite.action?.body).toEqual({ action: "start" });
    expect(INTENTS.autoskip.level).toBe("L1");
    expect(INTENTS.autoskip.commandId).toBe("CMD-N14");
    expect(INTENTS.autoskip.action?.endpoint).toBe("/api/novel/auto/skip");
  });
});

describe("executeQuery（L0 查询直接执行）", () => {
  test("read_chapter：找到章节 → BrowseCard", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_chapter", { index: 1 });
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("chapter");
  });

  test("read_chapter：未找到 → ResultCard fail", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_chapter", { index: 99 });
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
  });

  test("read_character：按名匹配 → BrowseCard", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_character", { name: "林墨" });
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("character");
  });

  test("read_character：未找到 → ResultCard fail", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_character", { name: "不存在" });
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
  });

  test("read_foreshadow → BrowseCard 含伏笔列表", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_foreshadow", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("foreshadow");
  });

  test("read_proposals：有 pending 提案 → BrowseCard(proposal) 含推荐原因与可交互操作", () => {
    const w = mkWorld();
    w.characterProposals = [
      { id: "cp1", name: "小翠", role: "掌柜", traits: ["机灵"], motivation: "查清身世", reason: "与主角身世成谜呼应", source: "writer", status: "pending" },
      { id: "cp2", name: "铁捕", role: "捕快", traits: [], motivation: "追凶", source: "gacha", status: "confirmed" }, // 非 pending 不出现
    ];
    const card = executeQuery(w, "read_proposals", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("proposal");
    const list = (card!.data as { list: Record<string, unknown>[] }).list;
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("小翠");
    expect(list[0].reason).toBe("与主角身世成谜呼应");
    const actions = list[0].actions as { label: string; danger?: boolean; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(actions.length).toBe(2); // 确认入册 + 拒绝
    expect(actions[0].label).toBe("确认入册");
    expect(actions[0].action.endpoint).toBe("/api/novel/proposal");
    // 端点字段完整：/api/novel/proposal 要求 title + proposalId + action（缺 title 会 400）
    expect(actions[0].action.body).toEqual({ title: "brain-chat-test", proposalId: "cp1", action: "confirm" });
    expect(actions[1].action.body).toEqual({ title: "brain-chat-test", proposalId: "cp1", action: "reject" });
  });

  test("read_proposals：无 pending 提案 → ResultCard 提示", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_proposals", {});
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
  });

  test("read_gacha：有 pendingCards → BrowseCard(gacha) 含逐张应用与全部应用操作（聊天内抽卡闭环）", () => {
    const w = mkWorld();
    w.pendingCards = [
      { id: "g1", type: "伏笔", rarity: "SR", title: "锈剑", description: "一把生锈的剑", effect: "在关键情节取出锈剑", dueHint: "第 8 章前后回收" },
      { id: "g2", type: "角色", rarity: "SSR", title: "哑巴师父", description: "沉默的武师", effect: "收哑巴师父为徒", character: { name: "哑巴师父", role: "武师", traits: ["寡言"], motivation: "守护传人" } },
    ];
    const card = executeQuery(w, "read_gacha", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("gacha");
    const list = (card!.data as { list: Record<string, unknown>[] }).list;
    expect(list.length).toBe(2);
    expect(list[0].title).toBe("锈剑");
    const actions = list[0].actions as { label: string; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(actions.length).toBe(1);
    expect(actions[0].label).toBe("应用此卡");
    expect(actions[0].action.endpoint).toBe("/api/novel/gacha");
    expect(actions[0].action.body).toEqual({ title: "brain-chat-test", action: "apply", pick: ["g1"] });
    // 卡片级「全部应用」action（AI 优选）
    const topActions = card!.actions as { label: string; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(topActions.length).toBe(1);
    expect(topActions[0].action.body).toEqual({ title: "brain-chat-test", action: "apply", auto: true });
  });

  test("read_gacha：无 pendingCards → ResultCard 提示先生成卡池", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_gacha", {});
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
    expect(String(card?.detail)).toContain("抽卡");
  });

  test("eval：无落盘评估 → ResultCard 提示", () => {
    const w = mkWorld();
    const card = executeQuery(w, "eval", {});
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
  });

  test("未知查询意图 → null", () => {
    const w = mkWorld();
    expect(executeQuery(w, "unknown", {})).toBeNull();
  });

  // —— Phase 1 查询扩展：read_chapters/read_characters/read_plans/read_tasks/read_logs/read_worldbook/read_media/read_review ——

  test("read_chapters → BrowseCard(chapters) 含章进度 done/target 与列表", () => {
    const w = mkWorld();
    w.goal = { structure: { targetChapters: 10 } };
    w.chapters[0].review = { verdict: "pass", scores: { coherence: 8, tension: 7, prose: 6, pacing: 7, dialogue: 7 }, findings: [], round: 1 };
    const card = executeQuery(w, "read_chapters", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("chapters");
    const d = card!.data as { done: number; target: number; list: Record<string, unknown>[] };
    expect(d.done).toBe(1);
    expect(d.target).toBe(10);
    expect(d.list.length).toBe(1);
    expect(d.list[0].index).toBe(1);
    expect(d.list[0].score).toBe(8);
    expect(d.list[0].status).toBe("已入册");
  });

  test("read_characters → BrowseCard(characters) 含统计网格与列表", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_characters", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("characters");
    const d = card!.data as { stats: Record<string, unknown>; list: Record<string, unknown>[] };
    expect(d.stats.total).toBe(1);
    expect(d.list[0].name).toBe("林墨");
    expect(d.list[0].appeared).toBe(0);
    expect(d.list[0].portrait).toBe(false);
  });

  test("read_plans → BrowseCard(plans) 含卷/弧/章纲进度与 next", () => {
    const w = mkWorld();
    w.blueprint = { theme: "复仇", mainPlot: "", ending: "", compass: "终局对决", progressContract: "前十章铺垫", volumes: [{ id: "v1", title: "第一卷", goal: "觉醒", status: "writing" }] };
    w.storyArcs = [{ id: "a1", volumeId: "v1", title: "身世之谜", goal: "揭开玉佩来历", arcType: "探索发现", status: "expanded", estChapters: 5 }];
    w.chapterPlans = [
      { index: 3, arcId: "a1", goal: "主角进入迷局", beats: [], hookType: "悬念", status: "planned" },
      { index: 4, arcId: "a1", goal: "揭开一角", beats: [], hookType: "反转", status: "planned" },
    ];
    const card = executeQuery(w, "read_plans", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("plans");
    const d = card!.data as { done: number; total: number; volumes: unknown[]; arcs: unknown[]; plans: Record<string, unknown>[]; next: Record<string, unknown> | null; compass: string };
    expect(d.compass).toBe("终局对决");
    expect(d.volumes.length).toBe(1);
    expect(d.arcs.length).toBe(1);
    expect(d.total).toBe(2);
    expect(d.done).toBe(0);
    expect(d.next?.index).toBe(3);
    expect(d.plans[0].hookType).toBe("悬念");
  });

  test("read_tasks → BrowseCard(tasks) 质量债含 fix/ignore 操作 + 重写队列", () => {
    const w = mkWorld();
    w.qualityDebt = [{ id: "d1", chapterIndex: 2, lens: "continuity", issue: "角色状态前后矛盾", severity: "major", status: "open" }];
    w.rewriteQueue = [2, 3];
    const card = executeQuery(w, "read_tasks", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("tasks");
    const d = card!.data as { debt: Record<string, unknown>[]; major: number; rewriteQueue: number[]; mergeTasks: string[]; goal: { disposition: string; chapterCount: number } };
    expect(d.debt.length).toBe(1);
    expect(d.major).toBe(1);
    expect(d.rewriteQueue).toEqual([2, 3]);
    const actions = d.debt[0].actions as { label: string; danger?: boolean; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(actions.length).toBe(2);
    expect(actions[0].action.endpoint).toBe("/api/novel/debt");
    expect(actions[0].action.body).toEqual({ title: "brain-chat-test", id: "d1", action: "fix" });
    expect(actions[1].action.body).toEqual({ title: "brain-chat-test", id: "d1", action: "ignore" });
    expect(d.goal.disposition).toBe("continue");
    expect(d.goal.chapterCount).toBe(1);
  });

  test("read_logs → BrowseCard(logs) 倒序含 commandId/level", () => {
    const w = mkWorld();
    w.changeLog = [
      { at: "2025-01-01T00:00:00Z", chapter: 1, actor: "user", kind: "gacha-apply", detail: "抽卡应用 1 张", commandId: "CMD-W18", level: "L0" },
      { at: "2025-01-01T00:01:00Z", chapter: 2, actor: "brain", kind: "brain-review", detail: "认可", commandId: "CMD-N06", level: "L2" },
    ];
    const card = executeQuery(w, "read_logs", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("logs");
    const d = card!.data as { list: Record<string, unknown>[] };
    expect(d.list.length).toBe(2);
    expect(d.list[0].commandId).toBe("CMD-N06"); // 倒序：最近在前
    expect(d.list[0].level).toBe("L2");
  });

  test("read_worldbook → BrowseCard(worldbook) 含设定与 lore", () => {
    const w = mkWorld();
    w.setting = { time: "明末", place: "江南", rules: ["江湖不出朝廷"], tone: "冷峻" };
    w.lore = [{ id: "l1", keywords: ["玉佩"], content: "主角身世信物", enabled: true, auto: true }];
    const card = executeQuery(w, "read_worldbook", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("worldbook");
    const d = card!.data as { setting: { rules: string[] }; lore: Record<string, unknown>[] };
    expect(d.setting.rules).toEqual(["江湖不出朝廷"]);
    expect(d.lore.length).toBe(1);
    expect(d.lore[0].keywords).toEqual(["玉佩"]);
  });

  test("read_media → BrowseCard(media) 统计插画/视频/角色立绘", () => {
    const w = mkWorld();
    w.chapters[0].media = [
      { id: "m1", kind: "image", anchor: "夜色", status: "ready" },
      { id: "m2", kind: "video", anchor: "走入", status: "pending" },
    ];
    w.characters[0].image = "portraits/linmo.png";
    const card = executeQuery(w, "read_media", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("media");
    const d = card!.data as { stats: { images: number; videos: number; characters: number }; list: Record<string, unknown>[] };
    expect(d.stats.images).toBe(1);
    expect(d.stats.videos).toBe(1);
    expect(d.stats.characters).toBe(1);
    expect(d.list.length).toBe(2);
    expect(d.list[0].kind).toBe("image");
  });

  test("read_review：有审查报告 → BrowseCard(review) 含 5 维分数", () => {
    const w = mkWorld();
    w.chapters[0].review = { verdict: "pass", scores: { coherence: 8, tension: 7, prose: 6, pacing: 7, dialogue: 7 }, findings: [{ severity: "minor", lens: "pacing", issue: "中段略拖", evidence: "…", suggestion: "删减" }], round: 2 };
    const card = executeQuery(w, "read_review", {});
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("review");
    const d = card!.data as { verdict: string; scores: Record<string, number>; findings: unknown[]; round: number };
    expect(d.verdict).toBe("pass");
    expect(d.scores.coherence).toBe(8);
    expect(d.findings.length).toBe(1);
    expect(d.round).toBe(2);
  });

  test("read_review：无审查记录 → ResultCard 提示", () => {
    const w = mkWorld();
    const card = executeQuery(w, "read_review", {});
    expect(card?.kind).toBe("result");
    expect(card?.success).toBe(false);
  });
});

// —— Phase 2：FormCard 协议（buildFormCard / flattenFormValues）+ 新意图映射 ——

describe("INTENTS 意图映射（Phase 2 表单/执行类）", () => {
  test("表单类意图已注册（edit_world/foreshadow_edit/task_ops/draft_confirm/expand_arc/settings）", () => {
    for (const k of ["edit_world", "foreshadow_edit", "task_ops", "draft_confirm", "expand_arc", "settings"]) {
      expect(INTENTS[k]).toBeTruthy();
      expect(INTENTS[k].commandId).toMatch(/^CMD-/);
    }
    expect(INTENTS.task_ops.level).toBe("L2");
    expect(INTENTS.settings.level).toBe("L0");
  });
});

describe("buildFormCard（表单卡构建）", () => {
  test("edit_world 带角色名 → 角色表单（L2、含 id、confirmRequired）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "edit_world", { name: "林墨" }, "修改林墨");
    expect(card?.kind).toBe("form");
    expect(card?.level).toBe("L2");
    expect(card?.confirmRequired).toBe(true);
    const fields = card!.fields as { key: string }[];
    expect(fields.map((f) => f.key)).toContain("status");
    expect(fields.map((f) => f.key)).toContain("motivation");
    expect((card!.action.body.characters as { id: string }[])[0].id).toBe("c1");
    expect(card?.action.endpoint).toBe("/api/novel/world");
  });

  test("edit_world 无角色名 → 设定表单（含点路径字段 setting.rules array）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "edit_world", {});
    expect(card?.kind).toBe("form");
    expect(card?.level).toBe("L0");
    const fields = card!.fields as { key: string; array?: boolean }[];
    expect(fields.find((f) => f.key === "setting.rules")?.array).toBe(true);
    expect(fields.map((f) => f.key)).toContain("setting.time");
  });

  test("edit_world 无 name 但对话历史提到角色 → 从历史收集角色名并预填（信息可从对话收集）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "edit_world", {}, "编辑角色", { userHist: ["昨天写的林墨不太对", "帮他改改"], prompt: "帮我改一下林墨" });
    expect(card?.kind).toBe("form");
    expect(card?.level).toBe("L2");
    expect(String(card!.title)).toContain("林墨");
    expect((card!.action.body.characters as { id: string }[])[0].id).toBe("c1");
  });

  test("edit_world 无 name 且 prompt 含「角色」→ 返回 null（中枢主动询问补充信息，而非误弹设定表单）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "edit_world", {}, "编辑角色", { prompt: "帮我把那个角色改一下" });
    expect(card).toBeNull();
  });

  test("extractNameFromHistory：最近消息优先、最长名优先、无命中/空历史返回空串", () => {
    const w = mkWorld();
    w.characters.push({ id: "c2", name: "沈夜", role: "反派", traits: [], motivation: "", status: "", introducedAt: 1 });
    expect(extractNameFromHistory(w, ["他叫林墨", "把沈夜的动机改掉"])).toBe("沈夜"); // 最近消息优先
    expect(extractNameFromHistory(w, ["完全没提角色的对话"])).toBe("");
    expect(extractNameFromHistory(w, undefined)).toBe("");
    expect(extractNameFromHistory(w, [])).toBe("");
  });

  test("foreshadow_edit add → 新增表单（required text + plantedAt）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "foreshadow_edit", {});
    expect(card?.kind).toBe("form");
    expect(card?.action.body).toEqual({ action: "add" });
    expect((card!.fields as { key: string; required?: boolean }[]).find((f) => f.key === "text")?.required).toBe(true);
  });

  test("foreshadow_edit update（带 id）→ 修改表单（select status + body 带 id）", () => {
    const w = mkWorld();
    w.foreshadowing.push({ id: "f9", text: "旧伏笔", plantedAt: 1, status: "planted" });
    const card = buildFormCard(w, "foreshadow_edit", { action: "update", id: "f9" });
    expect(card?.kind).toBe("form");
    expect(card?.action.body).toEqual({ action: "update", id: "f9" });
    expect((card!.fields as { key: string }[]).map((f) => f.key)).toContain("status");
  });

  test("foreshadow_edit delete（带 id）→ 确认删除表单（confirmRequired）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "foreshadow_edit", { action: "delete", id: "f9" });
    expect(card?.kind).toBe("form");
    expect(card?.confirmRequired).toBe(true);
    expect(card?.action.body).toEqual({ action: "delete", id: "f9" });
  });

  test("foreshadow_edit update 无 id → 提示表单（不崩）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "foreshadow_edit", { action: "update" });
    expect(card?.kind).toBe("form");
    expect(card!.fields).toEqual([]);
  });

  test("task_ops rewrite → 消费重写队列（confirmRequired，按队列非空）", () => {
    const w = mkWorld();
    w.rewriteQueue = [2, 3];
    const card = buildFormCard(w, "task_ops", { action: "rewrite" });
    expect(card?.kind).toBe("form");
    expect(card?.action.body).toEqual({ action: "start" });
    expect(card?.confirmRequired).toBe(true);
    expect(card?.summary).toContain("2");
  });

  test("task_ops 带质量债 id → 处理表单（select fix/ignore + body 带 id）", () => {
    const w = mkWorld();
    w.qualityDebt = [{ id: "d1", chapterIndex: 2, lens: "continuity", issue: "矛盾", severity: "major", status: "open" }];
    const card = buildFormCard(w, "task_ops", { id: "d1" });
    expect(card?.kind).toBe("form");
    expect(card?.action.endpoint).toBe("/api/novel/debt");
    expect(card?.action.body).toEqual({ id: "d1" });
    expect(card?.summary).toContain("continuity");
  });

  test("draft_confirm confirm/reject → 对应端点", () => {
    const w = mkWorld();
    const c = buildFormCard(w, "draft_confirm", {});
    expect(c?.action.endpoint).toBe("/api/novel/chapter/confirm");
    const r = buildFormCard(w, "draft_confirm", { action: "reject" });
    expect(r?.action.endpoint).toBe("/api/novel/chapter/reject");
  });

  test("expand_arc → 定位 skeleton 弧，无则提示", () => {
    const w = mkWorld();
    w.storyArcs = [{ id: "a1", volumeId: "v1", title: "身世之谜", goal: "g", arcType: "探索发现", status: "skeleton", estChapters: 5 }];
    const card = buildFormCard(w, "expand_arc", {});
    expect(card?.kind).toBe("form");
    expect(card?.action.body).toEqual({ action: "expand", arcId: "a1" });
    const w2 = mkWorld();
    const card2 = buildFormCard(w2, "expand_arc", {});
    expect(card2?.summary).toContain("没有可展开的弧");
  });

  test("settings → 生成参数表单（含 bool 转换字段 autoGacha）", () => {
    const w = mkWorld();
    const card = buildFormCard(w, "settings", {});
    expect(card?.kind).toBe("form");
    const fields = card!.fields as { key: string; transform?: string }[];
    expect(fields.find((f) => f.key === "gen.autoGacha")?.transform).toBe("bool");
    expect(fields.map((f) => f.key)).toContain("gen.temperature");
  });

  test("非表单意图 → null", () => {
    const w = mkWorld();
    expect(buildFormCard(w, "advance", {})).toBeNull();
    expect(buildFormCard(w, "chat", {})).toBeNull();
  });
});

describe("flattenFormValues（表单值扁平化）", () => {
  const fields = [
    { key: "setting.rules", label: "规则", type: "textarea", array: true, value: [] as string[] },
    { key: "gen.minWords", label: "最少字数", type: "number", value: 800 },
    { key: "gen.autoGacha", label: "自动抽卡", type: "select", value: "关", transform: "bool" as const },
    { key: "premise", label: "梗概", type: "textarea", value: "" },
  ];

  test("点路径嵌套 + array 按行拆分 + number/bool 转换", () => {
    const out = flattenFormValues(fields, {
      "setting.rules": "规则一\n规则二",
      "gen.minWords": "1000",
      "gen.autoGacha": "开",
      premise: "新梗概",
    });
    expect(out.setting).toEqual({ rules: ["规则一", "规则二"] });
    expect(out.gen).toEqual({ minWords: 1000, autoGacha: true });
    expect(out.premise).toBe("新梗概");
  });

  test("空值跳过 + 未修改字段不进入 body", () => {
    const out = flattenFormValues(fields, { "gen.minWords": "", premise: "" });
    expect(out.gen).toBeUndefined();
    expect(out.premise).toBe("");
  });
});

describe("brainChatStream（SSE 编排，事件协议 v2）", () => {
  test("故事不存在 → error 事件", async () => {
    mockWorld = null;
    const events = await runTurn("测试");
    expect((events[0] as Record<string, unknown>).error).toBeTruthy();
  });

  test("LLM 识别失败 → 降级 chat：intent → delta* → done", async () => {
    mockWorld = mkWorld();
    nextChatContent = "非法输出!!!"; // 识别失败降级 chat，回复走真流式
    const events = await runTurn("你好");
    expect(events[0].type).toBe("intent");
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    // 增量语义：每个 delta 是新增块（append:true），前端拼接——拼接后等于完整文本
    expect((deltas[0] as { append?: boolean }).append).toBe(true);
    expect((deltas.map((d) => d.text as string).join("")).endsWith("!!!")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  test("chat 意图 → 真流式 delta 累积 + done；消息落盘可恢复", async () => {
    mockWorld = mkWorld();
    nextChatContent = "中枢收到！";
    const events = await runTurn("你好", { sessionId: "chat-stream-session" });
    const rawDeltas = events.filter((e) => e.type === "delta");
    const deltas = rawDeltas.map((e) => e.text as string);
    expect(deltas.length).toBeGreaterThan(1);
    // 增量语义（append:true）：每个 delta 是新增块，前端拼接后等于完整回复——避免每块重传累积全文
    expect((rawDeltas[0] as { append?: boolean }).append).toBe(true);
    expect(deltas.join("")).toBe("中枢收到！");
    expect(deltas[0]).toBe("中");
    const done = events.find((e) => e.type === "done") as { messageId?: string } | undefined;
    expect(done?.messageId).toBeTruthy();
    // 会话持久化：消息已落盘（pending 清除、streaming 复位、文本完整）
    const sess = sessGet("brain-chat-test", "chat-stream-session");
    expect(sess).toBeTruthy();
    expect(sess!.streaming).toBe(false);
    expect(sessLastPending(sess!)).toBeNull();
    const lastMsg = sess!.messages[sess!.messages.length - 1];
    expect(lastMsg.role).toBe("assistant");
    expect(lastMsg.text).toBe("中枢收到！");
    expect(lastMsg.cards).toBeUndefined();
  });

  test("思考模式开：thinking:true → chatStream 收到 enabled + reasoning 事件流式 + 落盘 thinking", async () => {
    mockWorld = mkWorld();
    nextChatContent = JSON.stringify({ intent: "chat", reply: "" });
    const orig = brainChatDeps.chatStream;
    let captured: Record<string, unknown> | null = null;
    brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: Record<string, unknown>) => {
      captured = opts ?? null;
      const onReasoning = (opts?.onReasoning as ((d: string) => void) | undefined);
      if (onReasoning) for (const ch of "让我想想") onReasoning(ch);
      for (const ch of "这是回答") onChunk(ch);
      return "这是回答";
    }) as typeof brainChatDeps.chatStream;
    try {
      const events: Record<string, unknown>[] = [];
      await brainChatStream({
        title: "brain-chat-test", prompt: "你好", sessionId: "think-session", thinking: true,
        send: (o) => events.push(o as Record<string, unknown>),
      });
      // thinking 透传 enabled（关闭思维链的参数在 agnes 层转 {type:"enabled"}）
      expect(captured?.thinking).toBe("enabled");
      // reasoning 事件流式增量（append:true），拼回完整思维链
      const reasoningEvents = events.filter((e) => e.type === "reasoning");
      expect(reasoningEvents.length).toBeGreaterThan(1);
      expect(reasoningEvents.map((e) => e.text as string).join("")).toBe("让我想想");
      // 思维链落盘（刷新后可恢复展示）
      const sess = sessGet("brain-chat-test", "think-session");
      const lastMsg = sess!.messages[sess!.messages.length - 1];
      expect(lastMsg.thinking).toBe("让我想想");
      expect(lastMsg.text).toBe("这是回答");
    } finally {
      brainChatDeps.chatStream = orig;
    }
  });

  test("思考模式默认关：不传 thinking → chatStream 收到 disabled，无 reasoning 事件", async () => {
    mockWorld = mkWorld();
    nextChatContent = JSON.stringify({ intent: "chat", reply: "" });
    const orig = brainChatDeps.chatStream;
    let captured: Record<string, unknown> | null = null;
    brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: Record<string, unknown>) => {
      captured = opts ?? null;
      for (const ch of "回答") onChunk(ch);
      return "回答";
    }) as typeof brainChatDeps.chatStream;
    try {
      const events: Record<string, unknown>[] = [];
      await brainChatStream({
        title: "brain-chat-test", prompt: "你好", sessionId: "think-session-2",
        send: (o) => events.push(o as Record<string, unknown>),
      });
      expect(captured?.thinking).toBe("disabled");
      expect(events.some((e) => e.type === "reasoning")).toBe(false);
      const sess = sessGet("brain-chat-test", "think-session-2");
      expect(sess!.messages[sess!.messages.length - 1].thinking).toBeUndefined();
    } finally {
      brainChatDeps.chatStream = orig;
    }
  });

  test("意图 read_chapter → delta(reply) + card(browse) + done", async () => {
    mockWorld = mkWorld();
    nextChatContent = JSON.stringify({ intent: "read_chapter", params: { index: 1 }, reply: "为你打开第一章" });
    const events = await runTurn("读第一章");
    const delta = events.find((e) => e.type === "delta") as { text?: string } | undefined;
    expect(delta?.text).toBe("为你打开第一章");
    const card = events.find((e) => e.type === "card") as { card?: Record<string, unknown> } | undefined;
    expect(card).toBeTruthy();
    expect(card!.card!.kind).toBe("browse");
    expect(events[events.length - 1].type).toBe("done");
  });

  test("意图 read_proposals → delta + card(browse/proposal)（L0 查询直接执行）", async () => {
    mockWorld = mkWorld();
    mockWorld.characterProposals = [{ id: "cp1", name: "小翠", role: "掌柜", traits: [], motivation: "查清身世", reason: "呼应身世线", source: "writer", status: "pending" }];
    nextChatContent = JSON.stringify({ intent: "read_proposals", params: {}, reply: "当前有 1 项新角色提案" });
    const events = await runTurn("有哪些角色推荐？");
    const delta = events.find((e) => e.type === "delta") as { text?: string } | undefined;
    expect(delta?.text).toBe("当前有 1 项新角色提案");
    const card = events.find((e) => e.type === "card") as { card?: Record<string, unknown> } | undefined;
    expect(card!.card!.kind).toBe("browse");
    expect(card!.card!.browseType).toBe("proposal");
  });

  test("意图 open_proposals → 不列浏览卡，仅回复 + 发「已打开」result 卡（前端据此恢复底部提案区）", async () => {
    mockWorld = mkWorld();
    mockWorld.characterProposals = [{ id: "cp1", name: "小翠", role: "掌柜", traits: [], motivation: "查清身世", reason: "呼应身世线", source: "writer", status: "pending" }];
    nextChatContent = JSON.stringify({ intent: "open_proposals", params: {}, reply: "已为你打开新角色提案" });
    const events = await runTurn("打开新角色提案");
    const delta = events.find((e) => e.type === "delta") as { text?: string } | undefined;
    expect(delta?.text).toBe("已为你打开新角色提案");
    const cards = events.filter((e) => e.type === "card").map((e) => e.card as Record<string, unknown>);
    // 不列提案浏览卡（不会把提案内容铺进聊天列表）
    expect(cards.some((c) => c.kind === "browse" && c.browseType === "proposal")).toBe(false);
    expect(cards.length).toBe(1);
    expect(cards[0].kind).toBe("result");
    expect(cards[0].title).toBe("新角色提案");
    expect((cards[0].detail as string).includes("打开")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
  });

  test("意图 advance（L2）→ delta + card(preview/confirmRequired) + card(confirm)", async () => {
    mockWorld = mkWorld();
    nextChatContent = JSON.stringify({ intent: "advance", params: {}, reply: "好的，推进剧情" });
    const events = await runTurn("再写一章");
    const cards = events.filter((e) => e.type === "card").map((e) => e.card as Record<string, unknown>);
    expect(cards.length).toBe(2);
    expect(cards[0].kind).toBe("preview");
    expect(cards[0].confirmRequired).toBe(true);
    expect(cards[1].kind).toBe("confirm");
    expect(Array.isArray(cards[1].options)).toBe(true);
  });

  test("意图 delete_chapter（L3）→ confirm 仅 abort 选项", async () => {
    mockWorld = mkWorld();
    nextChatContent = JSON.stringify({ intent: "delete_chapter", params: { index: 1 }, reply: "删除第一章" });
    const events = await runTurn("删掉第一章");
    const confirmCard = events.filter((e) => e.type === "card").map((e) => e.card as Record<string, unknown>).find((c) => c?.kind === "confirm");
    expect(confirmCard).toBeTruthy();
    expect(confirmCard!.options).toEqual(["abort"]);
  });

  test("意图 gacha → 直接生成卡池 → card(browse/gacha) 含逐张/全部应用（聊天内抽卡闭环）", async () => {
    mockWorld = mkWorld();
    mockPool = [
      { id: "g1", type: "伏笔", rarity: "SR", title: "锈剑", description: "一把生锈的剑", effect: "在关键情节取出锈剑", dueHint: "第 8 章前后回收" },
      { id: "g2", type: "角色", rarity: "SSR", title: "哑巴师父", description: "沉默的武师", effect: "收哑巴师父为徒", character: { name: "哑巴师父", role: "武师", traits: ["寡言"], motivation: "守护传人" } },
    ];
    nextChatContent = JSON.stringify({ intent: "gacha", params: { count: 2 }, reply: "为你抽了 2 张卡" });
    const events = await runTurn("抽两张卡");
    // 不再走 preview 卡：直接出卡池浏览卡
    const card = (events.find((e) => e.type === "card") as { card?: Record<string, unknown> } | undefined)?.card;
    expect(card?.kind).toBe("browse");
    expect(card?.browseType).toBe("gacha");
    expect(String(card?.title)).toContain("2 张");
    const list = (card!.data as { list: Record<string, unknown>[] }).list;
    expect(list.length).toBe(2);
    const itemActions = list[0].actions as { label: string; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(itemActions[0].label).toBe("应用此卡");
    expect(itemActions[0].action.body).toEqual({ title: "brain-chat-test", action: "apply", pick: ["g1"] });
    const topActions = card!.actions as { label: string; action: { endpoint: string; body: Record<string, unknown> } }[];
    expect(topActions[0].action.body).toEqual({ title: "brain-chat-test", action: "apply", auto: true });
    expect(events[events.length - 1].type).toBe("done");
  });

  test("意图 plan → delta + card(plan 选项) + done", async () => {
    mockWorld = mkWorld();
    chatJsonQueue = [
      JSON.stringify({ intent: "plan", params: {}, reply: "给你三个方向" }),
      JSON.stringify({ options: [
        { label: "推进一章", description: "写下一章", intent: "advance" },
        { label: "查看现状", description: "看进度", intent: "read_chapter" },
      ] }),
    ];
    const events = await runTurn("接下来怎么写？");
    const delta = events.find((e) => e.type === "delta") as { text?: string } | undefined;
    expect(delta?.text).toBe("给你三个方向");
    const card = (events.find((e) => e.type === "card") as { card?: Record<string, unknown> } | undefined)?.card;
    expect(card?.kind).toBe("plan");
    const options = card!.options as { label: string; action?: { endpoint: string } }[];
    expect(options.length).toBe(2);
    expect(options[0].label).toBe("推进一章");
    expect(options[0].action?.endpoint).toBe("/api/novel/step");
    expect(options[1].action).toBeUndefined(); // 只读意图无 action
    expect(events[events.length - 1].type).toBe("done");
  });

  test("意图 opinion → delta + card(opinion 选项)；LLM 选项失败降级兜底", async () => {
    mockWorld = mkWorld();
    chatJsonQueue = [
      JSON.stringify({ intent: "opinion", params: {}, reply: "我觉得可以继续" }),
      "not-json", // 选项生成失败 → 兜底
    ];
    const events = await runTurn("要不要继续写？");
    const delta = events.find((e) => e.type === "delta") as { text?: string } | undefined;
    expect(delta?.text).toBe("我觉得可以继续");
    const card = (events.find((e) => e.type === "card") as { card?: Record<string, unknown> } | undefined)?.card;
    expect(card?.kind).toBe("opinion");
    const options = card!.options as { label: string }[];
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0].label).toBe("保持现状"); // 兜底选项
    expect(events[events.length - 1].type).toBe("done");
  });

  test("中途取消 → interrupted 事件，消息保留已生成文本", async () => {
    mockWorld = mkWorld();
    nextChatContent = "很长很长的回复内容";
    const ac = new AbortController();
    const events: Record<string, unknown>[] = [];
    // 首块发出后立即 abort（模拟用户点“停止生成”）
    const turn = brainChatStream({
      title: "brain-chat-test",
      prompt: "写点东西",
      sessionId: "abort-session",
      send: (o) => {
        const ev = o as Record<string, unknown>;
        events.push(ev);
        if (ev.type === "delta") ac.abort();
      },
      signal: ac.signal,
    });
    await turn;
    expect(events.some((e) => e.type === "interrupted")).toBe(true);
    // 消息标记 interrupted 且已生成文本保留（含卡片不写）
    const sess = sessGet("brain-chat-test", "abort-session")!;
    const last = sess.messages[sess.messages.length - 1];
    expect(last.interrupted).toBe(true);
    expect(last.pending).toBeFalsy();
    expect(last.text.length).toBeGreaterThan(0);
    expect(sess.streaming).toBe(false);
  });

  test("resume：复用最后一条 pending 消息，先 reset 再重新 delta", async () => {
    mockWorld = mkWorld();
    // 第一回合：中断（留下 pending 消息）
    nextChatContent = "半截回复";
    const ac1 = new AbortController();
    await brainChatStream({
      title: "brain-chat-test",
      prompt: "续写这个",
      sessionId: "resume-session",
      send: (o) => {
        if ((o as Record<string, unknown>).type === "delta") ac1.abort();
      },
      signal: ac1.signal,
    });
    // 第二回合：resume 复用同一 assistant 消息
    nextChatContent = "重新生成的完整回复";
    const events = await runTurn("续写这个", { sessionId: "resume-session", resume: true });
    const reset = events.find((e) => e.type === "reset") as { messageId?: string } | undefined;
    expect(reset?.messageId).toBeTruthy();
    const sess = sessGet("brain-chat-test", "resume-session")!;
    const last = sess.messages[sess.messages.length - 1];
    expect(last.id).toBe(reset!.messageId);
    expect(last.pending).toBeFalsy();
    // 未重复追加用户消息（消息数：1 user + 1 assistant）
    expect(sess.messages.filter((m) => m.role === "user").length).toBe(1);
    expect(sess.messages.length).toBe(2);
    expect(events[events.length - 1].type).toBe("done");
  });

  test("resume：reset 不带 thinking，重新生成后思维链不重复拼接", async () => {
    mockWorld = mkWorld();
    const orig = brainChatDeps.chatStream;
    // 第一回合：产生思维链+正文，收到 reasoning 后中断（留下 interrupted 消息）
    brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: Record<string, unknown>) => {
      (opts?.onReasoning as ((d: string) => void) | undefined)?.("旧思考");
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      for (const ch of "旧正文") onChunk(ch);
      return "旧正文";
    }) as typeof brainChatDeps.chatStream;
    const ac1 = new AbortController();
    await brainChatStream({
      title: "brain-chat-test", prompt: "续写", sessionId: "resume-think-session", thinking: true,
      send: (o) => { if ((o as Record<string, unknown>).type === "reasoning") ac1.abort(); },
      signal: ac1.signal,
    });
    // 第二回合：resume 重新生成，新流产生新思维链
    brainChatDeps.chatStream = (async (_msgs: ChatMessage[], onChunk: (d: string) => void, opts?: Record<string, unknown>) => {
      (opts?.onReasoning as ((d: string) => void) | undefined)?.("新思考");
      for (const ch of "新正文") onChunk(ch);
      return "新正文";
    }) as typeof brainChatDeps.chatStream;
    const events: Record<string, unknown>[] = [];
    await brainChatStream({
      title: "brain-chat-test", prompt: "续写", sessionId: "resume-think-session", resume: true, thinking: true,
      send: (o) => events.push(o as Record<string, unknown>),
    });
    const reset = events.find((e) => e.type === "reset") as Record<string, unknown> | undefined;
    // reset 不带 thinking（前端据此清空旧思维链，避免旧内容 + 新流 append 重复拼接）
    expect(reset?.thinking).toBeUndefined();
    // 落盘 thinking = 仅新思维链（无「旧思考」残留）
    const sess = sessGet("brain-chat-test", "resume-think-session")!;
    const last = sess.messages[sess.messages.length - 1];
    expect(last.thinking).toBe("新思考");
    expect(last.text).toBe("新正文");
    brainChatDeps.chatStream = orig;
  });
});

// —— 需求 1/2：生成插画未指定章节 → 默认选中章 + 默认 1 张；LLM 自动提取章号参数 ——

describe("chapterIndexFromPrompt（从用户输入提取章号）", () => {
  test("「第 N 章」/「第N章」/「N章」识别（阿拉伯数字）", () => {
    expect(chapterIndexFromPrompt("给第 5 章配张插画")).toBe(5);
    expect(chapterIndexFromPrompt("给第12章配图")).toBe(12);
    expect(chapterIndexFromPrompt("画第 3 回的插图")).toBe(3);
  });
  test("中文数字章号（第一/三/十二/二十/二十五章）", () => {
    expect(chapterIndexFromPrompt("给第三章配张插画")).toBe(3);
    expect(chapterIndexFromPrompt("画第一章的插图")).toBe(1);
    expect(chapterIndexFromPrompt("给第十二章配图")).toBe(12);
    expect(chapterIndexFromPrompt("第二十章的插画")).toBe(20);
    expect(chapterIndexFromPrompt("给第二十五章配图")).toBe(25);
  });
  test("无章号 → null", () => {
    expect(chapterIndexFromPrompt("生成插画")).toBeNull();
    expect(chapterIndexFromPrompt("写一章")).toBeNull();
  });
});

describe("buildMediaCard（生成插画/视频表单卡，需求 1）", () => {
  test("未指定章节 → 默认前端选中章（ctx.chapterIndex），张数默认 1", () => {
    const w = mkWorld();
    w.chapters.push({ index: 2, title: "第二章", text: "……", review: null });
    const card = buildMediaCard(w, "media_image", {}, "生成插画", { chapterIndex: 2 });
    expect(card.kind).toBe("form");
    const idxField = card.fields.find((f) => f.key === "chapterIndex")!;
    expect(idxField.value).toBe(2); // 默认选中章
    const countField = card.fields.find((f) => f.key === "count")!;
    expect(countField.value).toBe(1); // 默认 1 张
    expect(card.action.endpoint).toBe("/api/novel/media/plan");
    expect(card.action.body.kind).toBe("image");
  });

  test("prompt 正则「第 N 章」优先于选中章；不存在的章号回退到选中章", () => {
    const w = mkWorld();
    w.chapters.push({ index: 2, title: "第二章", text: "……", review: null });
    // prompt 指定第 2 章（存在）→ 2 优先于选中章 1
    const card = buildMediaCard(w, "media_image", {}, "给第二章配张插画", { chapterIndex: 1 });
    expect(card.fields.find((f) => f.key === "chapterIndex")!.value).toBe(2);
    // prompt 指定第 9 章（不存在）→ 回退选中章 2
    const card2 = buildMediaCard(w, "media_image", {}, "给第九章配张插画", { chapterIndex: 2 });
    expect(card2.fields.find((f) => f.key === "chapterIndex")!.value).toBe(2);
  });

  test("无章号且无选中章 → 默认最后一章，count 取 params.count", () => {
    const w = mkWorld();
    w.chapters.push({ index: 2, title: "第二章", text: "……", review: null });
    const card = buildMediaCard(w, "media_image", { count: 3 }, "生成插画", undefined);
    const idxField = card.fields.find((f) => f.key === "chapterIndex")!;
    expect(idxField.value).toBe(2); // 最后一章
    const countField = card.fields.find((f) => f.key === "count")!;
    expect(countField.value).toBe(3);
  });

  test("LLM 提取的 params.chapterIndex 优先于 prompt 正则", () => {
    const w = mkWorld();
    const card = buildMediaCard(w, "media_image", { chapterIndex: 1 }, "给第三章配张插画", undefined);
    const idxField = card.fields.find((f) => f.key === "chapterIndex")!;
    expect(idxField.value).toBe(1);
  });

  test("media_video → 恒 1 段，无 count 字段", () => {
    const w = mkWorld();
    const card = buildMediaCard(w, "media_video", {}, "给第一章生成视频", undefined);
    expect(card.action.body.kind).toBe("video");
    expect(card.fields.find((f) => f.key === "count")).toBeUndefined();
    const idxField = card.fields.find((f) => f.key === "chapterIndex")!;
    expect(idxField.value).toBe(1);
  });

  test("无章节的世界 → 不崩（chapters 空，value 取 lastIdx=null）", () => {
    const w = emptyWorld();
    const card = buildMediaCard(w, "media_image", {}, "生成插画", undefined);
    expect(card.kind).toBe("form");
  });
});
describe("buildMediaCard 张数下拉（按章节剩余额度生成 options）", () => {
  test("count 为 select，options 按默认章节剩余额度（上限 3 扣已有）", () => {
    const w = mkWorld();
    w.chapters.push({ index: 2, title: "第二章", text: "……", review: null });
    const card = buildMediaCard(w, "media_image", {}, "生成插画", { chapterIndex: 2 });
    const countField = card.fields.find((f) => f.key === "count")!;
    expect(countField.type).toBe("select");
    expect(countField.options?.length).toBe(3);
    expect(countField.options?.[0]).toEqual({ label: "1 张", value: "1" });
    expect(countField.value).toBe(1);
  });

  test("已有插画扣减剩余额度：2 张已有 → 仅 1 张可生成", () => {
    const w = mkWorld();
    (w.chapters[0] as { media?: unknown[] }).media = [
      { id: "m1", kind: "image", anchor: "a", prompt: "p", caption: "c", status: "ready", path: "images/m1.jpg" },
      { id: "m2", kind: "image", anchor: "b", prompt: "p", caption: "c", status: "pending", path: "" },
    ];
    const card = buildMediaCard(w, "media_image", {}, "给第一章配张插画", { chapterIndex: 1 });
    const countField = card.fields.find((f) => f.key === "count")!;
    expect(countField.type).toBe("select");
    expect(countField.options?.length).toBe(1);
    expect(countField.options?.[0]?.value).toBe("1");
    expect(countField.value).toBe(1);
  });

  test("已有 3 张（已满）→ options 仅「已满」占位，value 0", () => {
    const w = mkWorld();
    (w.chapters[0] as { media?: unknown[] }).media = [
      { id: "m1", kind: "image", anchor: "a", prompt: "p", status: "ready", path: "x" },
      { id: "m2", kind: "image", anchor: "b", prompt: "p", status: "ready", path: "x" },
      { id: "m3", kind: "image", anchor: "c", prompt: "p", status: "ready", path: "x" },
    ];
    const card = buildMediaCard(w, "media_image", {}, "给第一章配张插画", { chapterIndex: 1 });
    const countField = card.fields.find((f) => f.key === "count")!;
    expect(countField.value).toBe(0);
    expect(countField.options?.[0]?.label).toContain("已满");
  });
});



// —— 回复文本与追问引导（聊天体验关键：空话检测 / 角色查询侧重 / 含糊章节追问） ——

describe("isHollowReply：空话开场检测（仅「这就为您调出」式短句判空）", () => {
  test("空话短语 → true", () => {
    expect(isHollowReply("这就为您调出")).toBe(true);
    expect(isHollowReply("这就为您调取第三章")).toBe(true);
    expect(isHollowReply("为您展示该角色")).toBe(true);
  });

  test("实质回复（含要点或长度 > 30）→ false", () => {
    expect(isHollowReply("「林墨」当前状态：负伤，正随商队北行。")).toBe(false);
    expect(isHollowReply("这章写得不错，节奏比上一章紧凑。")).toBe(false);
    expect(isHollowReply("这就为您调出第三章的全部正文内容以及它的审查意见和相关角色出场情况的详细列表。")).toBe(false); // >30 字的长句即使含「调出」也不算空话
    expect(isHollowReply("")).toBe(false);
    expect(isHollowReply(null)).toBe(false);
  });
});

describe("l0QueryReply：查询开场文本（read_chapter 模板 / read_character 按问法侧重）", () => {
  test("read_chapter + browse 卡 → 模板说明已调取 + 字数", () => {
    const r = l0QueryReply("read_chapter", { kind: "browse", title: "第3章 · 风云", data: { index: 3, title: "风云", text: "一二三四五" } }, "看第三章", null);
    expect(r).toContain("第 3 章「风云」已为你调取");
    expect(r).toContain("约 5 字");
  });

  test("read_character + 状态问法 → 当前状态；形象问法 → 形象；关系问法 → 关系", () => {
    const card = { kind: "browse", title: "林墨 · 主角", data: { name: "林墨", role: "主角", status: "负伤", look: "玄色长衫", relations: [{ name: "沈夜", relation: "仇人" }] } };
    expect(l0QueryReply("read_character", card, "林墨现在什么状态", null)).toContain("当前状态：负伤");
    expect(l0QueryReply("read_character", card, "林墨长什么样", null)).toContain("的形象：玄色长衫");
    expect(l0QueryReply("read_character", card, "林墨和谁有仇", null)).toContain("人物关系");
    expect(l0QueryReply("read_character", card, "林墨是谁", null)).toContain("主角");
  });

  test("LLM 实质回复（非空话）优先保留；空话回退卡片标题", () => {
    const card = { kind: "browse", title: "伏笔账本（3 条）", data: { list: [] } };
    const good = l0QueryReply("read_foreshadow", card, "看看伏笔", "目前有 3 条伏笔，其中 1 条活跃。");
    expect(good).toBe("目前有 3 条伏笔，其中 1 条活跃。");
    const hollow = l0QueryReply("read_foreshadow", card, "看看伏笔", "这就为您调出伏笔");
    expect(hollow).toBe("伏笔账本（3 条）");
  });
});

describe("isAmbiguousChapterPrompt：仅提章节号无动作词 → 追问（不直接输出正文）", () => {
  test("纯章节号 → true（追问意图）", () => {
    expect(isAmbiguousChapterPrompt("第三章")).toBe(true);
    expect(isAmbiguousChapterPrompt("第 5 章")).toBe(true);
  });

  test("带查看/生成/评价等动作词 → false（明确意图）", () => {
    expect(isAmbiguousChapterPrompt("查看第三章")).toBe(false);
    expect(isAmbiguousChapterPrompt("给第二章生成插画")).toBe(false);
    expect(isAmbiguousChapterPrompt("第三章写得怎么样")).toBe(false);
    expect(isAmbiguousChapterPrompt("讲讲第一章的剧情")).toBe(false);
  });

  test("无章节提及 → false", () => {
    expect(isAmbiguousChapterPrompt("接下来怎么写")).toBe(false);
    expect(isAmbiguousChapterPrompt("")).toBe(false);
  });
});

describe("chapterAskCard：含糊章节的追问卡（看正文/插画/聊聊，revise 加审查）", () => {
  test("合法章 → 4 选项（含聊聊）；revise 章追加审查选项", () => {
    const w = emptyWorld();
    w.chapters.push({ index: 1, title: "风云起", text: "正文", review: { verdict: "revise", round: 2, scores: { coherence: 7, tension: 6, prose: 8, pacing: 7, dialogue: 7 }, findings: [] } } as never);
    const card = chapterAskCard(w, { index: 1 });
    expect(card?.kind).toBe("ask");
    expect(card?.options.map((o) => o.label)).toContain("查看第 1 章正文");
    expect(card?.options.map((o) => o.label)).toContain("为第 1 章生成插画");
    expect(card?.options.map((o) => o.label)).toContain("查看第 1 章审查报告"); // revise 章才有
    expect(card?.options.map((o) => o.label)).toContain("只是聊聊");
  });

  test("index 非法 / 缺失 → null（调用方走原逻辑）", () => {
    expect(chapterAskCard(emptyWorld(), {})).toBeNull();
    expect(chapterAskCard(emptyWorld(), { index: 0 })).toBeNull();
    expect(chapterAskCard(emptyWorld(), { index: "abc" })).toBeNull();
  });
});
