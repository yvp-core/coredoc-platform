/**
 * Mock Repository for Database Abstraction Layer
 *
 * Provides a configurable mock IGraphRepository implementation for testing
 * MCP tool handlers without requiring an actual database connection.
 */

import { vi } from 'vitest';
// NodeType enum (runtime value) — imported from @coredoc/core (canonical source)
// so it survives `vi.mock('@coredoc/db')` in the tests that consume this fixture.
import { NodeType } from '@coredoc/core';
import type {
  IGraphRepository,
  CodeElement,
  FunctionInfo,
  ClassInfo,
  InterfaceInfo,
  EntrypointInfo,
  EntityInfo,
  CallerInfo,
  CallTreeNode,
  EntityConsumer,
  ExternalCallInfo,
  MessagingExternalCall,
  RepoOverview,
  RepoCoverageCounts,
  PathStep,
  EmbeddedNode,
} from '@coredoc/db';
import type { DbOperationType } from '@coredoc/core/types';

/**
 * Creates a mock IGraphRepository with all methods as vi.fn() mocks.
 * Default implementations return empty arrays/null.
 * Override specific methods to provide custom mock data.
 *
 * @example
 * ```typescript
 * const mockRepo = createMockRepository({
 *   findCode: vi.fn().mockResolvedValue([mockCodeElement]),
 *   findFunction: vi.fn().mockResolvedValue(mockFunction),
 * });
 * (getRepository as Mock).mockResolvedValue(mockRepo);
 * ```
 */
export function createMockRepository(overrides?: Partial<IGraphRepository>): IGraphRepository {
  return {
    // Discovery
    findCode: vi.fn().mockResolvedValue([]),
    listSymbolsInFile: vi.fn().mockResolvedValue([]),
    findFunction: vi.fn().mockResolvedValue(null),
    findClass: vi.fn().mockResolvedValue(null),
    findInterface: vi.fn().mockResolvedValue(null),
    findEnum: vi.fn().mockResolvedValue(null),
    findTypeAlias: vi.fn().mockResolvedValue(null),
    findEntity: vi.fn().mockResolvedValue(null),
    listEntities: vi.fn().mockResolvedValue([]),
    listEntrypoints: vi.fn().mockResolvedValue([]),
    getRepoOverview: vi.fn().mockResolvedValue([]),
    getCoverageCounts: vi.fn().mockResolvedValue([]),
    listAllRepositories: vi.fn().mockResolvedValue([]),
    getRepositoryNames: vi.fn().mockResolvedValue([]),
    getPackages: vi.fn().mockResolvedValue([]),
    getEmbeddedNodes: vi.fn().mockResolvedValue([]),

    // Traversals
    getDirectCallers: vi.fn().mockResolvedValue([]),
    getTransitiveCallers: vi.fn().mockResolvedValue([]),
    getReachingEntrypoints: vi.fn().mockResolvedValue([]),
    findShortestPath: vi.fn().mockResolvedValue([]),
    getCallTree: vi.fn().mockResolvedValue([]),
    getDirectCallees: vi.fn().mockResolvedValue([]),

    // Impact Analysis
    getClassExtensions: vi.fn().mockResolvedValue([]),
    getInterfaceImplementations: vi.fn().mockResolvedValue([]),
    getEntityConsumers: vi.fn().mockResolvedValue([]),
    getTypeUsages: vi.fn().mockResolvedValue([]),
    getEntitiesForFunctions: vi.fn().mockResolvedValue([]),

    // Cross-Repo
    getPackageLinkerFacts: vi.fn().mockResolvedValue({ files: [], declarations: [] }),
    getMonikeredFunctions: vi.fn().mockResolvedValue([]),
    getExternalCalls: vi.fn().mockResolvedValue([]),
    getExternalCallsWithMessaging: vi.fn().mockResolvedValue([]),
    getExternalCallsFrom: vi.fn().mockResolvedValue([]),

    // Dynamic boundaries
    findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([]),
    findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([]),
    getResolvesEdge: vi.fn().mockResolvedValue(null),

    // Graph Visualization (Tier B — explorer)
    getNodesByIds: vi.fn().mockResolvedValue([]),
    getNeighborCounts: vi.fn().mockResolvedValue([]),
    getNeighbors: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    getSubgraph: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    getEdgesAmong: vi.fn().mockResolvedValue({ edges: [], truncated: false }),
    findDeadNodes: vi.fn().mockResolvedValue({ nodes: [], truncated: false, lowCoverageRepos: [] }),
    getCrossRepoBridges: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
    listNodesByType: vi.fn().mockResolvedValue({ nodes: [], truncated: false }),
    getNodeWithProperties: vi.fn().mockResolvedValue(null),

    // Graph Visualization (Tier C — C4 view)
    getPackageDependencyRollup: vi.fn().mockResolvedValue([]),
    getComponentGraph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),

    // Push Operations
    pushNodes: vi.fn().mockResolvedValue(0),
    pushEdges: vi.fn().mockResolvedValue(0),
    deleteRepository: vi.fn().mockResolvedValue(undefined),
    deleteEdgesByType: vi.fn().mockResolvedValue(undefined),
    updateResolvedTargetIds: vi.fn().mockResolvedValue(undefined),
    clearResolvedTargetIds: vi.fn().mockResolvedValue(undefined),

    // Apply overrides
    ...overrides,
    // Required capability: keep a concrete default when a Partial override
    // object carries this property as undefined.
    getAppliedGraphSnapshot: overrides?.getAppliedGraphSnapshot ?? vi.fn().mockResolvedValue(null),
  };
}

