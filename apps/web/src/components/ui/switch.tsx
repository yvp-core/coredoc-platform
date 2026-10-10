import type * as React from 'react';

import { cn } from '@/lib/utils';

// Native checkbox with switch semantics; the sibling span is the thumb.
function Switch({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <span className={cn('relative inline-flex shrink-0 has-[:disabled]:opacity-50', className)}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        className="peer h-[17px] w-[29px] cursor-pointer appearance-none rounded-full border border-transparent bg-track transition-colors checked:bg-brand disabled:cursor-not-allowed"
        {...props}
      />
      <span className="pointer-events-none absolute left-px top-[2px] size-[13px] translate-x-[2px] rounded-full bg-surface shadow-card transition-transform peer-checked:translate-x-[14px]" />
    </span>
  );
}

export { Switch };
