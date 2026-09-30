import type { IntentReleaseTrigger } from '../shared/intent-release-types.js';
import type {
  IntentReleaseAction,
  IntentReleaseHistory,
  IntentReleasePreview,
  IntentReleaseWrite,
} from '../shared/intent-release-types.js';
/**
 * Server API Client - HTTP client for coredoc server endpoints
 */

import type {
  IntentAnchorRefreshInput,
  IntentAnchorRefreshResponse,
  IntentArchiveInput,
  IntentContextQuery,
  IntentContextResponse,
  IntentDeleteInput,
  IntentDeleteResponse,
  IntentDimensionsQuery,
  IntentDimensionsResponse,
  IntentDomainCreateInput,
  IntentDomainMutationResponse,
  IntentDomainUpdateInput,
  IntentFeatureCreateInput,
  IntentFeatureMutationResponse,
  IntentFeatureSeedsResponse,
  IntentFeatureUpdateInput,
  IntentFeaturesQuery,
  IntentFeaturesResponse,
  IntentItemsQuery,
  IntentSourcesResponse,
  IntentItemsResponse,
  IntentReviewQueueQuery,
  IntentReviewQueueResponse,
  IntentReviewRequest,
  IntentReviewResponse,
  IntentSeedDeleteInput,
  IntentSeedMutationResponse,
  IntentSeedPutInput,
  IntentTransitionsQuery,
  IntentTransitionsResponse,
  IntentTreeQuery,
  IntentTreeResponse,
} from '../shared/intent-types.js';
import { analyticsWindowParams } from '../shared/ipc-types.js';
import { gzipSync } from 'node:zlib';
import { getValidTokens } from './auth-manager.js';
import { getConfiguredServerUrl } from './server-url.js';

// Re-exported so existing callers (workspace-manager.ts uses serverApi.setServerUrl)
// keep working after the resolver moved to server-url.ts.
export { getConfiguredServerUrl, setServerUrl } from './server-url.js';

/**
 * Transport error carrying the HTTP status, so callers can branch on the outcome
 * (the delivery manager maps a 403 from `DeliveryEnabledGuard` → a "feature
 * disabled" sentinel, distinct from other failures). The `message` string is the
 * same format the previous plain `Error` used, so message-based callers
 * (observability) are unaffected.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The raw response body, kept alongside the formatted `message` so a caller
     * that speaks a structured error contract (the intent module's
     * `IntentExceptionFilter`, spec §12) can parse it instead of scraping the
     * message string. Empty when the body could not be read.
     */
    readonly body: string = '',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const GZIP_THRESHOLD_BYTES = 1024 * 1024;

async function getHeaders(): Promise<Record<string, string>> {
  const tokens = await getValidTokens();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tokens) {
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
  }
  return headers;
}

