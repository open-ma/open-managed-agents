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
          <pre className="bg-stone-100 border border-stone-200 rounded-md p-3 overflow-x-auto my-2 text-[13px]">
            {children}
          </pre>
        ),
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code className="bg-stone-100 px-1 py-0.5 rounded text-[0.85em] font-[family-name:var(--font-mono)]" {...props}>
              {children}
            </code>
          ) : (
            <code className={`${className} font-[family-name:var(--font-mono)]`} {...props}>
              {children}
            </code>
          );
        },
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-5 my-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 my-1">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        h1: ({ children }) => <h1 className="font-[family-name:var(--font-display)] text-lg font-semibold mt-3 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="font-[family-name:var(--font-display)] text-base font-semibold mt-2 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="font-semibold mt-2 mb-1">{children}</h3>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-3 border-stone-300 pl-3 my-2 text-stone-500">{children}</blockquote>
        ),
        table: ({ children }) => (
          <table className="border-collapse my-2 text-sm w-full">{children}</table>
        ),
        th: ({ children }) => (
          <th className="border border-stone-200 px-2 py-1 bg-stone-100 text-left">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border border-stone-200 px-2 py-1">{children}</td>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
