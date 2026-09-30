/**
 * Usage view (UC-1/UC-2) over the one server-aggregated read per (workspace,
 * window) — the server owns the window basis (BR-16), the price-map spend (BR-1)
 * and member self-scoping (BR-4), so this file only composes cards.
 *
 * The POC's member and repository filter chips are deliberately absent: they are
 * static there and no server-side filter exists (spec Non-goals).
 */

import { useQuery } from '@tanstack/react-query';
import type { AnalyticsWindow, WorkspaceUsageAnalytics } from '../../../../shared/ipc-types.js';
import { QueryBoundary } from '../QueryBoundary';
import { usageAnalyticsQueryOptions } from '../observability-api';
import { AdoptionCard } from './AdoptionCard';
import { FeedbackCard } from './FeedbackCard';
import { KpiRow } from './KpiRow';
import { MembersTable } from './MembersTable';
import { TimeseriesCard } from './TimeseriesCard';
import { ToolUsageCard } from './ToolUsageCard';
import { windowCaption } from './usage-presentation';

export function UsageBody({ usage, isTeam, now }: { usage: WorkspaceUsageAnalytics; isTeam: boolean; now: Date }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <span className="text-[11.5px] text-content-quaternary">{windowCaption(usage.window)}</span>
      </div>

      <KpiRow usage={usage} />
      <TimeseriesCard usage={usage} />

      <div className="grid gap-3 lg:grid-cols-[3fr_1.6fr] lg:items-start">
        <ToolUsageCard tools={usage.tools} />
        <AdoptionCard adoption={usage.adoption} />
      </div>

      <MembersTable members={usage.members} days={usage.window.days} isTeam={isTeam} now={now} />
    </div>
  );
}

export function UsageView({
  workspaceId,
  window: analyticsWindow,
  isTeam,
}: {
  workspaceId: string;
  window: AnalyticsWindow;
  isTeam: boolean;
}) {
  const usageQuery = useQuery(usageAnalyticsQueryOptions(workspaceId, analyticsWindow));

  return (
    <QueryBoundary query={usageQuery}>
      {(usage) => (
        // The feedback card owns a second, independently paged read, so it sits
        // beside `UsageBody` (which stays a pure function of the one aggregate)
        // rather than inside it.
        <div className="flex flex-col gap-4">
          <UsageBody usage={usage} isTeam={isTeam} now={new Date(usage.window.until)} />
          <FeedbackCard workspaceId={workspaceId} window={analyticsWindow} feedback={usage.feedback} isTeam={isTeam} />
        </div>
      )}
    </QueryBoundary>
  );
}
