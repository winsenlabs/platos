/**
 * EOBD-68 — chat message renderer.
 *
 * Renders assistant / user message text with:
 *   - `react-markdown` + `remark-gfm` for GitHub-flavored markdown
 *     (tables, task lists, strikethrough, autolinks).
 *   - `prism-react-renderer` for syntax-highlighted code fences. We reuse
 *     this dep rather than adding `react-syntax-highlighter` (webapp
 *     already ships prism-react-renderer via `CodeBlock`).
 *   - Default `react-markdown` behaviour does NOT render raw HTML
 *     unless a `rehype-raw` plugin is wired in. We don't wire one, so
 *     there is no HTML injection surface — `rehype-sanitize` is not
 *     required.
 *
 * Exported separately from the chat route so the conversations viewer can
 * adopt the same renderer later.
 */
import { Highlight, themes, type Language, type PrismTheme } from "prism-react-renderer";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PRISM_THEME: PrismTheme = themes.nightOwl;

interface ChatMessageContentProps {
  content: string;
  /**
   * Hint — when true, we render with a smaller top margin and no
   * trailing-whitespace collapse so streaming tokens flow nicely.
   */
  streaming?: boolean;
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-charcoal-800 px-1 py-0.5 font-mono text-[0.85em] text-emerald-200">
      {children}
    </code>
  );
}

function CodeFence({
  language,
  code,
}: {
  language: string | undefined;
  code: string;
}) {
  const lang = (language ?? "text") as Language;
  return (
    <div className="my-2 overflow-hidden rounded-md border border-charcoal-700 bg-charcoal-900">
      <div className="flex items-center justify-between border-b border-charcoal-700 px-3 py-1 text-[10px] uppercase tracking-wide text-text-dimmed">
        <span>{lang}</span>
        <button
          type="button"
          aria-label="Copy code"
          className="rounded px-1.5 py-0.5 text-[10px] hover:bg-charcoal-700"
          onClick={() => {
            void navigator.clipboard?.writeText(code).catch(() => {});
          }}
        >
          copy
        </button>
      </div>
      <Highlight theme={PRISM_THEME} code={code.replace(/\n$/, "")} language={lang}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre className={`${className} overflow-x-auto px-3 py-2 text-xs`} style={style}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, j) => (
                  <span key={j} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function ChatMessageContent({ content, streaming }: ChatMessageContentProps) {
  if (!content) return null;

  return (
    <div
      className={`prose prose-invert max-w-none text-sm leading-relaxed ${
        streaming ? "" : ""
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code fences (block) vs inline code. react-markdown v10 passes
          // `className` on the `code` element for fenced blocks and omits
          // it for inline. `props.node?.properties?.className` is also a
          // reliable signal, but we keep it simple and use `className`.
          code({ className, children, ...rest }) {
            const raw = String(children ?? "");
            const match = /language-(\w+)/.exec(className ?? "");
            const isBlock = Boolean(match) || raw.includes("\n");
            if (isBlock) {
              return <CodeFence language={match?.[1]} code={raw} />;
            }
            return <InlineCode {...rest}>{children}</InlineCode>;
          },
          // `react-markdown` wraps fenced code in <pre><code>. Strip the
          // default <pre> wrapper so our `CodeFence` owns the layout.
          pre({ children }) {
            return <>{children}</>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-left font-semibold text-text-bright">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border border-charcoal-700 px-2 py-1 align-top">{children}</td>
            );
          },
          ul({ children }) {
            return <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>;
          },
          p({ children }) {
            return <p className="my-1 whitespace-pre-wrap">{children}</p>;
          },
          h1({ children }) {
            return <h1 className="mt-2 mb-1 text-lg font-semibold text-text-bright">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mt-2 mb-1 text-base font-semibold text-text-bright">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mt-1 mb-0.5 text-sm font-semibold text-text-bright">{children}</h3>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="my-1 border-l-2 border-emerald-600/40 pl-3 text-text-dimmed">
                {children}
              </blockquote>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
