/**
 * Tests for get_repo_overview Tool Handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleDescribeRepository } from './describe-repository.js';
import type { ScopeContext } from '../../types.js';

// Mock database abstraction layer
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock response formatter
vi.mock('../../response-formatter.js', () => ({
  formatRepoOverview: vi.fn((result, metadata) => ({
    data: metadata.format === 'raw' ? result : `Formatted: ${result.name}`,
    metadata,
  })),
  createMetadata: vi.fn((scope, format) => ({
    scope,
    staleness: {
      warning: 'Data reflects parsed stable branch, not local changes',
      parsedAt: '2024-01-15T10:30:00.000Z',
    },
    format,
  })),
}));

// Mock the config-backed project map. Default: no config (empty map), so the
// bulk of tests see bare names. Individual tests override it.
vi.mock('../../scope-resolver.js', () => ({
  buildRepoProjectMap: vi.fn(() => new Map()),
}));

// Import after mocks
import { getRepository } from '@coredoc/db';
import { buildRepoProjectMap } from '../../scope-resolver.js';
import { formatRepoOverview } from '../../response-formatter.js';
import {
  createMockRepository,
  createMockRepoOverview,
  createMockEntrypointInfo,
} from '../../__tests__/fixtures/mock-repository.js';

describe('get_repo_overview Tool', () => {
  let mockScope: ScopeContext;

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123'],
      crossRepoEnabled: true,
    };

    vi.clearAllMocks();
  });

  // =============================================================================
  // Main Handler Tests
  // =============================================================================

  describe('handleDescribeRepository', () => {
    it('returns bounded repository inventory without loading packages or entrypoints', async () => {
      mockScope.resolvedRepos = ['test-repo', 'not-parsed'];
      mockScope.repoHashes = ['abc123', 'missing'];
      const mockRepo = createMockRepository({
        getRepoOverview: vi
          .fn()
          .mockResolvedValue([
            createMockRepoOverview({ name: 'test-repo', type: 'monorepo', entrypointTypes: ['grpc'] }),
          ]),
      });
      const result = await handleDescribeRepository(
        { mode: 'inventory' },
        mockScope,
        'raw',
        undefined,
        undefined,
        mockRepo,
      );
      expect(result.data).toMatchObject({
        type: 'project',
        packages: [],
        repos: [
          { name: 'test-repo', parsed: true, entrypointTypes: ['grpc'] },
          { name: 'not-parsed', parsed: false, entrypointTypes: [] },
        ],
      });
      expect(mockRepo.getPackages).not.toHaveBeenCalled();
      expect(mockRepo.listEntrypoints).not.toHaveBeenCalled();
      expect(JSON.stringify(result.data)).not.toContain('"summary"');
    });

    it('should return repository overview with all stats', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'test-service',
            type: 'backend',
            parsedAt: '2024-01-15T10:30:00.000Z',
            fileCount: 150,
            functionCount: 500,
            classCount: 80,
            entityCount: 12,
            entrypointTypes: ['http', 'queue'],
          }),
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([
            createMockEntrypointInfo({ type: 'http' }),
            createMockEntrypointInfo({ type: 'http' }),
            createMockEntrypointInfo({ type: 'queue' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('Formatted: test-service');
      expect(result.metadata.format).toBe('summary');
    });

    it('hides unverified generated repository prose unless raw format is requested', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'supabase',
            summary: 'Coredoc is an AI-powered code documentation platform.',
          }),
        ]),
      });

      await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);
      expect((formatRepoOverview as Mock).mock.calls.at(-1)?.[0]).not.toHaveProperty('summary');

      const raw = await handleDescribeRepository({}, mockScope, 'raw', undefined, undefined, mockRepo);
      expect(raw.data).toHaveProperty('summary', 'Coredoc is an AI-powered code documentation platform.');
    });

    it('should return "no repos parsed" hint when graph is empty', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: vi.fn().mockResolvedValue([]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toBe('No repositories parsed yet.');
      expect(result.metadata).toBeDefined();
    });

    it('should return empty object in raw format when graph is empty', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: vi.fn().mockResolvedValue([]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'raw', undefined, undefined, mockRepo);

      expect(result.data).toEqual({});
      expect(result.metadata.format).toBe('raw');
    });

    it('should return discovery list filtered to current project when boundary is set', async () => {
      // User has 1 company workspace (20 repos) + 1 pet project + 10 learning
      // projects. Discovery without scope should NOT leak the 12 unrelated
      // workspaces — only the company's 20 repos. The boundary comes from
      // the COREDOC_SCOPE=project:X binding (local) or workspace binding
      // (cloud) and is pre-populated on `scope.projectBoundedRepos` by server.ts.
      const projectScope: ScopeContext = {
        currentPath: '/somewhere/else',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
        projectBoundedRepos: ['demo-shifts', 'demo-calculations'],
      };
      // Mirror the production sqlite contract: when nameFilter is passed,
      // the DB-level WHERE clause excludes everything outside the boundary.
      // The mock honors the same contract so we test the actual code path.
      const allRows = [
        { name: 'demo-shifts', hash: '5d8430bc81d0', type: 'backend', parsedAt: '2026-05-12' },
        { name: 'demo-calculations', hash: '9ff436afb359', type: 'backend', parsedAt: '2026-05-13' },
        { name: 'my-pet-project', hash: 'deadbeef0001', type: 'frontend', parsedAt: '2026-05-10' },
        { name: 'learning-rust', hash: 'deadbeef0002', type: 'unknown', parsedAt: '2026-05-09' },
      ];
      const listAll = vi
        .fn()
        .mockImplementation((filter?: string[]) =>
          Promise.resolve(filter ? allRows.filter((r) => filter.includes(r.name)) : allRows),
        );
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: listAll,
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, projectScope, 'raw', undefined, undefined, mockRepo);

      // Handler must push the boundary into the DB call, not filter in-memory.
      expect(listAll).toHaveBeenCalledWith(['demo-shifts', 'demo-calculations']);

      const data = result.data as { type: string; name: string; allKnownRepos?: Array<{ name: string }> };
      expect(data.type).toBe('discovery');
      expect(data.name).toContain('Project repositories');
      const names = data.allKnownRepos?.map((r) => r.name) ?? [];
      expect(names).toContain('demo-shifts');
      expect(names).toContain('demo-calculations');
      // Unrelated workspaces must NOT leak across the boundary
      expect(names).not.toContain('my-pet-project');
      expect(names).not.toContain('learning-rust');
    });

    it('should return all parsed repos when no project boundary is known', async () => {
      // Bootstrap / standalone case: no env, no workspace binding. We have to
      // show everything because there's nothing to narrow against.
      const emptyScope: ScopeContext = {
        currentPath: '/somewhere/else',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
      };
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: vi.fn().mockResolvedValue([
          { name: 'demo-shifts', hash: '5d8430bc81d0', type: 'backend', parsedAt: '2026-05-12' },
          { name: 'my-pet-project', hash: 'deadbeef0001', type: 'frontend', parsedAt: '2026-05-10' },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, emptyScope, 'raw', undefined, undefined, mockRepo);

      const data = result.data as { name: string; allKnownRepos?: Array<{ name: string }> };
      expect(data.name).toContain('All parsed repositories');
      const names = data.allKnownRepos?.map((r) => r.name) ?? [];
      expect(names).toEqual(expect.arrayContaining(['demo-shifts', 'my-pet-project']));
    });

    it('qualifies discovery rows with project/repo scope tokens when config is known', async () => {
      // F: projects live in config, not the graph. When the map resolves a
      // repo's project, each row carries `project` + a copy-pasteable
      // `project/repo` scopeToken; unmapped repos fall back to the bare name.
      (buildRepoProjectMap as Mock).mockReturnValue(
        new Map([
          ['demo-shifts', { projectId: 'demo', scopeToken: 'demo/demo-shifts', ambiguous: false }],
          // `shared` lives in two projects → ambiguous, qualified token required.
          ['shared', { projectId: 'demo', scopeToken: 'demo/shared', ambiguous: true }],
        ]),
      );
      const emptyScope: ScopeContext = {
        currentPath: '/somewhere/else',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
      };
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: vi.fn().mockResolvedValue([
          { name: 'demo-shifts', hash: '5d8430bc81d0', type: 'backend', parsedAt: '2026-05-12' },
          { name: 'shared', hash: 'aaaa00001111', type: 'library', parsedAt: '2026-05-11' },
          { name: 'orphan-repo', hash: 'bbbb00002222', type: 'frontend', parsedAt: '2026-05-10' },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, emptyScope, 'raw', undefined, undefined, mockRepo);

      const data = result.data as {
        allKnownRepos?: Array<{ name: string; project?: string; scopeToken?: string }>;
      };
      const byName = new Map((data.allKnownRepos ?? []).map((r) => [r.name, r]));
      expect(byName.get('demo-shifts')).toMatchObject({ project: 'demo', scopeToken: 'demo/demo-shifts' });
      expect(byName.get('shared')).toMatchObject({ project: 'demo', scopeToken: 'demo/shared' });
      // Not in config → no project/scopeToken, formatter falls back to bare name.
      expect(byName.get('orphan-repo')?.project).toBeUndefined();
      expect(byName.get('orphan-repo')?.scopeToken).toBeUndefined();
    });

    it('should explain when the project has no parsed repos yet', async () => {
      const projectScope: ScopeContext = {
        currentPath: '/somewhere/else',
        resolvedRepos: [],
        repoHashes: [],
        crossRepoEnabled: false,
        projectBoundedRepos: ['demo-shifts', 'demo-calculations'],
      };
      const allRows = [
        // Graph has only unrelated repos — none in the project boundary.
        { name: 'my-pet-project', hash: 'deadbeef0001', type: 'frontend', parsedAt: '2026-05-10' },
      ];
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
        listAllRepositories: vi
          .fn()
          .mockImplementation((filter?: string[]) =>
            Promise.resolve(filter ? allRows.filter((r) => filter.includes(r.name)) : allRows),
          ),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, projectScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('No parsed repositories in the current project');
      expect(result.data).toContain('demo-shifts');
      expect(result.data).toContain('demo-calculations');
    });

    it('should NOT pollute single-repo response with cross-project repos', async () => {
      // Counterpart to the user-reported "mess": when scope resolves cleanly
      // to one repo, the response should not list every other repo on disk.
      // `availableRepos` (from scope.resolvedRepos) is the right surface.
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([createMockRepoOverview({ name: 'test-service', type: 'backend' })]),
        listAllRepositories: vi.fn().mockResolvedValue([
          { name: 'test-service', hash: 'abc123', type: 'backend', parsedAt: '2026-05-13' },
          { name: 'unrelated-project', hash: 'def456', type: 'frontend', parsedAt: '2026-05-13' },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'raw', undefined, undefined, mockRepo);

      const data = result.data as { allKnownRepos?: unknown };
      expect(data.allKnownRepos).toBeUndefined();
    });

    it('should handle empty stats gracefully', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'empty-repo',
            type: 'backend',
            parsedAt: '2024-01-15T10:30:00.000Z',
            fileCount: 0,
            functionCount: 0,
            classCount: 0,
            entityCount: 0,
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.data).toContain('Formatted: empty-repo');
      expect(result.metadata).toBeDefined();
    });

    it('should handle multiple entrypoint types', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'multi-service',
            type: 'backend',
            fileCount: 100,
            functionCount: 200,
            classCount: 30,
            entityCount: 10,
          }),
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([
            ...Array(25).fill(createMockEntrypointInfo({ type: 'http' })),
            ...Array(10).fill(createMockEntrypointInfo({ type: 'graphql' })),
            ...Array(8).fill(createMockEntrypointInfo({ type: 'cron' })),
            ...Array(5).fill(createMockEntrypointInfo({ type: 'grpc' })),
            ...Array(2).fill(createMockEntrypointInfo({ type: 'cron' })),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });
  });

  // =============================================================================
  // Framework Detection Tests
  // =============================================================================

  describe('Framework Detection', () => {
    it('should detect GraphQL from entrypoint types', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'graphql-service',
            type: 'backend',
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([createMockEntrypointInfo({ type: 'graphql' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });

    it('should detect gRPC from entrypoint types', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'grpc-service',
            type: 'backend',
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([createMockEntrypointInfo({ type: 'grpc' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });

    it('should detect multiple frameworks', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'multi-framework-service',
            type: 'backend',
          }),
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([
            createMockEntrypointInfo({ type: 'http' }),
            createMockEntrypointInfo({ type: 'graphql' }),
            createMockEntrypointInfo({ type: 'queue' }),
          ]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });

    it('should not detect frameworks when none are present', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'no-framework-service',
            type: 'backend',
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });
  });

  // =============================================================================
  // Multi-Repo (Group Scope) Tests
  // =============================================================================

  describe('Project Scope Handling', () => {
    it('should return project overview for multiple repos', async () => {
      const { formatRepoOverview } = await import('../../response-formatter.js');

      const groupScope: ScopeContext = {
        currentPath: '/test/project',
        resolvedRepos: ['service-a', 'service-b', 'service-c'],
        repoHashes: ['hash1', 'hash2', 'hash3'],
        project: 'my-project',
        crossRepoEnabled: true,
      };

      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'service-a',
            type: 'backend',
            parsedAt: '2024-01-15T10:30:00.000Z',
            fileCount: 150,
            functionCount: 500,
            classCount: 80,
            entityCount: 12,
          }),
          createMockRepoOverview({
            name: 'service-b',
            type: 'backend',
            parsedAt: '2024-01-16T11:00:00.000Z',
            fileCount: 150,
            functionCount: 500,
            classCount: 80,
            entityCount: 12,
          }),
          createMockRepoOverview({
            name: 'service-c',
            type: 'frontend',
            parsedAt: '2024-01-14T09:00:00.000Z',
            fileCount: 150,
            functionCount: 500,
            classCount: 80,
            entityCount: 12,
          }),
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue([createMockEntrypointInfo({ type: 'http' }), createMockEntrypointInfo({ type: 'queue' })]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const _result = await handleDescribeRepository(
        {},
        groupScope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(vi.mocked(formatRepoOverview)).toHaveBeenCalled();
      const [passedResult] = vi.mocked(formatRepoOverview).mock.calls[0]!;

      expect(passedResult.name).toBe('my-project');
      expect(passedResult.type).toBe('project');
      expect(passedResult.repos).toHaveLength(3);
      // Per-repo rows carry full stats now, not just name/type/parsedAt.
      expect(passedResult.repos![0]).toMatchObject({
        name: 'service-a',
        fileCount: 150,
        functionCount: 500,
        classCount: 80,
        entityCount: 12,
        parsed: true,
      });
      expect(passedResult.repos![1]!.name).toBe('service-b');
      expect(passedResult.repos![2]!.name).toBe('service-c');
      // Should use latest parsedAt
      expect(passedResult.parsedAt).toBe('2024-01-16T11:00:00.000Z');
      // Project view drops the aggregated sums and the noisy packages list,
      // plus the project-level entrypointsByType (each repo's row already
      // lists its own entrypoint kinds).
      expect(passedResult.stats.files).toBe(0);
      expect(passedResult.packages).toEqual([]);
      expect(passedResult.entrypointsByType).toEqual({});
      expect(passedResult.frameworks).toEqual([]);
    });

    it('should surface unparsed repos as parse gaps in the project view', async () => {
      const { formatRepoOverview } = await import('../../response-formatter.js');

      // Scope lists 3 repos (from config), graph only has 2 parsed.
      const groupScope: ScopeContext = {
        currentPath: '/test/project',
        resolvedRepos: ['service-a', 'service-b', 'service-c'],
        repoHashes: ['hash1', 'hash2', 'hash3'],
        project: 'my-project',
        crossRepoEnabled: true,
      };

      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({ name: 'service-a', type: 'backend', fileCount: 100 }),
          createMockRepoOverview({ name: 'service-b', type: 'backend', fileCount: 50 }),
          // service-c missing from the graph
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleDescribeRepository({}, groupScope, 'summary', undefined, undefined, mockRepo);

      const [passedResult] = vi.mocked(formatRepoOverview).mock.calls[0]!;
      // result.name is just the project name; the formatter adds the
      // "X of Y parsed" annotation.
      expect(passedResult.name).toBe('my-project');
      expect(passedResult.repos).toHaveLength(3);
      const parsedCount = passedResult.repos!.filter((r) => r.parsed).length;
      expect(parsedCount).toBe(2);
      const unparsed = passedResult.repos!.find((r) => r.name === 'service-c');
      expect(unparsed).toMatchObject({ parsed: false, type: 'unparsed', fileCount: 0 });
    });

    it('should derive each repo type from its packages when the repo node has no type', async () => {
      const { formatRepoOverview } = await import('../../response-formatter.js');

      const groupScope: ScopeContext = {
        currentPath: '/test/project',
        resolvedRepos: ['single-svc', 'monorepo-root'],
        repoHashes: ['hash-single', 'hash-mono'],
        project: 'my-project',
        crossRepoEnabled: true,
      };

      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          // Both repos come back with type='unknown' — the parser didn't tag
          // them. The handler must derive types from their packages.
          createMockRepoOverview({ name: 'single-svc', type: 'unknown' }),
          createMockRepoOverview({ name: 'monorepo-root', type: 'unknown' }),
        ]),
        getPackages: vi.fn().mockResolvedValue([
          // single-svc → one package, type=backend → repo type should be backend.
          { name: 'single-svc', path: '.', type: 'backend', repoId: 'hash-single' },
          // monorepo-root → multiple packages → repo type should be 'monorepo'.
          { name: '@org/utils', path: 'packages/utils', type: 'library', repoId: 'hash-mono' },
          { name: '@org/api', path: 'packages/api', type: 'backend', repoId: 'hash-mono' },
          { name: 'web-app', path: 'apps/web', type: 'frontend', repoId: 'hash-mono' },
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      await handleDescribeRepository({}, groupScope, 'summary', undefined, undefined, mockRepo);

      const [passedResult] = vi.mocked(formatRepoOverview).mock.calls[0]!;
      const single = passedResult.repos!.find((r) => r.name === 'single-svc')!;
      const mono = passedResult.repos!.find((r) => r.name === 'monorepo-root')!;
      expect(single.type).toBe('backend');
      expect(single.packages).toBeUndefined();
      expect(mono.type).toBe('monorepo');
      // Monorepo repos carry their inner packages so the formatter can
      // render the "Monorepo packages" section.
      expect(mono.packages).toHaveLength(3);
      expect(mono.packages!.map((p) => p.name).sort()).toEqual(['@org/api', '@org/utils', 'web-app']);
    });

    it('should return single repo format for single repo scope', async () => {
      const { formatRepoOverview } = await import('../../response-formatter.js');

      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'single-service',
            type: 'backend',
            parsedAt: '2024-01-15T10:30:00.000Z',
            fileCount: 150,
            functionCount: 500,
            classCount: 80,
            entityCount: 12,
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const _result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(vi.mocked(formatRepoOverview)).toHaveBeenCalled();
      const [passedResult] = vi.mocked(formatRepoOverview).mock.calls[0]!;

      expect(passedResult.name).toBe('single-service');
      expect(passedResult.type).toBe('backend');
      expect(passedResult.repos).toBeUndefined();
    });

    it('should handle project with empty parsedAt values', async () => {
      const { formatRepoOverview } = await import('../../response-formatter.js');

      const groupScope: ScopeContext = {
        currentPath: '/test/project',
        resolvedRepos: ['service-a', 'service-b'],
        repoHashes: ['hash1', 'hash2'],
        project: 'my-project',
        crossRepoEnabled: true,
      };

      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'service-a',
            type: 'backend',
            parsedAt: '',
          }),
          createMockRepoOverview({
            name: 'service-b',
            type: 'backend',
            parsedAt: '2024-01-15T10:30:00.000Z',
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const _result = await handleDescribeRepository(
        {},
        groupScope,
        'summary',
        undefined,
        undefined,
        await getRepository(),
      );

      expect(vi.mocked(formatRepoOverview)).toHaveBeenCalled();
      const [passedResult] = vi.mocked(formatRepoOverview).mock.calls[0]!;

      expect(passedResult.parsedAt).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  // =============================================================================
  // Edge Cases and Error Handling
  // =============================================================================

  describe('Edge Cases', () => {
    it('should handle zero entrypoints gracefully', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'no-entrypoints-service',
            type: 'library',
            fileCount: 50,
            functionCount: 100,
            classCount: 20,
            entityCount: 0,
          }),
        ]),
        listEntrypoints: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });

    it('should handle large stats correctly', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          createMockRepoOverview({
            name: 'large-service',
            type: 'backend',
            fileCount: 10000,
            functionCount: 50000,
            classCount: 5000,
            entityCount: 500,
          }),
        ]),
        listEntrypoints: vi
          .fn()
          .mockResolvedValue(
            Array.from({ length: 100 }, (_, i) => createMockEntrypointInfo({ type: i % 2 === 0 ? 'http' : 'kafka' })),
          ),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await handleDescribeRepository({}, mockScope, 'summary', undefined, undefined, mockRepo);

      expect(result.metadata).toBeDefined();
    });
  });
});
