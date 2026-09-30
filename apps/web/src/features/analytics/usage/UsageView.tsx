/**
 * Usage view over the one server-aggregated read per (workspace, window) — the
 * server owns the window basis, the price-map spend and member self-scoping, so
 * this file only composes cards.
 */

import { useQuery } from '@tanstack/react-query';
import { usageAnalyticsQueryOptions } from '@/api/queries/analytics';
import { QueryBoundary } from '@/components/query-boundary';
import { AdoptionCard } from './AdoptionCard.js';
import { FeedbackCard } from './FeedbackCard.js';
import { KpiRow } from './KpiRow.js';
import { MembersTable } from './MembersTable.js';
import { TimeseriesCard } from './TimeseriesCard.js';
import { ToolUsageCard } from './ToolUsageCard.js';
import { WindowSelector } from '../WindowSelector.js';
import { type AnalyticsWindow, windowDays } from '../types.js';
import { windowCaption } from './usage-presentation.js';

export function UsageView({
  workspaceId,
  analyticsWindow,
  onWindowChange,
  isTeam,
}: {
  workspaceId: string;
  analyticsWindow: AnalyticsWindow;
  onWindowChange: (next: AnalyticsWindow) => void;
  isTeam: boolean;
}) {
  const usageQuery = useQuery(usageAnalyticsQueryOptions(workspaceId, analyticsWindow));

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <WindowSelector analyticsWindow={analyticsWindow} onChange={onWindowChange} />
        <span className="ml-auto text-[11.5px] text-ink-4">
          {usageQuery.data ? windowCaption(usageQuery.data.window) : `${windowDays(analyticsWindow)}d · UTC`}
        </span>
      </div>

      <QueryBoundary query={usageQuery}>
        {(usage) => (
          <div className="flex flex-col gap-3.5">
            <KpiRow usage={usage} />
            <TimeseriesCard usage={usage} />

            <div className="grid gap-3.5 lg:grid-cols-[3fr_1.6fr] lg:items-start">
              <ToolUsageCard tools={usage.tools} />
              <AdoptionCard adoption={usage.adoption} />
            </div>

            <MembersTable
              members={usage.members}
              days={usage.window.days}
              isTeam={isTeam}
              now={new Date(usage.window.until)}
            />
            <FeedbackCard
              feedback={usage.feedback}
              workspaceId={workspaceId}
              analyticsWindow={analyticsWindow}
              isTeam={isTeam}
            />
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
