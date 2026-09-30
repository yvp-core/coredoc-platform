import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export interface CompletedLeftPanelProps {
  open: boolean;
  children: ReactNode;
}

/**
 * The 256px contextual rail. Owns the card frame, the collapse transition and
 * the scroll container; the body is whatever the active tab supplies.
 *
 * One shell rather than a panel per tab: three collapsible components would be
 * three copies of the width constant, the easing curve and the scroll
 * behaviour, and they would drift.
 */
export function CompletedLeftPanel({ open, children }: CompletedLeftPanelProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 shrink-0 flex-col transition-[margin,opacity] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
        open ? 'ml-0 w-64 opacity-100 mr-4' : 'pointer-events-none -ml-64 w-64 opacity-0',
      )}
      aria-hidden={!open}
    >
      <div className="surface-b flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg border border-border-secondary">
        {children}
      </div>
    </div>
  );
}
