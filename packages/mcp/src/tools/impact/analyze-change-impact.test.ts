/**
 * Tests for the analyze_change_impact tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { TypeUseKind } from '@coredoc/db/types';
import { handleAnalyzeChangeImpact, BOUNDARY_FILE_SCOPE_CAP } from './analyze-change-impact.js';
import type { ScopeContext, ChangeImpactResult } from '../../types.js';
import { resolveDetailLevel, DETAIL_ESCALATION_HINT } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatChangeImpact: vi.fn((result, metadata) => {
    if (metadata.format === 'raw') {
      return { data: result, metadata };
    }
    let summary = result.impactSummary || 'No impact summary';
    // Mirror the real formatChangeImpact: the escalation footer must be the
    // last line of a basic-detail summary, so appendBoundarySection has
    // something real to insert ahead of.
    if (metadata.detailLevel === 'basic') summary += `\n\n${DETAIL_ESCALATION_HINT}`;
    return { data: summary, metadata };
  }),
  createMetadata: vi.fn((scope, format, detailLevel) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
    detailLevel,
  })),
}));

// Import after mocks
import { getRepository } from '@coredoc/db';
import {
  createMockRepository,
  createMockFunctionInfo,
  createMockClassInfo,
  createMockCallerInfo,
  createMockEntrypointInfo,
  createMockEntityInfo,
  createMockEntityConsumer,
} from '../../__tests__/fixtures/mock-repository.js';

describe('analyze_change_impact Tool Handler', () => {
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
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should analyze impact of changing a function', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 25,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handleRequest',
            name: 'handleRequest',
            filePath: 'src/controller.ts',
            startLine: 15,
            kind: 'method',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:POST:/api/process',
            type: 'http',
            method: 'POST',
            path: '/api/process',
            filePath: 'src/routes.ts',
            startLine: 20,
            handlerId: 'abc123:function:src/controller.ts:handleRequest',
            handlerName: 'handleRequest',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.target.name).toBe('processData');
      expect(data.directCallers).toHaveLength(1);
      expect(data.affectedEntrypoints).toHaveLength(1);
      // Risk score: 1 direct caller + 1 entrypoint * 3 = 4 (< 8 = low)
      expect(data.riskLevel).toBe('low');
    });

    it('should analyze impact with both direct and transitive callers', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/util.ts:helper',
            name: 'helper',
            filePath: 'src/util.ts',
            startLine: 5,
            endLine: 10,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 20,
            kind: 'function',
            distance: 1,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handler',
            name: 'handler',
            filePath: 'src/controller.ts',
            startLine: 30,
            kind: 'method',
            distance: 2,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/api.ts:endpoint',
            name: 'endpoint',
            filePath: 'src/api.ts',
            startLine: 40,
            kind: 'function',
            distance: 3,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'helper', depth: 3 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.directCallers).toHaveLength(1);
      expect(data.transitiveCallers).toHaveLength(2);
      expect(data.directCallers[0].distance).toBe(1);
      expect(data.transitiveCallers[0].distance).toBe(2);
      expect(data.transitiveCallers[1].distance).toBe(3);
    });

    it('should find target by specific type', async () => {
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/models/User.ts:User',
            name: 'User',
            filePath: 'src/models/User.ts',
            startLine: 5,
            endLine: 50,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'User', targetType: 'class' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.target.name).toBe('User');
      expect(data.target.type).toBe('class');
    });
  });

  // ===========================================================================
  // Risk Level Tests
  // ===========================================================================

  describe('Risk Level Calculation', () => {
    it('should calculate low risk for minimal impact', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/util.ts:unused',
            name: 'unused',
            filePath: 'src/util.ts',
            startLine: 1,
            endLine: 5,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'unused' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.riskLevel).toBe('low');
    });

    it('should calculate medium risk for moderate impact', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 20,
          }),
        ),
        getTransitiveCallers: vi
          .fn()
          .mockResolvedValue([createMockCallerInfo({ distance: 1 }), createMockCallerInfo({ distance: 1 })]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          // Distinct IDs — analyze-change-impact dedupes entrypoints by id
          // across seed paths, so two identical mock entrypoints collapse to
          // one and trip the medium/low boundary.
          createMockEntrypointInfo({ id: 'abc:entrypoint:http:GET:/a', path: '/a' }),
          createMockEntrypointInfo({ id: 'abc:entrypoint:http:GET:/b', path: '/b' }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'process' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.riskLevel).toBe('medium');
    });

    it('should calculate high risk for significant impact', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/core.ts:critical',
            name: 'critical',
            filePath: 'src/core.ts',
            startLine: 1,
            endLine: 50,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue(
          Array.from({ length: 10 }, (_, i) =>
            createMockCallerInfo({
              id: `abc123:function:src/caller${i}.ts:caller${i}`,
              name: `caller${i}`,
              distance: 1,
            }),
          ),
        ),
        getReachingEntrypoints: vi.fn().mockResolvedValue(
          Array.from({ length: 5 }, (_, i) =>
            createMockEntrypointInfo({
              id: `abc123:entrypoint:http:GET:/api/endpoint${i}`,
              path: `/api/endpoint${i}`,
            }),
          ),
        ),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'critical' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.riskLevel).toBe('high');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle target not found', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'nonExistent' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('should handle target not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'nonExistent' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.target.name).toBe('nonExistent');
      expect(data.directCallers).toHaveLength(0);
      expect(data.impactSummary).toContain('not found');
    });

    it('should handle function with no impacts', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/isolated.ts:isolated',
            name: 'isolated',
            filePath: 'src/isolated.ts',
            startLine: 5,
            endLine: 10,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'isolated' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.directCallers).toHaveLength(0);
      expect(data.transitiveCallers).toHaveLength(0);
      expect(data.affectedEntrypoints).toHaveLength(0);
      expect(data.affectedTests).toHaveLength(0);
      expect(data.impactSummary).toContain('No detected impacts');
    });
  });

  // ===========================================================================
  // Affected Tests
  //
  // `affectedTests` was hardcoded to [] ("not directly supported by
  // repository"), so a symbol covered by spec files reported zero tests.
  // ===========================================================================

  describe('Affected Tests', () => {
    it('reports callers declared in test files as affected tests', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/service.spec.ts:describeProcessData',
            name: 'describeProcessData',
            filePath: 'src/service.spec.ts',
            distance: 1,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/__tests__/helpers.ts:withFixture',
            name: 'withFixture',
            filePath: 'src/__tests__/helpers.ts',
            distance: 2,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handleRequest',
            name: 'handleRequest',
            filePath: 'src/controller.ts',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.affectedTests.map((t) => t.filePath)).toEqual(['src/service.spec.ts', 'src/__tests__/helpers.ts']);
      expect(data.impactSummary).toContain('2 test file(s)');
    });

    it('reports type users declared in test files as affected tests', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(
          createMockClassInfo({
            id: 'abc123:class:src/booking-types.ts:BookingTypes',
            name: 'BookingTypes',
            filePath: 'src/booking-types.ts',
          }),
        ),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:file:src/booking.spec.ts',
            name: 'booking.spec.ts',
            type: 'file',
            filePath: 'src/booking.spec.ts',
            startLine: 1,
            usage: 'import',
          },
        ]),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'BookingTypes', type: 'class' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.affectedTests.map((t) => t.filePath)).toEqual(['src/booking.spec.ts']);
    });
  });

  // ===========================================================================
  // Affected Entrypoints
  // ===========================================================================

  describe('Affected Entrypoints', () => {
    it('should identify HTTP entrypoints that reach the target', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:authenticate',
            name: 'authenticate',
            filePath: 'src/service.ts',
            startLine: 15,
            endLine: 30,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:POST:/auth/login',
            type: 'http',
            method: 'POST',
            path: '/auth/login',
            fullPath: '/api/auth/login',
            handlerId: 'abc123:function:src/auth/controller.ts:login',
            handlerName: 'login',
          }),
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:POST:/auth/register',
            type: 'http',
            method: 'POST',
            path: '/auth/register',
            fullPath: '/api/auth/register',
            handlerId: 'abc123:function:src/auth/controller.ts:register',
            handlerName: 'register',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'authenticate' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.affectedEntrypoints).toHaveLength(2);
      expect(data.affectedEntrypoints[0].type).toBe('http');
      expect(data.affectedEntrypoints[0].method).toBe('POST');
      expect(data.affectedEntrypoints[0].path).toBe('/auth/login');
    });

    it('should handle GraphQL entrypoints', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/resolvers.ts:getUser',
            name: 'getUser',
            filePath: 'src/resolvers.ts',
            startLine: 10,
            endLine: 20,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:graphql:Query.user',
            type: 'graphql',
            fieldName: 'user',
            operationType: 'Query',
            handlerId: 'abc123:function:src/resolvers.ts:getUser',
            handlerName: 'getUser',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'getUser' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.affectedEntrypoints).toHaveLength(1);
      expect(data.affectedEntrypoints[0].type).toBe('graphql');
      expect(data.affectedEntrypoints[0].operationType).toBe('Query');
      expect(data.affectedEntrypoints[0].fieldName).toBe('user');
    });
  });

  describe('Package import type users', () => {
    it('returns importing files for exported function targets', async () => {
      const targetId = 'provider123:function:src/client.ts:createClient';
      const fileId = 'consumer456:file:src/use-client.ts';
      const getTypeUsages = vi.fn().mockResolvedValue([
        {
          id: fileId,
          name: 'src/use-client.ts',
          type: 'file',
          filePath: 'src/use-client.ts',
          startLine: 0,
          usage: 'import',
          via: 'createClient',
          ambiguous: false,
        },
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: targetId,
            name: 'createClient',
            filePath: 'src/client.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getTypeUsages,
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });

      const result = await handleAnalyzeChangeImpact(
        { target: 'createClient', targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(getTypeUsages).toHaveBeenCalledWith(targetId, mockScope.repoHashes);
      expect(data.typeUsers).toEqual([
        expect.objectContaining({
          id: fileId,
          type: 'file',
          summary: 'imports createClient',
        }),
      ]);
    });

    it('returns importing files without running entrypoint closure from file-only seeds', async () => {
      const targetId = 'provider123:enum:src/enums.ts:BookingTypes';
      const fileId = 'consumer456:file:src/use-booking.ts';
      const getReachingEntrypoints = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: targetId,
            name: 'BookingTypes',
            type: 'enum',
            filePath: 'src/enums.ts',
            startLine: 1,
            endLine: 5,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: fileId,
            name: 'src/use-booking.ts',
            type: 'file',
            filePath: 'src/use-booking.ts',
            startLine: 0,
            usage: 'import',
            via: 'BookingTypes',
            ambiguous: false,
          },
        ]),
        getReachingEntrypoints,
      });

      const result = await handleAnalyzeChangeImpact(
        { target: 'BookingTypes', targetType: 'enum' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.typeUsers).toEqual([
        expect.objectContaining({
          id: fileId,
          type: 'file',
          summary: 'imports BookingTypes',
        }),
      ]);
      expect(getReachingEntrypoints).toHaveBeenCalledTimes(1);
      expect(getReachingEntrypoints).toHaveBeenCalledWith(targetId, 3, mockScope.repoHashes);
    });
  });

  describe('Value-position enum consumers', () => {
    it('labels a value-position consumer distinctly from a type-position one', async () => {
      const targetId = 'abc123:enum:src/status.ts:Status';
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          {
            id: targetId,
            name: 'Status',
            type: 'enum',
            filePath: 'src/status.ts',
            startLine: 1,
            endLine: 5,
          },
        ]),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/render.ts:render',
            name: 'render',
            type: 'function',
            filePath: 'src/render.ts',
            startLine: 10,
            usage: 'parameter',
            via: 'status',
            ambiguous: false,
          },
          {
            id: 'abc123:function:src/guard.ts:isLocked',
            name: 'isLocked',
            type: 'function',
            filePath: 'src/guard.ts',
            startLine: 4,
            usage: 'member-access',
            useKind: TypeUseKind.Value,
            member: 'Locked',
            ambiguous: false,
          },
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });

      const result = await handleAnalyzeChangeImpact(
        { target: 'Status', targetType: 'enum' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.typeUsers.map((u) => u.summary)).toEqual([
        'used as parameter (status)',
        'used as member-access — branches on Status.Locked (value)',
      ]);
    });
  });

  describe('Class usage consumers', () => {
    it('labels construction and import consumers of a class by what they do', async () => {
      const targetId = 'abc123:class:src/service.ts:UserService';
      const mockRepo = createMockRepository({
        findClass: vi.fn().mockResolvedValue({
          id: targetId,
          name: 'UserService',
          filePath: 'src/service.ts',
          startLine: 1,
          endLine: 9,
        }),
        getTypeUsages: vi.fn().mockResolvedValue([
          {
            id: 'abc123:function:src/a.ts:build',
            name: 'build',
            type: 'function',
            filePath: 'src/a.ts',
            startLine: 4,
            usage: 'construction',
            useKind: TypeUseKind.Value,
            ambiguous: false,
          },
          {
            id: 'abc123:file:src/b.ts',
            name: 'src/b.ts',
            type: 'file',
            filePath: 'src/b.ts',
            startLine: 0,
            usage: 'import',
            via: 'Svc',
            ambiguous: false,
          },
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });

      const result = await handleAnalyzeChangeImpact(
        { target: 'UserService', targetType: 'class' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.typeUsers.map((u) => u.summary)).toEqual(['constructs UserService', 'imports UserService (as Svc)']);
    });
  });

  // ===========================================================================
  // Cross-Repo Impact Tests
  // ===========================================================================

  describe('Cross-Repo Impact', () => {
    it('should not include cross-repo impacts when disabled', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/shared.ts:sharedFunc',
            name: 'sharedFunc',
            filePath: 'src/shared.ts',
            startLine: 5,
            endLine: 10,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'sharedFunc', includeCrossRepo: false },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.crossRepoImpacts).toBeUndefined();
    });

    it('should handle cross-repo impacts when scope has no project', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/shared.ts:sharedFunc',
            name: 'sharedFunc',
            filePath: 'src/shared.ts',
            startLine: 5,
            endLine: 10,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'sharedFunc', includeCrossRepo: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      // Cross-repo should be undefined when no project
      expect(data.crossRepoImpacts).toBeUndefined();
    });
  });

  // ===========================================================================
  // Impact Summary Tests
  // ===========================================================================

  describe('Impact Summary', () => {
    it('should build comprehensive impact summary', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 20,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/caller1.ts:caller1',
            name: 'caller1',
            distance: 1,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/caller2.ts:caller2',
            name: 'caller2',
            distance: 2,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          createMockEntrypointInfo({
            id: 'abc123:entrypoint:http:GET:/api/test',
            type: 'http',
            method: 'GET',
            path: '/api/test',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'process' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.impactSummary).toContain('Changing `process` would affect:');
      expect(data.impactSummary).toContain('1 direct caller(s)');
      expect(data.impactSummary).toContain('1 transitive caller(s)');
      expect(data.impactSummary).toContain('1 API endpoint(s)');
    });

    it('should include "No detected impacts" when nothing found', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/unused.ts:unused',
            name: 'unused',
            filePath: 'src/unused.ts',
            startLine: 1,
            endLine: 5,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'unused' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.impactSummary).toContain('No detected impacts');
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary by default', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 20,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'func' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return structured data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 20,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'func' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.target).toBeDefined();
      expect(data.directCallers).toBeDefined();
      expect(data.transitiveCallers).toBeDefined();
      expect(data.affectedEntrypoints).toBeDefined();
      expect(data.affectedTests).toBeDefined();
      expect(data.riskLevel).toBeDefined();
      expect(data.impactSummary).toBeDefined();
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Depth Parameter Tests
  // ===========================================================================

  describe('Depth Parameter', () => {
    it('should use default depth of 3', async () => {
      const getTransitiveCallers = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
          }),
        ),
        getTransitiveCallers,
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'func' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(getTransitiveCallers).toHaveBeenCalledWith('abc123:function:src/service.ts:func', 3, mockScope.repoHashes);
    });

    it('should respect custom depth parameter', async () => {
      const getTransitiveCallers = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
          }),
        ),
        getTransitiveCallers,
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'func', depth: 5 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(getTransitiveCallers).toHaveBeenCalledWith('abc123:function:src/service.ts:func', 5, mockScope.repoHashes);
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'test' },
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
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'test' },
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

  describe('Entity target', () => {
    it('finds an entity even when targetType is omitted (auto-detect tries entity last)', async () => {
      // Regression: TypeORM @Entity-decorated classes are filed as
      // type='entity' in the graph (their ID segment still says `:class:`
      // but the type column is `entity`). Before this branch, findClass
      // filtered on type='class' and missed them — every entity target
      // returned "not found".
      const findEntity = vi.fn().mockResolvedValue(
        createMockEntityInfo({
          id: 'abc:class:src/entities/Shift.ts:Shift',
          name: 'Shift',
          filePath: 'src/entities/Shift.ts',
          startLine: 1,
          endLine: 80,
        }),
      );
      const getEntityConsumers = vi.fn().mockResolvedValue([
        createMockEntityConsumer({
          id: 'abc:function:src/svc.ts:createShift',
          name: 'createShift',
          filePath: 'src/svc.ts',
          startLine: 10,
          operation: 'create',
        }),
        createMockEntityConsumer({
          id: 'abc:function:src/svc.ts:updateShift',
          name: 'updateShift',
          filePath: 'src/svc.ts',
          startLine: 30,
          operation: 'update',
        }),
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        findEntity,
        getEntityConsumers,
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'Shift' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as ChangeImpactResult;
      expect(data.target.type).toBe('entity');
      expect(data.target.name).toBe('Shift');
      // Consumers populate directCallers with operation tagged in the summary.
      expect(data.directCallers).toHaveLength(2);
      expect(data.directCallers[0].name).toBe('createShift');
      expect(data.directCallers[0].summary).toBe('create Shift');
      // CALLS-edge traversal must not run for entities.
      expect(mockRepo.getTransitiveCallers).not.toHaveBeenCalled();
    });

    it('prefers an exact entity over a unique signature-bearing method ending in the name', async () => {
      const method = createMockFunctionInfo({ id: 'fn', name: 'Shop.OrderBuilder.Shift()' });
      const mockRepo = createMockRepository({
        findFunction: vi.fn(async (name: string) => (name === method.name ? method : null)),
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        findCode: vi
          .fn()
          .mockResolvedValue([
            { id: 'fn', type: 'function', name: 'Shop.OrderBuilder.Shift()', filePath: 'src/OrderBuilder.cs' },
          ]),
        findEntity: vi.fn().mockResolvedValue(createMockEntityInfo({ id: 'ent', name: 'Shift' })),
        getEntityConsumers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });

      const result = await handleAnalyzeChangeImpact(
        { target: 'Shift' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as ChangeImpactResult).target.type).toBe('entity');
    });

    it('honors explicit targetType=entity', async () => {
      const findEntity = vi.fn().mockResolvedValue(createMockEntityInfo({ name: 'Workspace' }));
      const mockRepo = createMockRepository({
        findEntity,
        getEntityConsumers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'Workspace', targetType: 'entity' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findEntity).toHaveBeenCalledWith('Workspace', mockScope.repoHashes);
      // Type-only lookups should not have fired.
      expect(mockRepo.findClass).not.toHaveBeenCalled();
      expect(mockRepo.findInterface).not.toHaveBeenCalled();
    });
  });

  describe('Class.method input', () => {
    it('looks up by bare method name when caller passes Class.method as target', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc:function:src/svc.ts:foo',
          name: 'foo',
          filePath: 'src/svc.ts',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getDirectCallers: vi.fn().mockResolvedValue([]),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'MyService.foo', targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // findFunction must receive bare name AND className filter so bare-name
      // collisions across classes don't return the wrong function.
      expect(findFunction).toHaveBeenCalledWith('foo', mockScope.repoHashes, undefined, 'MyService');
    });

    it('rejects file-path-like targets early instead of resolving to "not found"', async () => {
      const findFunction = vi.fn().mockResolvedValue(null);
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      // Fail-fast: a file path is not a declaration name this tool can look
      // up, so it is rejected before any repository lookup runs, with
      // guidance to use list_file_symbols first.
      await expect(
        handleAnalyzeChangeImpact(
          { target: 'src/modules/foo.service.ts', targetType: 'function' },
          mockScope,
          'raw',
          defaultDetailLevel,
          defaultDetailConfig,
          mockRepo,
        ),
      ).rejects.toThrow(/list_file_symbols/);

      expect(findFunction).not.toHaveBeenCalled();
    });

    it('rejects targets containing a path separator without a file extension', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await expect(
        handleAnalyzeChangeImpact(
          { target: 'apps/server/src/modules/members/members.controller.ts' },
          mockScope,
          'text',
          defaultDetailLevel,
          defaultDetailConfig,
          mockRepo,
        ),
      ).rejects.toThrow(/not supported/);
    });

    it('does not reject an ordinary Class.method target', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc:function:src/svc.ts:foo',
          name: 'foo',
          filePath: 'src/svc.ts',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getDirectCallers: vi.fn().mockResolvedValue([]),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'MyService.foo', targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findFunction).toHaveBeenCalledWith('foo', mockScope.repoHashes, undefined, 'MyService');
    });

    // A Go/C/header method name IS a file extension (`Router.go`, `Buffer.c`,
    // `Preact.h`). The file-path guard must tell them apart by the stem, not by the
    // extension alone, or every such method is unanswerable.
    it.each([
      ['Router.go', 'go', 'Router'],
      ['History.go', 'go', 'History'],
    ])('resolves %s as Class.method rather than rejecting it as a file path', async (target, method, className) => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: `abc:function:src/router.go:${method}`,
          name: method,
          filePath: 'src/router.go',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getDirectCallers: vi.fn().mockResolvedValue([]),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target, targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findFunction).toHaveBeenCalledWith(method, mockScope.repoHashes, undefined, className);
    });

    it.each([
      'src/utils/index.ts',
      'cypher-guard.ts',
    ])('still rejects the genuine file path %s with list_file_symbols guidance', async (target) => {
      const findFunction = vi.fn().mockResolvedValue(null);
      const mockRepo = createMockRepository({ findFunction });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await expect(
        handleAnalyzeChangeImpact({ target }, mockScope, 'text', defaultDetailLevel, defaultDetailConfig, mockRepo),
      ).rejects.toThrow(/list_file_symbols/);
      expect(findFunction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // fileHint disambiguation
  // ===========================================================================

  describe('fileHint disambiguation', () => {
    // Regression for the same bug pattern fixed in explain_entrypoint on
    // 2026-05-15: supabase has 12+ `wrapper` functions across Pages API routes,
    // and a name-only lookup returns the alphabetically-first match. The
    // agent had no way to disambiguate when calling analyze_change_impact for
    // a function whose name collides — fileHint plumbs that hint through.
    it('passes fileHint through to findFunction so name collisions resolve by file', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc:function:pages/api/ai/sql/filter-v1.ts:wrapper',
          name: 'wrapper',
          filePath: 'pages/api/ai/sql/filter-v1.ts',
          startLine: 12,
          endLine: 40,
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        {
          target: 'wrapper',
          targetType: 'function',
          fileHint: 'pages/api/ai/sql/filter-v1',
        },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findFunction).toHaveBeenCalledWith(
        'wrapper',
        mockScope.repoHashes,
        'pages/api/ai/sql/filter-v1',
        undefined,
      );
      const data = result.data as ChangeImpactResult;
      expect(data.target.filePath).toBe('pages/api/ai/sql/filter-v1.ts');
    });

    it('passes both fileHint and className through when caller qualifies as Class.method', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc:function:src/users/UserService.ts:save',
          name: 'save',
          filePath: 'src/users/UserService.ts',
          className: 'UserService',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        {
          target: 'UserService.save',
          targetType: 'function',
          fileHint: 'src/users',
        },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Bare-name lookup with both fileHint AND className filters wired up.
      expect(findFunction).toHaveBeenCalledWith('save', mockScope.repoHashes, 'src/users', 'UserService');
    });

    it('omits fileHint cleanly when caller does not pass one', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc:function:src/svc.ts:doThing',
          name: 'doThing',
          filePath: 'src/svc.ts',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        findClass: vi.fn().mockResolvedValue(null),
        findInterface: vi.fn().mockResolvedValue(null),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleAnalyzeChangeImpact(
        { target: 'doThing', targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Backward-compat: when fileHint is absent it must be passed as
      // undefined so SQLite's findFunction omits the LIKE clause.
      expect(findFunction).toHaveBeenCalledWith('doThing', mockScope.repoHashes, undefined, undefined);
    });
  });

  // ===========================================================================
  // Dynamic boundaries — statically unresolved call sites (spec:
  // .scratch/dynamic-boundaries/spec.md, AC-2, silence)
  // ===========================================================================
  describe('dynamic boundaries', () => {
    it('lists unresolved sites inside impacted files, with file:line and expression (AC-2)', async () => {
      const findUnresolvedCallsInFiles = vi.fn().mockResolvedValue([
        {
          callerId: 'abc123:function:src/service.ts:processData',
          calleeExpression: 'ctx.validators.automaticBookings[validatorMethod]()',
          calleeNameTail: null,
          filePath: 'src/service.ts',
          line: 18,
        },
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 25,
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles,
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Scoped to the TARGET's own repo hash (derived from its id prefix),
      // never the whole cross-repo scope.repoHashes — see the "impact
      // boundaries precision" tests below for why.
      expect(findUnresolvedCallsInFiles).toHaveBeenCalledWith(['src/service.ts'], ['abc123'], {
        limit: 1000,
      });
      expect(result.data).toContain('Dynamic boundaries');
      expect(result.data).toContain('impact may extend through');
      expect(result.data).toContain('src/service.ts:18');
      expect(result.data).toContain('ctx.validators.automaticBookings[validatorMethod]()');
    });

    it('adds an additive `boundaries` field on raw output', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([
          {
            callerId: 'abc123:function:src/service.ts:processData',
            calleeExpression: 'dispatch(kind)',
            calleeNameTail: null,
            filePath: 'src/service.ts',
            line: 5,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as unknown as { boundaries: { sites: unknown[]; omittedCount: number } };
      expect(data.boundaries.sites).toHaveLength(1);
      expect(data.boundaries.omittedCount).toBe(0);
    });

    it('stays silent when no unresolved call site is inside an impacted file', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toContain('Dynamic boundaries');
    });

    it('keeps the basic-detail escalation footer as the final line when a boundary section is appended', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([
          {
            callerId: 'abc123:function:src/service.ts:processData',
            calleeExpression: 'dispatch(kind)',
            calleeNameTail: null,
            filePath: 'src/service.ts',
            line: 5,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'summary',
        'basic',
        resolveDetailLevel('basic'),
        mockRepo,
      );

      const lines = (result.data as string).split('\n').filter((line) => line.length > 0);
      expect(lines[lines.length - 1]).toBe(DETAIL_ESCALATION_HINT);
      expect(result.data).toContain('Dynamic boundaries');
    });

    // Impact-boundaries precision (spec UC-2): "sites inside the impacted
    // symbols", not "sites anywhere in the same files" — two different
    // functions can share a file, and only the impacted one's dynamic
    // dispatch is this tool's business.
    it('excludes an unresolved call site in the same file whose caller is NOT an impacted symbol', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([
          {
            // Same file as the target, but a DIFFERENT function's call site —
            // not the target, not a direct/transitive caller.
            callerId: 'abc123:function:src/service.ts:unrelatedHelper',
            calleeExpression: 'dispatch(kind)',
            calleeNameTail: null,
            filePath: 'src/service.ts',
            line: 99,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toContain('Dynamic boundaries');
    });

    it('keeps a site whose callerId is a direct caller of the target, scoped to the target repo hash', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
            filePath: 'src/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handleRequest',
            filePath: 'src/controller.ts',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([
          {
            callerId: 'abc123:function:src/controller.ts:handleRequest',
            calleeExpression: 'dispatch(kind)',
            calleeNameTail: null,
            filePath: 'src/controller.ts',
            line: 12,
          },
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleAnalyzeChangeImpact(
        { target: 'processData', targetType: 'function' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Dynamic boundaries');
      expect(result.data).toContain('src/controller.ts:12');
    });

    // Honest truncation phrasing (BOUNDARY_FILE_SCOPE_CAP disclosure).
    describe('impacted-file scope truncation note', () => {
      // BOUNDARY_FILE_SCOPE_CAP unique-file direct callers, plus one over —
      // enough to force the cap without asserting on its exact value twice.
      function callersAcrossManyFiles(count: number) {
        return Array.from({ length: count }, (_, i) =>
          createMockCallerInfo({
            id: `abc123:function:src/file${i}.ts:fn${i}`,
            filePath: `src/file${i}.ts`,
            distance: 1,
          }),
        );
      }

      it('appends the truncation note inside the boundary section when sites were also found', async () => {
        const callers = callersAcrossManyFiles(BOUNDARY_FILE_SCOPE_CAP + 1);
        const mockRepo = createMockRepository({
          findFunction: vi.fn().mockResolvedValue(
            createMockFunctionInfo({
              id: 'abc123:function:src/service.ts:processData',
              name: 'processData',
              filePath: 'src/service.ts',
            }),
          ),
          getTransitiveCallers: vi.fn().mockResolvedValue(callers),
          getReachingEntrypoints: vi.fn().mockResolvedValue([]),
          findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([
            {
              callerId: 'abc123:function:src/service.ts:processData',
              calleeExpression: 'dispatch(kind)',
              calleeNameTail: null,
              filePath: 'src/service.ts',
              line: 5,
            },
          ]),
        });
        (getRepository as Mock).mockResolvedValue(mockRepo);

        const result = await handleAnalyzeChangeImpact(
          { target: 'processData', targetType: 'function' },
          mockScope,
          'summary',
          defaultDetailLevel,
          defaultDetailConfig,
          mockRepo,
        );

        expect(result.data).toContain('Dynamic boundaries');
        // 1 target file + (CAP+1) caller files, all distinct → CAP+2 total.
        expect(result.data).toContain(
          `boundary scan covered the first ${BOUNDARY_FILE_SCOPE_CAP} of ${BOUNDARY_FILE_SCOPE_CAP + 2} impacted files`,
        );
      });

      it('emits the boundary section with just the note when truncation happened but nothing matched', async () => {
        const callers = callersAcrossManyFiles(BOUNDARY_FILE_SCOPE_CAP + 1);
        const mockRepo = createMockRepository({
          findFunction: vi.fn().mockResolvedValue(
            createMockFunctionInfo({
              id: 'abc123:function:src/service.ts:processData',
              name: 'processData',
              filePath: 'src/service.ts',
            }),
          ),
          getTransitiveCallers: vi.fn().mockResolvedValue(callers),
          getReachingEntrypoints: vi.fn().mockResolvedValue([]),
          findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([]),
        });
        (getRepository as Mock).mockResolvedValue(mockRepo);

        const result = await handleAnalyzeChangeImpact(
          { target: 'processData', targetType: 'function' },
          mockScope,
          'summary',
          defaultDetailLevel,
          defaultDetailConfig,
          mockRepo,
        );

        expect(result.data).toContain('Dynamic boundaries');
        expect(result.data).toContain(
          `boundary scan covered the first ${BOUNDARY_FILE_SCOPE_CAP} of ${BOUNDARY_FILE_SCOPE_CAP + 2} impacted files`,
        );
      });

      it('adds no truncation note and no boundary section when the file count never hit the cap', async () => {
        const mockRepo = createMockRepository({
          findFunction: vi.fn().mockResolvedValue(
            createMockFunctionInfo({
              id: 'abc123:function:src/service.ts:processData',
              name: 'processData',
              filePath: 'src/service.ts',
            }),
          ),
          getTransitiveCallers: vi.fn().mockResolvedValue([]),
          getReachingEntrypoints: vi.fn().mockResolvedValue([]),
          findUnresolvedCallsInFiles: vi.fn().mockResolvedValue([]),
        });
        (getRepository as Mock).mockResolvedValue(mockRepo);

        const result = await handleAnalyzeChangeImpact(
          { target: 'processData', targetType: 'function' },
          mockScope,
          'summary',
          defaultDetailLevel,
          defaultDetailConfig,
          mockRepo,
        );

        expect(result.data).not.toContain('Dynamic boundaries');
        expect(result.data).not.toContain('boundary scan covered');
      });
    });
  });
});
