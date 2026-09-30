/**
 * How an external call is NAMED, in one place.
 *
 * Three tools answer "what does this call reach" (`list_service_dependencies` keys its rows on
 * it, `trace_cross_repo_call` reports it, `explain` lists it) and each had its own copy of the
 * precedence. The rule: the parser-emitted canonical `targetService`, else the repo the call
 * RESOLVES_TO (the only name a Swift/Kotlin client has, since its profile cannot fill
 * `serviceName`), else the `serviceName` label — the same precedence `getExternalCalls` filters
 * on, so the filter and the row can never disagree.
 */

import type { ExternalCallInfo } from '@coredoc/db';
import type { ScopeContext } from '../../types.js';

/** A blank string is a missing value, not a service named "". */
function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The call's effective target name, or undefined when it names no target this scope can report.
 *
 * `callerRepoName` closes the self-dependency hole: an intra-repo RESOLVES_TO link (a multi-target
 * monorepo whose UI target calls its own backend target, or the intra-repo linker extension) makes
 * a call resolve back into the repo it was made from. That is an in-repo edge, never a service
 * dependency, so the resolved-repo level is dropped when it names the caller's own repository, and
 * a target that still is the caller's own repository is no target at all.
 */
export function effectiveTarget(call: ExternalCallInfo, callerRepoName?: string): string | undefined {
  const resolved = named(call.resolvedTargetRepoName);
  const target =
    named(call.targetService) ?? (resolved === callerRepoName ? undefined : resolved) ?? named(call.serviceName);
  return target === callerRepoName ? undefined : target;
}

/**
 * The repository a node belongs to, for the self-check above. Unlike the display-side repo tag
 * this answers in SINGLE-repo scope too: a monorepo resolving into itself is exactly the one-repo
 * case, and a guard that goes quiet there would never fire where the hole is.
 */
export function ownerRepoName(
  scope: Pick<ScopeContext, 'repoHashes' | 'resolvedRepos' | 'currentRepo'>,
  nodeId?: string,
): string | undefined {
  const hash = nodeId?.split(':')[0];
  if (hash) {
    const index = scope.repoHashes.indexOf(hash);
    const name = index >= 0 ? scope.resolvedRepos[index] : undefined;
    if (name) return name;
  }
  return scope.currentRepo ?? (scope.resolvedRepos.length === 1 ? scope.resolvedRepos[0] : undefined);
}
