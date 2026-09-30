/**
 * Workspace Scope Resolver
 *
 * Resolves ScopeContext for workspace-scoped MCP queries.
 * Instead of filesystem-based scope resolution (used by local MCP),
 * this resolves scope from the workspace's connected repos in the control plane.
 */

import type { ScopeContext } from '@coredoc/mcp';
import { type WorkspaceRepo } from '../database/control-plane.service.js';

// Note: this module needs no repo-hash helper — a workspace repo's `repoKey`
// IS the hash (see resolveWorkspaceScope). The canonical hash function lives in
// `@coredoc/core` (`generateRepoHash`) for callers that must derive one.

// =============================================================================
// Workspace Scope Resolution
// =============================================================================

export class UnknownWorkspaceScopeError extends Error {
  readonly code = 'UNKNOWN_WORKSPACE_SCOPE' as const;

  constructor(targetRepo: string, availableRepos: string[]) {
    super(`Unknown scope "${targetRepo}". Available repos (pass one of these as scope): ${availableRepos.join(', ')}`);
    this.name = 'UnknownWorkspaceScopeError';
  }
}

/**
 * Resolve scope context from a workspace's connected repos.
 *
 * Unlike the local scope resolver which matches filesystem paths,
 * this builds scope from the workspace_repos table. All connected repos
 * are included with cross-repo enabled by default.
 *
 * A `targetRepo` that names NO workspace repo is a hard error listing the
 * valid names (same contract as the local resolver's unknown-scope error) —
 * never a silent fall-back to all repos, which would answer a mistyped scope
 * with workspace-wide data the caller didn't ask for.
 *
 * @param workspaceRepos - Repos connected to the workspace
 * @param targetRepo - Optional repo name to narrow scope to
 * @returns ScopeContext for use with MCP tool handlers
 */
export function resolveWorkspaceScope(workspaceRepos: WorkspaceRepo[], targetRepo?: string): ScopeContext {
  let repos = workspaceRepos;

  // Narrow to specific repo if requested. Accept the qualified `project/repo`
  // form the tool schema advertises, not just a bare name: the cloud workspace
  // is flat (no projects), so match on the repo segment after the last slash.
  if (targetRepo) {
    const bareTarget = targetRepo.includes('/') ? targetRepo.split('/').pop()! : targetRepo;
    const matched = workspaceRepos.filter((r) => r.repoName === bareTarget || r.repoKey === bareTarget);
    if (matched.length === 0) {
      throw new UnknownWorkspaceScopeError(
        targetRepo,
        workspaceRepos.map((r) => r.repoName),
      );
    }
    repos = matched;
  }

  // repoKey IS the repo hash (from StableIdGenerator) that prefixes all node
  // IDs, so it is the join key to the graph nodes — that's `repoHashes`.
  // `resolvedRepos` is the human-readable names, index-aligned with repoHashes.
  // Every consumer treats resolvedRepos as NAMES (describe_repository keys its
  // parsedByName map by getRepoOverview's r.name; response-formatter and the
  // explain/cross-repo hints render them as names) — matching the local
  // scope-resolver. Using repoKey here makes the multi-repo describe merge miss
  // every row, so the whole workspace reports "0 of N parsed".
  const repoHashes = repos.map((r) => r.repoKey);
  const resolvedRepos = repos.map((r) => r.repoName);

  return {
    currentPath: `workspace://${repos[0]?.repoKey ?? 'unknown'}`,
    resolvedRepos,
    repoHashes,
    crossRepoEnabled: repos.length > 1,
    // Marks the scope as workspace-resolved: its repoHashes are a membership
    // boundary tools must not widen past (the topic tools' whole-graph `[]`
    // default keys off this — see resolveTopicQueryHashes).
    origin: 'workspace',
  };
}

/**
 * Resolve the "vantage" repo — the repo the remote MCP client is working from,
 * sent per-request via the `X-Coredoc-Current-Repo` header — to its
 * `{ currentRepo, currentRepoHash }` within the workspace.
 *
 * Cloud analogue of the local server's `COREDOC_CURRENT_REPO`. A HINT, not a
 * boundary: it only sharpens single-origin tools (`list_service_dependencies`)
 * and ranks the current repo first in `search_symbols` — it never narrows what
 * the workspace scope can see. The signal matches either the human-readable
 * `repoName` or the `repoKey`; `repoKey` IS the node-id hash (see
 * {@link resolveWorkspaceScope}), so `currentRepoHash = repoKey` directly.
 *
 * Fail-soft: an empty signal, or one naming a repo outside the workspace,
 * returns `undefined` and is ignored — a stale header never breaks a query.
 *
 * @param workspaceRepos - Repos connected to the workspace
 * @param signal - The vantage signal (repo name or key)
 */
export function resolveWorkspaceVantage(
  workspaceRepos: WorkspaceRepo[],
  signal: string,
): { currentRepo: string; currentRepoHash: string } | undefined {
  const trimmed = signal.trim();
  if (!trimmed) return undefined;

  // Accept bare `repo`, qualified `project/repo`, and `project:repo` forms —
  // match on the repo segment (parity with the local resolveVantageRepo).
  const bareName = trimmed.split(/[/:]/).pop() ?? trimmed;

  const match = workspaceRepos.find((r) => r.repoName === bareName || r.repoKey === bareName);
  if (!match) return undefined;

  return { currentRepo: match.repoName, currentRepoHash: match.repoKey };
}
