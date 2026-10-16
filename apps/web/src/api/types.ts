/**
 * Local API response types for the web app's data layer. Each type mirrors a
 * specific server response shape — auth (`GET /api/v1/me`), workspace config,
 * repos, members, tokens, jobs and metrics — with the mirrored server file
 * cited on each type below.
 *
 * TODO: move to @coredoc/core once the API surface stabilizes and other
 * clients (MCP, CLI) need the same shape — not worth the shared-package
 * indirection for a single caller yet (YAGNI).
 */

import type { IntentReleaseTrigger } from '../features/intent/release-types.js';

// The server's AuthUser also carries `serviceTokenTeamId?` — intentionally
// omitted: it only exists for cdt_ service-token auth, never for browser
// cookie sessions.
interface MeUser {
  id: string;
  email: string;
  displayName?: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  intentEnabled: boolean;
  /** Agent runs are enabled, or the workspace already has runs; gates the nav entry. */
  agentRunsEnabled: boolean;
}

export interface MeResponse {
  user: MeUser;
  workspaces: Workspace[];
}

/**
 * Mirrors `WorkspaceConfig` in
 * apps/server/src/modules/workspaces/config/workspace-config.service.ts
 * (served by `GET /api/v1/workspaces/:id/config`,
 * workspace-config.controller.ts). Dates are ISO strings — the server calls
 * `.toISOString()` on every Date field before returning.
 */
export interface WorkspaceConfigWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  isCloud: boolean;
  ciCdEnabled: boolean;
}

interface WorkspaceConfigMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
}

export interface WorkspaceConfig {
  workspace: WorkspaceConfigWorkspace;
  members: WorkspaceConfigMember[];
}

/**
 * Mirrors the raw `WorkspaceRepo` control-plane row returned by
 * `GET /api/v1/workspaces/:id/repos` — repos.controller.ts `listRepos` →
 * repos.service.ts `listRepos` → ControlPlaneService.listRepos, which is a
 * bare `prisma.workspaceRepo.findMany` with no projection, so the wire shape
 * is the full model from apps/server/prisma/schema.prisma (`WorkspaceRepo`),
 * push-tracking and R2 version fields included. Dates are ISO strings over
 * JSON.
 */
export interface WorkspaceRepo {
  id: string;
  workspaceId: string;
  repoKey: string;
  repoName: string;
  gitUrl: string | null;
  repoType: string | null;
  httpPrefix: string | null;
  /** Branch that counts as production for intent releases; null = connector default. */
  productionBranch: string | null;
  /** Per-repo release-trigger override; null = inherit the workspace default. */
  intentReleaseTrigger: IntentReleaseTrigger | null;
  createdAt: string;
  lastParseHash: string | null;
  lastPushedAt: string | null;
  lastPushedByUserId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  lastParsedVersion: string | null;
  lastSummaryVersion: string | null;
  lastEmbedVersion: string | null;
}

/**
 * Mirrors the `WorkspaceMember` control-plane row returned by
 * `GET /api/v1/workspaces/:id/members` — members.controller.ts `listMembers`
 * → members.service.ts → `ControlPlaneService.listMembers`, a bare
 * `prisma.workspaceMember.findMany` with no projection (same
 * no-projection pattern as `WorkspaceRepo` above), so the wire shape is the
 * full `WorkspaceMember` model from apps/server/prisma/schema.prisma. Role
 * values mirror `WorkspaceMemberRole`
 * (apps/server/src/modules/members/dto/workspace-role.enum.ts):
 * 'owner' | 'admin' | 'member'. `pending` is always `false` on this endpoint
 * in practice (pending rows are surfaced separately via `PendingInvite`
 * below) but the field exists on the model, so it's typed here too rather
 * than assumed absent.
 */
export interface Member {
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  pending: boolean;
  joinedAt: string;
}

/**
 * Mirrors the invitation lifecycle projection returned by
 * `MembersService.listPendingInvites`. WorkOS delivery metadata is exposed as
 * booleans/timestamps only; provider invitation ids never cross this API.
 */
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

export interface InviteMemberResult {
  invited: true;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}

export interface ResendInviteResult {
  resent: boolean;
  emailSent: boolean;
  expiresAt: string | null;
  signInUrl: string;
}

export interface RevokeInviteResult {
  revoked: true;
  emailRevoked: boolean | null;
}

export interface RemoveMemberResult {
  removed: true;
  providerCleanupSucceeded: boolean | null;
}

/**
 * Mirrors `TokenInfo` in apps/server/src/modules/tokens/tokens.service.ts —
 * served by `GET /api/v1/workspaces/:id/tokens` (tokens.controller.ts
 * `listTokens`). Never carries the plaintext value; `tokenPrefix` (e.g.
 * "cdt_a1b2c3d4") is the only identifying fragment for a list row.
 */
