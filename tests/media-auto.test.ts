// P5 角色/头像/立绘自动生成验证：mock 图像层（generateImage/compressToJpeg/saveImage 等），
// 验证 generateCharacterPortrait/Avatar prompt 内容与落盘、proposal 确认同步生成、失败不阻塞入册、
// newStory 后台 fire-and-forget 生成。
import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync as rmFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// —— mock 图像层：必须在 import 任何 src/api 模块之前 ——
let failImage = false;
let genPrompts: string[] = []; // 记录 generateImage 收到的 prompt（验证内容）
const slug = (t: string) => {
  const s = t.trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
  return !s || s === "." || s === ".." || /^\.+$/.test(s) ? "story" : s;
};
const imgBase = (title: string) => join(process.cwd(), "data", slug(title));

mock.module("../src/api/images", () => ({
  // 保持真实实现（unit.test 会直接断言该函数；mock 为进程级共享，不能破坏）
  toAgnesSize: (size: string) => {
    const [w, h] = size.split("x").map(Number);
    const width = Number.isInteger(w) && w > 0 ? w : 768;
    const height = Number.isInteger(h) && h > 0 ? h : 768;
    const landscape = width >= height;
    const r = Math.max(width, height) / Math.min(width, height);
    let ratio = "1:1";
    if (r >= 1.7) ratio = landscape ? "16:9" : "9:16";
    else if (r >= 1.25) ratio = landscape ? "3:2" : "2:3";
    else if (r > 1.1) ratio = landscape ? "4:3" : "3:4";
    return { size: "1K", ratio };
  },
  generateImageAgnes: async () => {
    if (failImage) throw new Error("模拟图像生成失败");
    genPrompts.push("agnes");
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  },
  generateImage: async (prompt: string) => {
    if (failImage) throw new Error("模拟图像生成失败");
    genPrompts.push(prompt);
    return new Uint8Array(64).fill(1);
  },
  compressToJpeg: async (buf: Uint8Array) => buf,
  saveImage: (title: string, name: string, data: Uint8Array) => {
    const dir = join(imgBase(title), "images");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), data);
    return `images/${name}`;
  },
  readImage: (title: string, rel: string) => {
    try {
      const full = join(imgBase(title), rel);
      if (!statSync(full).isFile()) return null;
      return new Uint8Array(readFileSync(full));
    } catch { return null; }
  },
  deleteMediaFile: (title: string, rel: string) => {
    try {
      const full = join(imgBase(title), rel);
      if (statSync(full).isFile()) { rmFileSync(full); return true; }
    } catch { /* 忽略 */ }
    return false;
  },
}));

let tmp: string;
let oldCwd: string;
const TEST_USER = "mediatest";
let authCookie = "";
let runAsUser: <T>(username: string | null, fn: () => T) => T;

