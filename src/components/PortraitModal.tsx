// 角色全局立绘大图预览：展示立绘（缺失时占位），可生成/重新生成立绘。
// 全局立绘是插画图生图参考图与视频 i2v 首帧的样貌唯一基准，保证同一人物跨章跨媒介形象一致。
// 立绘硬约束：1K 档 736x1312（9:16 竖版全身像），展示区域锁死同比例。
// 布局（三段，编辑状态底部留足空间）：头部固定 + 图片区自适应（弹窗定高，立绘等比缩放完整显示，不滚动）+ 底部操作区固定（textarea/说明/按钮始终可见）。
import { useState } from "react";
import { X } from "./icons";
import type { Character } from "../api/world";

export const PortraitModal: React.FC<{
  storyTitle: string;
  character: Character;
  busy: boolean;
  onGenerate: (description?: string) => void;
  onClose: () => void;
  /** 只读模式（只读角色弹窗内打开）：仅查看立绘，隐藏描述输入与生成/重新生成入口 */
  readOnly?: boolean;
}> = (p) => {
  const c = p.character;
  const imgPath = c.portrait?.path; // 立绘弹窗只展示立绘（头像仅供列表展示，与立绘区分）
  // 预填上一次生成时使用的外貌特征提示词（无则空），便于基于上次结果调整
  const [desc, setDesc] = useState(() => c.portrait?.looks ?? "");
  return (
    <div className="modal-mask" onClick={p.onClose}>
      <div className={"modal modal-stable portrait-modal" + (p.readOnly ? " readonly" : "")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>{c.name} · 全局立绘</b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        {/* 图片区：占满弹窗剩余高度，图片在可用空间内等比缩放（不被压缩），超高时区内滚动 */}
        <div className="portrait-media">
          {imgPath ? (
            <img
              className="portrait-img"
              src={`/api/novel/asset?title=${encodeURIComponent(p.storyTitle)}&path=${encodeURIComponent(imgPath)}`}
              alt={`${c.name}立绘`}
            />
          ) : (
            <div className="portrait-placeholder">
              <div>该角色暂无立绘</div>
              <div style={{ fontSize: "0.7rem" }}>生成立绘后，全书插画与视频的人物样貌将以此为准</div>
            </div>
          )}
        </div>
        {/* 底部操作区（编辑状态）：固定在弹窗底部、始终可见，textarea 有充足高度 */}
        {!p.readOnly && (
          <div className="portrait-actions">
            <textarea
              className="regen-prompt-input"
              rows={2}
              value={desc}
              placeholder="外貌描述（可选）：补充头发/眼睛/服饰等细节，如「青灰色长发，琥珀色眼眸，左眉一道疤」"
              onChange={(e) => setDesc(e.target.value)}
            />
            <p className="portrait-hint">
              立绘是人物样貌的唯一基准：插画、视频以其为参考图，画风由全书画风锚点统一；重新生成会延续既有容貌。
            </p>
            <button className="btn btn-primary" disabled={p.busy} onClick={() => p.onGenerate(desc.trim() || undefined)}>
              {p.busy ? "生成中…" : imgPath ? "重新生成立绘" : "生成立绘"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
