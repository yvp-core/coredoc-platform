import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { IntentRequestError } from './intent-api';
import type { IntentResult } from '../../../shared/intent-types';
import { IntentReleaseTrigger } from '../../../shared/intent-release-types.js';
import type {
  IntentReleaseAction,
  IntentReleaseHistory,
  IntentReleaseWrite,
} from '../../../shared/intent-release-types.js';

async function unwrap<T>(result: Promise<IntentResult<T>>): Promise<T> {
  const r = await result;
  if (!r.success || r.data === undefined)
    throw new IntentRequestError(r.detail?.message ?? r.error ?? 'Intent release request failed', r.detail);
  return r.data;
}
export const readIntentReleasePreview = (workspaceId: string, itemId: string) =>
  unwrap(window.electronAPI.intentReleasePreview(workspaceId, itemId));
export const readIntentReleasePreviews = (workspaceId: string, itemIds: string[]) =>
  unwrap(window.electronAPI.intentReleasePreviews(workspaceId, itemIds));
export const intentReleasePreviewOptions = (workspaceId: string, itemId: string | null) =>
  queryOptions({
    queryKey: ['intent', 'release-preview', workspaceId, itemId],
    queryFn: () => readIntentReleasePreview(workspaceId, itemId as string),
    enabled: itemId !== null,
  });
export const readIntentReleases = (workspaceId: string, beforeSeq?: number) =>
  unwrap(window.electronAPI.intentReleaseList(workspaceId, beforeSeq));
export const intentReleaseHistoryOptions = (workspaceId: string) =>
  infiniteQueryOptions({
    queryKey: ['intent', 'releases', workspaceId],
    queryFn: ({ pageParam }) => readIntentReleases(workspaceId, pageParam ?? undefined),
    initialPageParam: null as number | null,
    getNextPageParam: (last: IntentReleaseHistory) => last.nextBeforeSeq,
  });
export const writeIntentRelease = (workspaceId: string, action: IntentReleaseAction, body: IntentReleaseWrite) =>
  unwrap(window.electronAPI.intentReleaseWrite(workspaceId, action, body));

/**
 * The workspace's release trigger (amendment §2). Read from the workspace list
 * the main process already exposes — `/workspaces/:id/config` does not carry
 * the field, and a dedicated channel for one enum would be plumbing for its own
 * sake. Absent (old server, failed read) reads as `manual`, today's behaviour.
 */
export const intentReleaseTriggerOptions = (workspaceId: string) =>
  queryOptions({
    queryKey: ['intent', 'release-trigger', workspaceId],
    queryFn: async (): Promise<IntentReleaseTrigger> => {
      const workspaces = await window.electronAPI.workspaceListWorkspaces();
      return workspaces.find((w) => w.id === workspaceId)?.intentReleaseTrigger ?? IntentReleaseTrigger.Manual;
    },
    staleTime: 30_000,
  });
