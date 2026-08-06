// 角色全局立绘大图预览：展示立绘（缺失时占位），可生成/重新生成立绘。
// 全局立绘是插画图生图参考图与视频 i2v 首帧的样貌唯一基准，保证同一人物跨章跨媒介形象一致。
// 立绘硬约束：1K 档 736x1312（9:16 竖版全身像），展示区域锁死同比例。
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
      <div className="modal modal-stable" onClick={(e) => e.stopPropagation()} style={{ maxWidth: "640px" }}>
        <div className="modal-head">
          <b style={{ fontFamily: "var(--sans)", letterSpacing: "0.25em" }}>{c.name} · 全局立绘</b>
          <button className="modal-close" onClick={p.onClose}><X size={16} /></button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.7rem" }}>
          {imgPath ? (
            <img
              src={`/api/novel/asset?title=${encodeURIComponent(p.storyTitle)}&path=${encodeURIComponent(imgPath)}`}
              alt={`${c.name}立绘`}
              style={{ maxWidth: "100%", maxHeight: "58vh", aspectRatio: "9 / 16", objectFit: "cover", border: "1px solid var(--line-strong)", background: "var(--paper-dark)", boxShadow: "4px 4px 0 rgba(0,0,0,0.12)" }}
            />
          ) : (
            <div
              style={{
                width: "100%", maxWidth: "min(100%, calc(58vh * 9 / 16))", aspectRatio: "9 / 16",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.4rem",
                border: "1px dashed var(--line-strong)", background: "var(--paper-dark)",
                color: "var(--ink-soft)", fontSize: "0.8rem",
              }}
            >
              <div>该角色暂无立绘</div>
              <div style={{ fontSize: "0.7rem" }}>生成立绘后，全书插画与视频的人物样貌将以此为准</div>
            </div>
          )}
          {!p.readOnly && (
            <>
              <textarea
                className="regen-prompt-input"
                rows={2}
                value={desc}
                placeholder="外貌描述（可选）：补充头发/眼睛/服饰等细节，如「青灰色长发，琥珀色眼眸，左眉一道疤」"
                onChange={(e) => setDesc(e.target.value)}
              />
              <p style={{ fontSize: "0.72rem", color: "var(--ink-soft)", textAlign: "center", margin: 0 }}>
                全局立绘是插画/视频中该人物样貌的唯一基准：插画以其为图生图参考图，视频以其为 i2v 首帧，画风由全书画风锚点统一；重新生成会延续既有容貌。
              </p>
              <button className="btn btn-primary" disabled={p.busy} onClick={() => p.onGenerate(desc.trim() || undefined)}>
                {p.busy ? "生成中…" : imgPath ? "重新生成立绘" : "生成立绘"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
