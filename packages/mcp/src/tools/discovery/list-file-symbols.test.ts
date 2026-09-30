/**
 * Tests for the list_file_symbols tool handler
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { handleListFileSymbols } from './list-file-symbols.js';
import type { ScopeContext, CodeElementInfo, DetailLevel, DetailLevelConfig } from '../../types.js';
import { createMockRepository, createMockCodeElement } from '../../__tests__/fixtures/mock-repository.js';

vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

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

const defaultDetailLevel: DetailLevel = 'full';
const defaultDetailConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

describe('list_file_symbols Tool Handler', () => {
  let mockScope: ScopeContext;
  let getRepository: Mock;

  beforeEach(async () => {
    mockScope = {
      currentPath: '/test/repo',
      resolvedRepos: ['test-repo'],
      repoHashes: ['abc123def456'],
      crossRepoEnabled: false,
    };
    vi.clearAllMocks();
    const dbModule = await import('@coredoc/db');
    getRepository = vi.mocked(dbModule.getRepository);
  });

  it('lists all symbols in a file ordered by line', async () => {
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: 'abc123:class:src/templates.service.ts:TemplatesService',
        name: 'TemplatesService',
        type: 'class',
        filePath: 'src/templates.service.ts',
        startLine: 10,
      }),
      createMockCodeElement({
        id: 'abc123:function:src/templates.service.ts:createTemplate',
        name: 'createTemplate',
        type: 'function',
        filePath: 'src/templates.service.ts',
        startLine: 25,
      }),
    ]);
    const mockRepo = createMockRepository({ listSymbolsInFile });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'src/templates.service.ts' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(listSymbolsInFile).toHaveBeenCalledWith('src/templates.service.ts', mockScope.repoHashes);
    const elements = result.data as CodeElementInfo[];
    expect(elements).toHaveLength(2);
    expect(elements.map((e) => e.name)).toEqual(['TemplatesService', 'createTemplate']);
  });

  it('errors with a hint when path is missing', async () => {
    const mockRepo = createMockRepository({ listSymbolsInFile: vi.fn() });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      {},
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(result.data).toContain('requires a `path`');
    // No DB call when the path is absent.
    expect(mockRepo.listSymbolsInFile).not.toHaveBeenCalled();
  });

  it('filters by type when type is provided', async () => {
    const listSymbolsInFile = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ id: 'a', name: 'Foo', type: 'class', filePath: 'f.ts', startLine: 1 }),
        createMockCodeElement({ id: 'b', name: 'bar', type: 'function', filePath: 'f.ts', startLine: 5 }),
      ]);
    const mockRepo = createMockRepository({ listSymbolsInFile });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'f.ts', type: 'class' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    const elements = result.data as CodeElementInfo[];
    expect(elements).toHaveLength(1);
    expect(elements[0]!.type).toBe('class');
  });

  it('collapses parser duplicates at the same name+line (React FC)', async () => {
    const listSymbolsInFile = vi
      .fn()
      .mockResolvedValue([
        createMockCodeElement({ id: 'a', name: 'ShiftForm', type: 'function', filePath: 'Shift.tsx', startLine: 12 }),
        createMockCodeElement({ id: 'b', name: 'ShiftForm', type: 'component', filePath: 'Shift.tsx', startLine: 12 }),
      ]);
    const mockRepo = createMockRepository({ listSymbolsInFile });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'Shift.tsx' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    const elements = result.data as CodeElementInfo[];
    expect(elements).toHaveLength(1);
    // function outranks component at the same location.
    expect(elements[0]!.type).toBe('function');
  });

  it('drops non-symbol container nodes (file/package) instead of mislabeling them', async () => {
    // The parser stores a `file` node at the file root with no real start line;
    // it used to surface as a junk `path.ts:null (function)` row. It must be
    // filtered out, leaving only real declared symbols.
    const listSymbolsInFile = vi.fn().mockResolvedValue([
      createMockCodeElement({
        id: 'f',
        name: 'src/foo.service.ts',
        type: 'file' as unknown as 'function',
        filePath: 'src/foo.service.ts',
        startLine: 0,
      }),
      createMockCodeElement({
        id: 'c',
        name: 'FooService',
        type: 'class',
        filePath: 'src/foo.service.ts',
        startLine: 10,
      }),
    ]);
    const mockRepo = createMockRepository({ listSymbolsInFile });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'src/foo.service.ts' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    const elements = result.data as CodeElementInfo[];
    expect(elements).toHaveLength(1);
    expect(elements[0]!.name).toBe('FooService');
    expect(elements.some((e) => e.type === 'file')).toBe(false);
  });

  it('returns a not-found title in summary mode when the file has no symbols', async () => {
    const mockRepo = createMockRepository({ listSymbolsInFile: vi.fn().mockResolvedValue([]) });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'does/not/exist.ts' },
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(result.data).toContain('No symbols found');
    expect(result.data).toContain('does/not/exist.ts');
    // The uninformative "(showing 0 of 0)" suffix must NOT appear next to the
    // not-found title.
    expect(result.data).not.toContain('showing 0 of 0');
  });

  it('says the file is parsed-but-empty when the graph holds the file node and nothing else', async () => {
    // Measured on supabase: `packages/pg-meta/src/index.ts` is a re-export
    // barrel. It IS parsed (the file node is in the graph) but declares no
    // symbols, so "check the path" sent agents hunting a path that was right.
    const mockRepo = createMockRepository({
      listSymbolsInFile: vi.fn().mockResolvedValue([
        createMockCodeElement({
          id: 'abc:file:packages/pg-meta/src/index.ts',
          name: 'packages/pg-meta/src/index.ts',
          type: 'file' as CodeElementType,
          filePath: 'packages/pg-meta/src/index.ts',
          startLine: 0,
        }),
      ]),
    });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'packages/pg-meta/src/index.ts' },
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(result.data).toContain('packages/pg-meta/src/index.ts');
    expect(result.data).toContain('declares no symbols');
    expect(result.data).not.toContain('check the path');
  });

  it('names the type filter when it is the reason nothing is listed', async () => {
    const mockRepo = createMockRepository({
      listSymbolsInFile: vi
        .fn()
        .mockResolvedValue([
          createMockCodeElement({ name: 'FooService', type: 'class' as CodeElementType, filePath: 'src/foo.ts' }),
        ]),
    });
    getRepository.mockResolvedValue(mockRepo);

    const result = await handleListFileSymbols(
      { path: 'src/foo.ts', type: 'enum' },
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(result.data).toContain('no `enum` symbols');
    expect(result.data).not.toContain('check the path');
  });
});
