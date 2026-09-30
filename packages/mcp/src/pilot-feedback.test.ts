import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeType } from '@coredoc/core';
import {
  createMockRepository,
  createMockCodeElement,
  createMockEntrypointInfo,
  createMockCoverageCounts,
  createMockFunctionInfo,
} from './__tests__/fixtures/mock-repository.js';
import { resolveDetailLevel } from './detail-level.js';
import { handleSearchSymbols } from './tools/discovery/search-symbols.js';
import { handleFindCallers } from './tools/impact/find-callers.js';
import { handleExplain } from './tools/understanding/explain.js';
import { handleTraceCrossRepoCall } from './tools/cross-repo/trace-cross-repo-call.js';
import { createMetadata, formatStalenessHeader } from './response-formatter.js';
import { TOOL_INPUT_SCHEMAS, TOOL_SCHEMAS } from './tool-schemas.js';
import type { ExplainResult, ScopeContext } from './types.js';

const scope: ScopeContext = {
  currentPath: '/fixture',
  resolvedRepos: ['api'],
  repoHashes: ['api-hash'],
  crossRepoEnabled: false,
};
const config = resolveDetailLevel('basic');

afterEach(() => vi.unstubAllEnvs());

describe('pilot feedback: evidence boundaries', () => {
  it.each(['summary', 'raw'] as const)('qualifies a literal miss in %s output', async (format) => {
    const response = await handleSearchSymbols(
      { query: 'ot_token' },
      scope,
      format,
      'basic',
      config,
      createMockRepository(),
    );
    expect(response.metadata.warnings?.join(' ')).toMatch(/not.*(?:absence|absent)|not prove/i);
    expect(response.metadata.warnings?.join(' ')).toMatch(/literal|source text/i);
    if (format === 'summary') {
      expect(response.data).toContain(response.metadata.warnings![0]);
    } else {
      expect(response.data).toEqual([]);
    }
  });

  it('does not return other kinds as matches for an explicit entrypoint filter', async () => {
    const findCode = vi
      .fn()
      .mockImplementation(async ({ types }: { types: NodeType[] }) =>
        types.includes(NodeType.Function)
          ? [createMockCodeElement({ name: 'attachment', type: NodeType.Function })]
          : [],
      );
    const response = await handleSearchSymbols(
      { query: 'attachment', type: 'entrypoint' },
      scope,
      'raw',
      'basic',
      config,
      createMockRepository({ findCode }),
    );
    expect(response.data).toEqual([]);
    expect(findCode.mock.calls.every(([params]) => !params.types.includes(NodeType.Function))).toBe(true);
  });

  it.each([
    'summary',
    'raw',
  ] as const)('retains low-coverage evidence on empty caller results in %s', async (format) => {
    const repo = createMockRepository({
      findFunction: vi.fn().mockResolvedValue(createMockFunctionInfo({ name: 'syncAttachments' })),
      getCoverageCounts: vi.fn().mockResolvedValue([
        createMockCoverageCounts({
          callResolution: { callSites: 100, resolvedCalls: 28, outOfScopeCalls: 0 },
        }),
      ]),
    });
    const response = await handleFindCallers({ functionName: 'syncAttachments' }, scope, format, 'basic', config, repo);
    expect(response.metadata.warnings?.join(' ')).toContain('72 of 100 counted in-repo call sites are unbound');
    if (format === 'summary') expect(String(response.data).startsWith(response.metadata.warnings![0]!)).toBe(true);
    else expect(response.data).toEqual({ callers: [], reachingEntrypoints: [], totalCallers: 0 });
  });

  it('rejects unknown parameters rather than dropping repository filtering', () => {
    expect(TOOL_SCHEMAS.list_entrypoints.safeParse({ repository: 'api' }).success).toBe(false);
    expect(TOOL_INPUT_SCHEMAS.list_entrypoints.additionalProperties).toBe(false);
    expect(TOOL_SCHEMAS.list_entrypoints.parse({ scope: 'api' })).toEqual({ scope: 'api' });
  });

  it('keeps each repository snapshot visible instead of presenting the newest as the entire scope', async () => {
    const repo = createMockRepository({
      getRepoOverview: vi.fn().mockResolvedValue([
        { name: 'api', parsedAt: '2026-06-01T00:00:00Z', gitCommitHash: 'old-api', parserVersion: '1.0' },
        { name: 'web', parsedAt: '2026-09-01T00:00:00Z', gitCommitHash: 'new-web', parserVersion: '1.1' },
      ]),
    });
    const metadata = await createMetadata(
      { ...scope, resolvedRepos: ['api', 'web'], repoHashes: ['api-hash', 'web-hash'] },
      'raw',
      'basic',
      config,
      repo,
    );
    expect(metadata.staleness.parsedAt).toBe('unknown');
    expect(metadata.staleness.parsedCommit).toBeUndefined();
    expect(metadata.staleness.repositories).toEqual([
      { name: 'api', parsedAt: '2026-06-01T00:00:00Z', parsedCommit: 'old-api', parserVersion: '1.0' },
      { name: 'web', parsedAt: '2026-09-01T00:00:00Z', parsedCommit: 'new-web', parserVersion: '1.1' },
    ]);
    const text = formatStalenessHeader(metadata.staleness);
    for (const value of ['api', 'web', '2026-06-01', '2026-09-01', 'old-api', 'new-web']) expect(text).toContain(value);
  });

  it('includes repository snapshots in a cross-repo trace summary', async () => {
    const repo = createMockRepository({
      listEntrypoints: vi
        .fn()
        .mockResolvedValue([
          createMockEntrypointInfo({ id: 'web-hash:entrypoint:login', path: '/login', fullPath: '/login' }),
        ]),
      getRepoOverview: vi.fn().mockResolvedValue([
        { name: 'api', parsedAt: '2026-06-01', gitCommitHash: 'api-commit' },
        { name: 'web', parsedAt: '2026-09-01', gitCommitHash: 'web-commit' },
      ]),
    });
    const response = await handleTraceCrossRepoCall(
      { callPattern: '/login' },
      { ...scope, resolvedRepos: ['api', 'web'], repoHashes: ['api-hash', 'web-hash'] },
      'summary',
      'basic',
      config,
      repo,
    );
    expect(response.data).toContain('api-commit');
    expect(response.data).toContain('web-commit');
  });

  it('does not assign a scope-wide snapshot when only one of several repositories has metadata', async () => {
    const repo = createMockRepository({
      getRepoOverview: vi
        .fn()
        .mockResolvedValue([{ name: 'api', parsedAt: '2026-06-01T00:00:00Z', gitCommitHash: 'api-commit' }]),
    });
    const metadata = await createMetadata(
      { ...scope, resolvedRepos: ['api', 'web'], repoHashes: ['api-hash', 'web-hash'] },
      'raw',
      'basic',
      config,
      repo,
    );
    expect(metadata.staleness.parsedAt).toBe('unknown');
    expect(metadata.staleness.parsedCommit).toBeUndefined();
    expect(metadata.staleness.repositories).toEqual([
      { name: 'api', parsedAt: '2026-06-01T00:00:00Z', parsedCommit: 'api-commit' },
    ]);
  });

  it.each([
    NodeType.Interface,
    NodeType.TypeAlias,
    NodeType.Enum,
  ])('explains why a %s has no raw source body', async (type) => {
    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    const element = createMockCodeElement({ name: 'Token', type });
    const repo = createMockRepository({ findCode: vi.fn().mockResolvedValue([element]) });
    const response = await handleExplain({ target: 'Token', includeSource: true }, scope, 'raw', 'basic', config, repo);
    expect((response.data as ExplainResult).metadata?.sourceUnavailableReason).toBe('not-stored-for-kind');
    expect(repo.getNodeWithProperties).not.toHaveBeenCalled();
  });

  it('returns the complete available DTO contract when source is requested', async () => {
    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    const element = createMockCodeElement({ name: 'Token', type: NodeType.Interface });
    const members = Array.from({ length: 12 }, (_, i) => ({
      name: `field${i}`,
      kind: 'property',
      typeText: 'string',
      isOptional: true,
    }));
    const repo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([element]),
      findInterface: vi.fn().mockResolvedValue({ id: element.id, members }),
    });
    const response = await handleExplain(
      { target: 'Token', includeSource: true },
      scope,
      'summary',
      'basic',
      config,
      repo,
    );
    expect(response.data).toContain('Raw source bodies are not stored');
    for (const member of members) expect(response.data).toContain(`${member.name}?: string`);
  });

  it('explains unavailable type contents and requested source without inventing an empty contract', async () => {
    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'true');
    const repo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([createMockCodeElement({ name: 'Token', type: NodeType.Interface })]),
    });
    const response = await handleExplain({ target: 'Token', includeSource: true }, scope, 'raw', 'basic', config, repo);
    const metadata = (response.data as ExplainResult).metadata;
    expect(metadata?.sourceUnavailableReason).toBe('not-stored-for-kind');
    expect(metadata?.structureNote).toMatch(/source/i);
    expect(metadata?.fields).toBeUndefined();
  });

  it('does not read or expose type source when source-in-graph is disabled', async () => {
    vi.stubEnv('ALLOW_SOURCES_IN_GRAPH', 'false');
    const repo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([createMockCodeElement({ name: 'Token', type: NodeType.TypeAlias })]),
    });
    const response = await handleExplain({ target: 'Token', includeSource: true }, scope, 'raw', 'basic', config, repo);
    expect(repo.getNodeWithProperties).not.toHaveBeenCalled();
    expect((response.data as ExplainResult).metadata?.sourceUnavailableReason).toBe('disabled');
  });
});
