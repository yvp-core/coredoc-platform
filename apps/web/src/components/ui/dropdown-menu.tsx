import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[9rem] overflow-hidden rounded-lg border border-border bg-surface p-1 text-ink-1 shadow-card data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] text-ink-2 outline-none transition-colors data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink-1 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0',
        variant === 'destructive' && 'text-danger-text data-[highlighted]:text-danger-text',
        className,
      )}
      {...props}
    />
  );
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem };
