import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteDriver } from './driver.js';
import { buildRepoFilter, SqliteRepository } from './repository.js';
import { EdgeType, GraphApplyMode, NodeType, type IDatabaseDriver, type TransactionStatement } from '../types.js';

let tmp: string;
let driver: SqliteDriver;
let repo: SqliteRepository;

const REPO_HASH = 'abc123def456';

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sqlite-repo-'));
  driver = new SqliteDriver(`file:${join(tmp, 'test.db')}`);
  await driver.initialize();
  repo = new SqliteRepository(driver);
});

afterEach(async () => {
  await driver.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Insert one node row with a fully-qualified ID. Repository filters by the
// indexed `repo_id` column, so we derive it from the node id prefix (the
// segment before the first `:`) — matching what `pushNodes` writes from
// `GraphNode.repoId` in production. The default REPO_HASH is used when no
// `repoId` arg is given.
async function insertNode(args: {
  id: string;
  type: string;
  name: string;
  filePath: string;
  properties?: Record<string, unknown>;
  startLine?: number;
  endLine?: number;
  repoId?: string;
  summary?: string;
  /** Stored as JSON.stringify(number[]) — same encoding pushNodes writes. */
  embedding?: number[];
}): Promise<void> {
  const repoId = args.repoId ?? args.id.split(':', 1)[0] ?? null;
  await driver.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO nodes (id, type, name, file_path, start_line, end_line, properties, repo_id, summary, embedding)
       VALUES (@id, @type, @name, @filePath, @startLine, @endLine, @properties, @repoId, @summary, @embedding)`,
      {
        id: args.id,
        type: args.type,
        name: args.name,
        filePath: args.filePath,
        startLine: args.startLine ?? 1,
        endLine: args.endLine ?? null,
        properties: JSON.stringify(args.properties ?? {}),
        repoId,
        summary: args.summary ?? null,
        embedding: args.embedding ? JSON.stringify(args.embedding) : null,
      },
    );
  });
}

async function insertEdge(args: {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  properties?: Record<string, unknown>;
  /** Defaults to 1.0 (parser-grade) when omitted, matching the column default. */
  confidence?: number;
  /** Defaults to 'parser' when omitted, matching the column default. */
  createdBy?: 'parser' | 'ai' | 'human';
}): Promise<void> {
  await driver.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO edges (id, type, source_id, target_id, properties, confidence, created_by)
       VALUES (@id, @type, @sourceId, @targetId, @properties, @confidence, @createdBy)`,
      {
        id: args.id,
        type: args.type,
        sourceId: args.sourceId,
        targetId: args.targetId,
        properties: JSON.stringify(args.properties ?? {}),
        confidence: args.confidence ?? 1.0,
        createdBy: args.createdBy ?? 'parser',
      },
    );
  });
}

function strictReadDriver(queries: Array<{ sql: string; params: Record<string, unknown> }>): IDatabaseDriver {
  return {
    backend: 'sqlite',
    initialize: async () => undefined,
    close: async () => undefined,
    withReadTransaction: async (fn) =>
      fn({
        run: async <T>(sql: string, params: Record<string, unknown> = {}) => {
          const placeholders = new Set(Array.from(sql.matchAll(/@(\w+)/g), (m) => m[1]));
          expect(Object.keys(params).sort()).toEqual(Array.from(placeholders).sort());
          queries.push({ sql, params });
          return [] as T[];
        },
      }),
    withWriteTransaction: async () => {
      throw new Error('write transaction not expected');
    },
    executeBatch: async () => {
      throw new Error('batch execution not expected');
    },
  };
}

function strictWriteDriver(queries: Array<{ sql: string; params: Record<string, unknown> }>): IDatabaseDriver {
  return {
    backend: 'sqlite',
    initialize: async () => undefined,
    close: async () => undefined,
    withReadTransaction: async () => {
      throw new Error('read transaction not expected');
    },
    withWriteTransaction: async (fn) =>
      fn({
        run: async <T>(sql: string, params: Record<string, unknown> = {}) => {
          const placeholders = new Set(Array.from(sql.matchAll(/@(\w+)/g), (match) => match[1]));
          expect(Object.keys(params).sort()).toEqual(Array.from(placeholders).sort());
          queries.push({ sql, params });
          return [] as T[];
        },
      }),
    executeBatch: async () => {
      throw new Error('batch execution not expected');
    },
  };
}

function batchWriteDriver(batches: TransactionStatement[][]): IDatabaseDriver {
  return {
    backend: 'sqlite',
    initialize: async () => undefined,
    close: async () => undefined,
    withReadTransaction: async () => {
      throw new Error('read transaction not expected');
    },
    withWriteTransaction: async (fn) =>
      fn({
        run: async () => {
          throw new Error('individual statement execution not expected');
        },
        runBatch: async (statements) => {
          batches.push(statements);
        },
      }),
    executeBatch: async () => {
      throw new Error('batch execution not expected');
    },
  };
}

describe('SqliteRepository.applyChangeset snapshot ownership', () => {
  it('writes each node and edge batch with one multi-row SQL statement', async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const strictRepo = new SqliteRepository(strictWriteDriver(queries));
    const firstNodeId = `${REPO_HASH}:function:src/a.ts:first`;
    const secondNodeId = `${REPO_HASH}:function:src/a.ts:second`;

    const result = await strictRepo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [
        {
          id: firstNodeId,
          type: NodeType.Function,
          name: 'first',
          repoId: REPO_HASH,
          filePath: 'src/a.ts',
          properties: {},
        },
      ],
      nodesToUpdate: [
        {
          id: secondNodeId,
          type: NodeType.Function,
          name: 'second',
          repoId: REPO_HASH,
          filePath: 'src/a.ts',
          properties: {},
        },
      ],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'first-call',
          sourceId: firstNodeId,
          targetId: secondNodeId,
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: {},
        },
        {
          id: 'second-call',
          sourceId: secondNodeId,
          targetId: firstNodeId,
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: {},
        },
      ],
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain('INSERT INTO nodes');
    expect(queries[0]!.sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(queries[0]!.params).toMatchObject({ id_0: firstNodeId, id_1: secondNodeId });
    expect(Object.keys(queries[0]!.params)).toHaveLength(20);
    expect(queries[1]!.sql).toContain('INSERT INTO edges');
    expect(queries[1]!.sql).toContain('ON CONFLICT(source_id, target_id, type) DO UPDATE');
    expect(queries[1]!.params).toMatchObject({ id_0: 'first-call', id_1: 'second-call' });
    expect(Object.keys(queries[1]!.params)).toHaveLength(14);
    expect(result).toEqual({
      nodesAdded: 1,
      nodesUpdated: 1,
      nodesDeleted: 0,
      edgesDeleted: 0,
      edgesInserted: 2,
    });
  });

  it('reduces 1,300 row writes to three bounded transport calls', async () => {
    const batches: TransactionStatement[][] = [];
    const strictRepo = new SqliteRepository(batchWriteDriver(batches));
    const nodes = Array.from({ length: 1300 }, (_, index) => ({
      id: `${REPO_HASH}:function:${index}`,
      type: NodeType.Function,
      name: `fn${index}`,
      repoId: REPO_HASH,
      filePath: `src/${index}.ts`,
      properties: {},
    }));

    await strictRepo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: nodes,
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    // 1,300 rows → 26 statements of 50 rows, shipped 10 statements per
    // transport call (the Turso-safe cap — see STATEMENTS_PER_TRANSPORT_BATCH).
    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 6]);
    expect(batches.flat()).toHaveLength(26);
  });

  it('splits large rows so every transport batch remains below two MiB', async () => {
    const batches: TransactionStatement[][] = [];
    const strictRepo = new SqliteRepository(batchWriteDriver(batches));
    const nodes = Array.from({ length: 50 }, (_, index) => ({
      id: `${REPO_HASH}:function:large-${index}`,
      type: NodeType.Function,
      name: `large${index}`,
      repoId: REPO_HASH,
      filePath: `src/large-${index}.ts`,
      properties: { payload: 'x'.repeat(70_000) },
    }));

    await strictRepo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: nodes,
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const serializedParamsBytes = batch.reduce(
        (total, statement) => total + Buffer.byteLength(JSON.stringify(statement.params), 'utf8'),
        0,
      );
      expect(serializedParamsBytes).toBeLessThan(2 * 1024 * 1024);
    }
  });

  it('replaces parser edges while preserving an existing RESOLVES_TO edge', async () => {
    const externalCallId = `${REPO_HASH}:external_call:src/a.ts:request`;
    const localTargetId = `${REPO_HASH}:function:src/a.ts:target`;
    const siblingTargetId = `sibling123456:entrypoint:src/api.ts:getUser`;
    await insertNode({ id: externalCallId, type: 'external_call', name: 'request', filePath: 'src/a.ts' });
    await insertNode({ id: localTargetId, type: 'function', name: 'target', filePath: 'src/a.ts' });
    await insertNode({
      id: siblingTargetId,
      type: 'entrypoint',
      name: 'GET /users',
      filePath: 'src/api.ts',
      repoId: 'sibling123456',
    });
    await insertEdge({
      id: 'old-call',
      type: EdgeType.Calls,
      sourceId: externalCallId,
      targetId: localTargetId,
    });
    await insertEdge({
      id: 'resolved-link',
      type: EdgeType.ResolvesTo,
      sourceId: externalCallId,
      targetId: siblingTargetId,
      createdBy: 'ai',
    });

    const result = await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [externalCallId, localTargetId],
      edgeTypesToPreserve: [EdgeType.ResolvesTo],
      edgesToInsert: [
        {
          id: 'new-call',
          sourceId: externalCallId,
          targetId: localTargetId,
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: {},
        },
      ],
    });

    const edges = await driver.withReadTransaction((tx) =>
      tx.run<{ id: string; type: string }>('SELECT id, type FROM edges ORDER BY id'),
    );
    expect(edges).toEqual([
      { id: 'new-call', type: EdgeType.Calls },
      { id: 'resolved-link', type: EdgeType.ResolvesTo },
    ]);
    expect(result.edgesDeleted).toBe(1);
  });

  it('deletes only exact repo identities during an atomic whole-repo replacement', async () => {
    const siblingRepo = 'sibling123456';
    await insertNode({ id: REPO_HASH, type: 'repository', name: 'duplicate-name', filePath: '' });
    await insertNode({ id: `${REPO_HASH}:function:old`, type: 'function', name: 'old', filePath: 'old.ts' });
    await insertNode({
      id: siblingRepo,
      type: 'repository',
      name: 'duplicate-name',
      filePath: '',
      repoId: siblingRepo,
    });
    await insertNode({
      id: `${siblingRepo}:function:keep`,
      type: 'function',
      name: 'keep',
      filePath: 'keep.ts',
      repoId: siblingRepo,
    });
    await insertEdge({
      id: 'cross-edge',
      type: EdgeType.Calls,
      sourceId: `${REPO_HASH}:function:old`,
      targetId: `${siblingRepo}:function:keep`,
    });

    // Seed an unresolved call site owned by REPO_HASH — the repo-wipe branch
    // below must clear it too, not just nodes/edges/graph_meta.
    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      unresolvedCalls: [
        {
          callerId: `${REPO_HASH}:function:old`,
          calleeExpression: 'dispatch(kind)',
          calleeNameTail: 'dispatch',
          filePath: 'old.ts',
          line: 3,
        },
      ],
    });

    const result = await repo.applyChangeset({
      repoId: REPO_HASH,
      repoIdsToDelete: [REPO_HASH],
      nodesToAdd: [
        { id: REPO_HASH, type: NodeType.Repository, name: 'duplicate-name', properties: {} },
        {
          id: `${REPO_HASH}:function:new`,
          type: NodeType.Function,
          name: 'new',
          repoId: REPO_HASH,
          filePath: 'new.ts',
          properties: {},
        },
      ],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    const nodes = await driver.withReadTransaction((tx) => tx.run<{ id: string }>('SELECT id FROM nodes ORDER BY id'));
    expect(nodes.map((node) => node.id)).toEqual([
      REPO_HASH,
      `${REPO_HASH}:function:new`,
      siblingRepo,
      `${siblingRepo}:function:keep`,
    ]);
    expect(result.nodesDeleted).toBe(2);
    expect(result.edgesDeleted).toBe(1);
    // The repo-wipe branch (repoIdsToDelete) must remove unresolved_calls
    // rows too, not just nodes/edges/graph_meta.
    expect(await repo.findUnresolvedCallsByNameTail('dispatch', [REPO_HASH])).toEqual([]);
  });

  it('commits and removes the graph snapshot with repository ownership', async () => {
    await insertNode({ id: REPO_HASH, type: 'repository', name: 'snapshot-repo', filePath: '' });
    const executionToken = '11111111-1111-4111-8111-111111111111';
    await repo.applyChangeset(
      {
        repoId: REPO_HASH,
        nodesToAdd: [],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgesToInsert: [],
        unresolvedCalls: [
          {
            callerId: `${REPO_HASH}:function:old`,
            calleeExpression: 'dispatch(kind)',
            calleeNameTail: 'dispatch',
            filePath: 'old.ts',
            line: 3,
          },
        ],
      },
      {
        snapshot: {
          parsedVersion: 'parsed-v1',
          summaryVersion: null,
          embeddingsVersion: null,
          commitSha: 'abc123',
          totalNodeCount: 1,
          totalEdgeCount: 0,
          mode: GraphApplyMode.Metadata,
          executionToken,
        },
      },
    );

    expect(await repo.getAppliedGraphSnapshot(REPO_HASH)).toMatchObject({
      parsedVersion: 'parsed-v1',
      executionToken,
      nodeCount: 1,
      edgeCount: 0,
      receipt: { nodesAdded: 0, nodesUpdated: 0 },
    });
    expect(await repo.findUnresolvedCallsByNameTail('dispatch', [REPO_HASH])).toHaveLength(1);
    await repo.deleteRepository(REPO_HASH);
    expect(await repo.getAppliedGraphSnapshot(REPO_HASH)).toBeNull();
    // deleteRepository must remove unresolved_calls rows too, not just nodes/edges/graph_meta.
    expect(await repo.findUnresolvedCallsByNameTail('dispatch', [REPO_HASH])).toEqual([]);
  });

  it('preserves the existing edge id when relationship identity conflicts', async () => {
    const sourceId = `${REPO_HASH}:function:source`;
    const targetId = `${REPO_HASH}:function:target`;
    await insertNode({ id: sourceId, type: 'function', name: 'source', filePath: 'source.ts' });
    await insertNode({ id: targetId, type: 'function', name: 'target', filePath: 'target.ts' });
    await insertEdge({ id: 'existing-id', type: EdgeType.Calls, sourceId, targetId, confidence: 0.4 });

    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'incoming-different-id',
          sourceId,
          targetId,
          type: EdgeType.Calls,
          confidence: 0.9,
          createdBy: 'ai',
          properties: { reason: 'reclassified' },
        },
      ],
    });

    const rows = await driver.withReadTransaction((tx) =>
      tx.run<{ id: string; confidence: number; created_by: string }>(
        'SELECT id, confidence, created_by FROM edges WHERE source_id = @sourceId',
        { sourceId },
      ),
    );
    expect(rows).toEqual([{ id: 'existing-id', confidence: 0.9, created_by: 'ai' }]);
  });

  it('node UPSERT preserves row identity and removes the old FTS name', async () => {
    const id = `${REPO_HASH}:function:rename`;
    await insertNode({ id, type: 'function', name: 'LegacyUniqueName', filePath: 'rename.ts' });
    const before = await driver.withReadTransaction((tx) =>
      tx.run<{ rowid: number }>('SELECT rowid FROM nodes WHERE id = @id', { id }),
    );

    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      nodesToUpdate: [
        {
          id,
          type: NodeType.Function,
          name: 'ModernUniqueName',
          repoId: REPO_HASH,
          filePath: 'rename.ts',
          properties: {},
        },
      ],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    const after = await driver.withReadTransaction((tx) =>
      tx.run<{ rowid: number }>('SELECT rowid FROM nodes WHERE id = @id', { id }),
    );
    expect(after[0]!.rowid).toBe(before[0]!.rowid);
    expect(await repo.findCode({ pattern: '*LegacyUnique*' }, [REPO_HASH])).toEqual([]);
    expect((await repo.findCode({ pattern: '*ModernUnique*' }, [REPO_HASH])).map((node) => node.id)).toEqual([id]);
  });

  it('keeps the completed graph chunk but not the snapshot when aborted between transport batches', async () => {
    await insertNode({ id: REPO_HASH, type: 'repository', name: 'abort-repo', filePath: '' });
    const controller = new AbortController();
    const nodes = Array.from({ length: 1300 }, (_, index) => ({
      id: `${REPO_HASH}:function:${index}`,
      type: NodeType.Function,
      name: `fn${index}`,
      repoId: REPO_HASH,
      filePath: `src/${index}.ts`,
      properties: {},
    }));

    await expect(
      repo.applyChangeset(
        {
          repoId: REPO_HASH,
          nodesToAdd: nodes,
          nodesToUpdate: [],
          nodeIdsToDelete: [],
          edgeNodeIdsToWipe: [],
          edgesToInsert: [],
        },
        {
          signal: controller.signal,
          onBatch: () => controller.abort(new Error('lease lost')),
          snapshot: {
            parsedVersion: 'never-committed',
            summaryVersion: null,
            embeddingsVersion: null,
            commitSha: null,
            totalNodeCount: 1301,
            totalEdgeCount: 0,
            mode: GraphApplyMode.Incremental,
            executionToken: '22222222-2222-4222-8222-222222222222',
          },
        },
      ),
    ).rejects.toThrow();

    const count = await driver.withReadTransaction((tx) =>
      tx.run<{ count: number }>('SELECT count(*) AS count FROM nodes WHERE repo_id = @repoId', { repoId: REPO_HASH }),
    );
    expect(count[0]!.count).toBe(501);
    expect(await repo.getAppliedGraphSnapshot(REPO_HASH)).toBeNull();
  });
});

