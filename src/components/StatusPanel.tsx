// 右栏状态面板：创作进度 / 人物（本章被提及或出场的角色） / 伏笔账（本章埋设与触发，只读）
// 随当前选中章节联动：切换章节、新增/删除章节、版本回滚等 world 变化后自动更新
import type { WorldState, Character } from "../api/world";
import { appearedChars } from "./charAppearance";

export const StatusPanel: React.FC<{
  world: WorldState;
  busyPhase?: string;
  /** 当前选中章节 index；null = 尚无章节 */
  currentChapter: number | null;
  onViewPortrait?: (c: Character) => void;
}> = (p) => {
  const totalChars = p.world.chapters.reduce((n, c) => n + c.text.length, 0);
  const activeFs = p.world.foreshadowing.filter((f) => f.status !== "resolved").length;

  const chapterIdx = p.currentChapter;

  // 本章出场角色（与左栏「脉络」共用双轨判定：LLM 记账语义名单优先，未结算/名单为空回退实时文本匹配）
  const appearedCharsList = appearedChars(p.world, chapterIdx ?? -1);
  // 本章埋设的伏笔（plantedAt === 本章）
  const plantedHere = chapterIdx == null
    ? []
    : p.world.foreshadowing.filter((f) => f.plantedAt === chapterIdx);
  // 本章触发/回收的伏笔（resolvedAt === 本章）
  const resolvedHere = chapterIdx == null
    ? []
    : p.world.foreshadowing.filter((f) => f.resolvedAt === chapterIdx);

  return (
    <>
      <div className="game-col right">
        <h3 className="col-title">创作进度</h3>
        <div className="progress-stats">
          <div className="progress-stat"><b>{p.world.chapters.length}</b><span>章节</span></div>
          <div className="progress-stat"><b>{totalChars}</b><span>字数</span></div>
          <div className="progress-stat"><b>{activeFs}</b><span>活跃伏笔</span></div>
          <div className="progress-stat"><b>{p.world.outline?.length ?? 0}</b><span>大纲要点</span></div>
        </div>
        {p.busyPhase && <div className="progress-phase">{p.busyPhase}</div>}

        <h3 className="col-title">
          人物
          {chapterIdx != null && <span className="panel-tag tag-muted">第 {chapterIdx} 章</span>}
        </h3>
        {chapterIdx == null ? (
          <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
            （尚无章节，推进剧情后展示本章出场角色）
          </div>
        ) : appearedCharsList.length === 0 ? (
          <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
            （本章正文未提及任何角色）
          </div>
        ) : (
          <ul className="panel-list">
            {appearedCharsList.map((c) => (
              <li className="panel-item" key={c.id}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                  {(c.image ?? c.portrait?.path) && (
                    <img
                      src={`/api/novel/asset?title=${encodeURIComponent(p.world.title)}&path=${encodeURIComponent(c.image ?? c.portrait!.path)}`}
                      alt={`${c.name}头像`}
                      title="头像（点击查看全局立绘）"
                      style={{ width: "48px", flexShrink: 0, aspectRatio: "1", objectFit: "cover", border: "1px solid var(--line-strong)", cursor: "pointer" }}
                      onClick={() => p.onViewPortrait?.(c)}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="panel-name">{c.name}</span>{" "}
                    <span className="panel-tag tag-seal">{c.role}</span>
                    {(c.gender || c.age || c.identity) && (
                      <div style={{ fontSize: "0.68rem", color: "var(--ink-soft)" }}>
                        {[c.gender, c.age, c.identity].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)" }}>{c.status}</div>
                    {c.look && (
                      <div style={{ fontSize: "0.68rem", color: "var(--ink-soft)" }}>形象：{c.look}</div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <h3 className="col-title">
          伏笔账
          {chapterIdx != null && (
            <span className="panel-tag tag-muted">
              第 {chapterIdx} 章
            </span>
          )}
        </h3>
        {chapterIdx == null ? (
          <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
            （尚无章节，推进剧情后展示本章伏笔变动）
          </div>
        ) : plantedHere.length === 0 && resolvedHere.length === 0 ? (
          <div style={{ fontSize: "0.74rem", color: "var(--ink-soft)", fontStyle: "italic" }}>
            （本章无伏笔变动）
          </div>
        ) : (
          <>
            {plantedHere.length > 0 && (
              <>
                <div className="ctx-fs-row" style={{ marginTop: "0.3rem" }}>
                  <span className="ctx-fs-label ctx-fs-planted">○ 本章埋设</span>
                </div>
                <ul className="panel-list">
                  {plantedHere.map((f) => (
                    <li className={`panel-item fs-item ${f.status === "active" ? "fs-item-active" : f.status === "resolved" ? "fs-item-resolved" : "fs-item-planted"}`} key={f.id}>
                      <span className={`fs-status ${f.status === "resolved" ? "fs-resolved" : "fs-active"}`}>
                        {f.status === "resolved" ? "✓ 已回收" : f.status === "active" ? "● 活跃" : "○ 埋设"}
                      </span>
                      <div style={{ fontSize: "0.76rem" }}>{f.text}</div>
                      {f.note && (
                        <div style={{ fontSize: "0.68rem", color: "var(--ink-soft)", fontStyle: "italic" }}>{f.note}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {resolvedHere.length > 0 && (
              <>
                <div className="ctx-fs-row" style={{ marginTop: "0.3rem" }}>
                  <span className="ctx-fs-label ctx-fs-resolved">✓ 本章触发</span>
                </div>
                <ul className="panel-list">
                  {resolvedHere.map((f) => (
                    <li className="panel-item fs-item fs-item-resolved" key={f.id}>
                      <span className="fs-status fs-resolved">✓ 回收</span>
                      <div style={{ fontSize: "0.76rem" }}>{f.text}</div>
                      {f.note && (
                        <div style={{ fontSize: "0.68rem", color: "var(--ink-soft)", fontStyle: "italic" }}>{f.note}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
};
