/**
 * Reads behind the Analytics page. One server-aggregated read per (workspace,
 * window) for Usage and per (workspace, window, lifecycle, member scope) for Delivery; the task
 * trace composes the existing bounded per-collection routes instead of a server
 * trace route, each read once at the page maximum.
 *
 * Every Delivery v2 route is admin/owner + human session on the server — a 403
 * surfaces as `ApiError{status:403}` and the view renders the authorization
 * notice rather than a generic failure.
 */

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import { analyticsWindowParams } from '../../features/analytics/types.js';
import type {
  AnalyticsWindow,
  CanonicalArtifactItem,
  CanonicalArtifactRevisionsResponse,
  CanonicalCodeChangeItem,
  CanonicalCursorPage,
  CanonicalDeliverySummary,
  CanonicalExternalRefItem,
  CanonicalExternalRefStateFactItem,
  CanonicalReworkSignalItem,
  CanonicalRunItem,
  CanonicalShipEvidenceItem,
  CanonicalStageOccurrenceItem,
  CanonicalTaskDetail,
  CanonicalTaskSummariesResponse,
  DeliveryLifecycleFilter,
  FeedbackRecordsFilter,
  FeedbackRecordsPage,
  WorkspaceUsageAnalytics,
} from '../../features/analytics/types.js';

export const CANONICAL_PAGE_SIZE = 50;

const STALE_TIME = 60_000;

function workspacePath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function pageQuery(limit: number, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set('cursor', cursor);
  return params.toString();
}

/** One server-aggregated read per (workspace, window) behind the Usage view. */
export const usageAnalyticsQueryOptions = (workspaceId: string, window: AnalyticsWindow) =>
  queryOptions({
    queryKey: ['analytics', 'usage', workspaceId, window] as const,
    queryFn: () =>
      request<WorkspaceUsageAnalytics>(
        `${workspacePath(workspaceId)}/analytics/usage?${analyticsWindowParams(window)}`,
      ),
    staleTime: STALE_TIME,
  });

/**
 * Paged feedback records for the Session feedback card. The whole filter is part
 * of the key: every field changes the page the server returns.
 */
export const feedbackRecordsQueryOptions = (
  workspaceId: string,
  window: AnalyticsWindow,
  filter: FeedbackRecordsFilter,
) =>
  queryOptions({
    queryKey: ['analytics', 'feedback-records', workspaceId, window, filter] as const,
    queryFn: () =>
      request<FeedbackRecordsPage>(
        `${workspacePath(workspaceId)}/mcp-feedback/records?${analyticsWindowParams(
          window,
        )}&${feedbackFilterParams(filter)}`,
      ),
    staleTime: STALE_TIME,
  });

/** Only the filters the user actually set reach the wire — an absent param is "any". */
function feedbackFilterParams(filter: FeedbackRecordsFilter): string {
  const params = new URLSearchParams({
    page: String(filter.page),
    limit: String(filter.limit),
    sort: filter.sort,
    order: filter.order,
  });
  if (filter.area !== null) params.set('area', filter.area);
  // Same mutual exclusion as the delivery reads: at most one member scope.
  return `${params.toString()}${memberScopeParams(filter.mine, filter.userId)}`;
}

/**
 * The member scope of a delivery read: `mine=true` is the self-scope sugar a
 * member sends, `userId` is the member an admin/owner picked. The server rejects
 * both at once, so the caller sends at most one.
 */
function memberScopeParams(mine: boolean, userId: string | null): string {
  if (mine) return '&mine=true';
  return userId === null ? '' : `&userId=${encodeURIComponent(userId)}`;
}

/** One server-aggregated read per (workspace, window, lifecycle, member scope) behind the Delivery view. */
export const deliverySummaryQueryOptions = (
  workspaceId: string,
  window: AnalyticsWindow,
  lifecycle: DeliveryLifecycleFilter,
  mine: boolean,
  userId: string | null,
) =>
  queryOptions({
    queryKey: ['analytics', 'delivery-summary', workspaceId, window, lifecycle, mine, userId] as const,
    queryFn: () =>
      request<CanonicalDeliverySummary>(
        `${workspacePath(workspaceId)}/delivery/v2/summary?${analyticsWindowParams(
          window,
        )}&lifecycle=${lifecycle}${memberScopeParams(mine, userId)}`,
      ),
    staleTime: STALE_TIME,
  });