describe('SqliteRepository.listEntrypoints query contract', () => {
  it('does not pass the HTTP type parameter to the synthetic-route query', async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const strictRepo = new SqliteRepository(strictReadDriver(queries));

    await strictRepo.listEntrypoints({ type: 'http' }, [REPO_HASH]);

    expect(queries).toHaveLength(2);
    expect(queries[0]!.params).toEqual({ type: 'http' });
    expect(queries[1]!.params).toEqual({});
  });

  it('does not cap path candidates before parameter-aware refinement', async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const strictRepo = new SqliteRepository(strictReadDriver(queries));

    await strictRepo.listEntrypoints({ pathPattern: '/api/users/{id}', limit: 20 }, [REPO_HASH]);

    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.sql).not.toContain('LIMIT @limit');
      expect(query.params).toEqual({ pathPattern: '%users%' });
    }
  });

  it('anchors the path prefilter on the stored address keys, not the whole properties blob', async () => {
    const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const strictRepo = new SqliteRepository(strictReadDriver(queries));

    await strictRepo.listEntrypoints({ pathPattern: '/api/users/{id}' }, [REPO_HASH]);

    const entrypointSql = queries[0]!.sql;
    // A blob-wide `n.properties LIKE` matches any property — handler name, documentation prose —
    // so a short anchor selects nearly every row and the prefilter narrows nothing.
    expect(entrypointSql).not.toContain('n.properties LIKE');
    // Every address a non-HTTP entrypoint can be reached by must still be anchored: the multi-
    // address intent is why the blob filter was introduced in the first place.
    for (const key of [
      'fullPath',
      'path',
      'fieldName',
      'messagingDestination',
      'messagingDestinationRef',
      'topicValue',
      'topic',
      'eventValue',
      'eventName',
      'command',
      'schedule',
    ]) {
      expect(entrypointSql).toContain(`json_extract(n.properties, '$.${key}') LIKE @pathPattern`);
    }
    // API-level field names are derived on the way out and never stored; anchoring on them
    // matched nothing and dropped every queue/event row.
    expect(entrypointSql).not.toContain("'$.destinationValue'");
    expect(entrypointSql).not.toContain("'$.destination'");
  });

  it('filters messaging systems in SQL and reserves unknown for systemless rows', async () => {
    const exactQueries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    await new SqliteRepository(strictReadDriver(exactQueries)).listEntrypoints(
      { type: 'queue', system: ' GCP-PUBSUB ' },
      [REPO_HASH],
    );
    expect(exactQueries).toHaveLength(1);
    expect(exactQueries[0]!.sql).toContain('LOWER(TRIM(COALESCE');
    expect(exactQueries[0]!.params).toMatchObject({ type: 'queue', system: 'gcp-pubsub' });

    const unknownQueries: Array<{ sql: string; params: Record<string, unknown> }> = [];
    await new SqliteRepository(strictReadDriver(unknownQueries)).listEntrypoints({ system: ' UNKNOWN ' }, [REPO_HASH]);
    expect(unknownQueries[0]!.sql).toContain("entrypointType') IN ('queue', 'event')");
    expect(unknownQueries[0]!.sql).toMatch(/json_extract\(n\.properties, '\$\.emitter'\),\s*''\s*\)\) = ''/);
    expect(unknownQueries[0]!.params).toEqual({});
  });

  it('does not report an unresolved destination token as a resolved value', async () => {
    await insertNode({
      id: `${REPO_HASH}:entrypoint:orders`,
      type: 'entrypoint',
      name: 'orders',
      filePath: 'src/consumer.ts',
      properties: {
        entrypointType: 'queue',
        messagingSystem: 'gcp-pubsub',
        messagingDestinationRef: 'Topics.ORDERS',
        messagingDestination: 'Topics.ORDERS',
      },
    });

    const [entrypoint] = await repo.listEntrypoints({ type: 'queue' }, [REPO_HASH]);

    expect(entrypoint).toMatchObject({ destination: 'Topics.ORDERS' });
    expect(entrypoint?.destinationValue).toBeUndefined();
  });
});

describe('SqliteRepository.getTypeUsages', () => {
  it('returns USES_TYPE consumers with usage kind and via', async () => {
    // Target type: a type alias
    await insertNode({
      id: `${REPO_HASH}:type_alias:src/models.ts:UserId`,
      type: 'type_alias',
      name: 'UserId',
      filePath: 'src/models.ts',
      startLine: 3,
    });
    // Consumer: a function whose parameter is typed as UserId
    await insertNode({
      id: `${REPO_HASH}:function:src/svc.ts:getUser`,
      type: 'function',
      name: 'getUser',
      filePath: 'src/svc.ts',
      startLine: 10,
      endLine: 20,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:uses-type-1`,
      type: 'USES_TYPE',
      sourceId: `${REPO_HASH}:function:src/svc.ts:getUser`,
      targetId: `${REPO_HASH}:type_alias:src/models.ts:UserId`,
      properties: { usage: 'parameter', via: 'id', ambiguous: false },
    });

    const results = await repo.getTypeUsages(`${REPO_HASH}:type_alias:src/models.ts:UserId`, [REPO_HASH]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: `${REPO_HASH}:function:src/svc.ts:getUser`,
      name: 'getUser',
      type: 'function',
      filePath: 'src/svc.ts',
      startLine: 10,
      endLine: 20,
      usage: 'parameter',
      via: 'id',
      ambiguous: false,
    });
  });

  it('returns value-position enum-member metadata alongside type-position consumers', async () => {
    const targetId = `${REPO_HASH}:enum:src/enums.ts:Status`;
    const typeConsumer = `${REPO_HASH}:function:src/describe.ts:describeStatus`;
    const valueConsumer = `${REPO_HASH}:function:src/gate.ts:isLocked`;
    await insertNode({ id: targetId, type: 'enum', name: 'Status', filePath: 'src/enums.ts' });
    await insertNode({ id: typeConsumer, type: 'function', name: 'describeStatus', filePath: 'src/describe.ts' });
    await insertNode({ id: valueConsumer, type: 'function', name: 'isLocked', filePath: 'src/gate.ts' });
    await insertEdge({
      id: `${REPO_HASH}:edge:uses-status-type`,
      type: 'USES_TYPE',
      sourceId: typeConsumer,
      targetId,
      properties: { usage: 'parameter', via: 'status', ambiguous: false },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:uses-status-value`,
      type: 'USES_TYPE',
      sourceId: valueConsumer,
      targetId,
      properties: { usage: 'member-access', useKind: 'value', member: 'Locked', ambiguous: false },
    });

    const results = await repo.getTypeUsages(targetId, [REPO_HASH]);

    const typeUsage = results.find((usage) => usage.id === typeConsumer);
    expect(typeUsage?.useKind).toBeUndefined();
    expect(typeUsage?.member).toBeUndefined();
    expect(results.find((usage) => usage.id === valueConsumer)).toMatchObject({
      usage: 'member-access',
      useKind: 'value',
      member: 'Locked',
    });
  });

  it('carries the weak-identity flag of a name-matched member reference through to the row', async () => {
    const targetId = `${REPO_HASH}:enum:src/enums.ts:Mode`;
    const weakConsumer = `${REPO_HASH}:function:src/weak.ts:isFast`;
    await insertNode({ id: targetId, type: 'enum', name: 'Mode', filePath: 'src/enums.ts' });
    await insertNode({ id: weakConsumer, type: 'function', name: 'isFast', filePath: 'src/weak.ts' });
    await insertEdge({
      id: `${REPO_HASH}:edge:uses-mode-value-weak`,
      type: 'USES_TYPE',
      sourceId: weakConsumer,
      targetId,
      properties: { usage: 'member-access', useKind: 'value', member: 'Fast', ambiguous: true },
    });

    const results = await repo.getTypeUsages(targetId, [REPO_HASH]);

    expect(results.find((usage) => usage.id === weakConsumer)).toMatchObject({
      useKind: 'value',
      member: 'Fast',
      ambiguous: true,
    });
  });

  it('returns construction and import consumers of a class', async () => {
    const targetId = `${REPO_HASH}:class:src/service.ts:UserService`;
    const constructor_ = `${REPO_HASH}:function:src/a.ts:build`;
    const importer = `${REPO_HASH}:file:src/b.ts`;
    await insertNode({ id: targetId, type: 'class', name: 'UserService', filePath: 'src/service.ts' });
    await insertNode({ id: constructor_, type: 'function', name: 'build', filePath: 'src/a.ts', startLine: 4 });
    await insertNode({ id: importer, type: 'file', name: 'src/b.ts', filePath: 'src/b.ts', startLine: 0 });
    await insertEdge({
      id: `${REPO_HASH}:edge:constructs-user-service`,
      type: 'USES_TYPE',
      sourceId: constructor_,
      targetId,
      properties: { usage: 'construction', useKind: 'value', ambiguous: false },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:imports-user-service`,
      type: 'USES_TYPE',
      sourceId: importer,
      targetId,
      properties: { usage: 'import', ambiguous: false },
    });

    const results = await repo.getTypeUsages(targetId, [REPO_HASH]);

    expect(results.find((usage) => usage.id === constructor_)).toMatchObject({
      usage: 'construction',
      useKind: 'value',
      ambiguous: false,
    });
    expect(results.find((usage) => usage.id === importer)).toMatchObject({ type: 'file', usage: 'import' });
  });

  it('normalizes a missing legacy USES_TYPE usage to parameter', async () => {
    const targetId = `${REPO_HASH}:interface:src/types.ts:Config`;
    const sourceId = `${REPO_HASH}:function:src/svc.ts:configure`;
    await insertNode({
      id: targetId,
      type: 'interface',
      name: 'Config',
      filePath: 'src/types.ts',
    });
    await insertNode({
      id: sourceId,
      type: 'function',
      name: 'configure',
      filePath: 'src/svc.ts',
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:uses-type-missing-usage`,
      type: 'USES_TYPE',
      sourceId,
      targetId,
      properties: { via: 'config' },
    });

    const results = await repo.getTypeUsages(targetId, [REPO_HASH]);

    expect(results).toEqual([expect.objectContaining({ id: sourceId, usage: 'parameter', via: 'config' })]);
  });

  it('orders consumers by file path then start line', async () => {
    await insertNode({
      id: `${REPO_HASH}:interface:src/types.ts:Config`,
      type: 'interface',
      name: 'Config',
      filePath: 'src/types.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/b.ts:second`,
      type: 'function',
      name: 'second',
      filePath: 'src/b.ts',
      startLine: 30,
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/a.ts:first`,
      type: 'function',
      name: 'first',
      filePath: 'src/a.ts',
      startLine: 5,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:1`,
      type: 'USES_TYPE',
      sourceId: `${REPO_HASH}:function:src/b.ts:second`,
      targetId: `${REPO_HASH}:interface:src/types.ts:Config`,
      properties: { usage: 'return', ambiguous: false },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:2`,
      type: 'USES_TYPE',
      sourceId: `${REPO_HASH}:function:src/a.ts:first`,
      targetId: `${REPO_HASH}:interface:src/types.ts:Config`,
      properties: { usage: 'parameter', via: 'cfg', ambiguous: false },
    });

    const results = await repo.getTypeUsages(`${REPO_HASH}:interface:src/types.ts:Config`, [REPO_HASH]);

    expect(results.map((r) => r.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(results[0]?.via).toBe('cfg');
    expect(results[1]?.via).toBeUndefined();
  });

  it('only includes consumers whose source node is in the requested repos', async () => {
    const otherHash = 'fff111222333';
    await insertNode({
      id: `${REPO_HASH}:type_alias:src/t.ts:T`,
      type: 'type_alias',
      name: 'T',
      filePath: 'src/t.ts',
    });
    await insertNode({
      id: `${otherHash}:function:src/x.ts:outside`,
      type: 'function',
      name: 'outside',
      filePath: 'src/x.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/y.ts:inside`,
      type: 'function',
      name: 'inside',
      filePath: 'src/y.ts',
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:cross-repo`,
      type: 'USES_TYPE',
      sourceId: `${otherHash}:function:src/x.ts:outside`,
      targetId: `${REPO_HASH}:type_alias:src/t.ts:T`,
      properties: { usage: 'parameter', via: 'v' },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:same-repo`,
      type: 'USES_TYPE',
      sourceId: `${REPO_HASH}:function:src/y.ts:inside`,
      targetId: `${REPO_HASH}:type_alias:src/t.ts:T`,
      properties: { usage: 'parameter', via: 'v' },
    });

    const results = await repo.getTypeUsages(`${REPO_HASH}:type_alias:src/t.ts:T`, [REPO_HASH]);

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe('inside');
  });

  it('returns empty array when the type has no USES_TYPE consumers', async () => {
    await insertNode({
      id: `${REPO_HASH}:enum:src/e.ts:Status`,
      type: 'enum',
      name: 'Status',
      filePath: 'src/e.ts',
    });

    const results = await repo.getTypeUsages(`${REPO_HASH}:enum:src/e.ts:Status`, [REPO_HASH]);

    expect(results).toEqual([]);
  });

  it('returns source files linked by package-import RESOLVES_TO edges', async () => {
    const consumerHash = 'def456abc123';
    const targetId = `${REPO_HASH}:enum:src/enums.ts:BookingTypes`;
    const sourceId = `${consumerHash}:file:src/use-booking.ts`;
    await insertNode({
      id: targetId,
      type: 'enum',
      name: 'BookingTypes',
      filePath: 'src/enums.ts',
    });
    await insertNode({
      id: sourceId,
      type: 'file',
      name: 'src/use-booking.ts',
      filePath: 'src/use-booking.ts',
      startLine: 0,
      repoId: consumerHash,
    });
    await insertEdge({
      id: 'resolve:package-import:use-booking:BookingTypes',
      type: 'RESOLVES_TO',
      sourceId,
      targetId,
      properties: {
        relation: 'package-import',
        usage: 'import',
        via: 'BookingKind',
        importedName: 'BookingTypes',
      },
    });

    const results = await repo.getTypeUsages(targetId, [consumerHash]);

    expect(results).toEqual([
      {
        id: sourceId,
        name: 'src/use-booking.ts',
        type: 'file',
        filePath: 'src/use-booking.ts',
        startLine: 0,
        usage: 'import',
        via: 'BookingKind',
        ambiguous: false,
      },
    ]);
  });
});

describe('SqliteRepository.listAllRepositories', () => {
  // Repository nodes use the bare hash as their id (no `:type:...` suffix),
  // matching the parser/transformer contract. Inserting them this way keeps
  // the test honest about how the SQL clause filters.
  async function insertRepoNode(hash: string, name: string, type = 'backend'): Promise<void> {
    await insertNode({
      id: hash,
      type: 'repository',
      name,
      filePath: '',
      properties: { type, parsedAt: '2026-05-14T00:00:00Z' },
    });
  }

  it('returns every repository when no filter is passed', async () => {
    await insertRepoNode('aaaa11112222', 'company-svc-a');
    await insertRepoNode('bbbb33334444', 'company-svc-b');
    await insertRepoNode('cccc55556666', 'unrelated-pet-project', 'frontend');

    const results = await repo.listAllRepositories();

    expect(results.map((r) => r.name).sort()).toEqual(['company-svc-a', 'company-svc-b', 'unrelated-pet-project']);
  });

  it('filters at the SQL layer when nameFilter is passed', async () => {
    await insertRepoNode('aaaa11112222', 'company-svc-a');
    await insertRepoNode('bbbb33334444', 'company-svc-b');
    await insertRepoNode('cccc55556666', 'unrelated-pet-project', 'frontend');

    const results = await repo.listAllRepositories(['company-svc-a', 'company-svc-b']);

    expect(results.map((r) => r.name).sort()).toEqual(['company-svc-a', 'company-svc-b']);
    // Defense for cloud MCP workspace isolation: unrelated repos must NOT
    // leak across the project boundary.
    expect(results.map((r) => r.name)).not.toContain('unrelated-pet-project');
  });

  it('returns empty when filter is an empty array (explicit "no repos")', async () => {
    await insertRepoNode('aaaa11112222', 'company-svc-a');

    const results = await repo.listAllRepositories([]);

    expect(results).toEqual([]);
  });

  it('returns empty when filter names no repos that exist', async () => {
    await insertRepoNode('aaaa11112222', 'company-svc-a');

    const results = await repo.listAllRepositories(['nonexistent-repo']);

    expect(results).toEqual([]);
  });
});

