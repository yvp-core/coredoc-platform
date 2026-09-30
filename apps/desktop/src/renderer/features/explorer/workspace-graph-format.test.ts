import { describe, expect, it } from 'vitest';
import type { RepoDetailState, RepoStalenessInfo } from '../../../shared/ipc-types';
import { GraphStatus, graphStatus, staleBannerMessage } from './workspace-graph-format.js';

function repo(name: string, staleness?: RepoStalenessInfo, synced = true): RepoDetailState {
  return {
    name,
    parserExists: true,
    parserPath: `/repos/${name}/profile.ts`,
    parsed: { exists: true },
    summarized: { exists: true },
    neo4jSynced: { synced },
    staleness,
  };
}

const stale = (commitsBehind?: number | null): RepoStalenessInfo => ({
  isStale: true,
  reason: 'new_commits',
  ...(commitsBehind === undefined ? {} : { commitsBehind }),
});

describe('staleBannerMessage', () => {
  it('names the repo and the measured count', () => {
    expect(staleBannerMessage([repo('frontend-api', stale(12))])).toBe(
      'frontend-api has 12 new commits since the last sync.',
    );
  });

  it('uses the singular for exactly one commit', () => {
    expect(staleBannerMessage([repo('api', stale(1))])).toBe('api has 1 new commit since the last sync.');
  });

  it('says the count is unavailable rather than inventing a number', () => {
    expect(staleBannerMessage([repo('api', stale(null))])).toBe(
      'api has new commits (count unavailable) since the last sync.',
    );
  });

  it('degrades the same way when the count was never populated', () => {
    // This is the state before the main-process slice lands: stale is known,
    // the count is not.
    expect(staleBannerMessage([repo('api', stale())])).toContain('count unavailable');
  });

  it('never renders a zero count, which reads as a bug even though it is a real state', () => {
    // A branch switch or rebase moves HEAD without moving forward: the hashes
    // differ, so the repo is stale, but `parsed..HEAD` is empty.
    const msg = staleBannerMessage([repo('api', stale(0))]);
    expect(msg).not.toContain('0 new commits');
    expect(msg).toContain('count unavailable');
  });

  it('conjoins exactly two repos', () => {
    expect(staleBannerMessage([repo('api', stale(3)), repo('web', stale(1))])).toBe(
      'api and web have new commits since the last sync.',
    );
  });

  it('counts repos once there are three or more', () => {
    expect(staleBannerMessage([repo('a', stale(1)), repo('b', stale(2)), repo('c', stale(3))])).toBe(
      '3 repositories have new commits since the last sync.',
    );
  });

  it('is empty when nothing is stale — the banner does not render', () => {
    expect(staleBannerMessage([])).toBe('');
  });
});

describe('graphStatus', () => {
  it('is up to date when every repo is pushed and current', () => {
    expect(graphStatus([repo('api'), repo('web')]).status).toBe(GraphStatus.UpToDate);
  });

  it('reports re-parse required when a pushed repo has moved on', () => {
    const info = graphStatus([repo('api'), repo('web', stale(4))]);
    expect(info.status).toBe(GraphStatus.ReparseRequired);
    expect(info.label).toBe('Re-parse required');
  });

  it('ranks a never-pushed repo above a stale one', () => {
    // Missing from the graph entirely is a bigger gap than merely behind.
    expect(graphStatus([repo('api', stale(4)), repo('web', undefined, false)]).status).toBe(GraphStatus.NotPushed);
  });

  it('treats an empty workspace as up to date', () => {
    expect(graphStatus([]).status).toBe(GraphStatus.UpToDate);
  });
});