beforeAll(async () => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-media-"));
  process.chdir(tmp);
  process.env.APP_DB_PATH = join(tmp, "app-test.db");
  // 账号隔离后 novel API 需登录：占位首用户（消耗「首个注册用户认领旧数据」）+ 测试用户
  const { handleApi } = await import("../src/api/routes");
  const { runAsUser: rau } = await import("../src/api/storage");
  runAsUser = rau;
  await handleApi("/api/auth/register", new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "dummyfirst", password: "secret123" }),
  }));
  await handleApi("/api/auth/register", new Request("http://x/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_USER, password: "secret123" }),
  }));
  const login = await handleApi("/api/auth/login", new Request("http://x/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: TEST_USER, password: "secret123" }),
  }));
  authCookie = login!.headers.get("Set-Cookie")!.split(";")[0];
});
afterAll(() => {
  process.chdir(oldCwd);
  delete process.env.APP_DB_PATH;
  // 视觉巡检会经 listUsernames 初始化 db（临时库）：先关闭释放句柄再删目录（Windows 文件锁）
  const { getDb } = require("../src/api/db") as typeof import("../src/api/db");
  try {
    getDb().close();
  } catch {
    /* 未初始化则忽略 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function makeChar(): Promise<{ world: import("../src/api/world").WorldState; cid: string }> {
  const { emptyWorld } = await import("../src/api/world");
  const w = emptyWorld();
  w.title = "媒体验证书";
  w.setting = { time: "明朝", place: "京城", rules: [], tone: "冷峻" };
  const cid = "c1";
  w.characters.push({
    id: cid, name: "柳青霜", role: "主角", gender: "女", age: "二十出头", identity: "女捕快",
    traits: ["清冷", "机警"], motivation: "查案", status: "登场", relations: {}, introducedAt: 0,
  });
  return { world: w, cid };
}

/** 给角色造一个假头像文件并落到 world.characters[0].image（立绘必须参考头像，先备好头像） */
async function makeAvatar(world: import("../src/api/world").WorldState): Promise<string> {
  const { generateCharacterAvatar } = await import("../src/api/media");
  const avatar = await generateCharacterAvatar(world.title, world, world.characters[0]);
  world.characters[0].image = avatar.path;
  return avatar.path;
}

/** 轮询等待角色视觉自动生成完成（fire-and-forget 任务收尾），返回最终世界状态 */
async function waitVisual(title: string, cid: string, timeoutMs = 5000): Promise<import("../src/api/world").WorldState> {
  const { loadWorld } = await import("../src/api/storage");
  const t0 = Date.now();
  for (;;) {
    const w = loadWorld(title);
    const c = w?.characters.find((x) => x.id === cid);
    if (w && c?.portrait?.path && c.image) return w;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待角色视觉自动生成超时: ${title} ${cid}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("P5 角色媒体自动生成", () => {
  test("旧 state/visual-status HTTP 接口已移除，系统状态只走 sync WS", async () => {
    const { handleApi } = await import("../src/api/routes");
    for (const pathname of ["/api/novel/state", "/api/novel/visual/status"]) {
      const res = await handleApi(pathname, new Request(`http://localhost${pathname}`, {
        method: "POST", headers: { "Content-Type": "application/json", cookie: authCookie }, body: JSON.stringify({ title: "任意书" }),
      }));
      expect(res?.status).toBe(404);
      expect(((await res!.json()) as { error?: string }).error).toContain("未知 API");
    }
  });
  test("generateCharacterPortrait：立绘必须参考头像（无头像抛错；默认短改变 prompt 保参考图原样，改词回退全量描述，文件落盘）", async () => {
    const { generateCharacterPortrait } = await import("../src/api/media");
    const { saveWorld } = await import("../src/api/storage");
    const { world } = await makeChar();
    // 立绘必须参考头像：无头像 → 抛错（不降级纯文生）
    await expect(generateCharacterPortrait(world.title, world, world.characters[0])).rejects.toThrow("还没有头像");
    // 备好头像后立绘正常生成
    await makeAvatar(world);
    saveWorld(world);

    genPrompts = [];
    const p = await generateCharacterPortrait(world.title, world, world.characters[0]);
    // 默认短改变 prompt（弱模型 i2i 保持参考图的关键）：同一人 + 性别一致 + 保容貌发型服饰 + 竖版全身正面 + 禁帽子
    expect(p.prompt).toContain("柳青霜");
    expect(p.prompt).toContain("与参考头像完全同一人");
    expect(p.prompt).toContain("性别与参考头像一致");
    expect(p.prompt).toContain("容貌、发型、服饰全部保持参考图原样");
    expect(p.prompt).toContain("不戴帽"); // 差异化头饰子句（headwearOf）
    expect(p.prompt).toContain("面向观者");
    expect(p.prompt).not.toContain("或略侧身");
    // 短 prompt 不再重述性别/年龄/身份/时代服饰（头像已承载，重述会干扰弱模型保持参考图）
    expect(p.prompt).not.toContain("性别 女");
    expect(p.prompt).not.toContain("容貌必须严格照此刻画");
    // 用户改词重生成：回退全量描述，尊重用户描述
    const p2 = await generateCharacterPortrait(world.title, world, world.characters[0], { description: "白发红眼，左眼有疤" });
    expect(p2.prompt).toContain("白发红眼");
    expect(p2.prompt).toContain("性别 女");
    expect(p2.prompt).not.toContain("容貌必须严格照此刻画");
    // 文件真实落盘
    expect(existsSync(join(imgBase(world.title), p.path))).toBe(true);
    // 返回结构
    expect(p.mediaId).toBeTruthy();
    expect(p.looks).toContain("清冷");
  });

  test("可选槽位：pose/expression 透传进立绘 prompt，expression 透传进头像 prompt（VISUAL-VOCAB 达标后开放）", async () => {
    const { generateCharacterPortrait, generateCharacterAvatar } = await import("../src/api/media");
    const { world } = await makeChar();
    await makeAvatar(world);
    const p = await generateCharacterPortrait(world.title, world, world.characters[0], { pose: "手持长剑", expression: "冷峻" });
    expect(p.prompt).toContain("手持长剑");
    expect(p.prompt).toContain("表情冷峻");
    const a = await generateCharacterAvatar(world.title, world, world.characters[0], { expression: "微笑" });
    expect(a.prompt).toContain("表情微笑");
    // 默认不传：生产行为不变（无姿态/表情槽词）
    const p0 = await generateCharacterPortrait(world.title, world, world.characters[0]);
    expect(p0.prompt).not.toContain("手持长剑");
    expect(p0.prompt).not.toContain("表情");
  });

  test("generateCharacterAvatar：纯文生（仅角色自身字段属性），不参考任何图像，头像落盘", async () => {
    const { generateCharacterAvatar } = await import("../src/api/media");
    const { saveWorld } = await import("../src/api/storage");
    const { world } = await makeChar();
    saveWorld(world);
    genPrompts = [];
    const avatar = await generateCharacterAvatar(world.title, world, world.characters[0]);
    expect(avatar.path).toContain("images/avatar-");
    expect(existsSync(join(imgBase(world.title), avatar.path))).toBe(true);
    // 头像 prompt 含方形头像与性别（角色自身字段）
    expect(avatar.prompt).toContain("方形头像");
    expect(avatar.prompt).toContain("性别 女");
    // 区分度修复：确定性容貌标识（同名复现一致，重生成不变脸）
    expect(avatar.prompt).toContain("容貌必须严格照此刻画");
    // 性别强化（弱模型修复）：具体性别词前置并重复强化，防画出异性
    expect(avatar.prompt).toContain("年轻女子");
    expect(avatar.prompt).toContain("严禁画成异性");
    expect(avatar.prompt).toContain("五官柔和"); // 性别面部特征强化（实测修复女相/男相错画）
    expect(avatar.prompt).toContain("不戴帽"); // 差异化头饰子句（headwearOf）
    expect(avatar.prompt.startsWith("年轻女子，")).toBe(true);
    // 渠道单一：纯文生——无 i2i 保持前缀（不参考立绘/任何图像）
    expect(avatar.prompt).not.toContain("容貌基准");
    expect(genPrompts.length).toBe(1); // 只调了一次 generateImage（无参考图分支）
  });

  test("proposal 确认入册：角色入册后自动生成立绘+头像（fire-and-forget），操作日志留痕 CMD-M07/M08", async () => {
    await runAsUser(TEST_USER, async () => {
    const { handleApi } = await import("../src/api/routes");
    const { saveWorld, loadWorld } = await import("../src/api/storage");
    const { emptyWorld } = await import("../src/api/world");
    const w = emptyWorld();
    w.title = "提案媒体书";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "" };
    w.characters.push({ id: "c1", name: "主角", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0,
      portrait: { mediaId: "m1", kind: "image", anchor: "主角", path: "images/portrait-c1.jpg", status: "ready" }, image: "images/avatar-c1.jpg" }); // 已有完整视觉，读时自愈不触发
    w.characterProposals = [{ id: "cp1", name: "新角色乙", role: "配角", gender: "男", age: "三十", identity: "镖师", traits: ["沉稳"], motivation: "护送", source: "gacha", status: "pending" }];
    saveWorld(w);

    failImage = false;
    const res = await handleApi("/api/novel/proposal", new Request("http://localhost/api/novel/proposal", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: authCookie },
      body: JSON.stringify({ title: w.title, proposalId: "cp1", action: "confirm" }),
    }));
    const data = (await res!.json()) as { ok?: boolean; world?: import("../src/api/world").WorldState };
    expect(data.ok).toBe(true);
    const after = loadWorld(w.title)!;
    const nc = after.characters.find((c) => c.name === "新角色乙");
    expect(nc).toBeDefined();
    expect(nc?.gender).toBe("男");

    // 等待后台自动生成完成：头像 + 立绘（立绘以头像为参考图）落盘
    const finished = await waitVisual(w.title, nc!.id);
    const done = finished.characters.find((c) => c.id === nc!.id)!;
    expect(done.portrait?.path).toBeTruthy();
    expect(done.image).toBeTruthy();
    expect(existsSync(join(imgBase(w.title), done.image!))).toBe(true);
    expect(existsSync(join(imgBase(w.title), done.portrait!.path))).toBe(true);
    expect(done.visualTriedAt).toBeGreaterThan(0);
    // 操作日志留痕（actor=system 的自动指令）
    const autoLogs = finished.changeLog.filter((e) => ["portrait-auto", "avatar-auto"].includes(e.kind) && e.actor === "system");
    expect(autoLogs.some((e) => e.kind === "portrait-auto" && e.detail.includes("新角色乙"))).toBe(true);
    expect(autoLogs.some((e) => e.kind === "avatar-auto" && e.detail.includes("新角色乙"))).toBe(true);

    // 幂等：视觉已完整，再次 sync 订阅自愈不再触发自动生成
    const { getSystemSyncSnapshot } = await import("../src/api/routes");
    const st2 = getSystemSyncSnapshot(w.title, true)!;
    expect(st2.visual.running).toBe(false);
    });
  });

  test("生成失败：不阻塞角色入册，操作日志留痕 visual-fail（失败可见，可稍后手动补）", async () => {
    await runAsUser(TEST_USER, async () => {
    const { handleApi } = await import("../src/api/routes");
    const { saveWorld, loadWorld } = await import("../src/api/storage");
    const { emptyWorld } = await import("../src/api/world");
    const w = emptyWorld();
    w.title = "失败媒体书";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "" };
    w.characters.push({ id: "c1", name: "主角", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
    w.characterProposals = [{ id: "cp1", name: "失败角色", role: "配角", gender: "女", age: "", identity: "", traits: [], motivation: "", source: "writer", status: "pending" }];
    saveWorld(w);

    failImage = true; // 图像生成全部失败（模拟图像服务不可用）
    const res = await handleApi("/api/novel/proposal", new Request("http://localhost/api/novel/proposal", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: authCookie },
      body: JSON.stringify({ title: w.title, proposalId: "cp1", action: "confirm" }),
    }));
    const data = (await res!.json()) as { ok?: boolean; world?: import("../src/api/world").WorldState };
    expect(data.ok).toBe(true); // 入册不阻塞
    // 等待后台任务失败收尾（visual-fail 日志落盘）后再恢复图像层，避免 fire-and-forget 时序竞态
    const { loadWorld: lw } = await import("../src/api/storage");
    const t0 = Date.now();
    for (;;) {
      const ww = lw(w.title);
      if (ww?.changeLog.some((e) => e.kind === "visual-fail" && e.detail.includes("失败角色"))) break;
      if (Date.now() - t0 > 5000) throw new Error("等待视觉失败收尾超时");
      await new Promise((r) => setTimeout(r, 50));
    }
    failImage = false;
    const after = loadWorld(w.title)!;
    const nc2 = after.characters.find((c) => c.name === "失败角色")!;
    expect(nc2).toBeDefined();
    expect(nc2.image).toBeFalsy();
    expect(nc2.portrait?.path).toBeFalsy();
    expect(nc2.visualTriedAt).toBeGreaterThan(0); // 已尝试标记（防反复烧配额）
    // 失败写操作日志（而非静默）：失败可见
    expect(after.changeLog.some((e) => e.kind === "visual-fail" && e.actor === "system" && e.detail.includes("失败角色"))).toBe(true);
    // 状态链路：sync 快照携带 failed + reason（前端据此提示失败，而非假成功）
    const { getSystemSyncSnapshot } = await import("../src/api/routes");
    const failedEntry = getSystemSyncSnapshot(w.title)!.visual.failed.find((f) => f.name === "失败角色");
    expect(failedEntry).toBeDefined();
    expect(failedEntry?.reason).toContain("模拟图像生成失败");
    });
  });

  test("读时自愈：打开已有故事，视觉缺失且未尝试（或过冷却期）的角色自动补立绘+头像", async () => {
    await runAsUser(TEST_USER, async () => {
    const { handleApi } = await import("../src/api/routes");
    const { saveWorld, loadWorld } = await import("../src/api/storage");
    const { emptyWorld } = await import("../src/api/world");
    const w = emptyWorld();
    w.title = "自愈书";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "" };
    w.characters.push(
      { id: "c1", name: "主角", role: "主角", traits: ["清冷"], motivation: "", status: "", relations: {}, introducedAt: 0 },
      { id: "c2", name: "配角甲", role: "配角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 }, // 视觉缺失
    );
    saveWorld(w);

    failImage = false;
    const { getSystemSyncSnapshot } = await import("../src/api/routes");
    const st = getSystemSyncSnapshot(w.title, true)!;
    expect(st.visual.running).toBe(true); // 订阅触发后台补视觉

    const finished = await waitVisual(w.title, "c2");
    const c2 = finished.characters.find((c) => c.id === "c2")!;
    expect(c2.portrait?.path).toBeTruthy();
    expect(c2.image).toBeTruthy();
    expect(finished.changeLog.some((e) => e.kind === "portrait-auto" && e.actor === "system" && e.detail.includes("配角甲"))).toBe(true);

    // 幂等：视觉已完整 → 再次打开不触发
    const st2 = getSystemSyncSnapshot(w.title, true)!;
    expect(st2.visual.running).toBe(false);
    });
  });

  test("中枢巡检 sweepVisualGaps：扫描所有故事，视觉缺失角色自动补头像+立绘；冷却期内不重复触发", async () => {
    const { sweepVisualGaps } = await import("../src/api/routes");
    const { saveWorld, loadWorld } = await import("../src/api/storage");
    const { emptyWorld } = await import("../src/api/world");
    const w = emptyWorld();
    w.title = "巡检书";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "" };
    // c1 视觉完全缺失（未尝试过）→ 巡检应触发；c2 刚失败过（visualTriedAt 新鲜，1 分钟冷却内）→ 巡检应跳过
    w.characters.push(
      { id: "c1", name: "巡检主角", role: "主角", traits: ["沉稳"], motivation: "", status: "", relations: {}, introducedAt: 0 },
      { id: "c2", name: "冷却配角", role: "配角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0, visualTriedAt: Date.now() },
    );
    saveWorld(w);

    failImage = false;
    sweepVisualGaps(); // 中枢巡检：服务启动每 60s 调一次（此处直接单次调用）

    // c1：视觉缺失且未尝试 → 自动补全头像+立绘
    const finished = await waitVisual(w.title, "c1");
    const c1 = finished.characters.find((c) => c.id === "c1")!;
    expect(c1.portrait?.path).toBeTruthy();
    expect(c1.image).toBeTruthy();
    expect(finished.changeLog.some((e) => e.kind === "avatar-auto" && e.actor === "system" && e.detail.includes("巡检主角"))).toBe(true);
    expect(finished.changeLog.some((e) => e.kind === "portrait-auto" && e.actor === "system" && e.detail.includes("巡检主角"))).toBe(true);
    // c2：冷却期内（visualTriedAt 新鲜）→ 巡检不触发，视觉保持缺失
    const c2 = finished.characters.find((c) => c.id === "c2")!;
    expect(c2.image).toBeFalsy();
    expect(c2.portrait?.path).toBeFalsy();
    // 冷却期内再次巡检仍不触发（幂等 + 冷却双重保护）
    sweepVisualGaps();
    await new Promise((r) => setTimeout(r, 100));
    const after2 = loadWorld(w.title)!;
    const c2b = after2.characters.find((c) => c.id === "c2")!;
    expect(c2b.image).toBeFalsy();
  });
});
