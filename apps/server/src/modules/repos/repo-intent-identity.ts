/**
 * Durable intent identity on the workspace repo registry (spec §6.5).
 *
 * `workspace_repos.repo_key` is the GRAPH identity — `sha256(durableKey)[0..12]`,
 * minted by `StableIdGenerator` and baked into every node id. It is a hash, so
 * it cannot be reversed: the display-form key an anchor or a feature seed
 * addresses a repository by has to be REGISTERED, not derived. This module is
 * where a connect or an update registers it.
 *
 * THE PROOF. A durable key is only accepted when the unchanged graph-id
 * algorithm reproduces the row's stored `repo_key` from it. That is the same
 * predicate `workspace_repos_intent_repo_key_graph_hash_check` enforces in SQL,
 * asserted here first so the caller gets a `400` naming the mismatch instead of
 * a constraint violation.
 *
 * TRUST ON FIRST USE, exactly like `capture.service.ts`'s `captureRepositoryKey`
 * binding: the first write wins, a repeat of the same key is a no-op, and a
 * write that would REBIND the row to a different identity is refused. An anchor
 * captured under one identity would otherwise silently start addressing another
 * repository's graph.
 */
import { ConflictException, BadRequestException } from '@nestjs/common';
import { StableIdGenerator } from '@coredoc/core';
import { normalizeGitRemote } from '../../libs/git-remote.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * The narrowest client this module needs (ISP): the repo delegate, and nothing
 * else. Both `PrismaService` and a `Prisma.TransactionClient` satisfy it, which
 * is what lets the caller run the identity write INSIDE the same locked
 * transaction as the connect/update row write — see `repos.service.ts`.
 */
export type RepoIdentityClient = Pick<Prisma.TransactionClient, 'workspaceRepo'>;

/** The graph repo hash a durable key must reproduce. Core's algorithm, not a copy of it. */
export function graphRepoHashOf(durableKey: string): string {
  // `repoRoot` is only used by StableIdGenerator's file-resolution helpers; the
  // hash is a pure function of the key, so an empty root is correct here.
  return new StableIdGenerator('', durableKey).getRepoHash();
}

export interface RepoIntentIdentityInput {
  /** Explicit durable key from the client (the CLI's `repos[].key`), when it has one. */
  intentRepoKey?: string | null;
  /** Tri-state like the repo DTOs: `undefined` leaves the stored remote alone, `null` clears it. */
  gitUrl?: string | null;
}

/**
 * The durable key to bind, or `null` when this repo has none to bind yet.
 *
 * An explicit key that does not reproduce the graph hash is REFUSED — it is a
 * caller bug, and accepting it would bind anchors to the wrong graph. An absent
 * explicit key falls back to `repoName`, which is the durable key for every repo
 * connected without a `key` override; when the name does not reproduce the hash
 * either, the row simply stays unbound (the same rule the migration's backfill
 * used) until a client sends the explicit key.
 */
export function resolveIntentRepoKey(repo: { repoKey: string; repoName: string }, input: RepoIntentIdentityInput) {
  const explicit = input.intentRepoKey ?? undefined;
  if (explicit !== undefined) {
    if (graphRepoHashOf(explicit) !== repo.repoKey) {
      throw new BadRequestException(
        `intentRepoKey "${explicit}" does not reproduce this repo's graph key "${repo.repoKey}". ` +
          'The durable key must be the exact string the graph ids were minted from.',
      );
    }
    return explicit;
  }
  return graphRepoHashOf(repo.repoName) === repo.repoKey ? repo.repoName : null;
}

/** The `normalized_git_remote` write this input implies, if any. */
function normalizedRemoteUpdate(input: RepoIntentIdentityInput): { normalizedGitRemote: string | null } | undefined {
  if (input.gitUrl === undefined) return undefined;
  if (input.gitUrl === null) return { normalizedGitRemote: null };
  const normalized = normalizeGitRemote(input.gitUrl);
  // Intentional fallback: an origin this function cannot canonicalize (a
  // self-hosted spelling, a scheme outside the four Git protocols) is stored as
  // "no durable remote" rather than refusing the connect. `git_url` itself is
  // still recorded; only the identity-matching projection is absent, which is
  // the honest state — and refusing would break repo connects that work today.
  return { normalizedGitRemote: normalized.status === 'normalized' ? normalized.normalizedRemote : null };
}

