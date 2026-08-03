// 印章（日式朱印/墨印），pop 触发弹跳动画
export const Stamp: React.FC<{ text: string; reject?: boolean; pop?: boolean }> = (p) => (
  <span className={`stamp${p.reject ? " reject" : ""}${p.pop ? " stamp-pop" : ""}`}>{p.text}</span>
);
