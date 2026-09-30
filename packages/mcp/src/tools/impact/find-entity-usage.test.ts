/**
 * Tests for the get_entity_consumers tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { resetCoverageCaveatCache } from '../../coverage.js';
import { handleFindEntityUsage } from './find-entity-usage.js';
import type { ScopeContext, EntityConsumerInfo } from '../../types.js';
import { resolveDetailLevel } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatEntityConsumers: vi.fn((consumers, entityName, metadata) => {
    if (metadata.format === 'raw') {
      return { data: consumers, metadata };
    }
    const summary = `## Consumers of \`${entityName}\` (${consumers.length})`;
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
  createMockEntityInfo,
  createMockEntityConsumer,
  createMockCoverageCounts,
} from '../../__tests__/fixtures/mock-repository.js';

describe('get_entity_consumers Tool Handler', () => {
  let mockScope: ScopeContext;
  const defaultDetailConfig = resolveDetailLevel('full');

  beforeEach(() => {
    // The caveat path memoizes counts module-wide — isolate each test's mock.
    resetCoverageCaveatCache();
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };

    vi.clearAllMocks();
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should find consumers of an entity', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 5,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:findUser',
            name: 'findUser',
            filePath: 'src/services/UserService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'read',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Consumers of `User`');
      expect(mockRepo.findEntity).toHaveBeenCalledWith('User', mockScope.repoHashes);
      expect(mockRepo.getEntityConsumers).toHaveBeenCalled();
    });

    it('should find entity by table name', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/Order.ts:Order',
            name: 'Order',
            tableName: 'orders',
            ormType: 'MikroORM',
            filePath: 'src/entities/Order.ts',
            startLine: 8,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleFindEntityUsage({ entityName: 'orders' }, mockScope, 'raw', 'full', defaultDetailConfig, mockRepo);

      expect(mockRepo.findEntity).toHaveBeenCalledWith('orders', mockScope.repoHashes);
    });

    it('should return multiple consumers with different operations', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/Product.ts:Product',
            name: 'Product',
            tableName: 'products',
            ormType: 'TypeORM',
            filePath: 'src/entities/Product.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/ProductService.ts:createProduct',
            name: 'createProduct',
            filePath: 'src/services/ProductService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'create',
            className: 'ProductService',
          }),
          createMockEntityConsumer({
            id: 'abc123:function:src/services/ProductService.ts:findProduct',
            name: 'findProduct',
            filePath: 'src/services/ProductService.ts',
            startLine: 20,
            kind: 'method',
            operation: 'read',
            className: 'ProductService',
          }),
          createMockEntityConsumer({
            id: 'abc123:function:src/services/ProductService.ts:updateProduct',
            name: 'updateProduct',
            filePath: 'src/services/ProductService.ts',
            startLine: 30,
            kind: 'method',
            operation: 'update',
            className: 'ProductService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Product', operation: 'all' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(3);
      expect(consumers[0]!.operation).toBe('create');
      expect(consumers[1]!.operation).toBe('read');
      expect(consumers[2]!.operation).toBe('update');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle entity not found', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'NonExistentEntity' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
      expect(mockRepo.getEntityConsumers).not.toHaveBeenCalled();
    });

    it('should return empty array for entity not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'NonExistentEntity' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should handle entity with no consumers', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/Unused.ts:Unused',
            name: 'Unused',
            tableName: 'unused',
            ormType: 'TypeORM',
            filePath: 'src/entities/Unused.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Unused' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary by default', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:getUser',
            name: 'getUser',
            filePath: 'src/services/UserService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'read',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Consumers of `User`');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:getUser',
            name: 'getUser',
            filePath: 'src/services/UserService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'read',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Operation Filter Tests
  // ===========================================================================

  describe('Operation Filters', () => {
    it('should filter by create operation', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:createUser',
            name: 'createUser',
            filePath: 'src/services/UserService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'create',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'create' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getEntityConsumers).toHaveBeenCalledWith('User', mockScope.repoHashes, 'create');
      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.operation).toBe('create');
    });

    it('should filter by read operation', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:findUser',
            name: 'findUser',
            filePath: 'src/services/UserService.ts',
            startLine: 20,
            kind: 'method',
            operation: 'read',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'read' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getEntityConsumers).toHaveBeenCalledWith('User', mockScope.repoHashes, 'read');
      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.operation).toBe('read');
    });

    it('should filter by update operation', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:updateUser',
            name: 'updateUser',
            filePath: 'src/services/UserService.ts',
            startLine: 30,
            kind: 'method',
            operation: 'update',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'update' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getEntityConsumers).toHaveBeenCalledWith('User', mockScope.repoHashes, 'update');
      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.operation).toBe('update');
    });

    it('should filter by delete operation', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:deleteUser',
            name: 'deleteUser',
            filePath: 'src/services/UserService.ts',
            startLine: 40,
            kind: 'method',
            operation: 'delete',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'delete' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getEntityConsumers).toHaveBeenCalledWith('User', mockScope.repoHashes, 'delete');
      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.operation).toBe('delete');
    });

    it('should default to all operations when not specified', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:createUser',
            name: 'createUser',
            filePath: 'src/services/UserService.ts',
            startLine: 10,
            kind: 'method',
            operation: 'create',
            className: 'UserService',
          }),
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:findUser',
            name: 'findUser',
            filePath: 'src/services/UserService.ts',
            startLine: 20,
            kind: 'method',
            operation: 'read',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.getEntityConsumers).toHaveBeenCalledWith('User', mockScope.repoHashes, undefined);
      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(2);
    });
  });

  // ===========================================================================
  // Class Methods Tests
  // ===========================================================================

  describe('Class Methods', () => {
    it('should handle consumers with className', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/UserService.ts:saveUser',
            name: 'saveUser',
            filePath: 'src/services/UserService.ts',
            startLine: 25,
            kind: 'method',
            operation: 'create',
            className: 'UserService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'create' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.className).toBe('UserService');
      expect(consumers[0]!.kind).toBe('method');
    });

    it('should handle consumers without className', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/User.ts:User',
            name: 'User',
            tableName: 'users',
            ormType: 'TypeORM',
            filePath: 'src/entities/User.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/utils/userHelpers.ts:findUserById',
            name: 'findUserById',
            filePath: 'src/utils/userHelpers.ts',
            startLine: 10,
            kind: 'function',
            operation: 'read',
            className: undefined,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User', operation: 'read' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(1);
      expect(consumers[0]!.className).toBeUndefined();
      expect(consumers[0]!.kind).toBe('function');
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
        findEntity: vi.fn().mockResolvedValue(
          createMockEntityInfo({
            id: 'abc123:entity:src/entities/SharedEntity.ts:SharedEntity',
            name: 'SharedEntity',
            tableName: 'shared_entities',
            ormType: 'TypeORM',
            filePath: 'src/entities/SharedEntity.ts',
            startLine: 1,
          }),
        ),
        getEntityConsumers: vi.fn().mockResolvedValue([
          createMockEntityConsumer({
            id: 'abc123:function:src/services/Service1.ts:consumer1',
            name: 'consumer1',
            filePath: 'src/services/Service1.ts',
            startLine: 10,
            kind: 'method',
            operation: 'read',
            className: 'Service1',
          }),
          createMockEntityConsumer({
            id: 'xyz789:function:src/services/Service2.ts:consumer2',
            name: 'consumer2',
            filePath: 'src/services/Service2.ts',
            startLine: 20,
            kind: 'method',
            operation: 'create',
            className: 'Service2',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'SharedEntity' },
        multiRepoScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      const consumers = result.data as EntityConsumerInfo[];
      expect(consumers).toHaveLength(2);
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.scope).toEqual(mockScope);
    });

    it('should include staleness info in metadata', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.staleness).toBeDefined();
      expect(result.metadata.staleness.warning).toBe('Data reflects parsed stable branch, not local changes');
    });

    it('should include format in metadata', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleFindEntityUsage(
        { entityName: 'test' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleFindEntityUsage(
        { entityName: 'test' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(rawResult.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Low-Coverage Caveat Tests
  // ===========================================================================

  describe('Low-Coverage Caveats', () => {
    const lowDbOpCounts = [
      createMockCoverageCounts({
        entityCount: 100,
        entitiesWithDbOps: 12,
        dbOpResolution: { dbOpSites: 100, boundDbOps: 60, outOfScopeDbOps: 20 },
      }),
    ];
    const expectedCaveat =
      'Note: 20 of 80 counted db-operation sites are unbound across 1 measured repo(s) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.';

    it('appends the counted-db-operation caveat to the not-found message', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue(lowDbOpCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Ghost' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain("Entity 'Ghost' not found in scope");
      expect(result.data).toContain(expectedCaveat);
      expect(mockRepo.getCoverageCounts).toHaveBeenCalledWith(mockScope.repoHashes);
    });

    it('appends the caveat when the entity is found but has zero consumers', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(createMockEntityInfo({ name: 'User' })),
        getEntityConsumers: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(lowDbOpCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Consumers of `User` (0)');
      expect(result.data).toContain(expectedCaveat);
    });

    // An unmeasured graph says so even with no entities: "nothing to cover" was indistinguishable
    // from "this parser never counted", which is the fact the agent needs (spec BR-6).
    it('says db-operation resolution is not measured when no repo in scope carries the record', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue([createMockCoverageCounts({ entityCount: 0 })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Ghost' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain(
        'Note: db-operation resolution is not measured for this scope (re-parse and re-push to measure) — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
      );
      expect(result.data).not.toContain('%');
    });

    // BR-6: a scope mixing a measured and an unmeasured repo must not sum the measured one as
    // if it were the whole answer.
    it('names the unmeasured repos of a mixed scope', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue([
          createMockCoverageCounts({
            repoName: 'a',
            dbOpResolution: { dbOpSites: 60, boundDbOps: 30, outOfScopeDbOps: 10 },
          }),
          createMockCoverageCounts({ repoName: 'legacy' }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Ghost' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain(
        'Note: 20 of 50 counted db-operation sites are unbound across 1 measured repo(s); not measured for legacy — absence here may be a profile gap, not a code fact. Verify with source (grep) before asserting nonexistence.',
      );
    });

    it('leaves non-empty results untouched and never queries coverage (lazy)', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(createMockEntityInfo({ name: 'User' })),
        getEntityConsumers: vi.fn().mockResolvedValue([createMockEntityConsumer()]),
        getCoverageCounts: vi.fn().mockResolvedValue(lowDbOpCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'User' },
        mockScope,
        'summary',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toContain('Note:');
      expect(mockRepo.getCoverageCounts).not.toHaveBeenCalled();
    });

    it('keeps raw not-found output a plain empty array (caveat is summary-only)', async () => {
      const mockRepo = createMockRepository({
        findEntity: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue(lowDbOpCounts),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleFindEntityUsage(
        { entityName: 'Ghost' },
        mockScope,
        'raw',
        'full',
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });
  });
});