export async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const serverUrl = getConfiguredServerUrl();
  const headers = await getHeaders();
  // Large bodies (artifact uploads: a big ParsedRepo is 100 MB+ of repetitive
  // JSON) go gzipped — reverse proxies commonly cap raw bodies at 100 MB and
  // Express inflates `Content-Encoding: gzip` before the JSON parser.
  const json = body ? JSON.stringify(body) : undefined;
  const gzip = json !== undefined && json.length > GZIP_THRESHOLD_BYTES;
  const payload: string | Uint8Array<ArrayBuffer> | undefined = gzip ? new Uint8Array(gzipSync(json)) : json;
  const encodingHeaders: Record<string, string> = gzip ? { 'Content-Encoding': 'gzip' } : {};
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { ...headers, ...encodingHeaders },
    body: payload,
    signal: options.signal,
  });

  // On 401, try refreshing the token and retry once
  if (response.status === 401) {
    const freshTokens = await getValidTokens();
    if (freshTokens) {
      const retryHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${freshTokens.accessToken}`,
        ...encodingHeaders,
      };
      const retryResponse = await fetch(`${serverUrl}${path}`, {
        method,
        headers: retryHeaders,
        body: payload,
        signal: options.signal,
      });
      if (!retryResponse.ok) {
        const error = await retryResponse.text();
        throw new ApiError(
          retryResponse.status,
          `API ${method} ${path} failed (${retryResponse.status}): ${error}`,
          error,
        );
      }
      return retryResponse.json() as Promise<T>;
    }
  }

  if (!response.ok) {
    const error = await response.text();
    throw new ApiError(response.status, `API ${method} ${path} failed (${response.status}): ${error}`, error);
  }
  return response.json() as Promise<T>;
}

/**
 * Version handshake (`04-version-compat-handshake`). Unauthenticated
 * server-side; the Bearer apiRequest attaches is simply ignored. A pre-
 * handshake server answers 404, which `resolveServerCompat` reads as
 * "server too old" rather than an error.
 */
export const getServerMeta = () => apiRequest<unknown>('GET', '/api/v1/meta');

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  workosOrgId?: string;
  createdAt: string;
  role?: string;
  isCloud?: boolean;
  ciCdEnabled?: boolean;
  /** Workspace release trigger (amendment §2); absent on older servers = `manual`. */
  intentReleaseTrigger?: IntentReleaseTrigger;
  /** Per-workspace delivery-intelligence flag; gates the desktop Analytics tab. */
  deliveryEnabled?: boolean;
  /** Per-workspace intent flag; gates the Intent tab. */
  intentEnabled?: boolean;
  /** `turso` or `file_snapshot`; decides whether a sync can publish as one batch. */
  graphBackend?: string;
  /** Server capability advertisement; absent on older servers. */
  capabilities?: { batchResolveTargets?: boolean };
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  // Placeholder row created on invite (userId = `pending:<email>`); GET /members
  // is unfiltered, so the renderer sees these alongside real members.
  pending: boolean;
  joinedAt: string;
}

export interface WorkspaceRepo {
  id: string;
  repoKey: string;
  repoName: string;
  gitUrl: string | null;
  captureRepositoryKey: string | null;
  /** Branch whose merges count as production for intent releases; null = connector default. */
  productionBranch?: string | null;
  intentRepoKey?: string | null;
  intentReleaseTrigger?: IntentReleaseTrigger | null;
  createdAt: string;
}

export interface WorkspaceConfig {
  workspace: Workspace;
  repos: WorkspaceRepo[];
  members: WorkspaceMember[];
}

// Workspaces
export const listWorkspaces = () => apiRequest<Workspace[]>('GET', '/api/v1/workspaces');
export const createWorkspace = (name: string, slug: string) =>
  apiRequest<Workspace>('POST', '/api/v1/workspaces', { name, slug });
export const getWorkspace = (workspaceId: string) => apiRequest<Workspace>('GET', `/api/v1/workspaces/${workspaceId}`);
export const deleteWorkspace = (workspaceId: string) => apiRequest<void>('DELETE', `/api/v1/workspaces/${workspaceId}`);

// Members
export const listMembers = (workspaceId: string) =>
  apiRequest<WorkspaceMember[]>('GET', `/api/v1/workspaces/${workspaceId}/members`);
export interface InviteMemberResult {
  invited: true;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}
export interface RemoveMemberResult {
  removed: true;
  providerCleanupSucceeded: boolean | null;
}
export interface RevokeInviteResult {
  revoked: true;
  emailRevoked: boolean | null;
}
export interface ResendInviteResult {
  resent: boolean;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}
export const inviteMember = (workspaceId: string, email: string, role?: string) =>
  apiRequest<InviteMemberResult>('POST', `/api/v1/workspaces/${workspaceId}/members/invites`, {
    email,
    role: role ?? 'member',
  });
export const removeMember = (workspaceId: string, userId: string) =>
  apiRequest<RemoveMemberResult>('DELETE', `/api/v1/workspaces/${workspaceId}/members/${userId}`);

// Pending Invites
export interface PendingInvite {
  id: string;
  email: string;
  role: string;
  state: 'pending' | 'expired';
  emailSent: boolean;
  createdAt: string;
  invitedAt: string;
  expiresAt: string | null;
  lastSentAt: string | null;
}
export const listPendingInvites = (workspaceId: string) =>
  apiRequest<PendingInvite[]>('GET', `/api/v1/workspaces/${workspaceId}/members/invites`);
export const revokeInvite = (workspaceId: string, invitationId: string) =>
  apiRequest<RevokeInviteResult>('DELETE', `/api/v1/workspaces/${workspaceId}/members/invites/${invitationId}`);
export const resendInvite = (workspaceId: string, invitationId: string) =>
  apiRequest<ResendInviteResult>('POST', `/api/v1/workspaces/${workspaceId}/members/invites/${invitationId}/resend`);
export const updateMemberRole = (workspaceId: string, userId: string, role: string) =>
  apiRequest<void>('PATCH', `/api/v1/workspaces/${workspaceId}/members/${userId}`, { role });
// Repos
export const listRepos = (workspaceId: string) =>
  apiRequest<WorkspaceRepo[]>('GET', `/api/v1/workspaces/${workspaceId}/repos`);
export const connectRepo = (
  workspaceId: string,
  repoKey: string,
  repoName: string,
  gitUrl?: string,
  httpPrefix?: string,
  /**
   * The durable identity the intent knowledge base binds anchors, seeds and
   * imports on. Built by `buildRepoIntentIdentity`, which sends it only when it
   * hashes to `repoKey`; without it the server falls back to `hash(repoName)`
   * and a repo with an explicit `repos[].key` never binds at all.
   */
  identity: { intentRepoKey?: string } = {},
) => {
  // POST is create-only. On re-connect the server returns 409 Conflict; the
  // caller (workspace-manager.syncToCloud) then PATCHes mutable fields via
  // `updateRepo` to propagate gitUrl/httpPrefix changes from local config.
  const body: Record<string, unknown> = { repoKey, repoName };
  if (gitUrl !== undefined) body.gitUrl = gitUrl;
  if (httpPrefix !== undefined) body.httpPrefix = httpPrefix;
  if (identity.intentRepoKey !== undefined) body.intentRepoKey = identity.intentRepoKey;
  return apiRequest<WorkspaceRepo>('POST', `/api/v1/workspaces/${workspaceId}/repos`, body);
};

/**
 * Partial update for an already-connected repo. Tri-state per field:
 * `undefined` leaves alone, `null` clears, string sets. The desktop omits
 * fields (sends undefined) when local config has no value because the UI
 * doesn't distinguish "removed" from "never set"; a blanket null on every
 * sync would wipe values set elsewhere (e.g. hand-edited coredoc.config.json
 * or a different client). To clear a value, send null explicitly.
 */
export const updateRepo = (
  workspaceId: string,
  repoKey: string,
  updates: {
    gitUrl?: string | null;
    httpPrefix?: string | null;
    repoType?: string | null;
    /** Same durable intent identity as on connect — a repo connected before this shipped binds on its next sync. */
    intentRepoKey?: string;
    /** Production branch for intent releases; explicit `null` clears the override. */
    productionBranch?: string | null;
    intentReleaseTrigger?: IntentReleaseTrigger | null;
  },
) => {
  const body: Record<string, unknown> = {};
  if (updates.gitUrl !== undefined) body.gitUrl = updates.gitUrl;
  if (updates.httpPrefix !== undefined) body.httpPrefix = updates.httpPrefix;
  if (updates.repoType !== undefined) body.repoType = updates.repoType;
  if (updates.intentRepoKey !== undefined) body.intentRepoKey = updates.intentRepoKey;
  if (updates.productionBranch !== undefined) body.productionBranch = updates.productionBranch;
  if (updates.intentReleaseTrigger !== undefined) body.intentReleaseTrigger = updates.intentReleaseTrigger;
  return apiRequest<WorkspaceRepo>('PATCH', `/api/v1/workspaces/${workspaceId}/repos/${repoKey}`, body);
};

export const disconnectRepo = (workspaceId: string, repoId: string) =>
  apiRequest<void>('DELETE', `/api/v1/workspaces/${workspaceId}/repos/${repoId}`);

// Config
export const pullWorkspaceConfig = (workspaceId: string) =>
  apiRequest<WorkspaceConfig>('GET', `/api/v1/workspaces/${workspaceId}/config`);

// Cloud Sync
export const enableCloud = (workspaceId: string, opts?: { ciCdEnabled?: boolean }) =>
  apiRequest<Workspace>('POST', `/api/v1/workspaces/${workspaceId}/cloud/enable`, opts ?? {});

export const getRepoState = (workspaceId: string, repoName: string) =>
  apiRequest<import('../shared/ipc-types.js').RepoStateResponse | null>(
    'GET',
    `/api/v1/workspaces/${workspaceId}/repos/${repoName}/state`,
  );

export const getMcpConfig = (workspaceId: string, tool: string = 'claude') =>
  apiRequest<Record<string, unknown>>('GET', `/api/v1/workspaces/${workspaceId}/mcp-config?tool=${tool}`);

export const updateWorkspaceName = (workspaceId: string, name: string) =>
  apiRequest<Workspace>('PATCH', `/api/v1/workspaces/${workspaceId}`, { name });

export const updateWorkspace = (
  workspaceId: string,
  updates: { name?: string; ciCdEnabled?: boolean; intentReleaseTrigger?: IntentReleaseTrigger },
) => apiRequest<Workspace>('PATCH', `/api/v1/workspaces/${workspaceId}`, updates);

// Service Tokens
export interface ServiceTokenInfo {
  id: string;
  name: string;
  tokenPrefix: string | null;
  permissions: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const listTokens = (workspaceId: string) =>
  apiRequest<ServiceTokenInfo[]>('GET', `/api/v1/workspaces/${workspaceId}/tokens`);

export const createToken = (workspaceId: string, name: string) =>
  apiRequest<{ id: string; token: string; name: string; permissions: string[] }>(
    'POST',
    `/api/v1/workspaces/${workspaceId}/tokens`,
    { name },
  );

export const getTokenValue = (workspaceId: string, tokenId: string) =>
  apiRequest<{ token: string }>('GET', `/api/v1/workspaces/${workspaceId}/tokens/${tokenId}/value`);

export const revokeToken = (workspaceId: string, tokenId: string) =>
  apiRequest<void>('DELETE', `/api/v1/workspaces/${workspaceId}/tokens/${tokenId}`);

// Observability read wrappers (cloud dashboards). Response shapes mirror the
// server's metrics/agent-sessions services 1:1 — the interfaces live in
// ../shared/ipc-types.js (the renderer contract) and are referenced here as
// types to avoid duplicating the shapes.
export const getUsageAnalytics = (workspaceId: string, window: import('../shared/ipc-types.js').AnalyticsWindow) =>
  apiRequest<import('../shared/ipc-types.js').WorkspaceUsageAnalytics>(
    'GET',
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/analytics/usage?${new URLSearchParams(analyticsWindowParams(window)).toString()}`,
  );

export const getFeedbackRoadmap = (workspaceId: string, days: number) =>
  apiRequest<import('../shared/ipc-types.js').FeedbackRoadmap>(
    'GET',
    `/api/v1/workspaces/${workspaceId}/mcp-feedback/roadmap?days=${days}`,
  );

export const getFeedbackCorrelation = (workspaceId: string, days: number) =>
  apiRequest<import('../shared/ipc-types.js').FeedbackIssueCostCorrelation[]>(
    'GET',
    `/api/v1/workspaces/${workspaceId}/mcp-feedback/correlation?days=${days}`,
  );

/**
 * The paged records behind the roadmap aggregates. Sorting/paging always ride the
 * wire (the server's defaults are not this view's defaults); each optional filter
 * is appended only when set, so the unfiltered read keeps one stable URL.
 * The response stays `unknown`: observability-manager is the trust boundary.
 */
export const getFeedbackRecords = (
  workspaceId: string,
  window: import('../shared/ipc-types.js').AnalyticsWindow,
  filter: import('../shared/ipc-types.js').FeedbackRecordsFilter,
) => {
  const params = new URLSearchParams({
    ...analyticsWindowParams(window),
    page: String(filter.page),
    limit: String(filter.limit),
    sort: filter.sort,
    order: filter.order,
  });
  if (filter.area !== null) params.set('area', filter.area);
  if (filter.mine) params.set('mine', 'true');
  if (filter.userId !== null) params.set('userId', filter.userId);
  return apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp-feedback/records?${params.toString()}`,
  );
};

// Canonical Delivery v2 reads are JWT-only admin/owner routes. Keep their raw
// transport response unknown here: delivery-manager is the renderer trust
// boundary and projects only the explicitly shared fields before IPC returns.
export const getCanonicalDeliveryTasks = (workspaceId: string) =>
  apiRequest<unknown>('GET', `/api/v1/workspaces/${workspaceId}/delivery/v2/tasks`);

function canonicalPageQuery(limit: number, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) params.set('cursor', cursor);
  return params.toString();
}

function canonicalWorkspacePath(workspaceId: string): string {
  return encodeURIComponent(workspaceId);
}

export const getDeliverySummary = (
  workspaceId: string,
  window: import('../shared/ipc-types.js').AnalyticsWindow,
  lifecycle: import('../shared/ipc-types.js').DeliveryLifecycleFilter,
  mine: boolean,
  userId: string | null,
) => {
  const params = new URLSearchParams({ ...analyticsWindowParams(window), lifecycle });
  // The member filter rides the wire only when set, so the default read keeps its
  // existing URL. `mine` and `userId` are mutually exclusive (validated in MAIN).
  if (mine) params.set('mine', 'true');
  if (userId !== null) params.set('userId', userId);
  return apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/summary?${params.toString()}`,
  );
};

