import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface SafeArtifactMarkdownProps {
  content: string;
}

const components: Components = {
  a({ children }) {
    return <span>{children}</span>;
  },
  img({ alt }) {
    return <span>{alt ?? 'Image'}</span>;
  },
  code({ children }) {
    return <code className="font-mono text-xs text-content-secondary">{children}</code>;
  },
  pre({ children }) {
    return (
      <pre className="overflow-auto rounded-lg border border-border-input bg-input/40 p-3 text-xs">{children}</pre>
    );
  },
};

/**
 * Artifact Markdown is untrusted checkpoint content. Keep this renderer separate
 * from the general Markdown surface, which deliberately enables raw HTML,
 * Mermaid, links, and syntax highlighting for other product contexts.
 */
export function SafeArtifactMarkdown({ content }: SafeArtifactMarkdownProps) {
  return (
    <div className="prose prose-sm max-w-none text-content-secondary">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
