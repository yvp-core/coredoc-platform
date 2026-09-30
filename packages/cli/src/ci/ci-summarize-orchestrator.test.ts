import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import type { ParsedRepo, FunctionNode } from '@coredoc/core/types';
import type { FunctionSummary, SummaryOutput } from '../summarize/types.js';

// Keep the real isFallbackFunctionSummary: the orchestrator's cache/artifact
// filtering under test depends on it, only the LLM callers are mocked.
vi.mock('./ci-summarizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ci-summarizer.js')>()),
  summarizeFunction: vi.fn(),
  summarizeRepository: vi.fn(),
  summarizePackages: vi.fn(),
}));

import { summarizeFunction, summarizeRepository, summarizePackages } from './ci-summarizer.js';
import { ciSummarize } from './ci-summarize-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFn(id: string, versionedId: string): FunctionNode {
  return {
    id,
    versionedId,
    name: id.split(':').pop()!,
    kind: 'function',
    location: { filePath: 'src/test.ts', startLine: 1, endLine: 10 },
    fileId: 'repo:file:src/test.ts',
    sourceCode: `function ${id.split(':').pop()}() {}`,
  } as FunctionNode;
}

function makeSummary(fnId: string, versionedId: string): FunctionSummary {
  return {
    functionId: fnId,
    versionedId,
    detailed_summary: `Summary of ${fnId}`,
    purpose: `Purpose of ${fnId}`,
    business_logic: [],
    side_effects: [],
    data_handling: '',
    confidence_level: 'high',
    unknowns: [],
    generatedAt: new Date().toISOString(),
  };
}

const mockModel = {} as LanguageModel;

