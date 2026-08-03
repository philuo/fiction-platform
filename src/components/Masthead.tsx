// 报头（日式报纸 masthead）：左侧书单入口 + 标题 + 设置入口，右侧期号/日期/状态
import type { WorldState } from "../api/world";
import { List, Settings } from "./icons";

export const Masthead: React.FC<{
  world: WorldState;
  status: string;
  serverTime?: string;
  onBackToList?: () => void;
  onOpenSettings?: () => void;
}> = (p) => {
  // 日期用 SSR 注入的 serverTime：SSR 与客户端 hydrate 必须渲染完全一致的文本
  // （useState 初始值只在首次渲染读取一次，SSR/客户端各自固定）
  const now = new Date(p.serverTime ?? Date.now());
  return (
    <header className="masthead">
      <h1 className="masthead-title">{p.world.title}</h1>
      <div className="masthead-meta">
        <div>
          {now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })}
        </div>
      </div>
      {/* 右上角：书单 / 设置 快捷入口 */}
      <div className="masthead-actions">
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