/**
 * Bounded task summaries; only an explicit user action follows a non-null cursor.
 * The window/`lifecycle`/member-scope filters are part of the key because the server
 * binds them into the cursor scope — a cursor minted under one filter is rejected under another.
 */
export const canonicalTaskSummariesQueryOptions = (
  workspaceId: string,
  window: AnalyticsWindow,
  lifecycle: DeliveryLifecycleFilter,
  mine: boolean,
  userId: string | null,
) =>
  infiniteQueryOptions({
    queryKey: ['analytics', 'delivery-tasks', workspaceId, window, lifecycle, mine, userId] as const,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(pageQuery(CANONICAL_PAGE_SIZE, pageParam ?? undefined));
      params.set('lifecycle', lifecycle);
      return request<CanonicalTaskSummariesResponse>(
        `${workspacePath(workspaceId)}/delivery/v2/task-summaries?${analyticsWindowParams(
          window,
        )}&${params.toString()}${memberScopeParams(mine, userId)}`,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: STALE_TIME,
  });

/** Scalar detail is independent of every nested fact page. */
export const canonicalTaskDetailQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'delivery-task', workspaceId, taskId] as const,
    queryFn: () =>
      request<CanonicalTaskDetail>(`${workspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}`),
    staleTime: STALE_TIME,
  });

function taskCollection<T>(workspaceId: string, taskId: string, collection: string) {
  return request<CanonicalCursorPage<T>>(
    `${workspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}/${collection}?${pageQuery(
      CANONICAL_PAGE_SIZE,
    )}`,
  );
}

export const traceExternalRefsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'external-refs', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalExternalRefItem>(workspaceId, taskId, 'external-refs'),
    staleTime: STALE_TIME,
  });

export const traceRunsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'runs', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalRunItem>(workspaceId, taskId, 'runs'),
    staleTime: STALE_TIME,
  });

export const traceCodeChangesQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'code-changes', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalCodeChangeItem>(workspaceId, taskId, 'code-changes'),
    staleTime: STALE_TIME,
  });

export const traceShipEvidenceQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'ship-evidence', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalShipEvidenceItem>(workspaceId, taskId, 'ship-evidence'),
    staleTime: STALE_TIME,
  });

export const traceReworkSignalsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'rework-signals', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalReworkSignalItem>(workspaceId, taskId, 'rework-signals'),
    staleTime: STALE_TIME,
  });

export const traceArtifactsQueryOptions = (workspaceId: string, taskId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'artifacts', workspaceId, taskId] as const,
    queryFn: () => taskCollection<CanonicalArtifactItem>(workspaceId, taskId, 'artifacts'),
    staleTime: STALE_TIME,
  });

/** Nested read, one per run on the runs first page. */
export const traceRunStagesQueryOptions = (workspaceId: string, taskId: string, runId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'run-stages', workspaceId, taskId, runId] as const,
    queryFn: () =>
      request<CanonicalCursorPage<CanonicalStageOccurrenceItem>>(
        `${workspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(
          runId,
        )}/stage-occurrences?${pageQuery(CANONICAL_PAGE_SIZE)}`,
      ),
    staleTime: STALE_TIME,
  });

/** Nested read, one per external ref on the refs first page. */
export const traceRefHistoryQueryOptions = (workspaceId: string, taskId: string, externalRefId: string) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'ref-history', workspaceId, taskId, externalRefId] as const,
    queryFn: () =>
      request<CanonicalCursorPage<CanonicalExternalRefStateFactItem>>(
        `${workspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(
          taskId,
        )}/external-refs/${encodeURIComponent(externalRefId)}/state-history?${pageQuery(CANONICAL_PAGE_SIZE)}`,
      ),
    staleTime: STALE_TIME,
  });

/**
 * Checkpoint Markdown for one artifact. Bodies are untrusted and far heavier
 * than the trace's other reads, so this one is demand-only: disabled until a
 * chip is expanded.
 */
export const traceArtifactRevisionsQueryOptions = (workspaceId: string, artifactId: string | null) =>
  queryOptions({
    queryKey: ['analytics', 'trace', 'artifact-revisions', workspaceId, artifactId] as const,
    queryFn: () => {
      if (artifactId === null) throw new Error('No artifact selected');
      return request<CanonicalArtifactRevisionsResponse>(
        `${workspacePath(workspaceId)}/delivery/v2/artifacts/${encodeURIComponent(artifactId)}/revisions`,
      );
    },
    enabled: artifactId !== null,
    staleTime: STALE_TIME,
  });
