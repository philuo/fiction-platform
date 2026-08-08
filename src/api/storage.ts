// 持久化：data/<username>/<slug>/state.json（原子写：tmp + rename，写前备份 .bak）
// 账号隔离：每个用户一个目录（data/<username>/），目录内全部小说、会话记录、媒体完全隔离；
// 用户来自请求会话（AsyncLocalStorage 注入，见 runAsUser/currentUser）；无用户上下文时回退
// data/<slug>（遗留/未迁移数据与测试直调兼容）。
// 长篇架构：versions 外置到 data/<username>/<slug>/versions/；meta.json 供列表页快读；checkpoint.jsonl 断点日志
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, mkdtempSync, rmSync, renameSync, appendFileSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Arc, ChapterVersion, PendingChapter, WorldState } from "./world";
import type { EvalReport } from "./eval";

export function slugify(title: string): string {
  const s = title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
  // 排除 "." / ".." 等路径逃逸（安全审查 LOW：slugify 结果不得使路径回退到项目根）
  if (!s || s === "." || s === ".." || /^\.+$/.test(s)) return "story";
  return s;
}

// —— 用户上下文（请求级隔离）：API / SSR 入口用 runAsUser 注入当前登录用户名，
// 后续同步/异步调用（含 fire-and-forget 的后台任务链）经 AsyncLocalStorage 继承该上下文。
const userCtx = new AsyncLocalStorage<string | null>();

/** 当前请求的用户名（无用户上下文返回 null——遗留数据路径或测试直调） */
export function currentUser(): string | null {
  return userCtx.getStore() ?? null;
}

/** 在指定用户名上下文中执行 fn（API/SSR 入口与后台任务遍历用户时使用） */
export function runAsUser<T>(username: string | null, fn: () => T): T {
  return userCtx.run(username, fn);
}

/** 用户数据根目录：data/<username>（用户名经 auth 正则约束，无路径危险字符） */
export function userDir(username: string): string {
  return join(process.cwd(), "data", username);
}

/** 当前上下文对应的数据目录：登录用户 → data/<username>；无上下文 → data（遗留） */
function dataDirFor(username?: string): string {
  const u = username ?? currentUser();
  return u ? userDir(u) : join(process.cwd(), "data");
}

export function storyDir(title: string, username?: string): string {
  // process.cwd()：bun 直接运行与 bun build 产物下均指向项目根
  return join(dataDirFor(username), slugify(title));
}

/** 是否为书目录：目录且含 meta.json 或 state.json（app.db / 会话记录等非书条目一律不算书） */
function isStoryDirectory(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(dir, "meta.json")) || existsSync(join(dir, "state.json"));
}

/** 把 data/ 根下的遗留书目录迁移到指定用户目录（第一个注册用户认领旧数据）。
 * 只迁移书目录（含 meta.json/state.json）；目标已存在同名目录则跳过（不覆盖）。返回迁移的书目数。 */
export function migrateLegacyStoriesTo(username: string): number {
  const root = join(process.cwd(), "data");
  if (!existsSync(root)) return 0;
  let moved = 0;
  for (const d of readdir(root)) {
    const src = join(root, d);
    if (!isStoryDirectory(src)) continue;
    const dest = join(root, username, d);
    if (existsSync(dest)) continue; // 目标已存在：不覆盖
    try {
      mkdirSync(join(root, username), { recursive: true });
      renameSync(src, dest);
      moved++;
      console.log(`[storage] 旧数据迁移：${d} → ${username}/${d}`);
    } catch (e) {
      console.warn("[storage] 旧数据迁移跳过:", d, (e as Error).message);
    }
  }
  return moved;
}

/** 同名冲突检测：已存在同 slug 的存档则返回 true（修 G1：立项同名书不得静默覆盖） */
export function storyExists(title: string): boolean {
  return existsSync(join(storyDir(title), "state.json"));
}