/**
 * A storage-constraint violation, rendered as the 4xx the caller can act on.
 *
 * The two CHECKs and the identity unique index are BACKSTOPS — every sanctioned
 * write is proved before it reaches them (`resolveIntentRepoKey`, and
 * `normalizeGitRemote`'s totality against the remote CHECK) — but a backstop
 * that fires must still name the offending value rather than surfacing as a 500
 * from inside a repo connect. Rethrows anything else untouched: an unrecognized
 * failure is not something to dress up as a client error.
 */
export function repoIdentityConstraintError(
  error: unknown,
  offending: { intentRepoKey: string | null; remote?: string | null },
): unknown {
  // Prisma reports a CHECK violation as raw database text and a unique
  // violation as `P2002` with the constraint in `meta.target`, so both are
  // searched: the constraint NAME is the only reliable discriminator.
  const detail = error as { code?: unknown; meta?: { target?: unknown } };
  const message = `${error instanceof Error ? error.message : ''} ${
    detail?.code === 'P2002' ? JSON.stringify(detail.meta?.target ?? '') : ''
  }`;
  if (message.includes('workspace_repos_normalized_git_remote_check')) {
    return new BadRequestException(
      `The normalized Git remote "${offending.remote ?? ''}" is not a storable canonical remote. ` +
        'Connect the repo with a plain clone URL (https, ssh, git or scp form) or omit gitUrl.',
    );
  }
  if (message.includes('workspace_repos_intent_repo_key_graph_hash_check')) {
    return new BadRequestException(
      `intentRepoKey "${offending.intentRepoKey ?? ''}" does not reproduce this repo's graph key. ` +
        'The durable key must be the exact string the graph ids were minted from.',
    );
  }
  if (message.includes('workspace_repos_workspace_id_intent_repo_key_key') || message.includes('intent_repo_key')) {
    return new ConflictException(
      `Another repo in this workspace is already registered under the durable intent key ` +
        `"${offending.intentRepoKey ?? ''}". Disconnect that repo before reconnecting this one.`,
    );
  }
  return error;
}

/**
 * Register the durable identity for one connected repo. Additive: it never
 * touches a field outside the two identity columns.
 *
 * `client` is the SAME transaction client the caller's connect/update row write
 * runs on (spec §6.5 review): a bind committed separately could leave a repo
 * connected-but-unbound whose retry answers "already connected", with no client
 * remedy. Passing a plain `PrismaService` is still valid for callers that own no
 * surrounding write.
 */
export async function bindRepoIntentIdentity(
  client: RepoIdentityClient,
  workspaceId: string,
  repo: { repoKey: string; repoName: string },
  input: RepoIntentIdentityInput,
): Promise<void> {
  const durableKey = resolveIntentRepoKey(repo, input);
  const remote = normalizedRemoteUpdate(input);
  if (durableKey === null && remote === undefined) return;

  let bound: { count: number };
  try {
    bound = await client.workspaceRepo.updateMany({
      where: {
        workspaceId,
        repoKey: repo.repoKey,
        // TOFU: unbound, or already bound to this exact identity.
        ...(durableKey === null ? {} : { OR: [{ intentRepoKey: null }, { intentRepoKey: durableKey }] }),
      },
      data: { ...(durableKey === null ? {} : { intentRepoKey: durableKey }), ...(remote ?? {}) },
    });
  } catch (error) {
    throw repoIdentityConstraintError(error, { intentRepoKey: durableKey, remote: remote?.normalizedGitRemote });
  }
  if (bound.count > 0 || durableKey === null) return;

  // Nothing matched with a durable key in hand: either the row is gone (the
  // caller's own operation reports that) or it is already bound to a different
  // identity. The proof above already makes the second case unreachable through
  // any sanctioned write — only one key can reproduce a given graph hash — so
  // this branch is the BACKSTOP for a row bound by something that bypassed it
  // (a migration, a console). It must still refuse rather than overwrite.
  const current = await client.workspaceRepo.findUnique({
    where: { workspaceId_repoKey: { workspaceId, repoKey: repo.repoKey } },
    select: { intentRepoKey: true },
  });
  if (current && current.intentRepoKey !== durableKey) {
    throw new ConflictException(
      `Repo "${repo.repoKey}" is already registered under the durable intent key "${current.intentRepoKey}". ` +
        'Rebinding would silently re-point existing intent anchors and seeds; disconnect and reconnect the repo instead.',
    );
  }
}
