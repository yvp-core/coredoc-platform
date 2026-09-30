/**
 * Tests for the get_callers tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { NodeType } from '@coredoc/core';
import { resetCoverageCaveatCache } from '../../coverage.js';
import { DETAIL_ESCALATION_HINT } from '../../detail-level.js';
import { handleFindCallers } from './find-callers.js';
import type { ScopeContext, CallerInfo, DetailLevel, DetailLevelConfig } from '../../types.js';
import {
  createMockRepository,
  createMockFunctionInfo,
  createMockCallerInfo,
  createMockCoverageCounts,
} from '../../__tests__/fixtures/mock-repository.js';

// Mock database
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatCallerList: vi.fn((callers, functionName, metadata, reachingEntrypoints) => {
    if (metadata.format === 'raw') {
      return { data: { callers, reachingEntrypoints: reachingEntrypoints || [] }, metadata };
    }
    let summary = `## Callers of \`${functionName}\` (${callers.length})`;
    // Mirror the real formatCallerList: the escalation footer must be the last
    // line of a basic-detail summary, so appendBoundarySection has something
    // real to insert ahead of.
    if (metadata.detailLevel === 'basic') summary += `\n\n${DETAIL_ESCALATION_HINT}`;
    return { data: summary, metadata };
  }),
  createMetadata: vi.fn((scope, format, detailLevel, detailConfig) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
    detailLevel: detailLevel || 'full',
    detailConfig: detailConfig || {
      includeBasic: true,
      includeSummaries: true,
      includeRefs: true,
      includeFullDetails: true,
    },
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

describe('get_callers Tool Handler', () => {
  let mockScope: ScopeContext;
  let getRepository: Mock;

  beforeEach(async () => {
    // The caveat path memoizes counts module-wide — isolate each test's mock.
    resetCoverageCaveatCache();
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
    it('should find direct callers of a function', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:getUserById',
            name: 'getUserById',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:getUser',
            name: 'getUser',
            filePath: 'src/controller.ts',
            startLine: 10,
            endLine: 20,
            kind: 'method',
            summary: 'Gets user by ID',
            className: 'UserController',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'getUserById' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Callers of `getUserById`');
    });

    it('should find transitive callers with correct distances', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:processData',
            name: 'processData',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/api.ts:handler',
            name: 'handler',
            filePath: 'src/api.ts',
            startLine: 5,
            kind: 'function',
            distance: 1,
          }),
          createMockCallerInfo({
            id: 'abc123:function:src/routes.ts:endpoint',
            name: 'endpoint',
            filePath: 'src/routes.ts',
            startLine: 15,
            kind: 'function',
            distance: 2,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'processData', depth: 3 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toHaveLength(2);
      expect(data.callers[0].distance).toBe(1);
      expect(data.callers[1].distance).toBe(2);
    });

    it('should handle file hint to disambiguate functions', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/users/service.ts:save',
            name: 'save',
            filePath: 'src/users/service.ts',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      await handleFindCallers(
        { functionName: 'save', fileHint: 'users/service' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Verify findFunction was called with fileHint (no class qualifier
      // in this input, so the 4th arg — className filter — is undefined).
      expect(mockRepo.findFunction).toHaveBeenCalledWith('save', mockScope.repoHashes, 'users/service', undefined);
    });

    // Regression for the same bug pattern fixed in explain_entrypoint on
    // 2026-05-15: when two functions share a bare name (e.g. 12+ `wrapper`
    // functions in supabase Pages API routes), fileHint must reach
    // findFunction so the resolver picks by path instead of returning the
    // alphabetically-first match. Mirrors the analyze_change_impact fix —
    // find_callers was already plumbed correctly, this test pins it down.
    it('disambiguates colliding bare names by fileHint', async () => {
      // Mock findFunction to return whichever record matches the hint —
      // simulates the SQLite LIKE behavior at packages/db/src/sqlite/repository.ts:154.
      const findFunction = vi.fn().mockImplementation(async (_name, _hashes, hint) => {
        if (hint === 'pages/api/ai/sql/filter-v1') {
          return createMockFunctionInfo({
            id: 'abc:function:pages/api/ai/sql/filter-v1.ts:wrapper',
            name: 'wrapper',
            filePath: 'pages/api/ai/sql/filter-v1.ts',
          });
        }
        // No hint → fall through to alphabetically-first match. That's the
        // buggy path we never want the agent to land in.
        return createMockFunctionInfo({
          id: 'abc:function:code/complete.ts:wrapper',
          name: 'wrapper',
          filePath: 'code/complete.ts',
        });
      });
      const mockRepo = createMockRepository({
        findFunction,
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'wrapper', fileHint: 'pages/api/ai/sql/filter-v1' },
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
      // The targetFunction's id flows into getTransitiveCallers, so verify
      // the right one was selected — confirms the hint actually steered the
      // lookup, not just got passed in for show.
      expect(mockRepo.getTransitiveCallers).toHaveBeenCalledWith(
        'abc:function:pages/api/ai/sql/filter-v1.ts:wrapper',
        1,
        mockScope.repoHashes,
      );
      // Sanity: the response references the file the agent asked about.
      expect(JSON.stringify(result.data)).not.toContain('code/complete.ts');
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
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'nonExistentFunction' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('should return empty array for function not found in raw mode', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'nonExistentFunction' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should handle function with no callers', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/util.ts:helper',
            name: 'helper',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'helper' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toEqual([]);
      expect(data.reachingEntrypoints).toEqual([]);
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
            id: 'abc123:function:src/service.ts:target',
            name: 'target',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/caller.ts:caller',
            name: 'caller',
            filePath: 'src/caller.ts',
            startLine: 10,
            kind: 'function',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'target' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Callers of `target`');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:target',
            name: 'target',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/caller.ts:caller',
            name: 'caller',
            filePath: 'src/caller.ts',
            startLine: 10,
            kind: 'function',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'target' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(Array.isArray(data.callers)).toBe(true);
      expect(result.metadata.format).toBe('raw');
    });
  });

  // ===========================================================================
  // Entrypoints Tests
  // ===========================================================================

  describe('Entrypoints', () => {
    it('should include entrypoints by default', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:handler',
            name: 'handler',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([
          {
            id: 'abc123:entrypoint:http:GET:/api/users',
            type: 'http',
            method: 'GET',
            path: '/api/users',
            filePath: 'src/routes.ts',
            startLine: 10,
            handlerId: 'abc123:function:src/handler.ts:handler',
            handlerName: 'handler',
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      await handleFindCallers(
        { functionName: 'handler', includeEntrypoints: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Should call getReachingEntrypoints
      expect(mockRepo.getReachingEntrypoints).toHaveBeenCalled();
    });

    it('should skip entrypoints when includeEntrypoints is false', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:handler',
            name: 'handler',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      await handleFindCallers(
        { functionName: 'handler', includeEntrypoints: false },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Should not call getReachingEntrypoints
      expect(mockRepo.getReachingEntrypoints).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Class Methods Tests
  // ===========================================================================

  describe('Class Methods', () => {
    it('should handle method callers with className', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/service.ts:save',
            name: 'save',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/controller.ts:handleSave',
            name: 'handleSave',
            filePath: 'src/controller.ts',
            startLine: 25,
            endLine: 35,
            kind: 'method',
            visibility: 'public',
            isAsync: true,
            summary: 'Handles save request',
            purpose: 'Process and persist data',
            className: 'SaveController',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'save' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toHaveLength(1);
      expect(data.callers[0].className).toBe('SaveController');
      expect(data.callers[0].kind).toBe('method');
      expect(data.callers[0].visibility).toBe('public');
      expect(data.callers[0].isAsync).toBe(true);
      expect(data.callers[0].summary).toBe('Handles save request');
      expect(data.callers[0].purpose).toBe('Process and persist data');
    });

    it('should handle callers without className', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(
          createMockFunctionInfo({
            id: 'abc123:function:src/util.ts:helper',
            name: 'helper',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/app.ts:main',
            name: 'main',
            filePath: 'src/app.ts',
            startLine: 10,
            kind: 'function',
            className: undefined,
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'helper' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toHaveLength(1);
      expect(data.callers[0].className).toBeUndefined();
      expect(data.callers[0].kind).toBe('function');
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
            id: 'abc123:function:src/service.ts:shared',
            name: 'shared',
          }),
        ),
        getTransitiveCallers: vi.fn().mockResolvedValue([
          createMockCallerInfo({
            id: 'abc123:function:src/caller1.ts:caller1',
            name: 'caller1',
            filePath: 'src/caller1.ts',
            startLine: 10,
            kind: 'function',
            distance: 1,
          }),
          createMockCallerInfo({
            id: 'xyz789:function:src/caller2.ts:caller2',
            name: 'caller2',
            filePath: 'src/caller2.ts',
            startLine: 20,
            kind: 'function',
            distance: 1,
          }),
        ]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'shared' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toHaveLength(2);
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
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
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
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
      getRepository.mockResolvedValue(mockRepo);

      const summaryResult = await handleFindCallers(
        { functionName: 'test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleFindCallers(
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
  // State-store / Variable Fallback
  // ===========================================================================
  //
  // When findFunction returns null, the handler must fall back to looking
  // up state_store / variable nodes by name and surface their direct
  // referencers via getDirectCallers (which also queries REFERENCES_VARIABLE
  // edges). This is the Posthog/Kea-logic fix: `find_callers(userLogic)`
  // used to dead-end at "function not found" because userLogic is a
  // state_store, not a function.
  describe('State store / variable fallback', () => {
    it('falls back to state_store lookup when no function exists with that name', async () => {
      const findFunction = vi.fn().mockResolvedValue(null);
      const findCode = vi.fn().mockResolvedValue([
        {
          id: 'abc123:state_store:src/userLogic.ts:userLogic',
          name: 'userLogic',
          type: 'state_store',
          filePath: 'src/userLogic.ts',
          startLine: 3,
          endLine: 25,
        },
      ]);
      const getDirectCallers = vi.fn().mockResolvedValue([
        createMockCallerInfo({
          id: 'abc123:function:src/UserPage.ts:UserPage',
          name: 'UserPage',
          filePath: 'src/UserPage.ts',
          startLine: 10,
          kind: 'function',
          distance: 1,
        }),
      ]);
      const mockRepo = createMockRepository({
        findFunction,
        findCode,
        getDirectCallers,
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'userLogic' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // findFunction must run first — that's the dominant case and we don't
      // want to spend a findCode round-trip on every function lookup.
      expect(findFunction).toHaveBeenCalledWith('userLogic', mockScope.repoHashes, undefined, undefined);
      // findCode is the fallback path, scoped to state_store / variable only.
      expect(findCode).toHaveBeenCalledWith(
        { pattern: 'userLogic', types: ['state_store', 'variable'], limit: 1 },
        mockScope.repoHashes,
      );
      // Non-callable targets use getDirectCallers (REFERENCES_VARIABLE-aware)
      // rather than getTransitiveCallers — the closure table only tracks
      // CALLS edges, so a transitive lookup wouldn't reach the consumers.
      expect(getDirectCallers).toHaveBeenCalledWith(
        'abc123:state_store:src/userLogic.ts:userLogic',
        mockScope.repoHashes,
      );
      expect(mockRepo.getTransitiveCallers).not.toHaveBeenCalled();
      // Reaching-entrypoints walks the closure table — useless for state
      // stores; skip it.
      expect(mockRepo.getReachingEntrypoints).not.toHaveBeenCalled();

      const data = result.data as { callers: CallerInfo[]; reachingEntrypoints: unknown[] };
      expect(data.callers).toHaveLength(1);
      expect(data.callers[0].name).toBe('UserPage');
    });

    it('still reports "not found" when neither function nor state_store/variable matches', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'doesNotExist' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('not found');
    });

    it('does not invoke the state_store fallback when a Class.method qualifier was passed', async () => {
      // A `Class.method` lookup is unambiguous about wanting a function. If
      // findFunction returns null for `User.save`, treat that as a true
      // miss — don't shadow it with a stray `save` variable somewhere.
      const findFunction = vi.fn().mockResolvedValue(null);
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({
        findFunction,
        findCode,
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'User.save' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findFunction).toHaveBeenCalledWith('save', mockScope.repoHashes, undefined, 'User');
      for (const [params] of findCode.mock.calls) expect(params.types).toEqual([NodeType.Function]);
      expect(result.data).toContain('not found');
    });
  });

  // ===========================================================================
  // Low-Coverage Caveat Tests
  // ===========================================================================

  describe('Low-Coverage Caveats', () => {
    // 40 of 100 in-repo call sites unbound — a count, not a density verdict.
    const lowCallCounts = [
      createMockCoverageCounts({ callResolution: { callSites: 120, resolvedCalls: 60, outOfScopeCalls: 20 } }),
    ];
    const expectedCaveat =
      'Note: 40 of 100 counted in-repo call sites are unbound across 1 measured repo(s) — an empty result here may be an unbound call, not a code fact. Verify with source (grep) before asserting nonexistence.';

    it('appends the caveat to the not-found message when in-repo call sites are unbound', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue(lowCallCounts),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'ghostFn' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain("Function 'ghostFn' not found in scope");
      expect(result.data).toContain(expectedCaveat);
      expect(mockRepo.getCoverageCounts).toHaveBeenCalledWith(mockScope.repoHashes);
    });

    it('appends the caveat when the function is found but has zero callers and entrypoints', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(createMockFunctionInfo({ name: 'orphanFn' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(lowCallCounts),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'orphanFn' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Callers of `orphanFn` (0)');
      expect(result.data).toContain(expectedCaveat);
    });

    it('adds no caveat when every repo is measured and nothing is unbound', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue([
          createMockCoverageCounts({
            callResolution: { callSites: 100, resolvedCalls: 80, outOfScopeCalls: 20 },
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'ghostFn' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toBe("Function 'ghostFn' not found in scope");
    });

    it('leaves non-empty results untouched and never queries coverage (lazy)', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(createMockFunctionInfo({ name: 'busyFn' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([createMockCallerInfo()]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        getCoverageCounts: vi.fn().mockResolvedValue(lowCallCounts),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'busyFn' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toContain('Note:');
      expect(mockRepo.getCoverageCounts).not.toHaveBeenCalled();
    });

    it('keeps raw not-found output a plain empty array (caveat is summary-only)', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi.fn().mockResolvedValue(null),
        getCoverageCounts: vi.fn().mockResolvedValue(lowCallCounts),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'ghostFn' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });
  });

  describe('argument addressing', () => {
    it('accepts `target` as an alias for `functionName`', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(
            createMockFunctionInfo({ id: 'abc:function:src/h.ts:useIsOrioleDb', name: 'useIsOrioleDb' }),
          ),
        getDirectCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      await handleFindCallers(
        { target: 'useIsOrioleDb' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.findFunction).toHaveBeenCalledWith('useIsOrioleDb', mockScope.repoHashes, undefined, undefined);
    });

    it('errors explicitly when no functionName/target was passed', async () => {
      const mockRepo = createMockRepository({ findFunction: vi.fn() });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        {},
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('`functionName`');
      expect(result.data).not.toContain('undefined');
      expect(mockRepo.findFunction).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Dynamic boundaries — statically unresolved call sites (spec:
  // .scratch/dynamic-boundaries/spec.md, AC-1, AC-5, silence)
  // ===========================================================================
  describe('dynamic boundaries', () => {
    it('appends a labeled boundary section for a matching unresolved call site, never merged into callers (AC-1)', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([
          {
            callerId: 'abc:function:src/producer.ts:publish',
            calleeExpression: "this.client.emit(getTopicInNamespace('x'))",
            calleeNameTail: 'onTopic',
            filePath: 'src/producer.ts',
            line: 42,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.findUnresolvedCallsByNameTail).toHaveBeenCalledWith('onTopic', mockScope.repoHashes, {
        limit: 1000,
      });
      expect(result.data).toContain('Dynamic boundaries');
      expect(result.data).toContain('candidates, NOT confirmed callers');
      expect(result.data).toContain('src/producer.ts:42');
      expect(result.data).toContain("getTopicInNamespace('x')");
      // The mocked formatCallerList summary always states "(0)" for zero
      // callers — the boundary section must be additive to that count, never
      // folded into it.
      expect(result.data).toContain('## Callers of `onTopic` (0)');
    });

    it('adds an additive `boundaries` field on raw output, distinct from `callers`', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([
          {
            callerId: 'abc:function:src/producer.ts:publish',
            calleeExpression: "this.client.emit(getTopicInNamespace('x'))",
            calleeNameTail: 'onTopic',
            filePath: 'src/producer.ts',
            line: 42,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const data = result.data as { callers: unknown[]; boundaries: { sites: unknown[]; omittedCount: number } };
      expect(data.callers).toEqual([]);
      expect(data.boundaries.sites).toHaveLength(1);
      expect(data.boundaries.omittedCount).toBe(0);
    });

    it('caps sites shown and reports the omitted count deterministically (AC-5)', async () => {
      const records = Array.from({ length: 7 }, (_, i) => ({
        callerId: `abc:function:src/producer.ts:publish${i}`,
        calleeExpression: `dispatch(handlers[${i}])`,
        calleeNameTail: 'onTopic',
        filePath: 'src/producer.ts',
        line: 10 + i,
      }));
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue(records),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect((result.data as string).match(/src\/producer\.ts:1\d/g)).toHaveLength(5);
      expect(result.data).toContain('…and 2 more omitted');
    });

    it('stays silent when no unresolved call site matches (absence stays meaningful)', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).not.toContain('Dynamic boundaries');
    });

    it('sanitizes backticks in the callee expression so they cannot break out of the code span', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([
          {
            callerId: 'abc:function:src/producer.ts:publish',
            calleeExpression: 'sql`select 1`',
            calleeNameTail: 'onTopic',
            filePath: 'src/producer.ts',
            line: 42,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const line = (result.data as string).split('\n').find((l) => l.includes('src/producer.ts:42'));
      expect(line).toBeDefined();
      // The rendered line is `- file:line — \`<expression>\` (caller: id)` — exactly
      // two backticks, opening and closing the code span. Any more means a
      // backtick from the expression survived and broke out of it.
      expect((line as string).split('`').length - 1).toBe(2);
      expect(result.data).toContain("sql'select 1'");
    });

    it('keeps the basic-detail escalation footer as the final line when a boundary section is appended', async () => {
      const mockRepo = createMockRepository({
        findFunction: vi
          .fn()
          .mockResolvedValue(createMockFunctionInfo({ id: 'abc:function:src/handler.ts:onTopic', name: 'onTopic' })),
        getTransitiveCallers: vi.fn().mockResolvedValue([]),
        getReachingEntrypoints: vi.fn().mockResolvedValue([]),
        findUnresolvedCallsByNameTail: vi.fn().mockResolvedValue([
          {
            callerId: 'abc:function:src/producer.ts:publish',
            calleeExpression: "this.client.emit(getTopicInNamespace('x'))",
            calleeNameTail: 'onTopic',
            filePath: 'src/producer.ts',
            line: 42,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleFindCallers(
        { functionName: 'onTopic' },
        mockScope,
        'summary',
        'basic',
        defaultDetailConfig,
        mockRepo,
      );

      const lines = (result.data as string).split('\n').filter((line) => line.length > 0);
      expect(lines[lines.length - 1]).toBe(DETAIL_ESCALATION_HINT);
      expect(result.data).toContain('Dynamic boundaries');
    });
  });
});
