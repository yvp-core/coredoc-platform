import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EdgeType, type LinkResult } from '@coredoc/core';
import type { IGraphRepository, GraphEdge } from './types.js';
import { persistLinkResult } from './resolution.js';

function makeRepo(
  id: string,
  name: string,
  externalCallIds: string[] = [],
): { id: string; name: string; externalCalls: { id: string }[] } {
  return { id, name, externalCalls: externalCallIds.map((cid) => ({ id: cid })) };
}

function makeRepository(): {
  repo: IGraphRepository;
  pushedEdges: GraphEdge[];
  deletedTypes: Array<{ type: string; repoIds: string[] }>;
  resolvedUpdates: Map<string, string>[];
  cleared: string[][];
} {
  const pushedEdges: GraphEdge[] = [];
  const deletedTypes: Array<{ type: string; repoIds: string[] }> = [];
  const resolvedUpdates: Map<string, string>[] = [];
  const cleared: string[][] = [];
  const repo = {
    pushEdges: vi.fn(async (edges: GraphEdge[]) => {
      pushedEdges.push(...edges);
      return edges.length;
    }),
    deleteEdgesByType: vi.fn(async (type: string, repoIds: string[]) => {
      deletedTypes.push({ type, repoIds });
    }),
    updateResolvedTargetIds: vi.fn(async (updates: Map<string, string>) => {
      resolvedUpdates.push(new Map(updates));
    }),
    clearResolvedTargetIds: vi.fn(async (ids: string[]) => {
      cleared.push([...ids]);
    }),
  } as unknown as IGraphRepository;
  return { repo, pushedEdges, deletedTypes, resolvedUpdates, cleared };
}

function emptyResult(): LinkResult {
  return { edges: [], unresolved: [], metrics: { total: 0, resolved: 0, unresolvableExcluded: 0, rate: 0 } };
}

