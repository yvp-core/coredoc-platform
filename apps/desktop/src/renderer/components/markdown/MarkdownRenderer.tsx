import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Components } from 'react-markdown';
import { externalHttpsUrl } from '../../../shared/external-url';
import { CodeBlock } from './CodeBlock';
import { MermaidDiagram } from './MermaidDiagram';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  enableMermaid?: boolean;
  enableSyntaxHighlight?: boolean;
  diagramZoomable?: boolean;
  maxDiagramHeight?: number;
}

export function MarkdownRenderer({
  content,
  className,
  enableMermaid = true,
  enableSyntaxHighlight = true,
  diagramZoomable = true,
  maxDiagramHeight = 500,
}: MarkdownRendererProps) {
  const components: Components = {
    // Custom code block handling
    code({ node, className: codeClassName, children, ...props }) {
      const match = /language-(\w+)/.exec(codeClassName || '');
      const language = match ? match[1] : undefined;
      const codeString = String(children).replace(/\n$/, '');

      // Check if this is an inline code or a block
      const isInline = !codeClassName && !codeString.includes('\n');

      if (isInline) {
        return (
          <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-sm" {...props}>
            {children}
          </code>
        );
      }

      // Handle mermaid diagrams
      if (language === 'mermaid' && enableMermaid) {
        return <MermaidDiagram chart={codeString} zoomable={diagramZoomable} maxHeight={maxDiagramHeight} />;
      }

      // Handle regular code blocks
      if (enableSyntaxHighlight) {
        return <CodeBlock language={language}>{codeString}</CodeBlock>;
      }

      return (
        <pre className="overflow-auto p-4 rounded-lg bg-muted">
          <code className="font-mono text-sm" {...props}>
            {children}
          </code>
        </pre>
      );
    },

    // Custom pre handling (wrapper for code blocks)
    pre({ children }) {
      return <>{children}</>;
    },

    // Table styling for GFM
    table({ children }) {
      return (
        <div className="overflow-auto my-4">
          <table className="min-w-full border-collapse border border-border">{children}</table>
        </div>
      );
    },

    thead({ children }) {
      return <thead className="bg-muted">{children}</thead>;
    },

    th({ children }) {
      return <th className="border border-border px-4 py-2 text-left font-semibold">{children}</th>;
    },

    td({ children }) {
      return <td className="border border-border px-4 py-2">{children}</td>;
    },

    // Links open in the user's browser through the main process: the window
    // opens nothing itself (`setWindowOpenHandler` denies every popup), and an
    // href that fails the shared external-URL policy is not a link at all.
    a({ href, children }) {
      const external = externalHttpsUrl(href);
      if (!external) return <>{children}</>;
      return (
        <a
          href={external}
          className="text-primary underline underline-offset-2 hover:text-primary/80"
          onClick={(event) => {
            event.preventDefault();
            void window.electronAPI.openDeliveryExternal({ externalUrl: external });
          }}
        >
          {children}
        </a>
      );
    },

    // Task list styling
    input({ checked, ...props }) {
      return (
        <input type="checkbox" checked={checked} disabled className="mr-2 size-4 rounded border-border" {...props} />
      );
    },

    // Blockquote styling
    blockquote({ children }) {
      return (
        <blockquote className="border-l-4 border-muted-foreground/30 pl-4 my-4 italic text-muted-foreground">
          {children}
        </blockquote>
      );
    },

    // Horizontal rule
    hr() {
      return <hr className="my-6 border-border" />;
    },
  };

  return (
    <div className={`prose prose-sm dark:prose-invert max-w-none ${className || ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
