/**
 * Tests for the explain_function tool handler
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { handleExplainFunction, parseFunctionName } from './explain-function.js';
import type { ScopeContext, FunctionExplanationResult } from '../../types.js';
import { resolveDetailLevel } from '../../detail-level.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatFunctionExplanation: vi.fn((result, metadata) => {
    if (metadata.format === 'raw') {
      return { data: result, metadata };
    }
    const summary = `## Function: \`${result.function.name}\`\n\n${result.function.summary || 'No summary'}`;
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
  createMockFunctionInfo,
  createMockCallerInfo,
  createMockCallTreeNode,
} from '../../__tests__/fixtures/mock-repository.js';

describe('explain_function Tool Handler', () => {
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
  // Source-in-graph (ALLOW_SOURCES_IN_GRAPH) gating
  // ===========================================================================

  describe('includeSource (ALLOW_SOURCES_IN_GRAPH)', () => {
    const ORIGINAL_FLAG = process.env.ALLOW_SOURCES_IN_GRAPH;
    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
      else process.env.ALLOW_SOURCES_IN_GRAPH = ORIGINAL_FLAG;
    });

    function setupWithSource(sourceCode?: string): void {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/s.ts:fn',
            name: 'fn',
            filePath: 'src/s.ts',
            startLine: 1,
            endLine: 5,
            kind: 'function',
            sourceCode,
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);
    }

    it('attaches sourceCode when the flag is on AND includeSource:true', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      setupWithSource('function fn() { return 1; }');
      const result = await handleExplainFunction(
        { functionName: 'fn', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as FunctionExplanationResult;
      expect(data.function.sourceCode).toBe('function fn() { return 1; }');
    });

    it('omits sourceCode when includeSource is not requested (flag on)', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      setupWithSource('function fn() { return 1; }');
      const result = await handleExplainFunction(
        { functionName: 'fn' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as FunctionExplanationResult;
      expect('sourceCode' in data.function).toBe(false);
    });

    it('fail-closed: omits sourceCode when the flag is OFF even with includeSource:true', async () => {
      delete process.env.ALLOW_SOURCES_IN_GRAPH;
      setupWithSource('function fn() { return 1; }');
      const result = await handleExplainFunction(
        { functionName: 'fn', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        await getRepository(),
      );
      const data = result.data as FunctionExplanationResult;
      expect('sourceCode' in data.function).toBe(false);
    });
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should explain a simple function with metadata', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:getUserById',
            name: 'getUserById',
            filePath: 'src/service.ts',
            startLine: 10,
            endLine: 20,
            kind: 'function',
            summary: 'Retrieves a user by their ID',
            purpose: 'Fetch user data from database',
            visibility: 'public',
            isAsync: true,
            businessLogic: 'Queries user table by primary key',
            sideEffects: 'None - read-only operation',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'getUserById' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.name).toBe('getUserById');
      expect(data.function.summary).toBe('Retrieves a user by their ID');
      expect(data.function.isAsync).toBe(true);
      expect(data.businessLogic).toBe('Queries user table by primary key');
      expect(data.sideEffects).toBe('None - read-only operation');
    });

    it('should include callees by default', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processUser',
            name: 'processUser',
            filePath: 'src/service.ts',
            startLine: 30,
            endLine: 50,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([
          createMockCallTreeNode({
            id: 'abc123:function:src/validator.ts:validateUser',
            name: 'validateUser',
            filePath: 'src/validator.ts',
            startLine: 10,
            kind: 'function',
          }),
          createMockCallTreeNode({
            id: 'abc123:function:src/db.ts:saveUser',
            name: 'saveUser',
            filePath: 'src/db.ts',
            startLine: 40,
            kind: 'function',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'processUser' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callees).toHaveLength(2);
      expect(data.callees![0].name).toBe('validateUser');
      expect(data.callees![1].name).toBe('saveUser');
    });

    it('should include callers when requested', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:helper',
            name: 'helper',
            filePath: 'src/service.ts',
            startLine: 60,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
        getDirectCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handleRequest',
            name: 'handleRequest',
            filePath: 'src/controller.ts',
            startLine: 15,
            kind: 'method',
            className: 'RequestController',
            distance: 1,
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'helper', includeCallers: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callers).toHaveLength(1);
      expect(data.callers![0].name).toBe('handleRequest');
      expect(data.callers![0].className).toBe('RequestController');
    });

    it('includes protocol-aware external calls made by the explained function', async () => {
      const functionId = 'abc123:function:src/service.ts:publish';
      const getExternalCallsFrom = vi.fn().mockResolvedValue([
        {
          id: 'ext-http',
          callerId: functionId,
          callerName: 'publish',
          callerFilePath: 'src/service.ts',
          serviceName: 'apiClient',
          targetService: 'users-api',
          method: 'request',
          protocol: 'http',
          httpMethod: 'POST',
          pathTemplate: '/users/{id}',
          filePath: 'src/service.ts',
          startLine: 12,
        },
        {
          id: 'ext-kafka',
          callerId: functionId,
          callerName: 'publish',
          callerFilePath: 'src/service.ts',
          serviceName: 'kafka',
          method: 'emit',
          protocol: 'messaging',
          messagingSystem: 'kafka',
          messagingDestination: 'user.created',
          filePath: 'src/service.ts',
          startLine: 13,
        },
        {
          id: 'ext-grpc',
          callerId: functionId,
          callerName: 'publish',
          callerFilePath: 'src/service.ts',
          serviceName: 'billing',
          method: 'Charge',
          protocol: 'grpc',
          grpcService: 'billing.Billing',
          grpcMethod: 'Charge',
          filePath: 'src/service.ts',
          startLine: 14,
        },
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: functionId,
            name: 'publish',
            filePath: 'src/service.ts',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
        getExternalCallsFrom,
      });

      const result = await handleExplainFunction(
        { functionName: 'publish' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(getExternalCallsFrom).toHaveBeenCalledWith(functionId, mockScope.repoHashes);
      expect((result.data as FunctionExplanationResult).externalCalls).toEqual([
        { service: 'users-api', pattern: 'POST /users/{id}' },
        { service: 'kafka', pattern: 'messaging:kafka:user.created' },
        { service: 'billing', pattern: 'billing.Billing.Charge' },
      ]);
    });

    it('names the resolved repo when the external call carries no service name', async () => {
      const functionId = 'abc123:function:src/OrdersClient.swift:loadOrders';
      const getExternalCallsFrom = vi.fn().mockResolvedValue([
        {
          id: 'ext-swift',
          callerId: functionId,
          callerName: 'loadOrders',
          callerFilePath: 'src/OrdersClient.swift',
          serviceName: '',
          resolvedTargetId: 'bbb222:entrypoint:02-orders',
          resolvedTargetRepoName: 'orders-service',
          method: 'request',
          protocol: 'http',
          httpMethod: 'GET',
          pathTemplate: '/orders',
          filePath: 'src/OrdersClient.swift',
          startLine: 12,
        },
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: functionId,
            name: 'loadOrders',
            filePath: 'src/OrdersClient.swift',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
        getExternalCallsFrom,
      });

      const result = await handleExplainFunction(
        { functionName: 'loadOrders' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as FunctionExplanationResult).externalCalls).toEqual([
        { service: 'orders-service', pattern: 'GET /orders' },
      ]);
    });

    // A multi-target monorepo resolves a call back into its own repository. Naming the repo as a
    // service it calls tells the agent about a dependency that does not exist; the cross-repo
    // call beside it is still reported.
    it('does not name the caller repo as a service, and keeps the genuine cross-repo call', async () => {
      const functionId = 'abc123def456:function:src/ui/api.ts:load';
      const base = {
        callerId: functionId,
        callerName: 'load',
        callerFilePath: 'src/ui/api.ts',
        serviceName: '',
        method: 'request',
        protocol: 'http' as const,
        httpMethod: 'GET',
        filePath: 'src/ui/api.ts',
        startLine: 12,
      };
      const getExternalCallsFrom = vi.fn().mockResolvedValue([
        {
          ...base,
          id: 'ext-self',
          resolvedTargetId: 'abc123def456:entrypoint:01-own',
          resolvedTargetRepoName: 'test-repo',
          pathTemplate: '/own',
        },
        {
          ...base,
          id: 'ext-cross',
          resolvedTargetId: 'bbb222:entrypoint:02-orders',
          resolvedTargetRepoName: 'orders-service',
          pathTemplate: '/orders',
        },
      ]);
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(
            createMockFunctionInfo({ id: functionId, name: 'load', filePath: 'src/ui/api.ts', startLine: 10 }),
          ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
        getExternalCallsFrom,
      });

      const result = await handleExplainFunction(
        { functionName: 'load' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as FunctionExplanationResult).externalCalls).toEqual([
        { service: 'orders-service', pattern: 'GET /orders' },
      ]);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle function not found', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'nonExistentFunction' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('should return empty object for function not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'nonExistentFunction' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual({});
    });

    it('should handle function with no callees', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/util.ts:leafFunction',
            name: 'leafFunction',
            filePath: 'src/util.ts',
            startLine: 5,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'leafFunction' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callees).toHaveLength(0);
    });

    it('should handle file hint to disambiguate functions', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc123:function:src/users/controller.ts:create',
          name: 'create',
          filePath: 'src/users/controller.ts',
          startLine: 10,
          kind: 'method',
          className: 'UserController',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'create', fileHint: 'users/controller' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.filePath).toBe('src/users/controller.ts');
      expect(findFunction).toHaveBeenCalledWith('create', mockScope.repoHashes, 'users/controller', undefined);
    });

    // Regression for the same bug pattern fixed in explain_entrypoint on
    // 2026-05-15: when a bare name collides across files (12+ `wrapper`
    // functions in supabase Pages API routes), the agent passes a fileHint
    // to pick the right one. This pins down that the hint steers the lookup
    // — the targetFunction's id (and therefore everything downstream that
    // uses it) is the file-disambiguated match, not the alphabetically-first.
    it('disambiguates colliding bare names by fileHint and uses the right id downstream', async () => {
      const getDirectCallees = vi.fn().mockResolvedValue([]);
      const findFunction = vi.fn().mockImplementation(async (_name, _hashes, hint) => {
        if (hint === 'pages/api/ai/sql/filter-v1') {
          return createMockFunctionInfo({
            id: 'abc:function:pages/api/ai/sql/filter-v1.ts:wrapper',
            name: 'wrapper',
            filePath: 'pages/api/ai/sql/filter-v1.ts',
          });
        }
        // No hint → alphabetically-first (the buggy resolution).
        return createMockFunctionInfo({
          id: 'abc:function:code/complete.ts:wrapper',
          name: 'wrapper',
          filePath: 'code/complete.ts',
        });
      });
      const mockRepo = createMockRepository({
        findFunction,
        getDirectCallees,
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'wrapper', fileHint: 'pages/api/ai/sql/filter-v1' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.filePath).toBe('pages/api/ai/sql/filter-v1.ts');
      // Callees query must run against the disambiguated id, not the
      // alphabetically-first one — otherwise the agent gets the wrong tree.
      expect(getDirectCallees).toHaveBeenCalledWith(
        'abc:function:pages/api/ai/sql/filter-v1.ts:wrapper',
        mockScope.repoHashes,
      );
    });

    it('falls back to name-only lookup when fileHint does not match in scope', async () => {
      // Regression for the 2026-05-13 eval: agent passes fileHint pointing
      // at a file outside the current scope's repo (e.g.
      // fileHint="services/api-gateway/..." while scope is the UI repo).
      // The constrained lookup returns null; the retry without fileHint
      // resolves cleanly.
      const findFunction = vi
        .fn()
        // 1st call: with fileHint → null
        .mockResolvedValueOnce(null)
        // 2nd call: without fileHint → hit
        .mockResolvedValueOnce({
          id: 'fn:analyzeApplyTemplate',
          name: 'analyzeApplyTemplate',
          filePath: 'src/components/Shifts/api/services/templates.service.ts',
          startLine: 62,
          endLine: 80,
          kind: 'function',
        });
      const mockRepo = createMockRepository({
        findFunction,
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        {
          functionName: 'analyzeApplyTemplate',
          fileHint: 'services/api-gateway/src/modules/shifts/templates/templates.controller.ts',
        },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Both findFunction calls were made — first with the (failing) fileHint,
      // then a fallback retry without it.
      expect(findFunction).toHaveBeenCalledTimes(2);
      expect(findFunction).toHaveBeenNthCalledWith(
        1,
        'analyzeApplyTemplate',
        mockScope.repoHashes,
        'services/api-gateway/src/modules/shifts/templates/templates.controller.ts',
        undefined,
      );
      expect(findFunction).toHaveBeenNthCalledWith(
        2,
        'analyzeApplyTemplate',
        mockScope.repoHashes,
        undefined,
        undefined,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.name).toBe('analyzeApplyTemplate');
    });
  });

  // ===========================================================================
  // Options Tests
  // ===========================================================================

  describe('Options', () => {
    it('should skip callees when includeCallees is false', async () => {
      const getDirectCallees = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
            filePath: 'src/service.ts',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees,
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'func', includeCallees: false },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callees).toBeUndefined();
      expect(getDirectCallees).not.toHaveBeenCalled();
    });

    it('should skip callers by default', async () => {
      const getDirectCallers = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:func',
            name: 'func',
            filePath: 'src/service.ts',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
        getDirectCallers,
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'func' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callers).toBeUndefined();
      expect(getDirectCallers).not.toHaveBeenCalled();
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
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 10,
            kind: 'function',
            summary: 'Processes data',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'process' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Function: `process`');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'process' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('object');
      expect((result.data as FunctionExplanationResult).function).toBeDefined();
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Class Methods Tests
  // ===========================================================================

  describe('Class Methods', () => {
    it('should handle class methods with className', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:execute',
            name: 'execute',
            filePath: 'src/service.ts',
            startLine: 20,
            endLine: 40,
            kind: 'method',
            visibility: 'public',
            isAsync: true,
            summary: 'Executes the service operation',
            purpose: 'Perform business logic',
            className: 'DataService',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'execute' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.className).toBe('DataService');
      expect(data.function.kind).toBe('method');
      expect(data.function.visibility).toBe('public');
      expect(data.function.isAsync).toBe(true);
    });

    it('should handle callees that are methods', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/controller.ts:handle',
            name: 'handle',
            filePath: 'src/controller.ts',
            startLine: 10,
            kind: 'method',
            className: 'Controller',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([
          createMockCallTreeNode({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            filePath: 'src/service.ts',
            startLine: 25,
            kind: 'method',
            className: 'DataService',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'handle' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.callees).toHaveLength(1);
      expect(data.callees![0].className).toBe('DataService');
      expect(data.callees![0].kind).toBe('method');
    });
  });

  // ===========================================================================
  // Response Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'test' },
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
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'test' },
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
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const summaryResult = await handleExplainFunction(
        { functionName: 'test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleExplainFunction(
        { functionName: 'test' },
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
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/shared/util.ts:sharedFunc',
            name: 'sharedFunc',
            filePath: 'src/shared/util.ts',
            startLine: 10,
            kind: 'function',
          }),
        ),
        getDirectCallees: vi.fn().mockResolvedValue([
          createMockCallTreeNode({
            id: 'xyz789:function:src/service.ts:remoteFunc',
            name: 'remoteFunc',
            filePath: 'src/service.ts',
            startLine: 20,
            kind: 'function',
          }),
        ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'sharedFunc' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as FunctionExplanationResult;
      expect(data.function.name).toBe('sharedFunc');
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // Class.method input parsing
  // ===========================================================================

  describe('parseFunctionName', () => {
    it('returns input unchanged for bare names', () => {
      expect(parseFunctionName('myFn')).toEqual({
        lookupName: 'myFn',
        requestedClassName: undefined,
      });
    });

    it('splits Class.method into lookupName=method, className=Class', () => {
      expect(parseFunctionName('TemplatesService.analyzeRestDaySourceApplication')).toEqual({
        lookupName: 'analyzeRestDaySourceApplication',
        requestedClassName: 'TemplatesService',
      });
    });

    it('keeps the qualifier for nested forms like Outer.Inner.method', () => {
      expect(parseFunctionName('Outer.Inner.method')).toEqual({
        lookupName: 'method',
        requestedClassName: 'Outer.Inner',
      });
    });

    it('treats trailing or leading dots as not a qualifier', () => {
      expect(parseFunctionName('.method')).toEqual({
        lookupName: '.method',
        requestedClassName: undefined,
      });
      expect(parseFunctionName('method.')).toEqual({
        lookupName: 'method.',
        requestedClassName: undefined,
      });
    });
  });

  describe('Class.method input', () => {
    it('looks up by bare method name when caller passes Class.method', async () => {
      const findFunction = vi.fn().mockResolvedValue(
        createMockFunctionInfo({
          id: 'abc123:function:src/service.ts:foo',
          name: 'foo',
          filePath: 'src/service.ts',
        }),
      );
      const mockRepo = createMockRepository({
        findFunction,
        getDirectCallees: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'MyService.foo' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // findFunction must receive bare name AND the className filter so
      // bare-name collisions across classes don't return the wrong function.
      expect(findFunction).toHaveBeenCalledWith('foo', mockScope.repoHashes, undefined, 'MyService');
      const data = result.data as FunctionExplanationResult;
      // className surfaces the requested qualifier so the agent sees what it asked for.
      expect(data.function.className).toBe('MyService');
    });

    it('not-found message names the qualified input for debuggability', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleExplainFunction(
        { functionName: 'MissingClass.missingMethod' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('MissingClass.missingMethod');
      expect(result.data).toContain('missingMethod');
    });
  });
});