describe('SqliteRepository.getRepoOverview (git link)', () => {
  it('surfaces gitRemoteUrl from the repository node properties', async () => {
    await insertNode({
      id: REPO_HASH,
      type: 'repository',
      name: 'company-svc-a',
      filePath: '',
      properties: { type: 'backend', parsedAt: '2026-05-14T00:00:00Z', gitRemoteUrl: 'git@github.com:acme/api.git' },
    });

    const [overview] = await repo.getRepoOverview([REPO_HASH]);

    expect(overview).toBeDefined();
    expect(overview!.gitRemoteUrl).toBe('git@github.com:acme/api.git');
  });

  it('omits gitRemoteUrl when the repository node has no remote', async () => {
    await insertNode({
      id: REPO_HASH,
      type: 'repository',
      name: 'company-svc-a',
      filePath: '',
      properties: { type: 'backend', parsedAt: '2026-05-14T00:00:00Z' },
    });

    const [overview] = await repo.getRepoOverview([REPO_HASH]);

    expect(overview).toBeDefined();
    expect(overview!.gitRemoteUrl).toBeUndefined();
  });

  it('surfaces gitCommitHash from the repository node properties', async () => {
    await insertNode({
      id: REPO_HASH,
      type: 'repository',
      name: 'company-svc-a',
      filePath: '',
      properties: { type: 'backend', parsedAt: '2026-05-14T00:00:00Z', gitCommitHash: 'deadbeefcafe' },
    });

    const [overview] = await repo.getRepoOverview([REPO_HASH]);

    expect(overview).toBeDefined();
    expect(overview!.gitCommitHash).toBe('deadbeefcafe');
  });

  it('omits gitCommitHash when the repository node recorded no commit', async () => {
    await insertNode({
      id: REPO_HASH,
      type: 'repository',
      name: 'company-svc-a',
      filePath: '',
      properties: { type: 'backend', parsedAt: '2026-05-14T00:00:00Z' },
    });

    const [overview] = await repo.getRepoOverview([REPO_HASH]);

    expect(overview).toBeDefined();
    expect(overview!.gitCommitHash).toBeUndefined();
  });
});

describe('SqliteRepository.getDirectCallers (REFERENCES_VARIABLE fallback)', () => {
  // The target node is a state_store (`userLogic`). Consumers reference it
  // by name via REFERENCES_VARIABLE edges — there are no CALLS edges to a
  // state_store because state_stores aren't invoked. Before this fallback
  // existed, find_callers reported 0 callers and agents abandoned the MCP
  // path; the test pins the behaviour against regression.
  it('returns callers via REFERENCES_VARIABLE edges when the target is a state_store', async () => {
    const stateStoreId = `${REPO_HASH}:state_store:src/userLogic.ts:userLogic`;
    const consumer1Id = `${REPO_HASH}:function:src/UserPage.ts:UserPage`;
    const consumer2Id = `${REPO_HASH}:function:src/Header.ts:Header`;

    await insertNode({
      id: stateStoreId,
      type: 'state_store',
      name: 'userLogic',
      filePath: 'src/userLogic.ts',
      properties: { library: 'other' },
      startLine: 3,
    });
    await insertNode({
      id: consumer1Id,
      type: 'function',
      name: 'UserPage',
      filePath: 'src/UserPage.ts',
      startLine: 10,
      endLine: 20,
      properties: { kind: 'function', isAsync: false },
    });
    await insertNode({
      id: consumer2Id,
      type: 'function',
      name: 'Header',
      filePath: 'src/Header.ts',
      startLine: 5,
      endLine: 15,
      properties: { kind: 'function', isAsync: false },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:refvar-1`,
      type: 'REFERENCES_VARIABLE',
      sourceId: consumer1Id,
      targetId: stateStoreId,
      properties: { targetKind: 'state-store', identifierName: 'userLogic', line: 12 },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:refvar-2`,
      type: 'REFERENCES_VARIABLE',
      sourceId: consumer2Id,
      targetId: stateStoreId,
      properties: { targetKind: 'state-store', identifierName: 'userLogic', line: 7 },
    });

    const callers = await repo.getDirectCallers(stateStoreId, [REPO_HASH]);

    expect(callers.map((c) => c.name).sort()).toEqual(['Header', 'UserPage']);
    expect(callers.every((c) => c.distance === 1)).toBe(true);
  });

  it('keeps CALLS edges as the primary source and falls back to REFERENCES_VARIABLE', async () => {
    const targetFnId = `${REPO_HASH}:function:src/lib.ts:doThing`;
    const callerWithCallId = `${REPO_HASH}:function:src/a.ts:invoke`;
    const callerWithRefId = `${REPO_HASH}:function:src/b.ts:reference`;

    // Function target — should also be reachable through REFERENCES_VARIABLE
    // (e.g. someone wrote `register(doThing)` instead of `doThing()`),
    // not just CALLS.
    await insertNode({
      id: targetFnId,
      type: 'function',
      name: 'doThing',
      filePath: 'src/lib.ts',
      properties: { kind: 'function' },
      startLine: 1,
      endLine: 3,
    });
    await insertNode({
      id: callerWithCallId,
      type: 'function',
      name: 'invoke',
      filePath: 'src/a.ts',
      properties: { kind: 'function' },
      startLine: 10,
      endLine: 12,
    });
    await insertNode({
      id: callerWithRefId,
      type: 'function',
      name: 'reference',
      filePath: 'src/b.ts',
      properties: { kind: 'function' },
      startLine: 5,
      endLine: 8,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:call-1`,
      type: 'CALLS',
      sourceId: callerWithCallId,
      targetId: targetFnId,
      properties: { line: 11 },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:refvar-3`,
      type: 'REFERENCES_VARIABLE',
      sourceId: callerWithRefId,
      targetId: targetFnId,
      properties: { targetKind: 'variable', identifierName: 'doThing', line: 6 },
    });

    const callers = await repo.getDirectCallers(targetFnId, [REPO_HASH]);

    expect(callers.map((c) => c.name).sort()).toEqual(['invoke', 'reference']);
    const invokeRow = callers.find((c) => c.name === 'invoke')!;
    expect(invokeRow.callSiteLine).toBe(11); // CALLS edge wins the line metadata
  });

  // The transformer writes `provenanceInferred` on a heuristic CALLS edge
  // (`iface-impl`), and `CallProvenance` requires consumers to render it as
  // inferred. The property was written and never projected, so a guess reached
  // agents looking exactly like a compiler-proven SCIP edge.
  it('projects provenanceInferred off the CALLS edge, and only when set', async () => {
    const targetId = `${REPO_HASH}:function:src/iface.ts:handle`;
    const provenId = `${REPO_HASH}:function:src/proven.ts:provenCaller`;
    const guessedId = `${REPO_HASH}:function:src/guessed.ts:guessedCaller`;

    await insertNode({
      id: targetId,
      type: 'function',
      name: 'handle',
      filePath: 'src/iface.ts',
      properties: {},
      startLine: 1,
    });
    await insertNode({
      id: provenId,
      type: 'function',
      name: 'provenCaller',
      filePath: 'src/proven.ts',
      properties: {},
      startLine: 1,
    });
    await insertNode({
      id: guessedId,
      type: 'function',
      name: 'guessedCaller',
      filePath: 'src/guessed.ts',
      properties: {},
      startLine: 1,
    });

    await insertEdge({
      id: `${REPO_HASH}:edge:proven-call`,
      type: 'CALLS',
      sourceId: provenId,
      targetId,
      properties: { line: 4 },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:inferred-call`,
      type: 'CALLS',
      sourceId: guessedId,
      targetId,
      properties: { line: 7, provenanceInferred: true },
    });

    const callers = await repo.getDirectCallers(targetId, [REPO_HASH]);

    // Absent, not `false`, on a proven edge: an explicit false would claim
    // "proven" for an edge that merely predates the flag.
    expect(callers.find((c) => c.name === 'provenCaller')!.provenanceInferred).toBeUndefined();
    expect(callers.find((c) => c.name === 'guessedCaller')!.provenanceInferred).toBe(true);
  });

  // A chain is only as proven as its weakest edge.
  it('marks a transitive caller reached through an inferred hop', async () => {
    const leafId = `${REPO_HASH}:function:src/leaf.ts:leaf`;
    const midId = `${REPO_HASH}:function:src/mid.ts:mid`;
    const topId = `${REPO_HASH}:function:src/top.ts:top`;

    await insertNode({
      id: leafId,
      type: 'function',
      name: 'leaf',
      filePath: 'src/leaf.ts',
      properties: {},
      startLine: 1,
    });
    await insertNode({
      id: midId,
      type: 'function',
      name: 'mid',
      filePath: 'src/mid.ts',
      properties: {},
      startLine: 1,
    });
    await insertNode({
      id: topId,
      type: 'function',
      name: 'top',
      filePath: 'src/top.ts',
      properties: {},
      startLine: 1,
    });

    // top -> mid is a guess; mid -> leaf is proven. Reaching `leaf` from `top`
    // therefore crosses an inferred hop.
    await insertEdge({
      id: `${REPO_HASH}:edge:mid-leaf`,
      type: 'CALLS',
      sourceId: midId,
      targetId: leafId,
      properties: { line: 2 },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:top-mid`,
      type: 'CALLS',
      sourceId: topId,
      targetId: midId,
      properties: { line: 3, provenanceInferred: true },
    });

    const callers = await repo.getTransitiveCallers(leafId, 5, [REPO_HASH]);

    expect(callers.find((c) => c.name === 'mid')!.provenanceInferred).toBeUndefined();
    expect(callers.find((c) => c.name === 'top')!.provenanceInferred).toBe(true);
  });

  it('deduplicates a caller that has both CALLS and REFERENCES_VARIABLE to the same target, preferring CALLS', async () => {
    const targetId = `${REPO_HASH}:variable:src/store.ts:rootStore`;
    const callerId = `${REPO_HASH}:function:src/component.ts:Comp`;

    await insertNode({
      id: targetId,
      type: 'variable',
      name: 'rootStore',
      filePath: 'src/store.ts',
      properties: {},
      startLine: 1,
    });
    await insertNode({
      id: callerId,
      type: 'function',
      name: 'Comp',
      filePath: 'src/component.ts',
      properties: { kind: 'function' },
      startLine: 1,
      endLine: 20,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:call-2`,
      type: 'CALLS',
      sourceId: callerId,
      targetId,
      properties: { line: 7 },
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:refvar-4`,
      type: 'REFERENCES_VARIABLE',
      sourceId: callerId,
      targetId,
      properties: { targetKind: 'variable', identifierName: 'rootStore', line: 9 },
    });

    const callers = await repo.getDirectCallers(targetId, [REPO_HASH]);

    expect(callers).toHaveLength(1);
    // CALLS row wins, so callSiteLine matches the call edge's line.
    expect(callers[0]!.callSiteLine).toBe(7);
  });
});

describe('SqliteRepository.findCode exportedVariablesOnly', () => {
  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:variable:src/a.ts:exportedConst`,
      type: 'variable',
      name: 'exportedConst',
      filePath: 'src/a.ts',
      properties: { isExported: true },
    });
    await insertNode({
      id: `${REPO_HASH}:variable:src/b.ts:internalConst`,
      type: 'variable',
      name: 'internalConst',
      filePath: 'src/b.ts',
      properties: { isExported: false },
    });
    await insertNode({
      id: `${REPO_HASH}:variable:src/c.ts:legacyConst`,
      type: 'variable',
      name: 'legacyConst',
      filePath: 'src/c.ts',
      properties: {}, // isExported absent
    });
  });

  it('returns only exported variables when exportedVariablesOnly=true', async () => {
    const results = await repo.findCode(
      { pattern: '*Const', types: ['variable'], exportedVariablesOnly: true, limit: 10 },
      [REPO_HASH],
    );
    expect(results.map((r) => r.name)).toEqual(['exportedConst']);
  });

  it('returns all variables when exportedVariablesOnly is omitted', async () => {
    const results = await repo.findCode({ pattern: '*Const', types: ['variable'], limit: 10 }, [REPO_HASH]);
    expect(results.map((r) => r.name).sort()).toEqual(['exportedConst', 'internalConst', 'legacyConst']);
  });

  it('does not affect non-variable rows even when exportedVariablesOnly=true', async () => {
    await insertNode({
      id: `${REPO_HASH}:function:src/d.ts:helper`,
      type: 'function',
      name: 'helperConst',
      filePath: 'src/d.ts',
      properties: { isExported: false },
    });
    const results = await repo.findCode(
      { pattern: '*Const', types: ['function', 'variable'], exportedVariablesOnly: true, limit: 10 },
      [REPO_HASH],
    );
    // Internal function row is kept; only the variable rows are filtered.
    expect(results.map((r) => r.name).sort()).toEqual(['exportedConst', 'helperConst']);
  });
});

describe('SqliteRepository.findCode includeSource', () => {
  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:function:src/s.ts:withSource`,
      type: 'function',
      name: 'withSource',
      filePath: 'src/s.ts',
      properties: { sourceCode: 'function withSource() { return 1; }', purpose: 'Returns one.' },
    });
  });

  it('projects sourceCode from the properties blob when includeSource=true', async () => {
    const results = await repo.findCode({ pattern: 'withSource', includeSource: true, limit: 10 }, [REPO_HASH]);
    expect(results).toHaveLength(1);
    expect(results[0].sourceCode).toBe('function withSource() { return 1; }');
  });

  it('omits sourceCode when includeSource is not set (default hot path)', async () => {
    const results = await repo.findCode({ pattern: 'withSource', limit: 10 }, [REPO_HASH]);
    expect(results).toHaveLength(1);
    expect(results[0].sourceCode).toBeUndefined();
  });

  it('always projects purpose from the properties blob (independent of includeSource)', async () => {
    const results = await repo.findCode({ pattern: 'withSource', limit: 10 }, [REPO_HASH]);
    expect(results[0].purpose).toBe('Returns one.');
  });
});

