/**
 * Observed-checkout resolution (issue v1.1-04).
 *
 * NO REAL GIT: every case drives the injected {@link ObservedGitRunner}, so the
 * suite pins the grammar and the omission rules rather than this machine's
 * worktrees. `config-manager.js` is mocked whole because it reaches Electron's
 * paths at import time.
 *
 * The rule under test is that OMISSION is the only failure mode. Freshness is
 * never asserted by omission (spec §6.3), so a repo this module says nothing
 * about stays `unverified` server-side — which is honest — while a thrown read
 * would take the whole intent context down with it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  getCurrentConfig: vi.fn(),
  getConfigDir: vi.fn(),
}));

vi.mock('./config-manager.js', () => config);

const { invalidateObservedCheckouts, observedReposForWorkspace, resolveObservedCheckouts } = await import(
  './intent-observed-checkout.js'
);

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/** A runner over a `path → { head, status }` table; anything else rejects like git would. */
function fakeGit(worktrees: Record<string, { head: string; status: string }>) {
  return vi.fn(async (_exe: string, args: string[], options: { cwd: string }) => {
    const tree = worktrees[options.cwd];
    if (!tree) throw new Error(`not a git repository: ${options.cwd}`);
    if (args[0] === 'rev-parse') return { stdout: `${tree.head}\n` };
    return { stdout: tree.status };
  });
}

function withProject(repos: { name: string; path: string; key?: string }[], workspaceId = 'ws-1') {
  config.getCurrentConfig.mockReturnValue({
    projects: [{ id: 'p1', name: 'Acme', repos, cloud: { enabled: true, workspaceId } }],
  });
  config.getConfigDir.mockReturnValue('/home/dev');
}

beforeEach(() => {
  config.getCurrentConfig.mockReset();
  config.getConfigDir.mockReset();
  invalidateObservedCheckouts();
});

describe('repo mapping', () => {
  it('maps the workspace to its local project and uses the DURABLE key, not the name', () => {
    // The durable key is what anchors and seeds address (`repos[].key ?? name`);
    // reporting the name for a keyed repo would observe a repo nobody asked about.
    withProject([
      { name: 'api', path: 'repos/api', key: 'acme/api' },
      { name: 'web', path: 'repos/web' },
    ]);

    expect(observedReposForWorkspace('ws-1')).toEqual([
      { repoKey: 'acme/api', repoPath: '/home/dev/repos/api' },
      { repoKey: 'web', repoPath: '/home/dev/repos/web' },
    ]);
  });

  it('maps a workspace with no local project to nothing', () => {
    withProject([{ name: 'api', path: 'repos/api' }], 'ws-other');

    expect(observedReposForWorkspace('ws-1')).toEqual([]);
  });

  it('maps nothing when no config is loaded', () => {
    config.getCurrentConfig.mockReturnValue(null);
    config.getConfigDir.mockReturnValue(null);

    expect(observedReposForWorkspace('ws-1')).toEqual([]);
  });
});

describe('resolution', () => {
  it('reports a clean checkout as "<repoKey>@<commit>"', async () => {
    withProject([{ name: 'api', path: 'repos/api', key: 'acme/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });

    await expect(resolveObservedCheckouts('ws-1', git)).resolves.toEqual([`acme/api@${SHA}`]);
  });

  it('appends ":dirty" for any porcelain output at all, tracked or not', async () => {
    withProject([{ name: 'api', path: 'repos/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '?? notes.md\n' } });

    await expect(resolveObservedCheckouts('ws-1', git)).resolves.toEqual([`api@${SHA}:dirty`]);
  });

  it('lower-cases the commit, because the ":dirty" suffix is only unambiguous against hex', async () => {
    withProject([{ name: 'api', path: 'repos/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: 'ABCDEF1234567', status: '' } });

    await expect(resolveObservedCheckouts('ws-1', git)).resolves.toEqual(['api@abcdef1234567']);
  });

  it('omits a repo git could not read, and keeps the ones it could', async () => {
    withProject([
      { name: 'api', path: 'repos/api' },
      { name: 'gone', path: 'repos/gone' },
    ]);
    const git = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });
    const log = vi.fn();

    await expect(resolveObservedCheckouts('ws-1', git, log)).resolves.toEqual([`api@${SHA}`]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('repos/gone');
  });

  it('omits a checkout whose HEAD is not a commit rather than sending an unparseable value', async () => {
    // A value the server cannot parse is REFUSED — it fails the whole read —
    // so this module never emits one.
    withProject([{ name: 'api', path: 'repos/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: 'ref: refs/heads/main', status: '' } });

    await expect(resolveObservedCheckouts('ws-1', git)).resolves.toEqual([]);
  });

  it('resolves to nothing, never a throw, when the workspace has no local repos', async () => {
    withProject([], 'ws-1');

    await expect(resolveObservedCheckouts('ws-1', fakeGit({}))).resolves.toEqual([]);
  });
});

describe('session cache', () => {
  it('reads git once per checkout and answers the rest from the cache', async () => {
    withProject([{ name: 'api', path: 'repos/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });

    await resolveObservedCheckouts('ws-1', git);
    await resolveObservedCheckouts('ws-1', git);

    // rev-parse + status, once — not twice.
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('re-reads git after invalidate, so a manual refresh sees the new HEAD', async () => {
    withProject([{ name: 'api', path: 'repos/api' }]);
    const first = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });
    await resolveObservedCheckouts('ws-1', first);

    invalidateObservedCheckouts();
    const second = fakeGit({ '/home/dev/repos/api': { head: OTHER_SHA, status: 'M src/a.ts\n' } });

    await expect(resolveObservedCheckouts('ws-1', second)).resolves.toEqual([`api@${OTHER_SHA}:dirty`]);
  });
});

describe('concurrent resolution', () => {
  it('spawns git ONCE per checkout when two reads race for it', async () => {
    // Two context reads in flight at once both miss the cache — it is only
    // written after git answers — so before coalescing each spawned its own
    // `rev-parse` + `status` pair for the same worktree.
    withProject([{ name: 'api', path: 'repos/api' }]);
    const git = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });

    const [first, second] = await Promise.all([
      resolveObservedCheckouts('ws-1', git),
      resolveObservedCheckouts('ws-1', git),
    ]);

    expect(first).toEqual([`api@${SHA}`]);
    expect(second).toEqual([`api@${SHA}`]);
    // rev-parse + status, once between them.
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('coalesces per checkout, not across them', async () => {
    withProject([
      { name: 'api', path: 'repos/api' },
      { name: 'web', path: 'repos/web' },
    ]);
    const git = fakeGit({
      '/home/dev/repos/api': { head: SHA, status: '' },
      '/home/dev/repos/web': { head: OTHER_SHA, status: '' },
    });

    await Promise.all([resolveObservedCheckouts('ws-1', git), resolveObservedCheckouts('ws-1', git)]);

    // Two worktrees, one pair of spawns each.
    expect(git).toHaveBeenCalledTimes(4);
  });

  it('does not let a resolution started before an invalidate write the cache after it', async () => {
    withProject([{ name: 'api', path: 'repos/api' }]);
    const stale = fakeGit({ '/home/dev/repos/api': { head: SHA, status: '' } });

    const inFlight = resolveObservedCheckouts('ws-1', stale);
    invalidateObservedCheckouts();
    await inFlight;

    const fresh = fakeGit({ '/home/dev/repos/api': { head: OTHER_SHA, status: '' } });
    await expect(resolveObservedCheckouts('ws-1', fresh)).resolves.toEqual([`api@${OTHER_SHA}`]);
  });
});
