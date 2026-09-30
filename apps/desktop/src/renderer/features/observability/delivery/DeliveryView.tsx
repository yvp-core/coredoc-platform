/**
 * Delivery view (UC-3/UC-4): one server-aggregated summary read per
 * (workspace, window, lifecycle, member scope) over the KPI tiles, stage medians and
 * rework pareto, the cursor-paged task list beside it, and the composed trace for the
 * selected task.
 *
 * Admins and owners may narrow the read to one workspace member and members to
 * themselves (ADR-20260908-per-member-delivery-filter). The filter intersects the
 * same task and stage grain figures — it adds no ranking surface, and there is still
 * no per-person figure the members are compared on.
 */

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED,
  type AnalyticsWindow,
  type DeliveryLifecycleFilter,
} from '../../../../shared/ipc-types.js';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { Checkbox } from '../../../components/ui/checkbox';
import { Label } from '../../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import { QueryBoundary } from '../QueryBoundary';
import { SegmentedControl } from '../SegmentedControl';
import { deliverySummaryQueryOptions, workspaceMembersQueryOptions } from '../observability-api';
import { DeliveryKpis } from './DeliveryKpis';
import { LIFECYCLE_OPTIONS, memberOptions, populationCaption, scopeNoun } from './delivery-presentation';
import { ReworkCard } from './ReworkCard';
import { StageMediansCard } from './StageMediansCard';
import { TaskList } from './TaskList';
import { TaskTrace } from './TaskTrace';

function DeliveryNotice({ children, onRetry }: { children: string; onRetry?: () => void }) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col items-center gap-2 py-4 text-center">
        <p className="text-xs text-content-secondary">{children}</p>
        {onRetry === undefined ? null : (
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            Retry
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

const ALL_MEMBERS = 'all';

/** Only a workspace admin or owner may scope a delivery read to another member. */
function canFilterByMember(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner';
}

export function DeliveryView({
  workspaceId,
  window: analyticsWindow,
  role,
}: {
  workspaceId: string;
  window: AnalyticsWindow;
  role?: string;
}) {
  const [lifecycle, setLifecycle] = useState<DeliveryLifecycleFilter>('all');
  const [mine, setMine] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskQuery, setTaskQuery] = useState('');
  const dropSelection = useCallback(() => setSelectedTaskId(null), []);

  // Every Delivery v2 read is open to any workspace member on a signed-in session
  // (BR-15, opened 2026-09-08); a 403 still lands as the authorization sentinel below.
  const summaryQuery = useQuery(deliverySummaryQueryOptions(workspaceId, analyticsWindow, lifecycle, mine, userId));

  // The member picker is an admin/owner surface; a member keeps the self-scope
  // toggle, and the server refuses any other id from them regardless.
  const byMember = canFilterByMember(role);
  const membersQuery = useQuery({ ...workspaceMembersQueryOptions(workspaceId), enabled: byMember });
  const members = memberOptions(membersQuery.data ?? []);
  const memberName = members.find((member) => member.userId === userId)?.label ?? null;

  // The filters live outside every branch below: an unavailable summary occupies the
  // KPI slot only, and the user must still be able to switch lifecycle (or narrow the
  // population) rather than face a dead view.
  const filters = (
    <div className="flex flex-wrap items-center gap-2.5">
      <SegmentedControl
        options={LIFECYCLE_OPTIONS}
        value={lifecycle}
        onChange={(next) => {
          setLifecycle(next);
          setTaskQuery('');
        }}
        ariaLabel="Lifecycle"
      />
      {byMember ? (
        <Select
          value={userId ?? ALL_MEMBERS}
          onValueChange={(next) => {
            setUserId(next === ALL_MEMBERS ? null : next);
            setTaskQuery('');
          }}
        >
          <SelectTrigger aria-label="Member" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MEMBERS}>All members</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.userId} value={member.userId}>
                {member.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Label htmlFor="delivery-mine" className="gap-1.5">
          <Checkbox
            id="delivery-mine"
            checked={mine}
            onCheckedChange={(next) => {
              setMine(next === true);
              setTaskQuery('');
            }}
          />
          Only my tasks
        </Label>
      )}
      <span className="ml-auto text-[11.5px] text-content-quaternary">
        {populationCaption(analyticsWindow, lifecycle, mine, memberName)}
      </span>
    </div>
  );

  if (summaryQuery.isError) {
    const message = summaryQuery.error instanceof Error ? summaryQuery.error.message : String(summaryQuery.error);
    const authorization = message === CANONICAL_DELIVERY_AUTHORIZATION_REQUIRED;
    return authorization ? (
      <DeliveryNotice>Delivery analytics are not available to this account.</DeliveryNotice>
    ) : (
      <div className="flex flex-col gap-3">
        {filters}
        <DeliveryNotice onRetry={() => void summaryQuery.refetch()}>
          Delivery analytics are currently unavailable.
        </DeliveryNotice>
      </div>
    );
  }

  return (
    <QueryBoundary query={summaryQuery}>
      {(summary) => (
        <div className="flex flex-col gap-3">
          {filters}

          <DeliveryKpis summary={summary} />

          <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1.35fr_1fr]">
            <StageMediansCard summary={summary} />
            <ReworkCard summary={summary} />
          </div>

          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[340px_minmax(0,1fr)]">
            <TaskList
              workspaceId={workspaceId}
              window={analyticsWindow}
              lifecycle={lifecycle}
              mine={mine}
              userId={userId}
              scopeNoun={scopeNoun(mine, memberName)}
              query={taskQuery}
              onQueryChange={setTaskQuery}
              selectedTaskId={selectedTaskId}
              onSelect={setSelectedTaskId}
              onSelectionDropped={dropSelection}
            />
            <Card size="sm">
              <CardContent className="py-3">
                {selectedTaskId === null ? (
                  <p className="py-6 text-center text-xs text-content-quaternary">
                    Pick a task on the left to see its full trace.
                  </p>
                ) : (
                  <TaskTrace workspaceId={workspaceId} taskId={selectedTaskId} />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}
