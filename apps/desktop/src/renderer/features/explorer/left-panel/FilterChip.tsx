import { cn } from '../../../lib/utils';

export interface FilterChipProps {
  label: string;
  /** null renders "—": the tally is unknown, which is not the same as zero. */
  count?: number | null;
  /** Dot colour; omitted for chips that are not type-coded. */
  color?: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  /** The last load for this chip failed — surfaced, never silent. */
  error?: boolean;
  onToggle: () => void;
}

/** One toggleable pill in the explorer's left panel. */
export function FilterChip({ label, count, color, active, disabled, title, error, onToggle }: FilterChipProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1 rounded-2xl border py-1 pl-2.5 pr-2 text-xs font-bold leading-4 transition-colors',
        disabled ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-content-quaternary-disabled' : 'cursor-pointer',
        error
          ? 'border-content-tag-warning bg-bg-tag-warning text-content-primary'
          : active
            ? 'border-transparent bg-gray-300 text-content-secondary'
            : 'border-gray-200 bg-gray-100 text-content-secondary hover:border-gray-300',
      )}
    >
      {color && <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 font-medium tabular-nums text-content-quaternary">
          {count === null ? '—' : count.toLocaleString()}
        </span>
      )}
    </button>
  );
}
