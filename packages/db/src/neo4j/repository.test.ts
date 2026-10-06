import { describe, it, expect, vi, afterEach } from 'vitest';
import { Neo4jRepository } from './repository.js';
import type { Neo4jDriver } from './driver.js';
import type { ITransaction, GraphEdge, GraphNode } from '../types.js';
import { EdgeType, GraphApplyMode, NodeType } from '../types.js';

/**
 * Neo4j backend parity tests.
 *
 * The Neo4j backend has no live-instance test harness, so these exercise the
 * repository against a fake driver that records every Cypher query + params and
 * returns canned rows. They pin the SQLite-parity fixes — the regressions they
 * guard (reading `ep.type` instead of `entrypointType`, the no-op stale-edge
 * wipe, edge-property flattening, the missing interface methods) are invisible
 * to query-string-blind mocks, so we assert on the generated Cypher directly.
 */

type Responder = (query: string, params: Record<string, unknown>) => unknown[];

class FakeDriver {
  calls: Array<{ query: string; params: Record<string, unknown> }> = [];
  responder: Responder = () => [];

  // Native-Cypher (getOriginalDriver) call recording + canned classification.
  explainCalls: Array<{ query: string; params: Record<string, unknown> }> = [];
  runCalls: Array<{ query: string; params: Record<string, unknown> }> = [];
  cypherQueryType = 'r';
  cypherRecords: Array<{ keys: string[]; get: (key: string) => unknown }> = [];

  private makeTx(): ITransaction {
    return {
      run: async <T = unknown>(query: string, params: Record<string, unknown> = {}): Promise<T[]> => {
        this.calls.push({ query, params });
        return this.responder(query, params) as T[];
      },
    };
  }

  // Mimics neo4j-driver's Driver.session().executeRead(work,{timeout}). `work`
  // receives a tx whose `run` returns a QueryResult-shaped {records, summary}.
  async getOriginalDriver(): Promise<unknown> {
    const session = {
      executeRead: async <T>(work: (tx: { run: (q: string, p?: Record<string, unknown>) => unknown }) => T) => {
        const tx = {
          run: (query: string, params: Record<string, unknown> = {}) => {
            if (query.startsWith('EXPLAIN')) {
              this.explainCalls.push({ query, params });
              return { records: [], summary: { queryType: this.cypherQueryType } };
            }
            this.runCalls.push({ query, params });
            return { records: this.cypherRecords, summary: { queryType: this.cypherQueryType } };
          },
        };
        return work(tx);
      },
      close: async () => {
        /* no-op fake */
      },
    };
    return { session: () => session };
  }

  async withReadTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    return fn(this.makeTx());
  }

  async withWriteTransaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    return fn(this.makeTx());
  }

  async executeBatch<T>(
    items: T[],
    handler: (batch: T[], tx: ITransaction) => Promise<void>,
    batchSize = 500,
  ): Promise<number> {
    if (items.length === 0) return 0;
    let processed = 0;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await this.withWriteTransaction(async (tx) => {
        await handler(batch, tx);
      });
      processed += batch.length;
    }
    return processed;
  }
}

function makeRepo(): { repo: Neo4jRepository; driver: FakeDriver } {
  const driver = new FakeDriver();
  const repo = new Neo4jRepository(driver as unknown as Neo4jDriver);
  return { repo, driver };
}

const lastQuery = (driver: FakeDriver) => driver.calls[driver.calls.length - 1]!.query;
const queryMatching = (driver: FakeDriver, needle: string) => driver.calls.find((c) => c.query.includes(needle));

describe('Neo4jRepository — entrypoint type parity', () => {
  it('listEntrypoints filters and reads entrypointType (not the nonexistent ep.type)', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => {
      if (query.includes('MATCH (ep:Entrypoint)')) {
        return [
          {
            ep: { id: 'h:entrypoint:1', entrypointType: 'graphql', method: 'POST' },
            handlerName: null,
            handlerId: null,
            handlerSummary: null,
            handlerPurpose: null,
          },
        ];
      }
      return [];
    };

    const result = await repo.listEntrypoints({ type: 'graphql' }, ['hash']);

    const epQuery = queryMatching(driver, 'MATCH (ep:Entrypoint)')!;
    // Filter + ordering + projection must use entrypointType, parameterized.
    expect(epQuery.query).toContain('ep.entrypointType = $type');
    expect(epQuery.query).toContain('ORDER BY ep.entrypointType');
    expect(epQuery.query).not.toContain('ep.type =');
    // No pathPattern → no $pathPattern parameter is sent, so the hoisting WITH that references
    // it must not be emitted either: an unsupplied parameter is a query error, not an empty
    // result.
    expect(epQuery.query).not.toContain('$pathPattern');
    expect(epQuery.params).toMatchObject({ type: 'graphql' });
    // The output type is the real stored type, not the 'http' default.
    expect(result[0]?.type).toBe('graphql');
  });

  it('listEntrypoints parameterizes the path anchor with case-insensitive CONTAINS', async () => {
    const { repo, driver } = makeRepo();
    await repo.listEntrypoints({ pathPattern: '/Users', limit: 20 }, ['hash']);

    const epQuery = queryMatching(driver, 'MATCH (ep:Entrypoint)')!;
    // Anchored across every address property (path AND destination/topic/
    // schedule/command), so a queue entrypoint is not dropped before the JS
    // refinement can look at the only address it has.
    // `toLower($pathPattern)` is hoisted into a leading WITH rather than recomputed once per
    // token per row inside `any(...)`; the comparison itself stays case-insensitive.
    expect(epQuery.query).toContain('WITH toLower($pathPattern) AS pathAnchorLower');
    expect(epQuery.query).toContain('toLower(token) CONTAINS pathAnchorLower');
    // The anchored properties must be the names `transformEntrypoint` actually
    // persists. `destination`/`destinationValue` are API-level fields derived on
    // the way out, never stored — anchoring on them matched nothing and dropped
    // every queue/event row.
    for (const property of [
      'ep.fullPath',
      'ep.path',
      'ep.fieldName',
      'ep.messagingDestination',
      'ep.messagingDestinationRef',
      'ep.topicValue',
      'ep.topic',
      'ep.eventValue',
      'ep.eventName',
      'ep.command',
      'ep.schedule',
    ]) {
      expect(epQuery.query).toContain(property);
    }
    expect(epQuery.query).not.toContain('ep.destinationValue');
    expect(epQuery.query).not.toContain('ep.destination,');
    // The DB pre-filter binds the longest literal segment (placeholder-agnostic
    // matching is refined in JS afterward), parameterized, never interpolated.
    expect(epQuery.params).toMatchObject({ pathPattern: 'Users' });
    expect(epQuery.query).not.toContain("'/Users'");
    expect(epQuery.query).not.toContain('LIMIT $limit');
    expect(epQuery.params).not.toHaveProperty('limit');

    const routeQuery = queryMatching(driver, 'MATCH (n:Route)')!;
    expect(routeQuery.query).not.toContain('LIMIT $limit');
    expect(routeQuery.params).not.toHaveProperty('limit');
  });

  it('listEntrypoints filters by normalized messaging system and skips route fan-out', async () => {
    const { repo, driver } = makeRepo();
    await repo.listEntrypoints({ type: 'queue', system: ' GCP-PUBSUB ' }, ['hash']);

    const epQuery = queryMatching(driver, 'MATCH (ep:Entrypoint)')!;
    expect(epQuery.query).toContain('toLower(trim(coalesce(ep.messagingSystem, ep.emitter))) = $system');
    expect(epQuery.params).toMatchObject({ type: 'queue', system: 'gcp-pubsub' });
    expect(queryMatching(driver, 'MATCH (n:Route)')).toBeUndefined();
  });

  it('treats unknown case-insensitively and limits it to messaging entrypoints', async () => {
    const { repo, driver } = makeRepo();
    await repo.listEntrypoints({ system: ' UNKNOWN ' }, ['hash']);

    const epQuery = queryMatching(driver, 'MATCH (ep:Entrypoint)')!;
    expect(epQuery.query).toContain("ep.entrypointType IN ['queue', 'event']");
    expect(epQuery.query).toContain("trim(coalesce(ep.messagingSystem, ep.emitter, '')) = ''");
    expect(epQuery.params).not.toHaveProperty('system');
  });

  it('does not report an unresolved destination token as a resolved value', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) =>
      query.includes('MATCH (ep:Entrypoint)')
        ? [
            {
              ep: {
                id: 'h:entrypoint:orders',
                entrypointType: 'queue',
                messagingDestinationRef: 'Topics.ORDERS',
                messagingDestination: 'Topics.ORDERS',
              },
              handlerName: null,
              handlerId: null,
              handlerSummary: null,
              handlerPurpose: null,
            },
          ]
        : [];

    const [entrypoint] = await repo.listEntrypoints({ type: 'queue' }, ['hash']);

    expect(entrypoint).toMatchObject({ destination: 'Topics.ORDERS' });
    expect(entrypoint?.destinationValue).toBeUndefined();
  });

  it('listEntrypoints surfaces routes as synthetic HTTP-GET entrypoints', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => {
      if (query.includes('MATCH (ep:Entrypoint)')) return [];
      if (query.includes('MATCH (n:Route)')) {
        return [
          {
            id: 'h:route:1',
            name: '/dashboard',
            path: '/dashboard',
            componentId: 'h:component:Dash',
            componentName: 'Dashboard',
            filePath: 'src/routes.tsx',
            startLine: 10,
            endLine: 12,
            handlerName: 'Dashboard',
            handlerSummary: 'dashboard page',
            handlerPurpose: null,
          },
        ];
      }
      return [];
    };

    const result = await repo.listEntrypoints({}, ['hash']);

    expect(queryMatching(driver, 'MATCH (n:Route)')).toBeDefined();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'http',
      method: 'GET',
      path: '/dashboard',
      fullPath: '/dashboard',
      handlerId: 'h:component:Dash',
      handlerName: 'Dashboard',
    });
  });

  it('listEntrypoints skips the route fan-out for a non-http type filter', async () => {
    const { repo, driver } = makeRepo();
    await repo.listEntrypoints({ type: 'cron' }, ['hash']);
    expect(queryMatching(driver, 'MATCH (n:Route)')).toBeUndefined();
  });

  it('getReachingEntrypoints reads entrypointType, orders by fullPath, clamps depth', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      { ep: { id: 'h:entrypoint:1', entrypointType: 'queue' }, handlerName: 'h', handlerId: 'h:fn:1' },
    ];

    const result = await repo.getReachingEntrypoints('h:fn:target', 2, ['hash']);

    const q = lastQuery(driver);
    expect(q).toContain('ORDER BY ep.fullPath');
    expect(q).toContain('CALLS*0..5'); // intDepth(2) + 3
    expect(result[0]?.type).toBe('queue');
  });

  it('getReachingEntrypoints coerces a NaN depth to a safe integer literal', async () => {
    const { repo, driver } = makeRepo();
    await repo.getReachingEntrypoints('h:fn:target', Number.NaN, ['hash']);
    expect(lastQuery(driver)).toContain('CALLS*0..3'); // intDepth(NaN)=0, +3
    expect(lastQuery(driver)).not.toContain('NaN');
  });

  it('getRepoOverview collects entrypointType', async () => {
    const { repo, driver } = makeRepo();
    await repo.getRepoOverview(['hash']);
    expect(lastQuery(driver)).toContain('collect(DISTINCT ep.entrypointType)');
  });

  // The parse commit is read by the impact licence to ask whether the graph sees
  // a change's base. A backend that selects it and one that does not answer that
  // question differently for the same repository, which is the kind of divergence
  // only a per-backend assertion catches.
  it('getRepoOverview selects the parsed commit alongside the git link', async () => {
    const { repo, driver } = makeRepo();
    await repo.getRepoOverview(['hash']);
    const q = lastQuery(driver);
    expect(q).toContain('r.gitRemoteUrl as gitRemoteUrl');
    expect(q).toContain('r.gitCommitHash as gitCommitHash');
  });
});

describe('Neo4jRepository — cross-repo write path parity', () => {
  it('deleteEdgesByType scopes the wipe by source-node repo prefix, not r.sourceRepoId', async () => {
    const { repo, driver } = makeRepo();
    await repo.deleteEdgesByType(EdgeType.ResolvesTo, ['abc123def456']);

    const q = lastQuery(driver);
    expect(q).toContain('MATCH (source)-[r:RESOLVES_TO]->()');
    expect(q).toContain("source.id STARTS WITH 'abc123def456:'");
    expect(q).not.toContain('sourceRepoId');
  });

  it('deleteEdgesByType is a no-op for an empty repo list', async () => {
    const { repo, driver } = makeRepo();
    await repo.deleteEdgesByType(EdgeType.ResolvesTo, []);
    expect(driver.calls).toHaveLength(0);
  });

  it('pushEdges flattens array-of-maps properties and stores the edge id', async () => {
    const { repo, driver } = makeRepo();
    const edge: GraphEdge = {
      id: 'resolve:call1:ep1',
      sourceId: 'h:ext-call:1',
      targetId: 'h2:entrypoint:1',
      type: EdgeType.ResolvesTo,
      confidence: 0.9,
      createdBy: 'ai',
      properties: {
        chain: [{ kind: 'symbol', sourceId: 'a', targetId: 'b', via: 'moniker', confidence: 1 }],
        via: 'moniker',
      },
    };

    await repo.pushEdges([edge]);

    const writeCall = queryMatching(driver, 'MERGE (from)-[r:')!;
    const batch = writeCall.params.batch as Array<{ props: Record<string, unknown> }>;
    const props = batch[0]!.props;
    // chain (array-of-maps) must be JSON-encoded, or the tx would throw on Neo4j.
    expect(typeof props.chain).toBe('string');
    expect(JSON.parse(props.chain as string)).toHaveLength(1);
    // via is a scalar — left as-is.
    expect(props.via).toBe('moniker');
    // Edge id is persisted for getResolvesEdge.
    expect(props.id).toBe('resolve:call1:ep1');
  });
});

describe('Neo4jRepository — methods added for SQLite parity', () => {
  it('unions package-import RESOLVES_TO source files into getTypeUsages', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        src: {
          id: 'consumer1234:file:src/use-booking.ts',
          name: 'src/use-booking.ts',
          filePath: 'src/use-booking.ts',
          startLine: 0,
        },
        srcLabels: ['File'],
        usage: 'import',
        via: 'BookingKind',
        ambiguous: false,
      },
    ];

    const results = await repo.getTypeUsages('provider1234:enum:src/enums.ts:BookingTypes', ['consumer1234']);

    const query = lastQuery(driver);
    expect(query).toContain('RESOLVES_TO');
    expect(driver.calls.at(-1)?.params).toMatchObject({ packageImportRelation: 'package-import' });
    expect(results).toEqual([
      expect.objectContaining({
        id: 'consumer1234:file:src/use-booking.ts',
        type: NodeType.File,
        usage: 'import',
        via: 'BookingKind',
      }),
    ]);
  });

  it('maps construction and import class consumers off the USES_TYPE rows', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        src: { id: 'abc123:function:src/a.ts:build', name: 'build', filePath: 'src/a.ts', startLine: 4 },
        srcLabels: ['Function'],
        usage: 'construction',
        useKind: 'value',
        ambiguous: false,
      },
      {
        src: { id: 'abc123:file:src/b.ts', name: 'src/b.ts', filePath: 'src/b.ts', startLine: 0 },
        srcLabels: ['File'],
        usage: 'import',
        ambiguous: false,
      },
    ];

    const results = await repo.getTypeUsages('abc123:class:src/service.ts:UserService', ['abc123']);

    expect(results).toEqual([
      expect.objectContaining({ id: 'abc123:function:src/a.ts:build', usage: 'construction', useKind: 'value' }),
      expect.objectContaining({ id: 'abc123:file:src/b.ts', type: NodeType.File, usage: 'import' }),
    ]);
  });

  it('getResolvesEdge reads the RESOLVES_TO edge and decodes the JSON chain', async () => {
    const { repo, driver } = makeRepo();
    const chain = [{ kind: 'symbol', sourceId: 'a', targetId: 'b', via: 'moniker', confidence: 1 }];
    driver.responder = () => [
      {
        id: 'resolve:call1:ep1',
        sourceId: 'h:ext-call:1',
        targetId: 'h2:entrypoint:1',
        confidence: 0.9,
        via: 'moniker',
        chain: JSON.stringify(chain),
        sourceRepoName: 'consumer',
        targetRepoName: 'provider',
        confidenceLevel: 'high',
      },
    ];

    const edge = await repo.getResolvesEdge!('h:ext-call:1');

    expect(lastQuery(driver)).toContain('RESOLVES_TO');
    expect(edge).not.toBeNull();
    expect(edge?.chain).toEqual(chain);
    expect(edge?.via).toBe('moniker');
    expect(edge?.targetRepoName).toBe('provider');
  });

  it('getResolvesEdge returns null when no edge exists', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];
    expect(await repo.getResolvesEdge!('missing')).toBeNull();
  });

  it('getMonikeredFunctions filters on monikerPackage and hydrates the moniker', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        f: {
          id: 'h:function:1',
          name: 'createUser',
          filePath: 'sdk.ts',
          startLine: 1,
          endLine: 5,
          monikerPackage: '@acme/sdk',
          monikerDescriptor: 'createUser().',
        },
      },
    ];

    const result = await repo.getMonikeredFunctions!(['hash']);

    expect(lastQuery(driver)).toContain('f.monikerPackage IS NOT NULL');
    expect(result[0]?.moniker).toEqual({ packageName: '@acme/sdk', descriptor: 'createUser().' });
  });

  it('getMonikeredFunctions short-circuits on an empty repo list', async () => {
    const { repo, driver } = makeRepo();
    expect(await repo.getMonikeredFunctions!([])).toEqual([]);
    expect(driver.calls).toHaveLength(0);
  });

  it('getEmbeddedNodes filters on embedding and reads provenance props', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        id: 'h:function:src/auth.ts:rotateToken',
        type: 'Function',
        name: 'rotateToken',
        filePath: 'src/auth.ts',
        startLine: 42,
        summary: 'Rotates the refresh token',
        embedding: [0.1, 0.2, 0.3],
        embeddingProvider: 'ollama',
        embeddingModel: 'qwen3-embedding:4b',
      },
    ];

    const result = await repo.getEmbeddedNodes(['hash']);

    expect(lastQuery(driver)).toContain('n.embedding IS NOT NULL');
    // The type must come from the SPECIFIC label, not labels(n)[0] — label order
    // is unspecified in Neo4j, so the CodeNode supertype label could come first.
    expect(lastQuery(driver)).toContain("[l IN labels(n) WHERE l <> 'CodeNode'][0] AS type");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'h:function:src/auth.ts:rotateToken',
      type: 'function',
      name: 'rotateToken',
      filePath: 'src/auth.ts',
      startLine: 42,
      summary: 'Rotates the refresh token',
      embedding: [0.1, 0.2, 0.3],
      embeddingProvider: 'ollama',
      embeddingModel: 'qwen3-embedding:4b',
    });
  });

  it('getEmbeddedNodes with empty repoHashes queries all repos (no id filter)', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];

    const result = await repo.getEmbeddedNodes([]);

    expect(result).toEqual([]);
    // Empty repoHashes = the unconditional `true` filter, not a short-circuit.
    expect(lastQuery(driver)).toContain('WHERE true');
  });

  it('applyChangeset atomically patches summaries and embeddings', async () => {
    const { repo, driver } = makeRepo();
    const result = await repo.applyChangeset({
      repoId: 'h',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
      nodeMetadataUpdates: [
        { id: 'h:function:1', summary: 's1', properties: { purpose: 'p1', nested: { a: 1 } } },
        { id: 'h:function:2', embedding: [0.1, 0.2], properties: { embeddingProvider: 'ollama' } },
      ],
    });

    expect(result.nodesUpdated).toBe(2);
    const writeCall = queryMatching(driver, 'FOREACH (_ IN CASE WHEN item.hasSummary')!;
    const batch = writeCall.params.batch as Array<{ id: string; summary: string; props: Record<string, unknown> }>;
    expect(batch[0]!.summary).toBe('s1');
    // nested object property must be JSON-encoded (Neo4j rejects maps).
    expect(typeof batch[0]!.props.nested).toBe('string');
    expect(batch[0]!.props.purpose).toBe('p1');
    expect(batch[1]!.embedding).toEqual([0.1, 0.2]);
  });
});

describe('Neo4jRepository — findShortestPath self-path parity', () => {
  it('returns a single-step path for startId === endId without a shortestPath query', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => {
      if (query.includes('UNWIND $nodeIds AS nid')) {
        return [{ id: 'h:fn:1', name: 'foo', filePath: 'a.ts', startLine: 3, summary: null, classId: null }];
      }
      return [];
    };

    const result = await repo.findShortestPath('h:fn:1', 'h:fn:1', ['hash']);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('h:fn:1');
    // The single-node hydrate path is used; shortestPath is never run.
    expect(queryMatching(driver, 'shortestPath(')).toBeUndefined();
  });
});

describe('Neo4jRepository — getExternalCalls param safety', () => {
  it('returns both the resolved destination and its source reference', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        id: 'h:external_call:1',
        callerId: 'h:function:publish',
        callerName: 'publish',
        callerFilePath: 'src/events.ts',
        serviceName: 'kafka',
        method: 'emit',
        protocol: 'messaging',
        messagingSystem: 'kafka',
        messagingDestination: 'user.created',
        messagingDestinationRef: 'Topics.USER_CREATED',
        filePath: 'src/events.ts',
        startLine: 12,
      },
    ];

    const calls = await repo.getExternalCalls(['hash']);

    expect(lastQuery(driver)).toContain('ec.messagingDestinationRef as messagingDestinationRef');
    expect(calls[0]).toMatchObject({
      messagingSystem: 'kafka',
      messagingDestination: 'user.created',
      messagingDestinationRef: 'Topics.USER_CREATED',
    });
  });

  it('omits $targetService when no service filter is given (neo4j-driver rejects undefined)', async () => {
    const { repo, driver } = makeRepo();
    await repo.getExternalCalls(['hash']);

    const call = driver.calls[driver.calls.length - 1]!;
    expect(call.query).not.toContain('$targetService');
    expect('targetService' in call.params).toBe(false);
    // No undefined values reach the driver.
    expect(Object.values(call.params).every((v) => v !== undefined)).toBe(true);
  });

  it('binds $targetService only when a service filter is provided', async () => {
    const { repo, driver } = makeRepo();
    await repo.getExternalCalls(['hash'], 'billing');

    const call = driver.calls[driver.calls.length - 1]!;
    // Matches the effective target: targetService first, then the repo the call
    // resolved to, serviceName only as the last fallback.
    expect(call.query).toContain(
      'WHERE coalesce(ec.targetService, resolvedTargetRepoName, ec.serviceName) = $targetService',
    );
    expect(call.params).toMatchObject({ targetService: 'billing' });
  });
});

describe('Neo4jRepository — getExternalCallsWithMessaging (narrow destination query)', () => {
  it('filters to destination-carrying calls in Cypher with a narrow projection and no ORDER BY', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        id: 'h:ext:1',
        callerName: 'publishEvent',
        filePath: 'src/producer.ts',
        startLine: 42,
        system: 'gcp-pubsub',
        destination: 'user-events',
        destinationRef: 'Topics.USER_EVENTS',
      },
    ];

    const calls = await repo.getExternalCallsWithMessaging(['hash']);

    const query = lastQuery(driver);
    expect(query).toContain('AND ec.messagingDestination IS NOT NULL');
    expect(query).toContain("ec.id STARTS WITH 'hash:'");
    expect(query).not.toContain('ORDER BY');
    // Only the narrow fields — the full external-call row set is never pulled.
    expect(query).not.toContain('resolvedTargetId');
    expect(calls).toEqual([
      {
        id: 'h:ext:1',
        callerName: 'publishEvent',
        filePath: 'src/producer.ts',
        startLine: 42,
        system: 'gcp-pubsub',
        destination: 'user-events',
        destinationRef: 'Topics.USER_EVENTS',
      },
    ]);
  });

  it("falls back to callerName 'unknown' when the caller name is null", async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [{ id: 'h:ext:1', callerName: null, filePath: 'a.ts', startLine: 1, destination: 't' }];

    const calls = await repo.getExternalCallsWithMessaging([]);

    expect(calls[0]?.callerName).toBe('unknown');
  });

  // Read no longer reinterprets a row: a systemless row stays systemless, so a
  // graph that predates messaging descriptors is visible instead of guessed at.
  it('leaves a systemless row systemless rather than inferring a broker', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      { id: 'h:ext:1', callerName: 'publish', filePath: 'a.ts', startLine: 1, system: null, destination: 'events' },
    ];

    const calls = await repo.getExternalCallsWithMessaging(['hash']);

    expect(lastQuery(driver)).not.toContain('legacyKafkaTopic');
    expect(calls[0]?.system).toBeUndefined();
  });
});

describe('Neo4jRepository — getRepositoryNames (batched hash→name)', () => {
  it('reads Repository nodes as {hash, name} rows in one query, filtered by hash prefix', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [{ hash: 'hash', name: 'billing-api' }];

    const rows = await repo.getRepositoryNames(['hash']);

    const query = lastQuery(driver);
    expect(query).toContain('MATCH (r:Repository)');
    // Repository ids carry no ':' suffix — the repo-node filter form.
    expect(query).toContain("r.id STARTS WITH 'hash'");
    expect(rows).toEqual([{ hash: 'hash', name: 'billing-api' }]);
  });

  it('spans all repos when repoHashes is empty (no filter)', async () => {
    const { repo, driver } = makeRepo();

    await repo.getRepositoryNames([]);

    expect(lastQuery(driver)).toContain('WHERE true');
  });
});

describe('Neo4jRepository — :CodeNode label for index-backed id lookups', () => {
  it('pushNodes tags each node with :CodeNode (shared id index) on its type label', async () => {
    const { repo, driver } = makeRepo();
    await repo.pushNodes([
      {
        id: 'h:function:1',
        type: 'function',
        name: 'foo',
        properties: {},
        filePath: 'a.ts',
        startLine: 1,
        endLine: 2,
      },
    ]);

    const writeCall = queryMatching(driver, 'MERGE (n:Function {id')!;
    expect(writeCall.query).toContain('SET n:CodeNode');
  });

  it('pushEdges matches endpoints by :CodeNode (uses the id index, not a full scan)', async () => {
    const { repo, driver } = makeRepo();
    await repo.pushEdges([
      {
        id: 'e1',
        sourceId: 'h:function:1',
        targetId: 'h:function:2',
        type: EdgeType.Calls,
        confidence: 1,
        createdBy: 'parser',
        properties: {},
      },
    ]);

    const writeCall = queryMatching(driver, 'MERGE (from)-[r:')!;
    expect(writeCall.query).toContain('MATCH (from:CodeNode {id: item.sourceId})');
    expect(writeCall.query).toContain('MATCH (to:CodeNode {id: item.targetId})');
  });

  it('deleteRepository scopes the prefix delete to :CodeNode', async () => {
    const { repo, driver } = makeRepo();
    await repo.deleteRepository('abc123:repo');
    expect(driver.calls.some((call) => call.query.includes('MATCH (n:CodeNode)'))).toBe(true);
  });
});

describe('Neo4jRepository — findFunction name filtering', () => {
  // Regression: a `WHERE` that immediately follows an `OPTIONAL MATCH` is scoped
  // to that optional pattern (it only decides whether the optional node binds) —
  // it does NOT filter the earlier required MATCH. When findFunction's
  // `f.name = $name` predicate sat in a WHERE *after* `OPTIONAL MATCH (c:Class)`,
  // the name filter was silently ignored and the query returned the first
  // :Function by filePath regardless of the requested name. analyze_change_impact
  // then resolved the wrong target (e.g. `createCompany` → `sleep`) and reported
  // "No detected impacts". The fake driver can't execute Cypher, so we pin the
  // structural invariant: the function predicates must precede the OPTIONAL MATCH.
  it('filters f by name BEFORE the OPTIONAL MATCH (Cypher WHERE-scope footgun)', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];
    await repo.findFunction('createCompany', ['abc123']);
    const q = lastQuery(driver);
    const nameIdx = q.indexOf('f.name = $name');
    const optIdx = q.indexOf('OPTIONAL MATCH');
    expect(nameIdx).toBeGreaterThanOrEqual(0);
    expect(optIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeLessThan(optIdx);
  });

  it('requires the class via a WITH barrier when className is given, not a post-OPTIONAL WHERE', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];
    await repo.findFunction('createCompany', ['abc123'], undefined, 'CompaniesService');
    const q = lastQuery(driver);
    // The className predicate needs `c`, so it lives after OPTIONAL MATCH — but a
    // `WITH` must break the optional scope first, otherwise it repeats the bug.
    const optIdx = q.indexOf('OPTIONAL MATCH');
    const withIdx = q.indexOf('WITH', optIdx);
    const classIdx = q.indexOf('c.name = $className');
    expect(classIdx).toBeGreaterThanOrEqual(0);
    expect(withIdx).toBeGreaterThan(optIdx);
    expect(classIdx).toBeGreaterThan(withIdx);
  });
});

describe('Neo4jRepository — idiomatic graph traversal', () => {
  // These pin that the Neo4j backend walks the graph natively rather than
  // porting SQLite's recursive-CTE "seed then expand" shape into Cypher.
  it('getReachingEntrypoints prunes from the target, not by enumerating all entrypoints', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];
    await repo.getReachingEntrypoints('repo:fn:target', 3, ['repo']);
    const q = lastQuery(driver);
    const targetIdx = q.indexOf('MATCH (target:Function {id: $targetId})');
    const epIdx = q.indexOf('(ep:Entrypoint)');
    // Anchor the target by its indexed id and walk incoming CALLS first, THEN
    // match entrypoints over the small handler set. The old form matched every
    // Entrypoint first — the entrypoint match must come AFTER the target anchor.
    expect(targetIdx).toBeGreaterThanOrEqual(0);
    expect(epIdx).toBeGreaterThan(targetIdx);
    // Variable-length CALLS walk anchored on the target (planner expands from
    // the id-bound target node regardless of the arrow's written direction).
    expect(q).toContain(':CALLS*0..');
    expect(q).toContain('(handler:Function)-[:CALLS*0..');
  });

  it('findShortestPath anchors each endpoint by id (no cartesian-product MATCH)', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];
    await repo.findShortestPath('repo:fn:a', 'repo:fn:b', ['repo']);
    const q = lastQuery(driver);
    expect(q).toContain('MATCH (start:Function {id: $startId})');
    expect(q).toContain('MATCH (end:Function {id: $endId})');
    expect(q).toContain('shortestPath(');
    // The cartesian-product form the planner warns on must be gone.
    expect(q).not.toContain('MATCH (start:Function), (end:Function)');
  });
});

