/**
 * The one segmented-control recipe on the Analytics tab (day window, metric
 * switch, delivery lifecycle filter). One recipe, one control: a second pill
 * style would read as a second kind of control (DESIGN.md, "a state that should
 * not exist"). The view switch is a `Tabs` pill and is deliberately not this.
 */

import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

export interface SegmentedOption<T> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    // `fieldset` rather than a `role="group"` div: same grouping semantics, and
    // Tailwind preflight already zeroes the UA border/padding this recipe replaces.
    <fieldset
      aria-label={ariaLabel}
      className={cn('flex items-center rounded-full border border-border-input bg-card p-0.5 text-xs', className)}
    >
      {options.map((option) => (
        <Button
          key={String(option.value)}
          type="button"
          variant={value === option.value ? 'default' : 'ghost'}
          size="xs"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className="rounded-full"
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}
