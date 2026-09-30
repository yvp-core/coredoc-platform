/**
 * The one chip recipe on the Delivery surface (task meta, trace header). It is
 * deliberately not `components/ui/badge`: badges are the semantic state matrix,
 * while these are dense identity/meta pills inside a scrolling list, tuned to
 * the POC's 10.5px face (ADR-7 token mapping).
 */

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export type ChipTone = 'default' | 'completed' | 'active' | 'abandoned' | 'rework' | 'partial';

const TONE_CLASS: Record<ChipTone, string> = {
  default: 'bg-bg-primary-hover border-border-input text-content-tertiary',
  completed: 'bg-bg-tag-success border-transparent text-brand-600',
  active: 'bg-bg-tag-progress border-transparent text-dodger-blue-500',
  abandoned: 'bg-bg-primary-hover border-border-input text-content-quaternary',
  rework: 'bg-bg-tag-info border-transparent text-content-tag-info',
  // Partly shipped is not shipped: the amber tag family keeps it legible next to
  // the success chip without borrowing its "done" reading.
  partial: 'bg-bg-tag-warning border-transparent text-content-tag-warning',
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
        'inline-flex items-center rounded-full border px-[7px] text-[10.5px] tabular-nums',
        TONE_CLASS[tone],
        mono && 'font-mono',
      )}
    >
      {children}
    </span>
  );
}

/** Lifecycle is a closed set on the canonical task; anything else is not reachable from the contract. */
export function lifecycleTone(lifecycle: 'active' | 'completed' | 'abandoned'): ChipTone {
  if (lifecycle === 'completed') return 'completed';
  if (lifecycle === 'active') return 'active';
  return 'abandoned';
}
