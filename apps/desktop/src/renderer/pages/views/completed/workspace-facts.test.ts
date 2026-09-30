import { describe, expect, it } from 'vitest';
import type { RepoDetailState } from '../../../../shared/ipc-types';
import type { RunningCommand, WorkflowAction } from '../../../stores/project-detail-store';
import type { Project } from '../../../types/project';
import { bannerVisibility, deriveWorkspaceFacts } from './workspace-facts.js';

/** A fully finished repo: parsed, approved, pushed, worktree unchanged. */
function repoState(name: string, over: Partial<RepoDetailState> = {}): RepoDetailState {
  return {
    name,
    parserExists: true,
    parserPath: `/repos/${name}/profile.ts`,
    parsed: { exists: true },
    summarized: { exists: true },
    neo4jSynced: { synced: true, timestamp: '2026-07-20T09:00:00Z' },
    operations: { lastPushed: '2026-07-20T09:00:00Z' },
    approval: { approved: true, isStale: false, outputMatchesParser: true },
    ...over,
  };
}

function project(...names: string[]): Project {
  return {
    id: 'p1',
    name: 'Workspace',
    createdAt: '2026-07-01T00:00:00Z',
    repositories: names.map((name, i) => ({ id: `r${i}`, name, path: `/repos/${name}`, status: 'ready' as never })),
  };
}

function states(...list: RepoDetailState[]): Map<string, RepoDetailState> {
  return new Map(list.map((s) => [s.name, s]));
}

function running(...list: Array<[string, WorkflowAction]>): Map<string, RunningCommand> {
  return new Map(
    list.map(([repoName, action], i) => [
      String(i),
      { id: String(i), repoName, action, startedAt: '2026-07-26T00:00:00Z', origin: 'single' as const },
    ]),
  );
}

describe('deriveWorkspaceFacts', () => {
  it('reports a fully synced workspace as complete and up to date', () => {
    const facts = deriveWorkspaceFacts(project('api', 'web'), states(repoState('api'), repoState('web')), new Map());

    expect(facts.incompleteRepos).toEqual([]);
    expect(facts.incompleteStep).toBeNull();
    expect(facts.allSynced).toBe(true);
    expect(facts.staleRepos).toEqual([]);
    expect(facts.isGraphUpdating).toBe(false);
  });

  it('treats an empty workspace as not synced', () => {
    // syncedCount === totalCount === 0 must not read as "everything is synced" —
    // it gates the Team MCP affordance.
    expect(deriveWorkspaceFacts(project(), new Map(), new Map()).allSynced).toBe(false);
  });

  it('takes the lowest outstanding step across incomplete repos only', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web', 'done'),
      states(
        repoState('api', { approval: { approved: false, isStale: false, outputMatchesParser: true } }), // step 1
        repoState('web', { parserExists: false, parsed: { exists: false } }), // step 0
        repoState('done'),
      ),
      new Map(),
    );

    expect(facts.incompleteRepos.map((r) => r.name)).toEqual(['api', 'web']);
    expect(facts.incompleteStep).toBe(0);
  });

  it('ignores project repos that have no loaded state yet', () => {
    const facts = deriveWorkspaceFacts(project('api', 'not-loaded'), states(repoState('api')), new Map());
    expect(facts.incompleteRepos).toEqual([]);
  });

  it('reports anySynced as soon as one repo is pushed, while allSynced stays strict', () => {
    const partial = deriveWorkspaceFacts(
      project('api', 'web'),
      states(repoState('api'), repoState('web', { neo4jSynced: { synced: false }, operations: {} })),
      new Map(),
    );
    expect(partial.anySynced).toBe(true);
    expect(partial.allSynced).toBe(false);

    expect(deriveWorkspaceFacts(project(), new Map(), new Map()).anySynced).toBe(false);
  });

  it('separates never-pushed repos from pushed-but-stale ones', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web'),
      states(
        repoState('api', { staleness: { isStale: true, reason: 'new_commits' } }),
        repoState('web', { neo4jSynced: { synced: false }, operations: {} }),
      ),
      new Map(),
    );

    expect(facts.staleRepos.map((s) => s.name)).toEqual(['api']);
    expect(facts.allSynced).toBe(false);
  });

  it('does not count an unpushed repo as stale even when its worktree moved', () => {
    const facts = deriveWorkspaceFacts(
      project('web'),
      states(repoState('web', { neo4jSynced: { synced: false }, staleness: { isStale: true, reason: 'new_commits' } })),
      new Map(),
    );
    expect(facts.staleRepos).toEqual([]);
  });

  it('flags graph updates only for summarize and push', () => {
    const base = project('api');
    const state = states(repoState('api'));

    expect(deriveWorkspaceFacts(base, state, running(['api', 'push'])).isGraphUpdating).toBe(true);
    expect(deriveWorkspaceFacts(base, state, running(['api', 'summarize'])).isGraphUpdating).toBe(true);
    expect(deriveWorkspaceFacts(base, state, running(['api', 'parse'])).isGraphUpdating).toBe(false);
    expect(deriveWorkspaceFacts(base, state, running(['api', 'docs'])).isGraphUpdating).toBe(false);
  });

  it('dedupes running repo names and keeps docs out of the mutating set', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web'),
      states(repoState('api'), repoState('web')),
      running(['api', 'parse'], ['api', 'summarize'], ['web', 'docs']),
    );

    expect(facts.runningRepoNames).toEqual(['api']);
  });

  it('reports each repo its own stage, not the workspace-wide first one', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web'),
      states(repoState('api'), repoState('web')),
      running(['api', 'parse'], ['web', 'push']),
    );

    expect(facts.runningStageByRepo.get('api')).toBe('parse');
    expect(facts.runningStageByRepo.get('web')).toBe('push');
  });

  it('keeps the first stage in flight for a repo whose chain overlaps', () => {
    const facts = deriveWorkspaceFacts(
      project('api'),
      states(repoState('api')),
      running(['api', 'summarize'], ['api', 'push']),
    );
    expect(facts.runningStageByRepo.get('api')).toBe('summarize');
  });

  it('leaves generate and docs out of the stage map, which drives the drawer chrome', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web'),
      states(repoState('api'), repoState('web')),
      running(['api', 'generate'], ['web', 'docs']),
    );

    expect(facts.runningStageByRepo.size).toBe(0);
    // generate still counts as running for the terminal's repo list.
    expect(facts.runningRepoNames).toEqual(['api']);
  });

  it('picks the most recent push across repos', () => {
    const facts = deriveWorkspaceFacts(
      project('api', 'web'),
      states(
        repoState('api', { operations: { lastPushed: '2026-07-20T09:00:00Z' } }),
        repoState('web', { operations: { lastPushed: '2026-07-24T18:30:00Z' } }),
      ),
      new Map(),
    );
    expect(facts.latestPush).toBe('2026-07-24T18:30:00Z');
  });

  it('leaves latestPush undefined when nothing was ever pushed', () => {
    const facts = deriveWorkspaceFacts(
      project('api'),
      states(repoState('api', { neo4jSynced: { synced: false }, operations: {} })),
      new Map(),
    );
    expect(facts.latestPush).toBeUndefined();
  });
});

