// 中央正文栏（报纸排版）+ 审查引用红色波浪线标记 + 段落锚定媒体（插画/视频）
import { Fragment } from "react";
import { PenLine } from "../components/icons";
import type { Chapter, ChapterMedia, ReviewResult } from "../api/world";
import { Stamp } from "./Stamp";

/** 归一化：去掉空白字符、「」『』引用标记与全部中英文标点（LLM 摘抄 anchor 的标点/引号/空格差异不影响匹配） */
const norm = (s: string) => s.replace(/[\s「」『』“”‘’"'()（）\[\]【】{}《》，。！？；：、—…,.!?;:'\-]/g, "");

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

  // 归一化正文 + 原文索引映射（nText[i] 对应 text[origIdx[i]]；与 norm 过滤字符集完全一致）
  const origIdx: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (norm(text[i]) === "") continue;
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

/** 段落锚定媒体块：figure 容器（媒体本体 + 图注：章节来源/画面类型/中文图注/可折叠提示词/重生成与删除入口） */
const MediaBlock: React.FC<{ m: ChapterMedia; storyTitle: string; chapter: Chapter; onMediaAction?: (m: ChapterMedia) => void; onMediaDelete?: (m: ChapterMedia) => void; orphanHint?: boolean }> = ({ m, storyTitle, chapter, onMediaAction, onMediaDelete, orphanHint }) => {
  const src = `/api/novel/asset?title=${encodeURIComponent(storyTitle)}&path=${encodeURIComponent(m.path ?? "")}`;
  const caption = m.caption?.trim() || (m.anchor.length > 30 ? m.anchor.slice(0, 30) + "…" : m.anchor);
  const anchorBrief = m.anchor.length > 40 ? m.anchor.slice(0, 40) + "…" : m.anchor;
  return (
    <figure className="chapter-media-fig" id={`media-${m.id}`}>
      {(m.orphan || orphanHint) && (
        <div className="media-orphan-banner">⚠ 未能在正文中匹配到锚定句子，图文可能错位——可修改提示词重新生成或删除</div>
      )}
      {m.kind === "video"
        ? <video className="chapter-media" src={src} controls />
        : <img className="chapter-media" src={src} alt={caption} />}
      <figcaption className="chapter-media-caption">
        <span className="chapter-media-source">
          {m.sceneType && <span className={`chapter-media-type type-${m.sceneType}`}>{m.sceneType}</span>}
          第 {chapter.index} 章《{chapter.title}》 · 对应段落：「{anchorBrief}」
        </span>
        <span className="chapter-media-caption-text">{caption}</span>
        {m.prompt && (
          <details className="chapter-media-details">
            <summary>生成提示词</summary>
            <div className="chapter-media-prompt">{m.prompt}</div>
          </details>
        )}
        {(onMediaAction || onMediaDelete) && (
          <div className="chapter-media-actions">
            {onMediaAction && (
              <button className="chapter-media-regen" onClick={(e) => { (e.currentTarget.closest("figure")?.querySelector("video") as HTMLVideoElement | null)?.pause(); onMediaAction(m); }}>✎ 重新生成</button>
            )}
            {onMediaDelete && (
              <button className="chapter-media-del" onClick={(e) => { (e.currentTarget.closest("figure")?.querySelector("video") as HTMLVideoElement | null)?.pause(); onMediaDelete(m); }}>✕ 删除</button>
            )}
          </div>
        )}
      </figcaption>
    </figure>
  );
};

/** 段落首字符是否为文字（字母/汉字/数字）：仅此类首段应用首字下沉；以引号、破折号、省略号等特殊符号开头的段落放大会很难看，故跳过 */
const startsWithWord = (s: string) => /^[\p{L}\p{N}]/u.test(s);

/** 按中文句末标点切分句子（保留标点），用于把媒体精确插到 anchor 所在句子之后 */
function splitSentences(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    cur += ch;
    if ("。！？；…".includes(ch)) { out.push(cur); cur = ""; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 按 \n\n 拆分正文为段落，逐段渲染；就绪媒体按 anchor 归一化子串匹配插到对应句子后方（紧贴句子，跨句 anchor 插到覆盖的最后一句后），失配者末尾兜底并提示。 */
function renderParagraphsWithMedia(
  c: Chapter,
  storyTitle: string,
  review: ReviewResult | null,
  reviewMode: boolean,
  activeFindingIdx: number | null,
  onMarkClick?: (findingIdx: number) => void,
  onMediaAction?: (m: ChapterMedia) => void,
  onMediaDelete?: (m: ChapterMedia) => void,
): React.ReactNode {
  const media = (c.media ?? []).filter((m) => m.status === "ready" && m.path);
  const claimed = new Set<string>();
  const paras = c.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  /** 该段内未认领且 anchor 能归一化子串匹配的媒体（认领，保证跨段唯一归属）。
   * 优先精确匹配本段；本段不包含时，允许 anchor 前 4 字落在本段而尾部溢出到下一段（跨段锚定，插入点仍在段内）。 */
  const mediaFor = (para: string, nextPara: string | undefined): ChapterMedia[] => {
    const np = norm(para);
    const npNext = np + (nextPara ? norm(nextPara) : "");
    return media.filter((m) => {
      if (claimed.has(m.id)) return false;
      const na = norm(m.anchor);
      if (na.length < 4) return false;
      if (np.includes(na)) { claimed.add(m.id); return true; }
      // 跨段：anchor 起点在本段（前 4 字命中本段）且拼接下一段后完整包含
      if (nextPara && npNext.includes(na) && np.includes(na.slice(0, 4))) { claimed.add(m.id); return true; }
      return false;
    });
  };
  /** 段落渲染：有媒体时按句拆分，媒体紧跟 anchor 所在句子之后；无媒体时整段普通渲染。
   * 首段若以特殊符号开头则加 no-dropcap（CSS 首字下沉仅对文字开头的段落生效）。 */
  const renderPara = (para: string, nextPara: string | undefined, isFirst: boolean): React.ReactNode => {
    const ms = mediaFor(para, nextPara);
    const cls = isFirst && !startsWithWord(para) ? "para no-dropcap" : "para";
    if (!ms.length) return <p className={cls}>{renderWithCitations(para, review, reviewMode, activeFindingIdx, onMarkClick)}</p>;
    const sentences = splitSentences(para);
    // 每句后要插入的媒体列表（同一句多个媒体并列展示）
    const after: ChapterMedia[][] = sentences.map(() => []);
    for (const m of ms) {
      const na = norm(m.anchor);
      let acc = "";
      let target = sentences.length - 1;
      for (let j = 0; j < sentences.length; j++) {
        acc += norm(sentences[j]);
        if (acc.includes(na)) { target = j; break; }
      }
      after[target].push(m);
    }
    return (
      <div className={cls}>
        {sentences.map((s, j) => (
          <Fragment key={j}>
            {renderWithCitations(s, review, reviewMode, activeFindingIdx, onMarkClick)}
            {after[j].map((m) => <MediaBlock key={m.id} m={m} storyTitle={storyTitle} chapter={c} onMediaAction={onMediaAction} onMediaDelete={onMediaDelete} />)}
          </Fragment>
        ))}
      </div>
    );
  };
  return (
    <>
      {paras.map((para, i) => (
        <Fragment key={i}>{renderPara(para, paras[i + 1], i === 0)}</Fragment>
      ))}
      {/* 失配媒体：末尾兜底展示并强制提示锚定失败 */}
      {media.filter((m) => !claimed.has(m.id)).map((m) => (
        <MediaBlock key={m.id} m={m} storyTitle={storyTitle} chapter={c} onMediaAction={onMediaAction} onMediaDelete={onMediaDelete} orphanHint />
      ))}
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
  /** 媒体操作（编辑提示词并重生成）；不传则纯展示 */
  onMediaAction?: (m: ChapterMedia) => void;
  /** 媒体删除（调用方负责二次确认）；不传则不显示删除按钮 */
  onMediaDelete?: (m: ChapterMedia) => void;
}> = (p) => {
  const c = p.chapter;
  return (
    <>
      {c ? (
        <article className="chapter-article">
          <header className="chapter-head">
            <div className="chapter-title-row">
              {c.review && (c.review.verdict === "pass" ? <Stamp text="通过" pop /> : <Stamp text="需修改" reject />)}
              <h2 className="chapter-title">{c.title}</h2>
            </div>
            <hr className="chapter-rule" />
          </header>
          <div className="chapter-text">
            {renderParagraphsWithMedia(c, p.storyTitle ?? "", p.review ?? c.review, p.reviewMode ?? false, p.activeFindingIdx ?? null, p.onMarkClick, p.onMediaAction, p.onMediaDelete)}
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
