/**
 * Rework pareto (UC-3, BR-9): recorded rework signals per source. The note is part
 * of the card, not decoration — these are recorded sequences, and reading a cause
 * into them is exactly what the blameless ADR rules out.
 */

import type { CanonicalDeliverySummary } from '../../../../shared/ipc-types.js';
import { MagnitudeBar } from '../charts/MagnitudeBar';
import { DeliveryCard } from './DeliveryCard';
import { reworkEntries } from './delivery-presentation';

export function ReworkCard({ summary }: { summary: CanonicalDeliverySummary }) {
  const entries = reworkEntries(summary);
  const max = Math.max(...entries.map((entry) => entry.count), 1);

  return (
    <DeliveryCard title="Rework signals" sub="Tracker reopens and review turns · non-causal facts">
      <section aria-label="Rework signals by source" className="flex flex-col gap-2">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className="grid grid-cols-[minmax(120px,max-content)_1fr_max-content] items-center gap-3"
          >
            <div className="truncate text-right text-xs text-content-secondary">
              <span title={`${entry.count} signals across ${entry.tasks} tasks`}>{entry.name}</span>
            </div>
            <MagnitudeBar value={entry.count} max={max} tone="rework" height={14} className="rounded" />
            <div className="min-w-[24px] text-right text-xs font-semibold tabular-nums text-content-primary">
              {entry.count}
            </div>
          </div>
        ))}
      </section>
      <p className="mt-2.5 text-[11px] text-content-quaternary">
        Rework is counted from three sources: a tracker reopen, a review that requested changes, and a review that
        commented before further commits. Sequences are recorded, causes are not inferred.
      </p>
    </DeliveryCard>
  );
}
