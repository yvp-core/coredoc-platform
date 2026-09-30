import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Sparkline } from './sparkline';

export function KpiCard({
  label,
  value,
  delta,
  hint,
  spark,
}: {
  label: string;
  value: ReactNode;
  delta?: { pct: number };
  hint?: ReactNode;
  spark?: number[];
}) {
  const dir = delta ? (delta.pct > 0 ? 'up' : delta.pct < 0 ? 'down' : 'flat') : undefined;

  return (
    <div
      className={cn(
        'relative flex min-h-[108px] flex-col overflow-hidden rounded-xl border border-border bg-surface px-3.5 pt-3 shadow-card',
        // The sparkline is absolute at the bottom; reserve its height so a hint never sits on the stroke.
        spark && 'pb-[34px]',
      )}
    >
      <div className="text-[11.5px] text-ink-4">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <div className="num text-[24px] font-medium tracking-[-0.02em] text-ink-1">{value}</div>
        {delta ? (
          <div
            className={cn(
              'num text-[11.5px]',
              dir === 'up' && 'text-brand-text',
              dir === 'down' && 'text-danger-text',
              dir === 'flat' && 'text-ink-4',
            )}
          >
            {delta.pct > 0 ? '+' : ''}
            {delta.pct.toFixed(0)}%
          </div>
        ) : null}
      </div>
      {hint ? <div className="text-[11px] text-ink-4">{hint}</div> : null}
      {spark ? (
        <Sparkline data={spark} className="absolute inset-x-0 bottom-0 block h-[34px] w-full opacity-85" />
      ) : null}
    </div>
  );
}
