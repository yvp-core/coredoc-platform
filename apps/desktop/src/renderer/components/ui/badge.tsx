import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'gap-1 rounded-md border border-transparent px-1.5 py-1 text-xs font-semibold leading-4 tracking-normal transition-all [&>svg]:size-3! inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:shrink-0 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive overflow-hidden group/badge',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-bg-warning/10 [a]:hover:bg-bg-warning/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-content-warning dark:bg-bg-warning/20',
        outline:
          'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/20 dark:bg-input/30',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',

        initial: 'bg-bg-tag-initial text-content-secondary',
        success: 'bg-bg-tag-success text-content-secondary [a]:hover:bg-bg-tag-success/80',
        warning: 'bg-amber-200 text-content-secondary [a]:hover:bg-amber-200/80',
        error: 'bg-bg-warning text-content-secondary [a]:hover:bg-bg-warning/80',
        info: 'bg-bg-tag-progress text-content-secondary [a]:hover:bg-bg-tag-progress/80',
        outlineInitial: 'border border-content-tertiary bg-transparent text-content-tertiary',
        outlineSuccess: 'border border-content-brand bg-transparent text-content-brand',
        outlineInfo: 'border border-dodger-blue-500 bg-transparent text-dodger-blue-500',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp data-slot="badge" data-variant={variant} className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