/**
 * `window` / `lifecycle` / `mine` / `userId` are appended only when supplied: an
 * absent filter keeps the server's current population and cursor scope (BR-6).
 */
export const getCanonicalTaskSummaries = (
  workspaceId: string,
  limit: number,
  cursor?: string,
  window?: import('../shared/ipc-types.js').AnalyticsWindow,
  lifecycle?: import('../shared/ipc-types.js').DeliveryLifecycleFilter,
  mine?: boolean,
  userId?: string | null,
) => {
  const params = new URLSearchParams(canonicalPageQuery(limit, cursor));
  if (window !== undefined)
    for (const [key, value] of Object.entries(analyticsWindowParams(window))) params.set(key, value);
  if (lifecycle !== undefined) params.set('lifecycle', lifecycle);
  if (mine === true) params.set('mine', 'true');
  if (userId !== undefined && userId !== null) params.set('userId', userId);
  return apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/task-summaries?${params.toString()}`,
  );
};

export const getCanonicalTaskDetail = (workspaceId: string, taskId: string) =>
  apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}`,
  );

function canonicalTaskPage(workspaceId: string, taskId: string, collection: string, limit: number, cursor?: string) {
  return apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}/${collection}?${canonicalPageQuery(limit, cursor)}`,
  );
}

export const getCanonicalTaskExternalRefs = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'external-refs', limit, cursor);

export const getCanonicalExternalRefStateHistory = (
  workspaceId: string,
  taskId: string,
  externalRefId: string,
  limit: number,
  cursor?: string,
) =>
  apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}/external-refs/${encodeURIComponent(externalRefId)}/state-history?${canonicalPageQuery(limit, cursor)}`,
  );

