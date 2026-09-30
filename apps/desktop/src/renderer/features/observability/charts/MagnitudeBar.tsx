/**
 * Horizontal magnitude bar for ranked lists (tool usage, rework pareto, member
 * reach). A bar-in-a-track is not a chart: it is a proportion cue beside the
 * number that already carries the value, so it has no axis and no legend.
 */

import { cn } from '../../../lib/utils';
import { magnitudeWidth } from './chart-geometry';

export type MagnitudeTone = 'brand' | 'muted' | 'rework' | 'danger';

const TONE_FILL: Record<MagnitudeTone, string> = {
  brand: 'var(--color-content-brand)',
  muted: 'var(--color-content-quaternary)',
  rework: 'var(--color-content-tag-info)',
  danger: 'var(--color-bg-warning)',
};

export function MagnitudeBar({
  value,
  max,
  minPct = 1.5,
  tone = 'brand',
  height = 6,
  className,
}: {
  value: number;
  max: number;
  /** Floor (in %) so a non-zero value stays visible; an exact zero still renders empty. */
  minPct?: number;
  tone?: MagnitudeTone;
  height?: number;
  className?: string;
}) {
  const width = magnitudeWidth(value, max, minPct);
  return (
    <div
      aria-hidden="true"
      className={cn('w-full overflow-hidden rounded-full bg-bg-tertiary', className)}
      style={{ height }}
    >
      <div className="h-full rounded-full" style={{ width: `${width}%`, background: TONE_FILL[tone] }} />
    </div>
  );
}
