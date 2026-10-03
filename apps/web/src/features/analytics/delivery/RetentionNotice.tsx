/**
 * Retention notice for one task's trace: fine-event details older than the
 * policy window are purged, and the trace says so rather than rendering a
 * silent gap.
 */

import type { CanonicalTaskDetail } from '../types.js';

const UNAVAILABLE = 'Unavailable';

function timestamp(value: string | null): string {
  if (value === null) return UNAVAILABLE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function RetentionNotice({ retention }: { retention: CanonicalTaskDetail['fineEventRetention'] }) {
  // Nothing was purged yet, so there is no gap to explain.
  if (retention.purgedThroughReceivedAt === null) return null;
  return (
    <div className="rounded-lg border border-border-soft bg-surface-2 px-3 py-2.5 text-[12px] text-ink-2">
      <p>
        Fine-event details received through {timestamp(retention.purgedThroughReceivedAt)} are unavailable under the
        90-day retention policy. Durable delivery facts remain available.
      </p>
    </div>
  );
}