describe('persistLinkResult', () => {
  let env: ReturnType<typeof makeRepository>;
  beforeEach(() => {
    env = makeRepository();
  });

  it('clears stale RESOLVES_TO edges for every affected repo even when no new edges are written', async () => {
    const repos = [makeRepo('r1', 'caller', ['c1']), makeRepo('r2', 'target')];
    const out = await persistLinkResult(env.repo, repos, emptyResult());
    expect(out.crossRepoEdgesPushed).toBe(0);
    expect(env.deletedTypes).toEqual([{ type: 'RESOLVES_TO', repoIds: ['r1', 'r2'] }]);
    expect(env.pushedEdges).toHaveLength(0);
  });

  it('writes a RESOLVES_TO edge straight from the LinkEdge id, createdBy ai', async () => {
    const repos = [makeRepo('r1', 'caller', ['c1']), makeRepo('r2', 'target')];
    const result: LinkResult = {
      edges: [
        {
          id: 'resolve:c1:ep-1',
          sourceId: 'c1',
          targetId: 'ep-1',
          confidence: 0.9,
          properties: { sourceRepoName: 'caller', targetRepoName: 'target', via: 'moniker+http' },
        },
      ],
      unresolved: [],
      metrics: { total: 1, resolved: 1, unresolvableExcluded: 0, rate: 1 },
    };
    const out = await persistLinkResult(env.repo, repos, result);
    expect(out.crossRepoEdgesPushed).toBe(1);
    expect(env.repo.pushEdges).toHaveBeenCalledWith(expect.any(Array), {
      collisionTypes: [EdgeType.ResolvesTo],
    });
    expect(env.pushedEdges).toHaveLength(1);
    expect(env.pushedEdges[0]!).toMatchObject({
      id: 'resolve:c1:ep-1',
      sourceId: 'c1',
      targetId: 'ep-1',
      type: 'RESOLVES_TO',
      confidence: 0.9,
      createdBy: 'ai',
    });
    expect(env.pushedEdges[0]!.properties).toMatchObject({ via: 'moniker+http', targetRepoName: 'target' });
  });

  it('writes edges in locale-independent UTF-16 code-unit order', async () => {
    const edgeIds = ['resolve:é', 'resolve:a', 'resolve:_', 'resolve:A', 'resolve:😀', 'resolve:-'];
    const result: LinkResult = {
      edges: edgeIds.map((id, index) => ({
        id,
        sourceId: `call-${index}`,
        targetId: `entrypoint-${index}`,
        confidence: 1,
        properties: {},
      })),
      unresolved: [],
      metrics: { total: edgeIds.length, resolved: edgeIds.length, unresolvableExcluded: 0, rate: 1 },
    };

    await persistLinkResult(
      env.repo,
      [
        makeRepo(
          'repo',
          'caller',
          result.edges.map((edge) => edge.sourceId),
        ),
      ],
      result,
    );

    expect(env.pushedEdges.map((edge) => edge.id)).toEqual([
      'resolve:-',
      'resolve:A',
      'resolve:_',
      'resolve:a',
      'resolve:é',
      'resolve:😀',
    ]);
  });

  it('sets resolvedTargetId for resolved calls and clears it for the rest', async () => {
    const repos = [makeRepo('r1', 'caller', ['c1', 'c2']), makeRepo('r2', 'target')];
    const result: LinkResult = {
      edges: [{ id: 'resolve:c1:ep-1', sourceId: 'c1', targetId: 'ep-1', confidence: 1, properties: {} }],
      unresolved: [{ sourceId: 'c2', code: 'no-entrypoint-match' }],
      metrics: { total: 2, resolved: 1, unresolvableExcluded: 0, rate: 0.5 },
    };
    await persistLinkResult(env.repo, repos, result);
    expect(env.resolvedUpdates).toHaveLength(1);
    expect([...env.resolvedUpdates[0]!.entries()]).toEqual([['c1', 'ep-1']]);
    expect(env.cleared).toEqual([['c2']]);
  });

  it('persists package-import RESOLVES_TO edges without treating source files as resolved external calls', async () => {
    const repos = [makeRepo('r1', 'caller', ['c1', 'c2']), makeRepo('r2', 'target')];
    const result = {
      edges: [{ id: 'resolve:c1:ep-1', sourceId: 'c1', targetId: 'ep-1', confidence: 1, properties: {} }],
      packageImportEdges: [
        {
          id: 'resolve:package-import:import-1:BookingTypes:enum-1',
          sourceId: 'file-1',
          targetId: 'enum-1',
          confidence: 1,
          createdBy: 'cross-repo-linker',
          properties: {
            relation: 'package-import',
            usage: 'import',
            importedName: 'BookingTypes',
            moduleSpecifier: '@acme/types',
          },
        },
      ],
      unresolved: [{ sourceId: 'c2', code: 'no-entrypoint-match' }],
      metrics: { total: 2, resolved: 1, unresolvableExcluded: 0, rate: 0.5 },
    } as LinkResult & {
      packageImportEdges: Array<{
        id: string;
        sourceId: string;
        targetId: string;
        confidence: 1;
        createdBy: 'cross-repo-linker';
        properties: Record<string, unknown>;
      }>;
    };

    const out = await persistLinkResult(env.repo, repos, result);

    expect(env.repo.pushEdges).toHaveBeenCalledTimes(1);
    expect(env.pushedEdges).toHaveLength(2);
    expect(env.pushedEdges[1]).toMatchObject({
      id: 'resolve:package-import:import-1:BookingTypes:enum-1',
      sourceId: 'file-1',
      targetId: 'enum-1',
      type: EdgeType.ResolvesTo,
      confidence: 1,
      properties: expect.objectContaining({ relation: 'package-import', createdBy: 'cross-repo-linker' }),
    });
    expect(out.crossRepoEdgesPushed).toBe(1);
    expect(out.packageImportEdgesPushed).toBe(1);
    expect([...env.resolvedUpdates[0]!.entries()]).toEqual([['c1', 'ep-1']]);
    expect(env.cleared).toEqual([['c2']]);
  });

  it('checks the abort signal between stale-edge deletion and writes', async () => {
    const abort = new AbortController();
    (env.repo.deleteEdgesByType as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      abort.abort(new Error('resolution persistence aborted'));
    });
    const result: LinkResult = {
      edges: [{ id: 'resolve:c1:ep-1', sourceId: 'c1', targetId: 'ep-1', confidence: 1, properties: {} }],
      unresolved: [],
      metrics: { total: 1, resolved: 1, unresolvableExcluded: 0, rate: 1 },
    };

    await expect(persistLinkResult(env.repo, [makeRepo('r1', 'caller', ['c1'])], result, abort.signal)).rejects.toThrow(
      'resolution persistence aborted',
    );
    expect(env.repo.pushEdges).not.toHaveBeenCalled();
    expect(env.repo.updateResolvedTargetIds).not.toHaveBeenCalled();
  });
});
