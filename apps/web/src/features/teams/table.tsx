import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The design artifact's `table.members` treatment. Shared by the members,
 * tokens and connectors tables — first column left-aligned, everything else
 * right-aligned tabular numbers, soft dividers, row hover.
 */
export function Table({ minWidth, children }: { minWidth?: number; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]" style={minWidth ? { minWidth } : undefined}>
        {children}
      </table>
    </div>
  );
}

export function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-border-soft px-3 pb-[7px] text-right text-[11.5px] font-normal uppercase tracking-[0.04em] text-ink-4 first:pl-0 first:text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Tr({ className, children }: { className?: string; children: ReactNode }) {
  return <tr className={cn('group [&:last-child>td]:border-b-0', className)}>{children}</tr>;
}

export function Td({ className, colSpan, children }: { className?: string; colSpan?: number; children?: ReactNode }) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'num border-b border-border-soft px-3 py-2 text-right align-middle text-ink-2 transition-colors group-hover:bg-surface-2 first:pl-0 first:text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}
