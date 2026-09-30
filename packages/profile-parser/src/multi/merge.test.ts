import type { FileNode, ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import { mergeParsedRepos } from './merge.js';

function makeRepo(over: Partial<ParsedRepo>): ParsedRepo {
  return {
    id: 'rh:repo:acme',
    name: 'acme',
    path: '/acme',
    parsedAt: '2026-07-16T00:00:00.000Z',
    parserVersion: '1.0.0',
    parserId: 'acme',
    packages: [],
    files: [],
    functions: [],
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
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      skippedFiles: 0,
      totalFunctions: 0,
      totalClasses: 0,
      totalEntrypoints: 0,
      totalEntities: 0,
      totalCalls: 0,
      totalImports: 0,
      totalExternalCalls: 0,
      parseTimeMs: 0,
    },
    ...over,
  };
}

function makeFile(id: string, filePath: string, packageId: string, language: string): FileNode {
  return {
    id,
    versionedId: `${id}@v1`,
    path: filePath,
    extension: filePath.slice(filePath.lastIndexOf('.')),
    packageId,
    language,
    contentHash: 'h',
  };
}

const pkg = (id: string, name: string, path: string) => ({ id, name, path });

describe('mergeParsedRepos', () => {
  // The record is per repository (spec LIM-5), so a multi-target profile reports one summed
  // record; a target that measured nothing must contribute nothing, not zeros.
  it('sums stats.callResolution over the targets that recorded one', () => {
    const a = makeRepo({
      stats: { ...makeRepo({}).stats, callResolution: { callSites: 10, resolvedCalls: 6, outOfScopeCalls: 3 } },
    });
    const b = makeRepo({
      stats: { ...makeRepo({}).stats, callResolution: { callSites: 4, resolvedCalls: 1, outOfScopeCalls: 2 } },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: a },
      { name: 'api', repo: b },
    ]);

    expect(merged.stats.callResolution).toEqual({
      callSites: 14,
      resolvedCalls: 7,
      outOfScopeCalls: 5,
    });
  });

  it('keeps the one recorded callResolution when a target did not measure it', () => {
    const a = makeRepo({
      stats: { ...makeRepo({}).stats, callResolution: { callSites: 10, resolvedCalls: 6, outOfScopeCalls: 3 } },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: a },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect(merged.stats.callResolution).toEqual({
      callSites: 10,
      resolvedCalls: 6,
      outOfScopeCalls: 3,
    });
  });

  it('omits callResolution entirely when no target recorded one', () => {
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: makeRepo({}) },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect('callResolution' in merged.stats).toBe(false);
  });

  // Mirrors callResolution: dbOpResolution is per repository, summed over targets that measured it.
  it('sums stats.dbOpResolution over the targets that recorded one', () => {
    const a = makeRepo({
      stats: { ...makeRepo({}).stats, dbOpResolution: { dbOpSites: 10, boundDbOps: 6, outOfScopeDbOps: 3 } },
    });
    const b = makeRepo({
      stats: { ...makeRepo({}).stats, dbOpResolution: { dbOpSites: 4, boundDbOps: 1, outOfScopeDbOps: 2 } },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: a },
      { name: 'api', repo: b },
    ]);

    expect(merged.stats.dbOpResolution).toEqual({
      dbOpSites: 14,
      boundDbOps: 7,
      outOfScopeDbOps: 5,
    });
  });

  it('keeps the one recorded dbOpResolution when a target did not measure it', () => {
    const a = makeRepo({
      stats: { ...makeRepo({}).stats, dbOpResolution: { dbOpSites: 10, boundDbOps: 6, outOfScopeDbOps: 3 } },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: a },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect(merged.stats.dbOpResolution).toEqual({
      dbOpSites: 10,
      boundDbOps: 6,
      outOfScopeDbOps: 3,
    });
  });

  it('omits dbOpResolution entirely when no target recorded one', () => {
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: makeRepo({}) },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect('dbOpResolution' in merged.stats).toBe(false);
  });

  // Per-language diagnostic records. The CLI ambiguity suffix reads `stats.kotlin`, so losing
  // it in the merge is exactly the multi-target Android+backend case that suffix exists for.
  const kotlinStats = (over: Partial<NonNullable<ParsedRepo['stats']['kotlin']>>) => ({
    filesParsed: 0,
    filesWithSyntaxErrors: 0,
    callSites: 0,
    resolvedCalls: 0,
    ambiguousCalls: 0,
    outOfScopeCalls: 0,
    byTier: {},
    endpointsDefined: 0,
    egressCallSites: 0,
    entrypointsWithoutHandler: 0,
    unparsedDaoQueries: 0,
    ...over,
  });

  it('sums stats.kotlin over the targets that recorded one, merging byTier by key', () => {
    const android = makeRepo({
      stats: {
        ...makeRepo({}).stats,
        kotlin: kotlinStats({
          filesParsed: 12,
          callSites: 10,
          resolvedCalls: 6,
          ambiguousCalls: 1,
          outOfScopeCalls: 2,
          byTier: { 'kt-type': 4, 'kt-import': 2 },
          unparsedDaoQueries: 3,
        }),
      },
    });
    const api = makeRepo({
      stats: {
        ...makeRepo({}).stats,
        kotlin: kotlinStats({
          filesParsed: 5,
          callSites: 4,
          resolvedCalls: 3,
          byTier: { 'kt-type': 1, 'kt-member': 2 },
        }),
      },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'android', repo: android },
      { name: 'api', repo: api },
    ]);

    expect(merged.stats.kotlin).toEqual(
      kotlinStats({
        filesParsed: 17,
        callSites: 14,
        resolvedCalls: 9,
        ambiguousCalls: 1,
        outOfScopeCalls: 2,
        byTier: { 'kt-type': 5, 'kt-import': 2, 'kt-member': 2 },
        unparsedDaoQueries: 3,
      }),
    );
  });

  it('omits stats.kotlin entirely when no target recorded one', () => {
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: makeRepo({}) },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect('kotlin' in merged.stats).toBe(false);
  });

  it('sums stats.python, concatenating skipped files and re-ranking unresolved modules', () => {
    const svc = makeRepo({
      stats: {
        ...makeRepo({}).stats,
        python: {
          filesParsed: 20,
          syntaxErrors: 1,
          skippedFiles: ['svc/bad.py'],
          unresolvedImports: 7,
          durationMs: 100,
          topUnresolvedModules: [{ module: 'boto3', count: 5 }],
        },
      },
    });
    const jobs = makeRepo({
      stats: {
        ...makeRepo({}).stats,
        python: {
          filesParsed: 4,
          syntaxErrors: 0,
          skippedFiles: ['jobs/worse.py'],
          unresolvedImports: 2,
          durationMs: 40,
          topUnresolvedModules: [
            { module: 'celery', count: 9 },
            { module: 'boto3', count: 1 },
          ],
        },
      },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'svc', repo: svc },
      { name: 'jobs', repo: jobs },
    ]);

    expect(merged.stats.python).toEqual({
      filesParsed: 24,
      syntaxErrors: 1,
      skippedFiles: ['svc/bad.py', 'jobs/worse.py'],
      unresolvedImports: 9,
      durationMs: 140,
      topUnresolvedModules: [
        { module: 'celery', count: 9 },
        { module: 'boto3', count: 6 },
      ],
    });
  });

  it('omits stats.python entirely when no target recorded one', () => {
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: makeRepo({}) },
      { name: 'api', repo: makeRepo({}) },
    ]);

    expect('python' in merged.stats).toBe(false);
  });

  it('concatenates node arrays and recomputes stats (parseTimeMs = max, file counts summed)', () => {
    const web = makeRepo({
      files: [makeFile('f1', 'ui/App.tsx', 'pkg-ui', 'typescript')],
      functions: [{ id: 'fn1' } as never],
      stats: { ...makeRepo({}).stats, totalFiles: 1, parsedFiles: 1, parseTimeMs: 100 },
    });
    const api = makeRepo({
      files: [makeFile('f2', 'api/app.rb', 'pkg-api', 'ruby')],
      functions: [{ id: 'fn2' } as never],
      stats: { ...makeRepo({}).stats, totalFiles: 2, parsedFiles: 1, skippedFiles: 1, parseTimeMs: 250 },
    });
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'api', repo: api },
    ]);
    expect(merged.files).toHaveLength(2);
    expect(merged.functions.map((f) => f.id)).toEqual(['fn1', 'fn2']);
    expect(merged.type).toBe('monorepo');
    expect(merged.parserId).toBe('acme');
    expect(merged.stats.totalFiles).toBe(3);
    expect(merged.stats.parsedFiles).toBe(2);
    expect(merged.stats.skippedFiles).toBe(1);
    expect(merged.stats.totalFunctions).toBe(2);
    expect(merged.stats.parseTimeMs).toBe(250);
  });

  it('stamps each merged file with the name of the target that claimed it', () => {
    const web = makeRepo({
      files: [makeFile('f1', 'ui/App.tsx', 'pkg-ui', 'typescript')],
    });
    const api = makeRepo({
      files: [makeFile('f2', 'api/app.rb', 'pkg-api', 'ruby')],
    });
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'api', repo: api },
    ]);
    expect(merged.files.find((f) => f.id === 'f1')?.target).toBe('web');
    expect(merged.files.find((f) => f.id === 'f2')?.target).toBe('api');
  });

  it('stamps the owning target even when two targets share a language', () => {
    const web = makeRepo({
      files: [makeFile('f1', 'apps/web/index.ts', 'pkg-web', 'typescript')],
    });
    const admin = makeRepo({
      files: [makeFile('f2', 'apps/admin/index.ts', 'pkg-admin', 'typescript')],
    });
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'admin', repo: admin },
    ]);
    expect(merged.files.find((f) => f.id === 'f1')?.target).toBe('web');
    expect(merged.files.find((f) => f.id === 'f2')?.target).toBe('admin');
  });

  it('throws when two targets claim the same file, naming both targets and the path', () => {
    const a = makeRepo({ files: [makeFile('f1', 'shared/x.ts', 'p', 'typescript')] });
    const b = makeRepo({ files: [makeFile('f1', 'shared/x.ts', 'p', 'typescript')] });
    expect(() =>
      mergeParsedRepos('acme', undefined, [
        { name: 'web', repo: a },
        { name: 'admin', repo: b },
      ]),
    ).toThrow(/'web' and 'admin'.*shared\/x\.ts/);
  });

  it('de-dupes packages by id and sets the dominant language per package', () => {
    const web = makeRepo({
      packages: [pkg('p-root', 'acme', '.'), pkg('p-ui', 'ui', 'ui')],
      files: [makeFile('f1', 'ui/a.tsx', 'p-ui', 'typescript'), makeFile('f2', 'ui/b.tsx', 'p-ui', 'typescript')],
    });
    const api = makeRepo({
      packages: [pkg('p-root', 'acme', '.'), pkg('p-api', 'api', 'api')],
      files: [makeFile('f3', 'api/a.rb', 'p-api', 'ruby')],
    });
    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'api', repo: api },
    ]);
    expect(merged.packages).toHaveLength(3);
    expect(merged.packages.find((p) => p.id === 'p-ui')?.language).toBe('typescript');
    expect(merged.packages.find((p) => p.id === 'p-api')?.language).toBe('ruby');
    expect(merged.packages.find((p) => p.id === 'p-root')?.language).toBeUndefined();
  });

  it('includes optional arrays only when some target emitted them', () => {
    const web = makeRepo({ components: [{ id: 'c1' } as never] });
    const api = makeRepo({});
    const merged = mergeParsedRepos('acme', undefined, [
      { name: 'web', repo: web },
      { name: 'api', repo: api },
    ]);
    expect(merged.components).toHaveLength(1);
    expect(merged.routes).toBeUndefined();
    expect(merged.errors).toBeUndefined();
  });

  it('throws on a repo-id mismatch (targets must share repoKey/repoName)', () => {
    const a = makeRepo({});
    const b = makeRepo({ id: 'OTHER:repo:acme' });
    expect(() =>
      mergeParsedRepos('acme', undefined, [
        { name: 'a', repo: a },
        { name: 'b', repo: b },
      ]),
    ).toThrow(/must share repoKey/);
  });

  it('throws on empty results', () => {
    expect(() => mergeParsedRepos('acme', undefined, [])).toThrow(/no target results/);
  });
});

