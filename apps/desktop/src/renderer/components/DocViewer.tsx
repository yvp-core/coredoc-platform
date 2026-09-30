import { memo, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { ArrowLeft, Loader2, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Badge } from './ui/badge';
import { MarkdownRenderer } from './markdown';
import { useDocsStore } from '../stores/docs-store';
import type { DocFileInfo } from '../../shared/ipc-types';

/** Threshold (in characters) above which we enable lazy section rendering */
const LAZY_THRESHOLD = 8_000;
/** How many sections to render initially */
const INITIAL_SECTIONS = 5;
/** How many sections to add when a sentinel becomes visible */
const LOAD_MORE_COUNT = 3;

/**
 * Split markdown content into sections by top-level headings (# or ##).
 * Each section includes its heading line and all content until the next heading.
 */
function splitIntoSections(content: string): string[] {
  const lines = content.split('\n');
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    // Split on # or ## headings (not ### or deeper)
    if (/^#{1,2}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    sections.push(current.join('\n'));
  }
  return sections;
}

const MemoizedSection = memo(function MemoizedSection({ content }: { content: string }) {
  return (
    <MarkdownRenderer
      content={content}
      enableMermaid={true}
      enableSyntaxHighlight={true}
      diagramZoomable={true}
      maxDiagramHeight={400}
    />
  );
});

function LazyDocContent({ content }: { content: string }) {
  const sections = useMemo(() => splitIntoSections(content), [content]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_SECTIONS);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Reset visible count when content changes
  useEffect(() => {
    setVisibleCount(INITIAL_SECTIONS);
  }, []);

  const loadMore = useCallback(() => {
    setVisibleCount((prev) => Math.min(prev + LOAD_MORE_COUNT, sections.length));
  }, [sections.length]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const rendered = sections.slice(0, visibleCount);
  const hasMore = visibleCount < sections.length;

  return (
    <>
      {rendered.map((section, i) => (
        <MemoizedSection key={i} content={section} />
      ))}
      {hasMore && (
        <div ref={sentinelRef} className="py-8 text-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground mx-auto" />
        </div>
      )}
    </>
  );
}

interface DocViewerProps {
  onRegenerate?: (doc: DocFileInfo) => void;
  isRegenerating?: boolean;
}

export function DocViewer({ onRegenerate, isRegenerating = false }: DocViewerProps) {
  const selectedDoc = useDocsStore((s) => s.selectedDoc);
  const content = useDocsStore((s) => s.selectedDocContent);
  const isLoading = useDocsStore((s) => s.isLoadingContent);
  const goBack = useDocsStore((s) => s.goBackToList);

  if (!selectedDoc) return null;

  const isLargeDoc = content != null && content.length > LAZY_THRESHOLD;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={goBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{selectedDoc.title}</h2>
          <p className="text-xs text-muted-foreground truncate">{selectedDoc.relativePath}</p>
        </div>
        {onRegenerate && selectedDoc.promptName && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => onRegenerate(selectedDoc)}
            disabled={isRegenerating}
          >
            {isRegenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Regenerate
          </Button>
        )}
        <Badge variant="outline">{selectedDoc.repoName}</Badge>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : content ? (
        <ScrollArea className="h-[calc(100vh-212px)]">
          <div className="p-6 max-w-4xl">
            {isLargeDoc ? (
              <LazyDocContent content={content} />
            ) : (
              <MarkdownRenderer
                content={content}
                enableMermaid={true}
                enableSyntaxHighlight={true}
                diagramZoomable={true}
                maxDiagramHeight={400}
              />
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground">Failed to load document content.</p>
        </div>
      )}
    </div>
  );
}
