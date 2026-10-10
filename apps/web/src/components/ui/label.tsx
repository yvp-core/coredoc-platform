import type * as React from 'react';

import { cn } from '@/lib/utils';

function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: call sites pass htmlFor or wrap the control
    <label
      className={cn(
        'flex items-center gap-2 text-[12.5px] font-normal text-ink-3 select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