describe('Neo4jRepository — applyChangeset incremental parity', () => {
  const fnNode = (id: string, extra: Record<string, unknown> = {}): GraphNode => ({
    id,
    type: NodeType.Function,
    name: id.split(':').pop()!,
    properties: { ...extra },
  });

  it('writes and reads a CoredocMeta snapshot in the graph transaction', async () => {
    const { repo, driver } = makeRepo();
    let storedSnapshot: string | null = null;
    driver.responder = (query, params) => {
      if (query.includes('MERGE (meta:CoredocMeta')) {
        storedSnapshot = params.snapshot as string;
        return [{ snapshot: storedSnapshot }];
      }
      if (query.includes('MATCH (meta:CoredocMeta')) {
        return storedSnapshot ? [{ snapshot: storedSnapshot }] : [];
      }
      return [];
    };

    await repo.applyChangeset(
      {
        repoId: 'repo1',
        nodesToAdd: [{ id: 'repo1', type: NodeType.Repository, name: 'repo1', properties: {} }],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgesToInsert: [],
      },
      {
        snapshot: {
          parsedVersion: 'parsed-v1',
          summaryVersion: null,
          embeddingsVersion: null,
          commitSha: 'abc123',
          totalNodeCount: 1,
          totalEdgeCount: 0,
          mode: GraphApplyMode.Full,
          executionToken: '11111111-1111-4111-8111-111111111111',
        },
      },
    );

    expect(await repo.getAppliedGraphSnapshot('repo1')).toMatchObject({
      parsedVersion: 'parsed-v1',
      nodeCount: 1,
      edgeCount: 0,
      mode: GraphApplyMode.Full,
      receipt: { nodesAdded: 1, edgesInserted: 0 },
    });
    expect(queryMatching(driver, 'MERGE (meta:CoredocMeta')).toBeTruthy();
  });

  it('commits each statement in its own write transaction, phases in order', async () => {
    const { repo, driver } = makeRepo();

    // Instrument the fake driver to count managed write transactions.
    let writeTxCount = 0;
    const origWrite = driver.withWriteTransaction.bind(driver);
    driver.withWriteTransaction = (<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> => {
      writeTxCount += 1;
      return origWrite(fn);
    }) as typeof driver.withWriteTransaction;

    await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [fnNode('h:function:a')],
      nodesToUpdate: [fnNode('h:function:b')],
      nodeIdsToDelete: ['h:function:gone'],
      edgeNodeIdsToWipe: ['h:function:a'],
      edgesToInsert: [
        {
          id: 'e1',
          sourceId: 'h:function:a',
          targetId: 'h:function:b',
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: {},
        },
      ],
    });

    // Chunked commits: no single transaction carries the whole changeset.
    expect(writeTxCount).toBeGreaterThan(1);

    // Delete nodes -> upsert nodes -> wipe edges -> insert edges.
    const queries = driver.calls.map((c) => c.query);
    const idxDelete = queries.findIndex((q) => q.includes('DETACH DELETE n'));
    const idxUpsert = queries.findIndex((q) => q.includes('MERGE (n:Function {id: item.id})'));
    const idxWipe = queries.findIndex((q) => q.includes('WITH DISTINCT r'));
    const idxInsert = queries.findIndex((q) => q.includes('MERGE (from)-[r:CALLS]->(to)'));
    expect(idxDelete).toBeGreaterThanOrEqual(0);
    expect(idxDelete).toBeLessThan(idxUpsert);
    expect(idxUpsert).toBeLessThan(idxWipe);
    expect(idxWipe).toBeLessThan(idxInsert);
  });

  it('removes exact repository id namespaces before inserting their replacement', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => (query.includes('AS nodesDeleted') ? [{ nodesDeleted: 2, edgesDeleted: 3 }] : []);

    const result = await repo.applyChangeset({
      repoId: 'hash:with-colon',
      repoIdsToDelete: ['hash:with-colon'],
      nodesToAdd: [fnNode('hash:with-colon:function:new')],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    const count = queryMatching(driver, 'AS nodesDeleted')!;
    // Exact id and child namespace as separate index-seekable matches, never an any(... OR ...) scan.
    expect(count.query).toContain('MATCH (n:CodeNode {id: $repoId})');
    expect(count.query).toContain('WHERE n.id STARTS WITH $prefix');
    expect(count.query).not.toContain('any(');
    expect(count.params).toMatchObject({ repoId: 'hash:with-colon', prefix: 'hash:with-colon:' });
    const wholeRepoDelete = driver.calls.find(
      (call) => call.query.includes('STARTS WITH $prefix') && call.query.includes('DETACH DELETE n'),
    )!;
    expect(wholeRepoDelete.query).toContain('LIMIT $limit');
    const insert = queryMatching(driver, 'MERGE (n:Function {id: item.id})')!;
    expect(driver.calls.indexOf(wholeRepoDelete)).toBeLessThan(driver.calls.indexOf(insert));
    expect(result.nodesDeleted).toBe(2);
    expect(result.edgesDeleted).toBe(3);
  });

  it('deletes removed nodes with DETACH DELETE (Neo4j cannot plain-delete a node with edges)', async () => {
    const { repo, driver } = makeRepo();
    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: ['h:function:x', 'h:function:y'],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    const del = queryMatching(driver, 'DETACH DELETE n')!;
    expect(del.query).toContain('MATCH (n:CodeNode {id: nodeId})');
    expect(del.params.ids).toEqual(['h:function:x', 'h:function:y']);
    // Input-length based, mirroring SQLite (ids requested, not rows matched).
    expect(result.nodesDeleted).toBe(2);
  });

  it("folds the deleted nodes' incident edges into edgesDeleted, counted before DETACH DELETE", async () => {
    const { repo, driver } = makeRepo();
    // Phase 1 counts incident edges on the to-delete nodes; phase 3 (empty here) adds 0.
    driver.responder = (q) => (q.includes('count(DISTINCT r) AS deleted') ? [{ deleted: 4 }] : []);

    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: ['h:function:x', 'h:function:y'],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    // Counted over the whole to-delete set and BEFORE the DETACH DELETE, so an edge
    // between two deleted nodes is counted exactly once.
    const countCall = queryMatching(driver, 'count(DISTINCT r) AS deleted')!;
    expect(countCall.params.ids).toEqual(['h:function:x', 'h:function:y']);
    const countIdx = driver.calls.findIndex((c) => c.query.includes('count(DISTINCT r) AS deleted'));
    const delIdx = driver.calls.findIndex((c) => c.query.includes('DETACH DELETE n'));
    expect(countIdx).toBeGreaterThanOrEqual(0);
    expect(countIdx).toBeLessThan(delIdx);
    // SQLite counts these in its phase 3; we count them in phase 1 for parity.
    expect(result.edgesDeleted).toBe(4);
  });

  it('upserts nodes grouped by concrete label, full-replace (SET n = props, not +=) + :CodeNode tag', async () => {
    const { repo, driver } = makeRepo();
    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [fnNode('h:function:a', { purpose: 'p', nested: { a: 1 } })],
      nodesToUpdate: [{ id: 'h:class:c', type: NodeType.Class, name: 'C', properties: {} }],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });

    const fnUpsert = queryMatching(driver, 'MERGE (n:Function {id: item.id})')!;
    // Full-replace, NOT additive — a property dropped in the new version must vanish.
    expect(fnUpsert.query).toContain('SET n = item.props');
    expect(fnUpsert.query).not.toContain('SET n += item.props');
    // Shared label for index-backed id lookups, exactly like pushNodes.
    expect(fnUpsert.query).toContain('SET n:CodeNode');
    // Class nodes are grouped under their own concrete label.
    expect(queryMatching(driver, 'MERGE (n:Class {id: item.id})')).toBeTruthy();

    // Nested object property is JSON-encoded (Neo4j rejects maps as property values).
    const batch = fnUpsert.params.batch as Array<{ props: Record<string, unknown> }>;
    expect(typeof batch[0]!.props.nested).toBe('string');
    expect(batch[0]!.props.purpose).toBe('p');
    expect(batch[0]!.props.id).toBe('h:function:a');

    expect(result.nodesAdded).toBe(1);
    expect(result.nodesUpdated).toBe(1);
  });

  it('wipes incident edges index-driven with DISTINCT, returning the DB-measured count', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (q) => (q.includes('count(r) AS deleted') ? [{ deleted: 3 }] : []);

    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: ['h:function:a', 'h:function:b'],
      edgeTypesToPreserve: [EdgeType.ResolvesTo],
      edgesToInsert: [],
    });

    const wipe = queryMatching(driver, 'WITH DISTINCT r')!;
    // Incident match from each wipe node hits the :CodeNode(id) index; the undirected
    // hop catches both source- and target-side edges, DISTINCT prevents double-counting
    // an edge whose two endpoints are both wiped.
    expect(wipe.query).toContain('MATCH (n:CodeNode {id: wid})-[r]-()');
    expect(wipe.query).toContain('WHERE NOT type(r) IN $preservedEdgeTypes');
    expect(wipe.query).toContain('DELETE r');
    expect(wipe.query).toContain('count(r) AS deleted');
    expect(wipe.params.wipe).toEqual(['h:function:a', 'h:function:b']);
    expect(wipe.params.preservedEdgeTypes).toEqual([EdgeType.ResolvesTo]);
    // edgesDeleted is the one DB-measured count (parity with SQLite).
    expect(result.edgesDeleted).toBe(3);
  });

  it('inserts edges grouped by type, full-replace, persisting id/confidence/createdBy', async () => {
    const { repo, driver } = makeRepo();
    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'e1',
          sourceId: 'h:function:a',
          targetId: 'h:function:b',
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: { chain: [{ a: 1 }] },
        },
      ],
    });

    const ins = queryMatching(driver, 'MERGE (from)-[r:CALLS]->(to)')!;
    const moveById = queryMatching(driver, 'MATCH (oldFrom:CodeNode)-[existing:CALLS')!;
    expect(moveById.query).toContain('existing:CALLS {id: item.id}');
    expect(moveById.query).toContain('oldFrom.id <> item.sourceId OR oldTo.id <> item.targetId');
    expect(moveById.query).toContain('DELETE existing');
    expect(driver.calls.indexOf(moveById)).toBeLessThan(driver.calls.indexOf(ins));
    // Endpoints matched against the shared :CodeNode(id) index, exactly like pushEdges.
    expect(ins.query).toContain('MATCH (from:CodeNode {id: item.sourceId})');
    expect(ins.query).toContain('SET r = item.props');
    const batch = ins.params.batch as Array<{ id: string; props: Record<string, unknown> }>;
    expect(batch[0]!.id).toBe('e1');
    expect(ins.query).toContain('coalesce(r.id, item.id) AS edgeId');
    expect(ins.query).toContain('r.id = edgeId');
    expect(batch[0]!.props.confidence).toBe(1);
    expect(batch[0]!.props.createdBy).toBe('parser');
    // array-of-maps flattened to a JSON string (Neo4j rejects it otherwise).
    expect(typeof batch[0]!.props.chain).toBe('string');

    expect(result.edgesInserted).toBe(1);
  });

  it('marks the repository in-flight first and clears the mark with the final snapshot write', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query, params) =>
      query.includes('SET meta.snapshot') ? [{ snapshot: params.snapshot as string }] : [];

    await repo.applyChangeset(
      {
        repoId: 'repo1',
        nodesToAdd: [fnNode('repo1:function:a')],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgesToInsert: [],
      },
      {
        snapshot: {
          parsedVersion: 'parsed-v2',
          summaryVersion: null,
          embeddingsVersion: null,
          commitSha: null,
          totalNodeCount: 1,
          totalEdgeCount: 0,
          mode: GraphApplyMode.Incremental,
          executionToken: '22222222-2222-4222-8222-222222222222',
        },
      },
    );

    const queries = driver.calls.map((c) => c.query);
    expect(queries[0]).toContain('SET meta.applyPending = $parsedVersion');
    expect(driver.calls[0]!.params.parsedVersion).toBe('parsed-v2');
    const last = queries[queries.length - 1]!;
    expect(last).toContain('SET meta.snapshot = $snapshot');
    expect(last).toContain('REMOVE meta.applyPending');
  });

  it('reports a leftover in-flight mark through getPendingGraphApply', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => (query.includes('meta.applyPending AS pending') ? [{ pending: 'parsed-v2' }] : []);
    expect(await repo.getPendingGraphApply('repo1')).toBe('parsed-v2');
    driver.responder = () => [];
    expect(await repo.getPendingGraphApply('repo1')).toBeNull();
  });

  it('skips the rewire pre-pass for endpoint-derived edge ids (they can only name that endpoint pair)', async () => {
    const { repo, driver } = makeRepo();
    await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [
        {
          id: 'h:function:a:CALLS:h:function:b',
          sourceId: 'h:function:a',
          targetId: 'h:function:b',
          type: EdgeType.Calls,
          confidence: 1,
          createdBy: 'parser',
          properties: {},
        },
      ],
    });
    expect(queryMatching(driver, 'MATCH (oldFrom:CodeNode)')).toBeUndefined();
    expect(queryMatching(driver, 'MERGE (from)-[r:CALLS]->(to)')).toBeTruthy();
  });

  it('sizes statement batches from COREDOC_NEO4J_APPLY_BATCH_SIZE', async () => {
    const previous = process.env.COREDOC_NEO4J_APPLY_BATCH_SIZE;
    process.env.COREDOC_NEO4J_APPLY_BATCH_SIZE = '2';
    try {
      const { repo, driver } = makeRepo();
      await repo.applyChangeset({
        repoId: 'repo1',
        nodesToAdd: [fnNode('h:function:a'), fnNode('h:function:b'), fnNode('h:function:c')],
        nodesToUpdate: [],
        nodeIdsToDelete: [],
        edgeNodeIdsToWipe: [],
        edgesToInsert: [],
      });
      const upserts = driver.calls.filter((c) => c.query.includes('MERGE (n:Function {id: item.id})'));
      expect(upserts.map((c) => (c.params.batch as unknown[]).length)).toEqual([2, 1]);
    } finally {
      if (previous === undefined) delete process.env.COREDOC_NEO4J_APPLY_BATCH_SIZE;
      else process.env.COREDOC_NEO4J_APPLY_BATCH_SIZE = previous;
    }
  });

  it('is a no-op transaction for an empty changeset (no Cypher, all-zero counts)', async () => {
    const { repo, driver } = makeRepo();
    const result = await repo.applyChangeset({
      repoId: 'repo1',
      nodesToAdd: [],
      nodesToUpdate: [],
      nodeIdsToDelete: [],
      edgeNodeIdsToWipe: [],
      edgesToInsert: [],
    });
    expect(driver.calls).toHaveLength(0);
    expect(result).toEqual({ nodesAdded: 0, nodesUpdated: 0, nodesDeleted: 0, edgesDeleted: 0, edgesInserted: 0 });
  });
});

