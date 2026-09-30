/**
 * The one card shell every Usage section uses: title + sub in a hairline head,
 * body below. Same recipe as `FeedbackPanel`'s private `Section` (which is not
 * exported), kept local to this directory rather than widening that module.
 */

import type { ReactNode } from 'react';
import { Card, CardContent } from '../../../components/ui/card';

export function UsageCard({
  title,
  sub,
  action,
  children,
  className,
}: {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card size="sm" className={`gap-0 py-0${className ? ` ${className}` : ''}`}>
      <div className="flex items-baseline justify-between gap-3 border-b border-border-tertiary px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-[13px] font-semibold text-content-primary">{title}</h3>
          {sub ? <span className="text-[11.5px] text-content-quaternary">{sub}</span> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <CardContent className="py-3">{children}</CardContent>
    </Card>
  );
}
