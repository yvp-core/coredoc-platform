import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeType, NodeType, type GraphEdge, type GraphNode } from '@coredoc/core';
import type { Connection, Database } from '@ladybugdb/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApplyMode, TypeUseKind } from '../types.js';
import { LADYBUG_NO_QUERY_TIMEOUT_MS, LadybugDriver } from './driver.js';
import { LadybugRepository } from './repository.js';
import { LADYBUG_EDGE_TYPES } from './schema.js';

const REPO_A = 'aaa111aaa111';
const REPO_B = 'bbb222bbb222';

function node(id: string, name: string, repoId: string, properties: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type: NodeType.Function,
    name,
    properties: { kind: 'function', isAsync: false, ...properties },
    repoId,
    filePath: `src/${name}.ts`,
    startLine: 1,
    endLine: 2,
  };
}

function calls(sourceId: string, targetId: string, ordinal: number): GraphEdge {
  return {
    id: `call-${ordinal}`,
    sourceId,
    targetId,
    type: EdgeType.Calls,
    confidence: 1,
    createdBy: 'parser',
    properties: { callSiteLine: ordinal },
  };
}

function relationship(
  id: string,
  sourceId: string,
  targetId: string,
  type: EdgeType,
  properties: Record<string, unknown> = {},
): GraphEdge {
  return { id, sourceId, targetId, type, confidence: 1, createdBy: 'parser', properties };
}

