/**
 * Merged fact stream for one task. Chronological across every loaded
 * collection, with long silences rendered as their own gap row so the list never
 * implies continuous activity it did not observe.
 *
 * Timestamps render in UTC to match the gantt axis and the population caption.
 */

import { cn } from '@/lib/utils';
import { formatDurationShort } from './delivery-presentation.js';
import { type TraceJourneyEvent, type TraceJourneyKind, journeyRows } from './trace-presentation.js';

const KIND_CLASS: Record<TraceJourneyKind, string> = {
  ref: 'bg-blue-wash text-blue',
  stage: 'bg-brand-wash text-brand-text',
  code: 'bg-violet-wash text-violet-text',
  artifact: 'bg-surface border border-border-soft text-ink-3',
  rework: 'bg-rework-wash text-rework-text',
  ship: 'bg-brand text-white',
};

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function JourneyView({ events }: { events: ReadonlyArray<TraceJourneyEvent> }) {
  if (events.length === 0) {
    return <p className="py-2 text-[13px] text-ink-4">No facts loaded for this task yet.</p>;
  }
  return (
    <ol aria-label="Task journey" className="flex max-h-80 flex-col overflow-y-auto">
      {journeyRows(events).map((row) =>
        row.type === 'gap' ? (
          <li key={`gap-${row.id}`} className="flex items-center gap-2 py-0.5 text-[11.5px] text-ink-4">
            <span className="h-px flex-1 border-t border-dashed border-axis" />
            {`+${formatDurationShort(row.ms)} gap`}
            <span className="h-px flex-1 border-t border-dashed border-axis" />
          </li>
        ) : (
          <li
            key={`${row.event.kind}:${row.event.id}`}
            className="flex items-start gap-2.5 border-b border-border-soft py-1.5 last:border-b-0"
          >
            <span
              className={cn(
                'mt-0.5 flex-none rounded px-1.5 text-[10.5px] uppercase tracking-[0.03em]',
                KIND_CLASS[row.event.kind],
              )}
            >
              {row.event.kind}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink-1">{row.event.label}</span>
              {row.event.detail === null ? null : (
                <span className="block truncate text-[12px] text-ink-4">{row.event.detail}</span>
              )}
            </span>
            <span className="num mt-0.5 shrink-0 whitespace-nowrap text-right text-[11.5px] text-ink-4">
              {stamp(row.event.at)}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}
