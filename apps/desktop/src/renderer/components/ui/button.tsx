import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '../../lib/utils';

const buttonVariants = cva(
  "focus-visible:border-ring cursor-pointer focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 border border-transparent bg-clip-padding text-xs/relaxed font-medium focus-visible:ring-2 aria-invalid:ring-2 [&_svg:not([class*='size-'])]:size-4 inline-flex items-center justify-center whitespace-nowrap transition-all disabled:pointer-events-none [&_svg]:pointer-events-none shrink-0 [&_svg]:shrink-0 outline-none group/button select-none",
  {
    variants: {
      variant: {
        default:
          'bg-bg-action-primary text-content-action-primary border-border-action shadow-action hover:bg-bg-action-primary-hover hover:border-border-action-hover disabled:bg-bg-action-primary-disabled disabled:border-transparent disabled:shadow-none',
        brand: 'bg-[#079467] text-white shadow-action hover:bg-[#12B981] disabled:bg-[#079467]/50 disabled:shadow-none',
        // The design's tertiary button is a WHITE card, not a transparent one: white
        // fill, a near-white `gray-50` hairline, radius 8 (spec `03-project-drawer.md`
        // §B.5, "Edit repositories"). Transparent left it reading as an outline ring
        // over whatever it happened to sit on, which is how "Add local repository" and
        // its siblings started looking hollow.
        outline:
          'bg-bg-primary font-semibold shadow-surface border-border-action-secondary text-content-primary hover:bg-bg-primary-hover hover:text-content-action-secondary-hover disabled:bg-bg-primary disabled:border-border-input-disabled disabled:shadow-none disabled:text-content-action-secondary-disabled',
        // Transparent with a border, and NO backdrop-blur. The variant sets no
        // background on purpose, but a 10px backdrop-filter over the dialog's own
        // white-gradient surface flattened what is behind the button into an even,
        // near-white patch — a fill in everything but the class list. That is what
        // made Cancel read as solid white against a translucent panel.
        secondary:
          'text-content-primary border-border-action-hover shadow-action hover:border-border-action hover:text-content-action-secondary-hover disabled:border-border-action-disabled disabled:shadow-none disabled:text-content-action-secondary-disabled',
        ghost:
          'backdrop-blur-[10px] text-content-primary hover:text-content-secondary aria-expanded:text-content-secondary disabled:text-content-quaternary',
        destructive:
          'bg-bg-warning text-content-action-primary shadow-action hover:bg-bg-warning-hover disabled:bg-bg-warning-disabled disabled:shadow-none disabled:pointer-events-none',
        link: 'text-primary underline-offset-4 hover:underline',
        wrapper:
          'h-6 w-4 text-content-primary hover:bg-bg-primary-hover disabled:bg-bg-primary-selected disabled:opacity-100 disabled:shadow-none',
      },
      size: {
        default:
          "h-9 gap-2 px-4 rounded-lg   text-sm/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-5 gap-1 px-2 rounded-sm   text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-7 gap-1 px-3 rounded-lg   text-sm/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1 px-2.5 rounded-lg text-lg/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
        'icon-xs': "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-2.5",
        'icon-sm': "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        'icon-lg': "size-8 rounded-sm [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
    }
>(({ className, variant = 'default', size = 'default', asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
