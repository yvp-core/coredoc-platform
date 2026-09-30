/**
 * explain detailLevel default — compact-by-default regression tests.
 *
 * The dispatchers used to resolve an omitted `detailLevel` to 'full' for every
 * tool, which uncapped explain's inline field/value previews and contradicted
 * its tool description ("Default detail is compact … `detailLevel: "full"`
 * expands everything"). The fix resolves explain's omitted detailLevel to
 * 'basic' at dispatch (getDefaultDetailLevel('explain')), so only an explicit
 * 'full' uncaps the previews — while explain still forwards the full config to
 * its function/entrypoint sub-dispatches when the param was omitted (an
 * omitted param must not strip AI summaries from a function explain).
 *
 * Deliberately a separate file from explain.test.ts (which carries unrelated
 * in-flight changes).
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import { handleExplain } from './explain.js';
import { getDefaultDetailLevel } from '../../detail-level.js';
import { TOOL_INPUT_SCHEMAS } from '../../tool-schemas.js';
import type { ScopeContext, DetailLevelConfig, ExplainResult } from '../../types.js';
import { createMockRepository, createMockCodeElement } from '../../__tests__/fixtures/mock-repository.js';

// Partial mock: keeps the real value exports (e.g. CypherResultShape, pulled in
// transitively by tool-schemas.ts) while stubbing repository access.
vi.mock('@coredoc/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@coredoc/db')>()),
  getRepository: vi.fn(),
}));
vi.mock('./explain-function.js', () => ({
  handleExplainFunction: vi.fn(),
}));
vi.mock('./explain-entrypoint.js', () => ({
  handleExplainEntrypoint: vi.fn(),
}));
vi.mock('../discovery/describe-db-schema.js', () => ({
  handleDescribeDbSchema: vi.fn(),
}));
// Pass-through formatter so tests can inspect the structured ExplainResult.
vi.mock('../../response-formatter.js', () => ({
  formatExplain: vi.fn((result, metadata) => ({ data: result, metadata })),
  createMetadata: vi.fn((scope, format) => ({ scope, format })),
  resolveRepoName: vi.fn(() => undefined),
}));

import { handleExplainFunction } from './explain-function.js';
import { handleExplainEntrypoint } from './explain-entrypoint.js';

const scope: ScopeContext = {
  currentPath: '/test/repo',
  resolvedRepos: ['svc'],
  repoHashes: ['abc123'],
  crossRepoEnabled: false,
};

// What the dispatcher passes for an OMITTED detailLevel (explain-specific default).
const basicConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: false,
  includeRefs: false,
  includeFullDetails: false,
};
// What the dispatcher passes for an EXPLICIT detailLevel:'full'.
const fullConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

/** Interface with more members than the MAX_FIELD_PREVIEW cap (40). */
function wideInterfaceRepo() {
  const iface = createMockCodeElement({
    id: 'abc123:interface:src/wide.ts:WideIface',
    name: 'WideIface',
    type: 'interface',
    filePath: 'src/wide.ts',
    startLine: 1,
  });
  return createMockRepository({
    findCode: vi.fn().mockResolvedValue([iface]),
    getTypeUsages: vi.fn().mockResolvedValue([]),
    getInterfaceImplementations: vi.fn().mockResolvedValue([]),
    findInterface: vi.fn().mockResolvedValue({
      id: iface.id,
      name: 'WideIface',
      filePath: 'src/wide.ts',
      startLine: 1,
      endLine: 50,
      isExported: true,
      members: Array.from({ length: 45 }, (_, i) => ({ name: `field${i}`, kind: 'property', typeText: 'string' })),
    }),
  });
}

describe('getDefaultDetailLevel — per-tool omitted-param default', () => {
  it("resolves explain's omitted detailLevel to basic (compact previews)", () => {
    expect(getDefaultDetailLevel('explain')).toBe('basic');
  });

  it('resolves the list-shaped tools to basic as well', () => {
    expect(getDefaultDetailLevel('search_symbols')).toBe('basic');
    expect(getDefaultDetailLevel('find_callers')).toBe('basic');
  });

  it('keeps full for non-list tools and when no tool name is given', () => {
    expect(getDefaultDetailLevel('describe_db_schema')).toBe('full');
    expect(getDefaultDetailLevel()).toBe('full');
  });
});

