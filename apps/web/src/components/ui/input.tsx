import type * as React from 'react';

import { cn } from '@/lib/utils';

function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'w-full min-w-0 rounded-lg bg-surface-2 border border-border-soft px-3 py-1.5 text-[13.5px] text-ink-1 outline-none transition-colors placeholder:text-ink-4 hover:border-border focus-visible:border-brand disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
