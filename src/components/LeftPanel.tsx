// 左栏面板：目录 / 脉络（只读速览）
// 设计目的：一眼看清本章出场角色、故事梗概、伏笔的埋设·活跃·回收；
// 小说级 / 章节级设定统一收敛到「设置」面板操作。
import { useState } from "react";
import type { WorldState } from "../api/world";
import { PlanPanel } from "./PlanPanel";
import { appearedChars } from "./charAppearance";

type Tab = "目录" | "规划" | "脉络";

/** 角色徽章底色（无头像时首字圆形的兜底色） */
const ROLE_COLORS: Record<string, string> = { "主角": "#b03a2e", "反派": "#4a4a8a", "配角": "#4d7a4d" };

type Props = {
  world: WorldState;
  activeChapter: number;
  onSelectChapter: (index: number) => void;
  onWorldUpdate?: (w: WorldState) => void;
  onToast?: (msg: string) => void;
  /** 运行锁：任务运行中禁止大纲编辑（透传 PlanPanel） */
  taskActive?: boolean;
  /** 点击出场角色：通知外部打开顶层共享只读角色弹窗（与审查面板一致） */
  onOpenChar?: (charId: string) => void;
};

const TABS: Tab[] = ["目录", "规划", "脉络"];

export const LeftPanel: React.FC<Props> = (p) => {
  const [tab, setTab] = useState<Tab>("目录");
  // 当前聚焦章节：-1 表示最新节
  const currentIdx =
    p.activeChapter === -1
      ? (p.world.chapters[p.world.chapters.length - 1]?.index ?? -1)
      : p.activeChapter;

  return (
    <div className="game-col left">
      {/* 顶部标签栏：不参与滚动（桌面端列容器为 flex 纵向布局，仅 .left-scroll 内部滚动） */}
      <div className="panel-tabs">
        {TABS.map((t) => (
          <button className={`panel-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)} key={t}>
            {t}
          </button>
        ))}
      </div>

      <div className="left-scroll">
        {tab === "目录" && (
          <>
            <h3 className="col-title">目录</h3>
            {p.world.chapters.map((c) => (
              <div
                className={`toc-item ${p.activeChapter === c.index ? "active" : ""}`}
                onClick={() => p.onSelectChapter(p.activeChapter === c.index ? -1 : c.index)}
                key={c.index}
              >
                {c.review?.verdict === "pass" ? <span className="pass-mark">◎</span> : "○"} 第{c.index}章 {c.title}
              </div>
            ))}
            {p.world.chapters.length === 0 && (
              <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>（尚无章节）</div>
            )}
          </>
        )}

        {tab === "脉络" && <ContextView world={p.world} chapterIdx={currentIdx} onOpenChar={p.onOpenChar} />}
        {tab === "规划" && <PlanPanel world={p.world} onWorldUpdate={p.onWorldUpdate} onToast={p.onToast} taskActive={p.taskActive} />}
      </div>
    </div>
  );
};

// —— 脉络：本章速览（出场角色 / 故事梗概 / 伏笔动态）+ 全书弧线·伏笔账 ——
const ContextView: React.FC<{ world: WorldState; chapterIdx: number; onOpenChar?: (charId: string) => void }> = (p) => {
  const w = p.world;
  const hasChapter = p.chapterIdx >= 0;

  // 出场角色：与右栏共用双轨判定（LLM 记账语义名单优先 + 实时正文匹配兜底），
  // 章节内容变更/版本切换/删除章节后随 world 实时刷新，不再依赖静态 appearedIn 快照
  const appeared = appearedChars(w, p.chapterIdx);
  // 故事梗概：优先 LLM 记账摘要 chapterSummaries（编辑/回滚时即使记账失败也会降级为正文开头），
  // 兜底旧字段 timeline（旧存档）
  const chapterSummary = (w.chapterSummaries ?? []).find((s) => s.index === p.chapterIdx);
  const summary = chapterSummary?.summary || w.timeline.find((t) => t.chapter === p.chapterIdx)?.summary;
  const plantedHere = w.foreshadowing.filter((f) => f.plantedAt === p.chapterIdx);
  const resolvedHere = w.foreshadowing.filter((f) => f.resolvedAt === p.chapterIdx);
  const activeFs = w.foreshadowing.filter((f) => f.status === "active");

  const fsCount = w.foreshadowing.length;
  const fsResolved = w.foreshadowing.filter((f) => f.status === "resolved").length;

  return (
    <div>
      <h3 className="col-title">
        本章速览{hasChapter ? <span className="panel-tag tag-muted">第 {p.chapterIdx} 章</span> : null}
      </h3>
      {!hasChapter && <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>（尚无章节，推进剧情后生成）</div>}

      {hasChapter && (
        <>
          <h4 className="ctx-sub">出场角色</h4>
          {appeared.length ? (
            <div className="ctx-chips">
              {appeared.map((c) => (
                <span
                  className="ctx-chip ctx-char-chip"
                  key={c.id}
                  title={`${c.name}（${c.role}）`}
                  onClick={() => p.onOpenChar?.(c.id)}
                >
                  {c.image ? (
                    <img
                      className="ctx-char-avatar"
                      src={`/api/novel/asset?title=${encodeURIComponent(w.title)}&path=${encodeURIComponent(c.image)}`}
                      alt={`${c.name}头像`}
                    />
                  ) : (
                    <span className="ctx-char-avatar" style={{ background: ROLE_COLORS[c.role] ?? "#666" }}>
                      {c.name.slice(0, 1)}
                    </span>
                  )}
                  <span>{c.name}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="ctx-empty">（本章暂无角色登场记录）</div>
          )}

          <h4 className="ctx-sub">故事梗概</h4>
          {summary ? (
            <p className="ctx-summary">{summary}</p>
          ) : (
            <div className="ctx-empty">（暂无梗概，写作完成后自动登记）</div>
          )}

          <h4 className="ctx-sub">伏笔动态</h4>
          <div className="ctx-fs-group">
            <div className="ctx-fs-row">
              <span className="ctx-fs-label ctx-fs-planted">○ 埋设</span>
              {plantedHere.length ? (
                plantedHere.map((f) => <span className="ctx-fs-text" key={f.id}>{f.text}</span>)
              ) : (
                <span className="ctx-empty-inline">无</span>
              )}
            </div>
            <div className="ctx-fs-row">
              <span className="ctx-fs-label ctx-fs-active">● 活跃</span>
              {activeFs.length ? (
                activeFs.map((f) => <span className="ctx-fs-text" key={f.id}>{f.text}</span>)
              ) : (
                <span className="ctx-empty-inline">无</span>
              )}
            </div>
            <div className="ctx-fs-row">
              <span className="ctx-fs-label ctx-fs-resolved">✓ 回收</span>
              {resolvedHere.length ? (
                resolvedHere.map((f) => <span className="ctx-fs-text" key={f.id}>{f.text}</span>)
              ) : (
                <span className="ctx-empty-inline">无</span>
              )}
            </div>
          </div>
        </>
      )}

      <h3 className="col-title" style={{ marginTop: "1rem" }}>情节弧线</h3>
      <ul className="panel-list">
        {w.plotThreads?.map((a) => (
          <li className="panel-item" key={a.id}>
            <span className={`fs-status ${a.status === "已解决" ? "fs-resolved" : "fs-active"}`}>
              {a.status === "已解决" ? "已解决" : "进行中"}
            </span>{" "}
            <span className="panel-name">{a.name}</span>
            <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)" }}>{a.note}</div>
          </li>
        ))}
      </ul>
      {(w.plotThreads ?? []).length === 0 && (
        <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>
          （暂无弧线，写作后导演会自动登记并追踪）
        </div>
      )}

      <h3 className="col-title" style={{ marginTop: "1rem" }}>
        伏笔账
        <span className="panel-tag tag-muted">{fsResolved}/{fsCount} 已回收</span>
      </h3>
      {w.foreshadowing.map((f) => (
        <div style={{ fontSize: "0.72rem", marginBottom: "0.3rem" }} key={f.id}>
          <span className={`fs-status ${f.status === "resolved" ? "fs-resolved" : ""}`}>
            {f.status === "resolved" ? "✓ 已回收" : f.status === "active" ? "● 活跃" : "○ 埋设"}
          </span>{" "}
          {f.text.slice(0, 50)}
          <span style={{ color: "var(--ink-soft)" }}>（第{f.plantedAt}章）</span>
        </div>
      ))}
      {w.foreshadowing.length === 0 && (
        <div style={{ fontSize: "0.78rem", color: "var(--ink-soft)" }}>（暂无伏笔，写作时导演会自动埋设）</div>
      )}
    </div>
  );
};
