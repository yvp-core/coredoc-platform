import type { FileNode, FunctionNode, ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import {
  INTEGRITY_ERROR_FILE,
  IntegrityRef,
  applyIntegrityReport,
  checkReferentialIntegrity,
  isSyntheticHandlerId,
} from './referential-integrity.js';

const H = 'abc123def456';

function makeRepo(over: Partial<ParsedRepo>): ParsedRepo {
  const base: ParsedRepo = {
    id: H,
    name: 'acme',
    path: '/acme',
    parsedAt: '2026-08-22T00:00:00.000Z',
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
  // Keep the honesty check quiet unless a test targets it.
  if (over.stats === undefined) base.stats.parsedFiles = base.files.length;
  return base;
}

function makeFile(relPath: string, packageId = `${H}:package:.`): FileNode {
  const id = `${H}:file:${relPath}`;
  return {
    id,
    versionedId: `${id}@v1`,
    path: relPath,
    extension: relPath.slice(relPath.lastIndexOf('.')),
    packageId,
    language: 'typescript',
    contentHash: 'h',
  };
}

function makeFn(relPath: string, name: string, fileId: string): FunctionNode {
  const id = `${H}:function:${relPath}:${name}`;
  return {
    id,
    versionedId: `${id}@v1`,
    kind: 'function',
    name,
    fileId,
    isExported: true,
    isAsync: false,
    parameters: [],
    location: { filePath: relPath, startLine: 1, endLine: 2 },
  } as FunctionNode;
}

describe('checkReferentialIntegrity', () => {
  it('is clean on a repo whose refs all resolve', () => {
    const file = makeFile('src/a.ts');
    const pkg = { id: `${H}:package:.`, name: 'acme', path: '.' };
    const fn = makeFn('src/a.ts', 'doThing', file.id);
    const repo = makeRepo({ packages: [pkg], files: [file], functions: [fn] });

    const report = checkReferentialIntegrity(repo);

    expect(report.danglingRefs).toBe(0);
    expect(report.violations).toEqual([]);
  });

  it('catches a fabricated dangling functions.fileId with a count and sample ids', () => {
    const file = makeFile('src/a.ts');
    const pkg = { id: `${H}:package:.`, name: 'acme', path: '.' };
    const orphan = makeFn('src/gone.ts', 'ghost', `${H}:file:src/gone.ts`);
    const repo = makeRepo({
      packages: [pkg],
      files: [file],
      functions: [makeFn('src/a.ts', 'ok', file.id), orphan],
    });

    const report = checkReferentialIntegrity(repo);

    expect(report.danglingRefs).toBe(1);
    const v = report.violations.find((x) => x.ref === IntegrityRef.FunctionFile);
    expect(v).toBeDefined();
    expect(v?.count).toBe(1);
    expect(v?.samples).toEqual([`${H}:file:src/gone.ts`]);
  });

  it('flags a container reference that resolves to no class, whatever the function kind', () => {
    const file = makeFile('src/a.ts');
    const pkg = { id: `${H}:package:.`, name: 'acme', path: '.' };
    const orphan = { ...makeFn('src/a.ts', 'ghostMethod', file.id), classId: `${H}:class:src/a.ts:Ghost` };
    const repo = makeRepo({ packages: [pkg], files: [file], functions: [orphan] });

    const report = checkReferentialIntegrity(repo);

    const v = report.violations.find((x) => x.ref === IntegrityRef.FunctionClass);
    expect(v?.count).toBe(1);
    expect(v?.samples).toEqual([`${H}:class:src/a.ts:Ghost`]);
  });

  it('caps samples at 3 while counting every violation', () => {
    const repo = makeRepo({
      functions: Array.from({ length: 7 }, (_, i) => makeFn(`src/f${i}.ts`, `f${i}`, `${H}:file:src/f${i}.ts`)),
    });

    const v = checkReferentialIntegrity(repo).violations.find((x) => x.ref === IntegrityRef.FunctionFile);

    expect(v?.count).toBe(7);
    expect(v?.samples).toHaveLength(3);
  });

  it('checks calls.callerId/calleeId but tolerates an unresolved (absent) calleeId', () => {
    const file = makeFile('src/a.ts');
    const pkg = { id: `${H}:package:.`, name: 'acme', path: '.' };
    const caller = makeFn('src/a.ts', 'caller', file.id);
    const repo = makeRepo({
      packages: [pkg],
      files: [file],
      functions: [caller],
      calls: [
        { id: 'c1', callerId: caller.id, location: { filePath: 'src/a.ts', startLine: 1, endLine: 1 } },
        {
          id: 'c2',
          callerId: caller.id,
          calleeId: `${H}:function:src/b.ts:missing`,
          location: { filePath: 'src/a.ts', startLine: 2, endLine: 2 },
        },
      ] as ParsedRepo['calls'],
    });

    const report = checkReferentialIntegrity(repo);

    expect(report.byCollection[IntegrityRef.CallCallee]).toBe(1);
    expect(report.byCollection[IntegrityRef.CallCaller]).toBeUndefined();
  });

  it('treats synthetic route/queue handler ids as a documented exception, not a violation', () => {
    const repo = makeRepo({
      entrypoints: [
        {
          id: 'ep1',
          versionedId: 'ep1@v1',
          type: 'http',
          name: 'GET /users/{pk}/',
          handlerId: `${H}:function:api/urls.py:GET /users/{pk}/`,
          location: { filePath: 'api/urls.py', startLine: 1, endLine: 1 },
        },
        {
          id: 'ep2',
          versionedId: 'ep2@v1',
          type: 'queue',
          name: 'jobs',
          handlerId: `${H}:function:app/jobs.rb:queue:jobs`,
          location: { filePath: 'app/jobs.rb', startLine: 1, endLine: 1 },
        },
        {
          id: 'ep3',
          versionedId: 'ep3@v1',
          type: 'http',
          name: 'realHandler',
          handlerId: `${H}:function:src/api.ts:realHandler`,
          location: { filePath: 'src/api.ts', startLine: 1, endLine: 1 },
        },
      ] as ParsedRepo['entrypoints'],
    });

    const report = checkReferentialIntegrity(repo);

    expect(report.syntheticHandlers).toBe(2);
    expect(report.byCollection[IntegrityRef.EntrypointHandler]).toBe(1);
  });

  it('flags stats.parsedFiles disagreeing with files[].length (the posthog G2 signature)', () => {
    const repo = makeRepo({ files: [makeFile('src/a.ts')] });
    repo.packages = [{ id: `${H}:package:.`, name: 'acme', path: '.' }];
    repo.stats.parsedFiles = 11461;

    const report = checkReferentialIntegrity(repo);

    expect(report.byCollection[IntegrityRef.StatsParsedFiles]).toBe(11460);
    // A stats lie is not a dangling reference — it is reported separately.
    expect(report.danglingRefs).toBe(0);
  });
});

describe('isSyntheticHandlerId', () => {
  it.each([
    [`${H}:function:api/urls.py:GET /users/`, true],
    [`${H}:function:app/jobs.rb:queue:emails`, true],
    [`${H}:function:src/api.ts:handleUser`, false],
    [`${H}:method:src/api.ts:Ctrl.handle`, false],
  ])('%s → %s', (id, expected) => {
    expect(isSyntheticHandlerId(id)).toBe(expected);
  });
});

describe('applyIntegrityReport', () => {
  it('records violations as severity-error ParseErrors and stats.integrity', () => {
    const repo = makeRepo({ functions: [makeFn('src/a.ts', 'ghost', `${H}:file:src/a.ts`)] });

    applyIntegrityReport(repo);

    expect(repo.stats.integrity).toEqual({ danglingRefs: 1, byCollection: { [IntegrityRef.FunctionFile]: 1 } });
    const err = (repo.errors ?? []).find((e) => e.file === INTEGRITY_ERROR_FILE);
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('functions.fileId');
  });

  it('preserves pre-existing errors and is idempotent across repeated applications', () => {
    const repo = makeRepo({
      functions: [makeFn('src/a.ts', 'ghost', `${H}:file:src/a.ts`)],
      errors: [{ file: '.', message: 'scip degraded', severity: 'warning' }],
    });

    applyIntegrityReport(repo);
    applyIntegrityReport(repo);

    expect(repo.errors?.filter((e) => e.file === INTEGRITY_ERROR_FILE)).toHaveLength(1);
    expect(repo.errors?.filter((e) => e.message === 'scip degraded')).toHaveLength(1);
  });

  it('leaves errors undefined on a clean repo', () => {
    const repo = makeRepo({});

    applyIntegrityReport(repo);

    expect(repo.errors).toBeUndefined();
    expect(repo.stats.integrity?.danglingRefs).toBe(0);
  });
});
