/**
 * Tests for MCP Server Implementation
 *
 * Note: These tests verify server configuration and tool registration.
 * Full end-to-end protocol tests require MCP transport setup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
// EventName / repoId resolve to the REAL implementations (the telemetry mock
// spreads importActual and only overrides `track` / `initTelemetry` /
// `newInvocationId`), so assertions use the same event vocabulary and repo-id
// derivation the server does.
import { EventName, repoId } from '@coredoc/core/telemetry';
import { createServer, isUnboundDiscoveryCall, startServer, summarizePriorSessions } from './server.js';

type ToolCallHandler = (request: unknown) => Promise<{
  isError?: boolean;
  content: Array<{ text: string }>;
}>;

function toolCallHandler(server: unknown): ToolCallHandler {
  const handlers = (server as { _requestHandlers: Map<string, ToolCallHandler> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('MCP server did not register tools/call');
  return handler;
}

// Hoist the recordQuery + telemetry mocks so they can be referenced inside
// vi.mock factories.
const {
  mockRecordQuery,
  mockTrack,
  mockGetTelemetryConfig,
  mockGetOperationSummary,
  mockComputeCommitsStale,
  mockInitTelemetry,
  mockNewInvocationId,
  mockListAllRepositories,
  mockClaimUnsummarizedSessionRollups,
  mockOpenProjectDatabase,
  mockGetConfiguredBackend,
} = vi.hoisted(() => ({
  mockRecordQuery: vi.fn().mockResolvedValue(undefined),
  mockTrack: vi.fn(),
  mockGetTelemetryConfig: vi.fn().mockResolvedValue({ installId: 'test-install-id' }),
  mockGetOperationSummary: vi.fn().mockResolvedValue(undefined),
  mockComputeCommitsStale: vi.fn().mockResolvedValue(null),
  // Only startServer uses these; spying lets the startServer test assert the
  // exact InitContext (surface + explicit session id + bundled channels).
  mockInitTelemetry: vi.fn(),
  mockNewInvocationId: vi.fn(() => 'mcp-session-sentinel'),
  mockListAllRepositories: vi.fn().mockResolvedValue([{ name: 'test-repo' }]),
  mockClaimUnsummarizedSessionRollups: vi.fn().mockResolvedValue([]),
  mockGetConfiguredBackend: vi.fn(() => 'sqlite' as 'sqlite' | 'neo4j' | 'ladybug'),
  mockOpenProjectDatabase: vi.fn(
    async (configDir: string, projectId: string, _options: { mode: 'read' | 'create' }) => ({
      projectId,
      url: `file:${configDir}/coredoc.db.d/${projectId}.db`,
      graph: { listAllRepositories: mockListAllRepositories },
      operations: { getOperationSummary: mockGetOperationSummary },
      metrics: {
        recordQuery: mockRecordQuery,
        claimUnsummarizedSessionRollups: mockClaimUnsummarizedSessionRollups,
      },
    }),
  ),
}));

// Mock dependencies
vi.mock('@coredoc/db', async () => {
  const actual = await vi.importActual<typeof import('@coredoc/db')>('@coredoc/db');
  return {
    ...actual,
    registerExitHandlers: vi.fn(),
    isDatabaseAvailable: vi.fn().mockResolvedValue(true),
    getConfiguredBackend: mockGetConfiguredBackend,
    openProjectDatabase: mockOpenProjectDatabase,
  };
});

// Spy on `track` (keep the real EventName / repoId) so mcp_first_answer emits
// are observable without any real transport. `initTelemetry` + `newInvocationId`
// are spied too so the startServer test can assert the MCP process inits with its
// OWN explicit session id (never the shared CLI session file) and the bundled
// anon channels — without running the real lazy client.
vi.mock('@coredoc/core/telemetry', async () => {
  const actual = await vi.importActual<typeof import('@coredoc/core/telemetry')>('@coredoc/core/telemetry');
  return { ...actual, track: mockTrack, initTelemetry: mockInitTelemetry, newInvocationId: mockNewInvocationId };
});

// Stub the git `rev-list` shell-out (computeCommitsStale) so mcp_first_answer's
// staleness is deterministic without touching real git; keep commitHashFromSummary real.
vi.mock('./commits-stale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commits-stale.js')>();
  return { ...actual, computeCommitsStale: mockComputeCommitsStale };
});

// Pin the install id so repo_id is deterministic (and no real ~/.coredoc read).
vi.mock('@coredoc/core/utils', async () => {
  const actual = await vi.importActual<typeof import('@coredoc/core/utils')>('@coredoc/core/utils');
  return { ...actual, getTelemetryConfig: mockGetTelemetryConfig };
});

vi.mock('./scope-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scope-resolver.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({
      configDir: '/ws',
      projects: [{ id: 'proj-1', name: 'Project One', repos: [{ name: 'test-repo' }] }],
    })),
    resolveScope: vi.fn((path: string, options?: { includeCrossRepo?: boolean }) => ({
      success: true,
      scope: {
        currentPath: path,
        configDir: '/ws',
        resolvedRepos: ['test-repo'],
        repoHashes: ['test-hash'],
        projectId: 'proj-1',
        crossRepoEnabled: options?.includeCrossRepo !== false,
        repoName: 'test-repo',
        repoPath: path,
        repoHash: 'test-hash',
        includeCrossRepo: options?.includeCrossRepo !== false,
      },
    })),
  };
});

// Mock all tool handlers
vi.mock('./tools/impact/analyze-change-impact.js', () => ({
  handleAnalyzeChangeImpact: vi.fn().mockResolvedValue({
    data: { message: 'analyze_change_impact result' },
  }),
}));

vi.mock('./tools/impact/find-callers.js', () => ({
  handleFindCallers: vi.fn().mockResolvedValue({
    data: { message: 'find_callers result' },
  }),
}));

vi.mock('./tools/impact/find-dependents.js', () => ({
  handleFindDependents: vi.fn().mockResolvedValue({
    data: { message: 'find_dependents result' },
  }),
}));

vi.mock('./tools/impact/find-entity-usage.js', () => ({
  handleFindEntityUsage: vi.fn().mockResolvedValue({
    data: { message: 'find_entity_usage result' },
  }),
}));

vi.mock('./tools/discovery/search-symbols.js', () => ({
  handleSearchSymbols: vi.fn().mockResolvedValue({
    data: { message: 'search_symbols result' },
  }),
}));

vi.mock('./tools/discovery/list-entrypoints.js', () => ({
  handleListEntrypoints: vi.fn().mockResolvedValue({
    data: { message: 'list_entrypoints result' },
  }),
}));

vi.mock('./tools/discovery/describe-repository.js', () => ({
  handleDescribeRepository: vi.fn().mockResolvedValue({
    data: { message: 'describe_repository result' },
  }),
}));

vi.mock('./tools/cross-repo/trace-cross-repo-call.js', () => ({
  handleTraceCrossRepoCall: vi.fn().mockResolvedValue({
    data: { message: 'trace_cross_repo_call result' },
  }),
}));

vi.mock('./tools/cross-repo/list-service-dependencies.js', () => ({
  handleListServiceDependencies: vi.fn().mockResolvedValue({
    data: { message: 'list_service_dependencies result' },
  }),
}));

vi.mock('./tools/discovery/semantic-search.js', () => ({
  handleSemanticSearch: vi.fn().mockResolvedValue({
    data: { message: 'semantic_search result' },
  }),
}));

vi.mock('./tools/intent/get-intent-context.js', () => ({
  handleGetIntentContext: vi.fn().mockResolvedValue({
    data: { message: 'get_intent_context result' },
  }),
}));

vi.mock('./tools/discovery/run-cypher-query.js', () => ({
  handleRunCypherQuery: vi.fn().mockResolvedValue({
    data: { message: 'run_cypher_query result' },
  }),
}));

describe('MCP Server', () => {
  const ORIGINAL_SQLITE_URL = process.env.COREDOC_SQLITE_URL;
  const ORIGINAL_SCOPE = process.env.COREDOC_SCOPE;
  const ORIGINAL_CONFIG_PATH = process.env.MCP_CONFIG_PATH;
  const ORIGINAL_METRICS_DISABLED = process.env.COREDOC_MCP_METRICS_DISABLED;

  beforeEach(() => {
    // A legacy URL pin must never participate in MCP routing. The mocked
    // resolver supplies the authoritative configDir + projectId pair.
    process.env.COREDOC_SQLITE_URL = 'file:/tmp/must-be-ignored.db';
    delete process.env.COREDOC_SCOPE;
    delete process.env.MCP_CONFIG_PATH;
    delete process.env.COREDOC_MCP_METRICS_DISABLED;
    mockOpenProjectDatabase.mockClear();
    mockGetConfiguredBackend.mockReturnValue('sqlite');
  });

  afterEach(() => {
    if (ORIGINAL_SQLITE_URL === undefined) delete process.env.COREDOC_SQLITE_URL;
    else process.env.COREDOC_SQLITE_URL = ORIGINAL_SQLITE_URL;
    if (ORIGINAL_SCOPE === undefined) delete process.env.COREDOC_SCOPE;
    else process.env.COREDOC_SCOPE = ORIGINAL_SCOPE;
    if (ORIGINAL_CONFIG_PATH === undefined) delete process.env.MCP_CONFIG_PATH;
    else process.env.MCP_CONFIG_PATH = ORIGINAL_CONFIG_PATH;
    if (ORIGINAL_METRICS_DISABLED === undefined) delete process.env.COREDOC_MCP_METRICS_DISABLED;
    else process.env.COREDOC_MCP_METRICS_DISABLED = ORIGINAL_METRICS_DISABLED;
  });

  describe('database binding', () => {
    it('refuses to answer when it cannot tell which project database to read', async () => {
      const { resolveScope } = await import('./scope-resolver.js');
      (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        success: true,
        scope: {
          currentPath: '/test/path',
          resolvedRepos: ['test-repo'],
          repoHashes: ['test-hash'],
          crossRepoEnabled: false,
        },
      });
      const server = createServer();
      const callHandler = toolCallHandler(server);
      const result = await callHandler({
        method: 'tools/call',
        params: { name: 'describe_repository', arguments: {} },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No project bound/);
      expect(mockOpenProjectDatabase).not.toHaveBeenCalled();
    });

    it('routes Ladybug through the project-owned read-only graph instead of the Neo4j singleton', async () => {
      mockGetConfiguredBackend.mockReturnValue('ladybug');
      const server = createServer();
      const callHandler = toolCallHandler(server);

      await callHandler({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'test', scope: '/test/path' } },
      });

      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/ws', 'proj-1', {
        mode: 'read',
        backend: 'ladybug',
      });
    });
  });

  describe('Server Creation', () => {
    it('should create server instance', () => {
      const server = createServer();
      expect(server).toBeDefined();
    });

    it('should have Server type', () => {
      const server = createServer();
      // Verify it's a Server instance by checking it has connect method
      expect(typeof (server as any).connect).toBe('function');
    });

    it('should have request handler registration capability', () => {
      const server = createServer();
      // Verify it has setRequestHandler method
      expect(typeof (server as any).setRequestHandler).toBe('function');
    });

    it('should register request handlers', () => {
      const server = createServer();
      const serverAny = server as any;

      expect(serverAny._requestHandlers).toBeDefined();
      expect(serverAny._requestHandlers.size).toBeGreaterThan(0);
    });
  });

  describe('Tool Registration', () => {
    const expectedTools = [
      // Impact Analysis (4 tools)
      'analyze_change_impact',
      'find_callers',
      'find_dependents',
      'find_entity_usage',
      // Understanding (1 tool — explain is the single router; explain_function /
      // explain_entrypoint / trace_execution_path / trace_data_flow were removed)
      'explain',
      // Discovery (3 tools)
      'search_symbols',
      'list_entrypoints',
      'describe_repository',
      // Cross-Repo (2 tools)
      'trace_cross_repo_call',
      'list_service_dependencies',
    ];

    it('should register all 10 tools', () => {
      expect(expectedTools).toHaveLength(10);
    });

    it('should include all impact analysis tools', () => {
      const impactTools = expectedTools.filter((t) =>
        ['analyze_change_impact', 'find_callers', 'find_dependents', 'find_entity_usage'].includes(t),
      );
      expect(impactTools).toHaveLength(4);
    });

    it('should include all understanding tools', () => {
      const understandingTools = expectedTools.filter((t) => ['explain'].includes(t));
      expect(understandingTools).toHaveLength(1);
    });

    it('should include all discovery tools', () => {
      const discoveryTools = expectedTools.filter((t) =>
        ['search_symbols', 'list_entrypoints', 'describe_repository'].includes(t),
      );
      expect(discoveryTools).toHaveLength(3);
    });

    it('should include all cross-repo tools', () => {
      const crossRepoTools = expectedTools.filter((t) =>
        ['trace_cross_repo_call', 'list_service_dependencies'].includes(t),
      );
      expect(crossRepoTools).toHaveLength(2);
    });
  });

  describe('Tool Handler Mapping', () => {
    it('should have handler for analyze_change_impact', async () => {
      const { handleAnalyzeChangeImpact } = await import('./tools/impact/analyze-change-impact.js');
      expect(handleAnalyzeChangeImpact).toBeDefined();
    });

    it('should have handler for find_callers', async () => {
      const { handleFindCallers } = await import('./tools/impact/find-callers.js');
      expect(handleFindCallers).toBeDefined();
    });

    it('should have handler for find_dependents', async () => {
      const { handleFindDependents } = await import('./tools/impact/find-dependents.js');
      expect(handleFindDependents).toBeDefined();
    });

    it('should have handler for find_entity_usage', async () => {
      const { handleFindEntityUsage } = await import('./tools/impact/find-entity-usage.js');
      expect(handleFindEntityUsage).toBeDefined();
    });

    it('should have handler for explain', async () => {
      const { handleExplain } = await import('./tools/understanding/explain.js');
      expect(handleExplain).toBeDefined();
    });

    it('should have handler for search_symbols', async () => {
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      expect(handleSearchSymbols).toBeDefined();
    });

    it('should have handler for list_entrypoints', async () => {
      const { handleListEntrypoints } = await import('./tools/discovery/list-entrypoints.js');
      expect(handleListEntrypoints).toBeDefined();
    });

    it('should have handler for describe_repository', async () => {
      const { handleDescribeRepository } = await import('./tools/discovery/describe-repository.js');
      expect(handleDescribeRepository).toBeDefined();
    });

    it('should have handler for trace_cross_repo_call', async () => {
      const { handleTraceCrossRepoCall } = await import('./tools/cross-repo/trace-cross-repo-call.js');
      expect(handleTraceCrossRepoCall).toBeDefined();
    });

    it('should have handler for list_service_dependencies', async () => {
      const { handleListServiceDependencies } = await import('./tools/cross-repo/list-service-dependencies.js');
      expect(handleListServiceDependencies).toBeDefined();
    });
  });

  describe('MCP Protocol Compliance', () => {
    it('advertises intent and graph reads as non-destructive read-only tools', async () => {
      const server = createServer() as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown) => Promise<{
            tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
          }>
        >;
      };
      const { tools } = await server._requestHandlers.get('tools/list')!({ method: 'tools/list', params: {} });
      for (const name of ['get_intent_context', 'find_callers', 'describe_repository', 'explain']) {
        expect(tools.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
    });

    it('should support ListToolsRequest', () => {
      const server = createServer();
      const serverAny = server as any;

      // Verify that tools/list handler is registered
      expect(serverAny._requestHandlers.has('tools/list')).toBe(true);
    });

    it('should support CallToolRequest', () => {
      const server = createServer();
      const serverAny = server as any;

      // Verify that tools/call handler is registered
      expect(serverAny._requestHandlers.has('tools/call')).toBe(true);
    });

    it('should have registered both required handlers', () => {
      const server = createServer();
      const serverAny = server as any;

      const hasListTools = serverAny._requestHandlers.has('tools/list');
      const hasCallTool = serverAny._requestHandlers.has('tools/call');

      expect(hasListTools && hasCallTool).toBe(true);
    });
  });

  describe('Scope Resolution', () => {
    it('should import resolveScope function', async () => {
      const { resolveScope } = await import('./scope-resolver.js');
      expect(resolveScope).toBeDefined();
      expect(typeof resolveScope).toBe('function');
    });

    it('should resolve scope with includeCrossRepo option', async () => {
      const { resolveScope } = await import('./scope-resolver.js');

      const result = resolveScope('/test/path', { includeCrossRepo: true });

      expect(result.success).toBe(true);
      expect(result.scope?.repoPath).toBe('/test/path');
      expect(result.scope?.includeCrossRepo).toBe(true);
    });

    it('should resolve scope without includeCrossRepo option', async () => {
      const { resolveScope } = await import('./scope-resolver.js');

      const result = resolveScope('/test/path', { includeCrossRepo: false });

      expect(result.success).toBe(true);
      expect(result.scope?.includeCrossRepo).toBe(false);
    });
  });

  describe('Tool Schema Validation', () => {
    it('emits file only on the search_symbols type filter', async () => {
      const server = createServer() as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown) => Promise<{
            tools: Array<{
              name: string;
              description: string;
              inputSchema: { properties: Record<string, unknown> };
            }>;
          }>
        >;
      };
      const listHandler = server._requestHandlers.get('tools/list');
      if (!listHandler) throw new Error('MCP server did not register tools/list');

      const { tools } = await listHandler({ method: 'tools/list', params: {} });
      const searchSymbols = tools.find((tool) => tool.name === 'search_symbols');
      const listFileSymbols = tools.find((tool) => tool.name === 'list_file_symbols');
      const searchTypes = searchSymbols?.inputSchema.properties.type as { enum?: string[] };
      const listTypes = listFileSymbols?.inputSchema.properties.type as { enum?: string[] };

      expect(searchTypes.enum).toContain('file');
      expect(searchSymbols?.description).toMatch(/type=file/);
      expect(listTypes.enum).not.toContain('file');
    });

    it('should have required properties for impact analysis tools', () => {
      const impactTools = ['analyze_change_impact', 'find_callers', 'find_dependents', 'find_entity_usage'];

      impactTools.forEach((toolName) => {
        // Tool exists in our expected list
        expect(impactTools).toContain(toolName);
      });
    });

    it('should have required properties for understanding tools', () => {
      const understandingTools = ['explain'];

      understandingTools.forEach((toolName) => {
        // Tool exists in our expected list
        expect(understandingTools).toContain(toolName);
      });
    });

    it('should have required properties for discovery tools', () => {
      const discoveryTools = ['search_symbols', 'list_entrypoints', 'describe_repository'];

      discoveryTools.forEach((toolName) => {
        // Tool exists in our expected list
        expect(discoveryTools).toContain(toolName);
      });
    });

    it('should have required properties for cross-repo tools', () => {
      const crossRepoTools = ['trace_cross_repo_call', 'list_service_dependencies'];

      crossRepoTools.forEach((toolName) => {
        // Tool exists in our expected list
        expect(crossRepoTools).toContain(toolName);
      });
    });
  });

  describe('Response Formatting', () => {
    it('preserves raw data and carries evidence metadata across the local transport', async () => {
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      const metadata = {
        staleness: { warning: 'Indexed snapshots', parsedAt: 'unknown' },
        warnings: ['A graph miss does not prove code absence.'],
      };
      vi.mocked(handleSearchSymbols).mockResolvedValueOnce({
        data: [],
        metadata: { ...metadata, scope: {} as never, format: 'raw' },
      });
      const response = await toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'ot_token', format: 'raw', scope: '/test/path' } },
      });
      expect(JSON.parse(response.content[0]!.text)).toEqual([]);
      expect(response.content[1]!.text).toBe(`Evidence metadata: ${JSON.stringify(metadata)}`);
    });

    it('should format string responses correctly', () => {
      const stringData = 'Simple string response';
      const formatted = typeof stringData === 'string' ? stringData : JSON.stringify(stringData, null, 2);

      expect(formatted).toBe('Simple string response');
    });

    it('should format object responses as JSON', () => {
      const objectData = { callers: ['func1', 'func2'], count: 2 };
      const formatted = typeof objectData === 'string' ? objectData : JSON.stringify(objectData, null, 2);
      const parsed = JSON.parse(formatted);

      expect(parsed).toEqual({ callers: ['func1', 'func2'], count: 2 });
    });

    // D8: `format: "raw"` was pretty-printed, so the "cheap" structured format
    // billed an indent + newline for every field of every row. Nothing parses
    // the whitespace.
    it('serializes a structured tool response compactly, not pretty-printed', async () => {
      const server = createServer();
      const callHandler = (server as any)._requestHandlers.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: { name: 'find_dependents', arguments: { name: 'BookingTypes', format: 'raw', scope: '/test/path' } },
      });

      const text = response.content[0].text as string;
      expect(JSON.parse(text)).toEqual({ message: 'find_dependents result' });
      expect(text).not.toContain('\n');
      expect(text).toBe(JSON.stringify({ message: 'find_dependents result' }));
    });
  });

  describe('Error Message Formatting', () => {
    it('should format unknown tool error', () => {
      const toolName = 'unknown_tool';
      const errorMessage = `Unknown tool: ${toolName}`;

      expect(errorMessage).toContain('Unknown tool');
      expect(errorMessage).toContain('unknown_tool');
    });

    it('should format scope resolution error', () => {
      const error = 'Repo not found';
      const errorMessage = `Scope resolution failed: ${error}`;

      expect(errorMessage).toContain('Scope resolution failed');
      expect(errorMessage).toContain('Repo not found');
    });

    it('should format tool execution error', () => {
      const error = new Error('Database connection failed');
      const errorMessage = `Tool execution failed: ${error.message}`;

      expect(errorMessage).toContain('Tool execution failed');
      expect(errorMessage).toContain('Database connection failed');
    });

    it('should handle non-Error exceptions', () => {
      const error = 'String error';
      const errorMessage = `Tool execution failed: ${String(error)}`;

      expect(errorMessage).toContain('String error');
    });
  });

  describe('Default Values', () => {
    it('should use process.cwd() when scope not provided', () => {
      const defaultScope = process.cwd();
      expect(defaultScope).toBeDefined();
      expect(typeof defaultScope).toBe('string');
    });

    it('should default format to summary', () => {
      const format = 'summary';
      const defaultFormat = format || 'summary';

      expect(defaultFormat).toBe('summary');
    });

    it('should default includeCrossRepo to true', () => {
      const includeCrossRepo = true;
      const defaultIncludeCrossRepo = includeCrossRepo !== false;

      expect(defaultIncludeCrossRepo).toBe(true);
    });
  });

  describe('Metrics Recording', () => {
    beforeEach(() => {
      mockRecordQuery.mockClear();
    });

    it('routes each call from its resolved config directory and project id', async () => {
      const { resolveScope } = await import('./scope-resolver.js');
      const scoped = (configDir: string, projectId: string) => ({
        success: true,
        scope: {
          currentPath: `${configDir}/${projectId}`,
          configDir,
          resolvedRepos: ['test-repo'],
          repoHashes: ['test-hash'],
          projectId,
          crossRepoEnabled: true,
        },
      });
      (resolveScope as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(scoped('/workspaces/a', 'proj-a'))
        .mockReturnValueOnce(scoped('/workspaces/b', 'proj-b'));

      const server = createServer();
      const callHandler = (server as any)._requestHandlers.get('tools/call');
      const call = () =>
        callHandler({
          method: 'tools/call',
          params: { name: 'search_symbols', arguments: { query: 'q', scope: '/test/path' } },
        });

      await call();
      await call();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/workspaces/a', 'proj-a', { mode: 'read' });
      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/workspaces/b', 'proj-b', { mode: 'read' });
    });

    it('ignores COREDOC_SQLITE_URL when opening the scoped project database', async () => {
      const server = createServer();
      const callHandler = (server as any)._requestHandlers.get('tools/call');
      process.env.COREDOC_SQLITE_URL = 'file:/tmp/wrong-project.db';

      await callHandler({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'q', scope: '/test/path' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockOpenProjectDatabase).toHaveBeenCalled();
      expect(
        mockOpenProjectDatabase.mock.calls.every(
          ([configDir, projectId]) => configDir === '/ws' && projectId === 'proj-1',
        ),
      ).toBe(true);
      expect(mockOpenProjectDatabase.mock.calls.flat()).not.toContain('file:/tmp/wrong-project.db');
    });

    it('should record a metric after a successful tool call', async () => {
      const server = createServer();
      const serverAny = server as any;

      // Invoke the tools/call handler directly
      const callHandler = serverAny._requestHandlers.get('tools/call');
      expect(callHandler).toBeDefined();

      await callHandler({
        method: 'tools/call',
        params: {
          name: 'search_symbols',
          arguments: { query: 'test', scope: '/test/path' },
        },
      });

      // Wait for non-blocking metrics promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRecordQuery).toHaveBeenCalledOnce();
      expect(mockRecordQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'search_symbols',
          success: true,
          durationMs: expect.any(Number),
        }),
      );
    });

    it('should record a failure metric when the tool handler throws', async () => {
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      (handleSearchSymbols as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

      const server = createServer();
      const serverAny = server as any;

      const callHandler = serverAny._requestHandlers.get('tools/call');
      await callHandler({
        method: 'tools/call',
        params: {
          name: 'search_symbols',
          arguments: { query: 'test', scope: '/test/path' },
        },
      });

      // Wait for non-blocking metrics promise to settle
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRecordQuery).toHaveBeenCalledOnce();
      expect(mockRecordQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'search_symbols',
          success: false,
          durationMs: expect.any(Number),
        }),
      );
    });

    it('does not open or write query metrics after a successful call when explicitly disabled', async () => {
      process.env.COREDOC_MCP_METRICS_DISABLED = '1';
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      (handleSearchSymbols as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { message: 'empty but successful' },
        resultCount: 0,
      });
      mockOpenProjectDatabase.mockClear();
      const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>);
      const callHandler = toolCallHandler(server);

      await callHandler({
        method: 'tools/call',
        params: {
          name: 'search_symbols',
          arguments: { query: 'test', scope: '/test/path' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRecordQuery).not.toHaveBeenCalled();
      expect(mockOpenProjectDatabase).not.toHaveBeenCalled();
    });

    it('does not open or write query metrics after a failed call when explicitly disabled', async () => {
      process.env.COREDOC_MCP_METRICS_DISABLED = '1';
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      (handleSearchSymbols as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
      mockOpenProjectDatabase.mockClear();
      const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>);
      const callHandler = toolCallHandler(server);

      await callHandler({
        method: 'tools/call',
        params: {
          name: 'search_symbols',
          arguments: { query: 'test', scope: '/test/path' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRecordQuery).not.toHaveBeenCalled();
      expect(mockOpenProjectDatabase).not.toHaveBeenCalled();
    });

    it('stamps the process session id on every recorded query (groups rows into a session)', async () => {
      const server = createServer(undefined, 'session-xyz');
      const callHandler = (server as any)._requestHandlers.get('tools/call');

      await callHandler({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'test', scope: '/test/path' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockRecordQuery).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-xyz' }));
    });
  });

  // mcp_session_summary — the durable next-start rollup: at each start the server
  // aggregates every un-summarized PRIOR session into one summary event and marks
  // it done. summarizePriorSessions is the unit-testable core (fake repo + spied
  // track), independent of the DB/git wiring around it.
  describe('mcp_session_summary rollup', () => {
    beforeEach(() => {
      mockTrack.mockClear();
    });

    // The repo CLAIMS (aggregate + mark, atomically) and returns the rollups; the
    // server emits one event per returned rollup. Mark-before-emit lives in the
    // repo now, so the fake just returns what a claim would.
    function fakeMetrics(rollups: unknown[]) {
      return {
        claimUnsummarizedSessionRollups: vi.fn().mockResolvedValue(rollups),
      };
    }

    it('emits one summary per claimed session', async () => {
      const rollups = [
        { sessionId: 's1', toolCalls: 5, distinctTools: 3, errorCount: 1, totalDurationMs: 500, avgDurationMs: 100 },
        { sessionId: 's2', toolCalls: 2, distinctTools: 2, errorCount: 0, totalDurationMs: 200, avgDurationMs: 100 },
      ];
      const metrics = fakeMetrics(rollups);

      await summarizePriorSessions(metrics as any, 'current-session');

      const summaryCalls = mockTrack.mock.calls.filter((c) => c[0] === EventName.McpSessionSummary);
      expect(summaryCalls).toHaveLength(2);
      expect(summaryCalls[0][1]).toEqual({
        tool_calls: 5,
        distinct_tools: 3,
        error_count: 1,
        duration_ms_total: 500,
        duration_ms_avg: 100,
      });
      // The in-flight session is excluded from the atomic claim (which marks the
      // claimed sessions in the same transaction, so they never re-emit).
      expect(metrics.claimUnsummarizedSessionRollups).toHaveBeenCalledWith({ excludeSessionId: 'current-session' });
    });

    // Staleness is repo-grained, but a summarized session can span repos, so the
    // summary event must NEVER carry commits_stale — it rides on mcp_first_answer.
    it('never attaches commits_stale (wrong grain for a multi-repo session)', async () => {
      const metrics = fakeMetrics([
        { sessionId: 's1', toolCalls: 1, distinctTools: 1, errorCount: 0, totalDurationMs: 10, avgDurationMs: 10 },
      ]);

      await summarizePriorSessions(metrics as any, undefined);

      const props = mockTrack.mock.calls.find((c) => c[0] === EventName.McpSessionSummary)?.[1] as Record<
        string,
        unknown
      >;
      expect(props).toBeDefined();
      expect(props).not.toHaveProperty('commits_stale');
    });

    it('emits nothing when the claim returns no sessions', async () => {
      const metrics = fakeMetrics([]);

      await summarizePriorSessions(metrics as any, 'current-session');

      expect(mockTrack).not.toHaveBeenCalled();
      expect(metrics.claimUnsummarizedSessionRollups).toHaveBeenCalledWith({ excludeSessionId: 'current-session' });
    });
  });

  // mcp_first_answer — the activation milestone: the FIRST non-empty answer the
  // server returned for a given repo. Net-new telemetry, independent of the
  // per-call recordQuery metrics. Deduped once per repo per process.
  describe('mcp_first_answer telemetry', () => {
    beforeEach(() => {
      mockTrack.mockClear();
      mockGetTelemetryConfig.mockClear();
      mockGetOperationSummary.mockClear();
      // Default: staleness unknown (null) unless a test sets it. The scope in the
      // `call` helper carries no projectId, so resolveRepoCommitsStale short-circuits
      // before this mock is even reached in those cases.
      mockComputeCommitsStale.mockReset().mockResolvedValue(null);
    });

    async function call(currentPath: string, resultCount?: number) {
      const { resolveScope } = await import('./scope-resolver.js');
      (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        success: true,
        scope: {
          currentPath,
          configDir: '/ws',
          resolvedRepos: ['test-repo'],
          repoHashes: ['test-hash'],
          projectId: 'proj-1',
          crossRepoEnabled: true,
        },
      });
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      (handleSearchSymbols as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { message: 'ok' },
        ...(resultCount !== undefined ? { resultCount } : {}),
      });
      const server = createServer();
      const callHandler = (server as any)._requestHandlers.get('tools/call');
      await callHandler({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'test', scope: currentPath } },
      });
      // Let the fire-and-forget getTelemetryConfig().then(track) chain settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it('emits mcp_first_answer once on the first non-empty answer for a repo', async () => {
      await call('/repo/alpha', 3);

      const firstAnswerCalls = mockTrack.mock.calls.filter((c) => c[0] === EventName.McpFirstAnswer);
      expect(firstAnswerCalls).toHaveLength(1);
      expect(firstAnswerCalls[0][1]).toEqual({ repo_id: repoId('test-install-id', '/repo/alpha') });
    });

    it('treats a null resultCount (single-entity hit) as an answer', async () => {
      // No resultCount + no isError ⇒ server maps to null ⇒ still a real answer.
      await call('/repo/single');

      const firstAnswerCalls = mockTrack.mock.calls.filter((c) => c[0] === EventName.McpFirstAnswer);
      expect(firstAnswerCalls).toHaveLength(1);
    });

    it('does NOT emit when the answer is empty (resultCount === 0)', async () => {
      await call('/repo/empty', 0);

      const firstAnswerCalls = mockTrack.mock.calls.filter((c) => c[0] === EventName.McpFirstAnswer);
      expect(firstAnswerCalls).toHaveLength(0);
    });

    it('dedupes: the same repo emits mcp_first_answer only once across calls', async () => {
      await call('/repo/dedup', 2);
      await call('/repo/dedup', 5);

      const firstAnswerCalls = mockTrack.mock.calls.filter((c) => c[0] === EventName.McpFirstAnswer);
      expect(firstAnswerCalls).toHaveLength(1);
    });

    it('emits separately for distinct repos', async () => {
      await call('/repo/one', 1);
      await call('/repo/two', 1);

      const emittedRepoIds = mockTrack.mock.calls
        .filter((c) => c[0] === EventName.McpFirstAnswer)
        .map((c) => (c[1] as { repo_id: string }).repo_id);
      expect(emittedRepoIds).toEqual([repoId('test-install-id', '/repo/one'), repoId('test-install-id', '/repo/two')]);
    });

    // commits_stale rides on this repo-scoped event (correct grain) — when the
    // resolved scope has a projectId, staleness is looked up for THAT repo and
    // attached. The existing tests above (scope without projectId) prove the
    // omission path: resolveRepoCommitsStale short-circuits to null.
    it('attaches commits_stale for the answered repo when it is known', async () => {
      mockComputeCommitsStale.mockResolvedValueOnce(7);
      mockGetOperationSummary.mockResolvedValueOnce({
        projectId: 'proj-1',
        repoName: 'test-repo',
        lastParsed: {
          id: 'op1',
          projectId: 'proj-1',
          repoName: 'test-repo',
          operation: 'parse',
          status: 'completed',
          startedAt: 0,
          metadata: { gitCommitHash: 'abc123' },
        },
      });
      const { resolveScope } = await import('./scope-resolver.js');
      (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        success: true,
        scope: {
          currentPath: '/repo/stale',
          configDir: '/ws',
          resolvedRepos: ['test-repo'],
          repoHashes: ['test-hash'],
          projectId: 'proj-1',
          crossRepoEnabled: true,
        },
      });
      const { handleSearchSymbols } = await import('./tools/discovery/search-symbols.js');
      (handleSearchSymbols as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { message: 'ok' },
        resultCount: 3,
      });
      const server = createServer();
      const callHandler = (server as any)._requestHandlers.get('tools/call');
      await callHandler({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'test', scope: '/repo/stale' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const firstAnswer = mockTrack.mock.calls.find((c) => c[0] === EventName.McpFirstAnswer);
      expect(firstAnswer?.[1]).toEqual({ repo_id: repoId('test-install-id', '/repo/stale'), commits_stale: 7 });
      // The staleness lookup used the answered repo, not process.cwd().
      expect(mockGetOperationSummary).toHaveBeenCalledWith('proj-1', 'test-repo');
      expect(mockComputeCommitsStale).toHaveBeenCalledWith('/repo/stale', 'abc123');
    });
  });

  // startServer telemetry wiring (F4 + F5): the MCP process must (a) mint its OWN
  // session id and pass it EXPLICITLY — the client prefers ctx.sessionId over
  // resolveSession(), so MCP never slides into the shared ~/.coredoc/session.json
  // CLI file and collides with a parallel `coredoc` command — and (b) pass the
  // build-time bundled anon channels so a standalone MCP install actually ships
  // its P3 events instead of being dark. connect() is stubbed so no real stdio
  // transport is touched.
  describe('startServer telemetry init', () => {
    const validConfigPath = new URL('../package.json', import.meta.url).pathname;

    function removeAddedBeforeExitListeners(beforeListeners: NodeJS.BeforeExitListener[]): void {
      for (const listener of process.listeners('beforeExit')) {
        if (!beforeListeners.includes(listener)) process.removeListener('beforeExit', listener);
      }
    }

    it('rejects startup without an exact project-id binding', async () => {
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:Project One';
      const beforeListeners = process.listeners('beforeExit');

      try {
        await expect(startServer()).rejects.toThrow(/id must exist exactly/);
      } finally {
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(mockOpenProjectDatabase).not.toHaveBeenCalled();
    });

    it('rejects startup when the exact project id is duplicated', async () => {
      const { loadConfig } = await import('./scope-resolver.js');
      vi.mocked(loadConfig).mockReturnValueOnce({
        configDir: '/ws',
        projects: [
          { id: 'proj-1', name: 'First', repos: [{ name: 'api' }] },
          { id: 'proj-1', name: 'Second', repos: [{ name: 'web' }] },
        ],
      });
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      const beforeListeners = process.listeners('beforeExit');

      try {
        await expect(startServer()).rejects.toThrow(/id must exist exactly/);
      } finally {
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(mockOpenProjectDatabase).not.toHaveBeenCalled();
    });

    it('starts degraded when the bound project graph is empty, keeping graph-optional tools reachable', async () => {
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      mockListAllRepositories.mockResolvedValueOnce([]);
      const connectSpy = vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const beforeListeners = process.listeners('beforeExit');

      let stderrText = '';
      try {
        await startServer();
      } finally {
        stderrText = errorSpy.mock.calls.flat().join('\n');
        connectSpy.mockRestore();
        errorSpy.mockRestore();
        removeAddedBeforeExitListeners(beforeListeners);
      }

      // The old gate rejected here — resolving without a throw IS the regression proof.
      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/ws', 'proj-1', { mode: 'read' });
      expect(stderrText).toMatch(/No graph data for project "proj-1"/);
    });

    it('starts degraded when the project database cannot be opened', async () => {
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      mockOpenProjectDatabase.mockRejectedValueOnce(new Error('no database file'));
      const connectSpy = vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const beforeListeners = process.listeners('beforeExit');

      let stderrText = '';
      try {
        await startServer();
      } finally {
        stderrText = errorSpy.mock.calls.flat().join('\n');
        connectSpy.mockRestore();
        errorSpy.mockRestore();
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(stderrText).toMatch(/graph unavailable/i);
    });

    it('opens the configured Ladybug project graph read-only before connecting stdio', async () => {
      mockGetConfiguredBackend.mockReturnValue('ladybug');
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      const connectSpy = vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
      const beforeListeners = process.listeners('beforeExit');

      try {
        await startServer();
      } finally {
        connectSpy.mockRestore();
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/ws', 'proj-1', {
        mode: 'read',
        backend: 'ladybug',
      });
    });

    it('skips the prior-session metrics rollup when explicitly disabled', async () => {
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      process.env.COREDOC_MCP_METRICS_DISABLED = '1';
      mockClaimUnsummarizedSessionRollups.mockClear();
      const connectSpy = vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
      const beforeListeners = process.listeners('beforeExit');

      try {
        await startServer();
      } finally {
        connectSpy.mockRestore();
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(mockClaimUnsummarizedSessionRollups).not.toHaveBeenCalled();
    });

    it('inits with surface=mcp, an EXPLICIT minted session id, and the bundled channels', async () => {
      mockInitTelemetry.mockClear();
      mockNewInvocationId.mockClear().mockReturnValue('mcp-session-sentinel');
      const connectSpy = vi.spyOn(Server.prototype, 'connect').mockResolvedValue(undefined);
      // Startup is fail-closed: it needs an exact project id and an existing
      // config path before it will connect stdio.
      const savedConfigPath = process.env.MCP_CONFIG_PATH;
      const savedScope = process.env.COREDOC_SCOPE;
      process.env.MCP_CONFIG_PATH = validConfigPath;
      process.env.COREDOC_SCOPE = 'project:proj-1';
      // startServer registers a `beforeExit` drain listener; snapshot so we can
      // drop the one it adds and not leak listeners across the suite.
      const beforeListeners = process.listeners('beforeExit');

      try {
        await startServer();
      } finally {
        connectSpy.mockRestore();
        if (savedConfigPath === undefined) delete process.env.MCP_CONFIG_PATH;
        else process.env.MCP_CONFIG_PATH = savedConfigPath;
        if (savedScope === undefined) delete process.env.COREDOC_SCOPE;
        else process.env.COREDOC_SCOPE = savedScope;
        removeAddedBeforeExitListeners(beforeListeners);
      }

      expect(mockInitTelemetry).toHaveBeenCalledTimes(1);
      expect(mockInitTelemetry).toHaveBeenCalledWith({
        surface: 'mcp',
        // The freshly-minted invocation id, passed EXPLICITLY — this is what wins
        // over resolveSession()'s file inside the client, so MCP keeps its own
        // session rather than the shared CLI one. Not undefined ⇒ not the file path.
        sessionId: 'mcp-session-sentinel',
        // Bundled anon key/host wired through (empty in dev/test ⇒ no-op, real in
        // release CI). `any(String)` so a baked-in key still satisfies the shape.
        channels: { posthogKey: expect.any(String), posthogHost: expect.any(String) },
      });
      expect(mockOpenProjectDatabase).toHaveBeenCalledWith('/ws', 'proj-1', { mode: 'read' });
    });
  });

  // SECURITY: describe_repository with no scope falls through to the all-repos
  // discovery list when scope resolution fails. That fall-through must be
  // gated on the server being UNBOUND. Under a COREDOC_SCOPE binding a
  // resolution failure means the boundary couldn't be applied, so we must fail
  // closed instead of leaking repository metadata across workspaces.
  describe('Scope boundary enforcement (fail-closed)', () => {
    describe('isUnboundDiscoveryCall', () => {
      it('allows fall-through for describe_repository with no scope when unbound (no env)', () => {
        expect(isUnboundDiscoveryCall('describe_repository', undefined, undefined)).toBe(true);
      });

      it('treats COREDOC_SCOPE=auto as unbound (it defers to cwd resolution)', () => {
        expect(isUnboundDiscoveryCall('describe_repository', undefined, 'auto')).toBe(true);
      });

      it('fails closed under a project binding — no all-repos leak on resolution failure', () => {
        expect(isUnboundDiscoveryCall('describe_repository', undefined, 'project:coredoc')).toBe(false);
      });

      it('fails closed under a pinned single-repo binding', () => {
        expect(isUnboundDiscoveryCall('describe_repository', undefined, 'server-api')).toBe(false);
      });

      it('does not treat an explicit scope arg as a discovery call (even when unbound)', () => {
        expect(isUnboundDiscoveryCall('describe_repository', 'server-api', undefined)).toBe(false);
      });

      // An explicit project token is a REQUEST for one project's repo list. If it
      // does not resolve, answering with the all-repos discovery list would silently
      // describe a different set than the one asked for.
      it('does not let an explicit project scope fall through to the all-repos list', () => {
        expect(isUnboundDiscoveryCall('describe_repository', 'project:coredoc', undefined)).toBe(false);
      });

      it('treats an empty-string scope arg as no scope', () => {
        expect(isUnboundDiscoveryCall('describe_repository', '', undefined)).toBe(true);
      });

      it('allows only destination-mode cross-repo trace to widen when unbound', () => {
        expect(isUnboundDiscoveryCall('trace_cross_repo_call', undefined, undefined, 'user-events')).toBe(true);
        expect(isUnboundDiscoveryCall('trace_cross_repo_call', undefined, undefined)).toBe(false);
        // Still fail-closed when COREDOC_SCOPE declares a binding.
        expect(isUnboundDiscoveryCall('trace_cross_repo_call', undefined, 'project:coredoc', 'user-events')).toBe(
          false,
        );
        expect(isUnboundDiscoveryCall('trace_cross_repo_call', 'server-api', undefined, 'user-events')).toBe(false);
      });

      it('only discovery tools may fall through — other tools always fail closed', () => {
        expect(isUnboundDiscoveryCall('search_symbols', undefined, undefined)).toBe(false);
        expect(isUnboundDiscoveryCall('list_entrypoints', undefined, 'project:coredoc')).toBe(false);
      });
    });

    // End-to-end through the real tools/call wiring: a FAILED resolution under
    // a binding must short-circuit with an error and never reach the handler.
    describe('tools/call dispatch', () => {
      const ORIGINAL_SCOPE = process.env.COREDOC_SCOPE;

      afterEach(() => {
        if (ORIGINAL_SCOPE === undefined) delete process.env.COREDOC_SCOPE;
        else process.env.COREDOC_SCOPE = ORIGINAL_SCOPE;
        vi.clearAllMocks();
      });

      async function callDescribeRepositoryNoScope() {
        // Injecting a repository keeps this test focused on resolution
        // fall-through; the local SQLite startup path itself is always bound.
        const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>);
        const callHandler = (server as any)._requestHandlers.get('tools/call');
        return callHandler({
          method: 'tools/call',
          params: { name: 'describe_repository', arguments: {} },
        });
      }

      it('fails closed when bound (project:X) and scope resolution fails', async () => {
        process.env.COREDOC_SCOPE = 'project:does-not-exist';
        const { resolveScope } = await import('./scope-resolver.js');
        (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          success: false,
          error: 'No repos found in project: does-not-exist',
          scope: { currentPath: '/x', resolvedRepos: [], repoHashes: [], crossRepoEnabled: false },
        });
        const { handleDescribeRepository } = await import('./tools/discovery/describe-repository.js');

        const result = await callDescribeRepositoryNoScope();

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Scope resolution failed');
        // The discovery handler — and thus listAllRepositories — must never run.
        expect(handleDescribeRepository).not.toHaveBeenCalled();
      });

      it('falls through to discovery when unbound and scope resolution fails', async () => {
        delete process.env.COREDOC_SCOPE;
        const { resolveScope } = await import('./scope-resolver.js');
        (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          success: false,
          error: 'cwd is not a known repo',
          scope: { currentPath: '/x', resolvedRepos: [], repoHashes: [], crossRepoEnabled: false },
        });
        const { handleDescribeRepository } = await import('./tools/discovery/describe-repository.js');

        const result = await callDescribeRepositoryNoScope();

        // Bootstrap discovery: no error, handler runs and returns the list.
        expect(result.isError).toBeUndefined();
        expect(handleDescribeRepository).toHaveBeenCalledOnce();
      });

      it('falls through for destination tracing when unbound, and fails closed when bound', async () => {
        const { resolveScope } = await import('./scope-resolver.js');
        const { handleTraceCrossRepoCall } = await import('./tools/cross-repo/trace-cross-repo-call.js');
        const failedResolution = {
          success: false,
          error: 'cwd is not a known repo',
          scope: { currentPath: '/x', resolvedRepos: [], repoHashes: [], crossRepoEnabled: false },
        };
        const server = createServer({} as NonNullable<Parameters<typeof createServer>[0]>);
        const callHandler = (server as any)._requestHandlers.get('tools/call');

        // Unbound: destination mode may perform its whole-graph producer/consumer join.
        delete process.env.COREDOC_SCOPE;
        (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce(failedResolution);
        const unbound = await callHandler({
          method: 'tools/call',
          params: { name: 'trace_cross_repo_call', arguments: { destination: 'user-events' } },
        });
        expect(unbound.isError).toBeUndefined();
        expect(handleTraceCrossRepoCall).toHaveBeenCalledOnce();

        // Bound: the same failed resolution must short-circuit before the handler.
        process.env.COREDOC_SCOPE = 'project:does-not-exist';
        (resolveScope as ReturnType<typeof vi.fn>).mockReturnValueOnce(failedResolution);
        const bound = await callHandler({
          method: 'tools/call',
          params: { name: 'trace_cross_repo_call', arguments: { destination: 'user-events' } },
        });
        expect(bound.isError).toBe(true);
        expect(bound.content[0].text).toContain('Scope resolution failed');
        expect(handleTraceCrossRepoCall).toHaveBeenCalledOnce();
      });
    });
  });

  // get_intent_context is a PERMANENT LOCAL-ONLY tool: unlike semantic_search it
  // has no env gate, and unlike the shared tools it is deliberately absent from
  // the tool-descriptions/tool-schemas registry that apps/server iterates —
  // that absence IS the cloud gate (AC-9, AC-13).
  describe('get_intent_context (permanent, local-only)', () => {
    async function listToolNames(): Promise<string[]> {
      const server = createServer() as unknown as { _requestHandlers: Map<string, ToolCallHandler> };
      const listHandler = server._requestHandlers.get('tools/list') as unknown as (
        request: unknown,
      ) => Promise<{ tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }>;
      const result = await listHandler({ method: 'tools/list', params: {} });
      return result.tools.map((tool) => tool.name);
    }

    it('is listed with no env flag set', async () => {
      delete process.env.ENABLE_SEMANTIC_SEARCH;
      expect(await listToolNames()).toContain('get_intent_context');
    });

    it('advertises the bounded selector schema', async () => {
      const server = createServer() as unknown as { _requestHandlers: Map<string, ToolCallHandler> };
      const listHandler = server._requestHandlers.get('tools/list') as unknown as (
        request: unknown,
      ) => Promise<{ tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }>;
      const { tools } = await listHandler({ method: 'tools/list', params: {} });
      const tool = tools.find((entry) => entry.name === 'get_intent_context');
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(['intentIds', 'query', 'nodeIds', 'includeCandidates', 'limit']),
      );
    });

    it('is NOT in the shared registry the cloud server iterates (AC-13)', async () => {
      const { TOOL_DESCRIPTIONS } = await import('./tool-descriptions.js');
      const { TOOL_INPUT_SCHEMAS, TOOL_SCHEMAS } = await import('./tool-schemas.js');
      expect(Object.keys(TOOL_DESCRIPTIONS)).not.toContain('get_intent_context');
      expect(Object.keys(TOOL_INPUT_SCHEMAS)).not.toContain('get_intent_context');
      expect(Object.keys(TOOL_SCHEMAS)).not.toContain('get_intent_context');
    });

    it('dispatches to the handler', async () => {
      const { handleGetIntentContext } = await import('./tools/intent/get-intent-context.js');
      (handleGetIntentContext as ReturnType<typeof vi.fn>).mockClear();
      const result = await toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'get_intent_context', arguments: { query: 'ordering' } },
      });
      expect(result.isError).toBeUndefined();
      expect(handleGetIntentContext).toHaveBeenCalledOnce();
    });

    it('still dispatches when the project has no graph, with no repository bound (AC-9)', async () => {
      const { handleGetIntentContext } = await import('./tools/intent/get-intent-context.js');
      (handleGetIntentContext as ReturnType<typeof vi.fn>).mockClear();
      mockListAllRepositories.mockResolvedValueOnce([]);

      const result = await toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'get_intent_context', arguments: {} },
      });

      expect(result.isError).toBeUndefined();
      expect(handleGetIntentContext).toHaveBeenCalledOnce();
      expect((handleGetIntentContext as ReturnType<typeof vi.fn>).mock.calls[0][5]).toBeUndefined();
    });

    it('does not swallow a missing graph for graph-dependent tools', async () => {
      mockListAllRepositories.mockResolvedValueOnce([]);
      const result = await toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'search_symbols', arguments: { query: 'x' } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No graph data');
    });

    // The AC-9 degradation is scoped to ABSENCE of graph data. An unreadable
    // database — corrupt file, lock contention, permission denied — is not
    // evidence that a project was never pushed, so it must be logged and
    // surfaced rather than answered as "no code evidence exists".
    it('does not report an unreadable database as absent evidence', async () => {
      const { handleGetIntentContext } = await import('./tools/intent/get-intent-context.js');
      (handleGetIntentContext as ReturnType<typeof vi.fn>).mockClear();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockOpenProjectDatabase.mockRejectedValueOnce(
        Object.assign(new Error('database disk image is malformed'), { name: 'SqliteError' }),
      );

      const result = await toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'get_intent_context', arguments: {} },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('database disk image is malformed');
      expect(handleGetIntentContext).not.toHaveBeenCalled();
      const stderrText = stderr.mock.calls.map((call) => String(call[0])).join('\n');
      expect(stderrText).toContain('get_intent_context could not open the project graph');
      expect(stderrText).toContain('database disk image is malformed');
      stderr.mockRestore();
    });
  });

  // ENABLE_SEMANTIC_SEARCH gates the WHOLE semantic_search tool at module load
  // (the SOURCE_PARAM pattern extended to a tool): both its TOOLS entry
  // (tools/list) and its TOOL_HANDLERS entry (tools/call) exist only when the
  // flag is on, so a disabled deployment never even lists it. These tests
  // re-import server.js per case because the gate is evaluated once per process.
  describe('semantic_search env gating (ENABLE_SEMANTIC_SEARCH)', () => {
    const ORIGINAL_FLAG = process.env.ENABLE_SEMANTIC_SEARCH;

    afterEach(() => {
      if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_SEMANTIC_SEARCH;
      else process.env.ENABLE_SEMANTIC_SEARCH = ORIGINAL_FLAG;
      vi.resetModules();
      vi.clearAllMocks();
    });

    async function freshServer() {
      vi.resetModules();
      const { createServer: create } = await import('./server.js');
      return create() as any;
    }

    async function listToolNames(): Promise<string[]> {
      const server = await freshServer();
      const listHandler = server._requestHandlers.get('tools/list');
      const result = await listHandler({ method: 'tools/list', params: {} });
      return result.tools.map((t: { name: string }) => t.name);
    }

    it('is absent from the tool list when the env var is unset (fail-closed)', async () => {
      delete process.env.ENABLE_SEMANTIC_SEARCH;
      const names = await listToolNames();
      expect(names).toHaveLength(15);
      expect(names).not.toContain('semantic_search');
      expect(names).not.toContain('list_topics');
      expect(names).not.toContain('trace_topic');
    });

    it('is listed when ENABLE_SEMANTIC_SEARCH=true', async () => {
      process.env.ENABLE_SEMANTIC_SEARCH = 'true';
      expect(await listToolNames()).toContain('semantic_search');
    });

    it('is not dispatchable when disabled (unknown tool)', async () => {
      delete process.env.ENABLE_SEMANTIC_SEARCH;
      const server = await freshServer();
      const callHandler = server._requestHandlers.get('tools/call');
      const result = await callHandler({
        method: 'tools/call',
        params: { name: 'semantic_search', arguments: { query: 'x' } },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('dispatches to the handler when enabled', async () => {
      process.env.ENABLE_SEMANTIC_SEARCH = '1';
      const server = await freshServer();
      // Same (fresh) mocked module instance server.js imported after resetModules.
      const { handleSemanticSearch } = await import('./tools/discovery/semantic-search.js');
      const callHandler = server._requestHandlers.get('tools/call');
      const result = await callHandler({
        method: 'tools/call',
        params: { name: 'semantic_search', arguments: { query: 'x', scope: '/test/path' } },
      });
      expect(result.isError).toBeUndefined();
      expect(handleSemanticSearch).toHaveBeenCalledOnce();
    });
  });

  // S5 — run_cypher_query is gated on the graph backend's Cypher capability AND,
  // for Neo4j, on the operator opt-in (raw Cypher sees the whole shared graph
  // there, so auto-enabling it would nullify the REST endpoint's gate). Unlike
  // semantic_search the gate is evaluated per createServer() call, because the
  // backend is process-env configuration that a host can change between runs.
  describe('run_cypher_query gating (backend + COREDOC_ALLOW_CYPHER)', () => {
    const ORIGINAL_OPT_IN = process.env.COREDOC_ALLOW_CYPHER;

    afterEach(() => {
      if (ORIGINAL_OPT_IN === undefined) delete process.env.COREDOC_ALLOW_CYPHER;
      else process.env.COREDOC_ALLOW_CYPHER = ORIGINAL_OPT_IN;
    });

    async function listToolNames(): Promise<string[]> {
      const server = createServer() as unknown as { _requestHandlers: Map<string, ToolCallHandler> };
      const listHandler = server._requestHandlers.get('tools/list') as unknown as (
        request: unknown,
      ) => Promise<{ tools: Array<{ name: string; description: string }> }>;
      const result = await listHandler({ method: 'tools/list', params: {} });
      return result.tools.map((tool) => tool.name);
    }

    async function dispatch() {
      return toolCallHandler(createServer())({
        method: 'tools/call',
        params: { name: 'run_cypher_query', arguments: { query: 'MATCH (n) RETURN n.name AS name' } },
      });
    }

    it('is absent and undispatchable on sqlite (no Cypher surface)', async () => {
      mockGetConfiguredBackend.mockReturnValue('sqlite');
      delete process.env.COREDOC_ALLOW_CYPHER;

      expect(await listToolNames()).not.toContain('run_cypher_query');
      const result = await dispatch();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('is absent on sqlite even with the opt-in set (sqlite cannot serve Cypher)', async () => {
      mockGetConfiguredBackend.mockReturnValue('sqlite');
      process.env.COREDOC_ALLOW_CYPHER = 'true';

      expect(await listToolNames()).not.toContain('run_cypher_query');
    });

    it('is listed and dispatchable on ladybug without any opt-in', async () => {
      mockGetConfiguredBackend.mockReturnValue('ladybug');
      delete process.env.COREDOC_ALLOW_CYPHER;

      expect(await listToolNames()).toContain('run_cypher_query');
      const { handleRunCypherQuery } = await import('./tools/discovery/run-cypher-query.js');
      const result = await dispatch();
      expect(result.isError).toBeUndefined();
      expect(handleRunCypherQuery).toHaveBeenCalledOnce();
    });

    it('is absent on neo4j without COREDOC_ALLOW_CYPHER', async () => {
      mockGetConfiguredBackend.mockReturnValue('neo4j');
      delete process.env.COREDOC_ALLOW_CYPHER;

      expect(await listToolNames()).not.toContain('run_cypher_query');
      const result = await dispatch();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });

    it('is listed on neo4j once the operator opts in', async () => {
      mockGetConfiguredBackend.mockReturnValue('neo4j');
      process.env.COREDOC_ALLOW_CYPHER = 'true';

      expect(await listToolNames()).toContain('run_cypher_query');
    });

    it('does not treat a non-"true" opt-in value as consent', async () => {
      mockGetConfiguredBackend.mockReturnValue('neo4j');
      process.env.COREDOC_ALLOW_CYPHER = '1';

      expect(await listToolNames()).not.toContain('run_cypher_query');
    });

    it('renders the ACTIVE dialect in the listed description', async () => {
      mockGetConfiguredBackend.mockReturnValue('ladybug');
      const server = createServer() as unknown as { _requestHandlers: Map<string, ToolCallHandler> };
      const listHandler = server._requestHandlers.get('tools/list') as unknown as (
        request: unknown,
      ) => Promise<{ tools: Array<{ name: string; description: string }> }>;
      const { tools } = await listHandler({ method: 'tools/list', params: {} });
      const tool = tools.find((entry) => entry.name === 'run_cypher_query');

      expect(tool?.description).toContain('GraphNode');
      expect(tool?.description).not.toContain('CodeNode');
    });
  });
});

describe('tool argument evidence boundaries', () => {
  it('rejects an unknown repository filter before dispatch', async () => {
    const result = await toolCallHandler(createServer())({
      method: 'tools/call',
      params: { name: 'list_entrypoints', arguments: { repository: 'api' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('repository');
    expect(result.content[0]?.text).toContain('scope');
  });

  it('names the required explain argument when a caller sends symbol', async () => {
    const result = await toolCallHandler(createServer())({
      method: 'tools/call',
      params: { name: 'explain', arguments: { symbol: 'Token' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('target');
  });
});
