/**
 * Stage duration rows — the same recipe for the workspace medians and for one
 * task's claimed time.
 *
 * `MagnitudeBar` is the shared bar-in-a-track, but its fill is a fixed four-tone
 * set; these rows need the sequential stage ramp per row, so the fill carries the
 * entry's token inline. The geometry still comes from `magnitudeWidth`.
 */

import { magnitudeWidth } from '../charts/chart-geometry.js';
import type { StageBarEntry } from './delivery-presentation.js';

export function StageBars({ entries, ariaLabel }: { entries: ReadonlyArray<StageBarEntry>; ariaLabel: string }) {
  const max = Math.max(...entries.map((entry) => entry.ms), 1);
  return (
    <section aria-label={ariaLabel} className="flex flex-col gap-2">
      {entries.map((entry) => (
        <div key={entry.key} className="grid grid-cols-[96px_1fr_max-content] items-center gap-3">
          <div className="truncate text-right text-[12px] text-ink-2">
            <span className={entry.mono ? 'font-mono text-[11.5px]' : undefined} title={entry.name}>
              {entry.name}
            </span>
          </div>
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-track">
            <div
              className="h-full rounded-full"
              style={{ width: `${magnitudeWidth(entry.ms, max, 1.5)}%`, background: entry.color }}
            />
          </div>
          <div className="min-w-[44px] text-right">
            <div className="num text-[12px] text-ink-1">{entry.text}</div>
            {entry.caption === null ? null : <div className="text-[10px] text-ink-4">{entry.caption}</div>}
          </div>
        </div>
      ))}
    </section>
  );
}
