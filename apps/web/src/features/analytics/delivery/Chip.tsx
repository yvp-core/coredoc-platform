/**
 * The one chip recipe on the Delivery surface (task meta, trace header). It is
 * deliberately not `ui/badge`: badges are the semantic state matrix, while these
 * are dense identity/meta pills inside a scrolling list.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ChipTone = 'default' | 'completed' | 'active' | 'abandoned' | 'partial' | 'rework';

const TONE_CLASS: Record<ChipTone, string> = {
  default: 'bg-surface-2 border-border-soft text-ink-3',
  completed: 'bg-brand-wash border-transparent text-brand-text',
  active: 'bg-blue-wash border-transparent text-blue',
  abandoned: 'bg-surface-2 border-border-soft text-ink-4',
  // Partial ship is deliberately not the brand wash the shipped/completed chip uses.
  partial: 'bg-warn-wash border-transparent text-warn-text',
  rework: 'bg-rework-wash border-transparent text-rework-text',
};

export function Chip({
  tone = 'default',
  mono = false,
  title,
  children,
}: {
  tone?: ChipTone;
  mono?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        'num inline-flex items-center rounded-full border px-[7px] text-[10.5px]',
        TONE_CLASS[tone],
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  );
}

/** Lifecycle is a closed set on the canonical task. */
export function lifecycleTone(lifecycle: 'active' | 'completed' | 'abandoned'): ChipTone {
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'active') return 'active';
  return 'abandoned';
}
