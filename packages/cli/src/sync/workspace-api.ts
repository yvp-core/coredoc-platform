/**
 * Thin fetch wrappers for the four workspace endpoints used by `coredoc sync`:
 *   POST   /api/v1/workspaces                                  — create
 *   GET    /api/v1/workspaces/:id                              — probe (auth + existence)
 *   POST   /api/v1/workspaces/:id/repos                        — upsert repo
 *   GET    /api/v1/workspaces/:id/repos/:repoName/state        — delta probe
 *
 * Each helper maps documented status codes to typed errors so the orchestrator
 * can branch without parsing error strings.
 */

import { CLI_VERSION as VERSION } from '../version.js';
import { getToken, getServerUrl } from '../auth.js';

export class SlugTakenError extends Error {
  constructor(public readonly slug: string) {
    super(`Slug '${slug}' is taken`);
    this.name = 'SlugTakenError';
  }
}

export class WorkspaceForbiddenError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`No access to workspace ${workspaceId}`);
    this.name = 'WorkspaceForbiddenError';
  }
}

export class WorkspaceNotFoundError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`Workspace ${workspaceId} not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export interface CreateWorkspaceBody {
  name: string;
  slug: string;
}

export interface CreateWorkspaceResponse {
  id: string;
  name: string;
  slug: string;
}

export interface ConnectRepoBody {
  repoKey: string;
  repoName: string;
  repoType?: string;
  /**
   * The `origin` remote URL. The delivery importer links a GitHub PR to this
   * repo ONLY through it (`parseGithubRepo(WorkspaceRepo.gitUrl)`), so a repo
   * connected without it never gets its PRs — and a merge records no release.
   */
  gitUrl?: string;
  /** Tri-state: undefined = leave alone; string sets it; null clears server value. */
  httpPrefix?: string | null;
  /**
   * The DURABLE repo identity intent anchors and feature seeds address this
   * repository by — `repos[].key ?? repos[].name`, the exact string `repoKey`
   * was hashed from. Without it the server can only bind repos whose name IS
   * their key, so an explicitly-keyed repo stays unbound forever and every
   * anchor against it fails `unknown_repo_key`. Omitted (rather than sent
   * wrong) when it does not reproduce `repoKey`; see `repo-sync.ts`.
   */
  intentRepoKey?: string;
}

export interface ConnectRepoResponse {
  id?: string;
  alreadyConnected: boolean;
}

export interface RepoStateResponse {
  repoKey: string;
  repoName: string;
  lastParseHash: string | null;
  lastPushedAt: string | null;
  lastPushedByUserId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  currentSummaryVersion: string | null;
  /** Published pointer; absent only when talking to a pre-field server. */
  currentEmbeddingsVersion?: string | null;
  summaryUploadedAt: string | null;
}

async function authHeaders(): Promise<{ Authorization: string; 'Content-Type': 'application/json' }> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated. Run: coredoc login (or set COREDOC_TOKEN)');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export async function createWorkspace(body: CreateWorkspaceBody): Promise<CreateWorkspaceResponse> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (response.status === 409) throw new SlugTakenError(body.slug);
  if (!response.ok) {
    throw new Error(`createWorkspace failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as CreateWorkspaceResponse;
}

