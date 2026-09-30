import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
// import { Check, Copy } from 'lucide-react';
// import { Button } from '../ui/button';

interface CodeBlockProps {
  language?: string;
  children: string;
  className?: string;
}

export function CodeBlock({ language, children, className }: CodeBlockProps) {
  const [_copied] = useState(false);

  // Detect dark mode from document class
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const displayLanguage = language || 'text';

  return (
    <div className={`relative group rounded-lg overflow-hidden ${className || ''}`}>
      {/* Header with language badge */}
      <div className="flex items-center justify-between px-4 py-2 bg-bg-inverted-secondary dark:bg-bg-inverted-secondary border-b border-border-inverted">
        <span className="text-xs font-medium text-content-quaternary uppercase">{displayLanguage}</span>
        {/* <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 text-content-quaternary hover:text-content-inverted opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copy
            </>
          )}
        </Button> */}
      </div>

      {/* Code content */}
      <SyntaxHighlighter
        language={displayLanguage}
        style={isDark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          padding: '1rem',
          fontSize: '0.875rem',
          lineHeight: '1.5',
          background: isDark ? 'var(--color-bg-inverted-secondary)' : 'var(--color-bg-input)',
        }}
        codeTagProps={{
          style: {
            fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Fira Code', monospace",
          },
        }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}
