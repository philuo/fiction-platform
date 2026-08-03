// 中央正文栏（报纸排版）+ 审查引用红色波浪线标记 + 段落锚定媒体（插画/视频）
import { Fragment } from "react";
import { PenLine } from "../components/icons";
import type { Chapter, ChapterMedia, ReviewResult } from "../api/world";
import { Stamp } from "./Stamp";

/** 归一化：去掉空白字符与「」『』引用标记（AI 审查引用常自带标记，正文渲染时可能不同） */
const norm = (s: string) => s.replace(/[\s「」『』]/g, "");

/** 将 evidence 按标点切分为片段（用于 AI 拼接乱序引用的部分匹配） */
function splitEvidenceFragments(ev: string): string[] {
  return ev
    .split(/[「」『』,，。！？；：、\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 4);
}

/**
 * 将章节文本中审查引用的原文标记红色波浪线（仅在审查模式下渲染；只读模式正文保持纯净）。
 * 匹配策略：
 * 1. 归一化全文匹配（忽略空白差异，如「凶手 是」vs「凶手是」、跨段换行）；
 * 2. 完整匹配失败时，回退到 evidence 片段匹配（AI 可能将正文多处拼接成一条引用），
 *    高亮正文中真实存在的所有片段。
 */
function renderWithCitations(
  text: string,
  review: ReviewResult | null,
  reviewMode: boolean,
  activeFindingIdx: number | null,
  onMarkClick?: (findingIdx: number) => void,
): React.ReactNode[] {
  // 只读模式：不渲染任何波浪线/高亮标记
  if (!reviewMode || !review || !review.findings.length) return [text];
  // evidence → 引用了它的 finding 原始索引列表（同一 evidence 可能被多条指摘引用）
  const evToFinding = new Map<string, number[]>();
  review.findings.forEach((f, i) => {
    if (f.evidence) {
      const arr = evToFinding.get(f.evidence) ?? [];
      arr.push(i);
      evToFinding.set(f.evidence, arr);
    }
  });
  // 收集 evidence（去重、按归一化长度降序优先匹配）
  const evidences = [...new Set(review.findings.map((f) => f.evidence).filter((e) => e && norm(e).length >= 4))]
    .sort((a, b) => norm(b).length - norm(a).length);
  if (!evidences.length) return [text];

  // 归一化正文 + 原文索引映射（nText[i] 对应 text[origIdx[i]]）
  const origIdx: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/[\s「」『』]/.test(text[i])) continue;
    origIdx.push(i);
  }
  const nText = origIdx.map((i) => text[i]).join("");
  const normEvs = evidences.map(norm);

  // 找到所有匹配位置
  type Match = { start: number; end: number; evIdx: number; flen: number };
  const matches: Match[] = [];
  const tryAdd = (s: number, e: number, evIdx: number, flen: number) => {
    const overlaps = matches.some((m) => s < m.end && e > m.start);
    if (!overlaps) matches.push({ start: s, end: e, evIdx, flen });
    return !overlaps;
  };
  for (let ei = 0; ei < normEvs.length; ei++) {
    const ne = normEvs[ei];
    let pos = nText.indexOf(ne);
    let found = false;
    while (pos !== -1) {
      if (tryAdd(origIdx[pos], origIdx[pos + ne.length - 1] + 1, ei, ne.length)) found = true;
      pos = nText.indexOf(ne, pos + 1);
    }
    if (!found) {
      // 完整匹配失败：多片段全匹配（AI 拼接引用的所有真实落点，弹窗引用内容在正文中全部标出）
      const frags = [...new Set(splitEvidenceFragments(evidences[ei]))].sort((a, b) => b.length - a.length);
      for (const frag of frags) {
        let fp = nText.indexOf(frag);
        while (fp !== -1) {
          if (tryAdd(origIdx[fp], origIdx[fp + frag.length - 1] + 1, ei, frag.length)) found = true;
          fp = nText.indexOf(frag, fp + 1);
        }
      }
    }
  }
  if (!matches.length) return [text];
  matches.sort((a, b) => a.start - b.start);

  // 拆分文本为普通段落和标记段落
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    const fids = evToFinding.get(evidences[m.evIdx]) ?? [];
    const cls = ["citation-mark", "cite-badge"];
    if (activeFindingIdx != null && fids.includes(activeFindingIdx)) cls.push("cite-active");
    // 角标序号：激活时显示激活项序号，否则显示首个引用者
    const badge =
      activeFindingIdx != null && fids.includes(activeFindingIdx)
        ? `#${activeFindingIdx + 1}`
        : `#${fids[0] + 1}`;
    const firstFinding = fids[0];
    parts.push(
      <mark
        className={cls.join(" ")}
        data-finding={fids.join(" ")}
        data-flen={m.flen}
        data-badge={badge}
        key={`${m.start}-${m.end}`}
        title={`审查引用 #${fids.map((f) => f + 1).join("/#")}：${evidences[m.evIdx]}`}
        onClick={() => firstFinding != null && onMarkClick?.(firstFinding)}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    );
    cursor = m.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** 段落锚定媒体块：image → <img>，video → <video controls>（src 走 asset 路由） */