describe('bannerVisibility', () => {
  const base = { staleRepoCount: 2, staleDismissed: false, cloudEnabled: true, cloudOutdated: true };

  it('suppresses both banners when ciCdEnabled is true', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: true })).toEqual({
      showStaleBanner: false,
      showCloudBanner: false,
    });
  });

  it('suppresses both banners when ciCdEnabled is unknown (workspaces not yet loaded)', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: undefined })).toEqual({
      showStaleBanner: false,
      showCloudBanner: false,
    });
  });

  it('shows the stale banner when ciCdEnabled is false and repos are stale', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: false, cloudEnabled: false })).toEqual({
      showStaleBanner: true,
      showCloudBanner: false,
    });
  });

  it('shows the cloud banner when ciCdEnabled is false and the cloud copy is outdated', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: false, staleRepoCount: 0 })).toEqual({
      showStaleBanner: false,
      showCloudBanner: true,
    });
  });

  it('shows both banners when ciCdEnabled is false and both conditions hold', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: false })).toEqual({
      showStaleBanner: true,
      showCloudBanner: true,
    });
  });

  it('hides the stale banner once dismissed even with ciCdEnabled false', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: false, staleDismissed: true, cloudEnabled: false })).toEqual({
      showStaleBanner: false,
      showCloudBanner: false,
    });
  });

  it('hides both banners when ciCdEnabled is false and neither condition holds', () => {
    expect(
      bannerVisibility({
        ciCdEnabled: false,
        staleRepoCount: 0,
        staleDismissed: false,
        cloudEnabled: false,
        cloudOutdated: false,
      }),
    ).toEqual({ showStaleBanner: false, showCloudBanner: false });
  });

  it('does not show the cloud banner when outdated but cloud is disabled', () => {
    expect(bannerVisibility({ ...base, ciCdEnabled: false, cloudEnabled: false })).toEqual({
      showStaleBanner: true,
      showCloudBanner: false,
    });
  });
});
