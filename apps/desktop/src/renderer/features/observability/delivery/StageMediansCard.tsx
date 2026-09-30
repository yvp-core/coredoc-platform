/**
 * "Where the time goes" (UC-3): median claimed time per stage over the matching
 * population, the unclaimed remainder, and the two review facts. Every value is
 * a sampled median (BR-11) — the dash plus its "n of N" caption is the honest
 * rendering of an empty sample, never a zero bar.
 */

import type { CanonicalDeliverySummary } from '../../../../shared/ipc-types.js';
import { DeliveryCard } from './DeliveryCard';
import { formatCountValue, sampledMedianText, stageBarEntries } from './delivery-presentation';
import { StageBars } from './StageBars';

function Fact({ label, text, caption }: { label: string; text: string; caption: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="text-xs text-content-tertiary">{label}</span>
      <span className="whitespace-nowrap text-right">
        <span className="text-[12.5px] font-semibold tabular-nums text-content-primary">{text}</span>
        {caption === null ? null : <span className="ml-1.5 text-[10.5px] text-content-quaternary">{caption}</span>}
      </span>
    </div>
  );
}

export function StageMediansCard({ summary }: { summary: CanonicalDeliverySummary }) {
  const matching = summary.tasks.matching;
  const reviewWait = sampledMedianText(summary.reviewWaitMs, matching);
  const rounds = sampledMedianText(summary.editVerifyRoundsPerRun, matching, formatCountValue);

  return (
    <DeliveryCard
      title="Where the time goes"
      sub="Median claimed time per stage across matching tasks · from stage occurrence intervals"
    >
      <StageBars entries={stageBarEntries(summary)} ariaLabel="Median claimed time per stage" />
      <div className="mt-3 flex flex-col border-t border-border-input pt-2">
        <Fact label="Median wait: PR ready → first review" text={reviewWait.text} caption={reviewWait.caption} />
        <Fact label="Median edit-verify rounds / run" text={rounds.text} caption={rounds.caption} />
      </div>
    </DeliveryCard>
  );
}
