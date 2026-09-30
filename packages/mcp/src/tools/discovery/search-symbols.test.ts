/**
 * Tests for the find_code tool handler
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { NodeType } from '@coredoc/core';
import { handleSearchSymbols } from './search-symbols.js';
import type { ScopeContext, CodeElementInfo, DetailLevel, DetailLevelConfig } from '../../types.js';
import { createMockRepository, createMockCodeElement } from '../../__tests__/fixtures/mock-repository.js';

// Mock database
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatCodeElementList: vi.fn((elements, title, metadata) => {
    if (metadata.format === 'raw') {
      return { data: elements, metadata };
    }
    const summary = `${title}\n\nFound ${elements.length} elements`;
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

describe('find_code Tool Handler', () => {
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

  it('routes type=file to file nodes and returns the matched file', async () => {
    const file = createMockCodeElement({
      id: 'abc:file:src/server.ts:server.ts',
      name: 'server.ts',
      type: NodeType.File,
      filePath: 'src/server.ts',
      startLine: 1,
      endLine: 200,
    });
    const findCode = vi.fn().mockResolvedValue([file]);
    const mockRepo = createMockRepository({ findCode });

    const result = await handleSearchSymbols(
      { query: 'server.ts', type: 'file' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ types: [NodeType.File] }), mockScope.repoHashes);
    expect(result.data).toEqual([
      expect.objectContaining({ name: 'server.ts', type: 'file', filePath: 'src/server.ts' }),
    ]);
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

    // findCode mirrors the DB: it only returns sourceCode when asked to project it.
    function setup() {
      const findCode = vi.fn().mockImplementation((params: { includeSource?: boolean }) =>
        Promise.resolve([
          createMockCodeElement({
            id: 'abc:function:src/s.ts:fn',
            name: 'fn',
            type: 'function',
            filePath: 'src/s.ts',
            startLine: 1,
            endLine: 5,
            sourceCode: params.includeSource ? 'function fn() {}' : undefined,
          }),
        ]),
      );
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);
      return { mockRepo, findCode };
    }

    it('projects + attaches source when flag on AND includeSource:true', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      const { mockRepo, findCode } = setup();
      const result = await handleSearchSymbols(
        { query: 'fn', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].sourceCode).toBe('function fn() {}');
      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ includeSource: true }), mockScope.repoHashes);
    });

    it('omits source when includeSource not requested (flag on)', async () => {
      process.env.ALLOW_SOURCES_IN_GRAPH = 'true';
      const { mockRepo, findCode } = setup();
      const result = await handleSearchSymbols(
        { query: 'fn' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].sourceCode).toBeUndefined();
      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ includeSource: false }), mockScope.repoHashes);
    });

    it('fail-closed: omits source when the flag is OFF even with includeSource:true', async () => {
      delete process.env.ALLOW_SOURCES_IN_GRAPH;
      const { mockRepo, findCode } = setup();
      const result = await handleSearchSymbols(
        { query: 'fn', includeSource: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].sourceCode).toBeUndefined();
      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ includeSource: false }), mockScope.repoHashes);
    });
  });

  // ===========================================================================
  // Multi-word miss query budget
  // ===========================================================================

  describe('multi-word miss query budget', () => {
    it('does not fan out an over-long multi-word query into per-token lookups', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const query = Array.from({ length: 20 }, (_, i) => `term${i}`).join(' ');
      await handleSearchSymbols({ query }, mockScope, 'summary', defaultDetailLevel, defaultDetailConfig, mockRepo);

      // One AND lookup plus the two zero-result probes (variable-kind, and the
      // out-of-scope "declared elsewhere" probe) — never one lookup per token.
      expect(findCode).toHaveBeenCalledTimes(3);
    });

    it('does not retry each token for a normal short multi-word query', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'create user service' }, // 3 tokens — under the cap
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Same fixed budget as above: no per-token retry.
      expect(findCode).toHaveBeenCalledTimes(3);
    });
  });

  // ===========================================================================
  // Parser-duplicate dedupe + zero-result variable hint
  // ===========================================================================

  describe('parser-duplicate dedupe', () => {
    it('collapses function+component at the same name+file+line into one row carrying both kinds', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc:function:src/ScheduleEmployees.tsx:ScheduleEmployees',
          name: 'ScheduleEmployees',
          type: 'function',
          filePath: 'src/ScheduleEmployees.tsx',
          startLine: 92,
          endLine: 150,
        }),
        createMockCodeElement({
          id: 'abc:component:src/ScheduleEmployees.tsx:ScheduleEmployees',
          name: 'ScheduleEmployees',
          type: 'component',
          filePath: 'src/ScheduleEmployees.tsx',
          startLine: 92,
          endLine: 150,
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'ScheduleEmployees' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      // function outranks component; both collapsed kinds are recorded.
      expect(elements[0].type).toBe('function');
      expect(elements[0].kinds).toEqual(['function', 'component']);
    });

    it('does not merge distinct same-named symbols at different lines', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc:function:src/a.ts:handler@10',
          name: 'handler',
          type: 'function',
          filePath: 'src/a.ts',
          startLine: 10,
        }),
        createMockCodeElement({
          id: 'abc:function:src/a.ts:handler@40',
          name: 'handler',
          type: 'function',
          filePath: 'src/a.ts',
          startLine: 40,
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'handler' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(2);
      expect(elements.every((e) => e.kinds === undefined)).toBe(true);
    });
  });

  describe("zero-result type='all' variable hint", () => {
    it("nudges toward type='variable' only when a matching variable/const exists", async () => {
      // Main 'all' search (11 kinds) finds nothing; the length-1 variable probe does.
      const findCode = vi.fn().mockImplementation((params: { types: unknown[] }) =>
        Promise.resolve(
          params.types.length === 1
            ? [
                createMockCodeElement({
                  id: 'abc:variable:src/c.ts:MY_FLAG',
                  name: 'MY_FLAG',
                  type: 'variable',
                  filePath: 'src/c.ts',
                  startLine: 3,
                }),
              ]
            : [],
        ),
      );
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'MY_FLAG' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data as string).toContain("retry with type='variable'");
    });

    it('omits the hint on a true zero (no variable match either)', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'totallyAbsentName' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data as string).not.toContain("type='variable'");
    });
  });

  // ===========================================================================
  // Basic Functionality Tests
  // ===========================================================================

  describe('Basic Functionality', () => {
    it('should find elements by exact name match', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/user.ts:getUserById',
            name: 'getUserById',
            type: 'function',
            filePath: 'src/user.ts',
            startLine: 10,
            endLine: 20,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'getUserById', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0].name).toBe('getUserById');
      expect(elements[0].type).toBe('function');
    });

    it('should find elements by partial name match', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/user.ts:getUserById',
            name: 'getUserById',
            filePath: 'src/user.ts',
            startLine: 10,
            endLine: 20,
          }),
          createMockCodeElement({
            id: 'abc123:function:src/user.ts:getUsers',
            name: 'getUsers',
            filePath: 'src/user.ts',
            startLine: 30,
            endLine: 40,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'getUser' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements.every((e) => e.name.includes('getUser') || e.name.includes('User'))).toBe(true);
    });

    it('should search all types by default', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/service.ts:process',
            name: 'process',
            type: 'function',
            filePath: 'src/service.ts',
            startLine: 5,
            endLine: 10,
          }),
          createMockCodeElement({
            id: 'abc123:class:src/process.ts:Process',
            name: 'Process',
            type: 'class',
            filePath: 'src/process.ts',
            startLine: 1,
            endLine: 50,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'process' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });

    it('should respect limit parameter', async () => {
      const manyElements = Array.from({ length: 30 }, (_, i) =>
        createMockCodeElement({
          id: `abc123:function:src/service${i}.ts:func${i}`,
          name: `func${i}`,
          filePath: `src/service${i}.ts`,
          startLine: 1,
          endLine: 10,
        }),
      );

      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue(manyElements.slice(0, 10)),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'func', limit: 10 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeLessThanOrEqual(10);
    });
  });

  // ===========================================================================
  // Type-Specific Search Tests
  // ===========================================================================

  describe('Type-Specific Search', () => {
    it('should search only functions when type=function', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/util.ts:helper',
            name: 'helper',
            type: 'function',
            filePath: 'src/util.ts',
            startLine: 5,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'helper', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.every((e) => e.type === 'function')).toBe(true);
    });

    it('should search only classes when type=class', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:class:src/user.ts:UserService',
            name: 'UserService',
            type: 'class',
            filePath: 'src/user.ts',
            startLine: 1,
            endLine: 100,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'UserService', type: 'class' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.every((e) => e.type === 'class')).toBe(true);
    });

    it('should search only interfaces when type=interface', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:interface:src/types.ts:IUser',
            name: 'IUser',
            type: 'interface',
            filePath: 'src/types.ts',
            startLine: 5,
            endLine: 15,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'IUser', type: 'interface' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.every((e) => e.type === 'interface')).toBe(true);
    });

    it('should search only entities when type=entity', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entity:src/entities/user.ts:User',
            name: 'User',
            type: 'entity',
            filePath: 'src/entities/user.ts',
            startLine: 1,
            endLine: 50,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'User', type: 'entity' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.every((e) => e.type === 'entity')).toBe(true);
    });

    it('should search entrypoints by path and fieldName', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entrypoint:http:GET:/api/users',
            name: 'GET /api/users',
            type: 'entrypoint',
            filePath: 'src/routes.ts',
            startLine: 10,
            endLine: 15,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: '/api/users', type: 'entrypoint' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements[0].type).toBe('entrypoint');
    });

    it('should search only components when type=component', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc123:component:src/views/Requests.tsx:RequestsPage',
          name: 'RequestsPage',
          type: 'component',
          filePath: 'src/views/Requests.tsx',
          startLine: 1,
          endLine: 80,
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'RequestsPage', type: 'component' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ types: ['component'] }), mockScope.repoHashes);
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].type).toBe('component');
    });

    it('should search only routes when type=route', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc123:route:src/router.ts:/requests',
          name: '/requests',
          type: 'route',
          filePath: 'src/router.ts',
          startLine: 12,
          endLine: 14,
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: '/requests', type: 'route' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ types: ['route'] }), mockScope.repoHashes);
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].type).toBe('route');
    });

    it('should search only variables when type=variable (opt-in)', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc123:variable:src/config.ts:LOCK_BYPASS_GRACE_PERIOD_MS',
          name: 'LOCK_BYPASS_GRACE_PERIOD_MS',
          type: 'variable',
          filePath: 'src/config.ts',
          startLine: 49,
          endLine: 49,
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'LOCK_BYPASS_GRACE_PERIOD_MS', type: 'variable' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ types: ['variable'] }), mockScope.repoHashes);
      const elements = result.data as CodeElementInfo[];
      expect(elements[0].type).toBe('variable');
    });

    it('should include component, route, state_store, and variable when type=all', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'something', type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const callArgs = findCode.mock.calls[0]![0] as { types: string[]; exportedVariablesOnly?: boolean };
      expect(callArgs.types).toContain('component');
      expect(callArgs.types).toContain('route');
      expect(callArgs.types).toContain('state_store');
      expect(callArgs.types).toContain('variable');
      // 'all' includes variables but filters to exported only.
      expect(callArgs.exportedVariablesOnly).toBe(true);
    });

    it('should dedupe state_store and variable rows that share name+filePath', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc:state_store:frontend/src/scenes/userLogic.ts:userLogic',
          name: 'userLogic',
          type: 'state_store',
          filePath: 'frontend/src/scenes/userLogic.ts',
        }),
        createMockCodeElement({
          id: 'abc:variable:frontend/src/scenes/userLogic.ts:userLogic',
          name: 'userLogic',
          type: 'variable',
          filePath: 'frontend/src/scenes/userLogic.ts',
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'userLogic', type: 'all' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0]!.type).toBe('state_store');
    });

    it('should pass exportedVariablesOnly=false when type=variable (explicit opt-in)', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'LOCK_BYPASS', type: 'variable' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const callArgs = findCode.mock.calls[0]![0] as { exportedVariablesOnly?: boolean };
      expect(callArgs.exportedVariablesOnly).toBe(false);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle no results found', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'nonExistentElement' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toEqual([]);
    });

    it('should handle empty results in summary format', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'nonExistentElement' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data).toContain('Found 0 elements');
    });

    it('should handle missing optional properties', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/test.ts:minimal',
            name: 'minimal',
            filePath: 'src/test.ts',
            startLine: 1,
            endLine: undefined,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'minimal' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements[0].name).toBe('minimal');
      expect(elements[0].endLine).toBeUndefined();
    });

    it('should escape regex special characters', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/test.ts:$save',
            name: '$save',
            filePath: 'src/test.ts',
            startLine: 1,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: '$save' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      // Should not throw regex error
      expect(result.data).toBeDefined();
    });
  });

  // ===========================================================================
  // Output Format Tests
  // ===========================================================================

  describe('Output Formats', () => {
    it('should format output as summary', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/test.ts:test',
            name: 'test',
            filePath: 'src/test.ts',
            startLine: 1,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('Search results for "test"');
      expect(result.metadata.format).toBe('summary');
    });

    it('should return raw data when format is raw', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/test.ts:test',
            name: 'test',
            filePath: 'src/test.ts',
            startLine: 1,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'test' },
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
  // Sorting and Relevance Tests
  // ===========================================================================

  describe('Sorting and Relevance', () => {
    it('should sort exact matches first', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/util.ts:getUserInfo',
            name: 'getUserInfo',
            filePath: 'src/util.ts',
            startLine: 10,
            endLine: 20,
          }),
          createMockCodeElement({
            id: 'abc123:function:src/service.ts:getUser',
            name: 'getUser',
            filePath: 'src/service.ts',
            startLine: 5,
            endLine: 15,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'getUser' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      // Exact match 'getUser' should come before 'getUserInfo'
      if (elements.length > 1) {
        const exactMatchIndex = elements.findIndex((e) => e.name === 'getUser');
        const partialMatchIndex = elements.findIndex((e) => e.name === 'getUserInfo');
        if (exactMatchIndex !== -1 && partialMatchIndex !== -1) {
          expect(exactMatchIndex).toBeLessThan(partialMatchIndex);
        }
      }
    });

    it('should be case-insensitive', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:class:src/user.ts:UserService',
            name: 'UserService',
            type: 'class',
            filePath: 'src/user.ts',
            startLine: 1,
            endLine: 100,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'userservice' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements[0].name.toLowerCase()).toContain('userservice');
    });

    it('should sort alphabetically after exact matches', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/z.ts:zFunc',
            name: 'zFunc',
            filePath: 'src/z.ts',
            startLine: 1,
            endLine: 10,
          }),
          createMockCodeElement({
            id: 'abc123:function:src/a.ts:aFunc',
            name: 'aFunc',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'Func', type: 'function' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBe(2);
      // Both are partial matches, should be sorted alphabetically
      expect(elements[0].name).toBe('aFunc');
      expect(elements[1].name).toBe('zFunc');
    });
  });

  // ===========================================================================
  // Limit Tests
  // ===========================================================================

  describe('Limit Parameter', () => {
    it('should use default limit of 20', async () => {
      const manyElements = Array.from({ length: 50 }, (_, i) =>
        createMockCodeElement({
          id: `abc123:function:src/f${i}.ts:func${i}`,
          name: `func${i}`,
          filePath: `src/f${i}.ts`,
          startLine: 1,
          endLine: 10,
        }),
      );

      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue(manyElements.slice(0, 20)),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'func' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeLessThanOrEqual(20);
    });

    it('should respect custom limit', async () => {
      const manyElements = Array.from({ length: 30 }, (_, i) =>
        createMockCodeElement({
          id: `abc123:function:src/f${i}.ts:func${i}`,
          name: `func${i}`,
          filePath: `src/f${i}.ts`,
          startLine: 1,
          endLine: 10,
        }),
      );

      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue(manyElements.slice(0, 5)),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'func', limit: 5 },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeLessThanOrEqual(5);
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
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:function:src/shared.ts:shared1',
            name: 'shared1',
            filePath: 'src/shared.ts',
            startLine: 10,
            endLine: 20,
          }),
          createMockCodeElement({
            id: 'xyz789:function:src/shared.ts:shared2',
            name: 'shared2',
            filePath: 'src/shared.ts',
            startLine: 30,
            endLine: 40,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'shared' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(result.metadata.scope.crossRepoEnabled).toBe(true);
    });

    it('should search across all specified repos', async () => {
      const multiRepoScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['repo1', 'repo2', 'repo3'],
        repoHashes: ['hash1', 'hash2', 'hash3'],
        crossRepoEnabled: true,
      };

      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'hash1:class:src/common.ts:Common',
            name: 'Common',
            type: 'class',
            filePath: 'src/common.ts',
            startLine: 1,
            endLine: 50,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'Common' },
        multiRepoScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.metadata.scope.repoHashes.length).toBe(3);
    });
  });

  // ===========================================================================
  // Metadata Tests
  // ===========================================================================

  describe('Response Metadata', () => {
    it('should include scope context in metadata', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'test' },
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
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'test' },
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
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const summaryResult = await handleSearchSymbols(
        { query: 'test' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(summaryResult.metadata.format).toBe('summary');

      const rawResult = await handleSearchSymbols(
        { query: 'test' },
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
  // Entrypoint-Specific Tests
  // ===========================================================================

  describe('Entrypoint Search', () => {
    it('should search entrypoints by fullPath', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entrypoint:http:GET:/api/users',
            name: 'GET /api/users',
            type: 'entrypoint',
            filePath: 'src/routes.ts',
            startLine: 10,
            endLine: 15,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'GET /api/users', type: 'entrypoint' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements[0].name).toBe('GET /api/users');
    });

    it('should search entrypoints by partial path', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entrypoint:http:POST:/api/users',
            name: 'POST /api/users',
            type: 'entrypoint',
            filePath: 'src/routes.ts',
            startLine: 20,
            endLine: 25,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: '/api', type: 'entrypoint' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
    });

    it('should handle entrypoints with fieldName', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entrypoint:graphql:getUser',
            name: 'Query.getUser',
            type: 'entrypoint',
            filePath: 'src/graphql/resolvers.ts',
            startLine: 5,
            endLine: 10,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'getUser', type: 'entrypoint' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements[0].name).toBe('Query.getUser');
    });

    it('should handle entrypoints without name property', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'abc123:entrypoint:http:GET:/health',
            name: 'GET /health',
            type: 'entrypoint',
            filePath: 'src/routes.ts',
            startLine: 1,
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'health', type: 'entrypoint' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBeGreaterThan(0);
      expect(elements[0].name).toBe('GET /health');
    });
  });

  describe('HTTP Path Search via external_calls', () => {
    // Regression test for the 2026-05-12 eval gap: agents passing an HTTP
    // path as `query` got 0 matches because findCode only searches symbol
    // names. Now path-like queries also scan external_calls and return the
    // caller functions that issue the matching HTTP call.
    it('returns the caller function for an HTTP path query', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec1',
            callerId: 'ui:fn:templates.service.ts:analyzeApplyTemplate',
            callerName: 'analyzeApplyTemplate',
            callerFilePath: 'src/components/Shifts/api/services/templates.service.ts',
            serviceName: 'server-api',
            method: 'request',
            protocol: 'http',
            httpMethod: 'POST',
            pathTemplate:
              '/shifts/companies/{companyUuid}/planning_spaces/{planningSpaceUuid}/templates/apply-from-source/analyze-conflicts',
            filePath: 'src/components/Shifts/api/services/templates.service.ts',
            startLine: 62,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        {
          query:
            '/shifts/companies/{companyUuid}/planning_spaces/{planningSpaceUuid}/templates/apply-from-source/analyze-conflicts',
        },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBe(1);
      expect(elements[0].name).toBe('analyzeApplyTemplate');
      expect(elements[0].summary).toContain('analyze-conflicts');
    });

    it('matches across placeholder-name drift', async () => {
      // Agent typed `{thingId}` (camelCase); parser indexed `{thing_id}`.
      // Normalization replaces both with `{}` so the substring check succeeds.
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn().mockResolvedValue([
          {
            id: 'ec',
            callerId: 'fn',
            callerName: 'getThing',
            callerFilePath: 'src/foo.ts',
            serviceName: 'svc',
            method: 'request',
            protocol: 'http',
            httpMethod: 'GET',
            pathTemplate: '/things/{thing_id}',
            filePath: 'src/foo.ts',
            startLine: 1,
          },
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'GET /things/{thingId}' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements.length).toBe(1);
      expect(elements[0].name).toBe('getThing');
    });

    it('skips the external_call scan when query is a bare symbol name', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
        getExternalCalls: vi.fn(),
      });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'analyzeConflicts' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      // Bare name → no external_call scan, so getExternalCalls stays untouched.
      expect(mockRepo.getExternalCalls).not.toHaveBeenCalled();
    });
  });

  describe('Forgiving query matching', () => {
    it('wraps a bare-word query in wildcards (substring match)', async () => {
      // Regression for the 2026-05-13 eval: agent queried
      // `AnalyzeApplyTemplateDto` (partial guess) and got 0 results despite
      // the graph having `AnalyzeApplyTemplateRequestDto`. With substring
      // matching, the partial query now finds related symbols.
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'AnalyzeApply' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      // The pattern passed to findCode is wrapped in `*…*` — findCode will
      // translate to SQL %…%.
      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ pattern: '*AnalyzeApply*' }), expect.anything());
    });

    it('passes wildcard queries through unchanged', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      await handleSearchSymbols(
        { query: 'find*' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'find*' }), expect.anything());
    });

    it('tokenizes multi-word queries and AND-filters across tokens', async () => {
      // Agent types `analyzeConflicts apply template` — three concepts. The
      // longest token (`analyzeConflicts`) drives the broad DB lookup; rows
      // are then filtered to keep only those whose name contains every token.
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({ id: 'a', name: 'analyzeConflicts', type: 'function', filePath: 'a.ts' }),
        createMockCodeElement({
          id: 'b',
          name: 'analyzeConflictsForApplyTemplate',
          type: 'function',
          filePath: 'b.ts',
        }),
        createMockCodeElement({ id: 'c', name: 'analyzeConflictsLegacy', type: 'function', filePath: 'c.ts' }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'analyzeConflicts apply template' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      // Longest token = "analyzeConflicts" → DB query uses `*analyzeConflicts*`
      expect(findCode).toHaveBeenCalledWith(
        expect.objectContaining({ pattern: '*analyzeConflicts*' }),
        expect.anything(),
      );
      // Post-filter keeps only the row containing ALL three tokens.
      const elements = result.data as CodeElementInfo[];
      const names = elements.map((e) => e.name);
      expect(names).toContain('analyzeConflictsForApplyTemplate');
      expect(names).not.toContain('analyzeConflicts');
      expect(names).not.toContain('analyzeConflictsLegacy');
    });

    it('still ranks exact matches first', async () => {
      const findCode = vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ id: 'a', name: 'BookingServiceMock', type: 'class', filePath: 'a.ts' }),
          createMockCodeElement({ id: 'b', name: 'BookingService', type: 'class', filePath: 'b.ts' }),
          createMockCodeElement({ id: 'c', name: 'BookingServiceFactory', type: 'class', filePath: 'c.ts' }),
        ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'BookingService' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      // Exact-name match must sort to position 0
      expect(elements[0].name).toBe('BookingService');
    });
  });

  // ===========================================================================
  // Resolver Mode (exact + path)
  // ===========================================================================

  describe('Resolver mode (exact + path)', () => {
    it('drops substring near-misses when exact=true', async () => {
      const findCode = vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ id: 'a', name: 'createTemplate', type: 'function', filePath: 'a.ts' }),
          createMockCodeElement({ id: 'b', name: 'createTemplateFromSource', type: 'function', filePath: 'b.ts' }),
          createMockCodeElement({ id: 'c', name: 'createTemplateDto', type: 'class', filePath: 'c.ts' }),
        ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'createTemplate', exact: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0].name).toBe('createTemplate');
    });

    it('exact match is case-insensitive', async () => {
      const findCode = vi
        .fn()
        .mockResolvedValue([createMockCodeElement({ id: 'a', name: 'UserService', type: 'class', filePath: 'a.ts' })]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'userservice', exact: true },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0].name).toBe('UserService');
    });

    it('disambiguates a collision-heavy name by path (exact + suffix)', async () => {
      const findCode = vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'a',
          name: 'createTemplate',
          type: 'function',
          filePath: 'src/modules/templates/templates.service.ts',
        }),
        createMockCodeElement({
          id: 'b',
          name: 'createTemplate',
          type: 'function',
          filePath: 'src/legacy/templates.service.ts',
        }),
      ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'createTemplate', exact: true, path: 'modules/templates/templates.service.ts' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0].filePath).toBe('src/modules/templates/templates.service.ts');
    });

    it('path matches a full file path exactly', async () => {
      const findCode = vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ id: 'a', name: 'foo', type: 'function', filePath: 'src/a/foo.ts' }),
          createMockCodeElement({ id: 'b', name: 'foo', type: 'function', filePath: 'src/b/foo.ts' }),
        ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'foo', path: 'src/a/foo.ts' },
        mockScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(1);
      expect(elements[0].filePath).toBe('src/a/foo.ts');
    });

    it('emits a corrective hint when narrowing zeroes out a non-empty match set', async () => {
      const findCode = vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ id: 'a', name: 'createTemplate', type: 'function', filePath: 'src/a/foo.ts' }),
        ]);
      const mockRepo = createMockRepository({ findCode });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'createTemplate', exact: true, path: 'does/not/exist.ts' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      // Summary mock embeds the title; the hint must point at the looser match.
      expect(result.data).toContain('no match after');
      expect(result.data).toContain('createTemplate (src/a/foo.ts)');
      // The corrective hint is the message; the redundant "(showing 0 of 0)"
      // count suffix must not tag along.
      expect(result.data).not.toContain('showing 0 of 0');
    });
  });

  // ===========================================================================
  // Vantage Ranking Tests
  // ===========================================================================

  describe('Vantage ranking', () => {
    it('ranks the current (vantage) repo first among equally-relevant matches', async () => {
      // Same symbol exists in two repos within a project-wide scope. The vantage
      // (COREDOC_CURRENT_REPO) is web-app, so its match must surface first
      // even though the DB returned the api-server row first.
      const vantageScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['api-server', 'web-app'],
        repoHashes: ['hashcore', 'hashshifts'],
        project: 'acme',
        crossRepoEnabled: true,
        currentRepo: 'web-app',
        currentRepoHash: 'hashshifts',
      };
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'hashcore:function:src/core.ts:computeShift',
            name: 'computeShift',
            filePath: 'src/core.ts',
          }),
          createMockCodeElement({
            id: 'hashshifts:function:src/shifts.ts:computeShift',
            name: 'computeShift',
            filePath: 'src/shifts.ts',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'computeShift', type: 'function' },
        vantageScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      expect(elements).toHaveLength(2);
      expect(elements[0].id).toBe('hashshifts:function:src/shifts.ts:computeShift');
      expect(elements[1].id).toBe('hashcore:function:src/core.ts:computeShift');
    });

    it('preserves relevance ordering when no vantage is set (unchanged behavior)', async () => {
      const noVantageScope: ScopeContext = {
        currentPath: '/test/workspace',
        resolvedRepos: ['api-server', 'web-app'],
        repoHashes: ['hashcore', 'hashshifts'],
        project: 'acme',
        crossRepoEnabled: true,
      };
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([
          createMockCodeElement({
            id: 'hashcore:function:src/core.ts:computeShift',
            name: 'computeShift',
            filePath: 'src/core.ts',
          }),
          createMockCodeElement({
            id: 'hashshifts:function:src/shifts.ts:computeShift',
            name: 'computeShift',
            filePath: 'src/shifts.ts',
          }),
        ]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'computeShift', type: 'function' },
        noVantageScope,
        'raw',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const elements = result.data as CodeElementInfo[];
      // Both exact, same name → stable sort keeps the DB order (core first).
      expect(elements[0].id).toBe('hashcore:function:src/core.ts:computeShift');
    });
  });

  describe('multi-word misses', () => {
    it('returns no noisy any-word matches and explains how to retry', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn(({ pattern }: { pattern: string }) => {
          if (pattern === '*Foo*')
            return Promise.resolve([createMockCodeElement({ id: 'h:function:a:FooThing', name: 'FooThing' })]);
          if (pattern === '*Bar*')
            return Promise.resolve([createMockCodeElement({ id: 'h:function:b:BarThing', name: 'BarThing' })]);
          return Promise.resolve([]);
        }),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'Foo Bar' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(mockRepo.findCode).not.toHaveBeenCalledWith(
        expect.objectContaining({ pattern: '*Bar*' }),
        mockScope.repoHashes,
      );
      const text = result.data as string;
      expect(text).toContain('no declared symbol contains all words');
      expect(text).toContain('search one symbol-name concept at a time');
      expect(text).not.toContain('FooThing');
      expect(text).not.toContain('BarThing');
    });

    it('does not flag OR-fallback when the AND match succeeds', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([createMockCodeElement({ id: 'h:function:a:FooBar', name: 'FooBar' })]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'Foo Bar' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const text = result.data as string;
      expect(text).not.toContain('any-word (OR) matches');
      // Only the single AND query ran — no per-word fallback.
      expect(mockRepo.findCode).toHaveBeenCalledTimes(1);
    });
  });

  // A service-scoped search for a type imported from a shared package is a
  // legitimate miss — but an agent reads the bare zero as "this symbol does not
  // exist" and starts writing it from scratch. The repos that DO declare it are
  // one query away.
  describe('symbol declared outside the scope', () => {
    const OTHER = 'def456abc789';

    function repositoryWithOutOfScopeMatch(overrides?: Parameters<typeof createMockRepository>[0]) {
      return createMockRepository({
        findCode: vi.fn(async (_params: unknown, repoHashes: string[]) =>
          repoHashes.length === 0
            ? [
                createMockCodeElement({
                  id: `${OTHER}:enum:packages/api-client/src/types.ts:PaidOvertTimePhasesTypes`,
                  name: 'PaidOvertTimePhasesTypes',
                  type: NodeType.Enum,
                }),
              ]
            : [],
        ),
        getRepositoryNames: vi.fn().mockResolvedValue([{ hash: OTHER, name: 'acme-packages' }]),
        ...overrides,
      });
    }

    it('names the repos that declare the symbol and how to reach them', async () => {
      const mockRepo = repositoryWithOutOfScopeMatch();
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'PaidOvertTimePhasesTypes' },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      const text = result.data as string;
      expect(text).toContain('0 in this scope');
      expect(text).toContain('acme-packages');
      expect(text).toContain('scope="acme-packages"');
    });

    it('does not probe when the scope is already the whole graph', async () => {
      const mockRepo = repositoryWithOutOfScopeMatch({
        findCode: vi.fn().mockResolvedValue([]),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'PaidOvertTimePhasesTypes' },
        { ...mockScope, repoHashes: [] },
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data as string).not.toContain('0 in this scope');
      expect(mockRepo.getRepositoryNames).not.toHaveBeenCalled();
    });

    // A cloud workspace scope enumerates the connected repos; rows outside it
    // must not be named, so the probe never runs there.
    it('never reports repos outside a workspace-resolved scope', async () => {
      const mockRepo = repositoryWithOutOfScopeMatch();
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'PaidOvertTimePhasesTypes' },
        { ...mockScope, origin: 'workspace' },
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data as string).not.toContain('acme-packages');
      expect(mockRepo.getRepositoryNames).not.toHaveBeenCalled();
    });

    it('respects exact=true when deciding what counts as declared elsewhere', async () => {
      const mockRepo = repositoryWithOutOfScopeMatch({
        findCode: vi.fn(async (_params: unknown, repoHashes: string[]) =>
          repoHashes.length === 0
            ? [
                createMockCodeElement({
                  id: `${OTHER}:enum:packages/api-client/src/types.ts:PaidOvertTimePhasesTypesLegacy`,
                  name: 'PaidOvertTimePhasesTypesLegacy',
                  type: NodeType.Enum,
                }),
              ]
            : [],
        ),
      });
      getRepository.mockResolvedValue(mockRepo);

      const result = await handleSearchSymbols(
        { query: 'PaidOvertTimePhasesTypes', exact: true },
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );

      expect(result.data as string).not.toContain('acme-packages');
    });
  });
});