function makeRepo(functions: FunctionNode[], packages: { id: string; name: string }[] = []): ParsedRepo {
  return {
    id: 'repo:test',
    name: 'test-repo',
    path: '/tmp/test',
    parsedAt: new Date().toISOString(),
    parserVersion: '1.0.0',
    parserId: 'test-parser',
    packages:
      packages.length > 0
        ? packages.map((p) => ({ ...p, path: `/tmp/${p.name}`, files: [] }))
        : [{ id: 'repo:pkg:main', name: 'main', path: '/tmp/test', files: [] }],
    files: [],
    functions,
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
  } as unknown as ParsedRepo;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ciSummarize', () => {
  const mockedSummarizeFunction = vi.mocked(summarizeFunction);
  const mockedSummarizeRepository = vi.mocked(summarizeRepository);
  const mockedSummarizePackages = vi.mocked(summarizePackages);

  beforeEach(() => {
    vi.clearAllMocks();

    mockedSummarizeFunction.mockImplementation(async (fn) => makeSummary(fn.id, fn.versionedId));
    mockedSummarizeRepository.mockResolvedValue({
      overview: 'Test repo overview',
      dataModel: '',
      externalIntegrations: [],
      generatedAt: new Date().toISOString(),
    });
    mockedSummarizePackages.mockResolvedValue([]);
  });

  it('should summarize all functions when no previous summaries', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const fn2 = makeFn('repo:fn:b', 'repo:fn:b@v1');
    const repo = makeRepo([fn1, fn2]);

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries: null,
      model: mockModel,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(2);
    expect(mockedSummarizeRepository).toHaveBeenCalledTimes(1);
    expect(result.stats.totalFunctions).toBe(2);
    expect(result.stats.summarized).toBe(2);
    expect(result.stats.skippedCached).toBe(0);
    expect(result.summaries).toHaveLength(2);
    expect(result.repoId).toBe('repo:test');
    expect(result.repoName).toBe('test-repo');
    expect(result.repositorySummary).toBeDefined();
  });

  // A node minted from a declaration convention (a Rails `has_many` reader) has no body: the
  // LLM would be billed per association to describe source that does not exist. The declared
  // function beside it is still summarized.
  it('never summarizes a synthesized function, and still summarizes the declared one', async () => {
    const declared = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const reader = { ...makeFn('repo:fn:posts', 'repo:fn:posts@v1'), synthesized: 'ruby-association' as const };
    reader.sourceCode = undefined;

    const result = await ciSummarize({
      parsedRepo: makeRepo([declared, reader]),
      previousSummaries: null,
      model: mockModel,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1);
    expect(mockedSummarizeFunction.mock.calls[0]![0].id).toBe('repo:fn:a');
    expect(result.summaries.map((x) => x.functionId)).toEqual(['repo:fn:a']);
  });

  // A function parsed WITHOUT its body would be summarized from its signature alone — a confident
  // fabrication at full LLM cost. It is skipped, nothing about it enters the artifact, and the
  // synthesized skip is counted apart from it.
  it('never summarizes a function with no source code, and counts it apart from synthesized', async () => {
    const declared = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const bodyless = { ...makeFn('repo:fn:b', 'repo:fn:b@v1'), sourceCode: undefined };
    const reader = { ...makeFn('repo:fn:posts', 'repo:fn:posts@v1'), synthesized: 'ruby-association' as const };
    reader.sourceCode = undefined;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await ciSummarize({
      parsedRepo: makeRepo([declared, bodyless, reader]),
      previousSummaries: null,
      model: mockModel,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1);
    expect(mockedSummarizeFunction.mock.calls[0]![0].id).toBe('repo:fn:a');
    expect(result.summaries.map((x) => x.functionId)).toEqual(['repo:fn:a']);
    // The two skips are disjoint, so neither inflates `skippedCached`.
    expect(result.stats.skippedCached).toBe(0);
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(logged).toContain('1 synthesized (no body, skipped)');
    expect(logged).toContain('1 without source code (skipped)');
    expect(logged).toContain('Skipped (no source code): 1');
  });

  it('skips a source-less function under force too, and it is absent from the artifact', async () => {
    const bodyless = { ...makeFn('repo:fn:b', 'repo:fn:b@v1'), sourceCode: '   ' };
    const previous: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [makeSummary('repo:fn:b', 'repo:fn:b@v1')],
      stats: { totalFunctions: 1, summarized: 1, skippedCached: 0, failedSummarization: 0, processingTimeMs: 0 },
    };

    const result = await ciSummarize({
      parsedRepo: makeRepo([bodyless]),
      previousSummaries: previous,
      model: mockModel,
      force: true,
    });

    expect(mockedSummarizeFunction).not.toHaveBeenCalled();
    expect(result.summaries).toEqual([]);
  });

  it('should skip cached functions with matching versionedId', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const fn2 = makeFn('repo:fn:b', 'repo:fn:b@v2'); // changed
    const repo = makeRepo([fn1, fn2]);

    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [
        makeSummary('repo:fn:a', 'repo:fn:a@v1'), // matches fn1
        makeSummary('repo:fn:b', 'repo:fn:b@v1'), // old version, won't match fn2
      ],
      stats: {
        totalFunctions: 2,
        summarized: 2,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 100,
      },
    };

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries,
      model: mockModel,
    });

    // Only fn2 should be summarized (fn1 is cached)
    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1);
    expect(mockedSummarizeFunction.mock.calls[0][0].id).toBe('repo:fn:b');
    expect(result.stats.summarized).toBe(1);
    expect(result.stats.skippedCached).toBe(1);
    expect(result.summaries).toHaveLength(2);
    // Repo summary should be regenerated since something changed
    expect(mockedSummarizeRepository).toHaveBeenCalledTimes(1);
  });

  it('should skip all summarization when zero functions changed', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const fn2 = makeFn('repo:fn:b', 'repo:fn:b@v1');
    const repo = makeRepo([fn1, fn2]);

    const previousRepoSummary = {
      overview: 'Previous overview',
      dataModel: 'Previous data model',
      externalIntegrations: ['redis'],
      generatedAt: new Date().toISOString(),
    };

    const previousPkgSummaries = [
      { packageId: 'repo:pkg:main', purpose: 'Main package', generatedAt: new Date().toISOString() },
    ];

    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [makeSummary('repo:fn:a', 'repo:fn:a@v1'), makeSummary('repo:fn:b', 'repo:fn:b@v1')],
      stats: {
        totalFunctions: 2,
        summarized: 2,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 100,
      },
      repositorySummary: previousRepoSummary,
      packageSummaries: previousPkgSummaries,
    };

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries,
      model: mockModel,
    });

    expect(mockedSummarizeFunction).not.toHaveBeenCalled();
    expect(mockedSummarizeRepository).not.toHaveBeenCalled();
    expect(mockedSummarizePackages).not.toHaveBeenCalled();
    expect(result.stats.summarized).toBe(0);
    expect(result.stats.skippedCached).toBe(2);
    expect(result.repositorySummary).toEqual(previousRepoSummary);
    expect(result.packageSummaries).toEqual(previousPkgSummaries);
  });

  it('should call summarizePackages for monorepo (packages > 1)', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const repo = makeRepo(
      [fn1],
      [
        { id: 'repo:pkg:core', name: 'core' },
        { id: 'repo:pkg:cli', name: 'cli' },
      ],
    );

    mockedSummarizePackages.mockResolvedValue([
      { packageId: 'repo:pkg:core', purpose: 'Core logic', generatedAt: new Date().toISOString() },
      { packageId: 'repo:pkg:cli', purpose: 'CLI interface', generatedAt: new Date().toISOString() },
    ]);

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries: null,
      model: mockModel,
    });

    expect(mockedSummarizePackages).toHaveBeenCalledTimes(1);
    expect(result.packageSummaries).toHaveLength(2);
  });

  it('should track failed LLM calls in stats', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const fn2 = makeFn('repo:fn:b', 'repo:fn:b@v1');
    const repo = makeRepo([fn1, fn2]);

    // fn1 succeeds, fn2 returns a fallback (low confidence with LLM call failed)
    mockedSummarizeFunction.mockImplementation(async (fn) => {
      if (fn.id === 'repo:fn:b') {
        return {
          ...makeSummary(fn.id, fn.versionedId),
          confidence_level: 'low' as const,
          unknowns: ['LLM call failed: API timeout'],
        };
      }
      return makeSummary(fn.id, fn.versionedId);
    });

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries: null,
      model: mockModel,
    });

    expect(result.stats.failedSummarization).toBe(1);
    expect(result.stats.summarized).toBe(1);
    // The fallback never reaches the artifact — persisted, it would be served
    // as a real summary and pin the failure as the next run's cache.
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].functionId).toBe('repo:fn:a');
  });

  it('re-processes a function whose cached summary is a fallback', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const fn2 = makeFn('repo:fn:b', 'repo:fn:b@v1');
    const fn3 = makeFn('repo:fn:c', 'repo:fn:c@v1');
    const repo = makeRepo([fn1, fn2, fn3]);

    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [
        makeSummary('repo:fn:a', 'repo:fn:a@v1'),
        // Poisoned entry from a run whose LLM calls failed (e.g. credit precheck).
        {
          ...makeSummary('repo:fn:b', 'repo:fn:b@v1'),
          confidence_level: 'low' as const,
          unknowns: ['LLM call failed: This request requires more credits'],
        },
        // Genuine low-confidence summary — stays cached.
        {
          ...makeSummary('repo:fn:c', 'repo:fn:c@v1'),
          confidence_level: 'low' as const,
          unknowns: ['uses dynamic dispatch'],
        },
      ],
      stats: {
        totalFunctions: 3,
        summarized: 3,
        skippedCached: 0,
        failedSummarization: 0,
        processingTimeMs: 100,
      },
    };

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries,
      model: mockModel,
    });

    // Only the poisoned entry is re-processed; real summaries stay cached.
    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1);
    expect(mockedSummarizeFunction.mock.calls[0][0].id).toBe('repo:fn:b');
    expect(result.stats.skippedCached).toBe(2);
    expect(result.stats.summarized).toBe(1);
    expect(result.stats.failedSummarization).toBe(0);
    // Fresh success replaces the fallback in the artifact.
    expect(result.summaries).toHaveLength(3);
  });

  it('skips repo/package summaries and carries forward previous when repoSummary=false', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1'); // not in previous -> gets processed
    const repo = makeRepo(
      [fn1],
      [
        { id: 'repo:pkg:core', name: 'core' },
        { id: 'repo:pkg:cli', name: 'cli' },
      ],
    );

    const previousRepoSummary = {
      overview: 'Carried over',
      dataModel: '',
      externalIntegrations: [],
      generatedAt: new Date().toISOString(),
    };
    const previousPkgSummaries = [
      { packageId: 'repo:pkg:core', purpose: 'Core', generatedAt: new Date().toISOString() },
    ];
    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [], // fn1 absent -> still summarized
      stats: { totalFunctions: 0, summarized: 0, skippedCached: 0, failedSummarization: 0, processingTimeMs: 0 },
      repositorySummary: previousRepoSummary,
      packageSummaries: previousPkgSummaries,
    };

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries,
      model: mockModel,
      repoSummary: false,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1); // functions still summarized
    expect(mockedSummarizeRepository).not.toHaveBeenCalled();
    expect(mockedSummarizePackages).not.toHaveBeenCalled();
    expect(result.repositorySummary).toEqual(previousRepoSummary);
    expect(result.packageSummaries).toEqual(previousPkgSummaries);
  });

  it('threads strictJsonSchema=false to summarizeFunction (Ollama path)', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const repo = makeRepo([fn1]);

    await ciSummarize({
      parsedRepo: repo,
      previousSummaries: null,
      model: mockModel,
      strictJsonSchema: false,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledWith(expect.anything(), expect.anything(), mockModel, false);
  });

  it('backfills a MISSING repository summary even when all functions are cached', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const repo = makeRepo([fn1]);
    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [makeSummary('repo:fn:a', 'repo:fn:a@v1')], // fn1 cached
      stats: { totalFunctions: 1, summarized: 1, skippedCached: 0, failedSummarization: 0, processingTimeMs: 0 },
      // repositorySummary intentionally absent -> must be backfilled
    };

    const result = await ciSummarize({ parsedRepo: repo, previousSummaries, model: mockModel });

    expect(mockedSummarizeFunction).not.toHaveBeenCalled(); // all cached
    expect(mockedSummarizeRepository).toHaveBeenCalledTimes(1); // backfilled
    expect(result.repositorySummary).toBeDefined();
  });

  it('does NOT regenerate a present repository summary when all functions are cached', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const repo = makeRepo([fn1]);
    const prevRepo = {
      overview: 'keep me',
      dataModel: '',
      externalIntegrations: [],
      generatedAt: new Date().toISOString(),
    };
    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [makeSummary('repo:fn:a', 'repo:fn:a@v1')],
      stats: { totalFunctions: 1, summarized: 1, skippedCached: 0, failedSummarization: 0, processingTimeMs: 0 },
      repositorySummary: prevRepo,
    };

    const result = await ciSummarize({ parsedRepo: repo, previousSummaries, model: mockModel });

    expect(mockedSummarizeRepository).not.toHaveBeenCalled();
    expect(result.repositorySummary).toEqual(prevRepo);
  });

  it('force re-summarizes cached functions while preserving carried-forward summaries (repoSummary=false)', async () => {
    const fn1 = makeFn('repo:fn:a', 'repo:fn:a@v1');
    const repo = makeRepo([fn1]);
    const prevRepo = {
      overview: 'keep me',
      dataModel: '',
      externalIntegrations: [],
      generatedAt: new Date().toISOString(),
    };
    const previousSummaries: SummaryOutput = {
      repoId: 'repo:test',
      repoName: 'test-repo',
      generatedAt: new Date().toISOString(),
      summarizerVersion: '1.0.0',
      summaries: [makeSummary('repo:fn:a', 'repo:fn:a@v1')], // would be cached without force
      stats: { totalFunctions: 1, summarized: 1, skippedCached: 0, failedSummarization: 0, processingTimeMs: 0 },
      repositorySummary: prevRepo,
    };

    const result = await ciSummarize({
      parsedRepo: repo,
      previousSummaries,
      model: mockModel,
      force: true,
      repoSummary: false,
    });

    expect(mockedSummarizeFunction).toHaveBeenCalledTimes(1); // force ignored the per-function cache
    expect(mockedSummarizeRepository).not.toHaveBeenCalled(); // repoSummary=false
    expect(result.repositorySummary).toEqual(prevRepo); // carried forward despite --force
    expect(result.stats.skippedCached).toBe(0);
  });
});
