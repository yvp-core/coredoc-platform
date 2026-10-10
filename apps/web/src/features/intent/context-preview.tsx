// "Preview as": the panel owns the choice (component state, never persisted).

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Chip } from './items-list.js';
import type { DimensionValueSelection, IntentDimension } from './types.js';

interface IntentContextPreviewProps {
  dimensions: readonly IntentDimension[] | null;
  value: DimensionValueSelection;
  onChange: (next: DimensionValueSelection) => void;
  /** `null` while no value is chosen; otherwise how many scanned rules the context dropped. */
  hiddenCount: number | null;
  /** True once more than one page has loaded: `hiddenCount` is then a lower bound, not exact. */
  hiddenCountIsLowerBound?: boolean;
  /** Browse filters the context read cannot apply, named so the preview does not overclaim. */
  ignoredFilters: readonly string[];
}

export function IntentContextPreview({
  dimensions,
  value,
  onChange,
  hiddenCount,
  hiddenCountIsLowerBound = false,
  ignoredFilters,
}: IntentContextPreviewProps) {
  if (!dimensions || dimensions.length === 0) return null;

  const set = (dimension: string, next: string | string[] | null) => {
    const copy = { ...value };
    if (next === null) delete copy[dimension];
    else copy[dimension] = next;
    onChange(copy);
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-border-soft px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-4">Preview as</span>
        {dimensions.map((dimension) => {
          const chosen = value[dimension.id];
          if (dimension.multi) {
            const values = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
            // `[]` ("none of these") is a real context, distinct from the dimension being absent (open).
            const none = Array.isArray(chosen) && chosen.length === 0;
            return (
              <fieldset key={dimension.id} aria-label={dimension.title} className="flex flex-wrap gap-1">
                <span className="text-[12px] text-ink-3">{dimension.title}:</span>
                <Chip pressed={none} label="None" onClick={() => set(dimension.id, none ? null : [])} />
                {dimension.values.map((option) => (
                  <Chip
                    key={option.id}
                    pressed={values.includes(option.id)}
                    label={option.title}
                    onClick={() =>
                      set(
                        dimension.id,
                        values.includes(option.id)
                          ? values.length === 1
                            ? null
                            : values.filter((entry) => entry !== option.id)
                          : [...values, option.id],
                      )
                    }
                  />
                ))}
              </fieldset>
            );
          }
          return (
            <Select
              key={dimension.id}
              value={typeof chosen === 'string' ? chosen : ''}
              onValueChange={(next) => set(dimension.id, next || null)}
              aria-label={dimension.title}
              className="h-7 w-[150px]"
            >
              <option value="">Any {dimension.title.toLowerCase()}</option>
              {dimension.values.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </Select>
          );
        })}
        {hiddenCount !== null && (
          <Button variant="ghost" size="sm" className="px-2" onClick={() => onChange({})}>
            Clear preview
          </Button>
        )}
      </div>
      {hiddenCount !== null && (
        <p className="text-[12px] text-ink-3">
          {hiddenCountIsLowerBound
            ? `at least ${hiddenCount} rule${hiddenCount === 1 ? '' : 's'} hidden`
            : hiddenCount === 1
              ? '1 rule hidden'
              : `${hiddenCount} rules hidden`}{' '}
          by these conditions
        </p>
      )}
      {hiddenCount !== null && ignoredFilters.length > 0 && (
        <p className="text-[12px] text-ink-4">Not applied in preview: {ignoredFilters.join(', ')}.</p>
      )}
    </div>
  );
}
