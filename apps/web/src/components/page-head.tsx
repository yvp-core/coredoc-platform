import type { ReactNode } from 'react';

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.06em] text-ink-4">Coredoc Cloud</div>
        <h1 className="mt-0.5 text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-1">{title}</h1>
        {sub ? <div className="mt-[3px] flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">{sub}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
