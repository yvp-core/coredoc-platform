/**
 * Tests for the explain_entrypoint tool handler
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleExplainEntrypoint } from './explain-entrypoint.js';
import type { ScopeContext, EntrypointExplanationResult } from '../../types.js';
import { resolveDetailLevel } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatEntrypointExplanation: vi.fn((result, metadata) => {
    if (metadata.format === 'raw') {
      return { data: result, metadata };
    }
    const ep = result.entrypoint;
    const epDesc = ep.method
      ? `${ep.method} ${ep.path || ep.fullPath}`
      : ep.path || ep.fullPath || ep.fieldName || ep.topic;
    const summary = `## Entrypoint: \`${epDesc}\`\n\n**Handler:** ${result.handler.function.name}`;
    return { data: summary, metadata };
  }),
  createMetadata: vi.fn((scope, format) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
  })),
}));

// Import after mocks
import { getRepository } from '@coredoc/db';
import {
  createMockRepository,
  createMockEntrypointInfo,
  createMockFunctionInfo,
  createMockCallTreeNode,
} from '../../__tests__/fixtures/mock-repository.js';

describe('explain_entrypoint Tool Handler', () => {
  let mockScope: ScopeContext;
  const defaultDetailLevel = 'full';
  const defaultDetailConfig = resolveDetailLevel('full');

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };

    vi.clearAllMocks();
  });

  // ===========================================================================
  // Addressing: the handler projection must carry each type's ADDRESS
  // ===========================================================================

  describe('mobile addressing', () => {
    // This handler rebuilds `EntrypointInfo` field by field, so a field it forgets is a field
    // the caller never sees. A mobile entrypoint is addressed by its component class; without
    // it, every Android launcher and receiver renders as its lifecycle method — `onCreate`,
    // `onReceive` — which is neither what the caller typed nor unique in the repository.
    it('carries the component class and trigger through to the explanation', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:mobile:ace9',
            type: 'mobile',
            className: 'MainActivity',
            trigger: 'launcher',
            filePath: 'app/src/main/java/a/b/MainActivity.kt',
            startLine: 43,
            handlerName: 'onCreate',
            handlerId: 'abc123:method:app/src/main/java/a/b/MainActivity.kt:MainActivity.onCreate',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:method:app/src/main/java/a/b/MainActivity.kt:MainActivity.onCreate',
            name: 'onCreate',
            filePath: 'app/src/main/java/a/b/MainActivity.kt',
            startLine: 43,
            endLine: 90,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { id: 'abc123:entrypoint:mobile:ace9' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.className).toBe('MainActivity');
      expect(data.entrypoint.trigger).toBe('launcher');
    });
  });

  // ===========================================================================
  // Source-in-graph (ALLOW_SOURCES_IN_GRAPH) gating for the handler body
  // ===========================================================================

  describe('includeSource (handler body)', () => {
    const ORIGINAL_FLAG = process.env.ALLOW_SOURCES_IN_GRAPH;
    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
      else process.env.ALLOW_SOURCES_IN_GRAPH = ORIGINAL_FLAG;
    });

    function setupWithHandlerSource(sourceCode: string): void {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:queue:e0a1',
            type: 'queue',
            filePath: 'src/consumer.ts',
            startLine: 10,
            handlerName: 'handle',
            handlerId: 'abc123:function:src/consumer.ts:handle',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/consumer.ts:handle',
            name: 'handle',
            filePath: 'src/consumer.ts',
            startLine: 10,
            endLine: 20,
            kind: 'method',
            sourceCode,
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);
    }

    it('attaches the handler body when the flag is on AND includeSource:true', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      setupWithHandlerSource('if (!isTriggeredByRead) return;');
      const result = await handleExplainEntrypoint(
        { id: 'abc123:entrypoint:queue:e0a1', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.handler.function.sourceCode).toBe('if (!isTriggeredByRead) return;');
    });

    // The detail filter rebuilds a narrow function object; source must survive it.
    it('keeps the handler body at basic detail level', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      setupWithHandlerSource('if (!isTriggeredByRead) return;');
      const result = await handleExplainEntrypoint(
        { id: 'abc123:entrypoint:queue:e0a1', includeSource: true },
        mockScope,
        'raw',
        'basic',
        resolveDetailLevel('basic'),
        await getRepository(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.handler.function.sourceCode).toBe('if (!isTriggeredByRead) return;');
    });

    it('omits the handler body when includeSource is not requested (flag on)', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      setupWithHandlerSource('if (!isTriggeredByRead) return;');
      const result = await handleExplainEntrypoint(
        { id: 'abc123:entrypoint:queue:e0a1' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.handler.function.sourceCode).toBeUndefined();
    });

    it('omits the handler body when the operator disabled source-in-graph', async () => {
      delete process.env.ALLOW_SOURCES_IN_GRAPH;
      setupWithHandlerSource('if (!isTriggeredByRead) return;');
      const result = await handleExplainEntrypoint(
        { id: 'abc123:entrypoint:queue:e0a1', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.handler.function.sourceCode).toBeUndefined();
    });
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should explain an HTTP REST endpoint with handler', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:GET:/api/users/:id',
            type: 'http',
            method: 'GET',
            path: '/api/users/:id',
            fullPath: '/api/users/:id',
            filePath: 'src/controllers/user.controller.ts',
            startLine: 25,
            handlerName: 'getUserById',
            handlerId: 'abc123:function:src/controllers/user.controller.ts:getUserById',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/user.controller.ts:getUserById',
            name: 'getUserById',
            filePath: 'src/controllers/user.controller.ts',
            startLine: 25,
            endLine: 35,
            kind: 'method',
            summary: 'Retrieves user by ID from database',
            purpose: 'Fetch user data',
            visibility: 'public',
            isAsync: true,
            businessLogic: 'Validates ID, queries database, returns user data',
            sideEffects: 'None - read-only operation',
            className: 'UserController',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/users/:id' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.method).toBe('GET');
      expect(data.entrypoint.path).toBe('/api/users/:id');
      expect(data.entrypoint.type).toBe('http');
      expect(data.handler.function.name).toBe('getUserById');
      expect(data.handler.function.className).toBe('UserController');
      expect(data.handler.businessLogic).toBe('Validates ID, queries database, returns user data');
      expect(data.handler.sideEffects).toBe('None - read-only operation');
    });

    it('should include call tree from handler', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:POST:/api/users',
            type: 'http',
            method: 'POST',
            path: '/api/users',
            fullPath: '/api/users',
            handlerName: 'createUser',
            handlerId: 'abc123:function:src/controllers/user.controller.ts:createUser',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/user.controller.ts:createUser',
            name: 'createUser',
            filePath: 'src/controllers/user.controller.ts',
            startLine: 40,
            endLine: 55,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([
          createMockCallTreeNode({
            id: 'abc123:function:src/services/user.service.ts:validateUserData',
            name: 'validateUserData',
            filePath: 'src/services/user.service.ts',
            startLine: 15,
            kind: 'function',
            summary: 'Validates user input data',
          }),
          createMockCallTreeNode({
            id: 'abc123:function:src/repositories/user.repository.ts:save',
            name: 'save',
            filePath: 'src/repositories/user.repository.ts',
            startLine: 30,
            kind: 'method',
            summary: 'Saves user to database',
            className: 'UserRepository',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/api/users' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.callTree).toHaveLength(2);
      expect(data.callTree[0].name).toBe('validateUserData');
      expect(data.callTree[0].summary).toBe('Validates user input data');
      expect(data.callTree[1].name).toBe('save');
      expect(data.callTree[1].className).toBe('UserRepository');
    });
  });

  // ===========================================================================
  // Entrypoint Type Tests
  // ===========================================================================

  describe('Entrypoint Types', () => {
    it('should explain a GraphQL entrypoint', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:graphql:Query.user',
            type: 'graphql',
            fieldName: 'user',
            operationType: 'Query',
            filePath: 'src/resolvers/user.resolver.ts',
            startLine: 15,
            handlerName: 'user',
            handlerId: 'abc123:function:src/resolvers/user.resolver.ts:user',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/resolvers/user.resolver.ts:user',
            name: 'user',
            filePath: 'src/resolvers/user.resolver.ts',
            startLine: 15,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { entrypointType: 'graphql', path: 'user' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.type).toBe('graphql');
      expect(data.entrypoint.fieldName).toBe('user');
      expect(data.entrypoint.operationType).toBe('Query');
    });

    it('should explain a queue entrypoint', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:queue:user.created',
            type: 'queue',
            topic: 'user.created',
            filePath: 'src/consumers/user.consumer.ts',
            startLine: 20,
            handlerName: 'handleUserCreated',
            handlerId: 'abc123:function:src/consumers/user.consumer.ts:handleUserCreated',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/consumers/user.consumer.ts:handleUserCreated',
            name: 'handleUserCreated',
            filePath: 'src/consumers/user.consumer.ts',
            startLine: 20,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { entrypointType: 'queue', path: 'user.created' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.type).toBe('queue');
      expect(data.entrypoint.topic).toBe('user.created');
    });

    it('should explain a scheduled job entrypoint', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:cron:cleanupOldData',
            type: 'cron',
            schedule: '0 0 * * *',
            filePath: 'src/jobs/cleanup.job.ts',
            startLine: 12,
            handlerName: 'cleanupOldData',
            handlerId: 'abc123:function:src/jobs/cleanup.job.ts:cleanupOldData',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/jobs/cleanup.job.ts:cleanupOldData',
            name: 'cleanupOldData',
            filePath: 'src/jobs/cleanup.job.ts',
            startLine: 12,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { entrypointType: 'cron' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.type).toBe('cron');
      expect(data.entrypoint.schedule).toBe('0 0 * * *');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle entrypoint not found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/nonexistent' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('should return empty object for entrypoint not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/api/missing' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual({});
    });

    it('should handle handler not found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:GET:/api/test',
            type: 'http',
            method: 'GET',
            path: '/api/test',
            fullPath: '/api/test',
            handlerName: 'missingHandler',
            handlerId: 'abc123:function:src/controllers/test.controller.ts:missingHandler',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(null),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/test' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.handler.function.name).toBe('missingHandler');
      expect(data.handler.function.id).toBe('');
    });

    it('should handle search by path only', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:GET:/api/search',
            type: 'http',
            method: 'GET',
            path: '/api/search',
            fullPath: '/api/search',
            handlerName: 'search',
            handlerId: 'abc123:function:src/controllers/search.controller.ts:search',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/search.controller.ts:search',
            name: 'search',
            filePath: 'src/controllers/search.controller.ts',
            startLine: 15,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { path: '/api/search' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.path).toBe('/api/search');
      expect(data.handler.function.name).toBe('search');
    });

    it('should handle search by method only', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:DELETE:/api/resource/:id',
            type: 'http',
            method: 'DELETE',
            path: '/api/resource/:id',
            fullPath: '/api/resource/:id',
            handlerName: 'deleteResource',
            handlerId: 'abc123:function:src/controllers/resource.controller.ts:deleteResource',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/resource.controller.ts:deleteResource',
            name: 'deleteResource',
            filePath: 'src/controllers/resource.controller.ts',
            startLine: 50,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'DELETE' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.method).toBe('DELETE');
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary by default', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:GET:/api/test',
            type: 'http',
            method: 'GET',
            path: '/api/test',
            fullPath: '/api/test',
            handlerName: 'test',
            handlerId: 'abc123:function:src/controllers/test.controller.ts:test',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/test.controller.ts:test',
            name: 'test',
            filePath: 'src/controllers/test.controller.ts',
            startLine: 10,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Entrypoint: `GET /api/test`');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:POST:/api/create',
            type: 'http',
            method: 'POST',
            path: '/api/create',
            fullPath: '/api/create',
            handlerName: 'create',
            handlerId: 'abc123:function:src/controllers/create.controller.ts:create',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/create.controller.ts:create',
            name: 'create',
            filePath: 'src/controllers/create.controller.ts',
            startLine: 5,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/api/create' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('object');
      expect((result.data as EntrypointExplanationResult).entrypoint).toBeDefined();
      expect((result.data as EntrypointExplanationResult).handler).toBeDefined();
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Response Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/test' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.scope).toEqual(mockScope);
    });

    it('should include staleness info in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { path: '/test' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
    });

    it('should include format in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleExplainEntrypoint(
        { path: '/test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleExplainEntrypoint(
        { path: '/test' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(rawResult.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Cross-Repo Tests
  // ===========================================================================

  describe('Cross-Repo Scope', () => {
    it('should handle multiple repo hashes in scope', async () => {
      const multiRepoScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['repo1', 'repo2'],
        repoHashes: ['abc123def456', 'xyz789ghi012'],
        crossRepoEnabled: true,
        project: 'test-group',
      };

      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:GET:/api/shared',
            type: 'http',
            method: 'GET',
            path: '/api/shared',
            fullPath: '/api/shared',
            handlerName: 'shared',
            handlerId: 'abc123:function:src/controllers/shared.controller.ts:shared',
          }),
        ]),
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controllers/shared.controller.ts:shared',
            name: 'shared',
            filePath: 'src/controllers/shared.controller.ts',
            startLine: 10,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'GET', path: '/api/shared' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.path).toBe('/api/shared');
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });
  });

  describe('Forgiving path input', () => {
    it('parses "METHOD /path" from a single path arg', async () => {
      // Regression for the 2026-05-13 eval: agent calls
      // `explain_entrypoint({ path: "POST /shifts/.../analyze-conflicts" })`
      // — verb baked into the path. The previous handler treated the whole
      // string as the pathPattern LIKE, which never matched. Now we strip
      // the leading verb and use it as the method filter.
      const listEntrypoints = vi.fn().mockResolvedValue([
        createMockEntrypointInfo({
          id: 'abc:entrypoint:POST:/shifts/x',
          type: 'http',
          method: 'POST',
          path: '/shifts/x',
          fullPath: '/shifts/x',
          handlerName: 'doX',
        }),
      ]);
      const mockRepo = createMockRepository({
        listEntrypoints,
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc:fn:doX',
            name: 'doX',
            filePath: 'src/x.ts',
            startLine: 1,
            kind: 'method',
          }),
        ),
        getCallTree: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { path: 'POST /shifts/x' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // listEntrypoints called with the stripped path, not "POST /shifts/x"
      expect(listEntrypoints).toHaveBeenCalledWith(
        expect.objectContaining({ pathPattern: '/shifts/x' }),
        expect.anything(),
      );
      const data = result.data as EntrypointExplanationResult;
      expect(data.entrypoint.method).toBe('POST');
      expect(data.entrypoint.path).toBe('/shifts/x');
    });
  });

  describe('entities touched + outbound services', () => {
    it('populates deduped entities and reachable outbound services', async () => {
      const handlerId = 'abc123:function:src/user.controller.ts:createUser';
      const calleeId = 'abc123:function:src/user.service.ts:save';
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:POST:/api/users',
            type: 'http',
            method: 'POST',
            path: '/api/users',
            fullPath: '/api/users',
            handlerName: 'createUser',
            handlerId,
          }),
        ]),
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: handlerId, name: 'createUser', kind: 'method' })),
        getCallTree: vi
          .fn()
          .mockResolvedValue([createMockCallTreeNode({ id: calleeId, name: 'save', kind: 'method' })]),
        getEntitiesForFunctions: vi.fn().mockResolvedValue([
          { functionId: handlerId, entityName: 'User', tableName: 'users', operation: 'create', entityId: 'e:User' },
          // duplicate entity from a different function — must collapse to one
          { functionId: calleeId, entityName: 'User', tableName: 'users', operation: 'update', entityId: 'e:User' },
          { functionId: calleeId, entityName: 'Audit', tableName: 'audits', operation: 'create', entityId: 'e:Audit' },
        ]),
        findEntity: vi.fn((name: string) =>
          Promise.resolve({
            id: `e:${name}`,
            name,
            tableName: name === 'User' ? 'users' : 'audits',
            ormType: 'typeorm',
            filePath: `src/${name}.ts`,
            startLine: 1,
            endLine: 10,
          }),
        ),
        // Per-caller external calls: the handler queries getExternalCallsFrom
        // for each reachable function (handler + call tree), so an unreachable
        // caller's calls ('analytics' on `unrelated`) are never even fetched.
        getExternalCallsFrom: vi.fn((functionId: string) =>
          Promise.resolve(
            [
              {
                id: 'x1',
                callerId: handlerId,
                callerName: 'createUser',
                serviceName: 'payments',
                method: 'charge',
                protocol: 'http',
                filePath: 'a',
                startLine: 1,
              },
              {
                id: 'x2',
                callerId: calleeId,
                callerName: 'save',
                serviceName: 'core ',
                method: 'put',
                protocol: 'http',
                filePath: 'b',
                startLine: 2,
              },
              {
                id: 'x3',
                callerId: 'abc123:function:other.ts:unrelated',
                callerName: 'unrelated',
                serviceName: 'analytics',
                method: 'track',
                protocol: 'http',
                filePath: 'c',
                startLine: 3,
              },
            ].filter((c) => c.callerId === functionId),
          ),
        ),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainEntrypoint(
        { method: 'POST', path: '/api/users' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as EntrypointExplanationResult;
      // Entities deduped to User + Audit.
      expect(data.entities.map((e) => e.name).sort()).toEqual(['Audit', 'User']);
      // Outbound services: trimmed ('core ' -> 'core'), reachable-only (no 'analytics'), sorted.
      expect(data.externalServices).toEqual(['core', 'payments']);
    });
  });
});