const MediaBlock: React.FC<{ m: ChapterMedia; storyTitle: string }> = ({ m, storyTitle }) => {
  const src = `/api/novel/asset?title=${encodeURIComponent(storyTitle)}&path=${encodeURIComponent(m.path ?? "")}`;
  return m.kind === "video"
    ? <video className="chapter-media" src={src} controls />
    : <img className="chapter-media" src={src} alt="段落插画" />;
};

/** 按 \n\n 拆分正文为段落，逐段渲染；就绪媒体按 anchor 归一化子串匹配插到对应段落前方，失配者末尾兜底。 */
function renderParagraphsWithMedia(
  c: Chapter,
  storyTitle: string,
  review: ReviewResult | null,
  reviewMode: boolean,
  activeFindingIdx: number | null,
  onMarkClick?: (findingIdx: number) => void,
): React.ReactNode {
  const media = (c.media ?? []).filter((m) => m.status === "ready" && m.path);
  const claimed = new Set<string>();
  const paras = c.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const mediaBefore = (para: string): ChapterMedia[] => {
    const np = norm(para);
    return media.filter((m) => {
      if (claimed.has(m.id)) return false;
      const na = norm(m.anchor);
      if (na.length >= 4 && np.includes(na)) { claimed.add(m.id); return true; }
      return false;
    });
  };
  return (
    <>
      {paras.map((para, i) => (
        <Fragment key={i}>
          {mediaBefore(para).map((m) => <MediaBlock key={m.id} m={m} storyTitle={storyTitle} />)}
          <p className="para">{renderWithCitations(para, review, reviewMode, activeFindingIdx, onMarkClick)}</p>
        </Fragment>
      ))}
      {media.filter((m) => !claimed.has(m.id)).map((m) => <MediaBlock key={m.id} m={m} storyTitle={storyTitle} />)}
    </>
  );
}

export const ChapterView: React.FC<{
  chapter: Chapter | null;
  storyTitle?: string;
  writing?: boolean;
  review?: ReviewResult | null;
  /** 审查模式：正文引用显示波浪线/角标，激活项高亮；只读模式正文不渲染任何标记 */
  reviewMode?: boolean;
  activeFindingIdx?: number | null;
  /** 审查模式下点击正文波浪线文本：打开审查面板并定位到对应列表项 */
  onMarkClick?: (findingIdx: number) => void;
}> = (p) => {
  const c = p.chapter;
  return (
    <>
      {c ? (
        <article className="chapter-article">
          <header className="chapter-head">
            <div className="chapter-no">第 {c.index} 节</div>
            <div className="chapter-title-row">
              {c.review && (c.review.verdict === "pass" ? <Stamp text="通过" pop /> : <Stamp text="需修改" reject />)}
              <h2 className="chapter-title">{c.title}</h2>
            </div>
            <hr className="chapter-rule" />
          </header>
          <div className="chapter-text">
            {renderParagraphsWithMedia(c, p.storyTitle ?? "", p.review ?? c.review, p.reviewMode ?? false, p.activeFindingIdx ?? null, p.onMarkClick)}
          </div>
        </article>
      ) : (
        <div style={{ textAlign: "center", paddingTop: "4rem", color: "var(--ink-soft)" }}>
          <p style={{ fontSize: "1.1rem", letterSpacing: "0.2em" }}>── 暂无正文 ──</p>
          <p style={{ fontFamily: "var(--sans)", fontSize: "0.8rem" }}>
            点击下方「推进剧情」，导演将开始写作，审查者随后对抗审查。
          </p>
        </div>
      )}
      {p.writing && (
        <div className="busy-line"><PenLine size={12} /> 导演写作中 …</div>
      )}
    </>
  );
};
