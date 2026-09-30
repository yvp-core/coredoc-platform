import { describe, expect, it, vi } from 'vitest';
import {
  assertCellTruth,
  assertPrimaryHistoricalEvidence,
  assertRevisionAgreement,
  preflightCell,
  type GraphOverviewReader,
  type PrimaryHistoryReader,
} from './preflight.js';
import type { LoadedTarget, SelectedCell } from './target-loader.js';
import { AccessMode } from './types.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

describe('revision preflight', () => {
  it('accepts exact requested, verifier, agent, and parsed graph SHAs', () => {
    expect(
      assertRevisionAgreement({
        repoKey: 'target',
        requestedSha: SHA,
        verifierSha: SHA,
        agentSha: SHA,
        graphSha: SHA,
      }),
    ).toBe(SHA);
  });

  it.each([
    ['verifier', { verifierSha: OTHER_SHA }],
    ['agent', { agentSha: OTHER_SHA }],
    ['graph', { graphSha: OTHER_SHA }],
    ['missing graph', { graphSha: null }],
  ])('rejects a %s mismatch with all identities in the error', (_label, override) => {
    expect(() =>
      assertRevisionAgreement({
        repoKey: 'target',
        requestedSha: SHA,
        verifierSha: SHA,
        agentSha: SHA,
        graphSha: SHA,
        ...override,
      }),
    ).toThrow(/target.*requested=.*verifier=.*agent=.*graph=/);
  });

  it('allows no-checkout to omit an agent worktree while still requiring verifier and graph', () => {
    expect(
      assertRevisionAgreement({
        repoKey: 'target',
        requestedSha: SHA,
        verifierSha: SHA,
        agentSha: null,
        graphSha: SHA,
      }),
    ).toBe(SHA);
  });
});

describe('primary truth admission', () => {
  function cell(
    caseId: SelectedCell['caseId'],
    params: Record<string, unknown>,
    opts: { lifecycle?: 'primary' | 'diagnostic'; required?: unknown[] } = {},
  ): SelectedCell {
    const lifecycle = opts.lifecycle ?? 'primary';
    return {
      caseId,
      paramsKey: 'blastRadius',
      cell: {
        lifecycle,
        provenance: { kind: 'source-audit', snapshotCommit: SHA, evidence: ['issue/123'] },
        params,
        ...(lifecycle === 'primary'
          ? {
              admission: {
                artifact: { kind: 'issue', ref: 'issue/123' },
                observer: 'maintainer',
                decision: 'ship risk',
              },
              truth: {
                required: opts.required ?? [
                  { repoKey: 'target', gitSha: SHA, file: 'src/a.ts', relation: 'uses' },
                ],
                accepted: [],
                forbidden: [],
              },
            }
          : {}),
      },
    } as SelectedCell;
  }

  it('requires non-empty structured truth and verifies its file paths at the pinned tree', () => {
    expect(() => assertCellTruth({ selected: cell('blast-radius', {}, { required: [] }), prompt: 'impact' }))
      .toThrow(/structured truth.*required/i);
    expect(() =>
      assertCellTruth({
        selected: cell('blast-radius', {}, {
          required: [
            { repoKey: 'target', gitSha: SHA, file: 'src/missing.ts', relation: 'uses' },
          ],
        }),
        prompt: 'impact',
        pathExists: () => false,
      }),
    ).toThrow(/src\/missing.ts.*pinned revision/);
  });

  it('rejects a transitive closure that includes its own root', () => {
    expect(() =>
      assertCellTruth({
        selected: cell('transitive-callers-closure', {
          symbol: 'root',
          expectedClosure: ['root', 'caller'],
        }, { lifecycle: 'diagnostic' }),
        prompt: 'find callers',
      }),
    ).toThrow(/closure root.*excluded/);
  });

  it('rejects duplicate structured endpoints but permits GET/PATCH on the same normalized path', () => {
    expect(() =>
      assertCellTruth({
        selected: cell('route-api-surface', {
          expectedEndpoints: [
            { method: 'GET', path: '/v1/items/' },
            { method: 'get', path: '/v1/items' },
          ],
        }, { lifecycle: 'diagnostic' }),
        prompt: 'endpoints',
      }),
    ).toThrow(/duplicate endpoint/);
    expect(() =>
      assertCellTruth({
        selected: cell('route-api-surface', {
          expectedEndpoints: [
            { method: 'GET', path: '/v1/items/' },
            { method: 'PATCH', path: '/v1/items' },
          ],
        }, { lifecycle: 'diagnostic' }),
        prompt: 'endpoints',
      }),
    ).not.toThrow();
  });

  it('does not treat flag call-site identifiers as file paths', () => {
    expect(() =>
      assertCellTruth({
        selected: cell('flag-impact-audit', {
          hook: 'useGate',
          hookFile: 'src/hooks/useGate.ts',
          expectedCallSites: ['GatedWidget'],
        }, { lifecycle: 'diagnostic' }),
        prompt: 'find every caller',
        pathExists: (_repoKey, path) => path === 'src/hooks/useGate.ts',
      }),
    ).not.toThrow();
  });

  it('rejects bounded gold paired with an EVERY/COMPLETE task claim', () => {
    expect(() =>
      assertCellTruth({
        selected: cell('blast-radius', {
          truthScope: 'bounded',
          expectedTouchedFiles: ['src/a.ts'],
        }, { lifecycle: 'diagnostic' }),
        prompt: 'List EVERY complete consumer.',
        pathExists: () => true,
      }),
    ).toThrow(/bounded.*EVERY\/COMPLETE/);
  });

  it('falls back to a stripped target-qualified path and resolves siblings only as siblings', () => {
    const selected = cell(
      'blast-radius',
      {
        expectedTouchedFiles: ['target/src/target.ts', 'sibling/src/peer.ts'],
      },
      { lifecycle: 'diagnostic' },
    );
    selected.cell.repoRevisions = { sibling: { gitSha: SHA } };
    const seen: Array<[string, string]> = [];
    assertCellTruth({
      selected,
      prompt: 'impact',
      targetRepoKey: 'target',
      pathExists(repoKey, path) {
        seen.push([repoKey, path]);
        return (
          (repoKey === 'target' && path === 'src/target.ts') ||
          (repoKey === 'sibling' && path === 'src/peer.ts')
        );
      },
    });
    expect(seen).toEqual([
      ['target', 'target/src/target.ts'],
      ['target', 'src/target.ts'],
      ['sibling', 'src/peer.ts'],
    ]);
  });

  it('prefers an exact target path when its first directory equals the repo key', () => {
    const selected = cell(
      'blast-radius',
      {
        expectedTouchedFiles: [
          'acme/middleware.py',
          'acme/services/api/src/server.ts',
          'sibling/src/peer.ts',
        ],
      },
      { lifecycle: 'diagnostic' },
    );
    selected.cell.repoRevisions = { sibling: { gitSha: SHA } };
    const existing = new Set([
      'acme:acme/middleware.py',
      'acme:services/api/src/server.ts',
      'sibling:src/peer.ts',
    ]);
    const seen: Array<[string, string]> = [];

    expect(() =>
      assertCellTruth({
        selected,
        prompt: 'impact',
        targetRepoKey: 'acme',
        pathExists(repoKey, path) {
          seen.push([repoKey, path]);
          return existing.has(`${repoKey}:${path}`);
        },
      }),
    ).not.toThrow();
    expect(seen).toEqual([
      ['acme', 'acme/middleware.py'],
      ['acme', 'acme/services/api/src/server.ts'],
      ['acme', 'services/api/src/server.ts'],
      ['sibling', 'src/peer.ts'],
    ]);
  });
});

describe('registered historical primary preflight', () => {
  it('rejects an unregistered primary before reading any history', async () => {
    const selected = {
      caseId: 'feature-implementation-plan',
      paramsKey: 'featureImplementationPlan',
      cell: {
        lifecycle: 'primary',
        admission: {
          artifact: { kind: 'issue', ref: 'ACME-1' },
          observer: 'An acme-api operator.',
          decision: 'Whether the change is safe to ship.',
          verifierId: 'acme-api-v1',
        },
        provenance: {
          kind: 'historical-diff',
          snapshotCommit: SHA,
          artifactBaseCommit: OTHER_SHA,
          sourceCommit: 'a'.repeat(40),
          evidence: ['test fixture'],
        },
        params: {},
      },
    } as SelectedCell;
    const history: PrimaryHistoryReader = {
      objectType: vi.fn(async () => 'commit'),
      isAncestor: vi.fn(async () => true),
      mergeBase: vi.fn(async () => OTHER_SHA),
      readFile: vi.fn(async () => ''),
    };
    await expect(
      assertPrimaryHistoricalEvidence({
        repoPath: '/repo',
        repoKey: 'acme-api',
        targetSha: SHA,
        selected,
        history,
      }),
    ).rejects.toThrow(/unknown registered primary/i);
    expect(history.objectType).not.toHaveBeenCalled();
  });
});

