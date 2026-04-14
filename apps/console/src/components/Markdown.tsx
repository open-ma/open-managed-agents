import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre: ({ children }) => (
          <pre className="bg-bg-surface border border-border rounded-md p-3 overflow-x-auto my-2 text-[13px]">
            {children}
          </pre>
        ),
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code className="bg-bg-surface px-1 py-0.5 rounded text-[0.85em] font-mono" {...props}>
              {children}
            </code>
          ) : (
            <code className={`${className} font-mono`} {...props}>
              {children}
            </code>
          );
        },
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        h1: ({ children }) => <h1 className="font-display text-lg font-semibold mt-3 mb-1 text-fg">{children}</h1>,
        h2: ({ children }) => <h2 className="font-display text-base font-semibold mt-2 mb-1 text-fg">{children}</h2>,
        h3: ({ children }) => <h3 className="font-semibold mt-2 mb-1 text-fg">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-3 border-border-strong pl-3 my-2 text-fg-muted">{children}</blockquote>
        ),
        table: ({ children }) => (
          <table className="border-collapse my-2 text-sm w-full">{children}</table>
        ),
        th: ({ children }) => (
          <th className="border border-border px-2 py-1 bg-bg-surface text-left text-fg">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border border-border px-2 py-1 text-fg">{children}</td>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
