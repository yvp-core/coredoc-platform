import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const RESET_MS = 2000;

/**
 * A code surface with a copy button. A clipboard write can reject (blocked
 * permission, insecure context) — that surfaces as "Copy failed" rather than a
 * silent no-op, because the value may be a token the user only sees once.
 */
export function CopyBlock({ value, label, filename }: { value: string; label: string; filename?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (timer.current !== null) clearTimeout(timer.current);
    let next: 'copied' | 'failed';
    try {
      await navigator.clipboard.writeText(value);
      next = 'copied';
    } catch {
      next = 'failed';
    }
    setStatus(next);
    timer.current = setTimeout(() => setStatus('idle'), RESET_MS);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-surface-2">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-1.5">
        <span className="truncate font-mono text-[12.5px] text-ink-4">{filename ?? label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={status === 'idle' ? label : `${status === 'copied' ? 'Copied' : 'Copy failed'} — ${label}`}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors ${
            status === 'failed' ? 'text-danger-text' : 'text-ink-3 hover:bg-surface hover:text-ink-1'
          }`}
        >
          {status === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
          {status === 'idle' ? 'Copy' : status === 'copied' ? 'Copied' : 'Copy failed'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed text-ink-2">{value}</pre>
    </div>
  );
}
