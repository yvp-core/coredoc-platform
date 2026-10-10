import { cn } from '@/lib/utils';

interface PillTabItem<T extends string> {
  value: T;
  label: string;
  count?: number;
  disabled?: boolean;
  title?: string;
}

export function PillTabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  items: PillTabItem<T>[];
  className?: string;
}) {
  return (
    <div className={cn('inline-flex gap-[3px] rounded-full border border-border bg-surface p-[3px]', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            title={item.title}
            disabled={item.disabled}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-[7px] rounded-full px-[18px] py-[5px] text-[13.5px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
              active ? 'bg-brand-wash text-brand-text' : 'text-ink-3 hover:text-ink-1',
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className="num rounded-full bg-blue-wash px-[7px] text-[11.5px] text-blue">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