export const getCanonicalTaskRuns = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'runs', limit, cursor);

export const getCanonicalRunStageOccurrences = (
  workspaceId: string,
  taskId: string,
  runId: string,
  limit: number,
  cursor?: string,
) =>
  apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${canonicalWorkspacePath(workspaceId)}/delivery/v2/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stage-occurrences?${canonicalPageQuery(limit, cursor)}`,
  );

export const getCanonicalTaskCodeChanges = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'code-changes', limit, cursor);

export const getCanonicalTaskShipEvidence = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'ship-evidence', limit, cursor);

export const getCanonicalTaskReworkSignals = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'rework-signals', limit, cursor);

export const getCanonicalTaskArtifacts = (workspaceId: string, taskId: string, limit: number, cursor?: string) =>
  canonicalTaskPage(workspaceId, taskId, 'artifacts', limit, cursor);

export const getCanonicalArtifactRevisions = (workspaceId: string, artifactId: string) =>
  apiRequest<unknown>(
    'GET',
    `/api/v1/workspaces/${workspaceId}/delivery/v2/artifacts/${encodeURIComponent(artifactId)}/revisions`,
  );

// Intent knowledge base (cloud, spec §7). Response/request shapes mirror
// apps/server/src/modules/intent 1:1 and live in ../shared/intent-types.js so
// main, preload and renderer read one contract.
//
// Every mutation is a POST/PATCH with an idempotency key in its body — including
// the deletes, which the server models as explicit `…/delete` POSTs rather than
// DELETE-with-body (intermediaries are free to drop that body).

function intentPath(workspaceId: string, suffix: string, query?: URLSearchParams): string {
  const search = query && [...query.keys()].length > 0 ? `?${query.toString()}` : '';
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/intent/${suffix}${search}`;
}

