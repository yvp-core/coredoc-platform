/**
 * Durable repository identity for the connect / PATCH bodies the desktop sends
 * to a cloud workspace.
 *
 * THE DEFECT THIS CLOSES: the server accepts `intentRepoKey` on both the connect
 * (`POST repos`) and the update (`PATCH repos/:repoKey`) routes, and the desktop
 * never produced it. Binding therefore happened only through the server's
 * `hash(repoName) === repoKey` fallback, so any repo carrying an explicit
 * `repos[].key` different from its name stayed unbound forever — every intent
 * anchor, seed and import against it failing `unknown_repo_key` with no
 * client-side remedy. The CLI closed the same hole in
 * `packages/cli/src/sync/repo-sync.ts` (`buildRepoUpsertBodies`); this is the
 * desktop half of it, with the same rule.
 *
 * THE RULE: the durable key is sent only when it PROVES the graph key, using
 * core's own hashing rather than a copy of it. A stale parsed artifact — one
 * whose `id` was minted from a since-changed `repos[].key` — would otherwise
 * turn every push into a 400, and the identity it would register is wrong
 * anyway, so it is reported and omitted instead.
 *
 * MAIN PROCESS ONLY: `@coredoc/core` is a Node module and value-importing it
 * from the renderer breaks the browser bundle (docs/agents/design-system.md).
 */

import { StableIdGenerator } from '@coredoc/core';

export interface RepoIdentityInput {
  /** The graph key the workspace row is addressed by (`parsedRepo.id ?? name`). */
  repoKey: string;
  /** The durable local key: `repos[].key ?? repos[].name`. */
  durableKey: string;
}

/** The identity fragment spread into a connect or PATCH body — empty when unproven. */
export type RepoIntentIdentity = { intentRepoKey: string } | Record<string, never>;

/**
 * `{ intentRepoKey }` when the durable key reproduces the graph key, `{}`
 * otherwise. The mismatch is reported through `log` rather than swallowed: it
 * means the parsed artifact predates a `repos[].key` change and only a re-parse
 * can repair the binding.
 */
/** Default sink: callers that pass no logger silently accept the mismatch report. */
const discard = (_line: string): void => {
  // Intentionally does nothing — see `log`'s default above.
};

export function buildRepoIntentIdentity(
  { repoKey, durableKey }: RepoIdentityInput,
  log: (line: string) => void = discard,
): RepoIntentIdentity {
  if (durableKey === '') return {};
  if (new StableIdGenerator('', durableKey).getRepoHash() !== repoKey) {
    log(
      `[repo-identity] durable intent key "${durableKey}" does not reproduce the parsed repo id "${repoKey}" — ` +
        'sending no intent identity. Re-run parse after changing the repo key.',
    );
    return {};
  }
  return { intentRepoKey: durableKey };
}