describe('SqliteRepository.findCode pattern strategies', () => {
  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:function:src/a.ts:UserService`,
      type: 'function',
      name: 'UserService',
      filePath: 'src/a.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/b.ts:UserController`,
      type: 'function',
      name: 'UserController',
      filePath: 'src/b.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/c.ts:AnalyzeApplyTemplateDto`,
      type: 'function',
      name: 'AnalyzeApplyTemplateDto',
      filePath: 'src/c.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:variable:src/d.ts:percent_off`,
      type: 'variable',
      name: 'percent_off',
      filePath: 'src/d.ts',
      properties: { isExported: true },
    });
  });

  it('exact match (no wildcards) returns single hit', async () => {
    const r = await repo.findCode({ pattern: 'UserService', limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['UserService']);
  });

  it('prefix glob (trailing *) returns alphabetically ordered prefix matches', async () => {
    const r = await repo.findCode({ pattern: 'User*', limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['UserController', 'UserService']);
  });

  it('substring glob (*core*) uses FTS5 trigram and finds substring inside camelCase identifiers', async () => {
    const r = await repo.findCode({ pattern: '*Apply*', limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['AnalyzeApplyTemplateDto']);
  });

  it('substring glob is case-insensitive (trigram default)', async () => {
    const r = await repo.findCode({ pattern: '*apply*', limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['AnalyzeApplyTemplateDto']);
  });

  it('suffix glob (*foo) is anchored to end — does not match substring elsewhere', async () => {
    // *Service should match `UserService` but NOT `ServiceWorker`. Regression
    // guard: a bare FTS MATCH without a LIKE post-filter false-matched both.
    await insertNode({
      id: `${REPO_HASH}:class:src/g.ts:ServiceWorker`,
      type: 'class',
      name: 'ServiceWorker',
      filePath: 'src/g.ts',
    });
    const r = await repo.findCode({ pattern: '*Service', limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['UserService']);
  });

  it('escapes literal `_` so it does not act as a SQL wildcard', async () => {
    // `percent_off` contains a real underscore. A user typing `*_off` should
    // NOT match other words ending in `<any-char>off`.
    await insertNode({
      id: `${REPO_HASH}:variable:src/e.ts:percentXoff`,
      type: 'variable',
      name: 'percentXoff',
      filePath: 'src/e.ts',
      properties: { isExported: true },
    });
    const r = await repo.findCode({ pattern: '*_off', types: ['variable'], limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name)).toEqual(['percent_off']);
  });

  it('1-2 char glob (below trigram floor) falls back to LIKE and still returns matches', async () => {
    await insertNode({
      id: `${REPO_HASH}:variable:src/f.ts:ab`,
      type: 'variable',
      name: 'ab',
      filePath: 'src/f.ts',
      properties: { isExported: true },
    });
    const r = await repo.findCode({ pattern: '*ab*', types: ['variable'], limit: 10 }, [REPO_HASH]);
    expect(r.map((x) => x.name).sort()).toEqual(['ab']);
  });
});

describe('SqliteRepository.findCode FTS backfill on schema upgrade', () => {
  // Version 9 always rebuilds a non-empty external-content index. Count-based
  // detection is insufficient because missing and dangling entries can cancel
  // each other, and count(*) proxies to the content table when the index is empty.
  it('rebuilds the FTS index when reopening a DB whose nodes pre-date the index', async () => {
    const dbPath = join(tmp, 'upgrade.db');
    const driver1 = new SqliteDriver(`file:${dbPath}`);
    await driver1.initialize();
    const repo1 = new SqliteRepository(driver1);

    // Populate normally so triggers fire, then drop the FTS index contents to
    // mimic a DB that existed before the FTS5 table was added (the triggers
    // wouldn't have fired then).
    await driver1.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, end_line, properties, repo_id)
         VALUES (@id, @type, @name, @filePath, 1, NULL, '{}', @repoId)`,
        {
          id: `${REPO_HASH}:function:src/x.ts:AnalyzeApplyTemplate`,
          type: 'function',
          name: 'AnalyzeApplyTemplate',
          filePath: 'src/x.ts',
          repoId: REPO_HASH,
        },
      );
      // Empty the FTS index without touching `nodes`. After this,
      // count(*) on the external-content FTS table still equals node_count,
      // but no rows are actually indexed — exactly the upgrade scenario.
      await tx.run(`INSERT INTO nodes_name_fts(nodes_name_fts) VALUES('delete-all')`);
      await tx.run(`DELETE FROM schema_version WHERE version = 9`);
    });

    // Sanity: the bug-bait check would falsely report counts match.
    const counts = await driver1.withReadTransaction(async (tx) => {
      return tx.run<{ proxy_count: number; real_indexed: number }>(
        `SELECT
           (SELECT count(*) FROM nodes_name_fts) AS proxy_count,
           (SELECT count(*) FROM nodes_name_fts_docsize) AS real_indexed`,
      );
    });
    expect(counts[0]!.proxy_count).toBe(1);
    expect(counts[0]!.real_indexed).toBe(0);

    // Substring search is currently broken (index is empty).
    const before = await repo1.findCode({ pattern: '*Apply*', limit: 10 }, [REPO_HASH]);
    expect(before).toEqual([]);

    await driver1.close();

    // Re-initialize: schema version 9 sees a non-empty graph and rebuilds the
    // index unconditionally. After that, substring search works again.
    const driver2 = new SqliteDriver(`file:${dbPath}`);
    await driver2.initialize();
    const repo2 = new SqliteRepository(driver2);
    const after = await repo2.findCode({ pattern: '*Apply*', limit: 10 }, [REPO_HASH]);
    expect(after.map((r) => r.name)).toEqual(['AnalyzeApplyTemplate']);
    await driver2.close();
  });

  it('heals equal-count dangling entries left by INSERT OR REPLACE and applies v9 once', async () => {
    const dbPath = join(tmp, 'replace-corruption.db');
    const first = new SqliteDriver(`file:${dbPath}`);
    await first.initialize();
    await first.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, properties, repo_id)
         VALUES (@id, 'function', 'LegacyDanglingName', '{}', @repoId)`,
        { id: `${REPO_HASH}:function:replace`, repoId: REPO_HASH },
      );
      await tx.run(
        `INSERT OR REPLACE INTO nodes (id, type, name, properties, repo_id)
         VALUES (@id, 'function', 'CurrentCanonicalName', '{}', @repoId)`,
        { id: `${REPO_HASH}:function:replace`, repoId: REPO_HASH },
      );
      await tx.run(`DELETE FROM schema_version WHERE version = 9`);
    });
    await first.close();

    const repaired = new SqliteDriver(`file:${dbPath}`);
    await repaired.initialize();
    const repairedRepo = new SqliteRepository(repaired);
    expect(await repairedRepo.findCode({ pattern: '*LegacyDangling*' }, [REPO_HASH])).toEqual([]);
    expect((await repairedRepo.findCode({ pattern: '*Canonical*' }, [REPO_HASH])).map((node) => node.name)).toEqual([
      'CurrentCanonicalName',
    ]);
    const migration = await repaired.withReadTransaction((tx) =>
      tx.run<{ count: number }>(`SELECT count(*) AS count FROM schema_version WHERE version = 9`),
    );
    expect(migration[0]!.count).toBe(1);
    const trigger = await repaired.withReadTransaction((tx) =>
      tx.run<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'nodes_fts_au'`),
    );
    expect(trigger[0]!.sql).toContain('AFTER UPDATE OF name ON nodes');
    expect(trigger[0]!.sql).toContain('WHEN old.name IS NOT new.name');
    await repaired.close();

    const reopened = new SqliteDriver(`file:${dbPath}`);
    await reopened.initialize();
    const versionRows = await reopened.withReadTransaction((tx) =>
      tx.run<{ count: number }>(`SELECT count(*) AS count FROM schema_version WHERE version = 9`),
    );
    expect(versionRows[0]!.count).toBe(1);
    await reopened.close();
  });

  it('recovers an interrupted v9 migration on the next initialize()', async () => {
    // Simulate the post-crash shape: corrected work partially undone — the OLD
    // trigger is back, the FTS index is stale, and no v9 row was recorded
    // (the migration transaction commits the version row LAST, so any earlier
    // failure rolls the whole thing back to exactly this state).
    const dbPath = join(tmp, 'interrupted.db');
    const first = new SqliteDriver(`file:${dbPath}`);
    await first.initialize();
    await first.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, properties, repo_id)
         VALUES (@id, 'function', 'InterruptedName', '{}', @repoId)`,
        { id: `${REPO_HASH}:function:interrupted`, repoId: REPO_HASH },
      );
      await tx.run(`INSERT INTO nodes_name_fts(nodes_name_fts) VALUES('delete-all')`);
      await tx.run(`DROP TRIGGER IF EXISTS nodes_fts_au`);
      await tx.run(`CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_name_fts(nodes_name_fts, rowid, name) VALUES('delete', old.rowid, old.name);
        INSERT INTO nodes_name_fts(rowid, name) VALUES (new.rowid, new.name);
      END`);
      await tx.run(`DELETE FROM schema_version WHERE version = 9`);
    });
    await first.close();

    const recovered = new SqliteDriver(`file:${dbPath}`);
    await recovered.initialize();
    const repairedRepo = new SqliteRepository(recovered);
    expect((await repairedRepo.findCode({ pattern: '*Interrupted*' }, [REPO_HASH])).map((n) => n.name)).toEqual([
      'InterruptedName',
    ]);
    const trigger = await recovered.withReadTransaction((tx) =>
      tx.run<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'nodes_fts_au'`),
    );
    expect(trigger[0]!.sql).toContain('AFTER UPDATE OF name ON nodes');
    const version = await recovered.withReadTransaction((tx) =>
      tx.run<{ count: number }>(`SELECT count(*) AS count FROM schema_version WHERE version = 9`),
    );
    expect(version[0]!.count).toBe(1);
    await recovered.close();
  });

  // NOTE: the v9 check-then-act race (two PROCESSES initializing one database)
  // cannot be reproduced in-process: the local sqlite3 transport is
  // synchronous, so two drivers on one file in one event loop cannot
  // interleave write transactions. The guard against the race is structural —
  // the version re-check runs as the first statement INSIDE the write
  // transaction and the version insert is OR IGNORE — and the
  // interrupted-migration test above exercises exactly that code path.
});

describe('SqliteRepository.applyChangeset edge and metadata semantics', () => {
  const NODE_A = `${REPO_HASH}:function:src/a.ts:a`;
  const NODE_B = `${REPO_HASH}:function:src/a.ts:b`;
  const NODE_C = `${REPO_HASH}:function:src/a.ts:c`;

  async function seedNodes(): Promise<void> {
    for (const [id, name] of [
      [NODE_A, 'a'],
      [NODE_B, 'b'],
      [NODE_C, 'c'],
    ] as const) {
      await insertNode({ id, type: 'function', name, filePath: 'src/a.ts' });
    }
  }

  it('ON CONFLICT(id): same edge id with different endpoints moves the edge, preserving created_at', async () => {
    await seedNodes();
    await insertEdge({ id: 'edge-1', type: 'CALLS', sourceId: NODE_A, targetId: NODE_B });
    const before = await driver.withReadTransaction((tx) =>
      tx.run<{ created_at: number }>(`SELECT created_at FROM edges WHERE id = 'edge-1'`),
    );

    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'edge-1',
          sourceId: NODE_A,
          targetId: NODE_C,
          type: EdgeType.Calls,
          confidence: 0.5,
          createdBy: 'ai',
          properties: { via: 'rewire' },
        },
      ],
    });

    const rows = await driver.withReadTransaction((tx) =>
      tx.run<{ id: string; target_id: string; confidence: number; created_by: string; created_at: number }>(
        `SELECT id, target_id, confidence, created_by, created_at FROM edges WHERE id = 'edge-1'`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_id).toBe(NODE_C);
    expect(rows[0]!.confidence).toBe(0.5);
    expect(rows[0]!.created_by).toBe('ai');
    expect(rows[0]!.created_at).toBe(before[0]!.created_at);
  });

  it('metadata-only updates do not rewrite the FTS index', async () => {
    await seedNodes();
    const countDocs = () =>
      driver.withReadTransaction((tx) =>
        tx.run<{ count: number }>(`SELECT count(*) AS count FROM nodes_name_fts_docsize`),
      );
    const before = await countDocs();

    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [],
      // Same-name structural update + metadata patch: neither may touch FTS
      // under the corrected `AFTER UPDATE OF name ... WHEN old.name IS NOT
      // new.name` trigger.
      nodesToUpdate: [
        { id: NODE_A, type: NodeType.Function, name: 'a', repoId: REPO_HASH, filePath: 'src/a.ts', properties: {} },
      ],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      nodeMetadataUpdates: [{ id: NODE_B, summary: 'summarized', properties: { purpose: 'test' } }],
    });

    const after = await countDocs();
    expect(after[0]!.count).toBe(before[0]!.count);
    const hits = await repo.findCode({ pattern: '*a*', types: ['function'], limit: 10 }, [REPO_HASH]);
    expect(hits.filter((h) => h.name === 'a')).toHaveLength(1);
  });

  it('repoIdsToDelete removes the repo graph_meta snapshot but leaves siblings intact', async () => {
    const makeSnapshot = (repoId: string) => ({
      parsedVersion: `v-${repoId}`,
      summaryVersion: null,
      embeddingsVersion: null,
      commitSha: null,
      totalNodeCount: 1,
      totalEdgeCount: 0,
      mode: GraphApplyMode.Full,
      executionToken: `token-${repoId}`,
    });
    for (const repoId of ['repo-one', 'repo-two']) {
      await repo.applyChangeset(
        {
          repoId,
          repoIdsToDelete: [repoId],
          nodesToAdd: [{ id: repoId, type: NodeType.Repository, name: repoId, properties: {} }],
          nodesToUpdate: [],
          nodeIdsToDelete: [],
          edgeNodeIdsToWipe: [],
          edgesToInsert: [],
        },
        { snapshot: makeSnapshot(repoId) },
      );
    }
    expect(await repo.getAppliedGraphSnapshot('repo-one')).not.toBeNull();

    await repo.applyChangeset({
      repoId: 'repo-one',
      repoIdsToDelete: ['repo-one'],
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    expect(await repo.getAppliedGraphSnapshot('repo-one')).toBeNull();
    expect((await repo.getAppliedGraphSnapshot('repo-two'))?.parsedVersion).toBe('v-repo-two');
  });

  it('treats a malformed graph_meta row as no snapshot instead of throwing', async () => {
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(`INSERT INTO graph_meta (repo_id, snapshot) VALUES ('broken-repo', 'not-json{')`, {});
      await tx.run(`INSERT INTO graph_meta (repo_id, snapshot) VALUES ('shapeless-repo', '{"parsedVersion":42}')`, {});
    });
    expect(await repo.getAppliedGraphSnapshot('broken-repo')).toBeNull();
    expect(await repo.getAppliedGraphSnapshot('shapeless-repo')).toBeNull();
  });
});

describe('SqliteRepository.findShortestPath', () => {
  it('returns the empty path for start == end', async () => {
    await insertNode({
      id: `${REPO_HASH}:function:src/a.ts:solo`,
      type: 'function',
      name: 'solo',
      filePath: 'src/a.ts',
    });
    const path = await repo.findShortestPath(
      `${REPO_HASH}:function:src/a.ts:solo`,
      `${REPO_HASH}:function:src/a.ts:solo`,
      [REPO_HASH],
    );
    expect(path.map((s) => s.id)).toEqual([`${REPO_HASH}:function:src/a.ts:solo`]);
  });

  it('returns the SHORTEST path even when a wide branch sits between start and target', async () => {
    // Regression: when the CTE was capped at 5000 rows, DFS-order expansion
    // could exhaust the budget on a wide sibling branch before reaching the
    // target down the short branch, returning [] instead of the real path.
    // Topology:
    //   start → wide_0..wide_19  (20 wide siblings, no path to end)
    //   start → bridge → end
    // Shortest path is start→bridge→end (depth 2).
    await insertNode({
      id: `${REPO_HASH}:function:src/p.ts:start`,
      type: 'function',
      name: 'start',
      filePath: 'src/p.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:src/p.ts:bridge`,
      type: 'function',
      name: 'bridge',
      filePath: 'src/p.ts',
    });
    await insertNode({ id: `${REPO_HASH}:function:src/p.ts:end`, type: 'function', name: 'end', filePath: 'src/p.ts' });
    for (let i = 0; i < 20; i++) {
      await insertNode({
        id: `${REPO_HASH}:function:src/p.ts:wide${i}`,
        type: 'function',
        name: `wide${i}`,
        filePath: 'src/p.ts',
      });
      await insertEdge({
        id: `${REPO_HASH}:edge:wide${i}`,
        type: 'CALLS',
        sourceId: `${REPO_HASH}:function:src/p.ts:start`,
        targetId: `${REPO_HASH}:function:src/p.ts:wide${i}`,
      });
    }
    await insertEdge({
      id: `${REPO_HASH}:edge:start-bridge`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:src/p.ts:start`,
      targetId: `${REPO_HASH}:function:src/p.ts:bridge`,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:bridge-end`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:src/p.ts:bridge`,
      targetId: `${REPO_HASH}:function:src/p.ts:end`,
    });

    const path = await repo.findShortestPath(
      `${REPO_HASH}:function:src/p.ts:start`,
      `${REPO_HASH}:function:src/p.ts:end`,
      [REPO_HASH],
    );
    expect(path.map((s) => s.name)).toEqual(['start', 'bridge', 'end']);
  });

  it('returns [] when no path exists', async () => {
    await insertNode({ id: `${REPO_HASH}:function:src/q.ts:a`, type: 'function', name: 'a', filePath: 'src/q.ts' });
    await insertNode({ id: `${REPO_HASH}:function:src/q.ts:b`, type: 'function', name: 'b', filePath: 'src/q.ts' });
    const path = await repo.findShortestPath(`${REPO_HASH}:function:src/q.ts:a`, `${REPO_HASH}:function:src/q.ts:b`, [
      REPO_HASH,
    ]);
    expect(path).toEqual([]);
  });

  it('detects cycles without infinite-looping (visited set, not substring matching)', async () => {
    // Regression: the previous SQL cycle check used INSTR on a comma-
    // separated path string. Node IDs include filepaths, so `foo.ts:bar`
    // appeared as a substring of `foobar.ts:baz` and would falsely block
    // expansion. JS BFS uses an exact-id Set; no risk of false collisions.
    await insertNode({ id: `${REPO_HASH}:function:src/r.ts:a`, type: 'function', name: 'a', filePath: 'src/r.ts' });
    await insertNode({ id: `${REPO_HASH}:function:src/r.ts:b`, type: 'function', name: 'b', filePath: 'src/r.ts' });
    await insertEdge({
      id: `${REPO_HASH}:edge:a-b`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:src/r.ts:a`,
      targetId: `${REPO_HASH}:function:src/r.ts:b`,
    });
    // b → a creates a cycle. BFS must terminate.
    await insertEdge({
      id: `${REPO_HASH}:edge:b-a`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:src/r.ts:b`,
      targetId: `${REPO_HASH}:function:src/r.ts:a`,
    });
    const path = await repo.findShortestPath(`${REPO_HASH}:function:src/r.ts:a`, `${REPO_HASH}:function:src/r.ts:b`, [
      REPO_HASH,
    ]);
    expect(path.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('SqliteRepository.getTransitiveCallers (recursive CTE, replaces calls_closure)', () => {
  // Transitive callers now walk edges backward via recursive CTE at query
  // time instead of materializing a closure table on every push. These
  // tests pin the same semantic contract the old closure tests asserted.

  async function insertNodeWithRepo(args: { id: string; name: string; repoId: string }): Promise<void> {
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
         VALUES (@id, 'function', @name, 'src/x.ts', 1, '{"kind":"function"}', @repoId)`,
        args,
      );
    });
  }

  // buildRepoFilter matches on nodes.repo_id directly, so repoHashes
  // passed to getTransitiveCallers must equal the repo_id of the seeded
  // nodes — NOT a separate hash.

  it('finds transitive ancestors up to @depth (a -> b -> c, query c, find a and b)', async () => {
    await insertNodeWithRepo({ id: 'A:fn:a', name: 'a', repoId: 'A' });
    await insertNodeWithRepo({ id: 'A:fn:b', name: 'b', repoId: 'A' });
    await insertNodeWithRepo({ id: 'A:fn:c', name: 'c', repoId: 'A' });
    await insertEdge({ id: 'A:e:a-b', type: 'CALLS', sourceId: 'A:fn:a', targetId: 'A:fn:b' });
    await insertEdge({ id: 'A:e:b-c', type: 'CALLS', sourceId: 'A:fn:b', targetId: 'A:fn:c' });

    const callers = await repo.getTransitiveCallers('A:fn:c', 10, ['A']);
    const byName = Object.fromEntries(callers.map((c) => [c.name, c.distance]));
    expect(byName).toEqual({ a: 2, b: 1 });
  });

  it('respects the @depth bound (a -> b -> c at depth=1 returns only b)', async () => {
    await insertNodeWithRepo({ id: 'A:fn:a', name: 'a', repoId: 'A' });
    await insertNodeWithRepo({ id: 'A:fn:b', name: 'b', repoId: 'A' });
    await insertNodeWithRepo({ id: 'A:fn:c', name: 'c', repoId: 'A' });
    await insertEdge({ id: 'A:e:a-b', type: 'CALLS', sourceId: 'A:fn:a', targetId: 'A:fn:b' });
    await insertEdge({ id: 'A:e:b-c', type: 'CALLS', sourceId: 'A:fn:b', targetId: 'A:fn:c' });

    const callers = await repo.getTransitiveCallers('A:fn:c', 1, ['A']);
    expect(callers.map((c) => c.name).sort()).toEqual(['b']);
  });

  it('returns empty when target has no incoming CALLS edges', async () => {
    await insertNodeWithRepo({ id: 'A:fn:orphan', name: 'orphan', repoId: 'A' });

    const callers = await repo.getTransitiveCallers('A:fn:orphan', 10, ['A']);
    expect(callers).toEqual([]);
  });

  it('handles cycles without infinite recursion (depth bound caps the walk)', async () => {
    await insertNodeWithRepo({ id: 'A:fn:p', name: 'p', repoId: 'A' });
    await insertNodeWithRepo({ id: 'A:fn:q', name: 'q', repoId: 'A' });
    await insertEdge({ id: 'A:e:p-q', type: 'CALLS', sourceId: 'A:fn:p', targetId: 'A:fn:q' });
    await insertEdge({ id: 'A:e:q-p', type: 'CALLS', sourceId: 'A:fn:q', targetId: 'A:fn:p' });

    const callers = await repo.getTransitiveCallers('A:fn:p', 10, ['A']);
    expect(callers.map((c) => c.name)).toEqual(['q']);
  });
});