/** Only defined values reach the query string; `includeArchived` is the server's literal `'true'`/`'false'`. */
function intentQuery(entries: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  return params;
}

export const getIntentTree = (workspaceId: string, query: IntentTreeQuery = {}) =>
  apiRequest<IntentTreeResponse>(
    'GET',
    intentPath(workspaceId, 'tree', intentQuery({ ...query, includeArchived: query.includeArchived })),
  );

export const getIntentDimensions = (workspaceId: string, query: IntentDimensionsQuery = {}) =>
  apiRequest<IntentDimensionsResponse>('GET', intentPath(workspaceId, 'dimensions', intentQuery({ ...query })));

export const listIntentFeatures = (workspaceId: string, query: IntentFeaturesQuery = {}) =>
  apiRequest<IntentFeaturesResponse>('GET', intentPath(workspaceId, 'features', intentQuery({ ...query })));

export const listIntentFeatureSeeds = (workspaceId: string, featureId: string, query: IntentTreeQuery = {}) =>
  apiRequest<IntentFeatureSeedsResponse>(
    'GET',
    intentPath(workspaceId, `features/${encodeURIComponent(featureId)}/seeds`, intentQuery({ ...query })),
  );

export const listIntentItems = (workspaceId: string, query: IntentItemsQuery = {}) =>
  apiRequest<IntentItemsResponse>('GET', intentPath(workspaceId, 'items', intentQuery({ ...query })));

