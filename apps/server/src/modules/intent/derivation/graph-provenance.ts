/**
 * Per-repo graph provenance (spec §6.3).
 *
 * "A readable snapshot is USED regardless of age" only holds up if the response
 * says WHICH snapshot: the immutable `graphVersionId` the read was served from
 * and when each repository last pushed into it. Neither is a projection that
 * exists today — the version id comes from the leased graph context
 * (`WorkspaceGraphVersion`) and `pushedAt` from `workspace_repos.last_pushed_at`,
 * assembled here, once, so no caller re-derives it differently.
 *
 * Provenance is reported INDEPENDENTLY of anchor status (§6.4): a matched
 * anchor on a months-old snapshot is a representable, honest result, and this
 * module never lets a caller render one without the other.
 */

import { SnapshotFreshness, type RepoSnapshotEvidence } from '@coredoc/db';
import type { WorkspaceRepo } from '../../../database/control-plane.service.js';
import type { RepoGraphProvenance } from './derivation-contract.js';

/** Durable intent repo key → graph repo hash, for the repos this workspace registered. */
export function graphRepoHashByIntentKey(repos: readonly WorkspaceRepo[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const repo of repos) {
    // A repo without a durable intent key is not addressable by an anchor or a
    // seed at all (§6.5) — it is simply absent from the map, so a reference to
    // it resolves to "unregistered" rather than to some other repo's graph.
    if (repo.intentRepoKey) byKey.set(repo.intentRepoKey, repo.repoKey);
  }
  return byKey;
}

export interface AssembleProvenanceInput {
  repos: readonly WorkspaceRepo[];
  /** The immutable version the read was served from; null on the legacy plane. */
  graphVersionId: string | null;
  /** Freshness per DURABLE repo key, from evidence resolution; absent = unverified. */
  evidenceByRepoKey?: ReadonlyMap<string, RepoSnapshotEvidence>;
  /** Restrict the output to these durable keys; omit for every registered repo. */
  repoKeys?: readonly string[];
}

export function assembleRepoProvenance(input: AssembleProvenanceInput): RepoGraphProvenance[] {
  const wanted = input.repoKeys ? new Set(input.repoKeys) : undefined;
  const provenance: RepoGraphProvenance[] = [];
  for (const repo of input.repos) {
    if (wanted && (!repo.intentRepoKey || !wanted.has(repo.intentRepoKey))) continue;
    const evidence = repo.intentRepoKey ? input.evidenceByRepoKey?.get(repo.intentRepoKey) : undefined;
    provenance.push({
      repoKey: repo.intentRepoKey ?? null,
      repoName: repo.repoName,
      graphRepoHash: repo.repoKey,
      graphVersionId: input.graphVersionId,
      pushedAt: repo.lastPushedAt ? repo.lastPushedAt.toISOString() : null,
      // No evidence row means nothing was compared for this repo — `unverified`,
      // which is exactly the state the caller-supplied-nothing case must report
      // instead of a fabricated `current`.
      snapshotFreshness: evidence?.snapshotFreshness ?? SnapshotFreshness.Unverified,
      ...(evidence?.graphCommit ? { graphCommit: evidence.graphCommit } : {}),
      ...(evidence?.observedCommit ? { observedCommit: evidence.observedCommit } : {}),
    });
  }
  return provenance.sort((left, right) => left.repoName.localeCompare(right.repoName));
}
