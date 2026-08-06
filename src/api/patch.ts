// 定向修补（P2，修 D3）：按 findings 的 evidence 定位段落，只重写命中段落；
// 命中段落占比 >50% 时返回 patched=false，由管线回退整章重生成。
import { chat } from "./agnes";
import { normAnchor } from "./media";
import { genOf, type Chapter, type WorldState } from "./world";

/** 审查结果的最小结构依赖（CriticVerdict / ReviewResult 均可传入） */
export type PatchInput = {
  findings: { severity: "major" | "minor"; issue: string; evidence: string; suggestion: string }[];
};

const PATCH_SYSTEM = `你是小说修订师。给定一章正文中需要修改的段落与审查意见，只重写这些段落。
要求：
- 保持与上下文一致的视角、时态、语气与人物声线
- 严格回应审查意见，不引入新剧情（除非意见要求）
- 输出格式：每个段落以【段落N】开头（N 与输入编号一致），其后为重写后的完整段落（空行分隔不加序号）
- 不要输出任何解释、JSON 或 markdown`;

export type PatchResult = { text: string; patched: boolean; patchedParagraphs: number };

/** evidence 归一化子串匹配定位段落索引（复用 media.ts 的 normAnchor） */
export function locateParagraphs(chapterText: string, evidences: string[]): Set<number> {
  const paras = chapterText.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const hit = new Set<number>();
  for (const ev of evidences) {
    const nev = normAnchor(ev);
    if (nev.length < 4) continue;
    for (let i = 0; i < paras.length; i++) {
      if (normAnchor(paras[i]).includes(nev)) {
        hit.add(i);
        break;
      }
    }
  }
  return hit;
}

/** 定向修补：只重写命中段落；命中占比>50% 时放弃（回退整章重写） */
export async function patchChapter(w: WorldState, ch: Chapter, review: PatchInput): Promise<PatchResult> {
  const paras = ch.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const majors = review.findings.filter((f) => f.severity === "major" && f.evidence?.trim());
  const hit = locateParagraphs(ch.text, majors.map((f) => f.evidence));

  if (!hit.size || !paras.length) return { text: ch.text, patched: false, patchedParagraphs: 0 };
  if (hit.size / paras.length > 0.5) return { text: ch.text, patched: false, patchedParagraphs: 0 };

  const targets = [...hit].sort((a, b) => a - b);
  const input = targets
    .map((i) => {
      const notes = majors.filter((f) => normAnchor(ch.text).includes(normAnchor(f.evidence)) && locateParagraphs(ch.text, [f.evidence]).has(i));
      return `【段落${i + 1}】\n${paras[i]}\n[审查意见] ${notes.map((n) => `${n.issue}（建议：${n.suggestion}）`).join("；") || "按意见修正"}`;
    })
    .join("\n\n");

  const g = genOf(w, ch.index);
  let raw = "";
  try {
    raw = await chat(
      [
        { role: "system", content: PATCH_SYSTEM },
        { role: "user", content: `全文背景（只读）：\n${ch.text.slice(0, 3000)}\n\n请重写以下段落：\n${input}` },
      ],
      { temperature: Math.min(g.temperature, 1.0), maxTokens: 60000 },
    );
  } catch {
    return { text: ch.text, patched: false, patchedParagraphs: 0 };
  }

  // 解析【段落N】块
  const blocks = raw.split(/【段落(\d+)】/);
  // blocks = ["", "1", "内容", "2", "内容", ...]
  const rewritten = new Map<number, string>();
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const idx = Number(blocks[i]);
    const content = blocks[i + 1].trim();
    if (Number.isInteger(idx) && idx >= 1 && idx <= paras.length && content) rewritten.set(idx - 1, content);
  }
  if (!rewritten.size) return { text: ch.text, patched: false, patchedParagraphs: 0 };

  const next = paras.map((p, i) => rewritten.get(i) ?? p);
  return { text: next.join("\n\n"), patched: true, patchedParagraphs: rewritten.size };
}
