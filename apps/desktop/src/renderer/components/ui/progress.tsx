import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '../../lib/utils';

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indeterminate?: boolean }
>(({ className, value, indeterminate = false, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-bg-tertiary', className)}
    value={indeterminate ? null : value}
    {...props}
  >
    {indeterminate ? (
      <ProgressPrimitive.Indicator className="animate-indeterminate h-full w-1/4 rounded-full bg-bg-inverted-secondary" />
    ) : (
      <ProgressPrimitive.Indicator
        className="h-full w-full flex-1 rounded-full bg-bg-inverted-secondary transition-all"
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    )}
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