/**
 * The candidates-only slice, cursor-paged, with the filter's `total` and the
 * workspace's waiting summary (spec §7). An ordinary intent read: member role,
 * `intent:read`, writes nothing.
 */
export const listIntentReviewQueue = (workspaceId: string, query: IntentReviewQueueQuery = {}) =>
  apiRequest<IntentReviewQueueResponse>('GET', intentPath(workspaceId, 'review-queue', intentQuery({ ...query })));

/**
 * The rich read (`mode=context`): payloads, sources, anchors with their §6.4
 * status, and per-repo graph provenance. `intentIds` is repeated rather than
 * comma-joined so an id containing a comma could never be split into two, and
 * `observed` is repeated for the same reason plus one of its own: the server
 * splits each value at its LAST `@`, so one repo per parameter is the grammar.
 *
 * `query.refresh` is deliberately absent from the wire — it is main's own signal
 * to re-read git before this call, never something the server is told.
 */
export const getIntentContext = (workspaceId: string, query: IntentContextQuery = {}) => {
  const params = intentQuery({
    mode: 'context',
    limit: query.limit,
    includeCandidates: query.includeCandidates,
  });
  for (const id of query.intentIds ?? []) params.append('intentIds', id);
  for (const state of query.observed ?? []) params.append('observed', state);
  return apiRequest<IntentContextResponse>('GET', intentPath(workspaceId, 'context', params));
};

export const listIntentItemTransitions = (workspaceId: string, itemId: string, query: IntentTransitionsQuery = {}) =>
  apiRequest<IntentTransitionsResponse>(
    'GET',
    intentPath(workspaceId, `items/${encodeURIComponent(itemId)}/transitions`, intentQuery({ ...query })),
  );

export const listIntentTransitions = (workspaceId: string, query: IntentTransitionsQuery = {}) =>
  apiRequest<IntentTransitionsResponse>('GET', intentPath(workspaceId, 'transitions', intentQuery({ ...query })));

/** Admin/owner + user session only; refusals arrive per decision inside a 200. */
export const reviewIntentItems = (workspaceId: string, body: IntentReviewRequest) =>
  apiRequest<IntentReviewResponse>('POST', intentPath(workspaceId, 'items/review'), body);

export const createIntentDomain = (workspaceId: string, body: IntentDomainCreateInput) =>
  apiRequest<IntentDomainMutationResponse>('POST', intentPath(workspaceId, 'domains'), body);

export const updateIntentDomain = (workspaceId: string, body: IntentDomainUpdateInput) =>
  apiRequest<IntentDomainMutationResponse>(
    'PATCH',
    intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}`),
    body,
  );

export const archiveIntentDomain = (workspaceId: string, body: IntentArchiveInput) =>
  apiRequest<IntentDomainMutationResponse>(
    'POST',
    intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}/archive`),
    body,
  );

export const deleteIntentDomain = (workspaceId: string, body: IntentDeleteInput) =>
  apiRequest<IntentDeleteResponse>(
    'POST',
    intentPath(workspaceId, `domains/${encodeURIComponent(body.id)}/delete`),
    body,
  );

export const createIntentFeature = (workspaceId: string, body: IntentFeatureCreateInput) =>
  apiRequest<IntentFeatureMutationResponse>('POST', intentPath(workspaceId, 'features'), body);

export const updateIntentFeature = (workspaceId: string, body: IntentFeatureUpdateInput) =>
  apiRequest<IntentFeatureMutationResponse>(
    'PATCH',
    intentPath(workspaceId, `features/${encodeURIComponent(body.id)}`),
    body,
  );

export const archiveIntentFeature = (workspaceId: string, body: IntentArchiveInput) =>
  apiRequest<IntentFeatureMutationResponse>(
    'POST',
    intentPath(workspaceId, `features/${encodeURIComponent(body.id)}/archive`),
    body,
  );

