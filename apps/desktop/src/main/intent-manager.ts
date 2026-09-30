import type { IntentReleaseAction, IntentReleaseWrite } from '../shared/intent-release-types.js';
/**
 * Intent Manager — desktop MAIN-process IPC surface for the cloud intent
 * knowledge base (spec §7, issue 11).
 *
 * The renderer never talks to the server: every read and write here goes
 * renderer → IPC → `server-api.ts` → REST. Handlers return the repo's standard
 * `{ success, data?, error? }` envelope, extended with `detail` — the server's
 * structured error body, parsed and forwarded VERBATIM.
 *
 * That extension is the point of this file. `IntentExceptionFilter` (spec §12)
 * answers a refused mutation with a machine-readable `code`, a bounded message
 * and the exact failing field paths; flattening that into one string would
 * reproduce the archived CLI's named defect of swallowing preflight bodies
 * behind a generic hint. `ApiError.body` carries the raw payload for exactly
 * this, so the renderer can render the code and paths the server actually sent.
 *
 * A refused review DECISION is not an error at all: `POST items/review` answers
 * 200 with a per-decision result list, so a stale expected version refuses one
 * decision and leaves its siblings applied. That path returns `success: true`
 * and the renderer branches on each `outcome`.
 */

import type { IpcMain } from 'electron';
import { IpcChannels } from '../shared/ipc-types.js';
import type {
  IntentAnchorRefreshInput,
  IntentArchiveInput,
  IntentContextQuery,
  IntentDeleteInput,
  IntentDimensionsQuery,
  IntentDomainCreateInput,
  IntentDomainUpdateInput,
  IntentFeatureCreateInput,
  IntentFeatureUpdateInput,
  IntentFeaturesQuery,
  IntentItemsQuery,
  IntentResult,
  IntentReviewQueueQuery,
  IntentReviewRequest,
  IntentSeedDeleteInput,
  IntentSeedPutInput,
  IntentTransitionsQuery,
  IntentTreeQuery,
} from '../shared/intent-types.js';
import { parseIntentError } from './intent-error-body.js';
import { invalidateObservedCheckouts, resolveObservedCheckouts } from './intent-observed-checkout.js';
import {
  ApiError,
  getIntentReleasePreview,
  getIntentReleasePreviews,
  listIntentReleases,
  recordIntentRelease,
  archiveIntentDomain,
  archiveIntentFeature,
  createIntentDomain,
  createIntentFeature,
  deleteIntentDomain,
  deleteIntentFeature,
  deleteIntentFeatureSeed,
  getIntentContext,
  getIntentDimensions,
  getIntentTree,
  listIntentFeatureSeeds,
  listIntentFeatures,
  listIntentItemTransitions,
  listIntentItems,
  listIntentSources,
  listIntentReviewQueue,
  listIntentTransitions,
  putIntentFeatureSeed,
  refreshIntentAnchor,
  reviewIntentItems,
  updateIntentDomain,
  updateIntentFeature,
} from './server-api.js';

