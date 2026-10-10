/**
 * Delivery view: one server-aggregated summary read per (workspace, window,
 * lifecycle, member scope) over the KPI tiles, stage medians and rework pareto, the
 * cursor-paged task list beside it, and the composed trace for the selected task.
 *
 * The member filter is an intersection over the same task- and stage-grain figures,
 * not a ranking surface (ADR-20260908): admins and owners may scope the read to one
 * workspace member, a member may only scope it to themselves — and the server
 * re-checks that, this select is UI only.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { deliverySummaryQueryOptions } from '@/api/queries/analytics';
import { membersQueryOptions } from '@/api/queries/members';
import { ApiError } from '@/api/client';
import { QueryBoundary } from '@/components/query-boundary';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { hasAdminAccess } from '@/lib/roles';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import type { AnalyticsWindow, DeliveryLifecycleFilter } from '../types.js';
import { DeliveryKpis } from './DeliveryKpis.js';
import { ReworkCard } from './ReworkCard.js';
import { StageMediansCard } from './StageMediansCard.js';
import { TaskList } from './TaskList.js';
import { TaskTrace } from './TaskTrace.js';
import { LIFECYCLE_OPTIONS, populationCaption } from './delivery-presentation.js';

/** Every Delivery v2 read is any workspace member on a signed-in (JWT) session; service tokens get 403. */
const AUTHORIZATION_NOTICE = 'Delivery analytics are not available to this account';

function Notice({ children, onRetry }: { children: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface px-4 py-6 text-center shadow-card">
      <p className="text-[13.5px] text-ink-2">{children}</p>
      {onRetry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function DeliveryView({
  workspaceId,
  role,
  analyticsWindow,
  onWindowChange,
}: {
  workspaceId: string;
  /** Workspace role of the signed-in user: admin/owner pick a member, a member is self-scoped. */
  role: string;
  analyticsWindow: AnalyticsWindow;
  onWindowChange: (next: AnalyticsWindow) => void;
}) {
  const canPickMember = hasAdminAccess(role);
  const [lifecycle, setLifecycle] = useState<DeliveryLifecycleFilter>('all');
  const [mine, setMine] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskQuery, setTaskQuery] = useState('');
  const dropSelection = useCallback(() => setSelectedTaskId(null), []);

  // Only one of the two ever reaches the wire: the server rejects `mine` + `userId` together.
  const scopedUserId = canPickMember ? userId : null;
  const scopedMine = canPickMember ? false : mine;

  const membersQuery = useQuery({ ...membersQueryOptions(workspaceId), enabled: canPickMember });
  // Pending invites carry a placeholder `pending:<id>` and have no delivery facts.
  const members = (membersQuery.data ?? []).filter((member) => !member.userId.startsWith('pending:'));
  const selected = members.find((member) => member.userId === scopedUserId) ?? null;
  const scope = scopedMine
    ? 'your tasks'
    : scopedUserId === null
      ? null
      : `tasks of ${selected === null ? scopedUserId : (selected.displayName ?? selected.email)}`;

  const summaryQuery = useQuery(
    deliverySummaryQueryOptions(workspaceId, analyticsWindow, lifecycle, scopedMine, scopedUserId),
  );

  // The filters live outside every branch below: an unavailable summary occupies
  // the KPI slot only, and the user must still be able to switch lifecycle.
  const filters = (
    <div className="flex flex-wrap items-center gap-2.5">
      <DateRangePicker value={analyticsWindow} onChange={onWindowChange} />
      <Segmented
        value={lifecycle}
        onChange={(next) => {
          setLifecycle(next);
          setTaskQuery('');
        }}
        items={[...LIFECYCLE_OPTIONS]}
      />
      {canPickMember ? (
        <Select
          value={userId ?? ''}
          onValueChange={(value) => setUserId(value || null)}
          className="w-[190px]"
          aria-label="Member"
        >
          <option value="">All members</option>
          {members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.displayName ?? member.email}
            </option>
          ))}
        </Select>
      ) : (
        <Label className="gap-1.5" htmlFor="delivery-mine">
          <Switch id="delivery-mine" checked={mine} onChange={(event) => setMine(event.target.checked)} />
          Only my tasks
        </Label>
      )}
      <span className="ml-auto text-[12.5px] text-ink-4">{populationCaption(analyticsWindow, lifecycle, scope)}</span>
    </div>
  );

  if (summaryQuery.isError) {
    const forbidden = summaryQuery.error instanceof ApiError && summaryQuery.error.status === 403;
    return (
      <div className="flex flex-col gap-3.5">
        {filters}
        {forbidden ? (
          <Notice>{AUTHORIZATION_NOTICE}</Notice>
        ) : (
          <Notice onRetry={() => void summaryQuery.refetch()}>Delivery analytics are currently unavailable.</Notice>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {filters}

      <QueryBoundary query={summaryQuery}>
        {(summary) => (
          <div className="flex flex-col gap-3.5">
            <DeliveryKpis summary={summary} />

            <div className="grid grid-cols-1 items-stretch gap-3.5 lg:grid-cols-[1.35fr_1fr]">
              <StageMediansCard summary={summary} />
              <ReworkCard summary={summary} />
            </div>

            <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[340px_minmax(0,1fr)]">
              <TaskList
                workspaceId={workspaceId}
                analyticsWindow={analyticsWindow}
                lifecycle={lifecycle}
                mine={scopedMine}
                userId={scopedUserId}
                scope={scope}
                query={taskQuery}
                onQueryChange={setTaskQuery}
                selectedTaskId={selectedTaskId}
                onSelect={setSelectedTaskId}
                onSelectionDropped={dropSelection}
              />
              <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
                {selectedTaskId === null ? (
                  <p className="py-6 text-center text-[13px] text-ink-4">
                    Pick a task on the left to see its full trace.
                  </p>
                ) : (
                  <TaskTrace workspaceId={workspaceId} taskId={selectedTaskId} />
                )}
              </div>
            </div>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