/** 为新立项分配不冲突的书名：已存在则追加 -2 / -3 …（修 G1） */
export function allocateTitle(title: string): string {
  const base = title.trim();
  if (!storyExists(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!storyExists(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 存档迁移（旧字段兼容）：arcs→plotThreads（补稳定 id）；返回是否有变更 */
export function migrateWorld(w: WorldState): boolean {
  let changed = false;
  const legacy = w as WorldState & { arcs?: Arc[] };
  if (Array.isArray(legacy.arcs) && !w.plotThreads) {
    w.plotThreads = legacy.arcs.map((a, i) => (a.id ? a : { ...a, id: `pt${i + 1}` }));
    delete legacy.arcs;
    changed = true;
  }
  return changed;
}

// —— versions 外置（修 G2：state.json 不膨胀）：落盘时写文件，加载时 hydrate ——
function versionsDir(title: string): string {
  return join(storyDir(title), "versions");
}

function versionFileName(chIndex: number, v: ChapterVersion, i: number): string {
  const ts = (v.at || "").replace(/[^0-9T]/g, "").slice(0, 19) || `v${i}`;
  return `ch${chIndex}-${i}-${ts}.json`;
}

/** 落盘前把内存中的 versions 写入 versions/ 目录（幂等：已存在的文件不重写），返回外置文件名数组 */
function externalizeVersions(title: string, chIndex: number, versions: ChapterVersion[], existing: string[]): string[] {
  if (!versions.length) return [];
  const dir = versionsDir(title);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  versions.forEach((v, i) => {
    const name = existing[i] ?? versionFileName(chIndex, v, i);
    const full = join(dir, name);
    if (!existsSync(full)) {
      writeFileSync(full, JSON.stringify(v), "utf-8");
    }
    files.push(name);
  });
  return files;
}

/** 加载后把 versionFiles hydrate 回 chapter.versions（前端契约不变） */
function hydrateVersions(w: WorldState): void {
  for (const ch of w.chapters) {
    if (ch.versions?.length || !ch.versionFiles?.length) continue;
    const dir = versionsDir(w.title);
    const vs: ChapterVersion[] = [];
    for (const f of ch.versionFiles) {
      try {
        vs.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as ChapterVersion);
      } catch {
        /* 版本文件损坏跳过 */
      }
    }
    if (vs.length) ch.versions = vs;
  }
}

/** 存量清理：移除章节版本表中的重复条目（title/text/review 全等；内容重复时保留 at 较新者）。
 * 纯内存操作（幂等，零磁盘写）：重建 versionFiles 与新索引对齐；磁盘孤儿文件由 saveWorld 的
 * pruneVersionFiles 收敛——保证只读路径（changelog/state 等）绝不触发删文件/重写。 */
function dedupeVersions(w: WorldState): boolean {
  let changed = false;
  for (const ch of w.chapters) {
    const vs = ch.versions ?? [];
    if (vs.length < 2) continue;
    const kept: ChapterVersion[] = [];
    const seenIdx = new Map<string, number>(); // 内容键 → kept 索引
    let chChanged = false;
    for (const v of vs) {
      const key = JSON.stringify([v.title, v.text, v.review ?? null]);
      const idx = seenIdx.get(key);
      if (idx !== undefined) {
        // 内容重复：保留时间点较新的条目（内容相同，元数据跟随后者，时间线不倒退）
        if ((v.at ?? "") > (kept[idx].at ?? "")) kept[idx] = v;
        chChanged = true;
        continue;
      }
      seenIdx.set(key, kept.length);
      kept.push(v);
    }
    if (!chChanged) continue;
    ch.versions = kept;
    ch.versionFiles = kept.map((v, i) => versionFileName(ch.index, v, i));
    changed = true;
  }
  return changed;
}

/** 清理 versions/ 目录中不再被任何章节引用的孤儿版本文件（去重/删章后收敛磁盘）。
 * 单进程假设：仅由 saveWorld 在 state.json 落盘后调用；失败静默（孤儿残留无害，下次再清）。 */
function pruneVersionFiles(title: string, referenced: Set<string>): void {
  const dir = versionsDir(title);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return; // 目录不存在（无版本）直接跳过
  }
  for (const f of files) {
    if (referenced.has(f)) continue;
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* 权限失败等：孤儿残留，下次 saveWorld 再清理 */
    }
  }
}

export function saveWorld(w: WorldState): string {
  const dir = storyDir(w.title);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.json");
  if (existsSync(path)) copyFileSync(path, join(dir, "state.json.bak"));
  w.updatedAt = new Date().toISOString();
  // versions 外置：序列化副本中用 versionFiles 替换 versions
  const snapshot = {
    ...w,
    chapters: w.chapters.map((c) => {
      if (!c.versions?.length) return c;
      const files = externalizeVersions(w.title, c.index, c.versions, c.versionFiles ?? []);
      const { versions: _v, ...rest } = c;
      return { ...rest, versionFiles: files };
    }),
  };
  // 原子写：tmp + rename（修 G3：写一半崩溃不损坏存档）
  const tmp = join(dir, `state.json.tmp-${process.pid}`);
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf-8");
  renameSync(tmp, path);
  // 孤儿版本文件收敛：state.json 已落盘，删除不再被引用的版本文件（去重/删章后的磁盘清理）
  pruneVersionFiles(
    w.title,
    new Set(snapshot.chapters.flatMap((c) => c.versionFiles ?? [])),
  );
  // meta.json：列表页快读（修 G4）
  try {
    const meta = { slug: slugify(w.title), title: w.title, genre: w.genre ?? "", chapters: w.chapters?.length ?? 0, updatedAt: w.updatedAt, cover: w.cover };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta), "utf-8");
  } catch {
    /* meta 写失败不影响主存档 */
  }
  return path;
}

