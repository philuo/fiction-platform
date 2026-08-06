// 报头（日式报纸 masthead）：左侧书单入口 + 标题 + 设置入口，右侧章号/更新时间/状态
import type { Chapter, WorldState } from "../api/world";
import { List, Settings } from "./icons";

export const Masthead: React.FC<{
  world: WorldState;
  status: string;
  /** 当前查看的章节：展示「第x章」与该章最后保存更新时间 */
  chapter?: Chapter | null;
  onBackToList?: () => void;
  onOpenSettings?: () => void;
  /** 中枢指示器插槽（常驻报头右上角，点击查看记忆·台账·操作日志） */
  brain?: React.ReactNode;
}> = (p) => {
  // 时间取章节最后保存更新时间（更新正文/图片/视频/版本切换时刷新，见 touchChapter），
  // 无章节时回退全书 updatedAt；数据均来自 SSR 注入的 world，hydrate 前后渲染一致
  const ts = p.chapter?.updatedAt ?? p.world.updatedAt;
  const date = ts ? new Date(ts) : null;
  return (
    <header className="masthead">
      <h1 className="masthead-title">{p.world.title}</h1>
      <div className="masthead-meta">
        {p.chapter && <div className="issue">第 {p.chapter.index} 章</div>}
        {date && (
          <div>
            {date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}{" "}
            {date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </div>
        )}
      </div>
      {/* 右上角：中枢指示器 / 书单 / 设置 快捷入口 */}
      <div className="masthead-actions">
        {p.brain}
        <button className="masthead-icon-btn" title="返回书单" onClick={p.onBackToList}>
          <List size={17} />
        </button>
        <button className="masthead-icon-btn" title="小说设置" onClick={p.onOpenSettings}>
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
};