describe('getExternalCalls — moniker round-trip (R2)', () => {
  it('returns both the resolved destination and its source reference', async () => {
    await insertNode({
      id: `${REPO_HASH}:ext:kafka.emit`,
      type: 'external_call',
      name: 'kafka.emit',
      filePath: 'src/events.ts',
      startLine: 12,
      properties: {
        callerId: `${REPO_HASH}:fn:publish`,
        serviceName: 'kafka',
        method: 'emit',
        protocol: 'messaging',
        messagingSystem: 'kafka',
        messagingDestination: 'user.created',
        messagingDestinationRef: 'Topics.USER_CREATED',
      },
    });

    const calls = await repo.getExternalCalls([REPO_HASH]);

    expect(calls[0]).toMatchObject({
      messagingSystem: 'kafka',
      messagingDestination: 'user.created',
      messagingDestinationRef: 'Topics.USER_CREATED',
    });
  });

  it('returns moniker.packageName when monikerPackage is stored on the node', async () => {
    // Write an external_call node with monikerPackage/monikerDescriptor in its
    // properties JSON — the same shape that transformExternalCall now emits.
    await insertNode({
      id: `${REPO_HASH}:ext:billing.Charge`,
      type: 'external_call',
      name: 'billing.Charge',
      filePath: 'src/billing.ts',
      startLine: 42,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:chargeUser`,
        serviceName: 'billing',
        method: 'Charge',
        protocol: 'grpc',
        monikerPackage: '@acme/billing-client',
        monikerDescriptor: 'src/`index.d.ts`/BillingClient#Charge().',
      },
    });

    const calls = await repo.getExternalCalls([REPO_HASH]);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.moniker).toBeDefined();
    expect(call.moniker?.packageName).toBe('@acme/billing-client');
    expect(call.moniker?.descriptor).toBe('src/`index.d.ts`/BillingClient#Charge().');
  });

  it('leaves moniker undefined when monikerPackage is absent', async () => {
    await insertNode({
      id: `${REPO_HASH}:ext:payments.create`,
      type: 'external_call',
      name: 'payments.create',
      filePath: 'src/payments.ts',
      startLine: 10,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:createPayment`,
        serviceName: 'payments',
        method: 'create',
        protocol: 'http',
      },
    });

    const calls = await repo.getExternalCalls([REPO_HASH]);
    expect(calls).toHaveLength(1);
    expect(calls[0].moniker).toBeUndefined();
  });

  it('returns dispatchMethod when stored on the node, and undefined when absent', async () => {
    // A dynamic-dispatch egress: `method` is the wrapper verb, `dispatchMethod` carries
    // the real SDK method name — the cross-repo sdkMapping fallback keys on the latter.
    await insertNode({
      id: `${REPO_HASH}:ext:mgmt.performApiRequest`,
      type: 'external_call',
      name: 'sample-management-api.PERFORMAPIREQUEST',
      filePath: 'app/repositories/bookings-repository.js',
      startLine: 57,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:listBookings`,
        serviceName: 'sample-management-api',
        sdkName: '@sample/management-api-client',
        method: 'PERFORMAPIREQUEST',
        protocol: 'http',
        dispatchMethod: 'listCompanyBookings',
      },
    });
    await insertNode({
      id: `${REPO_HASH}:ext:plain.get`,
      type: 'external_call',
      name: 'svc.get',
      filePath: 'src/plain.ts',
      startLine: 1,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:plain`,
        serviceName: 'svc',
        method: 'get',
        protocol: 'http',
      },
    });

    const calls = await repo.getExternalCalls([REPO_HASH]);
    const dyn = calls.find((c) => c.id === `${REPO_HASH}:ext:mgmt.performApiRequest`);
    const plain = calls.find((c) => c.id === `${REPO_HASH}:ext:plain.get`);
    expect(dyn?.dispatchMethod).toBe('listCompanyBookings');
    expect(plain?.dispatchMethod).toBeUndefined();
  });
});

describe('getExternalCalls — service filter matches the effective target', () => {
  // A profile may put a client/SDK identity — or a single authored label for the
  // whole backend — in `serviceName` while emitting the real destination in
  // `targetService`. Filtering on serviceName alone returned nothing for those rows.
  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:ext:admin.listHolidays`,
      type: 'external_call',
      name: 'acme-backend.GET',
      filePath: 'src/components/Holidays/holidayApiUtils.ts',
      startLine: 54,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:listHolidaysGroups`,
        serviceName: 'acme-backend',
        targetService: 'client-admin-api',
        method: 'GET',
        protocol: 'http',
      },
    });
    // A legacy row with no targetService at all — must stay reachable by serviceName.
    await insertNode({
      id: `${REPO_HASH}:ext:legacy.get`,
      type: 'external_call',
      name: 'billing.get',
      filePath: 'src/legacy.ts',
      startLine: 3,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:legacyCaller`,
        serviceName: 'billing',
        method: 'get',
        protocol: 'http',
      },
    });
  });

  it('finds a call by its targetService even when serviceName is an unrelated label', async () => {
    const calls = await repo.getExternalCalls([REPO_HASH], 'client-admin-api');
    expect(calls.map((c) => c.id)).toEqual([`${REPO_HASH}:ext:admin.listHolidays`]);
  });

  it('does not match the client label that shadowed the real target', async () => {
    const calls = await repo.getExternalCalls([REPO_HASH], 'acme-backend');
    expect(calls).toHaveLength(0);
  });

  it('still matches serviceName on rows that carry no targetService', async () => {
    const calls = await repo.getExternalCalls([REPO_HASH], 'billing');
    expect(calls.map((c) => c.id)).toEqual([`${REPO_HASH}:ext:legacy.get`]);
  });

  it('matches the repo a call resolves to even when its targetService is a logical name', async () => {
    await insertNode({ id: 'corehash0001', type: 'repository', name: 'day-core', filePath: '' });
    await insertNode({
      id: 'corehash0001:entrypoint:get-profiles',
      type: 'entrypoint',
      name: 'POST /profiles',
      filePath: 'src/profiles.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:ext:core.getProfiles`,
      type: 'external_call',
      name: 'core.POST',
      filePath: 'src/core.ts',
      startLine: 7,
      repoId: REPO_HASH,
      properties: {
        callerId: `${REPO_HASH}:fn:getProfiles`,
        serviceName: 'dayio-api-client',
        targetService: 'core',
        protocol: 'http',
        resolvedTargetId: 'corehash0001:entrypoint:get-profiles',
      },
    });

    for (const name of ['core', 'day-core']) {
      const calls = await repo.getExternalCalls([REPO_HASH], name);
      expect(calls.map((c) => c.id)).toEqual([`${REPO_HASH}:ext:core.getProfiles`]);
    }
  });
});

