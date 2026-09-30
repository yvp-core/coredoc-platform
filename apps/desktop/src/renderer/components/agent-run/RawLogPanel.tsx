import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Collapsible raw transcript — the debugging escape hatch. Hidden by default so the main UI stays
 * clean; when open it shows the full structured event log and auto-scrolls to the newest line.
 */
export function RawLogPanel({ rawLog, defaultOpen = false }: { rawLog: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [open, rawLog]);

  return (
    <div className="border-t border-border-input pt-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-xs text-content-tertiary hover:text-content-secondary"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          {open ? 'Hide raw log' : 'View raw log'}
        </button>
        {open && rawLog && (
          <button
            type="button"
            onClick={() => navigator.clipboard?.writeText(rawLog)}
            className="flex items-center gap-1 text-xs text-content-tertiary hover:text-content-secondary"
          >
            <Copy className="size-3" />
            Copy
          </button>
        )}
      </div>
      {open && (
        <pre
          ref={preRef}
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-primary-selected p-3 font-mono text-[11px] leading-relaxed text-content-secondary"
        >
          {rawLog || '(no output yet)'}
        </pre>
      )}
    </div>
  );
}
