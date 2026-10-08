/**
 * Markdown as written in intent text, with ```mermaid blocks drawn as diagrams.
 *
 * Raw HTML is not rendered and Mermaid runs with `securityLevel: 'strict'`:
 * intent text is workspace content, imported or written by agents. Mermaid is
 * loaded on first use, so pages without a diagram do not pay for it.
 *
 * `noRemote` is for agent-written text (cloud agent runs): nothing is fetched
 * from elsewhere when the page opens. Images show their alt text and URL as
 * plain text, and links show their target.
 */

import { cn } from '@/lib/utils';
import { useEffect, useId, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function isDarkTheme(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function MermaidBlock({ chart }: { chart: string }) {
  const id = `intent-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDarkTheme() ? 'dark' : 'default' });
        const rendered = await mermaid.render(id, chart);
        if (live) setSvg(rendered.svg);
      } catch (caught) {
        if (live) setError(caught instanceof Error ? caught.message : 'Could not draw this diagram');
      }
    })();
    return () => {
      live = false;
    };
  }, [chart, id]);

  if (error)
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-border-soft bg-surface-2 p-2 text-[12.5px] text-ink-3">
        {chart}
      </pre>
    );
  if (svg === null) return <div className="my-2 h-16 animate-pulse rounded-lg bg-surface-2" />;
  // The SVG comes from mermaid.render under securityLevel 'strict', which sanitizes labels.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's own sanitized output
  return <div className="my-2 overflow-x-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink-1">{children}</strong>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  h1: ({ children }) => <h3 className="mb-1 mt-4 text-[15px] font-semibold text-ink-1">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1 mt-4 text-[15px] font-semibold text-ink-1">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1 mt-3 text-[14.5px] font-semibold text-ink-1">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-[14px] font-semibold text-ink-1">{children}</h4>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border-soft px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border-soft px-2 py-1 align-top">{children}</td>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-ink-3">{children}</blockquote>
  ),
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    const source = String(children).replace(/\n$/, '');
    if (language === 'mermaid') return <MermaidBlock chart={source} />;
    if (language || source.includes('\n'))
      return (
        <pre className="my-2 overflow-x-auto rounded-lg bg-surface-2 p-2 font-mono text-[12.5px]">
          <code>{source}</code>
        </pre>
      );
    return <code className="rounded bg-surface-2 px-1 font-mono text-[13px]">{children}</code>;
  },
};

/** `inline` drops the outer paragraph so a one-line statement can sit beside its marks. */
const INLINE_COMPONENTS: Components = { ...COMPONENTS, p: ({ children }) => <>{children}</> };

const NO_REMOTE_OVERRIDES: Components = {
  img: ({ alt, src }) => (
    <span className="rounded bg-surface-2 px-1 text-[12.5px] text-ink-3">
      [image: {alt || 'untitled'}] {typeof src === 'string' ? src : ''}
    </span>
  ),
  a: ({ children, href }) => (
    <>
      <a href={href} target="_blank" rel="noreferrer noopener" className="text-blue underline-offset-2 hover:underline">
        {children}
      </a>
      {href && String(children) !== href ? <span className="text-ink-4"> ({href})</span> : null}
    </>
  ),
};
const NO_REMOTE_COMPONENTS: Components = { ...COMPONENTS, ...NO_REMOTE_OVERRIDES };
const NO_REMOTE_INLINE_COMPONENTS: Components = { ...INLINE_COMPONENTS, ...NO_REMOTE_OVERRIDES };

export function IntentMarkdown({
  text,
  inline = false,
  noRemote = false,
  className,
}: {
  text: string;
  inline?: boolean;
  /** Agent-written text: no remote images or other remote content. */
  noRemote?: boolean;
  className?: string;
}) {
  const Wrapper = inline ? 'span' : 'div';
  const components = noRemote
    ? inline
      ? NO_REMOTE_INLINE_COMPONENTS
      : NO_REMOTE_COMPONENTS
    : inline
      ? INLINE_COMPONENTS
      : COMPONENTS;
  return (
    <Wrapper className={cn(className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </Wrapper>
  );
}
