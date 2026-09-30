/**
 * TanStack query options + async handlers for the observability surface. Mirrors
 * the `unwrap()` envelope idiom from ../../api/graph.ts: the main process returns
 * `{ success, data?, error? }`, and these helpers throw on failure so React Query
 * routes it to the panel's single error state.
 */

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type {
  AnalyticsWindow,
  CanonicalDeliverySummary,
  CanonicalTaskDetail,
  CanonicalTaskSummariesResponse,
  DeliveryLifecycleFilter,
  FeedbackRecordsFilter,
  FeedbackRecordsPage,
  WorkspaceUsageAnalytics,
} from '../../../shared/ipc-types.js';

export const CANONICAL_PAGE_SIZE = 50;

async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const res = await p;
  if (!res.success || res.data === undefined) throw new Error(res.error ?? 'Observability query failed');
  return res.data;
}

/**
 * One server-aggregated read per (workspace, window) behind the Usage view (ADR-1).
 * The server owns the window basis (BR-16) and member self-scoping (BR-4).
 */
export const usageAnalyticsQueryOptions = (workspaceId: string, analyticsWindow: AnalyticsWindow) =>
  queryOptions({
    queryKey: ['observability', 'usage', workspaceId, analyticsWindow] as const,
    queryFn: () => unwrap<WorkspaceUsageAnalytics>(window.electronAPI.getUsageAnalytics(workspaceId, analyticsWindow)),
    staleTime: 60_000,
  });

/**
 * The paged feedback records behind the roadmap aggregates. The whole filter is
 * part of the key: the server AND-s every knob and pages with OFFSET, so a page
 * is only meaningful under the filter that produced it.
 */
export const feedbackRecordsQueryOptions = (
  workspaceId: string,
  analyticsWindow: AnalyticsWindow,
  filter: FeedbackRecordsFilter,
) =>
  queryOptions({
    queryKey: ['observability', 'feedback-records', workspaceId, analyticsWindow, filter] as const,
    queryFn: () =>
      unwrap<FeedbackRecordsPage>(window.electronAPI.getFeedbackRecords(workspaceId, analyticsWindow, filter)),
    staleTime: 60_000,
  });

/** One server-aggregated read per (workspace, window, lifecycle, member scope) behind the Delivery view (ADR-2). */
export const deliverySummaryQueryOptions = (
  workspaceId: string,
  analyticsWindow: AnalyticsWindow,
  lifecycle: DeliveryLifecycleFilter,
  mine: boolean,
  userId: string | null = null,
) =>
  queryOptions({
    queryKey: ['observability', 'delivery-summary', workspaceId, analyticsWindow, lifecycle, mine, userId] as const,
    queryFn: () =>
      unwrap<CanonicalDeliverySummary>(
        window.electronAPI.getDeliverySummary(workspaceId, analyticsWindow, lifecycle, mine, userId),
      ),
    staleTime: 60_000,
  });

/**
 * The workspace member list, reused from the members IPC the Team surface already
 * owns — it backs the delivery member filter for admins and owners only.
 */
export const workspaceMembersQueryOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['observability', 'workspace-members', workspaceId] as const,
    queryFn: () => window.electronAPI.workspaceListMembers(workspaceId),
    staleTime: 300_000,
  });

/**
 * Bounded task summaries; only an explicit user action follows a non-null cursor.
 * `window`/`lifecycle`/`mine`/`userId` are part of the key because the server binds
 * them into the cursor scope — a cursor minted under one filter is rejected under
 * another (BR-6). Omitting them preserves the server's current population.
 */
export const canonicalTaskSummariesQueryOptions = (
  workspaceId: string,
  analyticsWindow?: AnalyticsWindow,
  lifecycle?: DeliveryLifecycleFilter,
  mine?: boolean,
  userId?: string | null,
) =>
  infiniteQueryOptions({
    queryKey: [
      'observability',
      'canonical-delivery-summaries',
      workspaceId,
      analyticsWindow ?? null,
      lifecycle ?? null,
      mine ?? false,
      userId ?? null,
    ] as const,
    queryFn: ({ pageParam }) =>
      unwrap<CanonicalTaskSummariesResponse>(
        window.electronAPI.getCanonicalTaskSummaries(
          workspaceId,
          CANONICAL_PAGE_SIZE,
          pageParam ?? undefined,
          analyticsWindow,
          lifecycle,
          mine,
          userId,
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 60_000,
  });

/** Scalar detail is independent of every nested fact page. */
export const canonicalTaskDetailQueryOptions = (workspaceId: string, taskId: string | null) =>
  queryOptions({
    queryKey: ['observability', 'canonical-delivery-detail', workspaceId, taskId] as const,
    queryFn: () => {
      if (taskId === null) throw new Error('No canonical task selected');
      return unwrap<CanonicalTaskDetail>(window.electronAPI.getCanonicalTaskDetail(workspaceId, taskId));
    },
    enabled: taskId !== null,
    staleTime: 60_000,
  });

/** Open the workspace's full web observability dashboard in the system browser. */
export async function openObservabilityDashboard(workspaceSlug: string): Promise<void> {
  const res = await window.electronAPI.openObservabilityDashboard(workspaceSlug);
  if (!res.success) throw new Error(res.error ?? 'Failed to open dashboard');
}
