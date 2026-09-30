/**
 * Durable repo identity gate (spec §6.5).
 *
 * A seed or an anchor addresses a repository by its `intentRepoKey` — the
 * display-form durable key whose hash provably reproduces the graph `repoKey`
 * (enforced by `workspace_repos_intent_repo_key_graph_hash_check`). A request
 * naming a key this workspace does not carry is REFUSED with the registered
 * identities enumerated, so the caller can fix it without a second round trip.
 *
 * Lifted from the archive's `assertWorkspaceAnchorRepoKeys`, with its message
 * converted to the §12 structured shape: same batch resolution (one query for
 * the whole request), same enumeration in the refusal, same "unbound" marker
 * for a repository that is registered but has no intent identity yet.
 *
 * Two entry points, one query each:
 *
 * - {@link assertWorkspaceIntentRepoKeys} — the seed path's all-or-nothing gate,
 *   one error path for the whole request.
 * - {@link readWorkspaceIntentRepoIdentities} + {@link unknownRepoKeyError} —
 *   the anchor path, which resolves several anchors that each have their OWN
 *   error path (`items.2.anchorSuggestions.1.repoKey`), so the refusal has to
 *   name the field that actually carried the unknown key.
 */
import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { IntentErrorCode, type IntentPublicException } from './contract/index.js';
import { intentStateError } from './intent-state-errors.js';

/** The narrowest reader this gate needs — a transaction or the client both satisfy it. */
export interface WorkspaceRepoReader {
  workspaceRepo: Pick<Prisma.TransactionClient['workspaceRepo'], 'findMany'>;
}

/** The workspace's registered intent identities, read once per request. */
export interface WorkspaceIntentRepoIdentities {
  /** `intentRepoKey → graph repoKey`, for repos that carry a durable identity. */
  graphKeyByDurableKey: ReadonlyMap<string, string>;
  /**
   * The enumeration a refusal shows, one entry per registered repository — the
   * durable key when it has one, `unbound (name, graphKey)` when it does not.
   * Built here rather than at the throw site so every refusal about repo
   * identity reads the same, whichever path raised it.
   */
  enumeration: string[];
}

export async function readWorkspaceIntentRepoIdentities(
  reader: WorkspaceRepoReader,
  workspaceId: string,
): Promise<WorkspaceIntentRepoIdentities> {
  const registered = await reader.workspaceRepo.findMany({
    where: { workspaceId },
    select: { intentRepoKey: true, repoKey: true, repoName: true },
    orderBy: [{ repoName: 'asc' }, { repoKey: 'asc' }],
  });

  const graphKeyByDurableKey = new Map<string, string>();
  for (const repo of registered) {
    if (repo.intentRepoKey) graphKeyByDurableKey.set(repo.intentRepoKey, repo.repoKey);
  }

  const enumeration = registered.map((repo) =>
    repo.intentRepoKey ? `${repo.intentRepoKey} (${repo.repoName})` : `unbound (${repo.repoName}, ${repo.repoKey})`,
  );

  return { graphKeyByDurableKey, enumeration };
}

/**
 * The §12 refusal for one or more keys this workspace does not carry.
 *
 * The registered identities go in BOTH the message (readable at a glance, which
 * is what a two-repo workspace wants) and the `details` list. A public error
 * message is bounded to 200 characters, so on a workspace with many repos the
 * inline enumeration truncates and the per-identity details are what stay
 * complete — and the acceptance rule is that the caller can see what IS
 * registered, not that it fits on one line.
 */
export function unknownRepoKeyError(
  identities: WorkspaceIntentRepoIdentities,
  unknown: readonly string[],
  path: string[],
): IntentPublicException {
  const listed = identities.enumeration.length === 0 ? 'none' : identities.enumeration.join(', ');
  return intentStateError(
    IntentErrorCode.UnknownRepoKey,
    `Repo key(s) outside this workspace graph: ${[...unknown].join(', ')}. Registered identities: ${listed}.`,
    path,
    HttpStatus.BAD_REQUEST,
    identities.enumeration.map((identity) => ({
      code: IntentErrorCode.UnknownRepoKey,
      message: `Registered identity: ${identity}`,
      path,
    })),
  );
}

/**
 * Resolve every durable key in one query and refuse the whole request if any is
 * unknown.
 *
 * Returns `intentRepoKey → graph repoKey` for the keys asked about, which is
 * what a later graph read needs.
 */
export async function assertWorkspaceIntentRepoKeys(
  reader: WorkspaceRepoReader,
  workspaceId: string,
  durableKeys: readonly string[],
  path: string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(durableKeys)].sort();
  if (wanted.length === 0) return {};

  const identities = await readWorkspaceIntentRepoIdentities(reader, workspaceId);
  const unknown = wanted.filter((key) => !identities.graphKeyByDurableKey.has(key));
  if (unknown.length > 0) throw unknownRepoKeyError(identities, unknown, path);

  return Object.fromEntries(identities.graphKeyByDurableKey);
}