// =============================================================================
// Mock Data Factories
// =============================================================================

/**
 * Creates a mock CodeElement for findCode results
 */
export function createMockCodeElement(overrides?: Partial<CodeElement>): CodeElement {
  return {
    id: 'abc123:function:src/test.ts:testFunction',
    name: 'testFunction',
    type: NodeType.Function,
    filePath: 'src/test.ts',
    startLine: 10,
    endLine: 20,
    ...overrides,
  };
}

/**
 * Creates a mock FunctionInfo for findFunction results
 */
export function createMockFunctionInfo(overrides?: Partial<FunctionInfo>): FunctionInfo {
  return {
    id: 'abc123:function:src/service.ts:handleRequest',
    name: 'handleRequest',
    kind: 'function',
    filePath: 'src/service.ts',
    startLine: 10,
    endLine: 30,
    isAsync: true,
    ...overrides,
  };
}

/**
 * Creates a mock ClassInfo for findClass results
 */
export function createMockClassInfo(overrides?: Partial<ClassInfo>): ClassInfo {
  return {
    id: 'abc123:class:src/service.ts:UserService',
    name: 'UserService',
    filePath: 'src/service.ts',
    startLine: 1,
    endLine: 100,
    isExported: true,
    isAbstract: false,
    ...overrides,
  };
}

/**
 * Creates a mock InterfaceInfo for findInterface results
 */
export function createMockInterfaceInfo(overrides?: Partial<InterfaceInfo>): InterfaceInfo {
  return {
    id: 'abc123:interface:src/types.ts:IUserService',
    name: 'IUserService',
    filePath: 'src/types.ts',
    startLine: 5,
    endLine: 20,
    isExported: true,
    ...overrides,
  };
}

/**
 * Creates a mock EntrypointInfo for listEntrypoints results
 */
export function createMockEntrypointInfo(overrides?: Partial<EntrypointInfo>): EntrypointInfo {
  return {
    id: 'abc123:entrypoint:http:GET:/api/users',
    type: 'http',
    handlerId: 'abc123:function:src/controller.ts:getUsers',
    handlerName: 'getUsers',
    method: 'GET',
    path: '/api/users',
    fullPath: '/api/users',
    filePath: 'src/routes.ts',
    startLine: 10,
    ...overrides,
  };
}

/**
 * Creates a mock ExternalCallInfo for getExternalCalls results.
 * Messaging-producer shaped by default (list_service_dependencies /
 * trace_cross_repo_call are its consumers); override
 * protocol/messagingSystem/messagingDestination for other call shapes.
 */
export function createMockExternalCallInfo(overrides?: Partial<ExternalCallInfo>): ExternalCallInfo {
  return {
    id: 'abc123:external_call:src/producer.ts:42',
    callerId: 'abc123:function:src/producer.ts:publishEvent',
    callerName: 'publishEvent',
    callerFilePath: 'src/producer.ts',
    serviceName: 'kafka',
    method: 'send',
    protocol: 'messaging',
    messagingSystem: 'kafka',
    messagingDestination: 'user-events',
    filePath: 'src/producer.ts',
    startLine: 42,
    ...overrides,
  };
}