describe('Neo4jRepository — entity/enum/type-alias/class/interface field read-back', () => {
  // `flattenForNeo4j` JSON-stringifies arrays-of-objects on write, so these rows
  // are shaped the way it stores them; the finders must JSON.parse them back.
  // This guards the Neo4j read path, which diverges from SQLite's whole-blob
  // parse (per-property JSON + the `properties_` rename for class fields).
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
      isNullable: true,
      isUnique: true,
      isGenerated: false,
    },
  ];
  const userRelations = [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post', joinColumn: 'user_id' }];
  const userEntityNode = {
    id: 'h:entity:src/user.ts:User',
    name: 'User',
    filePath: 'src/user.ts',
    startLine: 1,
    endLine: 20,
    ormType: 'typeorm',
    tableName: 'users',
    fields: JSON.stringify(userFields),
    relations: JSON.stringify(userRelations),
  };

  it('findEntity parses JSON-stringified fields/relations back into arrays', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) => (query.includes('MATCH (e:Entity)') ? [{ e: userEntityNode }] : []);

    const entity = await repo.findEntity('User', ['h']);

    expect(entity).not.toBeNull();
    expect(entity!.tableName).toBe('users');
    expect(entity!.fields).toEqual(userFields);
    expect(entity!.relations).toEqual(userRelations);
    // `indexes` was never stored (most ORM paths don't populate it) → undefined.
    expect(entity!.indexes).toBeUndefined();
  });

  it('listEntities maps + parses every entity row, and natively-stored empty arrays round-trip as []', async () => {
    const { repo, driver } = makeRepo();
    // An empty array has no complex elements, so flattenForNeo4j stores it
    // natively (not as a JSON string) — parseJsonArrayProp must still yield [].
    const postNode = {
      id: 'h:entity:src/post.ts:Post',
      name: 'Post',
      filePath: 'src/post.ts',
      startLine: 1,
      endLine: 5,
      ormType: 'typeorm',
      tableName: 'posts',
      fields: [],
      relations: [],
    };
    driver.responder = (query) => (query.includes('ORDER BY e.name') ? [{ e: userEntityNode }, { e: postNode }] : []);

    const entities = await repo.listEntities(['h']);

    expect(entities.map((e) => e.name)).toEqual(['User', 'Post']);
    expect(entities[0]!.fields).toEqual(userFields);
    expect(entities[1]!.fields).toEqual([]);
    expect(entities[1]!.relations).toEqual([]);
  });

  it('findEnum parses its members (values) back', async () => {
    const { repo, driver } = makeRepo();
    const members = [{ name: 'ShiftsPublished', value: 'shifts:published' }, { name: 'Auto' }];
    driver.responder = (query) =>
      query.includes('MATCH (e:Enum)')
        ? [
            {
              e: {
                id: 'h:enum:src/events.ts:EventType',
                name: 'EventType',
                filePath: 'src/events.ts',
                startLine: 1,
                endLine: 4,
                isExported: true,
                members: JSON.stringify(members),
              },
            },
          ]
        : [];

    const en = await repo.findEnum('EventType', ['h']);

    expect(en).not.toBeNull();
    expect(en!.members).toEqual(members);
  });

  it('findTypeAlias returns the aliased type text', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (query) =>
      query.includes('MATCH (t:TypeAlias)')
        ? [
            {
              t: {
                id: 'h:type_alias:src/types.ts:Status',
                name: 'Status',
                filePath: 'src/types.ts',
                startLine: 1,
                endLine: 1,
                isExported: true,
                aliasedTypeText: "'active' | 'inactive'",
              },
            },
          ]
        : [];

    const ta = await repo.findTypeAlias('Status', ['h']);

    expect(ta?.aliasedTypeText).toBe("'active' | 'inactive'");
  });

  it('findClass parses persisted properties_ back into properties', async () => {
    const { repo, driver } = makeRepo();
    const props = [
      { name: 'url', typeText: 'string', isOptional: false },
      { name: 'token', typeText: 'string', isReadonly: true },
    ];
    driver.responder = (query) =>
      query.includes('MATCH (c:Class)')
        ? [
            {
              c: {
                id: 'h:class:src/dto.ts:CreateWebhookDto',
                name: 'CreateWebhookDto',
                filePath: 'src/dto.ts',
                startLine: 1,
                endLine: 10,
                isExported: true,
                isAbstract: false,
                properties_: JSON.stringify(props),
              },
            },
          ]
        : [];

    const cls = await repo.findClass('CreateWebhookDto', ['h']);

    expect(cls?.properties).toEqual(props);
  });

  it('findInterface parses persisted members', async () => {
    const { repo, driver } = makeRepo();
    const members = [
      { name: 'id', kind: 'property', typeText: 'string', isOptional: false },
      { name: 'compute', kind: 'method', returnTypeText: 'number' },
    ];
    driver.responder = (query) =>
      query.includes('MATCH (i:Interface)')
        ? [
            {
              i: {
                id: 'h:interface:src/types.ts:Computable',
                name: 'Computable',
                filePath: 'src/types.ts',
                startLine: 1,
                endLine: 8,
                isExported: true,
                members: JSON.stringify(members),
              },
            },
          ]
        : [];

    const iface = await repo.findInterface('Computable', ['h']);

    expect(iface?.members).toEqual(members);
  });
});

describe('Neo4jRepository.getCoverageCounts', () => {
  const HASH = 'covaaa111222';

  /** Responder serving all five coverage queries for one repo. */
  const coverageResponder: Responder = (query) => {
    if (query.includes('MATCH (r:Repository)')) return [{ hash: HASH, name: 'cov-repo' }];
    if (query.includes('NOT n:Repository'))
      return [
        { hash: HASH, label: 'Function', c: 3 },
        { hash: HASH, label: 'Entity', c: 2 },
        { hash: HASH, label: 'ExternalCall', c: 2 },
      ];
    if (query.includes('OPERATES_ON')) return [{ hash: HASH, n: 1 }];
    if (query.includes('[:CALLS]')) return [{ hash: HASH, n: 1 }];
    if (query.includes('RESOLVES_TO')) return [{ hash: HASH, n: 1 }];
    return [];
  };

  it('merges the grouped queries into per-repo counts (SQLite parity)', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = coverageResponder;

    const counts = await repo.getCoverageCounts([HASH]);

    expect(counts).toEqual([
      {
        repoName: 'cov-repo',
        nodeCountsByType: { function: 3, entity: 2, external_call: 2 },
        entityCount: 2,
        entitiesWithDbOps: 1,
        functionCount: 3,
        functionsWithCalls: 1,
        externalCallCount: 2,
        resolvedExternalCallCount: 1,
      },
    ]);
  });

  it('scopes every sub-query by the repo-hash id prefix', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = coverageResponder;

    await repo.getCoverageCounts([HASH]);

    const scoped = driver.calls.filter((c) => c.query.includes(`STARTS WITH '${HASH}`));
    // repo query (prefix without ':') + 4 stat queries (prefix with ':')
    expect(scoped).toHaveLength(5);
    expect(queryMatching(driver, 'OPERATES_ON')!.query).toContain(`e.id STARTS WITH '${HASH}:'`);
    expect(queryMatching(driver, '[:CALLS]')!.query).toContain(`f.id STARTS WITH '${HASH}:'`);
    expect(queryMatching(driver, 'RESOLVES_TO')!.query).toContain(`ec.id STARTS WITH '${HASH}:'`);
  });

  it('returns empty array when no repository matches', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];

    expect(await repo.getCoverageCounts(['missing123456'])).toEqual([]);
  });
});

