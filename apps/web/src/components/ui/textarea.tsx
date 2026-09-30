import type * as React from 'react';

import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full min-h-16 resize-none rounded-lg bg-surface-2 border border-border-soft px-3 py-2 text-[12.5px] text-ink-1 outline-none transition-colors placeholder:text-ink-4 hover:border-border focus-visible:border-brand disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
