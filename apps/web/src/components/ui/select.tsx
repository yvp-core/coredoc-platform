import { ChevronDownIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@/lib/utils';

// Native <select>; `className` sizes the wrapper, the chevron replaces the platform arrow.
function Select({
  className,
  onValueChange,
  ...props
}: React.ComponentProps<'select'> & { onValueChange?: (value: string) => void }) {
  return (
    <span className={cn('relative flex h-8 w-full', className)}>
      <select
        className="size-full min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-border bg-surface pl-3 pr-8 text-[13.5px] text-ink-1 outline-none transition-colors hover:border-axis disabled:pointer-events-none disabled:opacity-50"
        onChange={(event) => onValueChange?.(event.target.value)}
        {...props}
      />
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-4" />
    </span>
  );
}

export { Select };
