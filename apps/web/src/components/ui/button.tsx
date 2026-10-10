import * as React from 'react';

import { cn } from '@/lib/utils';

const VARIANT = {
  default: 'bg-brand text-white hover:brightness-110',
  outline: 'border border-border bg-surface text-ink-2 hover:text-ink-1 hover:border-axis',
  ghost: 'text-ink-3 hover:bg-surface-2 hover:text-ink-1',
  destructive: 'bg-danger text-white hover:brightness-110',
};
const SIZE = {
  sm: 'h-7 px-3 text-[12.5px] rounded-md',
  default: 'h-8 px-3.5 text-[13.5px] rounded-lg',
  icon: 'size-8 rounded-lg',
};

interface ButtonVariants {
  variant?: keyof typeof VARIANT | null;
  size?: keyof typeof SIZE | null;
}

function buttonVariants({ variant, size }: ButtonVariants = {}) {
  return cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
    VARIANT[variant ?? 'default'],
    SIZE[size ?? 'default'],
  );
}

const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariants>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
