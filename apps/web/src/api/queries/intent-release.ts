import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type {
  IntentReleaseAction,
  IntentReleaseHistory,
  IntentReleasePreview,
  IntentReleaseTrigger,
  IntentReleaseWrite,
} from '../../features/intent/release-types.js';

const path = (workspaceId: string, suffix: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/intent/${suffix}`;
const readIntentReleasePreview = (workspaceId: string, itemId: string) =>
  request<IntentReleasePreview>(path(workspaceId, `items/${encodeURIComponent(itemId)}/release-preview`));
export const readIntentReleasePreviews = (workspaceId: string, itemIds: string[]) =>
  request<IntentReleasePreview[]>(path(workspaceId, 'items/release-preview'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemIds }),
  });
export const intentReleasePreviewOptions = (workspaceId: string, itemId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'release-preview', workspaceId, itemId],
    queryFn: () => readIntentReleasePreview(workspaceId, itemId as string),
    enabled: itemId !== null,
  });
export const readIntentReleases = (workspaceId: string, beforeSeq?: number) =>
  request<IntentReleaseHistory>(
    path(workspaceId, `releases?limit=25${beforeSeq === undefined ? '' : `&beforeSeq=${beforeSeq}`}`),
  );
export const intentReleaseHistoryOptions = (workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'releases', workspaceId],
    queryFn: ({ pageParam }) => readIntentReleases(workspaceId, pageParam ?? undefined),
    initialPageParam: null as number | null,
    getNextPageParam: (last: IntentReleaseHistory) => last.nextBeforeSeq,
  });
export const writeIntentRelease = (workspaceId: string, action: IntentReleaseAction, body: IntentReleaseWrite) => {
  const suffix =
    action === 'release' || action === 'baseline'
      ? 'releases'
      : action === 'rollback'
        ? `releases/${body.releaseSeq}/rollback`
        : `items/${encodeURIComponent(body.itemId ?? '')}/plan${action === 'plan' ? '' : `/${action}`}`;
  return request<unknown>(path(workspaceId, suffix), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
};

/**
 * The workspace's release trigger (amendment §2). `GET /workspaces/:id` is the
 * only read that carries it — `/config` does not.
 */
export const intentReleaseTriggerOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'release-trigger', workspaceId],
    queryFn: async (): Promise<IntentReleaseTrigger> => {
      const workspace = await request<{ intentReleaseTrigger: IntentReleaseTrigger }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      );
      return workspace.intentReleaseTrigger;
    },
    staleTime: 30_000,
  });
