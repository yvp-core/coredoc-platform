export enum TokenPermission {
  ParserRead = 'parser:read',
  ParserWrite = 'parser:write',
  ResultRead = 'result:read',
  ResultWrite = 'result:write',
  RepoPush = 'repo:push',
  /**
   * Manage service tokens (create / list / reveal value / revoke).
   * High-privilege: deliberately NOT part of CI_TOKEN_PERMISSIONS, so a leaked
   * CI/CD token cannot mint or read other tokens.
   */
  TokenManage = 'token:manage',
  /**
   * Workspace control-plane administration: member invite/remove/role changes
   * and repo connect/update/disconnect. Distinct from the data-plane `repo:push`.
   * Deliberately NOT part of CI_TOKEN_PERMISSIONS, so a leaked CI/CD token cannot
   * perform workspace-management actions beyond its data-plane scope.
   */
  WorkspaceManage = 'workspace:manage',
  TelemetryWrite = 'telemetry:write',
  /**
   * Read the parsed code graph over REST (search/entrypoints/service-deps/
   * overview) — the parity layer the web UI consumes. Deliberately NOT part of
   * CI_TOKEN_PERMISSIONS: existing CI/CD tokens must not silently gain graph
   * read access when this permission is introduced. Service tokens opt in
   * explicitly at creation time; browser/JWT users reach it via the
   * `@WorkspaceRole('member')` role path instead (PermissionsGuard passes
   * through for non-service-token requests).
   */
  GraphRead = 'graph:read',
  /**
   * Read the workspace's cloud intent overlay (context, tree, items,
   * transitions) over REST and MCP. Opt-in only — see CI_TOKEN_PERMISSIONS and
   * WILDCARD_EXEMPT_PERMISSIONS below.
   */
  IntentRead = 'intent:read',
  /**
   * Create or update intent CANDIDATES. Proposing never accepts intent and
   * never touches accepted content (spec §5). Accept/reject/supersede, tree
   * CRUD and manual anchor writes have deliberately NO permission: they require a user
   * session and are refused for every service token by UserSessionGuard (REST)
   * and `authorizeHumanReviewer` (MCP), regardless of the token's permissions
   * or its creator's role.
   */
  IntentPropose = 'intent:propose',
  /** Record a deployment release from CI; review, rollback and plans still require a user session. */
  IntentRelease = 'intent:release',
  /** Apply a PR's CI anchor operations against the graph its CI run published. */
  IntentBindings = 'intent:bindings',
}

/** Explicit CI grants: graph publishing and automatic intent writes, never human authority or administration. */
export const CI_TOKEN_PERMISSIONS: TokenPermission[] = [
  TokenPermission.ParserRead,
  TokenPermission.ParserWrite,
  TokenPermission.ResultRead,
  TokenPermission.ResultWrite,
  TokenPermission.RepoPush,
  TokenPermission.IntentRelease,
  TokenPermission.IntentBindings,
];

/**
 * Least-privilege hosted MCP credential for intent reads and candidate
 * proposals. Read + propose is the entire machine-reachable intent surface:
 * everything that changes authority needs a user session (spec §5).
 */
export const INTENT_AGENT_TOKEN_PERMISSIONS: TokenPermission[] = [
  TokenPermission.IntentRead,
  TokenPermission.IntentPropose,
];

/**
 * Permissions granted to a telemetry ingest token.
 *
 * Narrow by design: only `telemetry:write`, so a leaked telemetry token can push
 * OpenTelemetry data for its workspace and nothing else. Its own curated list
 * (not folded into CI_TOKEN_PERMISSIONS) — telemetry ingest is a distinct scope
 * from the data-plane CI permissions, and CI tokens must not gain it implicitly.
 */
export const TELEMETRY_TOKEN_PERMISSIONS: TokenPermission[] = [TokenPermission.TelemetryWrite];

/**
 * Legacy grant-all marker some service tokens carry in their permissions array.
 * No code path mints it today; rows predating the curated permission lists can
 * still hold it, so PermissionsGuard must keep honouring it.
 */
export const PERMISSION_WILDCARD = '*';

/**
 * Intent permissions stay explicit. The CI-token migration updates the known
 * CI purpose only; legacy wildcards and unrelated tokens gain no intent grants.
 */
export const WILDCARD_EXEMPT_PERMISSIONS: TokenPermission[] = [
  TokenPermission.IntentRead,
  TokenPermission.IntentPropose,
  TokenPermission.IntentRelease,
  TokenPermission.IntentBindings,
];

/** True when `*` must not stand in for this permission — see WILDCARD_EXEMPT_PERMISSIONS. */
export function isWildcardExemptPermission(permission: string): boolean {
  return (WILDCARD_EXEMPT_PERMISSIONS as string[]).includes(permission);
}

/** Exact-purpose telemetry tokens are write-only even on auth paths outside Nest guards. */
export function isExactTelemetryPurpose(permissions: readonly string[] | null | undefined): boolean {
  return permissions?.length === 1 && permissions[0] === TokenPermission.TelemetryWrite;
}
