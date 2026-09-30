import type * as React from 'react';

import { cn } from '@/lib/utils';

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('bg-surface border border-border rounded-xl shadow-card overflow-hidden', className)}
      {...props}
    />
  );
}

function CardHead({
  title,
  sub,
  right,
  className,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-3 px-4 pt-3 pb-2.5 border-b border-border-soft',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-normal text-ink-1">{title}</div>
        {sub ? <div className="text-[11.5px] text-ink-4 mt-px">{sub}</div> : null}
      </div>
      {right ? <div className="flex items-center gap-2 shrink-0">{right}</div> : null}
    </div>
  );
}

function CardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export { Card, CardHead, CardBody };
