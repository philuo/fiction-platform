// 整书评估（P4，修 D4）：WebNovelBench 式 8 维 LLM-as-Judge
// 输入 = 蓝图 + 全部章摘要 + 均匀抽样 3 章全文；输出每维 1-10 + 举证 + Top3 修复建议
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatJson, clampScore } from "./jsonutil";
import { storyDir } from "./storage";
import { isPendingForeshadow, type Foreshadow, type WorldState } from "./world";
import { EVAL_DIMENSIONS, type EvalDimensionResult, type EvalReport } from "../contracts/evaluation";

export { EVAL_DIMENSIONS } from "../contracts/evaluation";
export type { EvalDimensionResult, EvalReport } from "../contracts/evaluation";

/** 伏笔状态标注（评估提示词用）：待埋设=预登记尚未写入正文，避免 LLM 误判已埋设章节 */
function foreshadowLabel(f: Foreshadow): string {
  return f.status === "planted" ? "已埋设待回收" : "推进中未兑现";
}

const EVAL_SYSTEM = `你是资深网文主编。对一部连载中的小说做整体质量评估。
评估 8 个维度（各 1-10 分）：剧情逻辑 / 人物塑造 / 节奏张力 / 文笔风格 / 爽点钩子 / 伏笔管理 / 设定一致 / 主题立意。
要求：
- 每维给出分数与一句话举证（引用章节摘要或正文片段）
- 评分务实：有明显问题给低分，不谄媚
- 伏笔以提供的账本为准：「待埋设」为预登记、尚未写入任何章节正文，不得据此声称某伏笔已在某章埋设；评估「伏笔管理」时只考察已埋设/推进中的伏笔的分布与回收节奏
- 最后给出 3 条最有价值的改进建议（针对当前连载状态，可执行）
输出必须是合法 JSON（不要 markdown 围栏）：
{"dimensions":[{"name":"剧情逻辑","score":7,"evidence":"…"}],"suggestions":["…","…","…"]}
字符串值内部一律使用中文引号「」/『』，禁止英文双引号。`;

/** 均匀抽样 3 章全文（首/中/最新），控制评估输入体积 */
function sampleChapters(w: WorldState): string[] {
  const chs = w.chapters;
  if (chs.length <= 3) return chs.map((c) => `第${c.index}章《${c.title}》：\n${c.text.slice(0, 1200)}`);
  const idxs = [0, Math.floor(chs.length / 2), chs.length - 1];
  return idxs.map((i) => `第${chs[i].index}章《${chs[i].title}》：\n${chs[i].text.slice(0, 1200)}`);
}

export async function evaluateBook(w: WorldState, range?: [number, number]): Promise<EvalReport> {
  let summaries = w.chapterSummaries ?? [];
  if (range) summaries = summaries.filter((s) => s.index >= range[0] && s.index <= range[1]);

  const userMsg = [
    `书名《${w.title}》（${w.genre}），已写 ${w.chapters.length} 章。`,
    w.blueprint ? `[蓝图] 主题：${w.blueprint.theme}｜主线：${w.blueprint.mainPlot.slice(0, 200)}｜指南针：${w.blueprint.compass}` : "",
    `[章节摘要]\n${summaries.slice(-30).map((s) => `第${s.index}章：${s.summary.slice(0, 150)}`).join("\n") || "（无摘要）"}`,
    `[伏笔账本（以此为准，未注明状态者按字面理解）]\n${w.foreshadowing
      .filter((f) => f.status !== "resolved")
      .map((f) => {
        const state = isPendingForeshadow(w, f) ? `待埋设：计划埋设于第${f.plantedAt}章，尚未写入正文` : `${foreshadowLabel(f)}，埋于第${f.plantedAt}章`;
        return `- ${f.text.slice(0, 40)}（${state}）`;
      })
      .join("\n") || "（无）"}`,
    `[质量债务] ${(w.qualityDebt ?? []).filter((d) => d.status === "open").slice(-10).map((d) => `第${d.chapterIndex}章[${d.lens}]${d.issue.slice(0, 40)}`).join("；") || "（无）"}`,
    `[抽样正文]\n${sampleChapters(w).join("\n\n")}`,
    "\n请输出 8 维评估（只输出 JSON）。",
  ].filter(Boolean).join("\n");

  const out = await chatJson<{ dimensions?: { name?: string; score?: unknown; evidence?: string }[]; suggestions?: string[] }>(
    [
      { role: "system", content: EVAL_SYSTEM },
      { role: "user", content: userMsg },
    ],
    {
      temperature: 0.3,
      maxTokens: 60000,
      schema: {
        type: "object",
        required: ["dimensions"],
        properties: {
          dimensions: { type: "array", items: { type: "object", required: ["name", "score"], properties: { name: { type: "string" }, score: { type: "integer" }, evidence: { type: "string" } } } },
          suggestions: { type: "array", items: { type: "string" } },
        },
      },
    },
  );

  const dims: EvalDimensionResult[] = [];
  for (const name of EVAL_DIMENSIONS) {
    const found = (Array.isArray(out.dimensions) ? out.dimensions : []).find((d) => d?.name === name);
    dims.push({
      name,
      score: found ? clampScore(found.score) : 5,
      evidence: String(found?.evidence ?? "").slice(0, 120),
    });
  }
  const overall = Math.round((dims.reduce((n, d) => n + d.score, 0) / dims.length) * 10) / 10;

  return {
    at: new Date().toISOString(),
    chaptersEvaluated: w.chapters.length,
    dimensions: dims,
    overall,
    suggestions: (Array.isArray(out.suggestions) ? out.suggestions : []).map(String).filter(Boolean).slice(0, 3),
  };
}