/** Step 级断点日志（追加 jsonl；autorun 断点恢复与调试用） */
export function appendCheckpoint(title: string, step: string, chapter: number): void {
  try {
    const dir = storyDir(title);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "checkpoint.jsonl"), `${JSON.stringify({ step, chapter, at: new Date().toISOString() })}\n`, "utf-8");
  } catch {
    /* checkpoint 失败不阻塞主流程 */
  }
}

/** 读取最后一条断点记录（autorun 启动时对齐进度/审计用）；不存在或损坏返回 null */
export function readLastCheckpoint(title: string): { step: string; chapter: number; at: string } | null {
  try {
    const p = join(storyDir(title), "checkpoint.jsonl");
    if (!existsSync(p)) return null;
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]) as { step?: unknown; chapter?: unknown; at?: unknown };
    return {
      step: String(last.step ?? ""),
      chapter: Number(last.chapter),
      at: String(last.at ?? ""),
    };
  } catch {
    return null;
  }
}

export function loadWorld(title: string): WorldState | null {
  const path = join(storyDir(title), "state.json");
  if (!existsSync(path)) return null;
  const w = JSON.parse(readFileSync(path, "utf-8")) as WorldState;
  migrateWorld(w);
  hydrateVersions(w);
  dedupeVersions(w); // 存量版本表去重（纯内存，幂等；磁盘孤儿文件由下次 saveWorld 收敛）
  return w;
}

// —— 连载暂存区（git 工作区语义）：审查不通过的草稿落盘，供重试/跳过 ——

function pendingPath(title: string): string {
  return join(storyDir(title), "pending-chapter.json");
}

export function savePendingChapter(title: string, p: PendingChapter): void {
  try {
    const dir = storyDir(title);
    mkdirSync(dir, { recursive: true });
    writeFileSync(pendingPath(title), JSON.stringify(p, null, 2), "utf-8");
  } catch (e) {
    console.warn("[storage] 暂存区草稿写入失败:", (e as Error).message);
  }
}

export function loadPendingChapter(title: string): PendingChapter | null {
  try {
    const p = pendingPath(title);
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf-8")) as PendingChapter;
    return d.chapterIndex && d.text ? d : null;
  } catch {
    return null;
  }
}

