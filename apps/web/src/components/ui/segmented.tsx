import { cn } from '@/lib/utils';

export function Segmented<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn('inline-flex gap-0.5 rounded-lg border border-border bg-surface p-[2px]', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'rounded-md px-3 py-1 text-[12px] font-normal transition-colors',
              active ? 'bg-surface-2 text-ink-1 ring-1 ring-inset ring-border' : 'text-ink-3 hover:text-ink-1',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