// —— 结果缓存：章节/摘要/伏笔/债务等评估输入未变化时直接复用，避免重复烧 LLM 额度 ——

/** djb2 字符串哈希（非加密用途，仅作内容指纹） */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** 评估输入指纹：覆盖 evaluateBook 实际用到的全部内容（抽样正文/摘要/伏笔/债务/蓝图） */
export function evalFingerprint(w: WorldState, range?: [number, number]): string {
  let summaries = w.chapterSummaries ?? [];
  if (range) summaries = summaries.filter((s) => s.index >= range[0] && s.index <= range[1]);
  const payload = JSON.stringify([
    range ?? null,
    w.genre,
    w.blueprint ? [w.blueprint.theme, w.blueprint.mainPlot.slice(0, 200), w.blueprint.compass] : null,
    summaries.slice(-30).map((s) => [s.index, s.summary.slice(0, 150)]),
    w.foreshadowing.filter((f) => f.status !== "resolved").map((f) => [f.text.slice(0, 40), f.status, f.plantedAt]),
    (w.qualityDebt ?? []).filter((d) => d.status === "open").slice(-10).map((d) => [d.chapterIndex, d.lens, d.issue.slice(0, 40)]),
    sampleChapters(w),
  ]);
  return `${w.chapters.length}:${djb2(payload)}`;
}

// —— 评估记录落盘：data/<slug>/eval.json（指纹 + 报告），刷新/重启不丢；重新评估覆盖旧记录 ——

type EvalCacheFile = { fingerprint: string; report: EvalReport };

function evalCachePath(title: string): string {
  return join(storyDir(title), "eval.json");
}

function readEvalCache(title: string): EvalCacheFile | null {
  try {
    const p = evalCachePath(title);
    if (!existsSync(p)) return null;
    const d = JSON.parse(readFileSync(p, "utf-8")) as EvalCacheFile;
    return d && typeof d.fingerprint === "string" && d.report ? d : null;
  } catch {
    return null; // 缓存损坏降级为重新评估
  }
}

/** 读取落盘的评估报告（无缓存返回 null；不校验指纹，调用方按需判断新鲜度）。
 * 供中枢状态派生（brain-state）零成本复用已落盘 eval，避免重复烧 LLM。 */
export function readEvalReport(title: string): EvalReport | null {
  return readEvalCache(title)?.report ?? null;
}

function writeEvalCache(title: string, fingerprint: string, report: EvalReport): void {
  try {
    const dir = storyDir(title);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `eval.json.tmp-${process.pid}`); // 原子写（与 state.json 同策略）
    writeFileSync(tmp, JSON.stringify({ fingerprint, report }, null, 2), "utf-8");
    renameSync(tmp, evalCachePath(title));
  } catch {
    /* 缓存写失败不阻塞评估主流程 */
  }
}

/** 带持久化缓存的整书评估：内容指纹未变直接返回落盘结果（cached=true）；force 强制重新调用 LLM 并覆盖记录 */
export async function evaluateBookCached(w: WorldState, range?: [number, number], force?: boolean): Promise<{ report: EvalReport; cached: boolean }> {
  const fp = evalFingerprint(w, range);
  if (!force) {
    const disk = readEvalCache(w.title);
    if (disk && disk.fingerprint === fp) return { report: disk.report, cached: true };
  }
  const report = await evaluateBook(w, range);
  writeEvalCache(w.title, fp, report); // 重新评估后替换旧数据
  return { report, cached: false };
}
