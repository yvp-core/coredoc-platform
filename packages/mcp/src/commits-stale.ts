/**
 * commits-stale — how far the working tree has moved since the graph was parsed.
 *
 * `git rev-list --count <parsedCommit>..HEAD` in the repo working dir counts the
 * commits on HEAD that the parsed snapshot doesn't have — an upsell/staleness
 * signal attached to the MCP session summary (P3). Everything here is
 * best-effort: a missing input, a non-git dir, an unknown parsed commit, or git
 * being unavailable all resolve to `null` (unknown). Staleness telemetry must
 * never break or block a tool call.
 *
 * The parsed commit is recorded by `coredoc parse` in the parse operation's
 * metadata (`gitCommitHash`) and surfaced via `getOperationSummary().lastParsed`
 * — {@link commitHashFromSummary} extracts it. The repo working dir comes from
 * `ScopeContext.currentPath` / `resolvedRepoPaths`. The actual attach to the
 * session-summary props lands in T3; this module just exposes the pieces.
 */

import { countCommitsAhead, type GitRunner } from '@coredoc/core/utils';
import type { OperationSummary } from '@coredoc/db';

/** Re-exported so MCP-side callers and tests keep a single import site. */
export type { GitRunner };

/**
 * The git commit the graph was parsed at, if recorded. Returns undefined when
 * the repo was never parsed or the hash wasn't captured (e.g. a non-git repo at
 * parse time).
 */
export function commitHashFromSummary(summary: OperationSummary | undefined): string | undefined {
  const hash = summary?.lastParsed?.metadata?.gitCommitHash;
  return typeof hash === 'string' && hash.length > 0 ? hash : undefined;
}

/**
 * Number of commits HEAD is ahead of the parsed snapshot (0 when identical), or
 * `null` when it can't be determined. Non-fatal by construction: missing inputs,
 * a non-git dir, an unknown parsed commit, or git being unavailable all yield
 * `null`.
 */
export async function computeCommitsStale(
  repoDir: string | undefined,
  parsedCommit: string | undefined,
  runner?: GitRunner,
): Promise<number | null> {
  // The counting itself — and the default git runner — lives in @coredoc/core/utils
  // so the desktop main process can reach it without depending on the MCP server
  // package. This wrapper keeps the MCP-facing signature and its injectable runner.
  return countCommitsAhead(repoDir, parsedCommit, runner);
}