export const deleteIntentFeature = (workspaceId: string, body: IntentDeleteInput) =>
  apiRequest<IntentDeleteResponse>(
    'POST',
    intentPath(workspaceId, `features/${encodeURIComponent(body.id)}/delete`),
    body,
  );

export const putIntentFeatureSeed = (workspaceId: string, body: IntentSeedPutInput) =>
  apiRequest<IntentSeedMutationResponse>(
    'POST',
    intentPath(workspaceId, `features/${encodeURIComponent(body.featureId)}/seeds`),
    body,
  );

export const deleteIntentFeatureSeed = (workspaceId: string, body: IntentSeedDeleteInput) =>
  apiRequest<IntentDeleteResponse>(
    'POST',
    intentPath(workspaceId, `features/${encodeURIComponent(body.featureId)}/seeds/delete`),
    body,
  );

/**
 * Re-capture one anchor's baseline. The ids in the path are ALSO in the body —
 * the server asserts the two agree rather than preferring one, because the MCP
 * surface has no path — so both travel.
 */
export const refreshIntentAnchor = (workspaceId: string, body: IntentAnchorRefreshInput) =>
  apiRequest<IntentAnchorRefreshResponse>(
    'POST',
    intentPath(workspaceId, `items/${encodeURIComponent(body.itemId)}/anchors/refresh`),
    body,
  );

export interface ResolveTarget {
  repoName: string;
  parsedVersion: string;
  summaryVersion?: string;
  embeddingsVersion?: string;
  commitSha?: string;
}

/**
 * With `targets`, this publishes the whole batch as one graph version — one
 * build and one stored object for the sync instead of one per repository.
 * Without them it keeps its original meaning: recompute cross-repo resolution
 * over whatever is already published.
 */
export const resolveWorkspace = (workspaceId: string, targets?: readonly ResolveTarget[]) =>
  apiRequest<unknown>(
    'POST',
    `/api/v1/workspaces/${workspaceId}/resolve?sync=true`,
    targets && targets.length > 0 ? { targets } : undefined,
  );

export const putMapper = (workspaceId: string, mapper: unknown, options: { defer?: boolean } = {}) =>
  apiRequest<{ sha256: string; r2Key: string; sizeBytes: number }>(
    'PUT',
    `/api/v1/workspaces/${workspaceId}/mapper${options.defer ? '?defer=true' : ''}`,
    mapper,
  );

interface UploadResultResponse {
  version: string;
  sizeBytes: number;
  duplicate: boolean;
}

interface UploadSummaryResponse {
  version: string;
  sizeBytes: number;
}

interface JobStatusResponse {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  result: unknown;
  lastError: string | null;
}

const uploadResult = (workspaceId: string, repoName: string, parsedRepo: unknown) =>
  apiRequest<UploadResultResponse>(
    'POST',
    `/api/v1/workspaces/${workspaceId}/repos/${repoName}/results/upload`,
    parsedRepo,
  );

const uploadSummary = (workspaceId: string, repoName: string, summaryOutput: unknown) =>
  apiRequest<UploadSummaryResponse>(
    'POST',
    `/api/v1/workspaces/${workspaceId}/repos/${repoName}/summaries/upload`,
    summaryOutput,
  );

const uploadEmbeddings = (workspaceId: string, repoName: string, embeddingsOutput: unknown) =>
  apiRequest<{ version: string }>(
    'POST',
    `/api/v1/workspaces/${workspaceId}/repos/${repoName}/embeddings/upload`,
    embeddingsOutput,
  );

const getJobStatus = (workspaceId: string, jobId: string) =>
  apiRequest<JobStatusResponse>('GET', `/api/v1/workspaces/${workspaceId}/jobs/${jobId}`);

/**
 * Push a repo to the cloud via R2 upload + version-reference push.
 *
 * Flow: upload ParsedRepo to R2 → upload summaries to R2 → enqueue push
 * job with version references → poll until done.
 *
 * This replaces the legacy envelope path that sent the entire 4-8MB
 * ParsedRepo as the push body (stored in PostgreSQL job queue, then
 * deserialized by the worker). The version-based flow stores only a
 * ~100-byte version reference in the job queue; the worker reads from R2.
 */
/**
 * Uploads a repository's artifacts and returns the selection a batch resolve
 * must pin. Nothing is published for this repository until that resolve runs.
 */
