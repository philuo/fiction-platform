// MarkdownView：中枢消息富文本渲染（文本/表格/图片/列表/代码块/引用）
// react-markdown + remark-gfm；流式增量时对不完整 Markdown（未闭合表格等）容错渲染
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** 图片组件：限制最大宽度、alt 作为 title，避免超大图撑破气泡 */
function MdImage({ alt, src }: { alt?: string; src?: string }) {
  if (!src) return null;
  return <img className="bc-md-img" src={src} alt={alt ?? ""} loading="lazy" />;
}

export function MarkdownView({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="bc-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: MdImage,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
