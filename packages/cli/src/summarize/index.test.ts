/**
 * Unit tests for the pure helpers exported by index.ts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FunctionNode, SourceLocation } from '@coredoc/core/types';
import type { SummaryOutput } from './types';
import { buildSummarizeMetadata, resolveLlmConfig, runSummarize, type SummarizeOptions } from './index';

// The full (non-dry) run below writes the summaries artifact. Stub the three collaborators that
// would otherwise reach the LLM subprocess or the operations database — the assertions are about
// WHICH functions reach the summarizer and what lands in the artifact.
const summarized: string[] = [];
vi.mock('../operations-tracker.js', () => ({
  trackOperation: async (_p: string, _r: string, _o: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../db-scope.js', () => ({ bindProjectDatabase: async () => undefined }));
vi.mock('../ci/ci-summarizer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ci/ci-summarizer.js')>()),
  summarizeFunction: async (fn: FunctionNode) => {
    summarized.push(fn.id);
    return {
      functionId: fn.id,
      versionedId: fn.versionedId,
      detailed_summary: 'd',
      purpose: 'p',
      business_logic: [],
      side_effects: [],
      data_handling: '',
      confidence_level: 'high',
      unknowns: [],
      generatedAt: new Date().toISOString(),
    };
  },
}));

function makeFn(id: string, version: string, name = id): FunctionNode {
  const location: SourceLocation = { filePath: 'src/x.ts', startLine: 1, endLine: 2 };
  return {
    id,
    versionedId: id + '@' + version,
    name,
    kind: 'function',
    fileId: 'repo1:file:src/x.ts',
    isAsync: false,
    isGenerator: false,
    parameters: [],
    location,
    sourceCode: 'function ' + name + '() {}',
  } as FunctionNode;
}

describe('resolveLlmConfig', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.COREDOC_LLM_MODEL;
    delete process.env.COREDOC_LLM_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  const base: SummarizeOptions = { config: 'c', projectId: 'p', repo: 'r', provider: 'ollama' };

  it('throws when no model is given via flag or env', () => {
    expect(() => resolveLlmConfig({ ...base })).toThrow('model is required');
  });

  it('prefers the --model flag over COREDOC_LLM_MODEL', () => {
    process.env.COREDOC_LLM_MODEL = 'env-model';
    expect(resolveLlmConfig({ ...base, model: 'flag-model' }).model).toBe('flag-model');
  });

  it('falls back to COREDOC_LLM_MODEL when no flag', () => {
    process.env.COREDOC_LLM_MODEL = 'env-model';
    expect(resolveLlmConfig({ ...base }).model).toBe('env-model');
  });

  it('prefers the --api-key flag over COREDOC_LLM_API_KEY', () => {
    process.env.COREDOC_LLM_API_KEY = 'env-key';
    const cfg = resolveLlmConfig({ ...base, provider: 'openrouter', model: 'm', apiKey: 'flag-key' });
    expect(cfg.apiKey).toBe('flag-key');
  });

  it('falls back to COREDOC_LLM_API_KEY', () => {
    process.env.COREDOC_LLM_API_KEY = 'env-key';
    expect(resolveLlmConfig({ ...base, provider: 'openrouter', model: 'm' }).apiKey).toBe('env-key');
  });

  it('falls back to OLLAMA_BASE_URL only for the ollama provider', () => {
    process.env.OLLAMA_BASE_URL = 'http://gpu:11434';
    expect(resolveLlmConfig({ ...base, model: 'm' }).baseURL).toBe('http://gpu:11434');
    expect(resolveLlmConfig({ ...base, provider: 'openai', model: 'm', apiKey: 'k' }).baseURL).toBeUndefined();
  });

  it('prefers the --base-url flag over OLLAMA_BASE_URL', () => {
    process.env.OLLAMA_BASE_URL = 'http://env:11434';
    expect(resolveLlmConfig({ ...base, model: 'm', baseURL: 'http://flag:11434' }).baseURL).toBe('http://flag:11434');
  });
});

describe('buildSummarizeMetadata (P1.T3 summarize_completed enrichment)', () => {
  const stats: SummaryOutput['stats'] = {
    totalFunctions: 10,
    summarized: 7,
    skippedCached: 2,
    failedSummarization: 1,
    processingTimeMs: 4200,
  };

  it('enriches with model + duration_ms alongside the existing scorecard props', () => {
    expect(buildSummarizeMetadata(stats, 'claude-haiku')).toEqual({
      totalFunctions: 10,
      summarized: 7,
      cached: 2,
      failed: 1,
      model: 'claude-haiku',
      duration_ms: 4200,
    });
  });

  it('passes through an undefined model (default Claude Code path ships no override)', () => {
    expect(buildSummarizeMetadata(stats, undefined)).toMatchObject({ model: undefined, duration_ms: 4200 });
  });

  it('returns an empty object when stats are absent (no event props)', () => {
    expect(buildSummarizeMetadata(undefined, 'm')).toEqual({});
  });
});

// A node the substrate MINTED from a declaration convention (a Rails `has_many` reader) carries
// no body. Summarizing it is a paid LLM call per association whose prompt says "Source code not
// available" and whose output is a description of code that does not exist — so it never enters
// the work list, while the declared function beside it still does.
describe('runSummarize — synthesized functions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-summarize-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeRepo(functions: FunctionNode[]): string {
    const file = path.join(dir, 'parsed.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'repo1', name: 'repo1', functions, calls: [], packages: [] }), 'utf-8');
    return file;
  }

  it('excludes a synthesized function from the work list and keeps the declared one', async () => {
    const declared = makeFn('fn:declared', 'v1');
    const reader = {
      ...makeFn('fn:posts', 'v1', 'posts'),
      synthesized: 'ruby-association' as const,
      sourceCode: undefined,
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSummarize(
      { repo: writeRepo([declared, reader]), dryRun: true } as SummarizeOptions,
      { resolvedOutputDir: dir } as never,
    );

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Items to summarize: 1 / 2');
    expect(printed).toContain('Synthesized, no body (skipped): 1');
    expect(printed).toContain('- fn:declared');
    expect(printed).not.toContain('- posts');
  });

  it('skips it under --force too: there is no body to re-summarize', async () => {
    const reader = {
      ...makeFn('fn:posts', 'v1', 'posts'),
      synthesized: 'ruby-association' as const,
      sourceCode: undefined,
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSummarize(
      { repo: writeRepo([reader]), dryRun: true, force: true } as SummarizeOptions,
      { resolvedOutputDir: dir } as never,
    );

    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Items to summarize: 0 / 1');
  });
});

// A function parsed WITHOUT its body (a parser build or substrate that failed to capture it)
// would be summarized from its signature alone — a confident fabrication at full LLM
// cost. It is skipped, and nothing about it is written to the artifact, so the next run after a
// parse that carries sources picks it up as unsummarized.
describe('runSummarize — functions with no source code', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-nosource-'));
    summarized.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeRepo(functions: FunctionNode[]): string {
    const file = path.join(dir, 'parsed.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'repo1', name: 'repo1', functions, calls: [], packages: [] }), 'utf-8');
    return file;
  }

  function readArtifact(): SummaryOutput {
    return JSON.parse(fs.readFileSync(path.join(dir, 'repo1-summaries.json'), 'utf-8')) as SummaryOutput;
  }

  const bodyless = (): FunctionNode => ({ ...makeFn('fn:bodyless', 'v1', 'bodyless'), sourceCode: undefined });
  const synthesized = (): FunctionNode => ({
    ...makeFn('fn:posts', 'v1', 'posts'),
    synthesized: 'ruby-association' as const,
    sourceCode: undefined,
  });

  it('summarizes only the function that has a body, and counts the two skip reasons apart', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSummarize(
      { repo: writeRepo([makeFn('fn:declared', 'v1'), bodyless(), synthesized()]) } as SummarizeOptions,
      { resolvedOutputDir: dir } as never,
    );

    expect(summarized).toEqual(['fn:declared']);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Items to summarize: 1 / 3');
    expect(printed).toContain('Synthesized, no body (skipped): 1');
    expect(printed).toContain('No source code (skipped): 1');
    // Repeated in the final block, after the batch progress has scrolled the first line away.
    expect(printed).toContain('Skipped (no source code): 1');
  });

  it('writes no summary and no versionedId entry for the source-less function', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSummarize(
      { repo: writeRepo([makeFn('fn:declared', 'v1'), bodyless()]) } as SummarizeOptions,
      { resolvedOutputDir: dir } as never,
    );

    expect(readArtifact().summaries.map((s) => s.functionId)).toEqual(['fn:declared']);
  });

  it('picks it up on the next run once the parse carries sources', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = { resolvedOutputDir: dir } as never;

    await runSummarize({ repo: writeRepo([makeFn('fn:declared', 'v1'), bodyless()]) } as SummarizeOptions, config);
    summarized.length = 0;

    // Same versionedId — only the body is now present. A cached entry for it would pin the gap.
    await runSummarize(
      { repo: writeRepo([makeFn('fn:declared', 'v1'), makeFn('fn:bodyless', 'v1', 'bodyless')]) } as SummarizeOptions,
      config,
    );

    expect(summarized).toEqual(['fn:bodyless']);
    expect(
      readArtifact()
        .summaries.map((s) => s.functionId)
        .sort(),
    ).toEqual(['fn:bodyless', 'fn:declared']);
  });

  it('skips it under --force too: force ignores the cache, not the absence of a body', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runSummarize(
      { repo: writeRepo([bodyless()]), dryRun: true, force: true } as SummarizeOptions,
      { resolvedOutputDir: dir } as never,
    );

    expect(summarized).toEqual([]);
  });
});