/**
 * Creates a mock MessagingExternalCall for destination tracing.
 */
export function createMockMessagingExternalCall(overrides?: Partial<MessagingExternalCall>): MessagingExternalCall {
  return {
    id: 'abc123:external_call:src/producer.ts:42',
    callerName: 'publishEvent',
    filePath: 'src/producer.ts',
    startLine: 42,
    system: 'kafka',
    destination: 'user-events',
    ...overrides,
  };
}

/**
 * Creates a mock EntityInfo for findEntity results
 */
export function createMockEntityInfo(overrides?: Partial<EntityInfo>): EntityInfo {
  return {
    id: 'abc123:entity:src/entities/user.ts:User',
    name: 'User',
    filePath: 'src/entities/user.ts',
    startLine: 1,
    endLine: 50,
    ormType: 'typeorm',
    tableName: 'users',
    ...overrides,
  };
}

/**
 * Creates a mock CallerInfo for getTransitiveCallers results
 */
export function createMockCallerInfo(overrides?: Partial<CallerInfo>): CallerInfo {
  return {
    id: 'abc123:function:src/controller.ts:handleRequest',
    name: 'handleRequest',
    kind: 'method',
    filePath: 'src/controller.ts',
    startLine: 25,
    endLine: 40,
    distance: 1,
    ...overrides,
  };
}

/**
 * Creates a mock CallTreeNode for getCallTree results
 */
export function createMockCallTreeNode(overrides?: Partial<CallTreeNode>): CallTreeNode {
  return {
    id: 'abc123:function:src/service.ts:processData',
    name: 'processData',
    kind: 'function',
    filePath: 'src/service.ts',
    startLine: 50,
    depth: 1,
    ...overrides,
  };
}

/**
 * Creates a mock EntityConsumer for getEntityConsumers results
 */
export function createMockEntityConsumer(overrides?: Partial<EntityConsumer>): EntityConsumer {
  return {
    id: 'abc123:function:src/repository.ts:saveUser',
    name: 'saveUser',
    kind: 'method',
    filePath: 'src/repository.ts',
    startLine: 30,
    operation: 'create' as DbOperationType,
    ...overrides,
  };
}

/**
 * Creates a mock RepoOverview for getRepoOverview results
 */
export function createMockRepoOverview(overrides?: Partial<RepoOverview>): RepoOverview {
  return {
    name: 'test-service',
    type: 'backend',
    parsedAt: '2024-01-15T10:30:00.000Z',
    fileCount: 100,
    functionCount: 500,
    classCount: 50,
    entityCount: 10,
    entrypointTypes: ['http', 'queue'],
    ...overrides,
  };
}

/**
 * Creates a mock RepoCoverageCounts for getCoverageCounts results.
 * Defaults carry a HEALTHY external resolution (50%) and NO callResolution
 * record (the "not measured by this graph's parser" shape) so tests opt into
 * a measured record explicitly.
 */
export function createMockCoverageCounts(overrides?: Partial<RepoCoverageCounts>): RepoCoverageCounts {
  return {
    repoName: 'test-service',
    nodeCountsByType: { function: 100, entity: 10, external_call: 20, entrypoint: 15 },
    entityCount: 10,
    entitiesWithDbOps: 5,
    functionCount: 100,
    functionsWithCalls: 50,
    externalCallCount: 20,
    resolvedExternalCallCount: 10,
    ...overrides,
  };
}

/**
 * Creates a mock EmbeddedNode for getEmbeddedNodes results
 */
export function createMockEmbeddedNode(overrides?: Partial<EmbeddedNode>): EmbeddedNode {
  return {
    id: 'abc123:function:src/auth.ts:rotateToken',
    name: 'rotateToken',
    type: NodeType.Function,
    filePath: 'src/auth.ts',
    startLine: 42,
    summary: 'Rotates the refresh token',
    embedding: [1, 0, 0],
    embeddingProvider: 'ollama',
    embeddingModel: 'qwen3-embedding:4b',
    ...overrides,
  };
}

/**
 * Creates a mock PathStep for findShortestPath results
 */
export function createMockPathStep(overrides?: Partial<PathStep>): PathStep {
  return {
    id: 'abc123:function:src/service.ts:processData',
    name: 'processData',
    filePath: 'src/service.ts',
    startLine: 50,
    ...overrides,
  };
}
