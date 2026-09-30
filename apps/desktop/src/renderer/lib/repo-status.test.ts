import { describe, expect, it } from 'vitest';
import type { RepoDetailState } from '../../shared/ipc-types';
import { deriveRepoStatus } from './repo-status.js';

/** A fully finished repo: profile authored, parsed, approved, summarized, pushed. */
function repoState(over: Partial<RepoDetailState> = {}): RepoDetailState {
  return {
    name: 'api',
    parserExists: true,
    parserPath: '/repos/api/profile.ts',
    parsed: { exists: true },
    summarized: { exists: true },
    neo4jSynced: { synced: true, timestamp: '2026-07-20T09:00:00Z' },
    operations: { lastPushed: '2026-07-20T09:00:00Z' },
    approval: { approved: true, isStale: false, outputMatchesParser: true },
    ...over,
  };
}

describe('deriveRepoStatus', () => {
  it('reports a running action over the static state', () => {
    expect(deriveRepoStatus(repoState(), 'generate')).toBe('parser_creation');
    expect(deriveRepoStatus(repoState(), 'parse')).toBe('parsing');
    expect(deriveRepoStatus(repoState(), 'summarize')).toBe('summarising');
    expect(deriveRepoStatus(repoState(), 'push')).toBe('updating_graph');
    expect(deriveRepoStatus(repoState({ neo4jSynced: { synced: false } }), 'push')).toBe('creating_graph');
  });

  it('walks the wizard sequence from the static state', () => {
    expect(deriveRepoStatus(undefined)).toBe('not_started');
    expect(deriveRepoStatus(repoState({ parserExists: false, parsed: { exists: false } }))).toBe('not_started');
    expect(
      deriveRepoStatus(
        repoState({
          parsed: { exists: true },
          summarized: { exists: false },
          neo4jSynced: { synced: false },
          approval: undefined,
        }),
      ),
    ).toBe('parsed_pending_review');
    expect(
      deriveRepoStatus(
        repoState({
          summarized: { exists: false },
          neo4jSynced: { synced: false },
          approval: { approved: true, isStale: true, outputMatchesParser: true },
        }),
      ),
    ).toBe('approval_stale');
    expect(deriveRepoStatus(repoState({ summarized: { exists: false }, neo4jSynced: { synced: false } }))).toBe(
      'approved',
    );
    expect(deriveRepoStatus(repoState({ neo4jSynced: { synced: false } }))).toBe('summarised');
    expect(deriveRepoStatus(repoState())).toBe('graph_up_to_date');
    expect(deriveRepoStatus(repoState({ staleness: { isStale: true, reason: 'new_commits' } }))).toBe(
      'graph_needs_update',
    );
  });

  // A push row in the operations DB outlives the artifacts it described (workspace
  // cleaned, output dir pruned, profile re-authored elsewhere). Claiming a graph then
  // contradicts getRepoStep(), which sends the repo back to step 0 — and made the
  // wizard's right panel open chat instead of the terminal for an unparsed repo.
  it('claims no graph when the artifacts behind the push are gone', () => {
    expect(deriveRepoStatus(repoState({ parsed: { exists: false } }))).toBe('not_started');
    expect(deriveRepoStatus(repoState({ parserExists: false }))).toBe('not_started');
    expect(
      deriveRepoStatus(repoState({ parsed: { exists: false }, staleness: { isStale: true, reason: 'new_commits' } })),
    ).toBe('not_started');
  });

  it('claims no summary or approval when the parsed artifact is gone', () => {
    expect(deriveRepoStatus(repoState({ parsed: { exists: false }, neo4jSynced: { synced: false } }))).toBe(
      'not_started',
    );
  });
});
