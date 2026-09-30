/**
 * REST↔MCP Parity Gate (Task 9, B1-3)
 *
 * The strategy's verification gate for B1/B2: "graph REST parity spot-check
 * vs MCP tool output" — pinned here as a permanent, automated test instead of
 * a manual step. For the SAME underlying workspace data (a real SQLite graph,
 * no mocked repository), the REST GraphService and the portable @coredoc/mcp
 * handlers it wraps must return byte-identical `data` payloads.
 *
 * This test MUST fail if a future change reshapes, filters, or renames fields
 * in GraphService before returning them — that is its entire purpose. Do not
 * weaken these assertions (no `toMatchObject`, no field subsets) to make a
 * genuine divergence pass; a failure here means Task 8's service reshaped the
 * handler's output and the fix belongs there, not in this test.
 *
 * NOTE on `overview`: unlike the other four groups below, there is no MCP
 * tool handler with this `{ repos, coverage }` shape to compare against — it
 * composes `getRepoOverview` + `getCoverageCounts` directly, so "parity" for
 * it means something narrower: an internal-consistency check (GraphService's
 * composition matches calling the two repository methods directly) PLUS a
 * literal, hardcoded expected payload pinning the exact shape, so a future
 * reshape in GraphService.overview fails even though there is no second path
 * to diff against. The other six cases (searchSymbols x2, serviceDependencies
 * x2, entrypoints x2) remain true two-path parity: REST vs the real MCP
 * handler, same args, same fixture.
 *
 * NOTE on `edgesAmong`: the second REST-only exception, for the same reason —
 * the explorer's canvas-linking route has no MCP tool counterpart (there is no
 * assistant use case for "edges among this arbitrary id set"). It lives here
 * rather than in the mocked graph.service.test.ts because its two real risks —
 * leaking an edge with only ONE endpoint in the set, and mis-applying the
 * limit — are properties of the SQL the repository runs, which a mocked
 * repository cannot exhibit. So "parity" for it means: REST output equals what
 * the real SqliteRepository returns for the same ids, pinned against a fixture
 * that deliberately contains half-in edges.
 *
 * Fixture: a real `SqliteRepository` over a real `SqliteDriver` backed by a
 * tmp-file SQLite DB (direct construction — no env vars, no backend-factory
 * singleton), following the pattern in
 * packages/db/src/sqlite/repository.test.ts. Seed data shapes (GraphNode /
 * GraphEdge field names, external_call `serviceName` property) mirror
 * packages/mcp/src/__tests__/fixtures/seed-data.ts, which is not itself
 * importable here (packages/mcp only publicly exports `.` and `./tools`).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SqliteDriver, SqliteRepository, NodeType, EdgeType } from '@coredoc/db';
import type { GraphNode, GraphEdge, IGraphRepository } from '@coredoc/db';
import type { ScopeContext } from '@coredoc/mcp';
import { resolveDetailLevel } from '@coredoc/mcp';
import { handleSearchSymbols, handleListEntrypoints, handleListServiceDependencies } from '@coredoc/mcp/tools';

import { GraphService } from './graph.service.js';
import type { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { resolveWorkspaceScope } from '../../mcp/workspace-scope-resolver.js';

// =============================================================================
// Fixture repo hashes / names — two repos, matching the brief's "2 repos"
// requirement, with a cross-service call between them.
// =============================================================================

const USER_SVC_HASH = 'usrsvc123456';
const ORDER_SVC_HASH = 'ordsvc789012';
const USER_SVC_NAME = 'user-service';
const ORDER_SVC_NAME = 'order-service';

const REPOS = [
  { repoName: USER_SVC_NAME, repoKey: USER_SVC_HASH },
  { repoName: ORDER_SVC_NAME, repoKey: ORDER_SVC_HASH },
];

// =============================================================================
// Seed data — small but non-trivial: functions + a class per repo, an entity,
// >=2 entrypoint types (http + kafka), and >=2 external calls with distinct
// serviceName + distinct callCount (avoids a callCount tie, which would make
// list_service_dependencies' Map-insertion-order tiebreak a source of test
// flakiness — see graph.service.ts callers for why ordering matters).
// =============================================================================

function buildFixtureGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // --- repository nodes ---
  nodes.push({
    id: USER_SVC_HASH,
    type: NodeType.Repository,
    name: USER_SVC_NAME,
    properties: { type: 'backend', parsedAt: '2026-06-01T00:00:00Z' },
  });
  nodes.push({
    id: ORDER_SVC_HASH,
    type: NodeType.Repository,
    name: ORDER_SVC_NAME,
    properties: { type: 'backend', parsedAt: '2026-06-01T00:00:00Z' },
  });

  // --- user-service: class + functions + entity + http & kafka entrypoints ---
  const userServiceClassId = `${USER_SVC_HASH}:class:src/services/user.service.ts:UserService`;
  nodes.push({
    id: userServiceClassId,
    type: NodeType.Class,
    name: 'UserService',
    properties: { isExported: true, isAbstract: false },
    repoId: USER_SVC_HASH,
    filePath: 'src/services/user.service.ts',
    startLine: 10,
    endLine: 110,
  });

  const createUserId = `${USER_SVC_HASH}:function:src/services/user.service.ts:createUser`;
  nodes.push({
    id: createUserId,
    type: NodeType.Function,
    name: 'createUser',
    summary: 'Creates a new user',
    properties: { kind: 'method', isAsync: true, classId: userServiceClassId, visibility: 'public' },
    repoId: USER_SVC_HASH,
    filePath: 'src/services/user.service.ts',
    startLine: 20,
    endLine: 35,
  });

  const notifyOrderServiceId = `${USER_SVC_HASH}:function:src/services/user.service.ts:notifyOrderService`;
  nodes.push({
    id: notifyOrderServiceId,
    type: NodeType.Function,
    name: 'notifyOrderService',
    summary: 'Notifies order-service of a user change',
    properties: { kind: 'method', isAsync: true, classId: userServiceClassId, visibility: 'public' },
    repoId: USER_SVC_HASH,
    filePath: 'src/services/user.service.ts',
    startLine: 40,
    endLine: 55,
  });

  edges.push({
    id: 'edge:has_method:1',
    sourceId: userServiceClassId,
    targetId: createUserId,
    type: EdgeType.HasMethod,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });
  edges.push({
    id: 'edge:has_method:2',
    sourceId: userServiceClassId,
    targetId: notifyOrderServiceId,
    type: EdgeType.HasMethod,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });
  edges.push({
    id: 'edge:calls:1',
    sourceId: createUserId,
    targetId: notifyOrderServiceId,
    type: EdgeType.Calls,
    confidence: 1.0,
    createdBy: 'parser',
    properties: { line: 25 },
  });

  const userEntityId = `${USER_SVC_HASH}:entity:src/entities/user.entity.ts:User`;
  nodes.push({
    id: userEntityId,
    type: NodeType.Entity,
    name: 'User',
    properties: { tableName: 'users', ormType: 'TypeORM' },
    repoId: USER_SVC_HASH,
    filePath: 'src/entities/user.entity.ts',
    startLine: 1,
    endLine: 30,
  });
  edges.push({
    id: 'edge:operates_on:1',
    sourceId: createUserId,
    targetId: userEntityId,
    type: EdgeType.OperatesOn,
    confidence: 1.0,
    createdBy: 'parser',
    properties: { operation: 'create' },
  });

  // HTTP entrypoint (type #1)
  const postUsersId = `${USER_SVC_HASH}:entrypoint:src/controllers/user.controller.ts:POST /users`;
  nodes.push({
    id: postUsersId,
    type: NodeType.Entrypoint,
    name: 'POST /users',
    properties: {
      entrypointType: 'http',
      method: 'POST',
      path: '/users',
      fullPath: '/api/users',
      handlerId: createUserId,
    },
    repoId: USER_SVC_HASH,
    filePath: 'src/controllers/user.controller.ts',
    startLine: 15,
  });
  edges.push({
    id: 'edge:handles:1',
    sourceId: postUsersId,
    targetId: createUserId,
    type: EdgeType.Handles,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  // Kafka entrypoint (type #2 — distinct protocol from http, per brief's
  // ">=2 entrypoints of different types")
  const kafkaUserCreatedId = `${USER_SVC_HASH}:entrypoint:src/consumers/user.consumer.ts:kafka:user.created`;
  nodes.push({
    id: kafkaUserCreatedId,
    type: NodeType.Entrypoint,
    name: 'kafka:user.created',
    properties: {
      entrypointType: 'queue',
      topic: 'user.created',
      handlerId: notifyOrderServiceId,
    },
    repoId: USER_SVC_HASH,
    filePath: 'src/consumers/user.consumer.ts',
    startLine: 8,
  });
  edges.push({
    id: 'edge:handles:2',
    sourceId: kafkaUserCreatedId,
    targetId: notifyOrderServiceId,
    type: EdgeType.Handles,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  // External call #1: user-service -> order-service (kafka), 1 call — distinct
  // callCount from the http external call below.
  const extCallToOrderId = `${USER_SVC_HASH}:external_call:${ORDER_SVC_NAME}:1`;
  nodes.push({
    id: extCallToOrderId,
    type: NodeType.ExternalCall,
    name: `${ORDER_SVC_NAME}:user.changed`,
    properties: {
      callerId: notifyOrderServiceId,
      serviceName: ORDER_SVC_NAME,
      protocol: 'messaging',
      method: 'user.changed',
      messagingSystem: 'kafka',
      messagingDestination: 'user.changed',
    },
    repoId: USER_SVC_HASH,
    filePath: 'src/services/user.service.ts',
    startLine: 45,
  });
  edges.push({
    id: 'edge:makes_external_call:1',
    sourceId: notifyOrderServiceId,
    targetId: extCallToOrderId,
    type: EdgeType.MakesExternalCall,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  // --- order-service: class + functions + http entrypoints ---
  const orderServiceClassId = `${ORDER_SVC_HASH}:class:src/services/order.service.ts:OrderService`;
  nodes.push({
    id: orderServiceClassId,
    type: NodeType.Class,
    name: 'OrderService',
    properties: { isExported: true, isAbstract: false },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/services/order.service.ts',
    startLine: 10,
    endLine: 90,
  });

  const createOrderId = `${ORDER_SVC_HASH}:function:src/services/order.service.ts:createOrder`;
  nodes.push({
    id: createOrderId,
    type: NodeType.Function,
    name: 'createOrder',
    summary: 'Creates a new order',
    properties: { kind: 'method', isAsync: true, classId: orderServiceClassId, visibility: 'public' },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/services/order.service.ts',
    startLine: 20,
    endLine: 40,
  });

  const enrichOrderDataId = `${ORDER_SVC_HASH}:function:src/services/order.service.ts:enrichOrderData`;
  nodes.push({
    id: enrichOrderDataId,
    type: NodeType.Function,
    name: 'enrichOrderData',
    summary: 'Fetches user details to enrich an order',
    properties: { kind: 'method', isAsync: true, classId: orderServiceClassId, visibility: 'public' },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/services/order.service.ts',
    startLine: 45,
    endLine: 60,
  });

  edges.push({
    id: 'edge:has_method:3',
    sourceId: orderServiceClassId,
    targetId: createOrderId,
    type: EdgeType.HasMethod,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });
  edges.push({
    id: 'edge:has_method:4',
    sourceId: orderServiceClassId,
    targetId: enrichOrderDataId,
    type: EdgeType.HasMethod,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });
  edges.push({
    id: 'edge:calls:2',
    sourceId: createOrderId,
    targetId: enrichOrderDataId,
    type: EdgeType.Calls,
    confidence: 1.0,
    createdBy: 'parser',
    properties: { line: 22 },
  });

  const postOrdersId = `${ORDER_SVC_HASH}:entrypoint:src/controllers/order.controller.ts:POST /orders`;
  nodes.push({
    id: postOrdersId,
    type: NodeType.Entrypoint,
    name: 'POST /orders',
    properties: {
      entrypointType: 'http',
      method: 'POST',
      path: '/orders',
      fullPath: '/api/orders',
      handlerId: createOrderId,
    },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/controllers/order.controller.ts',
    startLine: 12,
  });
  edges.push({
    id: 'edge:handles:3',
    sourceId: postOrdersId,
    targetId: createOrderId,
    type: EdgeType.Handles,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  // External calls #2 and #3: order-service -> user-service (http), 2 calls —
  // callCount=2 vs the kafka external call's callCount=1 above, so
  // list_service_dependencies' callCount-desc sort has no tie to resolve.
  const extCallToUser1Id = `${ORDER_SVC_HASH}:external_call:${USER_SVC_NAME}:1`;
  nodes.push({
    id: extCallToUser1Id,
    type: NodeType.ExternalCall,
    name: `${USER_SVC_NAME}:GET /api/users/:id`,
    properties: {
      callerId: enrichOrderDataId,
      serviceName: USER_SVC_NAME,
      protocol: 'http',
      method: 'getUser',
      httpMethod: 'GET',
      pathTemplate: '/api/users/:id',
    },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/services/order.service.ts',
    startLine: 50,
  });
  edges.push({
    id: 'edge:makes_external_call:2',
    sourceId: enrichOrderDataId,
    targetId: extCallToUser1Id,
    type: EdgeType.MakesExternalCall,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  const extCallToUser2Id = `${ORDER_SVC_HASH}:external_call:${USER_SVC_NAME}:2`;
  nodes.push({
    id: extCallToUser2Id,
    type: NodeType.ExternalCall,
    name: `${USER_SVC_NAME}:GET /api/users/:id/profile`,
    properties: {
      callerId: enrichOrderDataId,
      serviceName: USER_SVC_NAME,
      protocol: 'http',
      method: 'getUserProfile',
      httpMethod: 'GET',
      pathTemplate: '/api/users/:id/profile',
    },
    repoId: ORDER_SVC_HASH,
    filePath: 'src/services/order.service.ts',
    startLine: 55,
  });
  edges.push({
    id: 'edge:makes_external_call:3',
    sourceId: enrichOrderDataId,
    targetId: extCallToUser2Id,
    type: EdgeType.MakesExternalCall,
    confidence: 1.0,
    createdBy: 'parser',
    properties: {},
  });

  return { nodes, edges };
}

// =============================================================================
// Suite setup — real SqliteDriver + SqliteRepository over a tmp-file DB.
// Direct construction (no env vars, no @coredoc/db backend-factory singleton)
// so this test cannot collide with any other test file's DB state — pattern
// reused from packages/db/src/sqlite/repository.test.ts.
// =============================================================================

describe('GraphService REST↔MCP parity (real SQLite fixture)', () => {
  let tmpDir: string;
  let driver: SqliteDriver;
  let repository: IGraphRepository;
  let graphService: GraphService;
  let unscopedScope: ScopeContext;
  // Same FULL_DETAIL_CONFIG value graph.service.ts resolves once at module
  // load — passed explicitly to the handler calls below so "same args" is
  // literal, not just behaviorally-equivalent-via-the-handler's-own-default.
  const fullDetailConfig = resolveDetailLevel('full');

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'graph-parity-'));
    driver = new SqliteDriver(`file:${join(tmpDir, 'test.db')}`);
    await driver.initialize();
    repository = new SqliteRepository(driver);

    const { nodes, edges } = buildFixtureGraph();
    await repository.pushNodes(nodes);
    await repository.pushEdges(edges);

    unscopedScope = resolveWorkspaceScope(REPOS);

    const wsContext = {
      withContextByWorkspaceId: vi
        .fn()
        .mockImplementation(async (_workspaceId, callback) =>
          callback({ repository, scope: unscopedScope, repos: REPOS, versionId: null }),
        ),
    } as unknown as WorkspaceMcpContextService;
    graphService = new GraphService(wsContext);
  });

  afterAll(async () => {
    await driver.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // search_symbols — 2 arg variations: no type filter, and type='function'.
  // ===========================================================================

  describe('searchSymbols parity', () => {
    it('matches the handler with no type filter (all kinds)', async () => {
      const restResult = await graphService.searchSymbols('ws-1', { q: 'order' });
      const handlerResponse = await handleSearchSymbols(
        { query: 'order', limit: 20 },
        unscopedScope,
        'raw',
        'full',
        fullDetailConfig,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });

    it('matches the handler with types=function filter', async () => {
      const restResult = await graphService.searchSymbols('ws-1', { q: 'create', types: 'function' });
      const handlerResponse = await handleSearchSymbols(
        { query: 'create', type: 'function', limit: 20 },
        unscopedScope,
        'raw',
        'full',
        fullDetailConfig,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // overview — internal-consistency + literal-shape pin (see header comment:
  // there is no MCP handler with this composed shape to diff against, unlike
  // the other four groups in this file).
  // ===========================================================================

  describe('overview parity', () => {
    it('matches getRepoOverview + getCoverageCounts composed directly', async () => {
      const restResult = await graphService.overview('ws-1', {});
      const [repos, coverage] = await Promise.all([
        repository.getRepoOverview(unscopedScope.repoHashes),
        repository.getCoverageCounts(unscopedScope.repoHashes),
      ]);

      expect(restResult).toEqual({ repos, coverage });
      expect((restResult.repos as unknown[]).length).toBe(2);
    });

    // Literal expected payload (computed once against this exact fixture,
    // hardcoded here — not re-derived from the repository at test time like
    // the assertion above). This is what pins the shape: if a future
    // GraphService.overview change reshapes, renames, or drops a field, this
    // hardcoded object stops matching and the test fails — the assertion
    // above alone could not catch that, since it recomputes both sides the
    // same way GraphService does and would happily agree with a shared bug.
    it('matches a hardcoded literal payload for this fixture (fails on any reshape)', async () => {
      const restResult = await graphService.overview('ws-1', {});

      expect(restResult).toEqual({
        repos: [
          {
            name: 'order-service',
            type: 'backend',
            parsedAt: '2026-06-01T00:00:00Z',
            fileCount: 0,
            functionCount: 2,
            classCount: 1,
            entityCount: 0,
            entrypointTypes: ['http'],
          },
          {
            name: 'user-service',
            type: 'backend',
            parsedAt: '2026-06-01T00:00:00Z',
            fileCount: 0,
            functionCount: 2,
            classCount: 1,
            entityCount: 1,
            entrypointTypes: ['http', 'queue'],
          },
        ],
        coverage: [
          {
            repoName: 'order-service',
            nodeCountsByType: {
              class: 1,
              entrypoint: 1,
              external_call: 2,
              function: 2,
            },
            entityCount: 0,
            entitiesWithDbOps: 0,
            functionCount: 2,
            functionsWithCalls: 1,
            externalCallCount: 2,
            resolvedExternalCallCount: 0,
          },
          {
            repoName: 'user-service',
            nodeCountsByType: {
              class: 1,
              entity: 1,
              entrypoint: 2,
              external_call: 1,
              function: 2,
            },
            entityCount: 1,
            entitiesWithDbOps: 1,
            functionCount: 2,
            functionsWithCalls: 1,
            externalCallCount: 1,
            resolvedExternalCallCount: 0,
          },
        ],
      });
    });
  });

  // ===========================================================================
  // edges-among — REST-only (no MCP counterpart, see the header note). The
  // fixture's UserService class has HAS_METHOD edges to both functions below,
  // and createUser has an OPERATES_ON edge to the User entity — all three have
  // exactly one endpoint in the node set used here, so a query that filtered on
  // only one endpoint would leak them and fail these assertions.
  // ===========================================================================

  describe('edgesAmong (induced subgraph over an explicit node set)', () => {
    const createUserId = `${USER_SVC_HASH}:function:src/services/user.service.ts:createUser`;
    const notifyOrderServiceId = `${USER_SVC_HASH}:function:src/services/user.service.ts:notifyOrderService`;
    const userServiceClassId = `${USER_SVC_HASH}:class:src/services/user.service.ts:UserService`;

    it('returns only edges with BOTH endpoints in the set (no half-in edge leaks)', async () => {
      const result = await graphService.edgesAmong('ws-1', { nodeIds: [createUserId, notifyOrderServiceId] });

      expect(result).toEqual({
        truncated: false,
        edges: [
          {
            id: 'edge:calls:1',
            sourceId: createUserId,
            targetId: notifyOrderServiceId,
            type: EdgeType.Calls,
            confidence: 1,
            createdBy: 'parser',
          },
        ],
      });
    });

    it('matches the repository called directly for the same ids', async () => {
      const nodeIds = [userServiceClassId, createUserId, notifyOrderServiceId];
      const restResult = await graphService.edgesAmong('ws-1', { nodeIds });
      const direct = await repository.getEdgesAmong(nodeIds, unscopedScope.repoHashes, 4000);

      expect(restResult).toEqual(direct);
      expect(restResult.edges.length).toBe(3);
    });

    it('truncates at a client-supplied limit rather than dropping the flag', async () => {
      const result = await graphService.edgesAmong('ws-1', {
        nodeIds: [userServiceClassId, createUserId, notifyOrderServiceId],
        limit: 1,
      });

      expect(result.truncated).toBe(true);
      expect(result.edges.length).toBe(1);
    });
  });

  // ===========================================================================
  // list_service_dependencies — 2 arg variations: unscoped (workspace-wide,
  // aggregates both repos' external calls) and scoped to a single repo.
  // ===========================================================================

  describe('serviceDependencies parity', () => {
    it('matches the handler unscoped (aggregates external calls across both repos)', async () => {
      const restResult = await graphService.serviceDependencies('ws-1', {});
      const handlerResponse = await handleListServiceDependencies(
        {},
        unscopedScope,
        'raw',
        undefined,
        undefined,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });

    it('matches the handler scoped to order-service only', async () => {
      const scopedScope = resolveWorkspaceScope(REPOS, ORDER_SVC_NAME);
      const restResult = await graphService.serviceDependencies('ws-1', { scopeRepo: ORDER_SVC_NAME });
      const handlerResponse = await handleListServiceDependencies(
        {},
        scopedScope,
        'raw',
        undefined,
        undefined,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // list_entrypoints — 3 arg variations: no protocol filter, protocol=http,
  // and protocol=all (now a supported alias for "no filter" — SYMBOL_TYPES /
  // ENTRYPOINT_TYPES are imported from @coredoc/mcp's public surface, so the
  // REST layer accepts the same 'all' value the MCP zod schema always did;
  // see graph.service.ts's protocol handling).
  // ===========================================================================

  describe('entrypoints parity', () => {
    it('matches the handler with no protocol filter', async () => {
      const restResult = await graphService.entrypoints('ws-1', {});
      const handlerResponse = await handleListEntrypoints(
        { limit: 20 },
        unscopedScope,
        'raw',
        'full',
        fullDetailConfig,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });

    it('matches the handler with protocol=http', async () => {
      const restResult = await graphService.entrypoints('ws-1', { protocol: 'http' });
      const handlerResponse = await handleListEntrypoints(
        { type: 'http', limit: 20 },
        unscopedScope,
        'raw',
        'full',
        fullDetailConfig,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });

    it('matches the handler (no filter) with protocol=all — the REST alias for omitted', async () => {
      const restResult = await graphService.entrypoints('ws-1', { protocol: 'all' });
      const handlerResponse = await handleListEntrypoints(
        { limit: 20 },
        unscopedScope,
        'raw',
        'full',
        fullDetailConfig,
        repository,
      );

      expect(restResult).toEqual(handlerResponse.data);
      expect((restResult as unknown[]).length).toBeGreaterThan(0);
    });
  });
});