describe('cross-repo cell preflight', () => {
  const graph: GraphOverviewReader = {
    overview: vi.fn(async (_repoKey: string) => ({
      gitCommitHash: SHA,
      parsedAt: '2026-08-23T00:00:00.000Z',
      parserVersion: '1.2.3',
    })),
  };

  const target = {
    name: 'target',
    repoKey: 'target',
    gitSha: SHA,
  } as LoadedTarget;

  it('fails a runnable cross-repo cell when an expected repository is not pinned', async () => {
    const selected = {
      caseId: 'cross-repo-trace',
      cell: {
        lifecycle: 'diagnostic',
        provenance: { kind: 'audit', snapshotCommit: SHA, evidence: ['x'] },
        params: { expectedRepos: ['target', 'sibling'] },
      },
    } as SelectedCell;
    await expect(
      preflightCell({
        target,
        selected,
        verifierSha: SHA,
        agentSha: SHA,
        graph,
      }),
    ).rejects.toThrow(/sibling.*repoRevisions/);
  });

  it('validates every declared graph pin and local git object when a path is available', async () => {
    const selected = {
      caseId: 'cross-repo-trace',
      cell: {
        lifecycle: 'diagnostic',
        provenance: { kind: 'audit', snapshotCommit: SHA, evidence: ['x'] },
        params: { expectedRepos: ['target', 'sibling'] },
        repoRevisions: { sibling: { gitSha: SHA, path: '/repos/sibling' } },
      },
    } as SelectedCell;
    const resolveLocal = vi.fn(async () => ({
      objectSha: SHA,
      headSha: SHA,
      trackedClean: true,
    }));
    const result = await preflightCell({
      target,
      selected,
      verifierSha: SHA,
      agentSha: SHA,
      graph,
      resolveLocalRevision: resolveLocal,
      accessMode: AccessMode.Worktree,
    });
    expect(resolveLocal).toHaveBeenCalledWith('/repos/sibling', SHA);
    expect(result.revisions.map((revision) => revision.repoKey)).toEqual(['target', 'sibling']);
    expect(result.revisions[1]).toMatchObject({
      localObjectSha: SHA,
      checkoutHeadSha: SHA,
      checkoutTrackedClean: true,
      parsedAt: '2026-08-23T00:00:00.000Z',
      parserVersion: '1.2.3',
    });
  });

  it('rejects a moving or tracked-dirty sibling checkout in worktree mode', async () => {
    const selected = {
      caseId: 'cross-repo-trace',
      cell: {
        lifecycle: 'diagnostic',
        provenance: { kind: 'source-audit', snapshotCommit: SHA, evidence: ['x'] },
        params: { expectedRepos: ['target', 'sibling'] },
        repoRevisions: { sibling: { gitSha: SHA, path: '/repos/sibling' } },
      },
    } as SelectedCell;
    await expect(
      preflightCell({
        target,
        selected,
        verifierSha: SHA,
        agentSha: SHA,
        graph,
        accessMode: AccessMode.Worktree,
        resolveLocalRevision: async () => ({
          objectSha: SHA,
          headSha: OTHER_SHA,
          trackedClean: false,
        }),
      }),
    ).rejects.toThrow(/sibling.*checkout HEAD.*trackedClean=false/);
  });
});

describe('access-mode binding preflight', () => {
  const target = {
    name: 'target',
    repoKey: 'target',
    gitSha: SHA,
  } as LoadedTarget;

  function graphReader(): GraphOverviewReader {
    return {
      overview: vi.fn(async (_repoKey: string) => ({
        gitCommitHash: SHA,
        parsedAt: '2026-08-23T00:00:00.000Z',
        parserVersion: '1.2.3',
      })),
    };
  }

  function boundCell(requiresAccessMode?: AccessMode): SelectedCell {
    return {
      caseId: 'feature-implementation-plan',
      paramsKey: 'featureImplementationPlan',
      cell: {
        lifecycle: 'diagnostic',
        provenance: { kind: 'source-audit', snapshotCommit: SHA, evidence: ['pr/1'] },
        params: { feature: 'held out' },
        ...(requiresAccessMode ? { requiresAccessMode } : {}),
      },
    } as SelectedCell;
  }

  it.each([
    ['an explicit worktree invocation', AccessMode.Worktree],
    ['an omitted access mode', undefined],
  ])('refuses %s for a historyless-bound cell before any graph read', async (_label, accessMode) => {
    const graph: GraphOverviewReader = {
      overview: vi.fn(async () => {
        throw new Error('should not be reached');
      }),
    };
    await expect(
      preflightCell({
        target,
        selected: boundCell(AccessMode.HistorylessSnapshot),
        verifierSha: SHA,
        agentSha: SHA,
        graph,
        accessMode,
      }),
    ).rejects.toThrow(
      /feature-implementation-plan: cell requires access mode "historyless-snapshot" but the invocation selected "worktree"/,
    );
    expect(graph.overview).not.toHaveBeenCalled();
  });

  it('runs a historyless-bound cell under its required mode', async () => {
    await expect(
      preflightCell({
        target,
        selected: boundCell(AccessMode.HistorylessSnapshot),
        verifierSha: SHA,
        agentSha: null,
        graph: graphReader(),
        accessMode: AccessMode.HistorylessSnapshot,
      }),
    ).resolves.toMatchObject({ revisions: [{ repoKey: 'target', requestedSha: SHA }] });
  });

  it('leaves an unbound cell runnable in worktree mode', async () => {
    await expect(
      preflightCell({
        target,
        selected: boundCell(),
        verifierSha: SHA,
        agentSha: SHA,
        graph: graphReader(),
        accessMode: AccessMode.Worktree,
      }),
    ).resolves.toMatchObject({ revisions: [{ repoKey: 'target', requestedSha: SHA }] });
  });
});
