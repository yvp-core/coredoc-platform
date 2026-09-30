/**
 * Tests for the explain tool handler.
 *
 * Each test pins one branch of the resolver:
 *   - HTTP-shaped target → explain_entrypoint dispatch
 *   - Qualified name → explain_function dispatch
 *   - Bare name with 1 exact hit → metadata or function dispatch
 *   - Multiple exact hits → disambiguation
 *   - No exact hit + substring hits → fuzzy
 *   - No hits at all → not-found
 *   - Empty target / cross-repo (no scope) → boundary behavior
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { TypeUseKind } from '@coredoc/db/types';
import { handleExplain, looksLikeFilePath, looksLikeHttpPath } from './explain.js';
import type { ScopeContext, DetailLevel, DetailLevelConfig, ExplainResult } from '../../types.js';
import {
  createMockRepository,
  createMockCodeElement,
  createMockEntrypointInfo,
} from '../../__tests__/fixtures/mock-repository.js';

// Mock DB
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

// Mock the two dispatcher targets so we can assert call shape and return
// canned successful payloads.
vi.mock('./explain-function.js', () => ({
  handleExplainFunction: vi.fn(),
}));
vi.mock('./explain-entrypoint.js', () => ({
  handleExplainEntrypoint: vi.fn(),
}));
// Entities dispatch to describe_db_schema — mock it like the other dispatchers.
vi.mock('../discovery/describe-db-schema.js', () => ({
  handleDescribeDbSchema: vi.fn(),
}));
// Bare file-path targets render through list_file_symbols — mock it like the
// other dispatchers so we can assert the delegation.
vi.mock('../discovery/list-file-symbols.js', () => ({
  handleListFileSymbols: vi.fn(),
}));

// Pass-through formatter so we can inspect the structured ExplainResult.
vi.mock('../../response-formatter.js', () => ({
  formatExplain: vi.fn((result, metadata) => ({ data: result, metadata })),
  createMetadata: vi.fn((scope, format) => ({
    scope,
    staleness: { warning: 'stale', parsedAt: '2026-05-14T00:00:00Z' },
    format,
  })),
  // Single-repo scope in these tests → no repo annotation.
  resolveRepoName: vi.fn(() => undefined),
}));

import { handleExplainFunction } from './explain-function.js';
import { handleExplainEntrypoint } from './explain-entrypoint.js';
import { handleDescribeDbSchema } from '../discovery/describe-db-schema.js';
import { handleListFileSymbols } from '../discovery/list-file-symbols.js';

const defaultLevel: DetailLevel = 'full';
const defaultConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

describe('looksLikeHttpPath', () => {
  it.each([
    ['/api/users', true],
    ['POST /v1/foo', true],
    ['GET /', true],
    ['DELETE /companies/{id}/users', true],
    ['BookingService.createBooking', false],
    ['Calculator', false],
    ['get /lowercase-method', true], // case-insensitive method match — agents type both
    ['POSTwithoutspace', false],
    ['', false],
    // Pages-API / file-convention routes are stored (and printed by
    // list_entrypoints) with the wildcard verb — accept it as HTTP-shaped.
    ['ALL /api/ai/sql/generate-v4', true],
    ['ANY /api/foo', true],
    ['all /api/foo', true],
  ])('classifies %j correctly', (input, expected) => {
    expect(looksLikeHttpPath(input)).toBe(expected);
  });
});

describe('looksLikeFilePath', () => {
  it.each([
    ['apps/studio/pages/project/[ref]/auth/users.tsx', true],
    ['packages/pg-meta/src/index.ts', true],
    ['src/foo.py', true],
    ['src/Config.zig', true],
    // no directory separator — a bare filename is indistinguishable from a
    // dotted symbol name (`Foo.bar`), so it stays on the symbol path.
    ['users.tsx', false],
    // a directory, not a file
    ['packages/pg-meta', false],
    // qualified symbol names and HTTP paths must never be read as files
    ['BookingService.createBooking', false],
    ['POST /v1/foo', false],
    // path:line keeps its own branch
    ['src/foo.ts:42', false],
    ['', false],
  ])('classifies %j correctly', (input, expected) => {
    expect(looksLikeFilePath(input)).toBe(expected);
  });
});

describe('handleExplain', () => {
  let scope: ScopeContext;

  beforeEach(() => {
    scope = {
      currentPath: '/test/repo',
      resolvedRepos: ['svc'],
      repoHashes: ['abc123'],
      crossRepoEnabled: false,
    };
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // HTTP / entrypoint dispatch
  // ---------------------------------------------------------------------------
  it('passes through explain_entrypoint response on HTTP-shaped target', async () => {
    // After the 2026-05-14 dispatch-swallowing fix, explain returns the
    // sub-tool's response verbatim — we don't re-wrap into ExplainResult.
    // This preserves the formatted prose in summary mode (otherwise the
    // function/entrypoint payload got reduced to a stub).
    const subResponse = {
      data: { handler: { name: 'list' }, callTree: [], entrypoint: { type: 'http', path: '/v1/foo' } },
      metadata: { format: 'raw' },
    };
    (handleExplainEntrypoint as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({});

    const result = await handleExplain({ target: 'POST /v1/foo' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    expect(handleExplainEntrypoint).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'POST /v1/foo' }),
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result).toBe(subResponse);
  });

  it('returns not-found when explain_entrypoint sets isError', async () => {
    (handleExplainEntrypoint as Mock).mockResolvedValue({
      data: "Entrypoint 'POST /missing' not found in scope",
      metadata: { format: 'raw' },
      isError: true,
    });
    const mockRepo = createMockRepository({});

    const result = await handleExplain(
      { target: 'POST /missing' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect((result.data as ExplainResult).resolution).toBe('not-found');
  });

  // ---------------------------------------------------------------------------
  // Qualified name → explain_function dispatch
  // ---------------------------------------------------------------------------
  it('dispatches Class.method to explain_function with parsed className and passes response through', async () => {
    const subResponse = {
      data: { function: { name: 'createBooking', className: 'BookingService' } },
      metadata: { format: 'raw' },
    };
    (handleExplainFunction as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({});

    const result = await handleExplain(
      { target: 'BookingService.createBooking' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'BookingService.createBooking',
        className: 'BookingService',
      }),
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    // Pass-through — explain returns exactly what explain_function returned.
    expect(result).toBe(subResponse);
  });

  it('returns class-name suggestions when qualified lookup misses (no silent bare-name fallthrough)', async () => {
    // Repro of the 2026-05-14 bug: agent typed `TemplateService.X` (typo —
    // real class is TemplatesService). Old code silently fell through to
    // bare-name lookup of `X`, returning matches from unrelated classes.
    // New behavior: surface class candidates so the agent can correct
    // the qualifier.
    (handleExplainFunction as Mock).mockResolvedValue({
      data: 'Function TemplateService.analyzeShiftSourceApplication not found in scope',
      metadata: { format: 'raw' },
      isError: true,
    });
    const findCode = vi.fn().mockImplementation((params: { pattern: string; types?: string[] }) => {
      // The class-suggestion path filters to class/interface only.
      if (params.types?.includes('class')) {
        return Promise.resolve([
          createMockCodeElement({
            name: 'TemplatesService', // plural
            type: 'class',
            filePath: 'src/modules/templates/templates.service.ts',
            startLine: 1,
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    const mockRepo = createMockRepository({ findCode });

    const result = await handleExplain(
      { target: 'TemplateService.analyzeShiftSourceApplication' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('fuzzy');
    expect(data.hint).toContain('TemplateService');
    expect(data.hint).toMatch(/Did you mean|did you mean/);
    expect(data.candidates?.map((c) => c.name)).toContain('TemplatesService');
  });

  it('returns not-found (no suggestions) when both class and method miss', async () => {
    (handleExplainFunction as Mock).mockResolvedValue({
      data: 'Function NotAClass.notAMethod not found in scope',
      metadata: { format: 'raw' },
      isError: true,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'NotAClass.notAMethod' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
    expect(data.hint).toContain('NotAClass');
  });

  it('composes Class.method when className is passed alongside a bare target', async () => {
    // handleExplainFunction reads only `args.functionName` (it re-parses
    // the qualifier itself), so when our caller separates target+className,
    // we have to combine them. Otherwise the class constraint is silently
    // dropped (which is what caused the 2026-05-14 className-not-working
    // report).
    (handleExplainFunction as Mock).mockResolvedValue({
      data: { function: { name: 'doStuff', className: 'ExplicitClass' } },
      metadata: { format: 'raw' },
      isError: false,
    });
    const mockRepo = createMockRepository({});

    await handleExplain(
      { target: 'doStuff', className: 'ExplicitClass' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'ExplicitClass.doStuff',
        className: 'ExplicitClass',
      }),
      expect.anything(),
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
  });

  // ---------------------------------------------------------------------------
  // Bare name → 1 exact hit
  // ---------------------------------------------------------------------------
  it('dispatches to explain_function when bare name resolves to a function (pass-through)', async () => {
    const subResponse = {
      data: { function: { name: 'createBooking' } },
      metadata: { format: 'raw' },
    };
    (handleExplainFunction as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({
          name: 'createBooking',
          type: 'function',
          filePath: 'src/booking.ts',
          startLine: 10,
        }),
      ]),
    });

    const result = await handleExplain(
      { target: 'createBooking' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainFunction).toHaveBeenCalled();
    expect(result).toBe(subResponse);
  });

  it('returns metadata payload for a class with usage count and follow-up hint', async () => {
    const classElement = createMockCodeElement({
      id: 'abc123:class:src/calc.ts:Calculator',
      name: 'Calculator',
      type: 'class',
      filePath: 'src/calc.ts',
      startLine: 5,
      endLine: 80,
      summary: 'Abstract base for computations',
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      // Construction and import rows are USES_TYPE rows too, so they are part of the same figure.
      getTypeUsages: vi.fn().mockResolvedValue([
        { id: 'x', name: 'consumer', usage: 'parameter' },
        { id: 'y', name: 'buildCalculator', usage: 'construction' },
        { id: 'z', name: 'src/app.ts', usage: 'import' },
      ]),
      getClassExtensions: vi.fn().mockResolvedValue([
        { id: 'sub1', name: 'SubA' },
        { id: 'sub2', name: 'SubB' },
      ]),
    });

    const result = await handleExplain({ target: 'Calculator' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('metadata');
    expect(data.metadata).toMatchObject({
      name: 'Calculator',
      kind: 'class',
      filePath: 'src/calc.ts',
      summary: 'Abstract base for computations',
      usageCount: 5, // 1 type-position + 1 construction + 1 import USES_TYPE + 2 EXTENDS
    });
    expect(data.metadata?.followUpHint).toContain('find_dependents');
    expect(data.metadata?.followUpHint).toContain('Calculator');
  });

  it('inlines a class/DTO property preview from findClass', async () => {
    const dto = createMockCodeElement({
      id: 'abc123:class:src/dto.ts:CreateWebhookDto',
      name: 'CreateWebhookDto',
      type: 'class',
      filePath: 'src/dto.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([dto]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
      findClass: vi.fn().mockResolvedValue({
        id: dto.id,
        name: 'CreateWebhookDto',
        filePath: 'src/dto.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        isAbstract: false,
        properties: [
          { name: 'url', typeText: 'string', isOptional: false },
          { name: 'token', typeText: 'string', isReadonly: true },
        ],
      }),
    });

    const result = await handleExplain(
      { target: 'CreateWebhookDto' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.metadata?.fieldsLabel).toBe('Properties');
    expect(data.metadata?.fields).toContain('url: string');
    expect(data.metadata?.fields).toContain('token: string [readonly]');
  });

  it('dispatches an entity to describe_db_schema and appends a Deeper footer', async () => {
    const entityElement = createMockCodeElement({
      id: 'abc123:entity:src/user.ts:User',
      name: 'User',
      type: 'entity',
      filePath: 'src/user.ts',
      startLine: 1,
    });
    // The entity schema block comes from describe_db_schema (same code path).
    (handleDescribeDbSchema as Mock).mockResolvedValue({
      data: '## DB Schema\n\n### `User` — table `users` (typeorm)\n**Columns (1)**\n- `id`: uuid [PK]',
      metadata: { format: 'summary' },
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([entityElement]),
    });

    const result = await handleExplain({ target: 'User' }, scope, 'summary', defaultLevel, defaultConfig, mockRepo);

    expect(handleDescribeDbSchema).toHaveBeenCalledWith(
      { entityName: 'User' },
      scope,
      'summary',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    // Schema block passed through verbatim; navigation demoted to a footer below.
    expect(result.data).toContain('### `User` — table `users`');
    expect(result.data).toContain('> Deeper: find_entity_usage({entityName: "User"})');
  });

  it('falls back to minimal metadata when describe_db_schema cannot resolve the entity', async () => {
    const entityElement = createMockCodeElement({
      id: 'abc123:entity:src/x.ts:Ghost',
      name: 'Ghost',
      type: 'entity',
      filePath: 'src/x.ts',
      startLine: 1,
    });
    (handleDescribeDbSchema as Mock).mockResolvedValue({ data: 'not found', isError: true, metadata: {} });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([entityElement]),
      getEntityConsumers: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'Ghost' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('metadata');
    expect(data.metadata?.kind).toBe('entity');
    expect(data.metadata?.followUpHint).toContain('describe_db_schema');
  });

  it('inlines enum values from findEnum', async () => {
    const enumElement = createMockCodeElement({
      id: 'abc123:enum:src/events.ts:EventType',
      name: 'EventType',
      type: 'enum',
      filePath: 'src/events.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([enumElement]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      findEnum: vi.fn().mockResolvedValue({
        id: enumElement.id,
        name: 'EventType',
        filePath: 'src/events.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
        members: [{ name: 'ShiftsPublished', value: 'shifts:published' }, { name: 'Auto' }],
      }),
    });

    // defaultLevel is 'full' → every value, brace-rendered (same as the column suffix).
    const result = await handleExplain({ target: 'EventType' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.fieldsLabel).toBe('Values');
    expect(data.metadata?.fieldsTotal).toBe(2);
    expect(data.metadata?.fields?.[0]).toBe('{shifts:published, Auto}');
  });

  it('truncates enum values with +N more at default detail, all at detailLevel:full', async () => {
    const members = Array.from({ length: 15 }, (_, i) => ({ name: `M${i}`, value: `v${i}` }));
    const enumElement = createMockCodeElement({
      id: 'h:enum:src/e.ts:Big',
      name: 'Big',
      type: 'enum',
      filePath: 'src/e.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([enumElement]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      findEnum: vi.fn().mockResolvedValue({
        id: 'h',
        name: 'Big',
        filePath: 'e',
        startLine: 1,
        endLine: 2,
        isExported: true,
        members,
      }),
    });

    const compact = await handleExplain({ target: 'Big' }, scope, 'raw', 'summary', defaultConfig, mockRepo);
    expect((compact.data as ExplainResult).metadata?.fields?.[0]).toContain('+3 more');

    const full = await handleExplain({ target: 'Big' }, scope, 'raw', 'full', defaultConfig, mockRepo);
    expect((full.data as ExplainResult).metadata?.fields?.[0]).not.toContain('more');
  });

  it('inlines the aliased type from findTypeAlias', async () => {
    const taElement = createMockCodeElement({
      id: 'abc123:type_alias:src/types.ts:Status',
      name: 'Status',
      type: 'type_alias',
      filePath: 'src/types.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([taElement]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      findTypeAlias: vi.fn().mockResolvedValue({
        id: taElement.id,
        name: 'Status',
        filePath: 'src/types.ts',
        startLine: 1,
        endLine: 1,
        isExported: true,
        aliasedTypeText: "'active' | 'inactive'",
      }),
    });

    const result = await handleExplain({ target: 'Status' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.fieldsLabel).toBe('Definition');
    expect(data.metadata?.fields).toContain("'active' | 'inactive'");
  });

  // ---------------------------------------------------------------------------
  // Bare name → multiple exact hits (the real collision case)
  // ---------------------------------------------------------------------------
  it('returns disambiguation when the same name has multiple kinds at DIFFERENT locations', async () => {
    // Distinct (file, line) tuples → genuine ambiguity, not a parser
    // artifact. Compare with the dedupe test below which collapses
    // {class, entity} at the SAME location.
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({
          name: 'Helper',
          type: 'class',
          filePath: 'src/a/helper.ts',
          startLine: 12,
        }),
        createMockCodeElement({
          name: 'Helper',
          type: 'function',
          filePath: 'src/b/helper.ts', // different file → not a parser duplicate
          startLine: 20,
        }),
      ]),
    });

    const result = await handleExplain({ target: 'Helper' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('disambiguation');
    expect(data.candidates).toHaveLength(2);
    expect(data.hint).toMatch(/fileHint|className/);
  });

  it('collapses React {component, function} pair at same file+line to one function dispatch', async () => {
    // Parser emits both nodes for every React functional component. Both
    // share name + filePath + startLine. fileHint can't disambiguate (both
    // pass), so the agent saw a useless disambiguation list. Repro of the
    // 2026-05-14 ShiftForm report.
    const subResponse = {
      data: { function: { name: 'ShiftForm' } },
      metadata: { format: 'raw' },
    };
    (handleExplainFunction as Mock).mockResolvedValue(subResponse);
    const path = 'src/components/Shifts/ShiftForm.tsx';
    const mockRepo = createMockRepository({
      findCode: vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ name: 'ShiftForm', type: 'function', filePath: path, startLine: 83 }),
          createMockCodeElement({ name: 'ShiftForm', type: 'component', filePath: path, startLine: 83 }),
        ]),
    });

    const result = await handleExplain(
      { target: 'ShiftForm', fileHint: path },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainFunction).toHaveBeenCalled();
    expect(result).toBe(subResponse);
  });

  it('dispatches an ORM class+entity dual to describe_db_schema (entity is the richest view)', async () => {
    // MikroORM/TypeORM model = class + entity. Precedence picks the class, but
    // the entity schema is the richest view, so explain dispatches to
    // describe_db_schema and notes the class via the Deeper footer.
    (handleDescribeDbSchema as Mock).mockResolvedValue({
      data: '## DB Schema\n\n### `Webhook` — table `webhooks` (mikro-orm)\n**Columns (1)**\n- `token`: string',
      metadata: { format: 'summary' },
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({ name: 'Webhook', type: 'class', filePath: 'src/entities/webhook.ts', startLine: 23 }),
        createMockCodeElement({
          name: 'Webhook',
          type: 'entity',
          filePath: 'src/entities/webhook.ts',
          startLine: 23,
        }),
      ]),
    });

    const result = await handleExplain({ target: 'Webhook' }, scope, 'summary', defaultLevel, defaultConfig, mockRepo);

    expect(handleDescribeDbSchema).toHaveBeenCalledWith(
      { entityName: 'Webhook' },
      scope,
      'summary',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result.data).toContain('### `Webhook` — table `webhooks`');
    expect(result.data).toContain('`token`: string');
    // Footer carries both navigation hints (entity + the class it's also stored as).
    expect(result.data).toContain('> Deeper: find_entity_usage({entityName: "Webhook"})');
    expect(result.data).toContain('find_dependents({name: "Webhook", type: "class"})');
  });

  it('omits `kinds` for a single-kind node', async () => {
    const mockRepo = createMockRepository({
      findCode: vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ name: 'PlainClass', type: 'class', filePath: 'src/x.ts', startLine: 1 }),
        ]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'PlainClass' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.kind).toBe('class');
    expect(data.metadata?.kinds).toBeUndefined();
    expect(data.metadata?.followUpHint).not.toContain('find_entity_usage');
  });

  it('surfaces dual kinds for a class+component (React class component), not just entities', async () => {
    // G is framework-agnostic: a React class component collapses to class +
    // component. `kind` is the class (precedence winner); `kinds` shows both;
    // the hint notes the component nature. No entity tool should appear here.
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({
          name: 'UserPanel',
          type: 'class',
          filePath: 'src/UserPanel.tsx',
          startLine: 8,
        }),
        createMockCodeElement({
          name: 'UserPanel',
          type: 'component',
          filePath: 'src/UserPanel.tsx',
          startLine: 8,
        }),
      ]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'UserPanel' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.kind).toBe('class');
    expect(data.metadata?.kinds).toEqual(['class', 'component']);
    // Class follow-up from the switch, component nature from the generic append.
    expect(data.metadata?.followUpHint).toContain('find_dependents');
    expect(data.metadata?.followUpHint).toContain('UI component');
    expect(data.metadata?.followUpHint).not.toContain('find_entity_usage');
  });

  it('collapses React pairs across multiple files but still disambiguates by file', async () => {
    // ShiftForm appears in two different files. Each file has its own
    // component+function pair. After dedupe we have 2 functions (one per
    // file) → genuine disambiguation by file. The agent uses fileHint to
    // pick which copy to look at.
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({
          name: 'ShiftForm',
          type: 'function',
          filePath: 'src/a/ShiftForm.tsx',
          startLine: 83,
        }),
        createMockCodeElement({
          name: 'ShiftForm',
          type: 'component',
          filePath: 'src/a/ShiftForm.tsx',
          startLine: 83,
        }),
        createMockCodeElement({
          name: 'ShiftForm',
          type: 'function',
          filePath: 'src/b/ShiftForm.tsx',
          startLine: 101,
        }),
        createMockCodeElement({
          name: 'ShiftForm',
          type: 'component',
          filePath: 'src/b/ShiftForm.tsx',
          startLine: 101,
        }),
      ]),
    });

    const result = await handleExplain({ target: 'ShiftForm' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('disambiguation');
    expect(data.candidates).toHaveLength(2);
    // Both surviving candidates should be functions (one per file).
    expect(data.candidates?.every((c) => c.kind === 'function')).toBe(true);
  });

  it('narrows disambiguation when fileHint matches one candidate', async () => {
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([
        createMockCodeElement({
          name: 'Calculator',
          type: 'class',
          filePath: 'src/lib/shift-summary/types.ts',
          startLine: 95,
        }),
        createMockCodeElement({
          name: 'Calculator',
          type: 'class',
          filePath: 'src/other/Calculator.ts',
          startLine: 1,
        }),
      ]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'Calculator', fileHint: 'src/lib/shift-summary/types.ts' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    // fileHint collapses two candidates to one → metadata response
    expect(data.resolution).toBe('metadata');
    expect(data.metadata?.filePath).toBe('src/lib/shift-summary/types.ts');
  });

  // ---------------------------------------------------------------------------
  // Fuzzy fallback
  // ---------------------------------------------------------------------------
  it('returns fuzzy "did you mean" candidates when no exact match exists', async () => {
    // findCode returns substring matches; none equals "Calc" exactly.
    const mockRepo = createMockRepository({
      findCode: vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ name: 'Calculator', type: 'class', filePath: 'src/calc.ts', startLine: 1 }),
          createMockCodeElement({ name: 'SubCalculator', type: 'class', filePath: 'src/sub.ts', startLine: 1 }),
        ]),
    });

    const result = await handleExplain({ target: 'Calc' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('fuzzy');
    expect(data.candidates?.length).toBeGreaterThan(0);
    expect(data.hint).toContain('Did you mean');
  });

  it('returns not-found when no exact and no fuzzy candidates', async () => {
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'TotallyMissingSymbol' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
    expect(data.hint).toContain('TotallyMissingSymbol');
  });

  // ---------------------------------------------------------------------------
  // Empty / cross-repo edge cases
  // ---------------------------------------------------------------------------
  it('returns a usage hint when target is empty', async () => {
    const mockRepo = createMockRepository({});

    const result = await handleExplain({ target: '   ' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
    expect(data.hint).toContain('Pass `target`');
  });

  it('strips surrounding backticks from target before lookup', async () => {
    const findCode = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ name: 'Calculator', type: 'class', filePath: 'src/calc.ts', startLine: 1 }),
      ]);
    const mockRepo = createMockRepository({
      findCode,
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: '`Calculator`' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    expect(findCode).toHaveBeenCalledWith(expect.objectContaining({ pattern: '*Calculator*' }), scope.repoHashes);
    expect((result.data as ExplainResult).resolution).toBe('metadata');
  });

  it('searches cross-repo (empty repoHashes) when scope is not bound', async () => {
    const crossRepoScope: ScopeContext = {
      currentPath: '/',
      resolvedRepos: [],
      repoHashes: [],
      crossRepoEnabled: true,
    };
    const findCode = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ name: 'BookingService', type: 'class', filePath: 'src/svc.ts', startLine: 1 }),
      ]);
    const mockRepo = createMockRepository({
      findCode,
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    await handleExplain({ target: 'BookingService' }, crossRepoScope, 'raw', defaultLevel, defaultConfig, mockRepo);

    expect(findCode).toHaveBeenCalledWith(expect.any(Object), []);
  });

  // ===========================================================================
  // path:line targets
  // ===========================================================================

  it('resolves a path:line target to the innermost enclosing symbol', async () => {
    // The class spans 1–100; the method spans 40–55. Line 42 sits in both —
    // the smaller (method) range wins.
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: 'abc:class:src/booking.service.ts:BookingService',
        name: 'BookingService',
        type: 'class',
        filePath: 'src/booking.service.ts',
        startLine: 1,
        endLine: 100,
      }),
      createMockCodeElement({
        id: 'abc:function:src/booking.service.ts:createBooking',
        name: 'createBooking',
        type: 'function',
        filePath: 'src/booking.service.ts',
        startLine: 40,
        endLine: 55,
      }),
    ]);
    const subResponse = { data: { function: { name: 'createBooking' } }, metadata: { format: 'raw' } };
    (handleExplainFunction as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({ listSymbolsInFile });

    const result = await handleExplain(
      { target: 'src/booking.service.ts:42' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(listSymbolsInFile).toHaveBeenCalledWith('src/booking.service.ts', scope.repoHashes);
    // Innermost is the function → dispatched to explain_function, passed through.
    expect(handleExplainFunction).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'createBooking', fileHint: 'src/booking.service.ts' }),
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result).toBe(subResponse);
  });

  // D2b: the queue entrypoint node at src/…controller.ts:80 used to render as
  // `## 9ff436afb359:entrypoint:queue:e0a1727d (entrypoint)` — the metadata path
  // treated the node id (stored in the `name` column) as a symbol name.
  it('dispatches a path:line that lands on an entrypoint to explain_entrypoint by id', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: '9ff436afb359:entrypoint:queue:e0a1727d',
        name: '9ff436afb359:entrypoint:queue:e0a1727d',
        type: 'entrypoint',
        filePath: 'src/modules/kafka-recalculate/kafka-recalculate.controller.ts',
        startLine: 80,
        endLine: 119,
      }),
    ]);
    const subResponse = { data: { entrypoint: { type: 'queue' } }, metadata: { format: 'raw' } };
    (handleExplainEntrypoint as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({ listSymbolsInFile });

    const result = await handleExplain(
      { target: 'src/modules/kafka-recalculate/kafka-recalculate.controller.ts:80' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainEntrypoint).toHaveBeenCalledWith(
      { id: '9ff436afb359:entrypoint:queue:e0a1727d', includeSource: false },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result).toBe(subResponse);
  });

  // D2b: `explain("Topics.DailySummaryRecalculateV2")` parsed as Class.member and
  // dead-ended on "no method DailySummaryRecalculateV2 on class Topics", even
  // though list_entrypoints printed that exact destination.
  it('resolves a queue destination token to the entrypoint deep-dive', async () => {
    const queueEntrypoint = createMockEntrypointInfo({
      id: '9ff436afb359:entrypoint:queue:e0a1727d',
      type: 'queue',
      method: undefined,
      path: undefined,
      fullPath: undefined,
      system: 'kafka',
      topic: 'Topics.DailySummaryRecalculateV2',
      destination: 'Topics.DailySummaryRecalculateV2',
      handlerName: 'handleDailySummaryRecalculateOnDemandV1',
      filePath: 'src/modules/kafka-recalculate/kafka-recalculate.controller.ts',
      startLine: 80,
    });
    const listEntrypoints = vi.fn().mockResolvedValue([queueEntrypoint]);
    const subResponse = { data: { entrypoint: { type: 'queue' } }, metadata: { format: 'raw' } };
    (handleExplainEntrypoint as Mock).mockResolvedValue(subResponse);
    (handleExplainFunction as Mock).mockResolvedValue({ data: 'miss', metadata: {}, isError: true });
    const mockRepo = createMockRepository({ listEntrypoints, findCode: vi.fn().mockResolvedValue([]) });

    const result = await handleExplain(
      { target: 'Topics.DailySummaryRecalculateV2' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(listEntrypoints).toHaveBeenCalledWith({ pathPattern: 'Topics.DailySummaryRecalculateV2' }, scope.repoHashes);
    expect(handleExplainEntrypoint).toHaveBeenCalledWith(
      { id: '9ff436afb359:entrypoint:queue:e0a1727d', includeSource: false },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result).toBe(subResponse);
  });

  it('resolves the bare destination segment to the same entrypoint', async () => {
    const queueEntrypoint = createMockEntrypointInfo({
      id: 'ep-queue',
      type: 'queue',
      method: undefined,
      path: undefined,
      fullPath: undefined,
      destination: 'Topics.DailySummaryRecalculateV2',
      handlerName: 'handleDailySummaryRecalculateOnDemandV1',
    });
    const subResponse = { data: { entrypoint: { type: 'queue' } }, metadata: { format: 'raw' } };
    (handleExplainEntrypoint as Mock).mockResolvedValue(subResponse);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([]),
      listEntrypoints: vi.fn().mockResolvedValue([queueEntrypoint]),
    });

    const result = await handleExplain(
      { target: 'DailySummaryRecalculateV2' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainEntrypoint).toHaveBeenCalledWith(
      { id: 'ep-queue', includeSource: false },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );
    expect(result).toBe(subResponse);
  });

  it('leaves an unrelated miss on the fuzzy/not-found path', async () => {
    const listEntrypoints = vi.fn().mockResolvedValue([]);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([]),
      listEntrypoints,
    });

    const result = await handleExplain(
      { target: 'NoSuchThingAnywhere' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleExplainEntrypoint).not.toHaveBeenCalled();
    expect((result.data as ExplainResult).resolution).toBe('not-found');
  });

  it('returns metadata for a path:line that lands on a non-function symbol', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: 'abc:class:src/calc.ts:Calculator',
        name: 'Calculator',
        type: 'class',
        filePath: 'src/calc.ts',
        startLine: 5,
        endLine: 80,
        summary: 'Computations',
      }),
    ]);
    const mockRepo = createMockRepository({
      listSymbolsInFile,
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'src/calc.ts:10' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('metadata');
    expect(data.metadata).toMatchObject({ name: 'Calculator', kind: 'class', filePath: 'src/calc.ts' });
  });

  it('falls back to the nearest declaration when no symbol strictly spans the line', async () => {
    // No range encloses line 999, but a class starts before it (the parser may
    // not record endLine for every kind). Use a non-function so the result is
    // metadata, not a dispatched explain_function payload.
    const listSymbolsInFile = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ name: 'Widget', type: 'class', filePath: 'src/a.ts', startLine: 5, endLine: 9 }),
      ]);
    const mockRepo = createMockRepository({
      listSymbolsInFile,
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'src/a.ts:999' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('metadata');
    expect(data.metadata?.name).toBe('Widget');
  });

  it('returns not-found when no file matches the path:line path', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([]);
    const mockRepo = createMockRepository({ listSymbolsInFile });

    const result = await handleExplain(
      { target: 'src/missing.ts:10' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
    expect(data.hint).toContain('list_file_symbols');
  });

  it('does NOT treat Class.method or HTTP paths as path:line', async () => {
    // Sanity: `Foo.bar` has no `:line` suffix; `POST /x` is HTTP. Neither
    // should hit listSymbolsInFile.
    const listSymbolsInFile = vi.fn().mockResolvedValue([]);
    (handleExplainFunction as Mock).mockResolvedValue({ data: {}, metadata: { format: 'raw' }, isError: true });
    (handleExplainEntrypoint as Mock).mockResolvedValue({ data: {}, metadata: { format: 'raw' }, isError: true });
    const mockRepo = createMockRepository({
      listSymbolsInFile,
      findCode: vi.fn().mockResolvedValue([]),
    });

    await handleExplain({ target: 'POST /v1/foo' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);
    expect(listSymbolsInFile).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // bare file-path targets (no `:line`)
  // ===========================================================================

  it('routes a bare file path to the file view', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: 'abc:component:apps/studio/pages/project/[ref]/auth/users.tsx:UsersPage',
        name: 'UsersPage',
        type: 'component',
        filePath: 'apps/studio/pages/project/[ref]/auth/users.tsx',
        startLine: 6,
        endLine: 8,
      }),
    ]);
    const fileView = { data: 'Symbols in users.tsx', metadata: { format: 'summary' } };
    (handleListFileSymbols as Mock).mockResolvedValue(fileView);
    const mockRepo = createMockRepository({ listSymbolsInFile });

    const result = await handleExplain(
      { target: 'apps/studio/pages/project/[ref]/auth/users.tsx' },
      scope,
      'summary',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleListFileSymbols).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'apps/studio/pages/project/[ref]/auth/users.tsx' }),
      scope,
      'summary',
      expect.anything(),
      expect.anything(),
      mockRepo,
    );
    expect(result.data).toContain('Symbols in users.tsx');
    expect(result.data).toContain('> Deeper:');
  });

  it('falls through to the did-you-mean flow when the bare file path is not in the graph', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([]);
    const mockRepo = createMockRepository({
      listSymbolsInFile,
      findCode: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'apps/studio/pages/nope.tsx' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect(handleListFileSymbols).not.toHaveBeenCalled();
    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
  });

  it('still resolves path:line to the innermost symbol rather than the file view', async () => {
    const listSymbolsInFile = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ name: 'Widget', type: 'class', filePath: 'src/a.ts', startLine: 5, endLine: 40 }),
      ]);
    const mockRepo = createMockRepository({
      listSymbolsInFile,
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'src/a.ts:10' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    expect(handleListFileSymbols).not.toHaveBeenCalled();
    expect((result.data as ExplainResult).metadata?.name).toBe('Widget');
  });

  // ---------------------------------------------------------------------------
  // Class methods (containment) + labelled usage figure
  // ---------------------------------------------------------------------------
  const classWithMethods = (methodCount: number) => {
    const classElement = createMockCodeElement({
      id: 'abc123:class:src/svc.ts:BookingService',
      name: 'BookingService',
      type: 'class',
      filePath: 'src/svc.ts',
      startLine: 5,
      endLine: 200,
    });
    const methods = Array.from({ length: methodCount }, (_, i) =>
      createMockCodeElement({
        id: `abc123:function:src/svc.ts:BookingService.m${i}`,
        name: `m${i}`,
        type: 'function',
        filePath: 'src/svc.ts',
        startLine: 10 + i,
        endLine: 11 + i,
      }),
    );
    return { classElement, methods };
  };

  it('lists the class methods held as containment rows, not just its properties', async () => {
    const { classElement, methods } = classWithMethods(2);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      listSymbolsInFile: vi.fn().mockResolvedValue([classElement, ...methods]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
      findClass: vi.fn().mockResolvedValue({
        id: classElement.id,
        name: 'BookingService',
        filePath: 'src/svc.ts',
        startLine: 5,
        endLine: 200,
        isExported: true,
        isAbstract: false,
        properties: [{ name: 'repo', typeText: 'Repository' }],
      }),
    });

    const result = await handleExplain(
      { target: 'BookingService' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.metadata?.methods).toEqual(['m0()', 'm1()']);
    expect(data.metadata?.methodsTotal).toBe(2);
    // Properties preview must survive alongside the methods.
    expect(data.metadata?.fields).toContain('repo: Repository');
    expect(data.metadata?.followUpHint).toContain('BookingService.<method>');
  });

  it('caps the class method preview and reports the full total', async () => {
    const { classElement, methods } = classWithMethods(45);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      listSymbolsInFile: vi.fn().mockResolvedValue([classElement, ...methods]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'BookingService' },
      scope,
      'raw',
      'basic',
      { includeBasic: true, includeSummaries: false, includeRefs: false, includeFullDetails: false },
      mockRepo,
    );

    const data = result.data as ExplainResult;
    expect(data.metadata?.methods).toHaveLength(40);
    expect(data.metadata?.methodsTotal).toBe(45);
  });

  it('lists only the precise HAS_METHOD members, not helpers nested inside the class range', async () => {
    const { classElement, methods } = classWithMethods(2);
    const nestedHelper = createMockCodeElement({
      id: 'abc123:function:src/svc.ts:formatRow',
      name: 'formatRow',
      type: 'function',
      filePath: 'src/svc.ts',
      // Declared INSIDE a method body, so the class line range encloses it.
      startLine: 30,
      endLine: 34,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      listSymbolsInFile: vi.fn().mockResolvedValue([classElement, ...methods, nestedHelper]),
      getNeighbors: vi.fn().mockResolvedValue({
        nodes: methods.map((m) => ({
          id: m.id,
          name: m.name,
          type: 'function',
          repoName: 'repo',
          startLine: m.startLine,
        })),
        edges: [],
        truncated: false,
      }),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'BookingService' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect((result.data as ExplainResult).metadata?.methods).toEqual(['m0()', 'm1()']);
  });

  it('falls back to the class line range when the graph has no HAS_METHOD edges', async () => {
    const { classElement, methods } = classWithMethods(2);
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      listSymbolsInFile: vi.fn().mockResolvedValue([classElement, ...methods]),
      getNeighbors: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'BookingService' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect((result.data as ExplainResult).metadata?.methods).toEqual(['m0()', 'm1()']);
  });

  it('keeps functions declared outside the class body out of its method list', async () => {
    const { classElement, methods } = classWithMethods(1);
    const outsider = createMockCodeElement({
      id: 'abc123:function:src/svc.ts:helper',
      name: 'helper',
      type: 'function',
      filePath: 'src/svc.ts',
      startLine: 400,
      endLine: 410,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      listSymbolsInFile: vi.fn().mockResolvedValue([classElement, ...methods, outsider]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
      getClassExtensions: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain(
      { target: 'BookingService' },
      scope,
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    expect((result.data as ExplainResult).metadata?.methods).toEqual(['m0()']);
  });

  it('labels the class usage figure with the relations it sums', async () => {
    const classElement = createMockCodeElement({
      id: 'abc123:class:src/calc.ts:Calculator',
      name: 'Calculator',
      type: 'class',
      filePath: 'src/calc.ts',
      startLine: 5,
      endLine: 80,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([classElement]),
      getTypeUsages: vi.fn().mockResolvedValue([{ id: 'x', name: 'consumer' }]),
      getClassExtensions: vi.fn().mockResolvedValue([{ id: 'sub1', name: 'SubA' }]),
    });

    const result = await handleExplain({ target: 'Calculator' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    expect((result.data as ExplainResult).metadata?.usageRelation).toBe(
      'type references + constructions + imports where extracted + subclasses',
    );
  });

  it('labels the enum usage figure so a zero is not read as "nothing uses it"', async () => {
    const enumElement = createMockCodeElement({
      id: 'abc123:enum:src/status.ts:Status',
      name: 'Status',
      type: 'enum',
      filePath: 'src/status.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([enumElement]),
      getTypeUsages: vi.fn().mockResolvedValue([]),
    });

    const result = await handleExplain({ target: 'Status' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.usageCount).toBe(0);
    expect(data.metadata?.usageRelation).toBe('type references + member-value reads where extracted');
    expect(data.metadata?.usageNote).toBeUndefined();
  });

  it('counts member-value reads in the enum usage figure and names the branched members', async () => {
    const enumElement = createMockCodeElement({
      id: 'abc123:enum:src/status.ts:Status',
      name: 'Status',
      type: 'enum',
      filePath: 'src/status.ts',
      startLine: 1,
    });
    const mockRepo = createMockRepository({
      findCode: vi.fn().mockResolvedValue([enumElement]),
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
    });

    const result = await handleExplain({ target: 'Status' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.metadata?.usageCount).toBe(2);
    expect(data.metadata?.usageRelation).toBe('type references + member-value reads where extracted');
    expect(data.metadata?.usageNote).toBe('1 of 2 usages are member-value reads (branches on Status.Locked)');
  });

  // ---------------------------------------------------------------------------
  // Sibling-repository fallback on an empty scoped lookup
  // ---------------------------------------------------------------------------
  it('names the sibling repositories that declare the symbol when the scoped lookup is empty', async () => {
    const findCode = vi.fn().mockImplementation((_params: unknown, repoHashes: string[]) => {
      // Scoped call finds nothing; the widened probe finds two siblings.
      if (repoHashes.length > 0) return Promise.resolve([]);
      return Promise.resolve([
        createMockCodeElement({ id: 'def456:class:src/a.ts:Ledger', name: 'Ledger', type: 'class' }),
        createMockCodeElement({ id: 'ghi789:class:src/b.ts:Ledger', name: 'Ledger', type: 'class' }),
      ]);
    });
    const mockRepo = createMockRepository({
      findCode,
      getRepositoryNames: vi.fn().mockResolvedValue([
        { hash: 'def456', name: 'billing' },
        { hash: 'ghi789', name: 'reporting' },
      ]),
    });

    const result = await handleExplain({ target: 'Ledger' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

    const data = result.data as ExplainResult;
    expect(data.resolution).toBe('not-found');
    expect(data.hint).toContain('billing');
    expect(data.hint).toContain('reporting');
  });

  it('does not widen past a workspace-bounded scope on an empty lookup', async () => {
    const findCode = vi.fn().mockResolvedValue([]);
    const mockRepo = createMockRepository({ findCode });

    await handleExplain(
      { target: 'Ledger' },
      { ...scope, origin: 'workspace' },
      'raw',
      defaultLevel,
      defaultConfig,
      mockRepo,
    );

    // Only the scoped lookup ran — no all-repos probe.
    for (const call of findCode.mock.calls) {
      expect((call[1] as string[]).length).toBeGreaterThan(0);
    }
  });

  // The guard above was covered; the thing it guards was not. A scoped miss and a
  // genuine absence are different facts, and an agent handed a flat "not found" for
  // a symbol that demonstrably exists one repo over will conclude it does not exist.
  describe('scoped miss vs genuine absence', () => {
    it('names the sibling repos that declare the symbol', async () => {
      const findCode = vi.fn(async (_params: unknown, hashes: string[]) =>
        // Scoped lookups find nothing; the unscoped sibling probe (hashes === [])
        // finds the declaration in another repo.
        hashes.length === 0
          ? [createMockCodeElement({ id: 'other456:class:src/ledger.ts:Ledger', name: 'Ledger', type: 'class' })]
          : [],
      );
      const mockRepo = createMockRepository({
        findCode,
        getRepositoryNames: vi.fn().mockResolvedValue([{ hash: 'other456', name: 'billing-api' }]),
      });

      const result = await handleExplain({ target: 'Ledger' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

      const data = result.data as ExplainResult;
      expect(data.resolution).toBe('not-found');
      expect(data.hint).toMatch(/not in this scope/i);
      expect(data.hint).toContain('billing-api');
      // The hint has to be actionable, not just a caveat.
      expect(data.hint).toContain('scope="billing-api"');
    });

    it('falls back to the generic hint when no sibling declares it', async () => {
      const mockRepo = createMockRepository({
        findCode: vi.fn().mockResolvedValue([]),
        getRepositoryNames: vi.fn().mockResolvedValue([]),
      });

      const result = await handleExplain({ target: 'Nowhere' }, scope, 'raw', defaultLevel, defaultConfig, mockRepo);

      const data = result.data as ExplainResult;
      expect(data.resolution).toBe('not-found');
      expect(data.hint).not.toMatch(/not in this scope, but/i);
      expect(data.hint).toMatch(/describe_repository|search_symbols/);
    });

    it('does not probe siblings when the scope carries no repo hashes', async () => {
      const findCode = vi.fn().mockResolvedValue([]);
      const mockRepo = createMockRepository({ findCode, getRepositoryNames: vi.fn().mockResolvedValue([]) });

      const result = await handleExplain(
        { target: 'Ledger' },
        { ...scope, repoHashes: [] },
        'raw',
        defaultLevel,
        defaultConfig,
        mockRepo,
      );

      // With no scope there is nothing to widen FROM, so claiming a symbol is
      // "elsewhere" would be meaningless.
      expect((result.data as ExplainResult).hint).not.toMatch(/not in this scope, but/i);
    });
  });
});