describe('handleExplain — compact previews by default', () => {
  it('omitted detailLevel (dispatcher-resolved basic) caps a wide interface preview at 40 members', async () => {
    const mockRepo = wideInterfaceRepo();

    const result = await handleExplain({ target: 'WideIface' }, scope, 'raw', 'basic', basicConfig, mockRepo);

    const meta = (result.data as ExplainResult).metadata;
    expect(meta?.fieldsTotal).toBe(45);
    // Capped list → the formatter renders the "... and 5 more" overflow line.
    expect(meta?.fields).toHaveLength(40);
  });

  it("explicit detailLevel:'full' uncaps the interface preview", async () => {
    const mockRepo = wideInterfaceRepo();

    const result = await handleExplain(
      { target: 'WideIface', detailLevel: 'full' },
      scope,
      'raw',
      'full',
      fullConfig,
      mockRepo,
    );

    const meta = (result.data as ExplainResult).metadata;
    expect(meta?.fieldsTotal).toBe(45);
    expect(meta?.fields).toHaveLength(45);
  });

  it('omitted detailLevel truncates enum values with +N more; explicit full shows all', async () => {
    const enumElement = createMockCodeElement({
      id: 'abc123:enum:src/big.ts:BigEnum',
      name: 'BigEnum',
      type: 'enum',
      filePath: 'src/big.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([enumElement]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      findEnum: vi.fn().mockResolvedValue({
        id: enumElement.id,
        name: 'BigEnum',
        filePath: 'src/big.ts',
        startLine: 1,
        endLine: 20,
        isExported: true,
        members: Array.from({ length: 15 }, (_, i) => ({ name: `M${i}`, value: `v${i}` })),
      }),
    });

    const compact = await handleExplain({ target: 'BigEnum' }, scope, 'raw', 'basic', basicConfig, mockRepo);
    expect((compact.data as ExplainResult).metadata?.fields?.[0]).toContain('+3 more');

    const full = await handleExplain(
      { target: 'BigEnum', detailLevel: 'full' },
      scope,
      'raw',
      'full',
      fullConfig,
      mockRepo,
    );
    expect((full.data as ExplainResult).metadata?.fields?.[0]).not.toContain('more');
  });
});

describe('handleExplain — sub-dispatches keep their full structure at the omitted default', () => {
  it('omitted detailLevel forwards the full config to the function dispatch', async () => {
    (handleExplainFunction as Mock).mockResolvedValue({ data: 'fn explanation', metadata: { format: 'raw' } });
    const fn = createMockCodeElement({
      id: 'abc123:function:src/do.ts:doThing',
      name: 'doThing',
      type: 'function',
      filePath: 'src/do.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({ findCode: vi.fn().mockResolvedValue([fn]) });

    await handleExplain({ target: 'doThing' }, scope, 'raw', 'basic', basicConfig, mockRepo);

    expect(handleExplainFunction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'doThing' }),
      scope,
      'raw',
      'full',
      expect.objectContaining({ includeSummaries: true, includeFullDetails: true }),
      mockRepo,
    );
  });

  it('omitted detailLevel forwards the full config to the entrypoint dispatch', async () => {
    (handleExplainEntrypoint as Mock).mockResolvedValue({ data: 'ep explanation', metadata: { format: 'raw' } });
    const mockRepo = createMockRepository({});

    await handleExplain({ target: 'POST /v1/things' }, scope, 'raw', 'basic', basicConfig, mockRepo);

    expect(handleExplainEntrypoint).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'POST /v1/things' }),
      scope,
      'raw',
      'full',
      expect.objectContaining({ includeSummaries: true, includeFullDetails: true }),
      mockRepo,
    );
  });

  it("explicit detailLevel:'basic' narrows the function dispatch too", async () => {
    (handleExplainFunction as Mock).mockResolvedValue({ data: 'fn explanation', metadata: { format: 'raw' } });
    const fn = createMockCodeElement({
      id: 'abc123:function:src/do.ts:doThing',
      name: 'doThing',
      type: 'function',
      filePath: 'src/do.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({ findCode: vi.fn().mockResolvedValue([fn]) });

    await handleExplain({ target: 'doThing', detailLevel: 'basic' }, scope, 'raw', 'basic', basicConfig, mockRepo);

    expect(handleExplainFunction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'doThing' }),
      scope,
      'raw',
      'basic',
      expect.objectContaining({ includeSummaries: false, includeFullDetails: false }),
      mockRepo,
    );
  });
});

describe('detailLevel schema text — each tool states ITS actual default', () => {
  const detailDescription = (tool: keyof typeof TOOL_INPUT_SCHEMAS): string =>
    (TOOL_INPUT_SCHEMAS[tool].properties.detailLevel as { description?: string } | undefined)?.description ?? '';

  it('explain no longer advertises full as the default and documents the compact previews', () => {
    const desc = detailDescription('explain');
    expect(desc).not.toMatch(/;\s*default\)/);
    expect(desc.toLowerCase()).toContain('compact');
  });

  it('describe_db_schema documents its compact whole-schema default', () => {
    const desc = detailDescription('describe_db_schema');
    expect(desc).not.toMatch(/;\s*default\)/);
    expect(desc.toLowerCase()).toContain('compact');
  });

  it('list-shaped tools advertise basic as the default, never full', () => {
    const basicDefaultTools = [
      'analyze_change_impact',
      'find_callers',
      'find_dependents',
      'find_entity_usage',
      'search_symbols',
      'list_entrypoints',
      'trace_cross_repo_call',
    ] as const;
    for (const tool of basicDefaultTools) {
      const desc = detailDescription(tool);
      // The old text advertised full as the default ("…callees; default)").
      expect(desc).not.toMatch(/;\s*default\)/);
      expect(desc).toMatch(/basic.*DEFAULT/);
    }
  });
});