describe('mergeParsedRepos referential integrity', () => {
  it('records a target that emitted functions but no file nodes (the posthog G1 shape)', () => {
    const web = makeRepo({
      packages: [pkg('p-ui', 'ui', 'ui')],
      files: [makeFile('f1', 'ui/App.tsx', 'p-ui', 'typescript')],
      stats: { ...makeRepo({}).stats, parsedFiles: 1 },
    });
    // A target with functions whose fileId names a node it never emitted.
    const py = makeRepo({
      functions: [{ id: 'fn-py', fileId: 'f-missing', kind: 'function' } as never],
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'python', repo: py },
    ]);

    expect(merged.stats.integrity).toEqual({ danglingRefs: 1, byCollection: { 'functions.fileId': 1 } });
    const err = (merged.errors ?? []).find((e) => e.file === '<integrity>');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('functions.fileId');
  });

  it('leaves a consistent merge clean', () => {
    const web = makeRepo({
      packages: [pkg('p-ui', 'ui', 'ui')],
      files: [makeFile('f1', 'ui/App.tsx', 'p-ui', 'typescript')],
      functions: [{ id: 'fn1', fileId: 'f1', kind: 'function' } as never],
      stats: { ...makeRepo({}).stats, parsedFiles: 1 },
    });
    const api = makeRepo({
      packages: [pkg('p-api', 'api', 'api')],
      files: [makeFile('f2', 'api/app.rb', 'p-api', 'ruby')],
      stats: { ...makeRepo({}).stats, parsedFiles: 1 },
    });

    const merged = mergeParsedRepos('acme', 'monorepo', [
      { name: 'web', repo: web },
      { name: 'api', repo: api },
    ]);

    expect(merged.stats.integrity?.danglingRefs).toBe(0);
    expect(merged.errors).toBeUndefined();
  });
});
