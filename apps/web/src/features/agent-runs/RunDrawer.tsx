import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';

export function RunDrawer({
  title,
  actions,
  onClose,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[540px] flex-col bg-surface shadow-card outline-none"
        >
          <header className="flex items-center gap-2 border-b border-border-soft px-4 pt-[calc(env(safe-area-inset-top,0px)+14px)] pb-3">
            <DialogPrimitive.Title className="mr-auto text-[14px] font-semibold text-ink-1">
              {title}
            </DialogPrimitive.Title>
            {actions}
            <DialogPrimitive.Close
              aria-label="Close"
              className="rounded-md border border-border p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
            >
              <XIcon className="size-3.5" />
            </DialogPrimitive.Close>
          </header>
          <div className="flex flex-col gap-2 overflow-auto px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
