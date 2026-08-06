// 移除角色清理媒体文件：bun test tests/remove-character-media.test.ts
// 覆盖：editWorld removeCharacterIds 同步删盘被移除角色的立绘/头像文件；
// 已登场角色禁止移除（文件与角色均保留）；其他角色文件不受影响
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWorld, type WorldState } from "../src/api/world";
import { editWorld } from "../src/api/director";
import { saveImage } from "../src/api/images";
import { storyDir } from "../src/api/storage";

// 隔离 data/：切到临时目录，避免污染真实存档
let tmp: string;
let oldCwd: string;
beforeAll(() => {
  oldCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ai-novel-rmchar-"));
  process.chdir(tmp);
});
afterAll(() => {
  process.chdir(oldCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function mkWorld(): WorldState {
  const w = emptyWorld();
  w.title = "rm-char-media";
  w.characters.push({
    id: "c1", name: "沈夜", role: "主角", traits: [], motivation: "", status: "",
    relations: {}, introducedAt: 1,
    portrait: { mediaId: "m1", path: "images/portrait-1.jpg", prompt: "p", looks: "l" },
    image: "images/avatar-1.jpg",
  });
  w.characters.push({
    id: "c2", name: "柳青霜", role: "配角", traits: [], motivation: "", status: "",
    relations: {}, introducedAt: 1,
    portrait: { mediaId: "m2", path: "images/portrait-2.jpg", prompt: "p", looks: "l" },
    image: "images/avatar-2.jpg",
  });
  return w;
}

function imgDir(title: string): string {
  return join(storyDir(title), "images");
}

describe("移除角色清理媒体文件", () => {
  test("移除未登场角色：其立绘/头像文件从本地真实删除，其他角色文件保留", () => {
    const w = mkWorld();
    saveImage(w.title, "portrait-1.jpg", new Uint8Array([1, 2, 3]));
    saveImage(w.title, "avatar-1.jpg", new Uint8Array([4, 5, 6]));
    saveImage(w.title, "portrait-2.jpg", new Uint8Array([7, 8, 9]));
    saveImage(w.title, "avatar-2.jpg", new Uint8Array([10, 11, 12]));
    const dir = imgDir(w.title);
    expect(existsSync(join(dir, "portrait-1.jpg"))).toBe(true);
    expect(existsSync(join(dir, "avatar-1.jpg"))).toBe(true);

    editWorld(w, { removeCharacterIds: ["c1"] });

    // c1 立绘/头像已删
    expect(existsSync(join(dir, "portrait-1.jpg"))).toBe(false);
    expect(existsSync(join(dir, "avatar-1.jpg"))).toBe(false);
    // c2 文件保留
    expect(existsSync(join(dir, "portrait-2.jpg"))).toBe(true);
    expect(existsSync(join(dir, "avatar-2.jpg"))).toBe(true);
    // 角色已移除
    expect(w.characters.find((c) => c.id === "c1")).toBeUndefined();
    expect(w.characters.length).toBe(1);
  });

  test("已登场角色禁止移除：抛错且文件、角色均保留", () => {
    const w = mkWorld();
    saveImage(w.title, "portrait-1.jpg", new Uint8Array([1]));
    saveImage(w.title, "avatar-1.jpg", new Uint8Array([2]));
    w.characters[0].appearedIn = [1]; // 已登场 -> 禁止移除
    const dir = imgDir(w.title);

    expect(() => editWorld(w, { removeCharacterIds: ["c1"] })).toThrow();

    expect(existsSync(join(dir, "portrait-1.jpg"))).toBe(true);
    expect(existsSync(join(dir, "avatar-1.jpg"))).toBe(true);
    expect(w.characters.find((c) => c.id === "c1")).toBeDefined();
  });
});