export interface Token {
  id: string;
  name: string;
  tokenPrefix: string | null;
  permissions: string[];
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Mirrors `CreateTokenResult` in
 * apps/server/src/modules/tokens/tokens.service.ts (interface at lines
 * 18-26) — served by `POST /api/v1/workspaces/:id/tokens`
 * (tokens.controller.ts `createToken`). Exactly the wire shape:
 * `{ id, name, token, permissions, expiresAt, createdAt }` — the create
 * response does NOT carry `tokenPrefix`, `createdBy`, or `lastUsedAt`
 * (those are `TokenInfo`/list-only fields), hence a Pick of `Token`, not an
 * extension of it. The plaintext `token` is returned exactly once, on
 * creation; it is never part of `Token` above and is not persisted anywhere
 * the client can refetch it from (only `GET /tokens/:tokenId/value` can
 * return it again, and only when the server has encrypted-storage
 * configured — see the `reveal` mutation in queries/tokens.ts).
 */
export type CreateTokenResult = Pick<Token, 'id' | 'name' | 'permissions' | 'expiresAt' | 'createdAt'> & {
  token: string;
};

/**
 * Mirrors the wire shape `WorkspacesService.getMcpConfig` returns — served by
 * `GET /api/v1/workspaces/:id/mcp-config` (workspaces.controller.ts
 * `getMcpConfig`, member role). The server-side method itself is typed as
 * `Promise<Record<string, unknown>>` (workspaces.service.ts:54); this is the
 * one concrete shape it actually constructs today:
 * `{ mcpServers: { coredoc: { url, type: 'http' } } }`, a single entry keyed
 * `"coredoc"`. `url` is `${MCP_SERVER_URL}/api/v1/workspaces/:id/mcp` — the
 * workspace-scoped MCP path the mcp-rewrite middleware rewrites internally to
 * `/mcp` (apps/server/src/mcp/mcp-rewrite.middleware.ts). No OAuth metadata,
 * transport-hint, or plugin-URL field is included yet (the B0 plugin
 * productization/marketplace-generator work is still unbuilt per
 * docs/product-strategy-2026-07.md §10) — this type only claims what the
 * server actually sends.
 */
export interface McpConfig {
  mcpServers: Record<string, { url: string; type: string }>;
}

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * Mirrors `JobResponse` in apps/server/src/modules/jobs/dto/job-response.dto.ts
 * (served by `GET /api/v1/workspaces/:id/jobs` and `.../jobs/:jobId`,
 * jobs.controller.ts). Dates are ISO strings over the wire (NestJS/Express
 * JSON-serializes `Date` fields that way) even though the server-side
 * interface types them as `Date`.
 *
 * Deliberately omits fields the server strips from this response:
 * `payload` (can be megabytes; legacy-path ParsedRepo) and `queuedByUserId`
 * (internal actor id, not part of the documented contract) — see the
 * comment on `JobResponse` in job-response.dto.ts.
 */
export interface Job {
  id: string;
  workspaceId: string;
  repoName: string | null;
  type: 'push' | 'resolve';
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
}

// ---------------------------------------------------------------------------
// Observability dashboards (B2-1) — SDLC / feedback roadmap / MCP usage.
// Each type mirrors a server response shape over existing REST (no new
// endpoints). Cost fields arrive PRE-COMPUTED from telemetry (`cost_usd`), so
// the SDLC dashboard needs no client-side pricing table.
// ---------------------------------------------------------------------------

/**
 * Mirrors `SessionSummary` (agent-sessions.service.ts), served by
 * `GET /api/v1/workspaces/:id/sessions/summary?days=`.
 */
export interface SessionSummary {
  sessionCount: number;
  distinctUserCount: number;
  // null when there are no sessions in the window — render as "no data", not 0.
  medianTokens: number | null;
  medianActiveTimeSec: number | null;
  medianCoredocToolCalls: number | null;
}

/**
 * Mirrors the return of `MetricsService.getWorkspaceSummary`, served by
 * `GET /api/v1/workspaces/:id/metrics/summary`. Coverage fields are ratios in
 * [0, 1].
 */
export interface MetricsSummary {
  totalNodes: number;
  totalEdges: number;
  totalEntrypoints: number;
  totalEntities: number;
  totalExternalCalls: number;
  totalComponents: number;
  summaryCoverage: number;
  embeddingCoverage: number;
}

/** Mirrors `GET /api/v1/workspaces/:id/metrics/mcp/count`. */
export interface McpQueryCount {
  count: number;
}

/** Series names accepted by `GET /api/v1/workspaces/:id/metrics/timeseries?metric=`. */
export type TimeseriesMetric = 'mcp_calls' | 'sessions' | 'cost' | 'nodes';

/** One day bucket in {@link MetricsTimeseries}. `date` is a UTC 'YYYY-MM-DD' key. */
export interface TimeseriesPoint {
  date: string;
  value: number;
}

/**
 * Mirrors the return of `MetricsService.getTimeseries`, served by
 * `GET /api/v1/workspaces/:id/metrics/timeseries?metric=&days=`. Exactly `days`
 * points, oldest-first; flow metrics are zero-filled, `nodes` is a level that
 * carries forward across gap days.
 */
export interface MetricsTimeseries {
  metric: TimeseriesMetric;
  days: number;
  points: TimeseriesPoint[];
}
