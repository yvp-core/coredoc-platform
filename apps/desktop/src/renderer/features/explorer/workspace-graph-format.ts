/**
 * Copy for the stale-graph banner and the Workspace Graph panel's status badge.
 *
 * Kept as a pure module because the degrade rules are the interesting part and
 * they need tests: per ADR-20260724-explicit-degrade-no-silent-zeros an
 * unmeasurable commit count must read as "new commits", never as "0 commits".
 */
import type { RepoDetailState } from '../../../shared/ipc-types';

export enum GraphStatus {
  UpToDate = 'up-to-date',
  ReparseRequired = 'reparse-required',
  NotPushed = 'not-pushed',
}

export interface GraphStatusInfo {
  status: GraphStatus;
  label: string;
}

/**
 * Status shown at the top of the Workspace Graph panel.
 *
 * Never-pushed repos outrank stale ones: a repo missing from the graph is a
 * bigger gap than one that is merely behind.
 */
export function graphStatus(repoStates: RepoDetailState[]): GraphStatusInfo {
  if (repoStates.some((s) => !s.neo4jSynced.synced)) {
    return { status: GraphStatus.NotPushed, label: 'Not in graph' };
  }
  if (repoStates.some((s) => s.staleness?.isStale)) {
    return { status: GraphStatus.ReparseRequired, label: 'Re-parse required' };
  }
  return { status: GraphStatus.UpToDate, label: 'Graph up to date' };
}

/**
 * The banner's second line.
 *
 * The banner itself is triggered by `staleness.isStale` — a commit-hash
 * comparison that stands on its own — so a missing count degrades the sentence,
 * never the warning. A measured `0` while stale is real (a branch switch or
 * rebase moves HEAD without moving forward) but reads as a bug, so it is folded
 * into the same "count unavailable" wording at the render boundary rather than
 * being faked upstream.
 */
export function staleBannerMessage(staleRepos: RepoDetailState[]): string {
  if (staleRepos.length === 0) return '';

  if (staleRepos.length === 1) {
    return `${staleRepos[0].name} has ${commitPhrase(staleRepos[0])} since the last sync.`;
  }

  if (staleRepos.length === 2) {
    return `${staleRepos[0].name} and ${staleRepos[1].name} have new commits since the last sync.`;
  }

  return `${staleRepos.length} repositories have new commits since the last sync.`;
}

function commitPhrase(state: RepoDetailState): string {
  const count = state.staleness?.commitsBehind;
  if (typeof count !== 'number' || count <= 0) return 'new commits (count unavailable)';
  return count === 1 ? '1 new commit' : `${count} new commits`;
}
