// 审查报告面板 —— 引用定位高亮 + 伏笔只读弹窗；涉及角色点击打开顶层共享的角色弹窗（由 Home 统一渲染）
import { useEffect, useRef, useState } from "react";
import type { Character, Foreshadow, ReviewResult, WorldState } from "../api/world";
import { Stamp } from "./Stamp";
import { Sparkles } from "./icons";

const LENS_CN: Record<string, string> = {
  continuity: "连续性", character_state: "角色状态", foreshadow: "伏笔",
  logic: "逻辑", prose: "文笔", pacing: "节奏", dialogue: "对话",
  style: "风格", arc: "弧线", general: "综合",
};
const SCORE_CN: Record<string, string> = {
  coherence: "连贯", tension: "张力", prose: "文笔", pacing: "节奏", dialogue: "对话",
};
const SEVERITY_COLOR: Record<string, string> = { major: "var(--seal)", minor: "var(--ink-soft)" };
const ROLE_COLORS: Record<string, string> = { "主角": "#b03a2e", "反派": "#4a4a8a", "配角": "#4d7a4d" };

/** 归一化：去掉空白字符与「」『』引用标记，用于鲁棒文本匹配 */
const normText = (s: string) => s.replace(/[\s「」『』]/g, "");

/** 归一化偏移 → 文本节点内真实字符偏移 */
function normOffsetToReal(data: string, normPos: number): number {
  let real = 0, count = 0;
  while (real < data.length && count < normPos) {
    if (!/[\s「」『』]/.test(data[real])) count++;
    real++;
  }
  return real;
}

/**
 * 点击引用：滚动正文到对应位置。
 * 审查模式下（传入 findingIdx）：优先定位 data-finding 精确匹配的 mark，
 * 多 mark（同一引用多片段）时滚动到引用核心片段（最长匹配）；高亮由 React 状态（cite-active）驱动。
 * 未传入 findingIdx / 未找到 mark：回退全文归一化搜索（跨文本节点）+ 3s 临时高亮。
 * @returns 是否在正文中定位到引用
 */
export function scrollToCitation(evidence: string, findingIdx?: number): boolean {
  if (typeof document === "undefined") return false;
  // 审查模式：优先定位对应角标 mark（data-finding 支持多值空格分隔；选引用核心片段 flen 最大）
  if (findingIdx != null) {
    const targets = document.querySelectorAll<HTMLElement>(`.citation-mark[data-finding~="${findingIdx}"]`);
    if (targets.length > 0) {
      let best = targets[0];
      for (const t of targets) {
        if (Number(t.dataset.flen ?? 0) > Number(best.dataset.flen ?? 0)) best = t;
      }
      best.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
  }
  // 先清除旧高亮
  document.querySelectorAll(".citation-highlight-active").forEach((el) => {
    el.classList.remove("citation-highlight-active");
  });
  // 尝试精确匹配 citation-mark（归一化比较，容忍空白差异）
  const normEv = normText(evidence);
  const marks = document.querySelectorAll<HTMLElement>(".citation-mark");
  for (const m of marks) {
    const t = normText(m.textContent ?? "");
    if (t && (normEv.includes(t) || t.includes(normEv.slice(0, 12)))) {
      m.scrollIntoView({ behavior: "smooth", block: "center" });
      m.classList.add("citation-highlight-active");
      setTimeout(() => m.classList.remove("citation-highlight-active"), 3000);
      return true;
    }
  }
  // 回退：在 chapter-text 全文（归一化、跨文本节点）中搜索
  const chapterEl = document.querySelector<HTMLElement>(".chapter-text");
  if (!chapterEl) return false;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(chapterEl, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  // 各节点归一化文本的累积起点 + 拼接全文
  const nodeStarts: number[] = [];
  let acc = 0;
  const parts = nodes.map((node) => {
    nodeStarts.push(acc);
    const t = normText(node.data);
    acc += t.length;
    return t;
  });
  const search = normEv.slice(0, 15);
  const ni = parts.join("").indexOf(search);
  if (ni >= 0 && search) {
    // 起点节点
    let si = 0;
    while (si < nodeStarts.length - 1 && nodeStarts[si + 1] <= ni) si++;
    // 终点节点（归一化位置 ni + search.length）
    const endPos = ni + search.length;
    let ei = 0;
    while (ei < nodeStarts.length - 1 && nodeStarts[ei + 1] <= endPos) ei++;
    const range = document.createRange();
    range.setStart(nodes[si], normOffsetToReal(nodes[si].data, ni - nodeStarts[si]));
    range.setEnd(nodes[ei], normOffsetToReal(nodes[ei].data, endPos - nodeStarts[ei]));
    try {
      const highlight = document.createElement("span");
      highlight.className = "citation-highlight-active";
      range.surroundContents(highlight);
      highlight.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        // 移除包裹，恢复原文
        const parent = highlight.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(highlight.textContent ?? ""), highlight);
          parent.normalize();
        }
      }, 3000);
    } catch {
      // 包裹失败（如范围完整包含节点）：降级仅滚动到起点
      nodes[si].parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return true;
  }
  // 未定位到引用
  return false;
}

