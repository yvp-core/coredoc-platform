/**
 * "Where the time goes": median claimed time per stage over the matching
 * population, the unclaimed remainder, and the two review facts. Every value is
 * a sampled median — the dash plus its "n of N" caption is the honest rendering
 * of an empty sample, never a zero bar.
 */

import { Card, CardBody, CardHead } from '@/components/ui/card';
import { StageBars } from './StageBars.js';
import type { CanonicalDeliverySummary } from '../types.js';
import { formatCountValue, sampledMedianText, stageBarEntries } from './delivery-presentation.js';

function Fact({ label, text, caption }: { label: string; text: string; caption: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="text-[12px] text-ink-3">{label}</span>
      <span className="whitespace-nowrap text-right">
        <span className="num text-[12.5px] text-ink-1">{text}</span>
        {caption === null ? null : <span className="ml-1.5 text-[10.5px] text-ink-4">{caption}</span>}
      </span>
    </div>
  );
}

export function StageMediansCard({ summary }: { summary: CanonicalDeliverySummary }) {
  const matching = summary.tasks.matching;
  const reviewWait = sampledMedianText(summary.reviewWaitMs, matching);
  const rounds = sampledMedianText(summary.editVerifyRoundsPerRun, matching, formatCountValue);

  return (
    <Card>
      <CardHead
        title="Where the time goes"
        sub="Median claimed time per stage across matching tasks · from stage occurrence intervals"
      />
      <CardBody>
        <StageBars entries={stageBarEntries(summary)} ariaLabel="Median claimed time per stage" />
        <div className="mt-3 flex flex-col border-t border-border-soft pt-2">
          <Fact label="Median wait: PR ready → first review" text={reviewWait.text} caption={reviewWait.caption} />
          <Fact label="Median edit-verify rounds / run" text={rounds.text} caption={rounds.caption} />
        </div>
      </CardBody>
    </Card>
  );
}
