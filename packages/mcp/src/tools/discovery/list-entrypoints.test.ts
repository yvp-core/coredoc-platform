/**
 * Tests for the list_entrypoints tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleListEntrypoints } from './list-entrypoints.js';
import type { ScopeContext, EntrypointInfo, DetailLevel, DetailLevelConfig } from '../../types.js';
import { createMockRepository, createMockEntrypointInfo } from '../../__tests__/fixtures/mock-repository.js';

// Mock database
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatEntrypointList: vi.fn((entrypoints, metadata) => {
    if (metadata.format === 'raw') {
      return { data: entrypoints, metadata };
    }
    const summary = `## Entrypoints (${entrypoints.length})`;
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

// Default detail level config for tests
const defaultDetailLevel: DetailLevel = 'full';
const defaultDetailConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

describe('list_entrypoints Tool Handler', () => {
  let mockScope: ScopeContext;
  let getRepository: Mock;

  beforeEach(async () => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };

    // Reset mocks
    vi.clearAllMocks();

    // Get the mock function
    const dbModule = await import('@coredoc/db');
    getRepository = vi.mocked(dbModule.getRepository);
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should list all entrypoints when type is "all"', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/users',
            type: 'http',
            method: 'GET',
            path: '/api/users',
            fullPath: 'GET /api/users',
            filePath: 'src/routes.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/handlers.ts:getUsers',
            handlerName: 'getUsers',
          }),
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:graphql:getUser',
            type: 'graphql',
            fieldName: 'getUser',
            operationType: 'query',
            filePath: 'src/graphql/resolvers.ts',
            startLine: 20,
            handlerId: 'abc123:function:src/resolvers.ts:getUserResolver',
            handlerName: 'getUserResolver',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(2);
      expect(entrypoints[0].type).toBe('http');
      expect(entrypoints[1].type).toBe('graphql');
    });

    it('should filter entrypoints by type=http', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:POST:/api/users',
            type: 'http',
            method: 'POST',
            path: '/api/users',
            fullPath: 'POST /api/users',
            filePath: 'src/routes.ts',
            startLine: 25,
            handlerId: 'abc123:function:src/handlers.ts:createUser',
            handlerName: 'createUser',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(1);
      expect(entrypoints[0].type).toBe('http');
      expect(entrypoints[0].method).toBe('POST');
    });

    it('should filter entrypoints by pathFilter', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/users/:id',
            type: 'http',
            method: 'GET',
            path: '/api/users/:id',
            fullPath: 'GET /api/users/:id',
            filePath: 'src/routes.ts',
            startLine: 15,
            handlerId: 'abc123:function:src/handlers.ts:getUserById',
            handlerName: 'getUserById',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { pathFilter: '/api/users' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(1);
      expect(entrypoints[0].path).toContain('/api/users');
    });

    it('should combine type and pathFilter', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:DELETE:/api/users/:id',
            type: 'http',
            method: 'DELETE',
            path: '/api/users/:id',
            fullPath: 'DELETE /api/users/:id',
            filePath: 'src/routes.ts',
            startLine: 40,
            handlerId: 'abc123:function:src/handlers.ts:deleteUser',
            handlerName: 'deleteUser',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'http', pathFilter: '/api/users' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(1);
      expect(entrypoints[0].type).toBe('http');
      expect(entrypoints[0].path).toContain('/api/users');
    });
  });

  // ===========================================================================
  // Type-Specific Tests
  // ===========================================================================

  describe('Type-Specific Entrypoints', () => {
    it('should list HTTP entrypoints', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/health',
            type: 'http',
            method: 'GET',
            path: '/api/health',
            fullPath: 'GET /api/health',
            filePath: 'src/routes.ts',
            startLine: 5,
            handlerId: 'abc123:function:src/handlers.ts:healthCheck',
            handlerName: 'healthCheck',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints.every((ep) => ep.type === 'http')).toBe(true);
      expect(entrypoints[0].method).toBeDefined();
      expect(entrypoints[0].path).toBeDefined();
    });

    it('should list GraphQL entrypoints', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:graphql:createUser',
            type: 'graphql',
            fieldName: 'createUser',
            operationType: 'mutation',
            filePath: 'src/graphql/resolvers.ts',
            startLine: 30,
            handlerId: 'abc123:function:src/resolvers.ts:createUserMutation',
            handlerName: 'createUserMutation',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'graphql' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints.every((ep) => ep.type === 'graphql')).toBe(true);
      expect(entrypoints[0].fieldName).toBe('createUser');
      expect(entrypoints[0].operationType).toBe('mutation');
    });

    it('should list CRON entrypoints', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:cron:daily-cleanup',
            type: 'cron',
            schedule: '0 0 * * *',
            filePath: 'src/jobs/cleanup.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/jobs.ts:cleanupJob',
            handlerName: 'cleanupJob',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'cron' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints.every((ep) => ep.type === 'cron')).toBe(true);
      expect(entrypoints[0].schedule).toBe('0 0 * * *');
    });

    it('should list gRPC entrypoints', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:grpc:GetUser',
            type: 'grpc',
            method: 'GetUser',
            filePath: 'src/grpc/service.ts',
            startLine: 20,
            handlerId: 'abc123:function:src/grpc.ts:getUserHandler',
            handlerName: 'getUserHandler',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'grpc' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints.every((ep) => ep.type === 'grpc')).toBe(true);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle no entrypoints found', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should handle no entrypoints in summary format', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Entrypoints (0)');
    });

    it('should handle missing optional properties', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/minimal',
            type: 'http',
            filePath: 'src/routes.ts',
            startLine: 1,
            handlerId: '',
            handlerName: undefined,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(1);
      expect(entrypoints[0].handlerName).toBe('unknown');
    });

    it('should handle entrypoints without handlers', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/orphan',
            type: 'http',
            method: 'GET',
            path: '/orphan',
            fullPath: 'GET /orphan',
            filePath: 'src/routes.ts',
            startLine: 50,
            handlerId: '',
            handlerName: undefined,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'http' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(1);
      expect(entrypoints[0].handlerId).toBe('');
      expect(entrypoints[0].handlerName).toBe('unknown');
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/users',
            type: 'http',
            method: 'GET',
            path: '/api/users',
            fullPath: 'GET /api/users',
            filePath: 'src/routes.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/handlers.ts:getUsers',
            handlerName: 'getUsers',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Entrypoints');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/users',
            type: 'http',
            method: 'GET',
            path: '/api/users',
            fullPath: 'GET /api/users',
            filePath: 'src/routes.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/handlers.ts:getUsers',
            handlerName: 'getUsers',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.metadata.format).toBe('raw');
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
            id: 'abc123:entrypoint:http:GET:/api/v1/users',
            type: 'http',
            method: 'GET',
            path: '/api/v1/users',
            fullPath: 'GET /api/v1/users',
            filePath: 'src/routes.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/handlers.ts:getUsers',
            handlerName: 'getUsers',
          }),
          createMockEntrypointInfo({
            id: 'xyz789:entrypoint:http:GET:/api/v2/users',
            type: 'http',
            method: 'GET',
            path: '/api/v2/users',
            fullPath: 'GET /api/v2/users',
            filePath: 'src/routes.ts',
            startLine: 20,
            handlerId: 'xyz789:function:src/handlers.ts:getUsersV2',
            handlerName: 'getUsersV2',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const entrypoints = result.data as EntrypointInfo[];
      expect(entrypoints).toHaveLength(2);
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });
  });

  describe('Messaging system filter', () => {
    it('passes the system filter to persistence and returns generic address fields', async () => {
      const listEntrypoints = vi.fn().mockResolvedValue([
        createMockEntrypointInfo({
          type: 'queue',
          system: 'gcp-pubsub',
          destination: 'Topics.USER_CREATED',
          destinationValue: 'user.created',
        }),
      ]);
      const mockRepo = createMockRepository({ listEntrypoints });

      const result = await handleListEntrypoints(
        { type: 'queue', system: 'gcp-pubsub' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(listEntrypoints).toHaveBeenCalledWith(
        { type: 'queue', pathPattern: undefined, system: 'gcp-pubsub' },
        mockScope.repoHashes,
      );
      expect(result.data).toEqual([
        expect.objectContaining({
          system: 'gcp-pubsub',
          destination: 'Topics.USER_CREATED',
          destinationValue: 'user.created',
        }),
      ]);
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
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
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleListEntrypoints(
        { type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
    });
  });
});
