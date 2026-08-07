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
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-media-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
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

describe("P5 角色媒体自动生成", () => {
  test("generateCharacterPortrait：prompt 含性别/外貌/时代服饰/禁帽子，文件落盘", async () => {
    const { generateCharacterPortrait } = await import("../src/api/media");
    const { saveWorld } = await import("../src/api/storage");
    const { world } = await makeChar();
    saveWorld(world);

    genPrompts = [];
    const p = await generateCharacterPortrait(world.title, world, world.characters[0]);
    // prompt 内容验证（生成式媒体硬约束）
    expect(p.prompt).toContain("性别 女");
    expect(p.prompt).toContain("柳青霜");
    expect(p.prompt).toContain("二十出头");
    expect(p.prompt).toContain("女捕快");
    expect(p.prompt).toContain("清冷");
    expect(p.prompt).toContain("明朝");
    expect(p.prompt).toContain("不戴任何帽子");
    // 文件真实落盘
    expect(existsSync(join(imgBase(world.title), p.path))).toBe(true);
    // 返回结构
    expect(p.mediaId).toBeTruthy();
    expect(p.looks).toContain("清冷");
  });

  test("generateCharacterAvatar：有立绘时 i2i 参考图生图（prompt 含保持容貌前缀），头像落盘", async () => {
    const { generateCharacterPortrait, generateCharacterAvatar, mediaDataUri } = await import("../src/api/media");
    const { saveWorld } = await import("../src/api/storage");
    const { world } = await makeChar();
    saveWorld(world);
    genPrompts = [];
    const portrait = await generateCharacterPortrait(world.title, world, world.characters[0]);
    const ref = mediaDataUri(world.title, { id: portrait.mediaId, kind: "image", anchor: "柳青霜", path: portrait.path, status: "ready" });
    const avatar = await generateCharacterAvatar(world.title, world, world.characters[0], { refImage: ref });
    expect(avatar.path).toContain("images/avatar-");
    expect(existsSync(join(imgBase(world.title), avatar.path))).toBe(true);
    // 头像 prompt 含方形头像与性别
    expect(avatar.prompt).toContain("方形头像");
    expect(avatar.prompt).toContain("性别 女");
  });

  test("proposal 确认入册：角色入册（当前设计：媒体手动生成）；随后手动生成立绘+头像可落盘", async () => {
    const { handleApi } = await import("../src/api/routes");
    const { generateCharacterPortrait, generateCharacterAvatar } = await import("../src/api/media");
    const { saveWorld, loadWorld } = await import("../src/api/storage");
    const { emptyWorld } = await import("../src/api/world");
    const w = emptyWorld();
    w.title = "提案媒体书";
    w.setting = { time: "架空", place: "边城", rules: [], tone: "" };
    w.characters.push({ id: "c1", name: "主角", role: "主角", traits: [], motivation: "", status: "", relations: {}, introducedAt: 0 });
    w.characterProposals = [{ id: "cp1", name: "新角色乙", role: "配角", gender: "男", age: "三十", identity: "镖师", traits: ["沉稳"], motivation: "护送", source: "gacha", status: "pending" }];
    saveWorld(w);

    failImage = false;
    const res = await handleApi("/api/novel/proposal", new Request("http://localhost/api/novel/proposal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: w.title, proposalId: "cp1", action: "confirm" }),
    }));
    const data = (await res!.json()) as { ok?: boolean; world?: import("../src/api/world").WorldState };
    expect(data.ok).toBe(true);
    const after = loadWorld(w.title)!;
    const nc = after.characters.find((c) => c.name === "新角色乙");
    expect(nc).toBeDefined();
    expect(nc?.gender).toBe("男");
    // 当前设计：确认入册不自动生成媒体（视觉手动生成），字段为空
    expect(nc?.image).toBeFalsy();
    expect(nc?.portrait?.path).toBeFalsy();

    // 手动生成路径：立绘 → 头像（以立绘为参考图），落盘后可读
    const portrait = await generateCharacterPortrait(w.title, after, nc!);
    nc!.portrait = portrait;
    const avatar = await generateCharacterAvatar(w.title, after, nc!, { refImage: undefined });
    nc!.image = avatar.path;
    saveWorld(after);
    const saved = loadWorld(w.title)!.characters.find((c) => c.name === "新角色乙")!;
    expect(saved.portrait?.path).toBeTruthy();
    expect(saved.image).toBeTruthy();
    expect(existsSync(join(imgBase(w.title), saved.image!))).toBe(true);
    expect(existsSync(join(imgBase(w.title), saved.portrait!.path))).toBe(true);
  });

  test("生成失败：不阻塞角色入册（媒体字段保持空，可稍后手动补）", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: w.title, proposalId: "cp1", action: "confirm" }),
    }));
    failImage = false;
    const data = (await res!.json()) as { ok?: boolean; world?: import("../src/api/world").WorldState };
    expect(data.ok).toBe(true); // 入册不阻塞
    const nc = loadWorld(w.title)!.characters.find((c) => c.name === "失败角色");
    expect(nc).toBeDefined();
    expect(nc?.image).toBeFalsy();
    expect(nc?.portrait?.path).toBeFalsy();
  });
});