describe('Neo4jRepository — Tier B graph explorer', () => {
  const H = 'expl11122233';
  const F = `${H}:function:a.ts:f`;

  it('getNodesByIds: CodeNode match, no-colon repo prefix, repository join, badge mapping', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (q) =>
      q.includes('MATCH (n:CodeNode)')
        ? [
            {
              id: `${H}:entrypoint:src/r.ts:GET /u`,
              typeLabel: 'Entrypoint',
              name: 'GET /u',
              repoName: 'gateway',
              filePath: 'src/r.ts',
              startLine: 8,
              summary: null,
              pMethod: 'GET',
              pEntrypointType: 'http',
              pProtocol: null,
            },
          ]
        : [];

    const rows = await repo.getNodesByIds([`${H}:entrypoint:src/r.ts:GET /u`], [H]);
    const q = queryMatching(driver, 'MATCH (n:CodeNode)')!.query;
    expect(q).toContain('n.id IN $ids');
    expect(q).toContain(`n.id STARTS WITH '${H}'`);
    expect(q).toContain('OPTIONAL MATCH (rp:Repository');
    expect(driver.calls.at(-1)!.params).toMatchObject({ ids: [`${H}:entrypoint:src/r.ts:GET /u`] });
    expect(rows[0]).toMatchObject({ type: 'entrypoint', name: 'GET /u', repoName: 'gateway', badge: 'GET' });
  });

  it('getNodesByIds: short-circuits on empty ids without querying', async () => {
    const { repo, driver } = makeRepo();
    expect(await repo.getNodesByIds([], [H])).toEqual([]);
    expect(driver.calls).toHaveLength(0);
  });

  it('getNeighborCounts: UNION ALLs the out/in directed matches and maps counts', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      { edgeType: 'CALLS', direction: 'out', count: 2 },
      { edgeType: 'MAKES_EXTERNAL_CALL', direction: 'out', count: 1 },
      { edgeType: 'CALLS', direction: 'in', count: 1 },
    ];
    const counts = await repo.getNeighborCounts(F, [H]);
    const q = lastQuery(driver);
    expect(q).toContain("'out' AS direction");
    expect(q).toContain("'in' AS direction");
    expect(q).toContain('UNION ALL');
    expect(q).toContain('count(*) AS count');
    expect(counts).toEqual([
      { edgeType: 'CALLS', direction: 'out', count: 2 },
      { edgeType: 'MAKES_EXTERNAL_CALL', direction: 'out', count: 1 },
      { edgeType: 'CALLS', direction: 'in', count: 1 },
    ]);
  });

  it('getNeighbors: picks the arrow per direction and binds edgeTypes/cursor params', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [];

    await repo.getNeighbors(F, { direction: 'out', edgeTypes: [EdgeType.Calls], limit: 50 }, [H]);
    let q = lastQuery(driver);
    expect(q).toContain('-[e]->(nb:CodeNode)');
    expect(q).toContain('type(e) IN $edgeTypes');
    expect(q).toContain('startNode(e).id AS edgeSource');
    expect(q).toContain('LIMIT $limitPlus1');
    expect(driver.calls.at(-1)!.params).toMatchObject({ edgeTypes: [EdgeType.Calls] });

    await repo.getNeighbors(F, { direction: 'in', limit: 50 }, [H]);
    expect(lastQuery(driver)).toContain('<-[e]-(nb:CodeNode)');

    await repo.getNeighbors(F, { limit: 50, cursor: 'c1' }, [H]);
    q = lastQuery(driver);
    expect(q).toContain('-[e]-(nb:CodeNode)');
    expect(q).toContain('e.id > $cursor');
    expect(driver.calls.at(-1)!.params).toMatchObject({ cursor: 'c1' });
  });

  it('getNeighbors: maps viz nodes/edges and flags truncation via limit+1', async () => {
    const { repo, driver } = makeRepo();
    const mkRow = (edgeId: string, target: string, conf: number, by: string) => ({
      edgeId,
      edgeSource: F,
      edgeTarget: target,
      edgeType: 'CALLS',
      confidence: conf,
      createdBy: by,
      edgeOperation: null,
      id: target,
      typeLabel: 'Function',
      name: target.split(':').pop(),
      repoName: 'gateway',
      filePath: 'a.ts',
      startLine: 3,
      summary: null,
      pMethod: null,
      pEntrypointType: null,
      pProtocol: null,
    });
    driver.responder = () => [
      mkRow('e1', `${H}:function:a.ts:g`, 1, 'parser'),
      mkRow('e2', `${H}:function:a.ts:h`, 0.6, 'ai'),
    ];

    const page = await repo.getNeighbors(F, { direction: 'out', limit: 1 }, [H]);
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBe('e1');
    expect(page.nodes).toHaveLength(1);
    expect(page.edges[0]).toMatchObject({
      id: 'e1',
      confidence: 1,
      createdBy: 'parser',
      sourceId: F,
      targetId: `${H}:function:a.ts:g`,
    });
  });
});

describe('Neo4jRepository — Tier C C4 view', () => {
  const H = 'c4aaa111222';

  it('getPackageDependencyRollup: resolves fileId→File→packageId→Package and aggregates', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = () => [
      {
        sourcePackageId: `${H}:package:a:a`,
        sourcePackageName: 'pkgA',
        targetPackageId: `${H}:package:b:b`,
        targetPackageName: 'pkgB',
        callCount: 3,
        minConfidence: 0.5,
        inferred: 1,
      },
    ];
    const rollup = await repo.getPackageDependencyRollup([H]);
    const q = lastQuery(driver);
    expect(q).toContain('MATCH (sfn:Function)-[e:CALLS]->(tfn:Function)');
    expect(q).toContain('(sfile:File { id: sfn.fileId })');
    expect(q).toContain('(spkg:Package { id: sfile.packageId })');
    expect(q).toContain('spkg.id <> tpkg.id');
    expect(q).toContain('count(*) AS callCount');
    expect(rollup[0]).toEqual({
      sourcePackageId: `${H}:package:a:a`,
      sourcePackageName: 'pkgA',
      targetPackageId: `${H}:package:b:b`,
      targetPackageName: 'pkgB',
      callCount: 3,
      minConfidence: 0.5,
      inferred: true,
    });
  });

  it('getComponentGraph: filters to component labels and maps nodes/edges', async () => {
    const { repo, driver } = makeRepo();
    driver.responder = (q) => {
      if (q.includes('startNode(e).id AS sourceId')) {
        return [
          {
            sourceId: `${H}:component:c.tsx:C1`,
            targetId: `${H}:component:c.tsx:C2`,
            type: 'RENDERS_COMPONENT',
            confidence: 1,
            createdBy: 'parser',
          },
        ];
      }
      // nodes query
      return [
        {
          id: `${H}:component:c.tsx:C1`,
          typeLabel: 'Component',
          name: 'C1',
          filePath: 'src/c.tsx',
          startLine: 1,
          summary: 'card',
        },
      ];
    };

    const graph = await repo.getComponentGraph([H]);

    const nodesQuery = queryMatching(driver, 'RETURN n.id AS id')!.query;
    expect(nodesQuery).toContain('(n:Entrypoint OR n:Component OR n:Class OR n:StateStore)');
    const edgesQuery = queryMatching(driver, 'startNode(e).id AS sourceId')!.query;
    expect(edgesQuery).toContain('(s:Entrypoint OR s:Component OR s:Class OR s:StateStore)');

    expect(graph.nodes[0]).toMatchObject({
      id: `${H}:component:c.tsx:C1`,
      type: 'component',
      name: 'C1',
      filePath: 'src/c.tsx',
      summary: 'card',
    });
    expect(graph.edges[0]).toMatchObject({
      type: 'RENDERS_COMPONENT',
      sourceId: `${H}:component:c.tsx:C1`,
      targetId: `${H}:component:c.tsx:C2`,
      confidence: 1,
      createdBy: 'parser',
    });
  });
});