export function clearPendingChapter(title: string): void {
  try {
    const p = pendingPath(title);
    if (existsSync(p)) rmSync(p, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

// —— 连载会话状态（刷新/服务重启恢复用） ——

export type AutoSession = {
  status: "running" | "paused" | "stopped" | "done";
  target: number; // 目标章数（绝对目标）
  written: number; // 已提交章数
  phase: string; // 最近阶段文字（写作/审查/结算/重试中）
  pauseReason?: string; // 暂停原因（如：第 N 章审查未通过）
  failedChapter?: number;
  failedFindings?: { severity: string; lens: string; issue: string; evidence: string; suggestion: string }[];
  lastEval?: EvalReport | null;
  startedAt: string;
  updatedAt: string;
};

function sessionPath(title: string): string {
  return join(storyDir(title), "autorun-session.json");
}

export function saveAutoSession(title: string, s: AutoSession): void {
  try {
    const dir = storyDir(title);
    mkdirSync(dir, { recursive: true });
    writeFileSync(sessionPath(title), JSON.stringify(s, null, 2), "utf-8");
  } catch (e) {
    console.warn("[storage] 会话状态写入失败:", (e as Error).message);
  }
}

export function loadAutoSession(title: string): AutoSession | null {
  try {
    const p = sessionPath(title);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as AutoSession;
  } catch {
    return null;
  }
}

export function clearAutoSession(title: string): void {
  try {
    const p = sessionPath(title);
    if (existsSync(p)) rmSync(p, { force: true });
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export function listStories(username?: string): string[] {
  const dir = dataDirFor(username);
  if (!existsSync(dir)) return [];
  return readdir(dir).filter((d) => isStoryDirectory(join(dir, d)));
}

export type StoryMeta = { slug: string; title: string; genre: string; chapters: number; updatedAt: string; cover?: string };

/** 列出当前用户所有故事的元信息（优先读 meta.json，缺失时回退解析 state.json）。
 * 只认书目录（含 meta.json/state.json）：app.db / 会话记录等非书条目不会出现在列表中。 */
export function listStoriesMeta(username?: string): StoryMeta[] {
  const dir = dataDirFor(username);
  if (!existsSync(dir)) return [];
  const slugs = readdir(dir);
  const metas: StoryMeta[] = [];
  for (const s of slugs) {
    const storyPath = join(dir, s);
    if (!isStoryDirectory(storyPath)) continue; // 非书目录/文件（sqlite、会话记录等）跳过
    try {
      const metaPath = join(storyPath, "meta.json");
      if (existsSync(metaPath)) {
        metas.push(JSON.parse(readFileSync(metaPath, "utf-8")) as StoryMeta);
        continue;
      }
      const raw = readFileSync(join(storyPath, "state.json"), "utf-8");
      const w = JSON.parse(raw) as WorldState;
      metas.push({ slug: s, title: w.title, genre: w.genre ?? "", chapters: w.chapters?.length ?? 0, updatedAt: w.updatedAt ?? "", cover: w.cover });
    } catch {
      // 损坏的存档跳过（不把非书目录当书）
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
  // 卷映射（P5）：本章计划 index → 弧 → 卷标题，卷切换处插入卷题
  const volOf = new Map<number, string>();
  if (w.blueprint && (w.chapterPlans ?? []).length) {
    const arcVol = new Map((w.storyArcs ?? []).map((a) => [a.id, a.volumeId]));
    const volTitle = new Map((w.blueprint.volumes ?? []).map((v) => [v.id, v.title]));
    for (const p of w.chapterPlans ?? []) {
      const t = volTitle.get(arcVol.get(p.arcId) ?? "");
      if (t) volOf.set(p.index, t);
    }
  }
  let curVol = "";
  const chapters = w.chapters.map((c, i) => {
    const vol = volOf.get(c.index);
    const volHead = vol && vol !== curVol ? `<h1>${escXml(vol)}</h1>\n` : "";
    if (vol) curVol = vol;
    const body =
      volHead +
      `<h2>第${c.index}章 ${escXml(c.title)}</h2>\n` +
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
    <dc:creator>墨枢</dc:creator>
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
    ${chapters.map((c, i) => `<navPoint id="nav${i + 1}" playOrder="${i + 1}"><navLabel><text>第${c.index}章 ${escXml(c.title)}</text></navLabel><content src="${c.name}"/></navPoint>`).join("\n    ")}
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
