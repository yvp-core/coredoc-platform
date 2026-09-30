/**
 * Tests for the MCP response formatter module
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  getStalenessInfo,
  formatStalenessHeader,
  createMetadata,
  formatChangeImpact,
  formatFunctionExplanation,
  formatEntrypointExplanation,
  formatRepoOverview,
  formatCodeElementList,
  formatEntrypointList,
  formatCallerList,
  formatEntityConsumers,
  formatServiceDependencies,
  formatExtractionCoverage,
  formatError,
  formatExplain,
} from './response-formatter.js';
import {
  DYNAMIC_DISPATCH_CAVEAT,
  NO_LOW_COVERAGE_FLAGS,
  STRUCTURALLY_BLIND_HEADING,
  structurallyBlindGuidanceLines,
  type RepoCoverageStats,
} from './coverage.js';
import type {
  ScopeContext,
  ChangeImpactResult,
  FunctionExplanationResult,
  EntrypointExplanationResult,
  RepoOverviewResult,
  CodeElementInfo,
  EntrypointInfo,
  CallerInfo,
  EntityConsumerInfo,
  ServiceDependencyResult,
  FunctionInfo,
  McpResponseMetadata,
  EntityInfo,
  ExplainResult,
  ExplainMetadata,
} from './types.js';
import { ZERO_RESULTS_MARKER } from './empty-results.js';
import { DETAIL_ESCALATION_HINT } from './detail-level.js';
import { createMockRepository } from './__tests__/fixtures/mock-repository.js';
import { getRepository } from '@coredoc/db';

// Mock database module
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

describe('Response Formatter', () => {
  let mockScope: ScopeContext;

  beforeEach(() => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123'],
      crossRepoEnabled: true,
    };
  });

  // =============================================================================
  // Staleness Information Tests
  // =============================================================================

  describe('getStalenessInfo', () => {
    it('should return unknown staleness for empty repo hashes', async () => {
      const scope: ScopeContext = {
        ...mockScope,
        repoHashes: [],
      };

      const result = await getStalenessInfo(scope);

      expect(result.warning).toBe('Data reflects indexed snapshots, not live code');
      expect(result.parsedAt).toBe('unknown');
      expect(result.parsedBranch).toBeUndefined();
    });

    it('should fetch staleness info from repository', async () => {
      const mockTimestamp = '2024-01-15T10:30:00.000Z';
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'test-repo', parsedAt: mockTimestamp }]),
      });
      const result = await getStalenessInfo(mockScope, mockRepo);

      expect(result.warning).toBe('Data reflects indexed snapshots, not live code');
      expect(result.parsedAt).toBe(mockTimestamp);
    });

    // No scoped repository (the graph-optional tools) must NOT fall back to the
    // process-default database — staleness would then describe another graph.
    it('reports unknown staleness when no repository is supplied', async () => {
      const result = await getStalenessInfo(mockScope);

      expect(result.parsedAt).toBe('unknown');
      expect(getRepository).not.toHaveBeenCalled();
    });

    it('should handle repository errors gracefully', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockRejectedValue(new Error('Connection failed')),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await getStalenessInfo(mockScope);

      expect(result.warning).toBe('Data reflects indexed snapshots, not live code');
      expect(result.parsedAt).toBe('unknown');
    });

    it('should handle missing records', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await getStalenessInfo(mockScope);

      expect(result.parsedAt).toBe('unknown');
    });

    // The commit the graph was parsed at — published so a consumer can ask the
    // binary question "does the graph see my base?" instead of guessing from a
    // timestamp. Absent stays ABSENT: a repo parsed before the commit was
    // captured (or outside git) publishes no commit rather than an empty string,
    // because a consumer comparing against '' would decide on a value nobody
    // produced.
    it('should publish the parsed commit when the graph recorded one', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi
          .fn()
          .mockResolvedValue([{ name: 'test-repo', parsedAt: '2024-01-15T10:30:00.000Z', gitCommitHash: 'abc123' }]),
      });

      const result = await getStalenessInfo(mockScope, mockRepo);

      expect(result.parsedCommit).toBe('abc123');
    });

    it('should omit the parsed commit when the graph recorded none', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'test-repo', parsedAt: '2024-01-15T10:30:00.000Z' }]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const result = await getStalenessInfo(mockScope);

      expect('parsedCommit' in result).toBe(false);
    });

    it('keeps timestamp and commit paired for every repository', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          { name: 'newer-repo', parsedAt: '2024-01-15T10:30:00.000Z', gitCommitHash: 'newer-commit' },
          { name: 'older-repo', parsedAt: '2024-01-10T10:30:00.000Z', gitCommitHash: 'older-commit' },
        ]),
      });
      const result = await getStalenessInfo(mockScope, mockRepo);
      expect(result.parsedAt).toBe('unknown');
      expect(result.parsedCommit).toBeUndefined();
      expect(result.repositories).toEqual([
        { name: 'newer-repo', parsedAt: '2024-01-15T10:30:00.000Z', parsedCommit: 'newer-commit' },
        { name: 'older-repo', parsedAt: '2024-01-10T10:30:00.000Z', parsedCommit: 'older-commit' },
      ]);
    });

    it('does not borrow a commit from another repository when a slice has none', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([
          { name: 'older-repo', parsedAt: '2024-01-10T10:30:00.000Z', gitCommitHash: 'older-commit' },
          { name: 'newer-repo', parsedAt: '2024-01-15T10:30:00.000Z' },
        ]),
      });
      const result = await getStalenessInfo(mockScope, mockRepo);
      expect(result.parsedCommit).toBeUndefined();
      expect(result.repositories?.find((repo) => repo.name === 'newer-repo')?.parsedCommit).toBeUndefined();
      expect(result.repositories?.find((repo) => repo.name === 'older-repo')?.parsedCommit).toBe('older-commit');
    });

    // The header is the SUMMARY path, which is the default every tool call takes
    // unless a caller asks for raw. A parse commit reachable only through raw is
    // one the ordinary caller never sees.
    it('should render the parsed commit in the summary header, and nothing when there is none', () => {
      const withCommit = formatStalenessHeader({
        warning: 'Data reflects parsed stable branch, not local changes',
        parsedAt: '2024-01-15T10:30:00.000Z',
        parsedCommit: 'abc123def456',
      });
      expect(withCommit).toContain('Parsed at commit: abc123def456');

      const withoutCommit = formatStalenessHeader({
        warning: 'Data reflects parsed stable branch, not local changes',
        parsedAt: '2024-01-15T10:30:00.000Z',
      });
      expect(withoutCommit).not.toContain('Parsed at commit');
      expect(withoutCommit).toContain('Last parsed: 2024-01-15T10:30:00.000Z');
    });

    describe('session-scoped dedupe', () => {
      const staleness = {
        warning: 'Data reflects indexed snapshots, not live code',
        parsedAt: 'unknown',
        repositories: [{ name: 'test-repo', parsedAt: '2024-01-15T10:30:00.000Z', parsedCommit: 'abcdef1234567' }],
      };

      // The dedupe state lives in a module-level, process-lifetime Map keyed by
      // session key — a hardcoded key reused across test reruns in one process
      // is flaky (it looks like a "repeat mention" from a prior run). Each test
      // mints its own key, mirroring staleness-dedupe.test.ts's freshKey().
      let sessionKeyCounter = 0;
      function freshSessionKey(): string {
        sessionKeyCounter += 1;
        return `test-formatter-session-${sessionKeyCounter}`;
      }

      it('renders the full banner on first mention, compact on an unchanged repeat', () => {
        const key = freshSessionKey();
        const full = formatStalenessHeader(staleness, key);
        expect(full).toContain('Data reflects indexed snapshots, not live code');
        expect(full).toContain('test-repo — Last parsed: 2024-01-15T10:30:00.000Z; Parsed at commit: abcdef1234567');

        const compact = formatStalenessHeader(staleness, key);
        expect(compact).not.toContain('Data reflects indexed snapshots, not live code');
        // commit7 = first 7 chars; date = YYYY-MM-DD.
        expect(compact).toBe('> snapshot test-repo@abcdef1 · 2024-01-15\n');
      });

      it('drops the commit segment in compact form when commit is unknown', () => {
        const key = freshSessionKey();
        formatStalenessHeader(
          { ...staleness, repositories: [{ name: 'no-commit-repo', parsedAt: '2024-02-01T00:00:00.000Z' }] },
          key,
        );
        const compact = formatStalenessHeader(
          { ...staleness, repositories: [{ name: 'no-commit-repo', parsedAt: '2024-02-01T00:00:00.000Z' }] },
          key,
        );
        expect(compact).toBe('> snapshot no-commit-repo · 2024-02-01\n');
      });

      it('renders full again after the repo parse state changes', () => {
        const key = freshSessionKey();
        formatStalenessHeader(staleness, key);
        formatStalenessHeader(staleness, key); // compact
        const changed = formatStalenessHeader(
          {
            ...staleness,
            repositories: [{ name: 'test-repo', parsedAt: '2024-03-01T00:00:00.000Z', parsedCommit: 'newcommit99' }],
          },
          key,
        );
        expect(changed).toContain('Data reflects indexed snapshots, not live code');
        expect(changed).toContain('Parsed at commit: newcommit99');
      });

      it('always renders full without a session key', () => {
        const first = formatStalenessHeader(staleness);
        const second = formatStalenessHeader(staleness);
        expect(first).toContain('Data reflects indexed snapshots, not live code');
        expect(second).toContain('Data reflects indexed snapshots, not live code');
      });

      it('falls back to the raw parsedAt string instead of throwing on a malformed date', () => {
        const key = freshSessionKey();
        const malformed = {
          ...staleness,
          repositories: [{ name: 'bad-date-repo', parsedAt: 'not-a-real-date' }],
        };
        formatStalenessHeader(malformed, key); // full — no compact path exercised yet
        const compact = formatStalenessHeader(malformed, key);
        expect(compact).toBe('> snapshot bad-date-repo · not-a-real-date\n');
      });
    });
  });

  describe('createMetadata', () => {
    it('should create metadata with staleness info', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([{ name: 'test-repo', parsedAt: '2024-01-15T10:30:00.000Z' }]),
      });
      const metadata = await createMetadata(mockScope, 'summary', undefined, undefined, mockRepo);

      expect(metadata.scope).toEqual(mockScope);
      expect(metadata.staleness.parsedAt).toBe('2024-01-15T10:30:00.000Z');
      expect(metadata.format).toBe('summary');
    });

    it('should support raw format', async () => {
      const mockRepo = createMockRepository({
        getRepoOverview: vi.fn().mockResolvedValue([]),
      });
      (getRepository as Mock).mockResolvedValue(mockRepo);

      const metadata = await createMetadata(mockScope, 'raw');

      expect(metadata.format).toBe('raw');
    });
  });

  // =============================================================================
  // Change Impact Formatter Tests
  // =============================================================================

  describe('formatChangeImpact', () => {
    let mockChangeImpact: ChangeImpactResult;
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockChangeImpact = {
        target: {
          name: 'getUserById',
          filePath: 'src/users/service.ts',
          startLine: 10,
          endLine: 20,
          type: 'function',
          id: 'abc123:function:src/users/service.ts:getUserById',
        },
        directCallers: [
          {
            name: 'userController',
            className: 'UserController',
            filePath: 'src/users/controller.ts',
            startLine: 30,
            endLine: 40,
            type: 'function',
            kind: 'method',
            id: 'abc123:function:src/users/controller.ts:userController',
            distance: 1,
          },
        ],
        transitiveCallers: [],
        affectedEntrypoints: [],
        affectedTests: [],
        riskLevel: 'low',
        impactSummary: 'Low risk change with 1 direct caller',
      };

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format change impact in summary mode', () => {
      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.metadata).toEqual(mockMetadata);
      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Impact Analysis: `getUserById`');
      expect(result.data).toContain('**Risk Level:**');
      expect(result.data).toContain('Low risk change with 1 direct caller');
      expect(result.data).toContain('### Direct Callers (1)');
      expect(result.data).toContain('UserController.userController');
    });

    it('keeps warnings and ambiguity banners unaffected when the staleness portion goes compact', () => {
      const dedupedMetadata: McpResponseMetadata = {
        ...mockMetadata,
        scope: { ...mockScope, sessionKey: 'change-impact-session' },
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: 'unknown',
          repositories: [{ name: 'test-repo', parsedAt: '2024-01-15T10:30:00.000Z', parsedCommit: 'abc123def' }],
        },
        warnings: ['Some entities were excluded by the extraction profile'],
        ambiguity: { totalMatches: 2, others: [], moreCount: 1, hint: '1 more match — disambiguate with fileHint' },
      };

      const first = formatChangeImpact(mockChangeImpact, dedupedMetadata);
      expect(first.data as string).toContain('Some entities were excluded by the extraction profile');
      expect(first.data as string).toContain('1 more match — disambiguate with fileHint');
      expect(first.data as string).toContain('Data reflects parsed stable branch, not local changes');

      // Second call, same session + unchanged repo state -> staleness compacts,
      // but warnings/ambiguity are unconditional and must still render.
      const second = formatChangeImpact(mockChangeImpact, dedupedMetadata);
      expect(second.data as string).toContain('Some entities were excluded by the extraction profile');
      expect(second.data as string).toContain('1 more match — disambiguate with fileHint');
      expect(second.data as string).not.toContain('Data reflects parsed stable branch, not local changes');
      expect(second.data as string).toContain('> snapshot test-repo@abc123d · 2024-01-15');
    });

    // An omitted "Affected Tests" section reads as "no test covers this", but
    // extraction profiles routinely exclude test sources — the zero has to be
    // stated, with the reason.
    it('states an explicit zero for affected tests instead of omitting the section', () => {
      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('### Affected Tests (0)');
      expect(result.data).toContain(ZERO_RESULTS_MARKER);
      expect(result.data).toContain('grep');
    });

    it('lists affected tests when there are any', () => {
      mockChangeImpact.affectedTests = [
        {
          id: 'abc123:function:src/users/service.spec.ts:describeService',
          name: 'describeService',
          filePath: 'src/users/service.spec.ts',
          startLine: 3,
          type: 'function',
        },
      ];

      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('### Affected Tests (1)');
      expect(result.data).toContain('src/users/service.spec.ts');
      expect(result.data).not.toContain('### Affected Tests (0)');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toEqual(mockChangeImpact);
      expect(result.metadata.format).toBe('raw');
    });

    it('should include staleness warning in summary', () => {
      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('> Data reflects parsed stable branch, not local changes');
      expect(result.data).toContain('> Last parsed: 2024-01-15T10:30:00.000Z');
    });

    it('should format high risk changes', () => {
      mockChangeImpact.riskLevel = 'high';
      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('HIGH');
    });

    it('should format transitive callers', () => {
      mockChangeImpact.transitiveCallers = [
        {
          name: 'adminController',
          filePath: 'src/admin/controller.ts',
          startLine: 50,
          type: 'function',
          kind: 'function',
          id: 'abc123:function:src/admin/controller.ts:adminController',
          distance: 2,
        },
      ];

      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('### Transitive Callers (1)');
      expect(result.data).toContain('2 hops');
    });

    it('should format affected entrypoints', () => {
      mockChangeImpact.affectedEntrypoints = [
        {
          type: 'http',
          method: 'GET',
          path: '/users/:id',
          fullPath: '/api/users/:id',
          handlerId: 'handler123',
          handlerName: 'getUser',
          filePath: 'src/users/routes.ts',
          startLine: 10,
          id: 'ep123',
        },
      ];

      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('### Affected Entrypoints (1)');
      expect(result.data).toContain('**GET** `/api/users/:id`');
    });

    it('should limit and truncate long lists', () => {
      mockChangeImpact.directCallers = Array.from({ length: 15 }, (_, i) => ({
        name: `caller${i}`,
        filePath: `src/caller${i}.ts`,
        startLine: i,
        type: 'function' as const,
        kind: 'function' as const,
        id: `caller${i}`,
        distance: 1,
      }));

      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('... and 5 more');
    });

    it('should format cross-repo impacts', () => {
      mockChangeImpact.crossRepoImpacts = [
        {
          repo: 'other-service',
          consumers: [
            {
              name: 'externalFunction',
              filePath: 'src/external.ts',
              startLine: 10,
              type: 'function',
              kind: 'function',
              id: 'ext123',
              distance: 1,
            },
          ],
        },
      ];

      const result = formatChangeImpact(mockChangeImpact, mockMetadata);

      expect(result.data).toContain('### Cross-Repo Impact');
      expect(result.data).toContain('**other-service** (1 consumer)');
    });
  });

  // =============================================================================
  // Function Explanation Formatter Tests
  // =============================================================================

  describe('formatFunctionExplanation', () => {
    let mockExplanation: FunctionExplanationResult;
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockExplanation = {
        function: {
          name: 'createUser',
          filePath: 'src/users/service.ts',
          startLine: 20,
          endLine: 35,
          type: 'function',
          kind: 'method',
          className: 'UserService',
          id: 'func123',
          summary: 'Creates a new user in the system',
          isAsync: true,
          visibility: 'public',
        },
        businessLogic: 'Validates user data, checks for duplicates, and creates user record',
        sideEffects: 'Sends welcome email, logs audit event',
        dbOperations: [{ entity: 'User', operation: 'create' }],
        externalCalls: [{ service: 'email-service', pattern: 'POST /send-email' }],
        callees: [],
        callers: [],
      };

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format function explanation in summary mode', () => {
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Function: `UserService.createUser`');
      expect(result.data).toContain('src/users/service.ts:20-35');
      expect(result.data).toContain('### Summary');
      expect(result.data).toContain('Creates a new user in the system');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toEqual(mockExplanation);
    });

    it('should prefer purpose over summary', () => {
      mockExplanation.function.purpose = 'User registration workflow entry point';
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Purpose');
      expect(result.data).toContain('User registration workflow entry point');
      expect(result.data).not.toContain('### Summary');
    });

    it('should format business logic', () => {
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Business Logic');
      expect(result.data).toContain('Validates user data');
    });

    it('should format side effects', () => {
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Side Effects');
      expect(result.data).toContain('Sends welcome email');
    });

    it('should format database operations', () => {
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Database Operations');
      expect(result.data).toContain('**CREATE** `User`');
    });

    it('fences source with a plain triple-backtick block when it has no backticks', () => {
      mockExplanation.function.sourceCode = 'function fn() { return 1; }';
      const lines = (formatFunctionExplanation(mockExplanation, mockMetadata).data as string).split('\n');
      const srcIdx = lines.indexOf('### Source');
      expect(srcIdx).toBeGreaterThanOrEqual(0);
      expect(lines[srcIdx + 1]).toBe('```');
      expect(lines[srcIdx + 2]).toBe('function fn() { return 1; }');
      expect(lines[srcIdx + 3]).toBe('```');
    });

    it('widens the fence so source containing a ``` run cannot break out', () => {
      mockExplanation.function.sourceCode = 'const md = "```";\n// end';
      const body = formatFunctionExplanation(mockExplanation, mockMetadata).data as string;
      const lines = body.split('\n');
      const srcIdx = lines.indexOf('### Source');
      // Opening fence must be longer than the longest backtick run in the source
      // (3 here), so the embedded ``` cannot prematurely close the block.
      expect(lines[srcIdx + 1]).toMatch(/^`{4,}$/);
      expect(body).toContain('const md = "```";');
    });

    it('should format external calls', () => {
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### External Calls');
      expect(result.data).toContain('**email-service** `POST /send-email`');
    });

    // A node the substrate minted from a declaration convention (Rails `has_many`) has no body.
    // Unmarked, an agent reads the `has_many :posts` line as a `def` and looks for source that
    // does not exist — and the twin matters just as much: a declared function gets no marker.
    it('marks a synthesized function, in the header and in the callee list', () => {
      mockExplanation.function.synthesized = 'ruby-association';
      mockExplanation.callees = [
        {
          id: 'f2',
          name: 'comments',
          type: 'function',
          kind: 'method',
          filePath: 'app/models/post.rb',
          startLine: 4,
          endLine: 4,
          synthesized: 'ruby-association',
        },
        {
          id: 'f3',
          name: 'save',
          type: 'function',
          kind: 'method',
          filePath: 'app/models/post.rb',
          startLine: 9,
          endLine: 11,
        },
      ];

      const body = formatFunctionExplanation(mockExplanation, mockMetadata).data as string;
      const calleeLines = body.split('\n').filter((l) => l.startsWith('- `'));

      expect(body).toContain('(synthesized: ruby-association — no body)');
      expect(calleeLines.find((l) => l.includes('`comments`'))).toContain('(synthesized: ruby-association — no body)');
      expect(calleeLines.find((l) => l.includes('`save`'))).not.toContain('synthesized');
    });

    it('marks no declared function as synthesized', () => {
      const body = formatFunctionExplanation(mockExplanation, mockMetadata).data as string;

      expect(body).not.toContain('synthesized');
    });

    it('should format callees', () => {
      mockExplanation.callees = [
        {
          name: 'validateUser',
          filePath: 'src/users/validator.ts',
          startLine: 10,
          type: 'function',
          kind: 'function',
          id: 'val123',
        },
      ];

      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Calls (1)');
      expect(result.data).toContain('validateUser');
    });

    it('should format callers', () => {
      mockExplanation.callers = [
        {
          name: 'handleSignup',
          filePath: 'src/auth/controller.ts',
          startLine: 20,
          type: 'function',
          kind: 'function',
          id: 'handler123',
          distance: 1,
        },
      ];

      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Called By (1)');
      expect(result.data).toContain('handleSignup');
      expect(result.data).toContain('[direct]');
    });

    it('should handle functions without class context', () => {
      delete mockExplanation.function.className;
      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('## Function: `createUser`');
    });

    it('should limit callees list', () => {
      mockExplanation.callees = Array.from({ length: 15 }, (_, i) => ({
        name: `callee${i}`,
        filePath: `src/callee${i}.ts`,
        startLine: i,
        type: 'function',
        kind: 'function',
        id: `callee${i}`,
      }));

      const result = formatFunctionExplanation(mockExplanation, mockMetadata);

      expect(result.data).toContain('### Calls (15)');
      expect(result.data).toContain('... and 5 more');
    });
  });

  // =============================================================================
  // Entrypoint Explanation Formatter Tests
  // =============================================================================

  describe('formatEntrypointExplanation', () => {
    let mockEntrypointExplanation: EntrypointExplanationResult;
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockEntrypointExplanation = {
        entrypoint: {
          type: 'http',
          method: 'POST',
          path: '/users',
          fullPath: '/api/v1/users',
          handlerId: 'handler123',
          handlerName: 'createUserHandler',
          filePath: 'src/users/routes.ts',
          startLine: 15,
          id: 'ep123',
        },
        handler: {
          function: {
            name: 'createUserHandler',
            filePath: 'src/users/controller.ts',
            startLine: 20,
            type: 'function',
            kind: 'function',
            id: 'func123',
            purpose: 'Handle user creation requests',
          },
          businessLogic: 'Validates input, creates user, returns response',
        },
        callTree: [],
        entities: [],
        externalServices: [],
      };

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format HTTP entrypoint explanation', () => {
      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Endpoint: POST `/api/v1/users`');
      expect(result.data).toContain('### Handler');
      expect(result.data).toContain('createUserHandler');
    });

    it('should format GraphQL entrypoint', () => {
      mockEntrypointExplanation.entrypoint = {
        type: 'graphql',
        operationType: 'mutation',
        fieldName: 'createUser',
        handlerId: 'handler123',
        handlerName: 'createUserResolver',
        filePath: 'src/resolvers.ts',
        startLine: 10,
        id: 'ep123',
      };

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('## GraphQL mutation: `createUser`');
    });

    it('should format a topic-addressed queue entrypoint', () => {
      mockEntrypointExplanation.entrypoint = {
        type: 'queue',
        topic: 'user-events',
        handlerId: 'handler123',
        handlerName: 'handleUserEvent',
        filePath: 'src/consumers.ts',
        startLine: 10,
        id: 'ep123',
      };

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('## queue: `user-events`');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toEqual(mockEntrypointExplanation);
    });

    // dynamic-boundaries spec AC-3: an `unresolved:`-prefixed topic sentinel
    // (packages/profile-parser/src/unresolved-sentinel.ts) must render as
    // statically unresolvable, never as if it were the literal topic name.
    it('renders an unresolved-sentinel topic as statically unresolvable, not as a literal value', () => {
      mockEntrypointExplanation.entrypoint = {
        type: 'queue',
        topicValue: "unresolved:getTopicInNamespace('x')",
        handlerId: 'handler123',
        handlerName: 'handleDynamicTopic',
        filePath: 'src/consumers.ts',
        startLine: 10,
        id: 'ep123',
      };

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain("<statically unresolvable: getTopicInNamespace('x')>");
      expect(result.data).not.toContain("`unresolved:getTopicInNamespace('x')`");
    });

    // D2a: a queue entrypoint has no `topic`/`schedule` on some parsers, and the
    // header fell back to `ep.id` — rendering `## 9ff436afb359:entrypoint:queue:e0a1727d`
    // as the title of an otherwise empty response.
    it('titles a queue entrypoint by its destination and system, never the node id', () => {
      mockEntrypointExplanation.entrypoint = {
        type: 'queue',
        system: 'kafka',
        destination: 'Topics.DailySummaryRecalculateV2',
        topic: 'Topics.DailySummaryRecalculateV2',
        handlerId: 'handler123',
        handlerName: 'handleDailySummaryRecalculateOnDemandV1',
        filePath: 'src/modules/kafka-recalculate/kafka-recalculate.controller.ts',
        startLine: 80,
        id: '9ff436afb359:entrypoint:queue:e0a1727d',
      };

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('## queue (kafka): `Topics.DailySummaryRecalculateV2`');
      expect(result.data).not.toContain('9ff436afb359:entrypoint:queue:e0a1727d');
    });

    it('falls back to the handler name, then the file location — never the node id', () => {
      mockEntrypointExplanation.entrypoint = {
        type: 'queue',
        handlerId: 'handler123',
        handlerName: 'handleSomething',
        filePath: 'src/queue.ts',
        startLine: 12,
        id: 'repo:entrypoint:queue:deadbeef',
      };

      const withHandler = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);
      expect(withHandler.data).toContain('## queue: `handleSomething`');

      mockEntrypointExplanation.entrypoint = { ...mockEntrypointExplanation.entrypoint, handlerName: '' };
      const withoutHandler = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);
      expect(withoutHandler.data).toContain('## queue: `src/queue.ts:12`');
      expect(withoutHandler.data).not.toContain('repo:entrypoint:queue:deadbeef');
    });

    it('should format handler purpose', () => {
      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('**Purpose:** Handle user creation requests');
    });

    it('should format business logic', () => {
      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('### Business Logic');
      expect(result.data).toContain('Validates input, creates user, returns response');
    });

    it('should format call tree', () => {
      mockEntrypointExplanation.callTree = [
        {
          name: 'validateInput',
          filePath: 'src/validators.ts',
          startLine: 5,
          type: 'function',
          kind: 'function',
          id: 'val123',
          summary: 'Validates request data',
        },
      ];

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('### Call Tree (1 functions)');
      expect(result.data).toContain('`validateInput`');
      expect(result.data).toContain('Validates request data');
    });

    // The deep-dive is a planning view: a callee row without its location costs
    // an extra lookup before the agent can read the body it actually needs.
    it('keeps file:line on every call-tree row so a Read is one step', () => {
      mockEntrypointExplanation.callTree = [
        {
          name: 'validateInput',
          className: 'Validators',
          filePath: 'src/validators.ts',
          startLine: 5,
          type: 'function',
          kind: 'function',
          id: 'val123',
          summary: 'Validates request data',
        },
      ];

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('`Validators.validateInput` - src/validators.ts:5');
    });

    describe('Deeper footer (handler body steering)', () => {
      const ORIGINAL_FLAG = process.env.ALLOW_SOURCES_IN_GRAPH;
      afterEach(() => {
        if (ORIGINAL_FLAG === undefined) delete process.env.ALLOW_SOURCES_IN_GRAPH;
        else process.env.ALLOW_SOURCES_IN_GRAPH = ORIGINAL_FLAG;
      });

      it('points at explain(includeSource) when source-in-graph is enabled', () => {
        process.env.ALLOW_SOURCES_IN_GRAPH = '1';
        mockEntrypointExplanation.handler.function.className = 'UserController';
        mockEntrypointExplanation.handler.function.name = 'createUser';

        const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

        expect(result.data).toContain(
          '> Deeper: explain({target: "UserController.createUser", includeSource: true}) — handler body: guards, predicates, field mappings',
        );
      });

      it('points at a file read when source-in-graph is disabled', () => {
        delete process.env.ALLOW_SOURCES_IN_GRAPH;
        mockEntrypointExplanation.handler.function.endLine = 48;

        const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

        expect(result.data).toContain(
          '> Deeper: Read `src/users/controller.ts:20-48` — handler body: guards, predicates, field mappings',
        );
        expect(result.data).not.toContain('includeSource');
      });

      it('inlines the handler body and drops the hop when source was already returned', () => {
        process.env.ALLOW_SOURCES_IN_GRAPH = '1';
        mockEntrypointExplanation.handler.function.sourceCode = 'if (!isTriggeredByRead) return;';

        const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

        expect(result.data).toContain('### Handler Source');
        expect(result.data).toContain('if (!isTriggeredByRead) return;');
        expect(result.data).not.toContain('> Deeper:');
      });

      it('omits the hop when the handler did not resolve', () => {
        process.env.ALLOW_SOURCES_IN_GRAPH = '1';
        mockEntrypointExplanation.handler = {
          function: { id: '', name: 'unknown', filePath: '', startLine: 0, type: 'function', kind: 'function' },
        };

        const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

        expect(result.data).not.toContain('> Deeper:');
      });
    });

    it('should format entities', () => {
      mockEntrypointExplanation.entities = [
        {
          name: 'User',
          tableName: 'users',
          ormType: 'TypeORM',
          filePath: 'src/entities/user.ts',
          startLine: 10,
          id: 'entity123',
        },
      ];

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      // Compact "Touches" block (rendered before the truncatable call tree).
      expect(result.data).toContain('### Touches');
      expect(result.data).toContain('**DB entities (1):**');
      expect(result.data).toContain('`User` (users)');
    });

    it('should format external services', () => {
      mockEntrypointExplanation.externalServices = ['email-service', 'payment-gateway'];

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('### Touches');
      expect(result.data).toContain('**Outbound services (2):**');
      expect(result.data).toContain('email-service, payment-gateway');
    });

    it('should format upstream callers', () => {
      mockEntrypointExplanation.upstreamCallers = [
        { repo: 'frontend', callSites: 3 },
        { repo: 'mobile-app', callSites: 1 },
      ];

      const result = formatEntrypointExplanation(mockEntrypointExplanation, mockMetadata);

      expect(result.data).toContain('### Called By (Cross-Repo)');
      expect(result.data).toContain('**frontend** (3 call sites)');
      expect(result.data).toContain('**mobile-app** (1 call site)');
    });
  });

  // =============================================================================
  // Repository Overview Formatter Tests
  // =============================================================================

  describe('formatRepoOverview', () => {
    let mockOverview: RepoOverviewResult;
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockOverview = {
        name: 'test-service',
        type: 'backend',
        parsedAt: '2024-01-15T10:30:00.000Z',
        stats: {
          files: 150,
          functions: 500,
          classes: 80,
          entrypoints: 25,
          entities: 12,
        },
        frameworks: ['NestJS', 'TypeORM'],
        packages: [
          { name: 'express', path: 'packages/express', type: 'backend', description: 'Web framework' },
          { name: 'typeorm', path: 'packages/typeorm', type: 'backend', description: 'ORM library' },
          { name: '@nestjs/common', path: 'packages/nestjs-common', type: 'backend' },
        ],
        entrypointsByType: {
          http: 20,
          kafka: 5,
        },
      };

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format repo overview in summary mode', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Repository: test-service');
      expect(result.data).toContain('**Type:** backend');
      expect(result.data).toContain('**Parsed:** 2024-01-15T10:30:00.000Z');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toEqual(mockOverview);
    });

    it('renders the git link when gitRemoteUrl is present, omits it otherwise', () => {
      expect(formatRepoOverview(mockOverview, mockMetadata).data).not.toContain('**Git:**');

      mockOverview.gitRemoteUrl = 'git@github.com:acme/api.git';
      const withLink = formatRepoOverview(mockOverview, mockMetadata);
      expect(withLink.data).toContain('**Git:** git@github.com:acme/api.git');
    });

    it('should format statistics table', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('### Statistics');
      expect(result.data).toContain('| Metric | Count |');
      expect(result.data).toContain('| Files | 150 |');
      expect(result.data).toContain('| Functions | 500 |');
      expect(result.data).toContain('| Entrypoints | 25 |');
    });

    it('should format detected frameworks', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('### Detected Frameworks');
      expect(result.data).toContain('- NestJS');
      expect(result.data).toContain('- TypeORM');
    });

    it('should format packages', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('### Packages');
      expect(result.data).toContain('| Package | Path | Type | Description |');
      expect(result.data).toContain('| express | packages/express | backend | Web framework |');
      expect(result.data).toContain('| typeorm | packages/typeorm | backend | ORM library |');
      expect(result.data).toContain('| @nestjs/common | packages/nestjs-common | backend |  |');
    });

    it('should format entrypoints by type', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('### Entrypoints by Type');
      expect(result.data).toContain('- **http:** 20');
      expect(result.data).toContain('- **kafka:** 5');
    });

    it('renders discovery rows with project/repo scope tokens when known (F)', () => {
      const discovery: RepoOverviewResult = {
        name: 'All parsed repositories (2)',
        type: 'discovery',
        parsedAt: '2026-05-12',
        stats: { files: 0, functions: 0, classes: 0, entrypoints: 0, entities: 0 },
        frameworks: [],
        packages: [],
        entrypointsByType: {},
        allKnownRepos: [
          {
            name: 'demo-shifts',
            type: 'backend',
            parsedAt: '2026-05-12',
            project: 'demo',
            scopeToken: 'demo/demo-shifts',
          },
          { name: 'orphan', type: 'frontend', parsedAt: '2026-05-10' },
        ],
      };
      const result = formatRepoOverview(discovery, mockMetadata);

      // Qualified row uses the token; unmapped row falls back to bare name.
      expect(result.data).toContain('| demo/demo-shifts | backend | 2026-05-12 |');
      expect(result.data).toContain('| orphan | frontend | 2026-05-10 |');
      // The disambiguation note appears once any row is qualified.
      expect(result.data).toContain('Repo names are shown as `project/repo`');
    });

    it('omits the project/repo note when no discovery row is qualified', () => {
      const discovery: RepoOverviewResult = {
        name: 'All parsed repositories (1)',
        type: 'discovery',
        parsedAt: '2026-05-12',
        stats: { files: 0, functions: 0, classes: 0, entrypoints: 0, entities: 0 },
        frameworks: [],
        packages: [],
        entrypointsByType: {},
        allKnownRepos: [{ name: 'solo', type: 'backend', parsedAt: '2026-05-12' }],
      };
      const result = formatRepoOverview(discovery, mockMetadata);

      expect(result.data).toContain('| solo | backend | 2026-05-12 |');
      expect(result.data).not.toContain('Repo names are shown as');
    });

    it('renders inconsistent zero counts as n/a (parser gap, not an empty repo)', () => {
      // Ruby/Rails case: functions are extracted but file/class counts are not.
      mockOverview.stats = { files: 0, functions: 2836, classes: 0, entrypoints: 40, entities: 0 };
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('| Files | n/a |');
      expect(result.data).toContain('| Classes | n/a |');
      expect(result.data).toContain('| Functions | 2836 |');
      expect(result.data).toContain("not reported by this language's parser");
    });

    it('keeps a genuine zero class count when files ARE reported', () => {
      // Functional codebase: real file count, legitimately no classes.
      mockOverview.stats = { files: 200, functions: 500, classes: 0, entrypoints: 10, entities: 0 };
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('| Files | 200 |');
      expect(result.data).toContain('| Classes | 0 |');
      expect(result.data).not.toContain('n/a');
    });

    it('includes a coverage manifest naming the index blind spots', () => {
      const result = formatRepoOverview(mockOverview, mockMetadata);

      expect(result.data).toContain('### Coverage');
      expect(result.data).toContain('NOT indexed');
      expect(result.data).toContain('migrations');
    });
  });

  // =============================================================================
  // List Formatter Tests
  // =============================================================================

  describe('formatCodeElementList', () => {
    let mockElements: CodeElementInfo[];
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockElements = [
        {
          name: 'createUser',
          filePath: 'src/users.ts',
          startLine: 10,
          type: 'function',
          id: 'func1',
        },
        {
          name: 'UserService',
          filePath: 'src/service.ts',
          startLine: 20,
          type: 'class',
          id: 'class1',
        },
      ];

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format element list in summary mode', () => {
      const result = formatCodeElementList(mockElements, 'Search Results', mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Search Results (showing 2 of 2)');
      expect(result.data).toContain('- `createUser` (function) - src/users.ts:10');
      expect(result.data).toContain('- `UserService` (class) - src/service.ts:20');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatCodeElementList(mockElements, 'Search Results', mockMetadata);

      expect(result.data).toEqual(mockElements);
    });

    it('widens an element source fence so an embedded ``` run cannot break out', () => {
      const els: CodeElementInfo[] = [
        { name: 'fn', filePath: 'src/a.ts', startLine: 1, type: 'function', id: 'i1', sourceCode: 'const md = "```";' },
      ];
      const body = formatCodeElementList(els, 'R', mockMetadata).data as string;
      const lines = body.split('\n');
      // A fence of >=4 backticks must wrap the source (longer than the inner ``` run).
      expect(lines.some((l) => /^`{4,}$/.test(l))).toBe(true);
      expect(body).toContain('const md = "```";');
    });

    it('should truncate long lists', () => {
      const manyElements = Array.from({ length: 60 }, (_, i) => ({
        name: `element${i}`,
        filePath: `src/file${i}.ts`,
        startLine: i,
        type: 'function' as const,
        id: `id${i}`,
      }));

      const result = formatCodeElementList(manyElements, 'Many Results', mockMetadata);

      expect(result.data).toContain('... and 10 more');
    });

    it('prefers the one-line purpose over the (long) summary', () => {
      const els: CodeElementInfo[] = [
        {
          name: 'fn',
          filePath: 'src/a.ts',
          startLine: 1,
          type: 'function',
          id: 'i1',
          purpose: 'Create a trial customer.',
          summary: 'A'.repeat(200),
        },
      ];
      const result = formatCodeElementList(els, 'R', mockMetadata);
      expect(result.data).toContain('Create a trial customer.');
      expect(result.data).not.toContain('AAAA'); // long summary suppressed when purpose exists
    });

    it('falls back to a capped summary with a trailing … when purpose is absent', () => {
      const els: CodeElementInfo[] = [
        { name: 'fn', filePath: 'src/a.ts', startLine: 1, type: 'function', id: 'i1', summary: 'x'.repeat(200) },
      ];
      const result = formatCodeElementList(els, 'R', mockMetadata);
      expect(result.data).toContain(`${'x'.repeat(120)}…`);
      expect(result.data).not.toContain('x'.repeat(121));
    });

    it('shows a short summary verbatim (no …) when purpose is absent', () => {
      const els: CodeElementInfo[] = [
        { name: 'fn', filePath: 'src/a.ts', startLine: 1, type: 'function', id: 'i1', summary: 'Short summary.' },
      ];
      const result = formatCodeElementList(els, 'R', mockMetadata);
      expect(result.data).toContain('Short summary.');
      expect(result.data).not.toContain('…');
    });

    it('renders an unverified-identity caveat from the ambiguous flag without touching the name', () => {
      const els: CodeElementInfo[] = [
        { name: 'isLocked', filePath: 'src/guard.ts', startLine: 4, type: 'function', id: 'i1', ambiguous: true },
        { name: 'render', filePath: 'src/render.ts', startLine: 9, type: 'function', id: 'i2' },
      ];
      const text = formatCodeElementList(els, 'R', mockMetadata).data as string;
      // The ambiguous row shows the caveat; the name stays clean (backtick-wrapped, no suffix).
      expect(text).toContain('`isLocked`');
      expect(text).not.toContain('`isLocked (');
      expect(text).toMatch(/isLocked`.*unverified identity/);
      // A verified row carries no caveat.
      expect(text).toContain('`render`');
      const renderLine = text.split('\n').find((l) => l.includes('`render`'))!;
      expect(renderLine).not.toContain('unverified identity');
    });

    it('passes the ambiguous flag through raw output as structured data, not display text', () => {
      const els: CodeElementInfo[] = [
        { name: 'isLocked', filePath: 'src/guard.ts', startLine: 4, type: 'function', id: 'i1', ambiguous: true },
      ];
      const raw = formatCodeElementList(els, 'R', { ...mockMetadata, format: 'raw' }).data as CodeElementInfo[];
      expect(raw[0]!.name).toBe('isLocked');
      expect(raw[0]!.ambiguous).toBe(true);
    });

    // `iface-impl` and friends write CALLS edges at confidence 0.5 with
    // `provenanceInferred: true`; rendering them byte-identically to a
    // SCIP-proven edge is what the flag exists to prevent.
    it('renders an inferred-relationship caveat without touching the name', () => {
      const els: CodeElementInfo[] = [
        { name: 'guess', filePath: 'src/a.ts', startLine: 1, type: 'function', id: 'i1', provenanceInferred: true },
        { name: 'proven', filePath: 'src/b.ts', startLine: 2, type: 'function', id: 'i2' },
      ];
      const text = formatCodeElementList(els, 'R', mockMetadata).data as string;
      expect(text).toContain('`guess`');
      expect(text).not.toContain('`guess (');
      expect(text).toMatch(/guess`.*inferred call/);
      const provenLine = text.split('\n').find((l) => l.includes('`proven`'))!;
      expect(provenLine).not.toContain('inferred call');
    });

    it('passes the inferred flag through raw output as structured data, not display text', () => {
      const els: CodeElementInfo[] = [
        { name: 'guess', filePath: 'src/a.ts', startLine: 1, type: 'function', id: 'i1', provenanceInferred: true },
      ];
      const raw = formatCodeElementList(els, 'R', { ...mockMetadata, format: 'raw' }).data as CodeElementInfo[];
      expect(raw[0]!.name).toBe('guess');
      expect(raw[0]!.provenanceInferred).toBe(true);
      expect(JSON.stringify(raw)).not.toContain('inferred call');
    });

    // `kinds` survives the basic filter, so a class+entity row must render both
    // kinds instead of falling back to `type`.
    it('renders every collapsed kind for a dual-kind row', () => {
      const els: CodeElementInfo[] = [
        { name: 'User', filePath: 'src/user.ts', startLine: 1, type: 'class', kinds: ['class', 'entity'], id: 'i1' },
      ];
      const text = formatCodeElementList(els, 'R', mockMetadata).data as string;
      expect(text).toContain('`User` (class+entity)');
    });
  });

  describe('formatEntrypointList', () => {
    let mockEntrypoints: EntrypointInfo[];
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockEntrypoints = [
        {
          type: 'http',
          method: 'GET',
          path: '/users',
          fullPath: '/api/users',
          handlerId: 'handler1',
          handlerName: 'getUsers',
          filePath: 'src/routes.ts',
          startLine: 10,
          id: 'ep1',
        },
        {
          type: 'queue',
          topic: 'user-events',
          handlerId: 'handler2',
          handlerName: 'handleEvent',
          filePath: 'src/consumers.ts',
          startLine: 20,
          id: 'ep2',
        },
      ];

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format entrypoint list grouped by type', () => {
      const result = formatEntrypointList(mockEntrypoints, mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Entrypoints (2 total)');
      expect(result.data).toContain('### HTTP (1)');
      expect(result.data).toContain('**GET** `/api/users`');
      expect(result.data).toContain('### QUEUE (1)');
      expect(result.data).toContain('**Queue** `user-events`');
    });

    // A mobile entrypoint's only address is its component class name; without
    // the `mobile` arm it fell through to the bare `**mobile**` default and the
    // reader never saw which screen it is.
    it('formats a mobile entrypoint by its trigger and component class name', () => {
      const mobile: EntrypointInfo = {
        type: 'mobile',
        className: 'MainActivity',
        trigger: 'launcher',
        handlerId: 'handler4',
        handlerName: 'onCreate',
        filePath: 'app/src/main/java/com/example/MainActivity.kt',
        startLine: 12,
        id: 'ep4',
      };
      const result = formatEntrypointList([mobile], mockMetadata);

      expect(result.data).toContain('### MOBILE (1)');
      expect(result.data).toContain('**Mobile (launcher)** `MainActivity`');
    });

    // A mobile row from an older graph has no stored trigger; it must still
    // render its address rather than an empty parenthetical.
    it('falls back to the bare mobile form when no trigger is stored', () => {
      const mobile: EntrypointInfo = {
        type: 'mobile',
        className: 'SyncReceiver',
        handlerId: 'handler5',
        handlerName: 'onReceive',
        filePath: 'app/src/main/java/com/example/SyncReceiver.kt',
        startLine: 8,
        id: 'ep5',
      };
      const result = formatEntrypointList([mobile], mockMetadata);

      expect(result.data).toContain('**Mobile** `SyncReceiver`');
      expect(result.data).not.toContain('**Mobile ()**');
    });

    // The read side stays type-agnostic: an unknown type with an address
    // renders it like the queue arm does.
    it('renders the address of an unknown-type entrypoint', () => {
      const unknown = {
        type: 'legacy-unknown',
        topicValue: 'orders.v1',
        handlerId: 'handler6',
        handlerName: 'onOrder',
        filePath: 'src/consumer.ts',
        startLine: 4,
        id: 'ep6',
      } as unknown as EntrypointInfo;
      const result = formatEntrypointList([unknown], mockMetadata);

      expect(result.data).toContain('**legacy-unknown** `orders.v1`');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatEntrypointList(mockEntrypoints, mockMetadata);

      expect(result.data).toEqual(mockEntrypoints);
    });

    // dynamic-boundaries spec AC-3: an `unresolved:`-prefixed sentinel value
    // must render as "statically unresolvable", never as if it were the
    // literal topic — formatEntrypointExplanation already covers this; this
    // pins the list/summary path (list_entrypoints) too.
    it('renders an unresolved-sentinel topic as "statically unresolvable", not as a literal value', () => {
      const unresolvedEntrypoint: EntrypointInfo = {
        type: 'queue',
        topicValue: "unresolved:getTopicInNamespace('x')",
        handlerId: 'handler3',
        handlerName: 'handleDynamicEvent',
        filePath: 'src/dynamic-consumer.ts',
        startLine: 30,
        id: 'ep3',
      };
      const result = formatEntrypointList([unresolvedEntrypoint], mockMetadata);

      expect(result.data).not.toContain("`unresolved:getTopicInNamespace('x')`");
      expect(result.data).toContain("<statically unresolvable: getTopicInNamespace('x')>");
    });
  });

  describe('formatCallerList', () => {
    let mockCallers: CallerInfo[];
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockCallers = [
        {
          name: 'directCaller',
          filePath: 'src/direct.ts',
          startLine: 10,
          type: 'function',
          kind: 'function',
          id: 'caller1',
          distance: 1,
        },
        {
          name: 'indirectCaller',
          filePath: 'src/indirect.ts',
          startLine: 20,
          type: 'function',
          kind: 'function',
          id: 'caller2',
          distance: 3,
        },
      ];

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format caller list grouped by distance', () => {
      const result = formatCallerList(mockCallers, 'targetFunction', mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Callers of `targetFunction` (2)');
      expect(result.data).toContain('### Direct Callers (1)');
      expect(result.data).toContain('### Transitive Callers (1)');
      expect(result.data).toContain('[3 hops]');
    });

    // A caller reached over an inferred edge (sole-implementation guess) must
    // not read like a SCIP-proven one.
    it('marks a caller reached over an inferred edge, leaving proven ones unmarked', () => {
      const callers: CallerInfo[] = [
        { ...mockCallers[0]!, provenanceInferred: true },
        { ...mockCallers[1]!, distance: 1, name: 'provenCaller', id: 'caller3' },
      ];
      const text = formatCallerList(callers, 'targetFunction', mockMetadata).data as string;
      expect(text).toMatch(/directCaller`.*inferred call/);
      expect(text).toContain('`directCaller`');
      const provenLine = text.split('\n').find((l) => l.includes('`provenCaller`'))!;
      expect(provenLine).not.toContain('inferred call');
    });

    // Same discipline for a caller the substrate minted from a declaration convention: it has no
    // body, so it must not be listed as if it were a `def` someone can open.
    it('marks a synthesized caller, leaving the declared one unmarked', () => {
      const callers: CallerInfo[] = [
        { ...mockCallers[0]!, synthesized: 'ruby-association' },
        { ...mockCallers[1]!, distance: 1, name: 'declaredCaller', id: 'caller3' },
      ];
      const text = formatCallerList(callers, 'targetFunction', mockMetadata).data as string;
      const synthesizedLine = text.split('\n').find((l) => l.includes('`directCaller`'))!;
      const declaredLine = text.split('\n').find((l) => l.includes('`declaredCaller`'))!;

      expect(synthesizedLine).toContain('(synthesized: ruby-association — no body)');
      expect(declaredLine).not.toContain('synthesized');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatCallerList(mockCallers, 'targetFunction', mockMetadata);

      expect(result.data).toEqual({ callers: mockCallers, reachingEntrypoints: [], totalCallers: 2 });
    });
  });

  describe('formatEntityConsumers', () => {
    let mockConsumers: EntityConsumerInfo[];
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockConsumers = [
        {
          name: 'createUser',
          filePath: 'src/create.ts',
          startLine: 10,
          type: 'function',
          kind: 'function',
          id: 'consumer1',
          operation: 'create',
        },
        {
          name: 'getUser',
          filePath: 'src/get.ts',
          startLine: 20,
          type: 'function',
          kind: 'function',
          id: 'consumer2',
          operation: 'read',
        },
      ];

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format entity consumers grouped by operation', () => {
      const result = formatEntityConsumers(mockConsumers, 'User', mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Functions Operating on `User` (2)');
      expect(result.data).toContain('### CREATE (1)');
      expect(result.data).toContain('### READ (1)');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatEntityConsumers(mockConsumers, 'User', mockMetadata);

      expect(result.data).toEqual(mockConsumers);
    });
  });

  describe('formatServiceDependencies', () => {
    let mockDeps: ServiceDependencyResult[];
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockDeps = [
        {
          service: 'auth-service',
          callCount: 15,
          callTypes: ['http', 'grpc'],
          patterns: ['/auth/verify', '/auth/refresh'],
        },
      ];

      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format service dependencies', () => {
      const result = formatServiceDependencies(mockDeps, 'test-repo', mockMetadata);

      expect(typeof result.data).toBe('string');
      expect(result.data).toContain('## Service Dependencies of `test-repo` (1)');
      expect(result.data).toContain('### auth-service');
      expect(result.data).toContain('- **Calls:** 15');
      expect(result.data).toContain('- **Types:** http, grpc');
      expect(result.data).toContain('`/auth/verify`');
    });

    it('should return raw data in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatServiceDependencies(mockDeps, 'test-repo', mockMetadata);

      expect(result.data).toEqual(mockDeps);
    });
  });

  // =============================================================================
  // Error Formatter Tests
  // =============================================================================

  describe('formatError', () => {
    let mockMetadata: McpResponseMetadata;

    beforeEach(() => {
      mockMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('should format error in summary mode', () => {
      const result = formatError('Function not found', mockMetadata);

      expect(result.data).toBe('**Error:** Function not found');
    });

    it('should format error in raw mode', () => {
      mockMetadata.format = 'raw';
      const result = formatError('Function not found', mockMetadata);

      expect(result.data).toBe(JSON.stringify({ error: 'Function not found' }));
    });
  });
  // =============================================================================
  // Explicit-empty Tests (D6)
  //
  // Every list-shaped response used to render an empty result as banner + title
  // and stop, so neither the agent nor the eval gap detector could see that the
  // result was empty.
  // =============================================================================

  describe('explicit empty results', () => {
    let emptyMetadata: McpResponseMetadata;

    beforeEach(() => {
      emptyMetadata = {
        scope: mockScope,
        staleness: {
          warning: 'Data reflects parsed stable branch, not local changes',
          parsedAt: '2024-01-15T10:30:00.000Z',
        },
        format: 'summary',
      };
    });

    it('search_symbols / find_dependents: empty element list states 0 results', () => {
      const result = formatCodeElementList([], 'Search results for "OvertimeMode"', emptyMetadata);

      expect(result.data).toContain(ZERO_RESULTS_MARKER);
      expect(result.data).toContain('Search results for "OvertimeMode"');
      expect(result.resultCount).toBe(0);
    });

    it('list_entrypoints: empty list states 0 results', () => {
      const result = formatEntrypointList([], emptyMetadata);

      expect(result.data).toContain(ZERO_RESULTS_MARKER);
    });

    it('find_callers: empty caller list states 0 results', () => {
      const result = formatCallerList([], 'processShiftSummaries', emptyMetadata);

      expect(result.data).toContain(ZERO_RESULTS_MARKER);
      expect(result.data).toContain('processShiftSummaries');
    });

    it('find_entity_usage: empty consumer list states 0 results', () => {
      const result = formatEntityConsumers([], 'DailySummary', emptyMetadata);

      expect(result.data).toContain(ZERO_RESULTS_MARKER);
    });

    it('list_service_dependencies: empty list states 0 results', () => {
      const result = formatServiceDependencies([], 'acme-calculations', emptyMetadata);

      expect(result.data).toContain(ZERO_RESULTS_MARKER);
    });

    it('non-empty lists do not claim 0 results', () => {
      const result = formatCallerList(
        [
          {
            id: 'f1',
            name: 'caller',
            filePath: 'src/a.ts',
            startLine: 1,
            type: 'function',
            kind: 'function',
            distance: 1,
          },
        ],
        'target',
        emptyMetadata,
      );

      expect(result.data).not.toContain(ZERO_RESULTS_MARKER);
    });
  });

  // =============================================================================
  // Basic-detail escalation footer
  //
  // The list tools are basic-by-default, so every basic summary response has to
  // carry the exact re-call that widens it — otherwise the truncation reads as
  // "this is everything there is".
  // =============================================================================

  describe('basic-detail escalation footer', () => {
    const metadataAt = (detailLevel: 'basic' | 'full'): McpResponseMetadata => ({
      scope: mockScope,
      staleness: {
        warning: 'Data reflects parsed stable branch, not local changes',
        parsedAt: '2024-01-15T10:30:00.000Z',
      },
      format: 'summary',
      detailLevel,
    });

    const caller: CallerInfo = {
      id: 'abc123:function:src/a.ts:caller',
      name: 'caller',
      filePath: 'src/a.ts',
      startLine: 1,
      type: 'function',
      kind: 'function',
      distance: 1,
    };
    const element: CodeElementInfo = {
      id: 'abc123:function:src/users.ts:createUser',
      name: 'createUser',
      filePath: 'src/users.ts',
      startLine: 10,
      type: 'function',
    };
    const entrypoint: EntrypointInfo = {
      id: 'abc123:entrypoint:src/api.ts:get-users',
      type: 'http',
      method: 'GET',
      path: '/users',
      handlerId: 'h1',
      handlerName: 'getUsers',
      filePath: 'src/api.ts',
      startLine: 5,
    };
    const consumer: EntityConsumerInfo = {
      id: 'abc123:function:src/repo.ts:loadUser',
      name: 'loadUser',
      filePath: 'src/repo.ts',
      startLine: 3,
      type: 'function',
      operation: 'read',
    };

    const bodies = (detailLevel: 'basic' | 'full'): string[] => {
      const metadata = metadataAt(detailLevel);
      return [
        formatCodeElementList([element], 'Search Results', metadata).data as string,
        formatEntrypointList([entrypoint], metadata).data as string,
        formatCallerList([caller], 'target', metadata).data as string,
        formatEntityConsumers([consumer], 'User', metadata).data as string,
        formatChangeImpact(
          {
            target: element,
            riskLevel: 'low',
            impactSummary: '1 direct caller',
            directCallers: [caller],
            transitiveCallers: [],
            affectedEntrypoints: [],
            affectedTests: [],
          } as ChangeImpactResult,
          metadata,
        ).data as string,
      ];
    };

    it('every list-shaped summary ends with the full-detail re-call hint at basic', () => {
      for (const body of bodies('basic')) {
        expect(body.trimEnd().endsWith(DETAIL_ESCALATION_HINT)).toBe(true);
        expect(body).toContain('detailLevel: "full"');
      }
    });

    it('no footer at full — nothing left to escalate to', () => {
      for (const body of bodies('full')) {
        expect(body).not.toContain(DETAIL_ESCALATION_HINT);
      }
    });

    it('raw stays machine-shaped (no footer smuggled into the data)', () => {
      const metadata = { ...metadataAt('basic'), format: 'raw' as const };
      const result = formatCodeElementList([element], 'Search Results', metadata);

      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // =============================================================================
  // Extraction-coverage trust signals
  //
  // The two signals are distinct: the dispatch caveat covers edges that exist
  // but under-resolve at any density; the blind-category block covers
  // categories with no edge to be sparse, which no density can ever flag. Both
  // must survive a fully healthy repo, which is the case that misled an agent.
  // =============================================================================

  describe('formatExtractionCoverage trust signals', () => {
    const coverageMetadata: McpResponseMetadata = {
      scope: mockScope,
      staleness: {
        warning: 'Data reflects parsed stable branch, not local changes',
        parsedAt: '2024-01-15T10:30:00.000Z',
      },
      format: 'summary',
      detailLevel: 'basic',
    };

    const healthyStats = (repoName: string): RepoCoverageStats => ({
      repoName,
      nodeCountsByType: { function: 100, entity: 10 },
      entityCount: 10,
      entitiesWithDbOps: 8,
      functionCount: 100,
      functionsWithCalls: 90,
      callResolution: { callSites: 200, resolvedCalls: 150, outOfScopeCalls: 40 },
      dbOpResolution: { dbOpSites: 90, boundDbOps: 40, outOfScopeDbOps: 30 },
      externalCallCount: 20,
      resolvedExternalCallCount: 18,
      externalResolutionRate: 0.9,
      guidance: [],
    });

    it.each([
      ['basic', false, true, 'basic (fallback); compiler receiver facts unavailable'],
      ['enhanced', false, false, 'enhanced; compiler receiver facts unavailable'],
      ['enhanced', true, false, 'enhanced; compiler receiver facts available'],
    ] as const)('discloses %s analysis and receiver capability (%s)', (mode, compilerReceiverTypes, fallback, text) => {
      const body = formatExtractionCoverage(
        [
          {
            ...healthyStats('svc'),
            analysis: [{ language: 'csharp', target: 'api', mode, compilerReceiverTypes, fallback }],
          },
        ],
        coverageMetadata,
      ).data as string;
      expect(body).toContain(`**Analysis — api (csharp):** ${text}`);
    });

    it('renders in-repo call resolution over counted sites, with no percent on the dbOp line', () => {
      const body = formatExtractionCoverage([healthyStats('svc')], coverageMetadata).data as string;

      expect(body).toContain(
        '- **In-repo call resolution:** 150/160 counted sites bound (94%); 40 of 200 counted sites name nothing declared in this repository',
      );
      expect(body).toContain(
        '- **DB operations:** 40/60 counted sites bound (67%); 30 of 90 counted sites name no entity or table declared in this repository; 8 of 10 entities have at least one recorded operation',
      );
      expect(body).not.toContain('functions have ≥1 call');
    });

    it('renders the zero-in-scope and not-measured db-operation renderings distinctly', () => {
      const allOutOfScope = formatExtractionCoverage(
        [{ ...healthyStats('svc'), dbOpResolution: { dbOpSites: 9, boundDbOps: 0, outOfScopeDbOps: 9 } }],
        coverageMetadata,
      ).data as string;
      const { dbOpResolution: _dropDbOp, ...unmeasuredDbOp } = healthyStats('svc');
      const notMeasured = formatExtractionCoverage([unmeasuredDbOp], coverageMetadata).data as string;

      expect(allOutOfScope).toContain(
        '- **DB operations:** no counted db-operation site names an entity or table declared in this repository (9 counted sites, all out of scope); 8 of 10 entities have at least one recorded operation',
      );
      expect(notMeasured).toContain(
        "- **DB operations:** resolution not measured by this graph's parser — re-parse and re-push to measure; 8 of 10 entities have at least one recorded operation",
      );
      for (const line of notMeasured.split('\n')) {
        if (line.includes('DB operations')) expect(line).not.toContain('%');
      }
    });

    it('renders the zero-in-scope case distinctly from the not-measured case', () => {
      const allOutOfScope = formatExtractionCoverage(
        [{ ...healthyStats('svc'), callResolution: { callSites: 12, resolvedCalls: 0, outOfScopeCalls: 12 } }],
        coverageMetadata,
      ).data as string;
      const { callResolution: _drop, ...unmeasured } = healthyStats('svc');
      const notMeasured = formatExtractionCoverage([unmeasured], coverageMetadata).data as string;

      expect(allOutOfScope).toContain(
        '- **In-repo call resolution:** no counted call site names a declaration in this repository (12 counted sites, all out of scope)',
      );
      expect(notMeasured).toContain(
        "- **In-repo call resolution:** not measured by this graph's parser — re-parse and re-push to measure",
      );
    });

    // A MEASURED all-zero record is what the engine emits for a repo with no call/db-op site; it
    // is not "all out of scope" (nothing was counted to be in or out of scope), and an impossible
    // record must name itself rather than be clamped into either sentence.
    it('distinguishes a zero-site record and an impossible one from "all out of scope"', () => {
      const zeroSites = formatExtractionCoverage(
        [
          {
            ...healthyStats('svc'),
            callResolution: { callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 },
            dbOpResolution: { dbOpSites: 0, boundDbOps: 0, outOfScopeDbOps: 0 },
          },
        ],
        coverageMetadata,
      ).data as string;
      const inconsistent = formatExtractionCoverage(
        [
          {
            ...healthyStats('svc'),
            callResolution: { callSites: 10, resolvedCalls: 0, outOfScopeCalls: 40 },
            dbOpResolution: { dbOpSites: 10, boundDbOps: 80, outOfScopeDbOps: 0 },
          },
        ],
        coverageMetadata,
      ).data as string;

      expect(zeroSites).toContain('- **In-repo call resolution:** no call site was counted for this scope');
      expect(zeroSites).toContain(
        '- **DB operations:** no db-operation site was counted for this scope; 8 of 10 entities have at least one recorded operation',
      );
      expect(zeroSites).not.toContain('all out of scope');

      expect(inconsistent).toContain(
        '- **In-repo call resolution:** inconsistent call-resolution record — re-parse and re-push (0 bound, 40 out of scope over 10 counted sites)',
      );
      expect(inconsistent).toContain(
        '- **DB operations:** inconsistent db-operation-resolution record — re-parse and re-push (80 bound, 0 out of scope over 10 counted sites)',
      );
      // Neither rendering may print a rate: there is no honest denominator behind one.
      for (const line of [...zeroSites.split('\n'), ...inconsistent.split('\n')]) {
        if (line.includes('In-repo call resolution') || line.includes('DB operations')) {
          expect(line).not.toContain('%');
        }
      }
    });

    it('never prints LOW for the call or dbOp categories', () => {
      const body = formatExtractionCoverage([healthyStats('svc')], coverageMetadata).data as string;

      for (const line of body.split('\n')) {
        if (line.includes('In-repo call resolution') || line.includes('DB operations')) {
          expect(line).not.toContain('LOW');
        }
      }
      expect(body).not.toContain('dbOp coverage LOW');
      expect(body).not.toContain('call coverage LOW');
    });

    it('renders the blind-category block even when no density flag fires', () => {
      const body = formatExtractionCoverage([healthyStats('svc')], coverageMetadata).data as string;

      expect(body).toContain(NO_LOW_COVERAGE_FLAGS);
      expect(body).toContain(STRUCTURALLY_BLIND_HEADING);
      for (const line of structurallyBlindGuidanceLines()) {
        expect(body).toContain(`- ${line}`);
      }
    });

    it('adds the substrate-conditional entries the scope’s reported languages prove applicable', () => {
      const rubyBody = formatExtractionCoverage([{ ...healthyStats('svc'), primaryLanguage: 'ruby' }], coverageMetadata)
        .data as string;
      const tsBody = formatExtractionCoverage(
        [{ ...healthyStats('svc'), primaryLanguage: 'typescript' }],
        coverageMetadata,
      ).data as string;

      for (const line of structurallyBlindGuidanceLines({ languages: ['ruby'] })) {
        expect(rubyBody).toContain(`- ${line}`);
      }
      // The TS substrate binds hierarchy, so the response must not tell that agent it is blind.
      expect(rubyBody).toContain('EXTENDS and IMPLEMENTS_INTERFACE edges are bound');
      expect(tsBody).not.toContain('EXTENDS and IMPLEMENTS_INTERFACE edges are bound');
    });

    it('keeps the dynamic-dispatch caveat alongside it (distinct signals)', () => {
      const body = formatExtractionCoverage([healthyStats('svc')], coverageMetadata).data as string;

      expect(body).toContain(DYNAMIC_DISPATCH_CAVEAT);
      expect(body).toContain(STRUCTURALLY_BLIND_HEADING);
    });

    it('prints the block exactly once for a multi-repo scope (no per-repo bloat)', () => {
      const body = formatExtractionCoverage(
        [healthyStats('svc-a'), healthyStats('svc-b'), healthyStats('svc-c')],
        coverageMetadata,
      ).data as string;

      expect(body.split(STRUCTURALLY_BLIND_HEADING)).toHaveLength(2);
      const [firstBlindLine] = structurallyBlindGuidanceLines();
      expect(body.split(firstBlindLine!)).toHaveLength(2);
    });

    it('raw format stays machine-shaped (guidance prose never enters the data)', () => {
      const result = formatExtractionCoverage([healthyStats('svc')], { ...coverageMetadata, format: 'raw' });

      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  describe('formatExplain — metadata rendering', () => {
    const explainMetadata = (): McpResponseMetadata => ({
      scope: mockScope,
      staleness: {
        warning: 'Data reflects parsed stable branch, not local changes',
        parsedAt: '2024-01-15T10:30:00.000Z',
      },
      format: 'summary',
      detailLevel: 'basic',
    });

    const classResult = (over: Partial<ExplainMetadata> = {}): ExplainResult => ({
      target: 'BookingService',
      resolution: 'metadata',
      metadata: {
        name: 'BookingService',
        kind: 'class',
        filePath: 'src/svc.ts',
        startLine: 5,
        usageCount: 3,
        ...over,
      },
    });

    it('names the relation the usage figure counts', () => {
      const body = formatExplain(classResult({ usageRelation: 'type references + subclasses' }), explainMetadata())
        .data as string;

      expect(body).toContain('**Usages (type references + subclasses):** 3');
    });

    it('falls back to a bare Usages label when no relation was supplied', () => {
      const body = formatExplain(classResult(), explainMetadata()).data as string;

      expect(body).toContain('**Usages:** 3');
    });

    it('renders the usage note as a sub-line under the usage figure', () => {
      const body = formatExplain(
        classResult({
          usageRelation: 'type references + member-value reads where extracted',
          usageNote: '1 of 3 usages are member-value reads (branches on Status.Locked)',
        }),
        explainMetadata(),
      ).data as string;

      expect(body).toContain('**Usages (type references + member-value reads where extracted):** 3');
      expect(body).toContain('1 of 3 usages are member-value reads (branches on Status.Locked)');
    });

    it('omits the usage-note sub-line when there is no breakdown', () => {
      const body = formatExplain(classResult(), explainMetadata()).data as string;

      expect(body).not.toContain('member-value reads');
    });

    it('renders the class methods as their own section with the overflow line', () => {
      const body = formatExplain(
        classResult({ methods: ['createBooking()', 'closeBooking()'], methodsTotal: 5 }),
        explainMetadata(),
      ).data as string;

      expect(body).toContain('### Methods (5)');
      expect(body).toContain('- createBooking()');
      expect(body).toContain('- ... and 3 more');
    });

    it('omits the methods section when the class has none', () => {
      const body = formatExplain(classResult(), explainMetadata()).data as string;

      expect(body).not.toContain('### Methods');
    });
  });
});