/** 从审查文本中提取角色名 */
function extractCharNames(findings: { issue: string; evidence: string; suggestion: string }[], characters: Character[]): Character[] {
  const allText = findings.map((f) => f.issue + f.evidence + f.suggestion).join(" ");
  return characters.filter((c) => allText.includes(c.name));
}

export const ReviewPanel: React.FC<{
  review: ReviewResult | null;
  writingRounds: number;
  foreshadowing?: Foreshadow[];
  characters?: Character[];
  /** 世界状态（角色弹窗复用「角色与关系」只读弹窗所需） */
  world?: WorldState;
  /** 审查模式：激活的指摘项原始索引（正文引用高亮 + 列表项高亮） */
  activeIdx?: number | null;
  /** 点击原文引用回调（父级统一处理：关闭弹窗/进入审查模式/定位，携带来源审查对象）；缺省时面板内部定位 */
  onCiteClick?: (evidence: string, findingIdx: number, review: ReviewResult) => void;
  /** 只读模式：引用不可点击，不进入审查模式（版本历史弹窗内使用） */
  readOnly?: boolean;
  /** 顶层共享角色弹窗当前选中角色 id（徽章选中高亮同步；由 Home 统一管理） */
  activeCharId?: string | null;
  /** 点击「涉及角色」徽章：通知外部打开顶层只读角色弹窗（与脉络面板共享同一实例） */
  onOpenChar?: (charId: string) => void;
  /** AI 修复：按审查意见重写本章（仅非只读且未通过时显示） */
  onAiFix?: () => void;
}> = (p) => {
  const [filter, setFilter] = useState<"all" | "major" | "minor">("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showFsModal, setShowFsModal] = useState(false);
  const [highlightFsId, setHighlightFsId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 激活项变化：重置筛选、自动展开该项并滚动到可见
  useEffect(() => {
    if (p.activeIdx == null) return;
    setFilter("all");
    setExpanded((prev) => {
      const s = new Set(prev);
      s.add(p.activeIdx!);
      return s;
    });
    const el = listRef.current?.querySelector<HTMLElement>(`[data-fidx="${p.activeIdx}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [p.activeIdx]);

  function toggleExpand(i: number) {
    setExpanded((prev) => {
      const s = new Set(prev);
      s.has(i) ? s.delete(i) : s.add(i);
      return s;
    });
  }

  // 伏笔 id → 中文 label（审查文本中 LLM 常以 [id] 形式引用伏笔，展示时替换为「中文」）
  const fsLabelMap = new Map<string, string>();
  for (const f of p.foreshadowing ?? []) {
    fsLabelMap.set(f.id, f.text);
    if (f.id.startsWith("fs_")) fsLabelMap.set(f.id.slice(3), f.text); // 兼容手动登记带前缀 id
  }
  /** 把文本中的 [伏笔id] 替换为「伏笔中文」高亮；未命中账本的占位符原样保留 */
  function decorateFsText(text: string): React.ReactNode {
    const parts = text.split(/(\[[A-Za-z0-9_]+\])/g);
    if (parts.length === 1) return text;
    return parts.map((part, i) => {
      const m = /^\[([A-Za-z0-9_]+)\]$/.exec(part);
      if (m) {
        const label = fsLabelMap.get(m[1]);
        if (label) return <b key={i} style={{ color: "var(--seal)" }}>「{label}」</b>;
      }
      return part;
    });
  }

  const filteredFindings = (() => {
    if (!p.review) return [];
    return p.review.findings
      .map((finding, idx) => ({ finding, idx }))
      .filter(({ finding }) => filter === "all" || finding.severity === filter)
      .sort((a, b) => (a.finding.severity === b.finding.severity ? 0 : a.finding.severity === "major" ? -1 : 1));
  })();

  // 伏笔引用列表
  const fsRefs = (() => {
    if (!p.foreshadowing?.length) return [];
    const refs: { fs: Foreshadow; seq: number }[] = [];
    const text = p.review?.findings.map((f) => f.issue + f.evidence + f.suggestion).join(" ") ?? "";
    let seq = 1;
    for (const fs of p.foreshadowing) {
      if (text.includes(fs.id) || text.includes(fs.text.slice(0, 8))) {
        refs.push({ fs, seq: seq++ });
      }
    }
    return refs;
  })();

  // 角色引用
  const charRefs = (() => {
    if (!p.characters?.length || !p.review) return [];
    return extractCharNames(p.review.findings, p.characters);
  })();

  function openFsModal(fsId?: string) {
    setHighlightFsId(fsId ?? null);
    setShowFsModal(true);
  }

  return (
  <>
  {p.review && (
    (() => {
      const r = p.review;
      return (
      <div className="review-box" ref={listRef}>
        <div className="review-head">
          {r.verdict === "pass" ? <Stamp text="通过" pop /> : <Stamp text="需修改" reject />}
          <b style={{ fontFamily: "var(--sans)" }}>
            {r.verdict === "pass" ? "审查通过" : "审查未通过，建议修正"}
            {p.writingRounds > 1 ? `（重写 ${p.writingRounds - 1} 次）` : ""}
          </b>
          {!p.readOnly && r.verdict !== "pass" && p.onAiFix && (
            <button className="btn-save btn-danger-sm" onClick={p.onAiFix} title="按审查意见由 AI 重写本章（原稿可在版本历史回滚）">
              <Sparkles size={12} /> AI 修复
            </button>
          )}
        </div>

        <div className="score-row">
          {Object.entries(r.scores).map(([k, v]) => (
            <span className="score-cell" key={k}>{SCORE_CN[k] ?? k} <b>{v}</b></span>
          ))}
        </div>

        {/* 伏笔引用条 */}
        {fsRefs.length > 0 && (
          <div className="fs-refs-bar">
            <span className="fs-refs-label">伏笔引用</span>
            {fsRefs.map(({ fs, seq }) => (
              <button className="fs-badge" onClick={() => openFsModal(fs.id)} title={fs.text} key={fs.id}>
                <span className="fs-badge-seq">{seq}</span>
                <span className="fs-badge-text">{fs.text.slice(0, 12)}{fs.text.length > 12 ? "…" : ""}</span>
              </button>
            ))}
            <button className="fs-badge fs-badge-all" onClick={() => openFsModal()}>全部伏笔 →</button>
          </div>
        )}

        {/* 角色引用条 */}
        {charRefs.length > 0 && (
          <div className="char-refs-bar">
            <span className="char-refs-label">涉及角色</span>
            {charRefs.map((c) => (
              <button
                className={`char-badge ${p.activeCharId === c.id ? "char-badge-selected" : ""}`}
                onClick={() => p.onOpenChar?.(c.id)}
                title={`${c.name}（${c.role}）`}
                key={c.id}
              >
                <span className="char-avatar" style={c.image && p.world?.title ? undefined : { background: ROLE_COLORS[c.role] ?? "#666" }}>
                  {c.image && p.world?.title ? (
                    <img
                      className="char-avatar-img"
                      src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(c.image)}`}
                      alt={`${c.name}头像`}
                    />
                  ) : (
                    c.name.slice(0, 1)
                  )}
                </span>
                <span className="char-badge-name">{c.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* 指摘列表 */}
        {r.findings.length > 0 ? (
          <>
            <div className="review-filter-bar">
              <span style={{ fontFamily: "var(--sans)", fontSize: "0.75rem", letterSpacing: "0.2em" }}>
                指摘事项（{r.findings.length} 条）
              </span>
              <div className="review-filters">
                {(["all", "major", "minor"] as const).map((f) => (
                  <button className={`panel-tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)} key={f}>
                    {f === "all" ? "全部" : f === "major" ? "严重" : "轻微"}
                  </button>
                ))}
              </div>
            </div>
            {filteredFindings.map(({ finding: f, idx }) => (
              <div
                className={`finding ${f.severity === "minor" ? "minor" : ""} ${p.activeIdx === idx ? "finding-active" : ""}`}
                data-fidx={idx}
                style={{ animationDelay: `${idx * 0.08}s` }}
                key={idx}
              >
                <div className="finding-header" onClick={() => toggleExpand(idx)}>
                  <span className="finding-meta" style={{ color: SEVERITY_COLOR[f.severity] }}>
                    <span className="finding-seq">#{idx + 1}</span>
                    <span className="finding-label">
                      <span className="finding-severity-dot" style={{ background: SEVERITY_COLOR[f.severity] }} />
                      <b>[{LENS_CN[f.lens] ?? f.lens}]</b>
                    </span>
                  </span>
                  {decorateFsText(f.issue)}
                  <span className="finding-toggle">{expanded.has(idx) ? "▼" : "▶"}</span>
                </div>
                {expanded.has(idx) && (
                  <div className="finding-detail">
                    {f.evidence && (
                      <div
                        className={`ev ${p.readOnly ? "" : "ev-clickable"}`}
                        onClick={p.readOnly ? undefined : () => (p.onCiteClick ? p.onCiteClick(f.evidence, idx, r) : scrollToCitation(f.evidence))}
                        title={p.readOnly ? undefined : "点击定位到正文对应位置"}
                      >
                        <span className="ev-icon">📌</span> 原文：「{decorateFsText(f.evidence)}」
                        {!p.readOnly && <span className="ev-hint">点击定位</span>}
                      </div>
                    )}
                    {f.suggestion && (
                      <div className="suggestion-line">💡 建议：{decorateFsText(f.suggestion)}</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          <div style={{ fontFamily: "var(--sans)", fontSize: "0.8rem", color: "var(--ink-soft)" }}>
            无指摘事项 —— 本章通过对抗审查。
          </div>
        )}
      </div>
      );
    })()
  )}

  {/* ===== 伏笔只读弹窗（顶层渲染，避免被 review-box 动画 stacking context 困住） ===== */}
  {showFsModal && (
    <div className="modal-mask" onClick={() => setShowFsModal(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "560px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.15em" }}>伏笔账本（只读）</b>
          <button className="modal-close" onClick={() => setShowFsModal(false)}>✕</button>
        </div>
        <div className="modal-body">
          {p.foreshadowing && p.foreshadowing.length > 0 ? (
            p.foreshadowing.map((fs) => (
              <div className={`rp-fs-item ${highlightFsId === fs.id ? "rp-fs-highlight" : ""} ${fs.status === "resolved" ? "rp-fs-resolved" : ""}`} key={fs.id}>
                <div className="rp-fs-status">
                  {fs.status === "resolved" ? "✓" : fs.status === "active" ? "●" : "○"}
                </div>
                <div className="rp-fs-content">
                  <div className="rp-fs-text">{fs.text}</div>
                  <div className="rp-fs-meta">
                    第{fs.plantedAt}章埋设
                    {fs.resolvedAt && <> · 第{fs.resolvedAt}章回收</>}
                    {fs.note && <> · {fs.note}</>}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "var(--ink-soft)" }}>暂无伏笔记录</div>
          )}
        </div>
      </div>
    </div>
  )}
  </>
  );
};