describe('SqliteRepository.getExternalCallsWithMessaging', () => {
  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:fn:publishEvent`,
      type: 'function',
      name: 'publishEvent',
      filePath: 'src/producer.ts',
      startLine: 40,
    });
    // A messaging producer and a plain HTTP call — only the former has a destination.
    await insertNode({
      id: `${REPO_HASH}:ext:kafka.send`,
      type: 'external_call',
      name: 'kafka.send',
      filePath: 'src/producer.ts',
      startLine: 42,
      properties: {
        callerId: `${REPO_HASH}:fn:publishEvent`,
        serviceName: 'kafka',
        method: 'send',
        protocol: 'messaging',
        messagingSystem: 'gcp-pubsub',
        messagingDestination: 'user-events',
        messagingDestinationRef: 'Topics.USER_EVENTS',
      },
    });
    await insertNode({
      id: `${REPO_HASH}:ext:http.get`,
      type: 'external_call',
      name: 'svc.get',
      filePath: 'src/client.ts',
      startLine: 7,
      properties: {
        callerId: `${REPO_HASH}:fn:publishEvent`,
        serviceName: 'svc',
        method: 'get',
        protocol: 'http',
      },
    });
  });

  it('returns only calls with a destination (filtered in SQL), projected narrow', async () => {
    const calls = await repo.getExternalCallsWithMessaging([REPO_HASH]);

    expect(calls).toEqual([
      {
        id: `${REPO_HASH}:ext:kafka.send`,
        callerName: 'publishEvent',
        filePath: 'src/producer.ts',
        startLine: 42,
        system: 'gcp-pubsub',
        destination: 'user-events',
        destinationRef: 'Topics.USER_EVENTS',
      },
    ]);
  });

  it('empty repoHashes spans all repos; a non-matching hash returns nothing', async () => {
    expect(await repo.getExternalCallsWithMessaging([])).toHaveLength(1);
    expect(await repo.getExternalCallsWithMessaging(['ffffffffffff'])).toEqual([]);
  });

  // A row with no persisted messagingDestination is not a messaging producer at
  // all now — the graph must be re-parsed rather than reinterpreted on read.
  it('ignores rows that carry no persisted messaging destination', async () => {
    await insertNode({
      id: `${REPO_HASH}:ext:legacy.publish`,
      type: 'external_call',
      name: 'pubsub.publish',
      filePath: 'src/legacy.ts',
      startLine: 9,
      properties: {
        callerId: `${REPO_HASH}:fn:publishEvent`,
        serviceName: 'gcp-pubsub',
        protocol: 'messaging',
      },
    });

    const calls = await repo.getExternalCallsWithMessaging([REPO_HASH]);
    expect(calls.find((call) => call.filePath === 'src/legacy.ts')).toBeUndefined();
  });

  it("falls back to callerName 'unknown' when the caller node is missing", async () => {
    await insertNode({
      id: `${REPO_HASH}:ext:kafka.orphan`,
      type: 'external_call',
      name: 'kafka.orphan',
      filePath: 'src/orphan.ts',
      startLine: 3,
      properties: { callerId: `${REPO_HASH}:fn:gone`, messagingDestination: 'orphan-topic' },
    });

    const calls = await repo.getExternalCallsWithMessaging([REPO_HASH]);
    const orphan = calls.find((c) => c.destination === 'orphan-topic');
    expect(orphan?.callerName).toBe('unknown');
    // The row carries no messagingSystem, and none is inferred on read — it
    // surfaces as systemless so a stale graph is visible rather than guessed at.
    expect(orphan?.system).toBeUndefined();
  });
});

describe('SqliteRepository.getRepositoryNames', () => {
  const OTHER_HASH = 'fedcba654321';

  beforeEach(async () => {
    // Repository node ids ARE the hash (no `:type:…` suffix) — the contract
    // listAllRepositories documents.
    await insertNode({ id: REPO_HASH, type: 'repository', name: 'billing-api', filePath: '', repoId: REPO_HASH });
    await insertNode({
      id: OTHER_HASH,
      type: 'repository',
      name: 'notification-svc',
      filePath: '',
      repoId: OTHER_HASH,
    });
  });

  it('returns {hash, name} rows for all repos when repoHashes is empty', async () => {
    const rows = await repo.getRepositoryNames([]);

    expect(rows).toHaveLength(2);
    expect(new Map(rows.map((r) => [r.hash, r.name]))).toEqual(
      new Map([
        [REPO_HASH, 'billing-api'],
        [OTHER_HASH, 'notification-svc'],
      ]),
    );
  });

  it('filters to the given hashes', async () => {
    const rows = await repo.getRepositoryNames([OTHER_HASH]);

    expect(rows).toEqual([{ hash: OTHER_HASH, name: 'notification-svc' }]);
  });
});

describe('SqliteRepository.getResolvesEdge', () => {
  const SRC_ID = 'h-web:external_call:src/api.ts:fetchUser:1';
  const TGT_ID = 'h-users:entrypoint:src/users.ts:GET:/users/:id';
  const EDGE_ID = `resolve:${SRC_ID}:${TGT_ID}`;

  const chain = [
    {
      kind: 'symbol',
      sourceId: SRC_ID,
      targetId: 'h-sdk:function:src/client.ts:getById',
      via: 'moniker',
      confidence: 1,
    },
    {
      kind: 'protocol',
      sourceId: 'h-sdk:function:src/client.ts:getById',
      targetId: TGT_ID,
      via: 'http',
      confidence: 1,
    },
  ];

  beforeEach(async () => {
    await insertNode({
      id: SRC_ID,
      type: 'external_call',
      name: 'fetchUser',
      filePath: 'src/api.ts',
      properties: { protocol: 'http' },
      repoId: 'h-web',
    });
    await insertNode({
      id: TGT_ID,
      type: 'entrypoint',
      name: 'getUser',
      filePath: 'src/users.ts',
      properties: { entrypointType: 'http' },
      repoId: 'h-users',
    });
    await insertEdge({
      id: EDGE_ID,
      type: 'RESOLVES_TO',
      sourceId: SRC_ID,
      targetId: TGT_ID,
      properties: { via: 'http', chain, sourceRepoName: 'web', targetRepoName: 'users-svc', confidenceLevel: 'exact' },
    });
  });

  it('returns the resolved end-edge with parsed chain provenance', async () => {
    const edge = await repo.getResolvesEdge(SRC_ID);
    expect(edge).not.toBeNull();
    expect(edge!.id).toBe(EDGE_ID);
    expect(edge!.targetId).toBe(TGT_ID);
    expect(edge!.via).toBe('http');
    expect(edge!.sourceRepoName).toBe('web');
    expect(edge!.targetRepoName).toBe('users-svc');
    expect(edge!.confidenceLevel).toBe('exact');
    expect(edge!.chain).toHaveLength(2);
    expect(edge!.chain![0]).toMatchObject({ kind: 'symbol', via: 'moniker' });
    expect(edge!.chain![1]).toMatchObject({ kind: 'protocol', via: 'http' });
  });

  it('returns null when no RESOLVES_TO edge exists for the source call', async () => {
    const edge = await repo.getResolvesEdge('h-web:external_call:src/api.ts:nope:9');
    expect(edge).toBeNull();
  });
});

describe('SqliteRepository.getPackageLinkerFacts', () => {
  it('projects package files, unresolved named imports, and exported top-level declarations only', async () => {
    const sourceId = `${REPO_HASH}:file:src/use-booking.ts`;
    const declarationFileId = `${REPO_HASH}:file:src/enums.ts`;
    await insertNode({
      id: sourceId,
      type: 'file',
      name: 'src/use-booking.ts',
      filePath: 'src/use-booking.ts',
      properties: {
        path: 'src/use-booking.ts',
        packageId: `${REPO_HASH}:package:consumer`,
        target: 'api',
        packageImports: [
          {
            id: 'import-booking-types',
            moduleSpecifier: '@acme/acme-api-client',
            isTypeOnly: true,
            importKind: 'named',
            importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
          },
        ],
      },
    });
    await insertNode({
      id: declarationFileId,
      type: 'file',
      name: 'src/enums.ts',
      filePath: 'src/enums.ts',
      properties: { path: 'src/enums.ts', packageId: `${REPO_HASH}:package:provider` },
    });
    await insertNode({
      id: `${REPO_HASH}:file:src/unrelated.ts`,
      type: 'file',
      name: 'src/unrelated.ts',
      filePath: 'src/unrelated.ts',
      properties: { path: 'src/unrelated.ts', packageId: `${REPO_HASH}:package:consumer` },
    });
    await insertNode({
      id: `${REPO_HASH}:enum:src/enums.ts:BookingTypes`,
      type: 'enum',
      name: 'BookingTypes',
      filePath: 'src/enums.ts',
      properties: { fileId: declarationFileId, isExported: true },
    });
    await insertNode({
      id: `${REPO_HASH}:enum:src/enums.ts:PrivateType`,
      type: 'enum',
      name: 'PrivateType',
      filePath: 'src/enums.ts',
      properties: { fileId: declarationFileId, isExported: false },
    });
    await insertNode({
      id: `${REPO_HASH}:method:src/enums.ts:Client.getBooking`,
      type: 'function',
      name: 'getBooking',
      filePath: 'src/enums.ts',
      properties: { fileId: declarationFileId, kind: 'method', isExported: true },
    });

    const facts = await repo.getPackageLinkerFacts([REPO_HASH]);

    expect(facts.files).toEqual([
      {
        id: declarationFileId,
        path: 'src/enums.ts',
        packageId: `${REPO_HASH}:package:provider`,
        imports: [],
      },
      {
        id: sourceId,
        path: 'src/use-booking.ts',
        packageId: `${REPO_HASH}:package:consumer`,
        target: 'api',
        imports: [
          {
            id: 'import-booking-types',
            moduleSpecifier: '@acme/acme-api-client',
            isTypeOnly: true,
            importKind: 'named',
            importedNames: [{ name: 'BookingTypes', alias: 'BookingKind' }],
          },
        ],
      },
    ]);
    expect(facts.declarations).toEqual([
      {
        id: `${REPO_HASH}:enum:src/enums.ts:BookingTypes`,
        name: 'BookingTypes',
        fileId: declarationFileId,
        kind: 'enum',
        isExported: true,
      },
    ]);
  });
});

describe('SqliteRepository.getMonikeredFunctions', () => {
  it('returns function nodes that carry monikerPackage, with moniker populated', async () => {
    // SDK-source repo with one monikered export
    const HASH = 'sdk1aabbccdd';
    await insertNode({
      id: `${HASH}:function:src/client.ts:getUser`,
      type: 'function',
      name: 'getUser',
      filePath: 'src/client.ts',
      repoId: HASH,
      startLine: 10,
      endLine: 20,
      properties: {
        kind: 'method',
        isExported: true,
        isAsync: false,
        monikerPackage: '@example/sdk-client',
        monikerDescriptor: 'Client#getUser().',
      },
    });

    // A sibling function WITHOUT a moniker — must be excluded
    await insertNode({
      id: `${HASH}:function:src/client.ts:internalHelper`,
      type: 'function',
      name: 'internalHelper',
      filePath: 'src/client.ts',
      repoId: HASH,
      startLine: 30,
      endLine: 35,
      properties: { kind: 'function', isAsync: false },
    });

    const fns = await repo.getMonikeredFunctions([HASH]);

    expect(fns).toHaveLength(1);
    expect(fns[0]).toMatchObject({
      id: `${HASH}:function:src/client.ts:getUser`,
      name: 'getUser',
      moniker: {
        packageName: '@example/sdk-client',
        descriptor: 'Client#getUser().',
      },
    });
  });

  it('returns empty array when no functions carry a moniker', async () => {
    const HASH = 'nomoniker1234';
    await insertNode({
      id: `${HASH}:function:src/utils.ts:helper`,
      type: 'function',
      name: 'helper',
      filePath: 'src/utils.ts',
      repoId: HASH,
      startLine: 1,
      endLine: 5,
      properties: { kind: 'function', isAsync: false },
    });

    const fns = await repo.getMonikeredFunctions([HASH]);
    expect(fns).toHaveLength(0);
  });

  it('returns empty array when repoHashes is empty', async () => {
    const fns = await repo.getMonikeredFunctions([]);
    expect(fns).toHaveLength(0);
  });

  it('scopes results to the requested repo hashes only', async () => {
    const HASH_A = 'repoabc111222';
    const HASH_B = 'repoxyz333444';

    await insertNode({
      id: `${HASH_A}:function:src/a.ts:methodA`,
      type: 'function',
      name: 'methodA',
      filePath: 'src/a.ts',
      repoId: HASH_A,
      startLine: 1,
      endLine: 5,
      properties: {
        kind: 'method',
        isAsync: false,
        monikerPackage: '@pkg/a',
        monikerDescriptor: 'A#methodA().',
      },
    });

    await insertNode({
      id: `${HASH_B}:function:src/b.ts:methodB`,
      type: 'function',
      name: 'methodB',
      filePath: 'src/b.ts',
      repoId: HASH_B,
      startLine: 1,
      endLine: 5,
      properties: {
        kind: 'method',
        isAsync: false,
        monikerPackage: '@pkg/b',
        monikerDescriptor: 'B#methodB().',
      },
    });

    // Request only HASH_A — HASH_B's method must not appear
    const fns = await repo.getMonikeredFunctions([HASH_A]);
    expect(fns).toHaveLength(1);
    expect(fns[0]!.name).toBe('methodA');
  });
});

describe('SqliteRepository.getEmbeddedNodes', () => {
  it('updates an embedding without replacing the existing summary', async () => {
    const HASH = 'embupdate123';
    const id = `${HASH}:function:src/auth.ts:rotateToken`;
    await insertNode({
      id,
      type: 'function',
      name: 'rotateToken',
      filePath: 'src/auth.ts',
      repoId: HASH,
      summary: 'Keep this summary',
      properties: { purpose: 'Rotate credentials' },
    });

    const result = await repo.applyChangeset({
      repoId: HASH,
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      nodeMetadataUpdates: [
        {
          id,
          embedding: [0.4, 0.6],
          properties: { embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' },
        },
      ],
    });

    expect(result.nodesUpdated).toBe(1);
    expect(await repo.getEmbeddedNodes([HASH])).toEqual([
      expect.objectContaining({
        id,
        summary: 'Keep this summary',
        embedding: [0.4, 0.6],
        embeddingProvider: 'ollama',
        embeddingModel: 'nomic-embed-text',
      }),
    ]);
  });

  it('returns only embedded nodes, with parsed vector and provenance props', async () => {
    const HASH = 'emb1aabbccdd';
    await insertNode({
      id: `${HASH}:function:src/auth.ts:rotateToken`,
      type: 'function',
      name: 'rotateToken',
      filePath: 'src/auth.ts',
      repoId: HASH,
      startLine: 42,
      summary: 'Rotates the refresh token',
      embedding: [0.1, 0.2, 0.3],
      properties: {
        embeddingProvider: 'ollama',
        embeddingModel: 'qwen3-embedding:4b',
        embeddingDimensions: 3,
      },
    });
    // A sibling WITHOUT an embedding — must be excluded
    await insertNode({
      id: `${HASH}:function:src/auth.ts:helper`,
      type: 'function',
      name: 'helper',
      filePath: 'src/auth.ts',
      repoId: HASH,
      startLine: 60,
    });

    const nodes = await repo.getEmbeddedNodes([HASH]);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      id: `${HASH}:function:src/auth.ts:rotateToken`,
      name: 'rotateToken',
      type: 'function',
      filePath: 'src/auth.ts',
      startLine: 42,
      summary: 'Rotates the refresh token',
      embedding: [0.1, 0.2, 0.3],
      embeddingProvider: 'ollama',
      embeddingModel: 'qwen3-embedding:4b',
    });
  });

  it('empty repoHashes = all repos (cross-repo convention)', async () => {
    const HASH_A = 'embaaa111222';
    const HASH_B = 'embbbb333444';
    await insertNode({
      id: `${HASH_A}:function:src/a.ts:fnA`,
      type: 'function',
      name: 'fnA',
      filePath: 'src/a.ts',
      repoId: HASH_A,
      embedding: [1, 0],
      properties: { embeddingProvider: 'ollama', embeddingModel: 'm' },
    });
    await insertNode({
      id: `${HASH_B}:entrypoint:src/b.ts:epB`,
      type: 'entrypoint',
      name: 'epB',
      filePath: 'src/b.ts',
      repoId: HASH_B,
      embedding: [0, 1],
      properties: { embeddingProvider: 'ollama', embeddingModel: 'm' },
    });

    const all = await repo.getEmbeddedNodes([]);
    expect(all).toHaveLength(2);

    const scoped = await repo.getEmbeddedNodes([HASH_A]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.name).toBe('fnA');
  });

  it('returns empty array (not an error) when nothing is embedded', async () => {
    const nodes = await repo.getEmbeddedNodes(['noembeds12345']);
    expect(nodes).toEqual([]);
  });
});

describe('SqliteRepository.getCoverageCounts', () => {
  const HASH = 'cov1aabbccdd';

  /** Seed one repo: 2 entities (1 operated on), 3 functions (1 calling), 2 external calls (1 resolved via RESOLVES_TO edge). */
  async function seedCoverageRepo(hash: string, name: string): Promise<void> {
    await insertNode({ id: hash, type: 'repository', name, filePath: '', repoId: hash });
    await insertNode({
      id: `${hash}:entity:src/user.ts:User`,
      type: 'entity',
      name: 'User',
      filePath: 'src/user.ts',
      repoId: hash,
    });
    await insertNode({
      id: `${hash}:entity:src/order.ts:Order`,
      type: 'entity',
      name: 'Order',
      filePath: 'src/order.ts',
      repoId: hash,
    });
    await insertNode({
      id: `${hash}:function:src/a.ts:createUser`,
      type: 'function',
      name: 'createUser',
      filePath: 'src/a.ts',
      repoId: hash,
    });
    await insertNode({
      id: `${hash}:function:src/a.ts:helperFn`,
      type: 'function',
      name: 'helperFn',
      filePath: 'src/a.ts',
      repoId: hash,
    });
    await insertNode({
      id: `${hash}:function:src/b.ts:orphanFn`,
      type: 'function',
      name: 'orphanFn',
      filePath: 'src/b.ts',
      repoId: hash,
    });
    await insertNode({
      id: `${hash}:external_call:src/a.ts:10`,
      type: 'external_call',
      name: 'postUser',
      filePath: 'src/a.ts',
      repoId: hash,
      properties: { serviceName: 'billing' },
    });
    await insertNode({
      id: `${hash}:external_call:src/a.ts:20`,
      type: 'external_call',
      name: 'sendEvent',
      filePath: 'src/a.ts',
      repoId: hash,
      properties: { serviceName: 'events' },
    });
    // createUser OPERATES_ON User (User covered, Order not)
    await insertEdge({
      id: `${hash}:edge:op-1`,
      type: 'OPERATES_ON',
      sourceId: `${hash}:function:src/a.ts:createUser`,
      targetId: `${hash}:entity:src/user.ts:User`,
      properties: { operation: 'create' },
    });
    // createUser CALLS helperFn twice (distinct count must stay 1) — helperFn/orphanFn call nothing
    await insertEdge({
      id: `${hash}:edge:call-1`,
      type: 'CALLS',
      sourceId: `${hash}:function:src/a.ts:createUser`,
      targetId: `${hash}:function:src/a.ts:helperFn`,
    });
    await insertEdge({
      id: `${hash}:edge:call-2`,
      type: 'CALLS',
      sourceId: `${hash}:function:src/a.ts:createUser`,
      targetId: `${hash}:function:src/b.ts:orphanFn`,
    });
    // postUser RESOLVES_TO an entrypoint (the durable resolution signal); sendEvent stays unresolved.
    await insertEdge({
      id: `${hash}:edge:res-1`,
      type: 'RESOLVES_TO',
      sourceId: `${hash}:external_call:src/a.ts:10`,
      targetId: `${hash}:entrypoint:http:POST:/users`,
    });
  }

  it('returns per-repo counts: node kinds, dbOp-covered entities, calling functions, external calls', async () => {
    await seedCoverageRepo(HASH, 'cov-repo');

    const counts = await repo.getCoverageCounts([HASH]);

    expect(counts).toHaveLength(1);
    expect(counts[0]).toEqual({
      repoName: 'cov-repo',
      nodeCountsByType: { entity: 2, function: 3, external_call: 2 },
      entityCount: 2,
      entitiesWithDbOps: 1,
      functionCount: 3,
      functionsWithCalls: 1,
      externalCallCount: 2,
      resolvedExternalCallCount: 1,
    });
  });

  it('scopes to the requested repo and supports empty repoHashes = all repos', async () => {
    const HASH_B = 'cov2eeff0011';
    await seedCoverageRepo(HASH, 'cov-repo');
    await insertNode({ id: HASH_B, type: 'repository', name: 'other-repo', filePath: '', repoId: HASH_B });
    await insertNode({
      id: `${HASH_B}:function:src/x.ts:fnX`,
      type: 'function',
      name: 'fnX',
      filePath: 'src/x.ts',
      repoId: HASH_B,
    });

    const scoped = await repo.getCoverageCounts([HASH_B]);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      repoName: 'other-repo',
      nodeCountsByType: { function: 1 },
      entityCount: 0,
      entitiesWithDbOps: 0,
      functionCount: 1,
      functionsWithCalls: 0,
      externalCallCount: 0,
      resolvedExternalCallCount: 0,
    });

    const all = await repo.getCoverageCounts([]);
    expect(all).toHaveLength(2);
  });

  it('returns empty array (not an error) when no repository matches', async () => {
    expect(await repo.getCoverageCounts(['missing123456'])).toEqual([]);
  });

  it('counts resolved external calls by RESOLVES_TO edge, not the clobber-prone resolvedTargetId property', async () => {
    // Real-world state after a re-push: the linker wrote RESOLVES_TO edges, but a
    // subsequent `coredoc push` full-replaced the node properties, wiping
    // resolvedTargetId. The durable signal is the edge — resolution must count it.
    const H = 'covedge01aabb';
    await insertNode({ id: H, type: 'repository', name: 'edge-repo', filePath: '', repoId: H });
    // callA: resolved via RESOLVES_TO edge, but its property was clobbered (absent).
    await insertNode({
      id: `${H}:external_call:src/a.ts:10`,
      type: 'external_call',
      name: 'callA',
      filePath: 'src/a.ts',
      repoId: H,
      properties: { serviceName: 'svc' },
    });
    await insertEdge({
      id: `${H}:edge:res-1`,
      type: 'RESOLVES_TO',
      sourceId: `${H}:external_call:src/a.ts:10`,
      targetId: `${H}:entrypoint:http:POST:/x`,
    });
    // callB: unresolved (no edge).
    await insertNode({
      id: `${H}:external_call:src/a.ts:20`,
      type: 'external_call',
      name: 'callB',
      filePath: 'src/a.ts',
      repoId: H,
      properties: { serviceName: 'svc' },
    });

    const counts = await repo.getCoverageCounts([H]);
    expect(counts[0]).toMatchObject({ externalCallCount: 2, resolvedExternalCallCount: 1 });
  });
});

describe('SqliteRepository.findEntity / listEntities (DB structure round-trip)', () => {
  const userFields = [
    {
      name: 'id',
      columnName: 'id',
      type: { text: 'string' },
      dbType: 'uuid',
      isPrimaryKey: true,
      isNullable: false,
      isUnique: true,
      isGenerated: true,
    },
    {
      name: 'email',
      columnName: 'email_address',
      type: { text: 'string' },
      isPrimaryKey: false,
      isNullable: false,
      isUnique: true,
      isGenerated: false,
    },
  ];
  const userRelations = [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post', joinColumn: 'user_id' }];

  beforeEach(async () => {
    await insertNode({
      id: `${REPO_HASH}:entity:src/user.ts:User`,
      type: 'entity',
      name: 'User',
      filePath: 'src/user.ts',
      properties: { ormType: 'typeorm', tableName: 'users', fields: userFields, relations: userRelations },
    });
    await insertNode({
      id: `${REPO_HASH}:entity:src/post.ts:Post`,
      type: 'entity',
      name: 'Post',
      filePath: 'src/post.ts',
      properties: { ormType: 'typeorm', tableName: 'posts', fields: [], relations: [] },
    });
  });

  it('findEntity returns columns and relations from the properties blob', async () => {
    const entity = await repo.findEntity('User', [REPO_HASH]);
    expect(entity).not.toBeNull();
    expect(entity!.tableName).toBe('users');
    expect(entity!.fields).toEqual(userFields);
    expect(entity!.relations).toEqual(userRelations);
  });

  it('findEntity resolves by table name too', async () => {
    const entity = await repo.findEntity('users', [REPO_HASH]);
    expect(entity?.name).toBe('User');
  });

  it('listEntities returns every entity in scope with its schema', async () => {
    const entities = await repo.listEntities([REPO_HASH]);
    expect(entities.map((e) => e.name).sort()).toEqual(['Post', 'User']);
    const user = entities.find((e) => e.name === 'User');
    expect(user!.fields).toEqual(userFields);
  });

  it('listEntities scopes by repo hash', async () => {
    const entities = await repo.listEntities(['nonexistenthash']);
    expect(entities).toEqual([]);
  });
});

describe('SqliteRepository.findClass / findInterface (field read-back)', () => {
  it('findClass returns persisted properties (from properties_)', async () => {
    const props = [
      { name: 'url', typeText: 'string', isOptional: false, visibility: 'public' },
      { name: 'token', typeText: 'string', isReadonly: true },
    ];
    await insertNode({
      id: `${REPO_HASH}:class:src/dto.ts:CreateWebhookDto`,
      type: 'class',
      name: 'CreateWebhookDto',
      filePath: 'src/dto.ts',
      properties: { isExported: true, isAbstract: false, properties_: props },
    });

    const cls = await repo.findClass('CreateWebhookDto', [REPO_HASH]);
    expect(cls).not.toBeNull();
    expect(cls!.properties).toEqual(props);
  });

  it('findInterface returns persisted members', async () => {
    const members = [
      { name: 'id', kind: 'property', typeText: 'string', isOptional: false },
      { name: 'compute', kind: 'method', returnTypeText: 'number' },
    ];
    await insertNode({
      id: `${REPO_HASH}:interface:src/types.ts:Computable`,
      type: 'interface',
      name: 'Computable',
      filePath: 'src/types.ts',
      properties: { isExported: true, members },
    });

    const iface = await repo.findInterface('Computable', [REPO_HASH]);
    expect(iface).not.toBeNull();
    expect(iface!.members).toEqual(members);
  });

  it('findEnum returns persisted members (values)', async () => {
    const members = [{ name: 'ShiftsPublished', value: 'shifts:published' }, { name: 'Auto' }];
    await insertNode({
      id: `${REPO_HASH}:enum:src/events.ts:EventType`,
      type: 'enum',
      name: 'EventType',
      filePath: 'src/events.ts',
      properties: { isExported: true, members },
    });

    const en = await repo.findEnum('EventType', [REPO_HASH]);
    expect(en).not.toBeNull();
    expect(en!.members).toEqual(members);
  });

  it('findTypeAlias returns the aliased type text', async () => {
    await insertNode({
      id: `${REPO_HASH}:type_alias:src/types.ts:Status`,
      type: 'type_alias',
      name: 'Status',
      filePath: 'src/types.ts',
      properties: { isExported: true, aliasedTypeText: "'active' | 'inactive'" },
    });

    const ta = await repo.findTypeAlias('Status', [REPO_HASH]);
    expect(ta).not.toBeNull();
    expect(ta!.aliasedTypeText).toBe("'active' | 'inactive'");
  });
});

// ===========================================================================
// Tier B — graph explorer (getNodesByIds / getNeighborCounts / getNeighbors)
// ===========================================================================

const REPO2_HASH = 'fed654cba321';

/**
 * A small realistic fixture centered on function F:
 *   E --CALLS--> F,  F --CALLS--> G,  F --CALLS(ai,0.6)--> H,
 *   F --MAKES_EXTERNAL_CALL--> XC(kafka)
 *   REPO --CONTAINS_PACKAGE--> P
 * Repository node is inserted with repo_id NULL (production contract) to
 * exercise the COALESCE(repo_id, id) repoName join.
 */
async function seedExplorerGraph(): Promise<void> {
  // Repository node: id IS the hash, repo_id NULL — inserted directly since the
  // insertNode helper derives a non-null repo_id from the id prefix.
  await driver.withWriteTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
       VALUES (@id, 'repository', 'gateway', NULL, NULL, '{}', NULL)`,
      { id: REPO_HASH },
    );
  });
  await insertNode({
    id: `${REPO_HASH}:package:packages/svc:svc`,
    type: 'package',
    name: 'svc',
    filePath: 'packages/svc',
  });
  await insertNode({
    id: `${REPO_HASH}:function:src/svc.ts:handleRequest`,
    type: 'function',
    name: 'handleRequest',
    filePath: 'src/svc.ts',
    startLine: 10,
    endLine: 30,
    summary: 'Handles the request',
    properties: { kind: 'method', isAsync: true },
  });
  await insertNode({
    id: `${REPO_HASH}:function:src/svc.ts:validate`,
    type: 'function',
    name: 'validate',
    filePath: 'src/svc.ts',
    startLine: 40,
  });
  await insertNode({
    id: `${REPO_HASH}:function:src/util.ts:log`,
    type: 'function',
    name: 'log',
    filePath: 'src/util.ts',
    startLine: 5,
  });
  await insertNode({
    id: `${REPO_HASH}:function:src/route.ts:route`,
    type: 'function',
    name: 'route',
    filePath: 'src/route.ts',
    startLine: 8,
  });
  await insertNode({
    id: `${REPO_HASH}:entrypoint:src/route.ts:GET /users`,
    type: 'entrypoint',
    name: 'GET /users',
    filePath: 'src/route.ts',
    startLine: 8,
    properties: { method: 'GET', entrypointType: 'http' },
  });
  await insertNode({
    id: `${REPO_HASH}:external_call:src/svc.ts:fetchOrders`,
    type: 'external_call',
    name: 'fetchOrders',
    filePath: 'src/svc.ts',
    startLine: 22,
    properties: { protocol: 'messaging', serviceName: 'orders' },
  });

  const F = `${REPO_HASH}:function:src/svc.ts:handleRequest`;
  await insertEdge({
    id: `${REPO_HASH}:edge:e1`,
    type: 'CALLS',
    sourceId: `${REPO_HASH}:function:src/route.ts:route`,
    targetId: F,
    properties: { line: 9 },
  });
  await insertEdge({
    id: `${REPO_HASH}:edge:e2`,
    type: 'CALLS',
    sourceId: F,
    targetId: `${REPO_HASH}:function:src/svc.ts:validate`,
  });
  await insertEdge({
    id: `${REPO_HASH}:edge:e3`,
    type: 'CALLS',
    sourceId: F,
    targetId: `${REPO_HASH}:function:src/util.ts:log`,
    confidence: 0.6,
    createdBy: 'ai',
  });
  await insertEdge({
    id: `${REPO_HASH}:edge:e4`,
    type: 'MAKES_EXTERNAL_CALL',
    sourceId: F,
    targetId: `${REPO_HASH}:external_call:src/svc.ts:fetchOrders`,
  });
  await insertEdge({
    id: `${REPO_HASH}:edge:e5`,
    type: 'CONTAINS_PACKAGE',
    sourceId: REPO_HASH,
    targetId: `${REPO_HASH}:package:packages/svc:svc`,
  });
}