/** Envelope wrapper that preserves the structured error when the server sent one. */
async function ok<T>(fn: () => Promise<T>): Promise<IntentResult<T>> {
  try {
    return { success: true, data: await fn() };
  } catch (err) {
    if (err instanceof ApiError) {
      const detail = parseIntentError(err.body);
      return {
        success: false,
        // The structured message is the one a reviewer can act on; the transport
        // string is the fallback for everything that has no contract body.
        error: detail ? detail.message : err.message,
        ...(detail ? { detail } : {}),
      };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerIntentHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.INTENT_RELEASE_PREVIEW, (_event, workspaceId: string, itemId: string) =>
    ok(() => getIntentReleasePreview(workspaceId, itemId)),
  );
  ipcMain.handle(IpcChannels.INTENT_RELEASE_PREVIEWS, (_event, workspaceId: string, itemIds: string[]) =>
    ok(() => getIntentReleasePreviews(workspaceId, itemIds)),
  );
  ipcMain.handle(IpcChannels.INTENT_RELEASE_LIST, (_event, workspaceId: string, beforeSeq?: number) =>
    ok(() => listIntentReleases(workspaceId, beforeSeq)),
  );
  ipcMain.handle(
    IpcChannels.INTENT_RELEASE_WRITE,
    (_event, workspaceId: string, action: IntentReleaseAction, body: IntentReleaseWrite) =>
      ok(() => recordIntentRelease(workspaceId, action, body)),
  );
  /* ------------------------------------------------------------- reads --- */

  ipcMain.handle(IpcChannels.INTENT_GET_TREE, (_event, workspaceId: string, query: IntentTreeQuery) =>
    ok(() => getIntentTree(workspaceId, query)),
  );

  ipcMain.handle(IpcChannels.INTENT_LIST_DIMENSIONS, (_event, workspaceId: string, query: IntentDimensionsQuery) =>
    ok(() => getIntentDimensions(workspaceId, query)),
  );

  ipcMain.handle(IpcChannels.INTENT_LIST_FEATURES, (_event, workspaceId: string, query: IntentFeaturesQuery) =>
    ok(() => listIntentFeatures(workspaceId, query)),
  );

  ipcMain.handle(
    IpcChannels.INTENT_LIST_FEATURE_SEEDS,
    (_event, workspaceId: string, featureId: string, query: IntentTreeQuery) =>
      ok(() => listIntentFeatureSeeds(workspaceId, featureId, query)),
  );

  ipcMain.handle(IpcChannels.INTENT_LIST_SOURCES, (_event, workspaceId: string, search: string) =>
    ok(() => listIntentSources(workspaceId, search)),
  );
  ipcMain.handle(IpcChannels.INTENT_LIST_ITEMS, (_event, workspaceId: string, query: IntentItemsQuery) =>
    ok(() => listIntentItems(workspaceId, query)),
  );

  ipcMain.handle(IpcChannels.INTENT_REVIEW_QUEUE, (_event, workspaceId: string, query: IntentReviewQueueQuery) =>
    ok(() => listIntentReviewQueue(workspaceId, query)),
  );

  /**
   * The one handler that ADDS to what the renderer asked for: `observed`, the
   * local checkout state of every workspace repo main can map to a path (spec
   * §6.3, issue v1.1-04). It is folded in here rather than exposed as its own
   * channel because the renderer has no use for git state and must not learn
   * it — it asks for context, and freshness comes back better than `unverified`.
   *
   * `query.refresh` is main's own signal, not the server's: it drops the
   * per-session checkout cache so a manual refresh re-reads git, and it never
   * reaches the wire.
   *
   * BOTH ARE STRIPPED FROM WHAT THE RENDERER SENT. `observed` is a claim about
   * the local worktree and the renderer has no standing to make one — forwarding
   * a renderer-supplied value would let it assert any freshness it liked, which
   * is the whole point of resolving it here. `refresh` is consumed here and goes
   * no further.
   */
  ipcMain.handle(IpcChannels.INTENT_GET_CONTEXT, (_event, workspaceId: string, query: IntentContextQuery = {}) =>
    ok(async () => {
      const { observed: _rendererObserved, refresh, ...rest } = query;
      if (refresh) invalidateObservedCheckouts();
      const observed = await resolveObservedCheckouts(workspaceId);
      // Absent rather than empty: a zero-length parameter list is not a claim,
      // and the transport should send nothing at all for it.
      return getIntentContext(workspaceId, observed.length === 0 ? rest : { ...rest, observed });
    }),
  );

  ipcMain.handle(
    IpcChannels.INTENT_LIST_ITEM_TRANSITIONS,
    (_event, workspaceId: string, itemId: string, query: IntentTransitionsQuery) =>
      ok(() => listIntentItemTransitions(workspaceId, itemId, query)),
  );

  ipcMain.handle(IpcChannels.INTENT_LIST_TRANSITIONS, (_event, workspaceId: string, query: IntentTransitionsQuery) =>
    ok(() => listIntentTransitions(workspaceId, query)),
  );

  /* ------------------------------------------------------------ review --- */

  ipcMain.handle(IpcChannels.INTENT_REVIEW_ITEMS, (_event, workspaceId: string, body: IntentReviewRequest) =>
    ok(() => reviewIntentItems(workspaceId, body)),
  );

  /* -------------------------------------------------------------- tree --- */

  ipcMain.handle(IpcChannels.INTENT_CREATE_DOMAIN, (_event, workspaceId: string, body: IntentDomainCreateInput) =>
    ok(() => createIntentDomain(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_UPDATE_DOMAIN, (_event, workspaceId: string, body: IntentDomainUpdateInput) =>
    ok(() => updateIntentDomain(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_ARCHIVE_DOMAIN, (_event, workspaceId: string, body: IntentArchiveInput) =>
    ok(() => archiveIntentDomain(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_DELETE_DOMAIN, (_event, workspaceId: string, body: IntentDeleteInput) =>
    ok(() => deleteIntentDomain(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_CREATE_FEATURE, (_event, workspaceId: string, body: IntentFeatureCreateInput) =>
    ok(() => createIntentFeature(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_UPDATE_FEATURE, (_event, workspaceId: string, body: IntentFeatureUpdateInput) =>
    ok(() => updateIntentFeature(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_ARCHIVE_FEATURE, (_event, workspaceId: string, body: IntentArchiveInput) =>
    ok(() => archiveIntentFeature(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_DELETE_FEATURE, (_event, workspaceId: string, body: IntentDeleteInput) =>
    ok(() => deleteIntentFeature(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_PUT_SEED, (_event, workspaceId: string, body: IntentSeedPutInput) =>
    ok(() => putIntentFeatureSeed(workspaceId, body)),
  );

  ipcMain.handle(IpcChannels.INTENT_DELETE_SEED, (_event, workspaceId: string, body: IntentSeedDeleteInput) =>
    ok(() => deleteIntentFeatureSeed(workspaceId, body)),
  );

  /* ----------------------------------------------------------- anchors --- */

  ipcMain.handle(IpcChannels.INTENT_REFRESH_ANCHOR, (_event, workspaceId: string, body: IntentAnchorRefreshInput) =>
    ok(() => refreshIntentAnchor(workspaceId, body)),
  );
}
