/**
 * The card head recipe the Delivery view repeats (title + subtitle over a
 * hairline, body below). Header content differs per card, so the header slot is
 * open rather than forced through the title/sub props.
 */

import type { ReactNode } from 'react';
import { Card, CardContent } from '../../../components/ui/card';
import { cn } from '../../../lib/utils';

export function DeliveryCardHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-input px-4 pb-2.5 pt-3">
      {children}
    </div>
  );
}

export function DeliveryCard({
  title,
  sub,
  bodyClassName,
  children,
}: {
  title: string;
  sub?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="gap-0 overflow-hidden py-0">
      <DeliveryCardHead>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-content-primary">{title}</div>
          {sub === undefined ? null : <div className="mt-px text-[11.5px] text-content-quaternary">{sub}</div>}
        </div>
      </DeliveryCardHead>
      <CardContent className={cn('px-4 pb-4 pt-3.5', bodyClassName)}>{children}</CardContent>
    </Card>
  );
}
