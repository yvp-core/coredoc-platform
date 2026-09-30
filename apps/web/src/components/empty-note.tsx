import type { ReactNode } from 'react';

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-center text-[12px] text-ink-4">{children}</div>;
}
