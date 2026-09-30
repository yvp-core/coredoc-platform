/**
 * Rework pareto by source: tracker reopens and review-driven revisions as counts.
 * The note is part of the card, not decoration — these are recorded sequences, and
 * reading a cause into them is exactly what the blameless rule rules out.
 */

import { Card, CardBody, CardHead } from '@/components/ui/card';
import { MagnitudeBar } from '../charts/MagnitudeBar.js';
import type { CanonicalDeliverySummary } from '../types.js';
import { reworkEntries } from './delivery-presentation.js';

export function ReworkCard({ summary }: { summary: CanonicalDeliverySummary }) {
  const entries = reworkEntries(summary);
  const max = Math.max(...entries.map((entry) => entry.count), 1);

  return (
    <Card>
      <CardHead title="Rework signals" sub="Tracker reopens and review-driven revisions · non-causal facts" />
      <CardBody>
        <section aria-label="Rework signals by source" className="flex flex-col gap-2">
          {entries.length === 0 ? (
            <p className="text-[12px] text-ink-4">This server does not report rework by source.</p>
          ) : null}
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="grid grid-cols-[minmax(120px,max-content)_1fr_max-content] items-center gap-3"
            >
              <div className="truncate text-right text-[12px] text-ink-2">
                <span title={`${entry.name} · ${entry.tasks} tasks`}>{entry.name}</span>
              </div>
              <MagnitudeBar value={entry.count} max={max} tone="rework" height={6} />
              <div className="num min-w-[24px] text-right text-[12px] text-ink-1">{entry.count}</div>
            </div>
          ))}
        </section>
        <p className="mt-2.5 text-[11px] text-ink-4">
          Counted sources: a tracker reopen, a review that requested changes, and a review comment followed by new
          commits. Stage re-entries are iteration, not rework. Sequences are recorded, causes are not inferred.
        </p>
      </CardBody>
    </Card>
  );
}