export async function getWorkspace(
  workspaceId: string,
): Promise<{ id: string; graphBackend?: string; capabilities?: { batchResolveTargets?: boolean } }> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (response.status === 403) throw new WorkspaceForbiddenError(workspaceId);
  if (response.status === 404) throw new WorkspaceNotFoundError(workspaceId);
  if (!response.ok) {
    throw new Error(`getWorkspace failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { id: string };
}

export async function connectRepo(workspaceId: string, body: ConnectRepoBody): Promise<ConnectRepoResponse> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/repos`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (response.status === 409) return { alreadyConnected: true };
  if (!response.ok) {
    throw new Error(`connectRepo failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { id?: string };
  return { id: json.id, alreadyConnected: false };
}

export interface UpdateRepoBody {
  /** Tri-state: undefined leaves the stored value alone; null clears it; string sets it. */
  gitUrl?: string | null;
  repoType?: string | null;
  httpPrefix?: string | null;
  /**
   * Durable repo identity — see {@link ConnectRepoBody.intentRepoKey}. Sent on
   * the PATCH path too, deliberately: it is the ONLY remedy for a repo that was
   * connected by an older client and left with a null identity, because
   * reconnecting it just answers "already connected".
   */
  intentRepoKey?: string;
}

/**
 * PATCH updateRepo — pushes mutable connect-time fields (gitUrl, repoType,
 * httpPrefix) for an already-connected repo. Required because POST /repos is
 * create-only; without this, changed `httpPrefix` or `repoType` in the local
 * config never propagates to the server (the cross-repo resolver reads
 * httpPrefix from the control plane).
 */
export async function updateRepo(workspaceId: string, repoKey: string, body: UpdateRepoBody): Promise<void> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/repos/${encodeURIComponent(repoKey)}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (response.status === 404) {
    // Treat as no-op: repo was removed between connectRepo (409) and now.
    return;
  }
  if (!response.ok) {
    throw new Error(`updateRepo failed (${response.status}): ${await response.text()}`);
  }
}

export async function getRepoState(workspaceId: string, repoName: string): Promise<RepoStateResponse | null> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/repos/${repoName}/state`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`getRepoState failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as RepoStateResponse;
}

export interface ResolveMetrics {
  resolved: number;
  total: number;
  rate: number;
  legacyEdges: number;
  mapperSha: string | null;
}

/**
 * Shape depends on the workspace backend. Turso's inline resolver returns the
 * metrics at the top level. A file-snapshot `?sync=true` resolve returns the
 * published job result: metrics nested under `resolution` (null on the
 * idempotent no-op fast path), plus per-repository counts for a batch.
 */
export type ResolveWorkspaceResponse =
  | ResolveMetrics
  | {
      versionId: string;
      idempotent: boolean;
      resolution: ResolveMetrics | null;
      repositories?: Array<{ repoName: string; nodeCount: number; edgeCount: number }>;
    };

/**
 * Trigger one workspace-wide cross-repo resolution pass. Used by `coredoc sync`
 * after a batch of deferred pushes to collapse N resolver runs into one.
 */
export interface ResolveTarget {
  repoName: string;
  parsedVersion: string;
  summaryVersion?: string;
  embeddingsVersion?: string;
  commitSha?: string;
}

export async function resolveWorkspace(
  workspaceId: string,
  options: { sync?: boolean; targets?: readonly ResolveTarget[] } = {},
): Promise<ResolveWorkspaceResponse | QueuedJobReceipt> {
  const serverUrl = await getServerUrl();
  const qs = options.sync ? '?sync=true' : '';
  const targets = options.targets ?? [];
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/resolve${qs}`, {
    method: 'POST',
    headers: { ...(await authHeaders()), ...(targets.length > 0 ? { 'Content-Type': 'application/json' } : {}) },
    ...(targets.length > 0 ? { body: JSON.stringify({ targets }) } : {}),
  });
  if (response.status === 403) throw new WorkspaceForbiddenError(workspaceId);
  if (response.status === 404) throw new WorkspaceNotFoundError(workspaceId);
  if (!response.ok) {
    throw new Error(`resolveWorkspace failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as ResolveWorkspaceResponse | QueuedJobReceipt;
}

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type JobType = 'push' | 'resolve';

export interface JobResponse {
  id: string;
  workspaceId: string;
  repoName: string | null;
  type: JobType;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
}

export interface QueuedJobReceipt {
  jobId: string;
  status: 'queued';
}

// =============================================================================
// Version handshake
// =============================================================================

/**
 * Oldest Coredoc server this CLI supports — the current release line, which is
 * also the first line that serves `GET /api/v1/meta`. Hand-bumped when the CLI
 * starts depending on a newer server capability.
 */
export const MIN_SERVER_VERSION = '1.1.0';

interface ServerMeta {
  version: string;
  minClientVersion: string;
}

/**
 * Numeric compare of `major.minor.patch`, prerelease/build suffixes cut. Local
 * on purpose: the desktop keeps its own copy (apps/desktop/src/main/version-compat.ts)
 * and neither process should grow a shared dependency for six lines. Throws
 * rather than guessing when a version is not three numeric parts.
 */
function compareSemver(a: string, b: string): number {
  const parts = (value: string): number[] => {
    const nums = value.trim().split(/[-+]/)[0].split('.');
    if (nums.length !== 3 || nums.some((part) => !/^\d+$/.test(part))) {
      throw new TypeError(`Not a semver version: ${value}`);
    }
    return nums.map(Number);
  };
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Advisory version handshake, run by the network-facing commands before they
 * talk to a server. Prints one warning line on a mismatch and returns — no hard
 * block: an on-prem server that lags the CLI usually still serves the request,
 * and a real incompatibility surfaces as the command's own error.
 *
 * A 404 means the server predates the meta endpoint, which is itself the "too
 * old" signal. Every other failure (unreachable, malformed body, non-semver
 * version) is "unknown" and stays silent — the command that follows reports the
 * real problem.
 */
/** Advisory check — never worth more than a few seconds of a push's wall clock. */
const META_TIMEOUT_MS = 3000;

export async function checkServerCompat(serverUrl: string): Promise<void> {
  let meta: ServerMeta | null;
  try {
    // Unauthenticated, like /health: no token is needed and none is sent.
    // Bounded: this runs before every remote push, and a server that accepts
    // the connection but never answers must not hang the push behind an
    // advisory version check.
    const response = await fetch(`${serverUrl}/api/v1/meta`, {
      method: 'GET',
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
    if (response.status === 404) {
      meta = null;
    } else if (!response.ok) {
      return;
    } else {
      const body = (await response.json()) as Partial<ServerMeta>;
      if (typeof body.version !== 'string' || typeof body.minClientVersion !== 'string') return;
      meta = { version: body.version, minClientVersion: body.minClientVersion };
    }
  } catch {
    return;
  }

  if (meta === null) {
    console.warn(
      'Warning: this Coredoc server is older than the CLI supports (no /api/v1/meta) — ask your admin to upgrade the server.',
    );
    return;
  }

  try {
    if (compareSemver(meta.version, MIN_SERVER_VERSION) < 0) {
      console.warn(
        `Warning: Coredoc server v${meta.version} is older than this CLI supports (v${MIN_SERVER_VERSION}+) — ask your admin to upgrade the server.`,
      );
      return;
    }
    if (compareSemver(VERSION, meta.minClientVersion) < 0) {
      console.warn(
        `Warning: this CLI (v${VERSION}) is older than the server supports (v${meta.minClientVersion}+) — update the CLI.`,
      );
    }
  } catch {
    // Non-semver version on either side: unknown, not a proven mismatch.
  }
}

// =============================================================================
// Intent transport (spec §8.1, §9, §12)
// =============================================================================

/**
 * The server's public refusal, verbatim (§12): machine-readable `code`, bounded
 * human `message`, and the EXACT failing field path.
 *
 * Structurally mirrored rather than imported — the CLI does not depend on
 * `@coredoc/server` — and deliberately widened to `string` for `code`: the code
 * set is the server's contract to grow, and a CLI that only recognised today's
 * members would render tomorrow's as "unknown error".
 */
export interface IntentPublicErrorBody {
  code: string;
  message: string;
  path: string[];
  details?: Array<{ code: string; message: string; path: string[] }>;
}

/**
 * How much of a NON-contract error body is kept.
 *
 * The structured `{code, message, path, details}` is never truncated — that is
 * the whole point of this class. This bound applies only to the other case: a
 * proxy's HTML page, a gateway timeout, anything that is not the intent error
 * shape, where an unbounded dump into the terminal helps nobody.
 */
const MAX_RAW_ERROR_BODY_CHARS = 4096;

/**
 * A structured intent refusal from the server.
 *
 * THE NAMED §12 DEFECT THIS FIXES: the archived `postIntentHandover` read the
 * response body, threw away everything in it, and reported a generic hint. A
 * maintainer whose overlay was refused for one email address in one field saw
 * "preflight failed" and had no way to find the field. Here the body is parsed
 * into {@link publicError} when it has the contract shape and preserved in
 * {@link rawBody} when it does not — either way nothing is discarded, and the
 * renderer in `commands/intent-cloud.ts` prints it without summarizing.
 */
export class IntentApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly publicError: IntentPublicErrorBody | undefined,
    readonly rawBody: string,
  ) {
    super(
      publicError
        ? `${operation} refused (${status} ${publicError.code}): ${publicError.message}`
        : `${operation} failed (${status})`,
    );
    this.name = 'IntentApiError';
  }
}

/** `{code, message, path}` with the right primitive types, or `undefined`. */
function readIntentPublicError(body: string): IntentPublicErrorBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return undefined;
  if (!Array.isArray(candidate.path) || candidate.path.some((entry) => typeof entry !== 'string')) return undefined;

  const details = Array.isArray(candidate.details)
    ? candidate.details.filter(
        (entry): entry is { code: string; message: string; path: string[] } =>
          entry !== null &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).code === 'string' &&
          typeof (entry as Record<string, unknown>).message === 'string' &&
          Array.isArray((entry as Record<string, unknown>).path),
      )
    : undefined;

  return {
    code: candidate.code,
    message: candidate.message,
    path: candidate.path as string[],
    ...(details && details.length > 0 ? { details } : {}),
  };
}

async function intentFailure(operation: string, response: Response): Promise<IntentApiError> {
  const body = await response.text().catch(() => '');
  const bounded = body.length > MAX_RAW_ERROR_BODY_CHARS ? `${body.slice(0, MAX_RAW_ERROR_BODY_CHARS)}…` : body;
  return new IntentApiError(operation, response.status, readIntentPublicError(body), bounded);
}

export interface ImportIntentOverlayBody {
  idempotencyKey: string;
  /** sha256 hex of the canonical overlay bytes; recorded on every arrival transition. */
  localRevision: string;
  overlay: Record<string, unknown>;
}

/** The fields `coredoc intent import` reports. The server's result carries more; extra keys are kept by the caller. */
export interface CloudIntentImportResult {
  formatVersion: number;
  workspaceId: string;
  localRevision: string;
  projectId: string;
  createdDomains: Array<{ id: string; title: string }>;
  importedItems: Array<{ id: string; authority: string; domainId: string }>;
  importedSourceCount: number;
  importedAnchorCount: number;
  skippedAnchors: Array<{ repo: string; reason: string; anchorCount: number; itemIds: string[] }>;
  droppedRelations: Array<{ from: string; type: string; to: string }>;
  registeredRepoIdentities: string[];
}

/**
 * `POST …/intent/import`. Idempotent by key: a retry after a network failure
 * returns the STORED result rather than importing twice, which is what makes
 * "rerun the same command" the recovery for a crashed cutover write.
 */
export async function importIntentOverlay(
  workspaceId: string,
  body: ImportIntentOverlayBody,
): Promise<CloudIntentImportResult> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/intent/import`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await intentFailure('intent import', response);
  return (await response.json()) as CloudIntentImportResult;
}

/**
 * The import's preconditions as the server sees them (`GET …/intent/import/preflight`).
 *
 * Read-only, and the SAME rule the import asserts: the counts come from the
 * function `IntentImportService` calls before it writes, so a green preflight
 * and a refused import cannot disagree about what "empty" means.
 */
export interface IntentImportPreflight {
  workspaceId: string;
  empty: boolean;
  content: { domains: number; features: number; items: number; dimensions?: number };
  /** Display rendering, unbound repos included. */
  registeredRepoIdentities: string[];
  /** The bound durable keys an overlay anchor's `repo` is checked against. */
  intentRepoKeys: string[];
}

export async function getIntentImportPreflight(workspaceId: string): Promise<IntentImportPreflight> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/intent/import/preflight`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (!response.ok) throw await intentFailure('intent bootstrap-check', response);
  return (await response.json()) as IntentImportPreflight;
}

/** The export document. `content` stays opaque here: the CLI writes it verbatim, it does not interpret it. */
export interface CloudIntentExportDocument {
  formatVersion: number;
  generatedAt: string;
  contentHash: string;
  content: unknown;
}

export async function exportIntent(workspaceId: string): Promise<CloudIntentExportDocument> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/intent/export`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (!response.ok) throw await intentFailure('intent export', response);
  return (await response.json()) as CloudIntentExportDocument;
}

export async function getJob(workspaceId: string, jobId: string): Promise<JobResponse | null> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/jobs/${jobId}`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (response.status === 404) return null;
  if (response.status === 403) throw new WorkspaceForbiddenError(workspaceId);
  if (!response.ok) {
    throw new Error(`getJob failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as JobResponse;
}

/**
 * The automatic actor's body for `POST …/intent/releases` (amendment §3.2).
 *
 * No `included`, no `contentHash`, no `expectedHeadSeq`: the PR trailers are
 * the only statement of what shipped, the server resolves each hash from the
 * named version, and ordering is decided by `deployedAt`. `deployId` and
 * `deployedAt` are properties of the DEPLOYMENT RUN, so a retried step carries
 * the same pair, replays the same idempotency key, and cannot leapfrog a later
 * release.
 */
export interface RecordIntentReleaseBody {
  kind: 'release';
  repoKey: string;
  deliveredRef: string;
  deployId: string;
  /** ISO datetime, the deploy run's start time — never the record step's clock. */
  deployedAt: string;
  /** Optional explicit operation; otherwise the server records every merged PR the deployed ref includes. */
  handoffId?: string;
}

/** What the record route answers. Only the fields the CLI renders are typed; the rest is the server's to grow. */
/** One entry per included merged PR when the server resolved the deploy itself (no handoffId). */
export interface CloudIntentDeployDelivery {
  handoffId: string;
  pr: number;
  outcome: string;
  seq?: number;
  reason?: string;
}
export type CloudIntentReleaseResult =
  | CloudIntentRecordedRelease
  | { outcome: 'no_delivery'; reason: string; deliveries?: CloudIntentDeployDelivery[] };
export interface CloudIntentRecordedRelease {
  deliveries?: CloudIntentDeployDelivery[];
  event: {
    seq: number;
    kind: string;
    recordedAt: string;
    reason?: string;
    data: {
      deliveredRef?: string;
      /** Item ids; the hashes live in a sibling `contentHashes` map the CLI does not print. */
      included?: string[];
      retired?: string[];
      actorKind?: string;
      deployId?: string;
      orderingToken?: string;
      pr?: { repoKey: string; number: number; url?: string };
    };
  };
  headSeq: number;
  currentReleaseSeq: number | null;
}

/**
 * `POST …/intent/releases`. Idempotent by `<repoKey>:<deliveredRef>:<deployId>`:
 * a retry of ONE delivery replays the original record (2xx, same body), while a
 * new deploy of the same artifact carries a new `deployId` and records again.
 */
export async function recordIntentRelease(
  workspaceId: string,
  body: RecordIntentReleaseBody,
): Promise<CloudIntentReleaseResult> {
  const serverUrl = await getServerUrl();
  const response = await fetch(`${serverUrl}/api/v1/workspaces/${workspaceId}/intent/releases`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await intentFailure('intent release', response);
  return (await response.json()) as CloudIntentReleaseResult;
}
