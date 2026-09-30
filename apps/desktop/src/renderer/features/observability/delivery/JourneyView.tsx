/**
 * Merged fact stream for one task (UC-4). Chronological across every loaded
 * collection, with long silences rendered as their own gap row so the list never
 * implies continuous activity it did not observe.
 *
 * Timestamps render in UTC to match the gantt axis and the population caption —
 * a host-local time here would disagree with the chart next to it.
 */

import { cn } from '../../../lib/utils';
import { formatDurationShort } from './delivery-presentation';
import { journeyRows, type TraceJourneyEvent, type TraceJourneyKind } from './trace-presentation';

const KIND_CLASS: Record<TraceJourneyKind, string> = {
  ref: 'bg-bg-tag-progress text-dodger-blue-500',
  stage: 'bg-bg-tag-success text-brand-600',
  // The PR family reads as the lavender wash (ADR-7); its own magenta ink is
  // unreadable on that wash, so the label keeps the neutral content ramp.
  code: 'bg-lavender-magenta-100 text-content-secondary',
  artifact: 'bg-card border border-border-input text-content-tertiary',
  rework: 'bg-bg-tag-info text-content-tag-info',
  ship: 'bg-content-brand text-content-inverted',
};

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function JourneyView({ events }: { events: ReadonlyArray<TraceJourneyEvent> }) {
  if (events.length === 0) {
    return <p className="py-2 text-xs text-content-quaternary">No facts loaded for this task yet.</p>;
  }
  return (
    <ol aria-label="Task journey" className="flex max-h-80 flex-col overflow-y-auto">
      {journeyRows(events).map((row) =>
        row.type === 'gap' ? (
          <li key={`gap-${row.id}`} className="flex items-center gap-2 py-0.5 text-[10.5px] text-content-quaternary">
            <span className="h-px flex-1 border-t border-dashed border-chart-axis" />
            {`+${formatDurationShort(row.ms)} gap`}
            <span className="h-px flex-1 border-t border-dashed border-chart-axis" />
          </li>
        ) : (
          <li
            key={`${row.event.kind}:${row.event.id}`}
            className="flex items-start gap-2.5 border-b border-border-input py-1.5 last:border-b-0"
          >
            <span
              className={cn(
                'mt-0.5 flex-none rounded px-1.5 text-[9.5px] font-semibold uppercase tracking-[0.03em]',
                KIND_CLASS[row.event.kind],
              )}
            >
              {row.event.kind}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-content-primary">{row.event.label}</span>
              {row.event.detail === null ? null : (
                <span className="block truncate text-[11px] text-content-quaternary">{row.event.detail}</span>
              )}
            </span>
            <span className="mt-0.5 shrink-0 whitespace-nowrap text-right text-[10.5px] tabular-nums text-content-quaternary">
              {stamp(row.event.at)}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}