describe('Neo4jRepository — runReadOnlyCypher EXPLAIN classification + rows', () => {
  const rec = (obj: Record<string, unknown>) => ({
    keys: Object.keys(obj),
    get: (key: string) => obj[key],
  });

  it('runs EXPLAIN with the identical query+params BEFORE executing the query', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ kind: 'Function', c: 3 })];

    const query = 'MATCH (n) RETURN n.type AS kind, count(*) AS c';
    const params = { limitKind: 'Function' };
    await repo.runReadOnlyCypherRows(query, { limit: 200, params });

    expect(driver.explainCalls).toHaveLength(1);
    expect(driver.explainCalls[0]!.query).toBe(`EXPLAIN ${query}`);
    expect(driver.explainCalls[0]!.params).toEqual(params);
    // execute happened AND with the same params
    expect(driver.runCalls).toHaveLength(1);
    expect(driver.runCalls[0]!.query).toBe(query);
    expect(driver.runCalls[0]!.params).toEqual(params);
  });

  it('a non-"r" classification prevents the execute call (fail closed)', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'rw';

    await expect(repo.runReadOnlyCypherRows('MATCH (n) RETURN n', { limit: 10 })).rejects.toThrow(/read-only/i);

    expect(driver.explainCalls).toHaveLength(1);
    // the real query must NOT have executed
    expect(driver.runCalls).toHaveLength(0);
  });

  it('the graph shape also classifies via EXPLAIN and threads params', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [];

    const query = 'MATCH (n) RETURN n';
    const params = { id: 'x' };
    await repo.runReadOnlyCypher(query, { limit: 50, params });

    expect(driver.explainCalls[0]!.query).toBe(`EXPLAIN ${query}`);
    expect(driver.explainCalls[0]!.params).toEqual(params);
    expect(driver.runCalls[0]!.params).toEqual(params);
  });

  it('the guard rejects a mutation before any driver call', async () => {
    const { repo, driver } = makeRepo();
    await expect(repo.runReadOnlyCypherRows('MATCH (n) SET n.x = 1 RETURN n', { limit: 10 })).rejects.toThrow(
      /read-only/i,
    );
    expect(driver.explainCalls).toHaveLength(0);
    expect(driver.runCalls).toHaveLength(0);
  });

  it('normalizes rows: safe BigInt→number, unsafe BigInt→decimal string', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    const unsafe = 9007199254740993n; // > MAX_SAFE_INTEGER
    driver.cypherRecords = [rec({ small: 42n, big: unsafe, name: 'fn', flag: true, none: null })];

    const result = await repo.runReadOnlyCypherRows('MATCH (n) RETURN n.small, n.big', { limit: 10 });

    expect(result.columns).toEqual(['small', 'big', 'name', 'flag', 'none']);
    expect(result.rows[0]).toEqual([42, unsafe.toString(), 'fn', true, null]);
    expect(result.truncated).toBe(false);
  });

  it('normalizes a Neo4j Integer via inSafeRange/toNumber, unsafe→toString', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    const safeInt = { inSafeRange: () => true, toNumber: () => 7, toString: () => '7' };
    const unsafeInt = { inSafeRange: () => false, toNumber: () => 0, toString: () => '9007199254740993' };
    driver.cypherRecords = [rec({ a: safeInt, b: unsafeInt })];

    const result = await repo.runReadOnlyCypherRows('MATCH (n) RETURN n.a, n.b', { limit: 10 });
    expect(result.rows[0]).toEqual([7, '9007199254740993']);
  });

  it('rejects a composite cell (list/map/node) with projection guidance', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ arr: [1, 2, 3] })];

    await expect(repo.runReadOnlyCypherRows('MATCH (n) RETURN collect(n)', { limit: 10 })).rejects.toThrow(
      /scalar|project|resultShape/i,
    );
  });

  it('caps rows at limit and reports truncated', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ x: 1 }), rec({ x: 2 }), rec({ x: 3 })];

    const result = await repo.runReadOnlyCypherRows('MATCH (n) RETURN n.x', { limit: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('Neo4jRepository — Cypher source fail-closed (S11)', () => {
  const rec = (obj: Record<string, unknown>) => ({
    keys: Object.keys(obj),
    get: (key: string) => obj[key],
    values: () => Object.values(obj),
  });

  const sourceBearingNode = {
    identity: 1,
    labels: ['Function'],
    properties: { id: 'r:function:sourced', name: 'sourced', sourceCode: 'export function sourced() {}' },
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Source protection is enforced QUERY-SIDE, before execution: a query that
  // references a source-bearing property is rejected outright when the serve
  // flag is off. This replaces the old (bypassable) output-scan — projecting
  // `n.sourceCode AS s` renamed the column past the scanner but the query text
  // still names the property, so the query-side check catches it.

  it('rejects a rows-shape query that projects n.properties, before execution', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ properties: JSON.stringify({ name: 'sourced', sourceCode: 'export {}' }) })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', '');
    await expect(
      repo.runReadOnlyCypherRows('MATCH (n) RETURN n.properties AS properties', { limit: 10 }),
    ).rejects.toThrow(/source-in-graph is disabled/i);
    // rejected before any driver call — not an output-scan after execution
    expect(driver.explainCalls).toHaveLength(0);
    expect(driver.runCalls).toHaveLength(0);
  });

  it('allows the same rows-shape query when the deployment opts in to serving source', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ properties: JSON.stringify({ name: 'sourced', sourceCode: 'export {}' }) })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    await expect(
      repo.runReadOnlyCypherRows('MATCH (n) RETURN n.properties AS properties', { limit: 10 }),
    ).resolves.toMatchObject({ truncated: false });
  });

  it('catches the previously-bypassing aliased projection RETURN n.sourceCode AS s (flag off)', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    // Aliasing renames the OUTPUT column, defeating any output-scan — but the
    // query text still names `sourceCode`, so the query-side check rejects it.
    driver.cypherRecords = [rec({ s: 'export function sourced() {}' })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', '');
    await expect(
      repo.runReadOnlyCypherRows('MATCH (n:CodeNode) WHERE n.sourceCode IS NOT NULL RETURN n.sourceCode AS s', {
        limit: 10,
      }),
    ).rejects.toThrow(/source-in-graph is disabled/i);
    expect(driver.explainCalls).toHaveLength(0);
    expect(driver.runCalls).toHaveLength(0);
  });

  it('allows the aliased sourceCode projection when the deployment opts in to serving source', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ s: 'export function sourced() {}' })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    const result = await repo.runReadOnlyCypherRows(
      'MATCH (n:CodeNode) WHERE n.sourceCode IS NOT NULL RETURN n.sourceCode AS s',
      { limit: 10 },
    );
    expect(result.rows[0]).toEqual(['export function sourced() {}']);
  });

  it('rejects a graph-shape query that references sourceCode, before execution', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ n: sourceBearingNode })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', '');
    await expect(
      repo.runReadOnlyCypher('MATCH (n) WHERE n.sourceCode IS NOT NULL RETURN n', { limit: 10 }),
    ).rejects.toThrow(/source-in-graph is disabled/i);
    expect(driver.explainCalls).toHaveLength(0);
    expect(driver.runCalls).toHaveLength(0);
  });

  it('allows a graph-shape query when the deployment opts in to serving source', async () => {
    const { repo, driver } = makeRepo();
    driver.cypherQueryType = 'r';
    driver.cypherRecords = [rec({ n: sourceBearingNode })];

    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    const result = await repo.runReadOnlyCypher('MATCH (n) WHERE n.sourceCode IS NOT NULL RETURN n', { limit: 10 });
    expect(result.nodes).toHaveLength(1);
  });
});

/**
 * The cross-backend contract test covers sqlite + ladybug only (Neo4j needs a
 * live server), so the shared `clampLimit` contract is pinned here against the
 * fake driver: an over-max or non-positive limit must never reach Cypher raw.
 */
describe('Neo4jRepository limit clamping', () => {
  it('caps getNeighbors at 200 and falls back to 50 for a non-positive limit', async () => {
    const { repo, driver } = makeRepo();

    await repo.getNeighbors('n1', { direction: 'out', limit: 5000 }, ['hash']);
    expect(Number(driver.calls[0]!.params.limitPlus1)).toBe(201);

    await repo.getNeighbors('n1', { direction: 'out', limit: 0 }, ['hash']);
    expect(Number(driver.calls[1]!.params.limitPlus1)).toBe(51);
  });

  it('caps findDeadNodes at 200 and listNodesByType at 1000', async () => {
    const { repo, driver } = makeRepo();

    await repo.findDeadNodes({ limit: 5000 }, ['hash']);
    expect(Number(queryMatching(driver, 'coalesce(n.isExported, false)')!.params.limitPlus1)).toBe(201);

    await repo.listNodesByType(NodeType.Function, { limit: 5000 }, ['hash']);
    expect(Number(driver.calls[driver.calls.length - 1]!.params.limitPlus1)).toBe(1001);
  });

  it('caps listEntrypoints at 1000', async () => {
    const { repo, driver } = makeRepo();

    await repo.listEntrypoints({ limit: 5000 }, ['hash']);
    expect(Number(queryMatching(driver, 'MATCH (ep:Entrypoint)')!.params.limit)).toBe(1000);
  });

  it('caps getEdgesAmong at 10000', async () => {
    const { repo, driver } = makeRepo();

    await repo.getEdgesAmong(['n1', 'n2'], ['hash'], 50_000);
    expect(Number(driver.calls[driver.calls.length - 1]!.params.limitPlus1)).toBe(10_001);
  });

  it('findCode treats regex metacharacters in a glob as literals', async () => {
    const { repo, driver } = makeRepo();

    await repo.findCode({ pattern: '*.Webhook(*' }, ['hash']);
    const sent = String(driver.calls[driver.calls.length - 1]!.params.pattern);
    expect(sent.startsWith('(?i)')).toBe(true);
    const regex = new RegExp(`^${sent.slice('(?i)'.length)}$`, 'i');
    expect(regex.test('Ns.Webhook(string)')).toBe(true);
    expect(regex.test('NsXWebhook(string)')).toBe(false);
  });

  it('caps findCode at 1000', async () => {
    const { repo, driver } = makeRepo();

    await repo.findCode({ pattern: '*', limit: 5000 }, ['hash']);
    expect(Number(driver.calls[driver.calls.length - 1]!.params.limit)).toBe(1000);
  });
});
