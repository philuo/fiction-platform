// 持久化：data/<slug>/state.json（写前备份 .bak）
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { WorldState } from "./world";

export function slugify(title: string): string {
  const s = title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
  // 排除 "." / ".." 等路径逃逸（安全审查 LOW：slugify 结果不得使路径回退到项目根）
  if (!s || s === "." || s === ".." || /^\.+$/.test(s)) return "story";
  return s;
}

export function storyDir(title: string): string {
  // process.cwd()：bun 直接运行与 bun build 产物下均指向项目根
  return join(process.cwd(), "data", slugify(title));
}

export function saveWorld(w: WorldState): string {
  const dir = storyDir(w.title);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  if (existsSync(path)) copyFileSync(path, join(dir, "state.json.bak"));
  w.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(w, null, 2), "utf-8");
  return path;
}

export function loadWorld(title: string): WorldState | null {
  const path = join(storyDir(title), "state.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as WorldState;
}

export function listStories(): string[] {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) return [];
  return readdir(dir);
}

export type StoryMeta = { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string };

/** 列出所有故事的元信息（用于小说列表页） */
export function listStoriesMeta(): StoryMeta[] {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) return [];
  const slugs = readdir(dir);
  const metas: StoryMeta[] = [];
  for (const s of slugs) {
    try {
      const raw = readFileSync(join(dir, s, "state.json"), "utf-8");
      const w = JSON.parse(raw) as WorldState;
      metas.push({ slug: s, title: w.title, genre: w.genre ?? "", chapters: w.chapters?.length ?? 0, updatedAt: w.updatedAt ?? "", cover: w.cover });
    } catch {
      // 损坏的 state.json 跳过
      metas.push({ slug: s, title: s, genre: "", chapters: 0, updatedAt: "", cover: undefined });
    }
  }
  // 按更新时间倒序
  metas.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return metas;
}

function readdir(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(dir).filter((d) => d !== ".DS_Store");
}

export function exportMarkdown(w: WorldState): string {
  const lines: string[] = [`# 《${w.title}》`, "", `> ${w.genre} · ${w.setting.time} / ${w.setting.place} · ${w.setting.tone}`, ""];
  for (const ch of w.chapters) {
    lines.push(`## 第${ch.index}章 ${ch.title}`, "", ch.text, "");
  }
  return lines.join("\n");
}

// —— EPUB 导出（Bun.zipSync 原生 zip，含 content.opf / toc.ncx / xhtml 章节） ——
function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function exportEpub(w: WorldState): Blob {
  const chapters = w.chapters.map((c, i) => {
    const body =
      `<h2>第${c.index}节 ${escXml(c.title)}</h2>\n` +
      c.text
        .split(/\n{2,}/)
        .map((p) => `<p>${escXml(p.trim())}</p>`)
        .join("\n");
    return {
      index: c.index,
      title: c.title,
      name: `chapter${i + 1}.xhtml`,
      html: `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escXml(c.title)}</title></head><body>${body}</body></html>`,
    };
  });
  const uuid = `urn:uuid:${crypto.randomUUID?.() ?? "ai-novel-export"}`;
  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>${escXml(w.title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>AI 小说引擎</dc:creator>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${chapters.map((c, i) => `<item id="ch${i + 1}" href="${c.name}" media-type="application/xhtml+xml"/>`).join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join("\n    ")}
  </spine>
</package>`;
  const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uuid}"/></head>
  <docTitle><text>${escXml(w.title)}</text></docTitle>
  <navMap>
    ${chapters.map((c, i) => `<navPoint id="nav${i + 1}" playOrder="${i + 1}"><navLabel><text>第${c.index}节 ${escXml(c.title)}</text></navLabel><content src="${c.name}"/></navPoint>`).join("\n    ")}
  </navMap>
</ncx>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

  const entries: Record<string, string> = {
    "META-INF/container.xml": container,
    "OEBPS/content.opf": contentOpf,
    "OEBPS/toc.ncx": tocNcx,
  };
  for (const c of chapters) entries[`OEBPS/${c.name}`] = c.html;

  // EPUB = zip：mimetype 必须无压缩（stored）且为首文件；用系统 zip 生成
  const dir = mkdtempSync(join(tmpdir(), "ai-novel-epub-"));
  try {
    writeFileSync(join(dir, "mimetype"), "application/epub+zip", "utf-8");
    for (const [rel, content] of Object.entries(entries)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
    const epubPath = join(dir, "book.epub");
    const r1 = spawnSync("zip", ["-0", "-X", "book.epub", "mimetype"], { cwd: dir, encoding: "utf-8" });
    if (r1.status !== 0) throw new Error("zip mimetype 失败: " + r1.stderr);
    const r2 = spawnSync("zip", ["-r", "-X", "book.epub", "META-INF", "OEBPS"], { cwd: dir, encoding: "utf-8" });
    if (r2.status !== 0) throw new Error("zip 打包失败: " + r2.stderr);
    return new Blob([readFileSync(epubPath)], { type: "application/epub+zip" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
