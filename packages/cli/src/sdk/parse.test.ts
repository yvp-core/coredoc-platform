/**
 * Tests for the SDK parse's product-funnel telemetry (P1.T2 — repo_added).
 *
 * There is NO `coredoc add` command: a repo is materialized on its FIRST parse,
 * so `repo_added` fires exactly once, on that first parse. Detection queries the
 * ops repository for a PRIOR completed parse BEFORE this one records — these
 * tests assert the emit (and its non-emit on a repeat parse) with a fake `track`
 * and NO real DB / parser / network:
 *  - `../parser-loader.js` returns a fake parser whose `.parse()` yields a stub
 *    `ParsedRepo` (files + packages the funnel props read).
 *  - `@coredoc/db` is mocked; `getOperationSummary` drives first-vs-repeat.
 *  - `@coredoc/core/telemetry` keeps its REAL enums (via importActual); only
 *    `track`/`shutdownTelemetry` are spied.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedRepo } from '@coredoc/core/types';
import { EventName, repoId } from '@coredoc/core/telemetry';
import { getTelemetryConfig } from '@coredoc/core/utils';

const { trackSpy, getOperationSummarySpy, loadParserSpy, bindProjectDatabaseSpy } = vi.hoisted(() => ({
  trackSpy: vi.fn(),
  getOperationSummarySpy: vi.fn(),
  loadParserSpy: vi.fn(),
  bindProjectDatabaseSpy: vi.fn().mockResolvedValue(undefined),
}));

// Keep the real vocabulary; only intercept the emit sinks.
vi.mock('@coredoc/core/telemetry', async (importActual) => {
  const actual = await importActual<typeof import('@coredoc/core/telemetry')>();
  return {
    ...actual,
    track: trackSpy,
    shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  };
});

// SQLite ops table is a no-op; getOperationSummary drives first-parse detection.
vi.mock('@coredoc/db', () => ({
  getOperationsRepository: vi.fn().mockResolvedValue({
    getOperationSummary: getOperationSummarySpy,
    startOperation: vi.fn().mockResolvedValue('op-1'),
    completeOperation: vi.fn().mockResolvedValue(undefined),
    failOperation: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../parser-loader.js', () => ({
  loadParser: loadParserSpy,
}));

vi.mock('../db-scope.js', () => ({ bindProjectDatabase: bindProjectDatabaseSpy }));

import { parse } from './parse.js';
import { loadConfig } from './config.js';

function makeParsedRepo(overrides?: Partial<ParsedRepo>): ParsedRepo {
  return {
    path: '/tmp/coredoc-test/svc-a',
    stats: {
      totalFiles: 3,
      parsedFiles: 3,
      skippedFiles: 0,
      totalFunctions: 10,
      totalClasses: 0,
      totalEntrypoints: 2,
      totalEntities: 1,
      totalCalls: 5,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 100,
    },
    errors: [],
    files: [{ language: 'typescript' }, { language: 'typescript' }, { language: 'python' }],
    packages: [{}, {}, {}],
    ...overrides,
    // Unused-by-funnel fields left off — cast bridges the partial shape.
  } as unknown as ParsedRepo;
}

let tmp: string;

function writeConfig(): string {
  const configPath = join(tmp, 'coredoc.config.json');
  mkdirSync(join(tmp, 'svc-a'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: '2.0',
      projects: [
        {
          id: 'alpha',
          name: 'Alpha',
          repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }],
        },
      ],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'interactive',
    }),
    'utf-8',
  );
  return configPath;
}

describe('parse — repo_added (P1.T2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), 'sdk-parse-'));
    loadParserSpy.mockResolvedValue({ parse: async () => makeParsedRepo() });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits repo_added once on the FIRST parse (no prior lastParsed)', async () => {
    getOperationSummarySpy.mockResolvedValue({ projectId: 'alpha', repoName: 'svc-a' });
    const config = loadConfig(writeConfig());

    await parse({ config, repo: 'svc-a' });

    expect(bindProjectDatabaseSpy).toHaveBeenCalledWith(config, 'alpha');

    const added = trackSpy.mock.calls.filter((c) => c[0] === EventName.RepoAdded);
    expect(added).toHaveLength(1);
    expect(added[0]?.[1]).toMatchObject({
      package_count: 3,
      language_hint: 'typescript,python',
    });
    // repo_added is the funnel entry milestone — assert it anchors the funnel
    // with a non-empty repo_id derived from the parsed repo path.
    const { installId } = await getTelemetryConfig();
    const expectedRepoId = repoId(installId, '/tmp/coredoc-test/svc-a');
    expect(expectedRepoId).not.toBe('');
    expect((added[0]?.[1] as Record<string, unknown>).repo_id).toBe(expectedRepoId);
  });

  it('does NOT emit repo_added when a prior parse already exists', async () => {
    getOperationSummarySpy.mockResolvedValue({
      projectId: 'alpha',
      repoName: 'svc-a',
      lastParsed: { id: 'op-0', operation: 'parse', status: 'completed' },
    });
    const config = loadConfig(writeConfig());

    await parse({ config, repo: 'svc-a' });

    expect(trackSpy.mock.calls.find((c) => c[0] === EventName.RepoAdded)).toBeUndefined();
  });

  it('is null-safe when the parsed repo has no packages or files', async () => {
    getOperationSummarySpy.mockResolvedValue({ projectId: 'alpha', repoName: 'svc-a' });
    loadParserSpy.mockResolvedValue({
      parse: async () => makeParsedRepo({ files: [], packages: [] }),
    });
    const config = loadConfig(writeConfig());

    await parse({ config, repo: 'svc-a' });

    const added = trackSpy.mock.calls.find((c) => c[0] === EventName.RepoAdded);
    expect(added?.[1]).toMatchObject({ package_count: 0, language_hint: '' });
  });

  it('fails the parse and preserves the previous output boundary on extraction errors', async () => {
    getOperationSummarySpy.mockResolvedValue({ projectId: 'alpha', repoName: 'svc-a' });
    loadParserSpy.mockResolvedValue({
      parse: async () =>
        makeParsedRepo({
          errors: [
            { file: '.', message: 'scip-typescript produced no usable index', severity: 'error' },
            { file: '.', message: 'recovered split diagnostic', severity: 'warning' },
          ],
        }),
    });
    const config = loadConfig(writeConfig());
    const previousOutput = join(tmp, 'out', 'alpha', 'svc-a.json');
    mkdirSync(join(tmp, 'out', 'alpha'), { recursive: true });
    writeFileSync(previousOutput, '{"previous":true}');

    await expect(parse({ config, repo: 'svc-a' })).rejects.toThrow('Failed to parse 1 repo');

    expect(readFileSync(previousOutput, 'utf8')).toBe('{"previous":true}');
    expect(trackSpy.mock.calls.find((call) => call[0] === EventName.RepoAdded)).toBeUndefined();
  });
});
