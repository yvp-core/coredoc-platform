import type * as React from 'react';

import { cn } from '@/lib/utils';

const VARIANT = {
  accepted: 'bg-brand-wash text-brand-text',
  candidate: 'bg-blue-wash text-blue',
  rejected: 'bg-danger-wash text-danger-text',
  superseded: 'bg-surface-2 text-ink-4 border border-border-soft',
  reason: 'bg-surface-2 text-ink-3 border border-border-soft',
  replace: 'bg-violet-wash text-violet-text',
  ok: 'bg-brand-wash text-brand-text',
  warn: 'bg-warn-wash text-warn-text',
  err: 'bg-danger-wash text-danger-text',
  info: 'bg-blue-wash text-blue',
  neutral: 'bg-surface-2 text-ink-3 border border-border-soft',
};

function Badge({
  className,
  variant = 'neutral',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof VARIANT | null }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-[7px] py-[0.5px] text-[11px] font-normal whitespace-nowrap',
        VARIANT[variant ?? 'neutral'],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