function graphNode(
  id: string,
  type: NodeType,
  name: string,
  repoId: string | undefined,
  properties: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    type,
    name,
    properties,
    ...(repoId ? { repoId } : {}),
    ...(type !== NodeType.Repository ? { filePath: `src/${name}.ts`, startLine: 1, endLine: 2 } : {}),
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function openRepository(
  readOnly = false,
  path?: string,
): Promise<{ driver: LadybugDriver; repository: LadybugRepository; path: string }> {
  const directory = path ? undefined : mkdtempSync(join(tmpdir(), 'coredoc-ladybug-repository-'));
  const databasePath = path ?? join(directory as string, 'graph.db');
  const driver = new LadybugDriver(databasePath, { readOnly });
  await driver.initialize();
  const cleanup = async (): Promise<void> => {
    await driver.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { driver, repository: new LadybugRepository(driver), path: databasePath };
}

describe('LadybugRepository', () => {
  it('returns source files linked by package-import RESOLVES_TO edges as type usages', async () => {
    const { repository } = await openRepository();
    const targetId = `${REPO_A}:enum:src/enums.ts:BookingTypes`;
    const sourceId = `${REPO_B}:file:src/use-booking.ts`;
    await repository.pushNodes([
      graphNode(targetId, NodeType.Enum, 'BookingTypes', REPO_A),
      graphNode(sourceId, NodeType.File, 'src/use-booking.ts', REPO_B),
    ]);
    await repository.pushEdges([
      relationship('resolve:package-import:use-booking:BookingTypes', sourceId, targetId, EdgeType.ResolvesTo, {
        relation: 'package-import',
        usage: 'import',
        via: 'BookingKind',
        importedName: 'BookingTypes',
      }),
    ]);

    const results = await repository.getTypeUsages(targetId, [REPO_B]);

    expect(results).toEqual([
      expect.objectContaining({
        id: sourceId,
        name: 'src/use-booking.ts',
        type: NodeType.File,
        usage: 'import',
        via: 'BookingKind',
        ambiguous: false,
      }),
    ]);
  });

  it('keeps value-position enum-member consumers distinguishable from type-position ones', async () => {
    const { repository } = await openRepository();
    const targetId = `${REPO_A}:enum:src/enums.ts:Status`;
    const typeConsumer = `${REPO_A}:function:src/describe.ts:describeStatus`;
    const valueConsumer = `${REPO_A}:function:src/gate.ts:isLocked`;
    await repository.pushNodes([
      graphNode(targetId, NodeType.Enum, 'Status', REPO_A),
      graphNode(typeConsumer, NodeType.Function, 'describeStatus', REPO_A),
      graphNode(valueConsumer, NodeType.Function, 'isLocked', REPO_A),
    ]);
    await repository.pushEdges([
      relationship('uses-status-type', typeConsumer, targetId, EdgeType.UsesType, {
        usage: 'parameter',
        via: 'status',
      }),
      relationship('uses-status-value', valueConsumer, targetId, EdgeType.UsesType, {
        usage: 'member-access',
        useKind: TypeUseKind.Value,
        member: 'Locked',
      }),
    ]);

    const results = await repository.getTypeUsages(targetId, [REPO_A]);

    const typeUsage = results.find((usage) => usage.id === typeConsumer);
    expect(typeUsage?.useKind).toBeUndefined();
    expect(typeUsage?.member).toBeUndefined();
    expect(results.find((usage) => usage.id === valueConsumer)).toMatchObject({
      usage: 'member-access',
      useKind: TypeUseKind.Value,
      member: 'Locked',
    });
  });

  it('returns construction and import consumers of a class', async () => {
    const { repository } = await openRepository();
    const targetId = `${REPO_A}:class:src/service.ts:UserService`;
    const constructionConsumer = `${REPO_A}:function:src/a.ts:build`;
    const importConsumer = `${REPO_A}:file:src/b.ts`;
    await repository.pushNodes([
      graphNode(targetId, NodeType.Class, 'UserService', REPO_A),
      graphNode(constructionConsumer, NodeType.Function, 'build', REPO_A),
      graphNode(importConsumer, NodeType.File, 'src/b.ts', REPO_A),
    ]);
    await repository.pushEdges([
      relationship('constructs-user-service', constructionConsumer, targetId, EdgeType.UsesType, {
        usage: 'construction',
        useKind: TypeUseKind.Value,
      }),
      relationship('imports-user-service', importConsumer, targetId, EdgeType.UsesType, { usage: 'import' }),
    ]);

    const results = await repository.getTypeUsages(targetId, [REPO_A]);

    expect(results.find((usage) => usage.id === constructionConsumer)).toMatchObject({
      usage: 'construction',
      useKind: TypeUseKind.Value,
      ambiguous: false,
    });
    expect(results.find((usage) => usage.id === importConsumer)).toMatchObject({
      type: NodeType.File,
      usage: 'import',
    });
  });

  it('carries the weak-identity flag of a name-matched member reference through to the row', async () => {
    const { repository } = await openRepository();
    const targetId = `${REPO_A}:enum:src/enums.ts:Mode`;
    const weakConsumer = `${REPO_A}:function:src/weak.ts:isFast`;
    await repository.pushNodes([
      graphNode(targetId, NodeType.Enum, 'Mode', REPO_A),
      graphNode(weakConsumer, NodeType.Function, 'isFast', REPO_A),
    ]);
    await repository.pushEdges([
      relationship('uses-mode-value-weak', weakConsumer, targetId, EdgeType.UsesType, {
        usage: 'member-access',
        useKind: TypeUseKind.Value,
        member: 'Fast',
        ambiguous: true,
      }),
    ]);

    const results = await repository.getTypeUsages(targetId, [REPO_A]);

    expect(results.find((usage) => usage.id === weakConsumer)).toMatchObject({
      useKind: TypeUseKind.Value,
      member: 'Fast',
      ambiguous: true,
    });
  });

  it('orders type usages by code units across punctuation, case, and non-ASCII paths', async () => {
    const { repository } = await openRepository();
    const targetId = `${REPO_A}:interface:src/types.ts:Config`;
    const filePaths = ['src/a.ts', 'src/é.ts', 'src/_.ts', 'src/-.ts', 'src/A.ts'];
    const consumers = filePaths.map((filePath, index) => ({
      ...graphNode(`${REPO_B}:function:${filePath}:useConfig`, NodeType.Function, `useConfig${index}`, REPO_B),
      filePath,
    }));
    await repository.pushNodes([graphNode(targetId, NodeType.Interface, 'Config', REPO_A), ...consumers]);
    await repository.pushEdges(
      consumers.map((consumer, index) =>
        relationship(`uses-config-${index}`, consumer.id, targetId, EdgeType.UsesType, { usage: 'parameter' }),
      ),
    );

    const results = await repository.getTypeUsages(targetId, [REPO_B]);

    expect(results.map(({ filePath }) => filePath)).toEqual([
      'src/-.ts',
      'src/A.ts',
      'src/_.ts',
      'src/a.ts',
      'src/é.ts',
    ]);
  });

  it('detects exact sensitive text in every persisted node text field within repository scope', async () => {
    const { repository } = await openRepository();
    const sensitive = {
      id: 'sensitive-id-canary',
      name: 'sensitive-name-canary',
      properties: 'sensitive "properties"\ncanary',
      summary: 'sensitive-summary-canary',
      filePath: 'sensitive-file-path-canary',
    };
    await repository.pushNodes([
      {
        ...node(`${REPO_A}:function:${sensitive.id}`, sensitive.name, REPO_A, {
          marker: sensitive.properties,
        }),
        summary: sensitive.summary,
        filePath: `src/${sensitive.filePath}.ts`,
      },
      node(`${REPO_B}:function:other-repo`, 'other-repo', REPO_B, {
        marker: 'out-of-scope-canary',
      }),
    ]);

    for (const needle of Object.values(sensitive)) {
      await expect(repository.containsNodeText([needle], [REPO_A])).resolves.toBe(true);
    }
    await expect(repository.containsNodeText(['out-of-scope-canary'], [REPO_A])).resolves.toBe(false);
    await expect(repository.containsNodeText(['missing-canary'], [REPO_A])).resolves.toBe(false);
  });

  it('streams one fixed scoped query and stops after the first sensitive node', async () => {
    let pulled = 0;
    let closed = false;
    const streamReadRows = vi.fn(async function* (query: string, params: Record<string, unknown>) {
      try {
        pulled += 1;
        yield {
          id: `${REPO_A}:function:one`,
          name: 'sensitive-canary',
          properties: '{}',
          summary: null,
          filePath: 'src/one.ts',
        };
        pulled += 1;
        yield {
          id: `${REPO_A}:function:two`,
          name: 'second',
          properties: '{}',
          summary: null,
          filePath: 'src/two.ts',
        };
      } finally {
        closed = true;
      }
      void query;
      void params;
    });
    const repository = new LadybugRepository({ streamReadRows } as never);

    await expect(repository.containsNodeText(['sensitive-canary'], [REPO_A])).resolves.toBe(true);
    expect(streamReadRows).toHaveBeenCalledOnce();
    expect(streamReadRows.mock.calls[0]?.[0]).not.toContain('sensitive-canary');
    expect(streamReadRows.mock.calls[0]?.[0]).toContain('list_contains($repoHashes, n.repoId)');
    expect(streamReadRows.mock.calls[0]?.[1]).toEqual({ repoHashes: [REPO_A] });
    expect(pulled).toBe(1);
    expect(closed).toBe(true);
  });

  it('fails closed when stored properties cannot be inspected', async () => {
    const driver = {
      async *streamReadRows(): AsyncGenerator<Record<string, unknown>> {
        yield {
          id: `${REPO_A}:function:invalid`,
          name: 'invalid',
          properties: '{',
          summary: null,
          filePath: 'src/invalid.ts',
        };
      },
    };
    const repository = new LadybugRepository(driver as never);

    await expect(repository.containsNodeText(['missing-canary'], [REPO_A])).rejects.toThrow(
      'Invalid stored node properties prevent logical text inspection',
    );
    await expect(repository.containsNodeText([''], [REPO_A])).rejects.toThrow(
      'Logical node text needles must be non-empty strings',
    );
  });

  it('fails closed when immutable-file validation encounters malformed stored properties', async () => {
    const driver = {
      async *streamReadRows(): AsyncGenerator<Record<string, unknown>> {
        yield {
          id: `${REPO_A}:function:invalid`,
          type: NodeType.Function,
          name: 'invalid',
          properties: '{',
          summary: null,
          embedding: null,
          repoId: REPO_A,
          filePath: 'src/invalid.ts',
          startLine: 1,
          endLine: 1,
        };
      },
    };
    const repository = new LadybugRepository(driver as never);

    await expect(async () => {
      for await (const _node of repository.scanStoredNodes()) {
        // Consume the validation stream so malformed content must surface.
      }
    }).rejects.toThrow('Invalid stored graph node properties');
  });

  it('runs a scoped, parameterized, and bounded query against the real FTS index capability', async () => {
    const run = vi.fn(async () => [{ id: 'hit', name: 'Needle', score: 1.25 }]);
    const driver = {
      withReadTransaction: async <T>(callback: (transaction: { run: typeof run }) => Promise<T>): Promise<T> =>
        callback({ run }),
    };
    const repository = new LadybugRepository(driver as never);

    await expect(repository.queryFtsIndex('Needle', [REPO_A], 1_000)).resolves.toEqual([
      { id: 'hit', name: 'Needle', score: 1.25 },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toContain('CALL QUERY_FTS_INDEX');
    expect(run.mock.calls[0]?.[0]).toContain('$query');
    expect(run.mock.calls[0]?.[0]).toContain('list_contains($repoHashes, node.repoId)');
    expect(run.mock.calls[0]?.[0]).toMatch(/ORDER BY score DESC, node\.id LIMIT 100$/);
    expect(run.mock.calls[0]?.[1]).toEqual({ query: 'Needle', repoHashes: [REPO_A] });
  });

  it('bounds an all-wildcard code search in Ladybug rather than materializing the full graph', async () => {
    const queries: string[] = [];
    const driver = {
      async *streamReadRows(query: string): AsyncGenerator<Record<string, unknown>> {
        queries.push(query);
        yield* [] as Record<string, unknown>[];
      },
    };
    const repository = new LadybugRepository(driver as never);

    await expect(repository.findCode({ pattern: '*', limit: 10 }, [REPO_A])).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/LIMIT 10\s*$/);
  });

  it('streams complex glob candidates and stops once the requested page is full', async () => {
    let pulled = 0;
    let closed = false;
    const rows = ['alpha-middle-z', 'alpha-miss', 'alpha-other-z'];
    const driver = {
      async *streamReadRows(): AsyncGenerator<Record<string, unknown>> {
        try {
          for (const name of rows) {
            pulled += 1;
            yield {
              id: `node-${pulled}`,
              type: NodeType.Function,
              name,
              properties: '{}',
              summary: null,
              embedding: null,
              repoId: REPO_A,
              filePath: 'src/a.ts',
              startLine: pulled,
              endLine: pulled,
            };
          }
        } finally {
          closed = true;
        }
      },
    };
    const repository = new LadybugRepository(driver as never);

    await expect(repository.findCode({ pattern: 'alpha*?z', limit: 1 }, [REPO_A])).resolves.toHaveLength(1);
    expect(pulled).toBe(1);
    expect(closed).toBe(true);
  });

  it('clamps edges-among database work at the 10,000-edge production ceiling', async () => {
    const run = vi.fn(async () => []);
    const driver = {
      withReadTransaction: async <T>(callback: (transaction: { run: typeof run }) => Promise<T>): Promise<T> =>
        callback({ run }),
    };
    const repository = new LadybugRepository(driver as never);

    await expect(repository.getEdgesAmong(['left', 'right'], [REPO_A], 10_001)).resolves.toEqual({
      edges: [],
      truncated: false,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatch(/LIMIT 10001\s*$/);
  });

  it('mirrors edge upsert keys and removes cleared metadata properties', async () => {
    const { repository } = await openRepository();
    const left = node(`${REPO_A}:function:left`, 'left', REPO_A, { resolvedTargetId: 'old-target' });
    const middle = node(`${REPO_A}:function:middle`, 'middle', REPO_A);
    const right = node(`${REPO_A}:function:right`, 'right', REPO_A);
    await repository.pushNodes([left, middle, right]);

    await repository.pushEdges([relationship('edge-1', left.id, middle.id, EdgeType.Calls)]);
    await repository.pushEdges([relationship('edge-1', left.id, right.id, EdgeType.Calls)]);
    let edges = await repository.getEdgesAmong([left.id, middle.id, right.id], [REPO_A]);
    expect(edges.edges).toEqual([
      expect.objectContaining({ id: 'edge-1', sourceId: left.id, targetId: right.id, type: EdgeType.Calls }),
    ]);

    await repository.pushEdges([{ ...relationship('edge-2', left.id, right.id, EdgeType.Calls), confidence: 0.5 }]);
    edges = await repository.getEdgesAmong([left.id, middle.id, right.id], [REPO_A]);
    expect(edges.edges).toEqual([
      expect.objectContaining({ id: 'edge-1', sourceId: left.id, targetId: right.id, confidence: 0.5 }),
    ]);

    await repository.clearResolvedTargetIds([left.id]);
    const stored = await repository.getNodeWithProperties(left.id, [REPO_A]);
    expect(stored).not.toBeNull();
    expect(Object.hasOwn(stored?.properties ?? {}, 'resolvedTargetId')).toBe(false);
  });

  it("judges each dead-code candidate by ITS type's usage edges, not the batch union", async () => {
    const { repository } = await openRepository();
    // A class whose only inbound edge is REFERENCES_VARIABLE (a DI token).
    // REFERENCES_VARIABLE is usage for Function candidates but NOT for Class —
    // sqlite reports this class dead; the union-list bug marked it live
    // whenever a Function candidate shared the scan batch.
    const cls = { ...node(`${REPO_A}:class:di-token`, 'DiToken', REPO_A, { kind: 'class' }), type: NodeType.Class };
    const fn = node(`${REPO_A}:function:consumer`, 'consumer', REPO_A);
    await repository.pushNodes([cls, fn]);
    await repository.pushEdges([relationship('ref-1', fn.id, cls.id, EdgeType.ReferencesVariable)]);

    const result = await repository.findDeadNodes({ types: [NodeType.Class, NodeType.Function], limit: 20 }, [REPO_A]);
    const deadIds = result.nodes.map((deadNode) => deadNode.id);
    expect(deadIds).toContain(cls.id);
  });

  it('drops a dangling edge like a clean rebuild would: no insert, and the same-id prior edge goes too', async () => {
    const { repository } = await openRepository();
    const left = node(`${REPO_A}:function:dangling-left`, 'dangling-left', REPO_A);
    const right = node(`${REPO_A}:function:dangling-right`, 'dangling-right', REPO_A);
    const edge = relationship('stable-edge-id', left.id, right.id, EdgeType.Calls);
    await repository.pushNodes([left, right]);
    await repository.pushEdges([edge]);

    // Transformer output legitimately contains dangling references (unresolved
    // calleeId, out-of-repo HANDLES). Policy matches the cloud file-builder:
    // drop and count, never roll back the whole changeset — throwing here made
    // real repos that push fine on sqlite fail wholesale on ladybug.
    const receipt = await repository.applyChangeset({
      repoId: REPO_A,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [{ ...edge, targetId: `${REPO_A}:function:missing` }],
    });

    expect(receipt.edgesInserted).toBe(0);
    // Clean-build equivalence: a rebuild of this input would contain neither
    // the dangling edge nor any prior edge under the same id.
    await expect(repository.getEdgesAmong([left.id, right.id], [REPO_A])).resolves.toMatchObject({ edges: [] });
  });

  it('inventories relationship tables once per edge batch instead of scanning every relation for every edge', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      if (query.includes('RETURN source.id AS sourceId, target.id AS targetId LIMIT 1')) {
        return [{ sourceId: 'source', targetId: 'target' }];
      }
      return [];
    });
    const driver = {
      executeBatch: async <T>(
        items: T[],
        handler: (batch: T[], transaction: { run: typeof run }) => Promise<void>,
      ): Promise<number> => {
        await handler(items, { run });
        return items.length;
      },
    };
    const repository = new LadybugRepository(driver as never);

    await repository.pushEdges([
      relationship('edge-a', 'source', 'target-a', EdgeType.Calls),
      relationship('edge-b', 'source', 'target-b', EdgeType.Imports),
    ]);

    expect(queries.filter((query) => query.includes('MATCH (source:GraphNode)-[r:'))).toHaveLength(
      LADYBUG_EDGE_TYPES.length,
    );
    expect(queries.some((query) => query.includes('-[r]->') && query.includes('r.id = $id'))).toBe(false);
  });

  it('inventories only RESOLVES_TO for canonical resolver edges', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      if (query.includes('RETURN source.id AS sourceId, target.id AS targetId LIMIT 1')) {
        return [{ sourceId: 'source', targetId: 'target' }];
      }
      return [];
    });
    const driver = {
      executeBatch: async <T>(
        items: T[],
        handler: (batch: T[], transaction: { run: typeof run }) => Promise<void>,
      ): Promise<number> => {
        await handler(items, { run });
        return items.length;
      },
    };
    const repository = new LadybugRepository(driver as never);

    await repository.pushEdges([relationship('resolve:source:target', 'source', 'target', EdgeType.ResolvesTo)], {
      collisionTypes: [EdgeType.ResolvesTo],
    });

    const inventoryQueries = queries.filter((query) => query.includes('RETURN r.id AS id'));
    expect(inventoryQueries).toEqual([expect.stringContaining('[r:RESOLVES_TO]')]);
  });

  it('validates a narrowed collision scope before building Cypher', async () => {
    const executeBatch = vi.fn();
    const repository = new LadybugRepository({ executeBatch } as never);
    const edge = relationship('edge-a', 'source', 'target', EdgeType.Calls);

    await expect(repository.pushEdges([edge], { collisionTypes: ['INVALID_RELATION' as EdgeType] })).rejects.toThrow(
      'Unsupported Ladybug relationship type: INVALID_RELATION',
    );
    await expect(repository.pushEdges([edge], { collisionTypes: [EdgeType.ResolvesTo] })).rejects.toThrow(
      'Ladybug edge collision scope must include every incoming relationship type',
    );
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it('skips edge inventory after replacing the changeset repository', async () => {
    const queries: string[] = [];
    const run = vi.fn(async (query: string) => {
      queries.push(query);
      if (query.includes('RETURN source.id AS sourceId') && query.includes('LIMIT 1')) {
        return [{ sourceId: 'source', targetId: 'target' }];
      }
      return [];
    });
    const driver = {
      withWriteTransaction: async <T>(handler: (transaction: { run: typeof run }) => Promise<T>): Promise<T> =>
        handler({ run }),
    };
    const repository = new LadybugRepository(driver as never);
    const source = node(`${REPO_A}:function:source`, 'source', REPO_A);
    const target = node(`${REPO_A}:function:target`, 'target', REPO_A);

    const receipt = await repository.applyChangeset({
      repoId: REPO_A,
      repoIdsToDelete: [REPO_A],
      nodesToAdd: [source, target],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [relationship(`${REPO_A}:call:edge`, source.id, target.id, EdgeType.Calls)],
    });

    expect(receipt.edgesInserted).toBe(1);
    expect(queries.filter((query) => query.includes('RETURN r.id AS id'))).toEqual([]);
  });

  it('scopes Unicode duplicate names and bounds cyclic transitive callers to 100', async () => {
    const { repository } = await openRepository();
    const target = node(`${REPO_A}:function:target`, '目標', REPO_A);
    const cycle = node(`${REPO_A}:function:cycle`, '循環', REPO_A);
    const duplicateA = node(`${REPO_A}:function:unicode`, 'συνάρτηση', REPO_A);
    const duplicateB = node(`${REPO_B}:function:unicode`, 'συνάρτηση', REPO_B);
    const fanIn = Array.from({ length: 105 }, (_, index) =>
      node(`${REPO_A}:function:caller-${index.toString().padStart(3, '0')}`, `caller-${index}`, REPO_A),
    );

    await repository.pushNodes([target, cycle, duplicateA, duplicateB, ...fanIn]);
    await repository.pushEdges([
      calls(cycle.id, target.id, 1),
      calls(target.id, cycle.id, 2),
      ...fanIn.map((caller, index) => calls(caller.id, target.id, index + 3)),
    ]);

    expect((await repository.findFunction('συνάρτηση', [REPO_A]))?.id).toBe(duplicateA.id);
    expect((await repository.findFunction('συνάρτηση', [REPO_B]))?.id).toBe(duplicateB.id);

    const callers = await repository.getTransitiveCallers(target.id, Number.MAX_SAFE_INTEGER, [REPO_A]);
    expect(callers).toHaveLength(100);
    expect(new Set(callers.map((caller) => caller.id)).size).toBe(100);
    expect(callers.every((caller) => caller.id !== target.id)).toBe(true);
    expect(callers.every((caller) => caller.distance >= 1 && caller.distance <= 10)).toBe(true);
  });

  it('reports subgraph truncation when visited cycle nodes would otherwise crowd the per-level limit', async () => {
    const { repository } = await openRepository();
    const root = node(`${REPO_A}:function:00-root`, '00-root', REPO_A);
    const branch = node(`${REPO_A}:function:01-branch`, '01-branch', REPO_A);
    const first = node(`${REPO_A}:function:02-first`, '02-first', REPO_A);
    const hidden = node(`${REPO_A}:function:03-hidden`, '03-hidden', REPO_A);
    await repository.pushNodes([root, branch, first, hidden]);
    await repository.pushEdges([
      relationship('root-branch', root.id, branch.id, EdgeType.Calls),
      relationship('branch-root', branch.id, root.id, EdgeType.Calls),
      relationship('branch-self', branch.id, branch.id, EdgeType.Calls),
      relationship('branch-first', branch.id, first.id, EdgeType.Calls),
      relationship('branch-hidden', branch.id, hidden.id, EdgeType.Calls),
    ]);

    await expect(
      repository.getSubgraph(root.id, { depth: 2, direction: 'out', nodeCap: 2 }, [REPO_A]),
    ).resolves.toMatchObject({
      nodes: [
        expect.objectContaining({ id: root.id }),
        expect.objectContaining({ id: branch.id }),
        expect.objectContaining({ id: first.id }),
      ],
      truncated: true,
    });
  });

  it('serves a checkpointed artifact read-only and rejects every write path at the driver boundary', async () => {
    const { driver, repository, path } = await openRepository();
    await repository.pushNodes([node(`${REPO_A}:function:reader`, 'reader', REPO_A)]);
    await driver.checkpoint();
    await driver.close();

    const { repository: readOnlyRepository } = await openRepository(true, path);
    expect((await readOnlyRepository.findCode({ pattern: 'reader' }, [REPO_A])).map((result) => result.id)).toEqual([
      `${REPO_A}:function:reader`,
    ]);
    await expect(
      readOnlyRepository.pushNodes([node(`${REPO_A}:function:forbidden`, 'forbidden', REPO_A)]),
    ).rejects.toThrow(/read-only/i);
  });

  it('applies one atomic changeset, preserves unique edges, and round-trips its snapshot', async () => {
    const { repository } = await openRepository();
    const repositoryNode: GraphNode = {
      id: REPO_A,
      type: NodeType.Repository,
      name: 'alpha',
      properties: { type: 'backend', parsedAt: '2026-08-10T00:00:00.000Z' },
    };
    const caller = node(`${REPO_A}:function:caller`, 'caller', REPO_A);
    const target = node(`${REPO_A}:function:target`, 'target', REPO_A);
    const edge = calls(caller.id, target.id, 1);

    const receipt = await repository.applyChangeset(
      {
        repoId: REPO_A,
        nodesToAdd: [repositoryNode, caller, target],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgesToInsert: [edge],
      },
      {
        snapshot: {
          parsedVersion: 'parsed-v1',
          summaryVersion: null,
          embeddingsVersion: null,
          commitSha: 'abc123',
          totalNodeCount: 3,
          totalEdgeCount: 1,
          mode: GraphApplyMode.Full,
          executionToken: 'execution-1',
        },
      },
    );

    expect(receipt).toMatchObject({ nodesAdded: 3, edgesInserted: 1, totalNodeCount: 3, totalEdgeCount: 1 });
    expect(await repository.getAppliedGraphSnapshot(REPO_A)).toMatchObject({
      parsedVersion: 'parsed-v1',
      nodeCount: 3,
      edgeCount: 1,
      receipt,
    });

    await repository.pushEdges([{ ...edge, id: 'replacement', confidence: 0.75, createdBy: 'ai' }]);
    const direct = await repository.getDirectCallers(target.id, [REPO_A]);
    expect(direct.map((result) => result.id)).toEqual([caller.id]);
  });

  it('deletes incident preserved edges when their endpoint node is deleted', async () => {
    const { repository } = await openRepository();
    const source = graphNode(`${REPO_A}:external_call:source`, NodeType.ExternalCall, 'source', REPO_A);
    const target = graphNode(`${REPO_B}:entrypoint:target`, NodeType.Entrypoint, 'target', REPO_B);
    await repository.pushNodes([source, target]);
    await repository.pushEdges([relationship('resolved', source.id, target.id, EdgeType.ResolvesTo)]);

    await expect(
      repository.applyChangeset({
        repoId: REPO_A,
        nodesToAdd: [],
        nodesToUpdate: [],
        nodeIdsToDelete: [source.id],
        edgeNodeIdsToWipe: [],
        edgeTypesToPreserve: [EdgeType.ResolvesTo],
        edgesToInsert: [],
      }),
    ).resolves.toMatchObject({ nodesDeleted: 1, edgesDeleted: 1 });
    expect(await repository.getNodeWithProperties(source.id, [])).toBeNull();
    expect(await repository.getResolvesEdge(source.id)).toBeNull();
  });

  it('mirrors direct-caller fallback and production call-site metadata', async () => {
    const { repository } = await openRepository();
    const target = graphNode(`${REPO_A}:variable:target`, NodeType.Variable, 'target', REPO_A);
    const invoked = node(`${REPO_A}:function:invoked`, 'invoked', REPO_A);
    const referenced = node(`${REPO_A}:function:referenced`, 'referenced', REPO_A);
    await repository.pushNodes([target, invoked, referenced]);
    await repository.pushEdges([
      relationship('call', invoked.id, target.id, EdgeType.Calls, { line: 21, isAsync: true }),
      relationship('same-caller-reference', invoked.id, target.id, EdgeType.ReferencesVariable, { line: 22 }),
      relationship('reference', referenced.id, target.id, EdgeType.ReferencesVariable, { line: 23 }),
    ]);

    const callers = await repository.getDirectCallers(target.id, [REPO_A]);
    expect(callers.map((caller) => caller.id)).toEqual([invoked.id, referenced.id]);
    expect(callers[0]).toMatchObject({ callSiteLine: 21, isAsyncCall: true });
    expect(callers[1]).toMatchObject({ callSiteLine: 23 });
  });
});

/**
 * Read-only Cypher (`run_cypher_query` MCP tool substrate). Every case runs
 * against a real `.lbdb` fixture opened through a read-only driver — the
 * boundary the implementation asserts.
 */
class TimeoutSpyDriver extends LadybugDriver {
  readonly timeouts: number[] = [];

  protected override createConnection(database: Database): Connection {
    const connection = super.createConnection(database);
    const original = connection.setQueryTimeout.bind(connection);
    (connection as { setQueryTimeout: (timeoutInMs: number) => void }).setQueryTimeout = (
      timeoutInMs: number,
    ): void => {
      this.timeouts.push(timeoutInMs);
      original(timeoutInMs);
    };
    return connection;
  }
}

async function openCypherFixture(
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
): Promise<{ driver: TimeoutSpyDriver; repository: LadybugRepository; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'coredoc-ladybug-cypher-'));
  const databasePath = join(directory, 'graph.db');
  const writer = new LadybugDriver(databasePath, { readOnly: false });
  await writer.initialize();
  const writerRepository = new LadybugRepository(writer);
  if (nodes.length > 0) await writerRepository.pushNodes(nodes);
  if (edges.length > 0) await writerRepository.pushEdges(edges);
  await writer.checkpoint();
  await writer.close();

  const driver = new TimeoutSpyDriver(databasePath, { readOnly: true });
  await driver.initialize();
  cleanups.push(async () => {
    await driver.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { driver, repository: new LadybugRepository(driver), path: databasePath };
}

describe('LadybugRepository read-only Cypher', () => {
  // Fixture contents are declared here, not derived from another Cypher call:
  // three functions and one class in REPO_A, one function in REPO_B.
  const FIXTURE_NODES: GraphNode[] = [
    graphNode(`${REPO_A}:function:alpha`, NodeType.Function, 'alpha', REPO_A),
    graphNode(`${REPO_A}:function:beta`, NodeType.Function, 'beta', REPO_A),
    graphNode(`${REPO_A}:class:Gamma`, NodeType.Class, 'Gamma', REPO_A),
    graphNode(`${REPO_B}:function:delta`, NodeType.Function, 'delta', REPO_B),
  ];

  it('returns per-kind aggregate rows with JSON-safe scalar cells (S1)', async () => {
    const { repository } = await openCypherFixture(FIXTURE_NODES);

    const result = await repository.runReadOnlyCypherRows(
      'MATCH (n:GraphNode) RETURN n.type AS kind, count(*) AS c ORDER BY c DESC',
      { limit: 10 },
    );

    expect(result.columns).toEqual(['kind', 'c']);
    // Fixture declares 3 functions (alpha, beta, delta) and 1 class (Gamma).
    expect(result.rows).toEqual([
      ['function', 3],
      ['class', 1],
    ]);
    for (const row of result.rows) expect(typeof row[1]).toBe('number');
    expect(result.truncated).toBe(false);
  });

  it('binds params through the prepared-statement path', async () => {
    const { repository } = await openCypherFixture(FIXTURE_NODES);

    const result = await repository.runReadOnlyCypherRows(
      'MATCH (n:GraphNode) WHERE n.type = $t RETURN count(n) AS c',
      { limit: 10, params: { t: 'function' } },
    );

    expect(result.rows).toEqual([[3]]);
  });

  it('refuses to run Cypher through a writable handle before touching the engine', async () => {
    const { driver, repository } = await openRepository();
    const timed = vi.spyOn(driver, 'runTimedReadQuery');

    await expect(
      repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN n.id AS id', { limit: 5 }),
    ).rejects.toThrow(/read-only Ladybug handle/i);
    await expect(repository.runReadOnlyCypher('MATCH (n:GraphNode) RETURN n', { limit: 5 })).rejects.toThrow(
      /read-only Ladybug handle/i,
    );
    expect(timed).not.toHaveBeenCalled();
  });

  it('rejects a mutating statement through the allowlist before touching the engine', async () => {
    const { driver, repository } = await openCypherFixture(FIXTURE_NODES);
    const timed = vi.spyOn(driver, 'runTimedReadQuery');

    await expect(repository.runReadOnlyCypherRows('MATCH (n:GraphNode) DELETE n', { limit: 5 })).rejects.toThrow(
      /read-only/i,
    );
    expect(timed).not.toHaveBeenCalled();
  });

  it('lets the read-only engine reject a write when the guard is bypassed (S4)', async () => {
    const { driver } = await openCypherFixture(FIXTURE_NODES);

    await expect(
      driver.runTimedReadQuery(
        `CREATE (n:GraphNode {id: 'bypass', type: 'function', name: 'bypass'})`,
        {},
        5_000,
        async () => undefined,
      ),
    ).rejects.toThrow(/read-only/i);
  });

  it('caps rows at the limit and consumes at most limit + 1 rows (S6)', async () => {
    const { driver, repository } = await openCypherFixture(FIXTURE_NODES);
    let pulled = 0;
    const original = driver.runTimedReadQuery.bind(driver);
    vi.spyOn(driver, 'runTimedReadQuery').mockImplementation((query, params, timeoutMs, consume) =>
      original(query, params, timeoutMs, async (columns, rows) => {
        async function* counted(): AsyncGenerator<Record<string, unknown>> {
          for await (const row of rows) {
            pulled += 1;
            yield row;
          }
        }
        return consume(columns, counted());
      }),
    );

    const result = await repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN n.id AS id ORDER BY n.id', {
      limit: 2,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(pulled).toBeLessThanOrEqual(3);
  });

  it('rejects a composite cell with projection guidance (S10)', async () => {
    const { repository } = await openCypherFixture(FIXTURE_NODES);

    await expect(
      repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN collect(n.name) AS names', { limit: 10 }),
    ).rejects.toThrow(
      'Cypher rows shape supports scalar cells only; project scalar fields (e.g. RETURN n.name) or use resultShape "graph"',
    );
  });

  it('projects nodes and relationships into a viz subgraph with numeric line numbers', async () => {
    const { repository } = await openCypherFixture(FIXTURE_NODES, [
      relationship('call-alpha-beta', `${REPO_A}:function:alpha`, `${REPO_A}:function:beta`, EdgeType.Calls),
    ]);

    const result = await repository.runReadOnlyCypher(
      'MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) RETURN a, r, b, a AS again',
      { limit: 10 },
    );

    expect(result.nodes.map((node) => node.id).sort()).toEqual([`${REPO_A}:function:alpha`, `${REPO_A}:function:beta`]);
    for (const node of result.nodes) expect(typeof node.startLine).toBe('number');
    expect(result.edges).toEqual([
      expect.objectContaining({
        id: 'call-alpha-beta',
        sourceId: `${REPO_A}:function:alpha`,
        targetId: `${REPO_A}:function:beta`,
        type: EdgeType.Calls,
      }),
    ]);
    expect(result.truncated).toBe(false);
  });

  it('caps the graph shape at the limit', async () => {
    const { repository } = await openCypherFixture(FIXTURE_NODES, [
      relationship('call-alpha-beta', `${REPO_A}:function:alpha`, `${REPO_A}:function:beta`, EdgeType.Calls),
    ]);

    const result = await repository.runReadOnlyCypher('MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) RETURN a, r, b', {
      limit: 1,
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // The dropped endpoint takes the edge with it.
    expect(result.edges).toEqual([]);
  });

  it('caps edges at the limit once both endpoints are returned', async () => {
    const alpha = `${REPO_A}:function:alpha`;
    const beta = `${REPO_A}:function:beta`;
    const { repository } = await openCypherFixture(FIXTURE_NODES, [
      relationship('call-alpha-beta', alpha, beta, EdgeType.Calls),
      relationship('imports-alpha-beta', alpha, beta, EdgeType.Imports),
      relationship('uses-type-alpha-beta', alpha, beta, EdgeType.UsesType),
    ]);

    const result = await repository.runReadOnlyCypher('MATCH (a:GraphNode)-[r]->(b:GraphNode) RETURN a, r, b', {
      limit: 2,
    });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('sets and resets the 5000 ms query timeout around the Cypher call only', async () => {
    const { driver, repository } = await openCypherFixture(FIXTURE_NODES);
    driver.timeouts.length = 0;

    await repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN n.id AS id', { limit: 10 });

    expect(driver.timeouts).toEqual([5_000, LADYBUG_NO_QUERY_TIMEOUT_MS]);

    await repository.findCode({ pattern: 'alpha' }, [REPO_A]);

    expect(driver.timeouts).toEqual([5_000, LADYBUG_NO_QUERY_TIMEOUT_MS]);
  });

  it('rejects a source-bearing projection at the query gate before execution, serving source off (S11)', async () => {
    const sourceBearing = graphNode(`${REPO_A}:function:sourced`, NodeType.Function, 'sourced', REPO_A, {
      kind: 'function',
      sourceCode: 'export function sourced(): number { return 42; }',
    });
    const { driver, repository } = await openCypherFixture([...FIXTURE_NODES, sourceBearing]);
    const timed = vi.spyOn(driver, 'runTimedReadQuery');

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', '');
    // A direct `properties`/`sourceCode` projection is rejected by the query
    // gate, BEFORE the engine runs — not scrubbed out of the result after.
    await expect(
      repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN n.properties AS properties', { limit: 10 }),
    ).rejects.toThrow(/source/i);
    await expect(
      repository.runReadOnlyCypher('MATCH (n:GraphNode) RETURN n.sourceCode AS s', { limit: 10 }),
    ).rejects.toThrow(/source/i);
    // The in-engine bypass — mining sourceCode out of the JSON blob with
    // `regexp_extract` — never emits a field an output scan recognises, yet the
    // query gate still catches it because it references `properties`.
    await expect(
      repository.runReadOnlyCypherRows(
        `MATCH (n:GraphNode) RETURN regexp_extract(n.properties, 'sourceCode":"([^"]*)', 1) AS s`,
        { limit: 10 },
      ),
    ).rejects.toThrow(/source/i);
    // Rejected before touching the engine, so the timed read never ran.
    expect(timed).not.toHaveBeenCalled();

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    // With the flag on, the same queries pass and return normally.
    await expect(
      repository.runReadOnlyCypherRows('MATCH (n:GraphNode) RETURN n.properties AS properties', { limit: 10 }),
    ).resolves.toMatchObject({ truncated: false });
    await expect(
      repository.runReadOnlyCypherRows(
        `MATCH (n:GraphNode) RETURN regexp_extract(n.properties, 'sourceCode":"([^"]*)', 1) AS s`,
        { limit: 10 },
      ),
    ).resolves.toMatchObject({ truncated: false });
    vi.unstubAllEnvs();
  });

  // The relationship-properties allowance was rebindable: `WITH a AS r` aliased a
  // NODE onto the name the relationship pattern proved, and `r.properties` / `r.*`
  // then returned the node blob — sourceCode included — with serving off. Both
  // shapes were reproduced against this same real Ladybug fixture.
  it('rejects a node aliased onto a trusted relationship name, serving source off (S11b)', async () => {
    const sourceBearing = graphNode(`${REPO_A}:function:sourced`, NodeType.Function, 'sourced', REPO_A, {
      kind: 'function',
      sourceCode: 'export function sourced(): number { return 42; }',
    });
    const { driver, repository } = await openCypherFixture(
      [...FIXTURE_NODES, sourceBearing],
      [relationship('call-sourced-alpha', sourceBearing.id, `${REPO_A}:function:alpha`, EdgeType.Calls)],
    );
    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', '');
    const timed = vi.spyOn(driver, 'runTimedReadQuery');

    await expect(
      repository.runReadOnlyCypherRows(
        'MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) WITH a AS r RETURN r.properties AS p',
        { limit: 10 },
      ),
    ).rejects.toThrow(/source/i);
    await expect(
      repository.runReadOnlyCypherRows('MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) WITH a AS r RETURN r.*', {
        limit: 10,
      }),
    ).rejects.toThrow(/source/i);
    expect(timed).not.toHaveBeenCalled();

    // The legitimate edge-metadata projection still executes against the engine.
    const edgeMetadata = await repository.runReadOnlyCypherRows(
      'MATCH (a:GraphNode)-[r:CALLS]->(b:GraphNode) RETURN r.properties AS p',
      { limit: 10 },
    );
    expect(edgeMetadata.columns).toEqual(['p']);
    expect(edgeMetadata.rows).toHaveLength(1);
    expect(String(edgeMetadata.rows[0]?.[0] ?? '')).not.toContain('sourceCode');
    vi.unstubAllEnvs();
  });

  it('bounds the graph-shape rels accumulator at the limit instead of materializing every relationship (M1)', async () => {
    // A hub with far more outgoing edges than the limit.
    const hub = graphNode(`${REPO_A}:function:hub`, NodeType.Function, 'hub', REPO_A);
    const spokes = Array.from({ length: 8 }, (_, index) =>
      graphNode(`${REPO_A}:function:spoke-${index}`, NodeType.Function, `spoke-${index}`, REPO_A),
    );
    const edges = spokes.map((spoke, index) => relationship(`edge-${index}`, hub.id, spoke.id, EdgeType.Calls));
    const { repository } = await openCypherFixture([hub, ...spokes], edges);

    // `RETURN r` projects relationships only, so the endpoint-drop leaves zero
    // edges — but the rels accumulator must still be capped, which `truncated`
    // proves (unbounded pre-cap materialization would leave it false).
    const result = await repository.runReadOnlyCypher('MATCH ()-[r]->() RETURN r', { limit: 2 });

    expect(result.edges.length).toBeLessThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it('stops pulling graph-shape rows once both the node and edge caps are reached (M1)', async () => {
    const alpha = `${REPO_A}:function:alpha`;
    const beta = `${REPO_A}:function:beta`;
    // Four relationships between the same two nodes: every row after the second
    // can only add truncated content, so the consumer must break — not drain.
    const edges = [
      relationship('call-alpha-beta', alpha, beta, EdgeType.Calls),
      relationship('imports-alpha-beta', alpha, beta, EdgeType.Imports),
      relationship('uses-type-alpha-beta', alpha, beta, EdgeType.UsesType),
      relationship('references-alpha-beta', alpha, beta, EdgeType.ReferencesVariable),
    ];
    const { driver, repository } = await openCypherFixture(FIXTURE_NODES, edges);

    let pulled = 0;
    const original = driver.runTimedReadQuery.bind(driver);
    vi.spyOn(driver, 'runTimedReadQuery').mockImplementation((query, params, timeoutMs, consume) =>
      original(query, params, timeoutMs, async (columns, rows) => {
        async function* counted(): AsyncGenerator<Record<string, unknown>> {
          for await (const row of rows) {
            pulled += 1;
            yield row;
          }
        }
        return consume(columns, counted());
      }),
    );

    const result = await repository.runReadOnlyCypher('MATCH (a:GraphNode)-[r]->(b:GraphNode) RETURN a, r, b', {
      limit: 2,
    });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // Both caps reached after the second row: the 4-row set is NOT fully drained.
    expect(pulled).toBeLessThanOrEqual(3);
    expect(pulled).toBeLessThan(edges.length);
  });
});