export async function uploadRepoArtifacts(
  workspaceId: string,
  repoName: string,
  parsedRepo: unknown,
  summaryOutput?: unknown,
  embeddingsOutput?: unknown,
): Promise<ResolveTarget> {
  const { version: parsedVersion } = await uploadResult(workspaceId, repoName, parsedRepo);

  let summaryVersion: string | undefined;
  if (summaryOutput) {
    const res = await uploadSummary(workspaceId, repoName, summaryOutput);
    summaryVersion = res.version;
  }

  let embeddingsVersion: string | undefined;
  if (embeddingsOutput) {
    const res = await uploadEmbeddings(workspaceId, repoName, embeddingsOutput);
    embeddingsVersion = res.version;
  }

  return { repoName, parsedVersion, summaryVersion, embeddingsVersion };
}

export async function pushRepo(
  workspaceId: string,
  repoName: string,
  parsedRepo: unknown,
  summaryOutput?: unknown,
  embeddingsOutput?: unknown,
): Promise<{ repoName: string; nodesInserted: number; edgesInserted: number }> {
  const { parsedVersion, summaryVersion, embeddingsVersion } = await uploadRepoArtifacts(
    workspaceId,
    repoName,
    parsedRepo,
    summaryOutput,
    embeddingsOutput,
  );

  const pushBody: Record<string, string> = { parsedVersion };
  if (summaryVersion) pushBody.summaryVersion = summaryVersion;
  if (embeddingsVersion) pushBody.embeddingsVersion = embeddingsVersion;

  const pushRes = await apiRequest<
    { jobId: string; status: 'queued' } | { repoName: string; nodesInserted: number; edgesInserted: number }
  >('POST', `/api/v1/workspaces/${workspaceId}/repos/${repoName}/push?defer=true`, pushBody);

  if ('repoName' in pushRes) return pushRes;

  const { jobId } = pushRes;
  const POLL_INTERVAL_MS = 10_000;
  const MAX_POLL_MS = 10 * 60 * 1_000;
  const start = Date.now();

  while (Date.now() - start < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const job = await getJobStatus(workspaceId, jobId);

    if (job.status === 'succeeded') {
      const r = job.result as { repoName?: string; nodesInserted?: number; edgesInserted?: number } | null;
      return {
        repoName: r?.repoName ?? repoName,
        nodesInserted: r?.nodesInserted ?? 0,
        edgesInserted: r?.edgesInserted ?? 0,
        ...(r ?? {}),
      };
    }

    if (job.status === 'failed') {
      throw new Error(`Push job ${jobId} ${job.status}: ${job.lastError ?? 'unknown error'}`);
    }
  }

  throw new Error(`Push job ${jobId} timed out after ${MAX_POLL_MS / 1000}s`);
}

export const getIntentReleasePreview = (workspaceId: string, itemId: string) =>
  apiRequest<IntentReleasePreview>(
    'GET',
    intentPath(workspaceId, `items/${encodeURIComponent(itemId)}/release-preview`),
  );
export const getIntentReleasePreviews = (workspaceId: string, itemIds: string[]) =>
  apiRequest<IntentReleasePreview[]>('POST', intentPath(workspaceId, 'items/release-preview'), { itemIds });
export const listIntentReleases = (workspaceId: string, beforeSeq?: number) =>
  apiRequest<IntentReleaseHistory>('GET', intentPath(workspaceId, 'releases', intentQuery({ limit: 25, beforeSeq })));
export const recordIntentRelease = (workspaceId: string, action: IntentReleaseAction, body: IntentReleaseWrite) => {
  let suffix: string;
  switch (action) {
    case 'release':
    case 'baseline':
      suffix = 'releases';
      break;
    case 'rollback':
      suffix = `releases/${encodeURIComponent(String(body.releaseSeq))}/rollback`;
      break;
    case 'plan':
    case 'withdraw':
    case 'reinstate':
      suffix = `items/${encodeURIComponent(body.itemId ?? '')}/plan${action === 'plan' ? '' : `/${action}`}`;
      break;
    default:
      throw new Error('Unsupported intent release action');
  }
  return apiRequest<unknown>('POST', intentPath(workspaceId, suffix), body);
};

export const listIntentSources = (workspaceId: string, search: string) =>
  apiRequest<IntentSourcesResponse>('GET', intentPath(workspaceId, 'sources', intentQuery({ search })));