describe('SqliteRepository.getNodesByIds', () => {
  it('projects nodes to VizNode with repoName resolved and type-specific badges', async () => {
    await seedExplorerGraph();
    const rows = await repo.getNodesByIds(
      [
        `${REPO_HASH}:function:src/svc.ts:handleRequest`,
        `${REPO_HASH}:entrypoint:src/route.ts:GET /users`,
        `${REPO_HASH}:external_call:src/svc.ts:fetchOrders`,
      ],
      [REPO_HASH],
    );
    const byId = new Map(rows.map((n) => [n.id, n]));
    expect(rows).toHaveLength(3);

    const fn = byId.get(`${REPO_HASH}:function:src/svc.ts:handleRequest`)!;
    expect(fn).toMatchObject({
      type: 'function',
      name: 'handleRequest',
      repoName: 'gateway',
      filePath: 'src/svc.ts',
      startLine: 10,
      summary: 'Handles the request',
    });
    expect(fn.badge).toBeUndefined();

    expect(byId.get(`${REPO_HASH}:entrypoint:src/route.ts:GET /users`)!.badge).toBe('GET');
    expect(byId.get(`${REPO_HASH}:external_call:src/svc.ts:fetchOrders`)!.badge).toBe('messaging');
  });

  it('excludes ids outside repoHashes and silently drops missing ids', async () => {
    await seedExplorerGraph();
    await insertNode({
      id: `${REPO2_HASH}:function:x.ts:other`,
      type: 'function',
      name: 'other',
      filePath: 'x.ts',
      repoId: REPO2_HASH,
    });

    const rows = await repo.getNodesByIds(
      [
        `${REPO2_HASH}:function:x.ts:other`,
        `${REPO_HASH}:function:does/not:exist`,
        `${REPO_HASH}:function:src/svc.ts:validate`,
      ],
      [REPO_HASH],
    );
    expect(rows.map((n) => n.name)).toEqual(['validate']);
  });
});

describe('SqliteRepository.getNeighborCounts', () => {
  it('tallies edges by (edgeType, direction) around the focus node', async () => {
    await seedExplorerGraph();
    const counts = await repo.getNeighborCounts(`${REPO_HASH}:function:src/svc.ts:handleRequest`, [REPO_HASH]);
    expect(counts).toEqual(
      expect.arrayContaining([
        { edgeType: 'CALLS', direction: 'out', count: 2 },
        { edgeType: 'CALLS', direction: 'in', count: 1 },
        { edgeType: 'MAKES_EXTERNAL_CALL', direction: 'out', count: 1 },
      ]),
    );
    expect(counts).toHaveLength(3);
  });

  it('returns an empty array for a node with no edges', async () => {
    await seedExplorerGraph();
    const counts = await repo.getNeighborCounts(`${REPO_HASH}:function:src/svc.ts:validate`, [REPO_HASH]);
    // validate is only a CALLS target (incoming), so it has exactly one group.
    expect(counts).toEqual([{ edgeType: 'CALLS', direction: 'in', count: 1 }]);
  });
});

describe('SqliteRepository.getNeighbors', () => {
  const F = `${REPO_HASH}:function:src/svc.ts:handleRequest`;

  it('expands outgoing CALLS with viz edges carrying confidence + provenance', async () => {
    await seedExplorerGraph();
    const page = await repo.getNeighbors(F, { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 200 }, [REPO_HASH]);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.nodes.map((n) => n.name).sort()).toEqual(['log', 'validate']);

    const aiEdge = page.edges.find((e) => e.targetId === `${REPO_HASH}:function:src/util.ts:log`)!;
    expect(aiEdge).toMatchObject({ type: 'CALLS', confidence: 0.6, createdBy: 'ai', sourceId: F });
    const parserEdge = page.edges.find((e) => e.targetId === `${REPO_HASH}:function:src/svc.ts:validate`)!;
    expect(parserEdge).toMatchObject({ confidence: 1, createdBy: 'parser' });
  });

  it('expands incoming edges', async () => {
    await seedExplorerGraph();
    const page = await repo.getNeighbors(F, { direction: 'in', limit: 200 }, [REPO_HASH]);
    expect(page.nodes.map((n) => n.name)).toEqual(['route']);
    expect(page.edges[0]).toMatchObject({ sourceId: `${REPO_HASH}:function:src/route.ts:route`, targetId: F });
  });

  it('defaults to both directions and honors the edgeTypes filter', async () => {
    await seedExplorerGraph();
    const all = await repo.getNeighbors(F, { limit: 200 }, [REPO_HASH]);
    expect(all.nodes.map((n) => n.name).sort()).toEqual(['fetchOrders', 'log', 'route', 'validate']);

    const external = await repo.getNeighbors(
      F,
      { direction: 'out', edgeTypes: [EdgeType.MakesExternalCall], limit: 200 },
      [REPO_HASH],
    );
    expect(external.nodes.map((n) => n.name)).toEqual(['fetchOrders']);
    expect(external.nodes[0].badge).toBe('messaging');
  });

  it('keyset-paginates with a cursor and truncated flag', async () => {
    await seedExplorerGraph();
    const first = await repo.getNeighbors(F, { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 1 }, [REPO_HASH]);
    expect(first.nodes).toHaveLength(1);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await repo.getNeighbors(
      F,
      { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 1, cursor: first.nextCursor },
      [REPO_HASH],
    );
    expect(second.nodes).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    const seen = new Set([...first.nodes, ...second.nodes].map((n) => n.name));
    expect(seen).toEqual(new Set(['validate', 'log']));
  });

  it('resolves a repository node neighbor (repo_id NULL) via COALESCE', async () => {
    await seedExplorerGraph();
    const page = await repo.getNeighbors(
      `${REPO_HASH}:package:packages/svc:svc`,
      { direction: 'in', edgeTypes: [EdgeType.ContainsPackage], limit: 200 },
      [REPO_HASH],
    );
    expect(page.nodes).toHaveLength(1);
    expect(page.nodes[0]).toMatchObject({ type: 'repository', name: 'gateway', repoName: 'gateway' });
  });
});

// ===========================================================================
// Tier C — C4 view (getPackageDependencyRollup / getComponentGraph)
// ===========================================================================

/**
 * Two packages, two files (each with a `packageId`), three functions (each with
 * a `fileId`). Cross-package CALLS: f1→f2 (P1→P2, parser), f3→f2 (P1→P2, ai),
 * f2→f1 (P2→P1). Intra-package CALLS f1→f3 must be excluded from the rollup.
 */
async function seedPackageGraph(): Promise<void> {
  const P1 = `${REPO_HASH}:package:pkgA:pkgA`;
  const P2 = `${REPO_HASH}:package:pkgB:pkgB`;
  const FA = `${REPO_HASH}:file:pkgA/a.ts:a.ts`;
  const FB = `${REPO_HASH}:file:pkgB/b.ts:b.ts`;
  await insertNode({ id: P1, type: 'package', name: 'pkgA', filePath: 'pkgA', properties: { path: 'pkgA' } });
  await insertNode({ id: P2, type: 'package', name: 'pkgB', filePath: 'pkgB', properties: { path: 'pkgB' } });
  await insertNode({ id: FA, type: 'file', name: 'a.ts', filePath: 'pkgA/a.ts', properties: { packageId: P1 } });
  await insertNode({ id: FB, type: 'file', name: 'b.ts', filePath: 'pkgB/b.ts', properties: { packageId: P2 } });
  await insertNode({
    id: `${REPO_HASH}:function:pkgA/a.ts:f1`,
    type: 'function',
    name: 'f1',
    filePath: 'pkgA/a.ts',
    properties: { fileId: FA },
  });
  await insertNode({
    id: `${REPO_HASH}:function:pkgA/a.ts:f3`,
    type: 'function',
    name: 'f3',
    filePath: 'pkgA/a.ts',
    properties: { fileId: FA },
  });
  await insertNode({
    id: `${REPO_HASH}:function:pkgB/b.ts:f2`,
    type: 'function',
    name: 'f2',
    filePath: 'pkgB/b.ts',
    properties: { fileId: FB },
  });

  const f1 = `${REPO_HASH}:function:pkgA/a.ts:f1`;
  const f2 = `${REPO_HASH}:function:pkgB/b.ts:f2`;
  const f3 = `${REPO_HASH}:function:pkgA/a.ts:f3`;
  await insertEdge({ id: `${REPO_HASH}:edge:c1`, type: 'CALLS', sourceId: f1, targetId: f2 });
  await insertEdge({
    id: `${REPO_HASH}:edge:c2`,
    type: 'CALLS',
    sourceId: f3,
    targetId: f2,
    confidence: 0.5,
    createdBy: 'ai',
  });
  await insertEdge({ id: `${REPO_HASH}:edge:c3`, type: 'CALLS', sourceId: f2, targetId: f1 });
  await insertEdge({ id: `${REPO_HASH}:edge:c4`, type: 'CALLS', sourceId: f1, targetId: f3 }); // intra-P1, excluded
}

describe('SqliteRepository.getPackageDependencyRollup', () => {
  it('aggregates cross-package CALLS by package pair, excluding intra-package', async () => {
    await seedPackageGraph();
    const rollup = await repo.getPackageDependencyRollup([REPO_HASH]);

    const p1p2 = rollup.find((r) => r.sourcePackageName === 'pkgA' && r.targetPackageName === 'pkgB')!;
    expect(p1p2).toMatchObject({ callCount: 2, minConfidence: 0.5, inferred: true });
    const p2p1 = rollup.find((r) => r.sourcePackageName === 'pkgB' && r.targetPackageName === 'pkgA')!;
    expect(p2p1).toMatchObject({ callCount: 1, minConfidence: 1, inferred: false });
    // Only the two cross-package directions — the intra-P1 f1→f3 call is gone.
    expect(rollup).toHaveLength(2);
  });

  it('returns [] when there are no cross-package calls', async () => {
    await insertNode({ id: `${REPO_HASH}:package:only:only`, type: 'package', name: 'only', filePath: 'only' });
    const rollup = await repo.getPackageDependencyRollup([REPO_HASH]);
    expect(rollup).toEqual([]);
  });
});

describe('SqliteRepository.getComponentGraph', () => {
  it('returns component-level nodes and only edges whose both ends are components', async () => {
    await insertNode({
      id: `${REPO_HASH}:entrypoint:r.ts:E1`,
      type: 'entrypoint',
      name: 'E1',
      filePath: 'src/r.ts',
      startLine: 3,
      properties: { method: 'GET' },
    });
    await insertNode({
      id: `${REPO_HASH}:component:c.tsx:C1`,
      type: 'component',
      name: 'C1',
      filePath: 'src/c.tsx',
      startLine: 1,
      summary: 'card',
    });
    await insertNode({
      id: `${REPO_HASH}:component:c.tsx:C2`,
      type: 'component',
      name: 'C2',
      filePath: 'src/c.tsx',
      startLine: 20,
    });
    await insertNode({
      id: `${REPO_HASH}:class:k.ts:K1`,
      type: 'class',
      name: 'K1',
      filePath: 'src/k.ts',
      startLine: 5,
    });
    await insertNode({
      id: `${REPO_HASH}:function:h.ts:handler`,
      type: 'function',
      name: 'handler',
      filePath: 'src/h.ts',
      startLine: 2,
    });
    // component→component edge: included. entrypoint→function edge: excluded (function isn't component-level).
    await insertEdge({
      id: `${REPO_HASH}:edge:rc`,
      type: 'RENDERS_COMPONENT',
      sourceId: `${REPO_HASH}:component:c.tsx:C1`,
      targetId: `${REPO_HASH}:component:c.tsx:C2`,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:hd`,
      type: 'HANDLES',
      sourceId: `${REPO_HASH}:entrypoint:r.ts:E1`,
      targetId: `${REPO_HASH}:function:h.ts:handler`,
    });

    const graph = await repo.getComponentGraph([REPO_HASH]);
    expect(graph.nodes.map((n) => n.name).sort()).toEqual(['C1', 'C2', 'E1', 'K1']);
    expect(graph.nodes.find((n) => n.name === 'C1')).toMatchObject({
      type: 'component',
      summary: 'card',
      filePath: 'src/c.tsx',
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      type: 'RENDERS_COMPONENT',
      sourceId: `${REPO_HASH}:component:c.tsx:C1`,
      targetId: `${REPO_HASH}:component:c.tsx:C2`,
    });
  });
});

// ===========================================================================
// Depth-N subgraph / dead-code / cross-repo bridge (explorer query features)
// ===========================================================================

describe('SqliteRepository.getSubgraph', () => {
  const F = `${REPO_HASH}:function:src/svc.ts:handleRequest`;

  it('walks outgoing flow edges to depth N and returns the reached subgraph', async () => {
    await seedExplorerGraph();
    const g = await repo.getSubgraph(F, { depth: 3, direction: 'out', nodeCap: 200 }, [REPO_HASH]);
    expect(g.truncated).toBe(false);
    // F → validate, F → log (CALLS), F → fetchOrders (MAKES_EXTERNAL_CALL).
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['fetchOrders', 'handleRequest', 'log', 'validate']);
    expect(g.edges.map((e) => e.type).sort()).toEqual(['CALLS', 'CALLS', 'MAKES_EXTERNAL_CALL']);
  });

  it('honors direction=both and the explicit edgeTypes filter', async () => {
    await seedExplorerGraph();
    const both = await repo.getSubgraph(F, { depth: 1, direction: 'both', nodeCap: 200 }, [REPO_HASH]);
    // adds `route` (incoming CALLS) on top of the outgoing neighbours.
    expect(both.nodes.map((n) => n.name).sort()).toEqual(['fetchOrders', 'handleRequest', 'log', 'route', 'validate']);

    const callsOnly = await repo.getSubgraph(
      F,
      { depth: 1, direction: 'out', edgeTypes: [EdgeType.Calls], nodeCap: 200 },
      [REPO_HASH],
    );
    // fetchOrders is reached via MAKES_EXTERNAL_CALL, so it drops when only CALLS is followed.
    expect(callsOnly.nodes.map((n) => n.name).sort()).toEqual(['handleRequest', 'log', 'validate']);
  });

  it('caps the neighbour set at nodeCap and flags truncated (root always kept)', async () => {
    await seedExplorerGraph();
    const g = await repo.getSubgraph(F, { depth: 3, direction: 'out', nodeCap: 1 }, [REPO_HASH]);
    expect(g.nodes).toHaveLength(2); // root + 1 neighbour
    expect(g.nodes.some((n) => n.id === F)).toBe(true);
    expect(g.truncated).toBe(true);
  });
});

describe('SqliteRepository.findDeadNodes', () => {
  /** deadFn (no inbound) + DeadClass (no inbound) are dead; usedFn/UsedClass have
   *  inbound usage; handlerFn is an entrypoint handler (root); apiFn is exported. */
  async function seedDeadCodeGraph(): Promise<void> {
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
         VALUES (@id, 'repository', 'app', NULL, NULL, '{}', NULL)`,
        { id: REPO_HASH },
      );
    });
    await insertNode({ id: `${REPO_HASH}:function:a.ts:deadFn`, type: 'function', name: 'deadFn', filePath: 'a.ts' });
    await insertNode({ id: `${REPO_HASH}:function:a.ts:usedFn`, type: 'function', name: 'usedFn', filePath: 'a.ts' });
    await insertNode({
      id: `${REPO_HASH}:function:a.ts:handlerFn`,
      type: 'function',
      name: 'handlerFn',
      filePath: 'a.ts',
    });
    await insertNode({
      id: `${REPO_HASH}:function:a.ts:apiFn`,
      type: 'function',
      name: 'apiFn',
      filePath: 'a.ts',
      properties: { isExported: true },
    });
    await insertNode({ id: `${REPO_HASH}:class:a.ts:DeadClass`, type: 'class', name: 'DeadClass', filePath: 'a.ts' });
    await insertNode({ id: `${REPO_HASH}:class:a.ts:UsedClass`, type: 'class', name: 'UsedClass', filePath: 'a.ts' });
    await insertNode({
      id: `${REPO_HASH}:entrypoint:a.ts:GET /x`,
      type: 'entrypoint',
      name: 'GET /x',
      filePath: 'a.ts',
      properties: { method: 'GET', entrypointType: 'http' },
    });
    // deadFn calls usedFn and uses UsedClass — so deadFn is a source only (dead),
    // usedFn has an inbound CALLS, UsedClass has an inbound USES_TYPE.
    await insertEdge({
      id: `${REPO_HASH}:edge:d1`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:a.ts:deadFn`,
      targetId: `${REPO_HASH}:function:a.ts:usedFn`,
    });
    await insertEdge({
      id: `${REPO_HASH}:edge:d2`,
      type: 'USES_TYPE',
      sourceId: `${REPO_HASH}:function:a.ts:deadFn`,
      targetId: `${REPO_HASH}:class:a.ts:UsedClass`,
    });
    // handlerFn is served by an entrypoint → a root, not dead.
    await insertEdge({
      id: `${REPO_HASH}:edge:d3`,
      type: 'HANDLES',
      sourceId: `${REPO_HASH}:entrypoint:a.ts:GET /x`,
      targetId: `${REPO_HASH}:function:a.ts:handlerFn`,
    });
  }

  it('flags unreferenced functions/classes, excluding exported + handler roots', async () => {
    await seedDeadCodeGraph();
    const page = await repo.findDeadNodes({ limit: 50 }, [REPO_HASH]);
    expect(new Set(page.nodes.map((n) => n.name))).toEqual(new Set(['deadFn', 'DeadClass']));
    expect(page.truncated).toBe(false);
  });

  it('narrows to the requested node kinds', async () => {
    await seedDeadCodeGraph();
    const page = await repo.findDeadNodes({ types: [NodeType.Class], limit: 50 }, [REPO_HASH]);
    expect(page.nodes.map((n) => n.name)).toEqual(['DeadClass']);
  });

  it('flags low-coverage repos so their results read as suspect, not dead', async () => {
    // 3 functions, only 1 has an outgoing CALLS → ratio 1/3 < 0.5 → low coverage.
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
         VALUES (@id, 'repository', 'thin', NULL, NULL, '{}', NULL)`,
        { id: REPO_HASH },
      );
    });
    await insertNode({ id: `${REPO_HASH}:function:a.ts:one`, type: 'function', name: 'one', filePath: 'a.ts' });
    await insertNode({ id: `${REPO_HASH}:function:a.ts:two`, type: 'function', name: 'two', filePath: 'a.ts' });
    await insertNode({ id: `${REPO_HASH}:function:a.ts:three`, type: 'function', name: 'three', filePath: 'a.ts' });
    await insertEdge({
      id: `${REPO_HASH}:edge:c`,
      type: 'CALLS',
      sourceId: `${REPO_HASH}:function:a.ts:one`,
      targetId: `${REPO_HASH}:function:a.ts:two`,
    });
    const page = await repo.findDeadNodes({ limit: 50 }, [REPO_HASH]);
    expect(page.lowCoverageRepos).toEqual(['thin']);
  });
});

describe('SqliteRepository.getCrossRepoBridges', () => {
  const CALLER = `${REPO_HASH}:function:a.ts:caller`;
  const XC = `${REPO_HASH}:external_call:a.ts:xc`;
  const EP = `${REPO2_HASH}:entrypoint:b.ts:GET /orders`;
  const HANDLER = `${REPO2_HASH}:function:b.ts:getOrders`;

  async function seedCrossRepoGraph(): Promise<void> {
    await driver.withWriteTransaction(async (tx) => {
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
         VALUES (@id, 'repository', 'gateway', NULL, NULL, '{}', NULL)`,
        { id: REPO_HASH },
      );
      await tx.run(
        `INSERT INTO nodes (id, type, name, file_path, start_line, properties, repo_id)
         VALUES (@id, 'repository', 'orders', NULL, NULL, '{}', NULL)`,
        { id: REPO2_HASH },
      );
    });
    await insertNode({ id: CALLER, type: 'function', name: 'caller', filePath: 'a.ts' });
    await insertNode({
      id: XC,
      type: 'external_call',
      name: 'orders.fetch',
      filePath: 'a.ts',
      properties: { protocol: 'http', serviceName: 'orders' },
    });
    await insertNode({
      id: EP,
      type: 'entrypoint',
      name: 'GET /orders',
      filePath: 'b.ts',
      repoId: REPO2_HASH,
      properties: { method: 'GET', entrypointType: 'http' },
    });
    await insertNode({ id: HANDLER, type: 'function', name: 'getOrders', filePath: 'b.ts', repoId: REPO2_HASH });
    await insertEdge({ id: `${REPO_HASH}:edge:mec`, type: 'MAKES_EXTERNAL_CALL', sourceId: CALLER, targetId: XC });
    await insertEdge({
      id: `${REPO_HASH}:edge:rt`,
      type: 'RESOLVES_TO',
      sourceId: XC,
      targetId: EP,
      confidence: 0.8,
      createdBy: 'ai',
    });
    await insertEdge({ id: `${REPO2_HASH}:edge:hnd`, type: 'HANDLES', sourceId: EP, targetId: HANDLER });
  }

  it('assembles the caller→external_call→entrypoint→handler bridge across repos', async () => {
    await seedCrossRepoGraph();
    const g = await repo.getCrossRepoBridges({ limit: 50 }, []); // empty = all repos
    expect(g.truncated).toBe(false);
    expect(new Set(g.nodes.map((n) => n.name))).toEqual(
      new Set(['caller', 'orders.fetch', 'GET /orders', 'getOrders']),
    );
    expect(new Set(g.edges.map((e) => e.type))).toEqual(new Set(['MAKES_EXTERNAL_CALL', 'RESOLVES_TO', 'HANDLES']));
    const rt = g.edges.find((e) => e.type === 'RESOLVES_TO')!;
    expect(rt).toMatchObject({ sourceId: XC, targetId: EP, createdBy: 'ai', confidence: 0.8 });
    expect(g.nodes.find((n) => n.name === 'GET /orders')!.repoName).toBe('orders');
  });

  it('filters to bridges touching the focus repo', async () => {
    await seedCrossRepoGraph();
    const hit = await repo.getCrossRepoBridges({ limit: 50, focusRepoHashes: [REPO2_HASH] }, []);
    expect(hit.edges.length).toBeGreaterThan(0);

    const miss = await repo.getCrossRepoBridges({ limit: 50, focusRepoHashes: ['zzz999888777'] }, []);
    expect(miss.nodes).toEqual([]);
    expect(miss.edges).toEqual([]);
  });
});

describe('buildRepoFilter', () => {
  it('uses an indexed equality filter for repository nodes, never LIKE', () => {
    // Repository node ids ARE the 12-hex repo hash (transformRepository sets
    // id = ParsedRepo.id = repoHash), so an exact IN-list is both correct and
    // index-friendly. The previous `id LIKE 'hash%'` OR-chain forced a full
    // nodes scan (measured 302ms p95 on a 181k-node graph vs 5ms indexed —
    // Phase 0 bench, 2026-08-10).
    expect(buildRepoFilter(['aaa111222333'], 'r', true)).toBe(`r.id IN ('aaa111222333')`);
    expect(buildRepoFilter(['aaa111222333', 'bbb444555666'], 'r', true)).toBe(
      `r.id IN ('aaa111222333', 'bbb444555666')`,
    );
    expect(buildRepoFilter([], 'r', true)).toBe('1=1');
  });
});

describe('applyChangeset planner statistics (local file mode)', () => {
  it('refreshes sqlite_stat1 after a changeset so recursive CTEs plan correctly', async () => {
    const fnId = (name: string) => `${REPO_HASH}:function:src/a.ts:${name}`;
    const mkNode = (id: string, type: string, name: string) => ({
      id,
      type: type as never,
      name,
      properties: {},
      repoId: REPO_HASH,
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 2,
    });
    await repo.applyChangeset({
      repoId: REPO_HASH,
      nodesToAdd: [
        mkNode(REPO_HASH, 'repository', 'stat-repo'),
        mkNode(fnId('a'), 'function', 'a'),
        mkNode(fnId('b'), 'function', 'b'),
      ],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'e1',
          sourceId: fnId('a'),
          targetId: fnId('b'),
          type: 'CALLS' as never,
          confidence: 1,
          createdBy: 'parser' as const,
          properties: {},
        },
      ],
    });

    const rows = await driver.withReadTransaction((tx) =>
      tx.run<{ c: number }>(`SELECT count(*) as c FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`),
    );
    expect(Number(rows[0]?.c)).toBe(1);
    const stats = await driver.withReadTransaction((tx) =>
      tx.run<{ c: number }>(`SELECT count(*) as c FROM sqlite_stat1`),
    );
    expect(Number(stats[0]?.c)).toBeGreaterThan(0);
  });
});

describe('embedded schema indexes', () => {
  it('creates the (repo_id, type) covering index for per-repo counts', async () => {
    const rows = await driver.withReadTransaction((tx) =>
      tx.run<{ c: number }>(
        `SELECT count(*) as c FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_repo_type'`,
      ),
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });
});
