import type { CallEdge, FileNode, FunctionNode, ImportEdge, ParsedRepo } from '@coredoc/core/types';
import { describe, expect, it } from 'vitest';
import {
  blockingExtractionErrors,
  callResolutionBlackouts,
  declaredFrontendRules,
  extractionErrorSummary,
  perPackageCallResolution,
  unclaimedFrontendRedFlags,
  unclaimedFrontendSurface,
} from './silent-failure.js';
import { isOverallPass } from './score-core.js';

const H = 'abc123def456';

function makeRepo(over: Partial<ParsedRepo>): ParsedRepo {
  return {
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
      parsedFiles: over.files?.length ?? 0,
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

const pkgId = (p: string) => `${H}:package:${p}`;

function makePackage(packagePath: string, dependencies: Record<string, string> = {}) {
  return {
    id: pkgId(packagePath),
    name: packagePath === '.' ? 'acme' : packagePath.split('/').at(-1)!,
    path: packagePath,
    dependencies,
  };
}

function makeFile(relPath: string, packagePath: string): FileNode {
  const id = `${H}:file:${relPath}`;
  return {
    id,
    versionedId: `${id}@v1`,
    path: relPath,
    extension: relPath.slice(relPath.lastIndexOf('.')),
    packageId: pkgId(packagePath),
    language: 'typescript',
    contentHash: 'h',
  };
}

function makeFn(relPath: string, name: string): FunctionNode {
  const id = `${H}:function:${relPath}:${name}`;
  return {
    id,
    versionedId: `${id}@v1`,
    kind: 'function',
    name,
    fileId: `${H}:file:${relPath}`,
    isExported: true,
    isAsync: false,
    parameters: [],
    location: { filePath: relPath, startLine: 1, endLine: 2 },
  } as FunctionNode;
}

/** A package with `fnCount` functions whose calls resolve at the given rate. */
function packageFixture(
  packagePath: string,
  fnCount: number,
  resolvedPerFn: number,
  unresolvedPerFn: number,
): { files: FileNode[]; functions: FunctionNode[]; calls: CallEdge[] } {
  const files: FileNode[] = [];
  const functions: FunctionNode[] = [];
  const calls: CallEdge[] = [];
  for (let i = 0; i < fnCount; i++) {
    const rel = `${packagePath}/src/f${i}.ts`;
    files.push(makeFile(rel, packagePath));
    const fn = makeFn(rel, `f${i}`);
    functions.push(fn);
    for (let r = 0; r < resolvedPerFn; r++) {
      calls.push({
        id: `${packagePath}-r-${i}-${r}`,
        callerId: fn.id,
        calleeId: fn.id,
        location: { filePath: rel, startLine: 1, endLine: 1 },
      } as CallEdge);
    }
    for (let u = 0; u < unresolvedPerFn; u++) {
      calls.push({
        id: `${packagePath}-u-${i}-${u}`,
        callerId: fn.id,
        location: { filePath: rel, startLine: 2, endLine: 2 },
      } as CallEdge);
    }
  }
  return { files, functions, calls };
}

describe('perPackageCallResolution', () => {
  it('attributes call sites to the caller function’s owning package', () => {
    const ui = packageFixture('packages/ui', 2, 3, 1);
    const www = packageFixture('apps/www', 2, 0, 2);
    const repo = makeRepo({
      packages: [
        { id: pkgId('packages/ui'), name: 'ui', path: 'packages/ui' },
        { id: pkgId('apps/www'), name: 'www', path: 'apps/www' },
      ],
      files: [...ui.files, ...www.files],
      functions: [...ui.functions, ...www.functions],
      calls: [...ui.calls, ...www.calls],
    });

    const rows = perPackageCallResolution(repo);

    expect(rows.map((r) => r.packagePath)).toEqual(['apps/www', 'packages/ui']);
    expect(rows[0]).toMatchObject({ callSites: 4, resolved: 0, rate: 0, functions: 2 });
    expect(rows[1]).toMatchObject({ callSites: 8, resolved: 6, rate: 0.75 });
  });
});

describe('callResolutionBlackouts', () => {
  it('fires on the bimodal shape: a ≥20-function package at 0% beside a >50% package', () => {
    const healthy = packageFixture('packages/ui', 20, 3, 1);
    const dead = packageFixture('apps/www', 25, 0, 2);
    const repo = makeRepo({
      packages: [
        { id: pkgId('packages/ui'), name: 'ui', path: 'packages/ui' },
        { id: pkgId('apps/www'), name: 'www', path: 'apps/www' },
      ],
      files: [...healthy.files, ...dead.files],
      functions: [...healthy.functions, ...dead.functions],
      calls: [...healthy.calls, ...dead.calls],
    });

    const flags = callResolutionBlackouts(perPackageCallResolution(repo));

    expect(flags).toHaveLength(1);
    expect(flags[0]).toContain("package 'apps/www' resolves 0/50 call sites");
    expect(flags[0]).toContain("'packages/ui' resolves 75%");
    expect(flags[0]).toContain('call graph is silently empty');
  });

  it('stays silent when the 0% package is small (below the function floor)', () => {
    const healthy = packageFixture('packages/ui', 20, 3, 1);
    const tiny = packageFixture('scripts', 5, 0, 2);
    const repo = makeRepo({
      packages: [
        { id: pkgId('packages/ui'), name: 'ui', path: 'packages/ui' },
        { id: pkgId('scripts'), name: 'scripts', path: 'scripts' },
      ],
      files: [...healthy.files, ...tiny.files],
      functions: [...healthy.functions, ...tiny.functions],
      calls: [...healthy.calls, ...tiny.calls],
    });

    expect(callResolutionBlackouts(perPackageCallResolution(repo))).toEqual([]);
  });

  it('stays silent when the WHOLE repo resolves poorly (uniform, not bimodal)', () => {
    const a = packageFixture('packages/a', 25, 0, 2);
    const b = packageFixture('packages/b', 25, 0, 2);
    const repo = makeRepo({
      packages: [
        { id: pkgId('packages/a'), name: 'a', path: 'packages/a' },
        { id: pkgId('packages/b'), name: 'b', path: 'packages/b' },
      ],
      files: [...a.files, ...b.files],
      functions: [...a.functions, ...b.functions],
      calls: [...a.calls, ...b.calls],
    });

    expect(callResolutionBlackouts(perPackageCallResolution(repo))).toEqual([]);
  });
});

describe('declaredFrontendRules', () => {
  it('treats an empty stateStores array as undeclared', () => {
    expect(declaredFrontendRules({ components: {}, stateStores: [], routes: undefined })).toEqual({
      components: true,
      stateStores: false,
      routes: false,
    });
  });
});

describe('unclaimedFrontendSurface', () => {
  const componentFiles = Array.from({ length: 22 }, (_, i) => makeFile(`src/c${i}.tsx`, '.'));
  const stateImports: ImportEdge[] = Array.from({ length: 12 }, (_, i) => ({
    id: `imp${i}`,
    sourceFileId: `${H}:file:src/c${i}.tsx`,
    moduleSpecifier: 'zustand',
    isTypeOnly: false,
    importKind: 'named',
  }));
  const pageFiles = Array.from({ length: 6 }, (_, i) => makeFile(`apps/web/pages/p${i}.tsx`, 'apps/web'));
  const frontendRepo = makeRepo({
    packages: [makePackage('.'), makePackage('apps/web')],
    files: [...componentFiles, ...pageFiles],
    imports: stateImports,
  });

  it('flags components, stateStores and routes when the profile declares none', () => {
    const signals = unclaimedFrontendSurface(frontendRepo, { substrate: { language: 'ts' } });

    expect(signals.map((s) => s.surface).sort()).toEqual(['components', 'routes', 'stateStores']);
    expect(signals.find((s) => s.surface === 'components')?.count).toBe(28);
    expect(signals.find((s) => s.surface === 'stateStores')?.count).toBe(12);
    expect(signals.find((s) => s.surface === 'routes')?.count).toBe(6);
  });

  it('keeps Pages API and App Router handler gaps separate', () => {
    const apiRepo = makeRepo({
      packages: [makePackage('apps/studio', { next: '^15.0.0' }), makePackage('apps/docs', { next: '^15.0.0' })],
      files: [
        makeFile('apps/studio/pages/api/health.ts', 'apps/studio'),
        makeFile('apps/docs/app/api/health/route.ts', 'apps/docs'),
      ],
    });
    const flagged = unclaimedFrontendSurface(apiRepo, { substrate: { language: 'ts' } });
    expect(flagged.filter((s) => s.surface === 'api-handlers')).toEqual([
      expect.objectContaining({
        count: 1,
        message: expect.stringContaining('"apps/studio/pages/api/health.ts"'),
      }),
      expect.objectContaining({
        count: 1,
        message: expect.stringContaining('"apps/docs/app/api/health/route.ts"'),
      }),
    ]);
    const redFlags = unclaimedFrontendRedFlags(flagged);
    expect(redFlags).toEqual([expect.stringContaining('Pages Router'), expect.stringContaining('App Router')]);
    expect(isOverallPass([], [], redFlags)).toBe(false);

    const pagesOnly = unclaimedFrontendSurface(apiRepo, {
      substrate: { language: 'ts' },
      entrypoints: [{ kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' }],
    });
    expect(pagesOnly.filter((s) => s.surface === 'api-handlers')).toEqual([
      expect.objectContaining({ count: 1, message: expect.stringContaining('App Router') }),
    ]);

    const appOnly = unclaimedFrontendSurface(apiRepo, {
      substrate: { language: 'ts' },
      entrypoints: [{ kind: 'http', via: 'file-convention', framework: 'next-app-router', routeRoot: 'app' }],
    });
    expect(appOnly.filter((s) => s.surface === 'api-handlers')).toEqual([
      expect.objectContaining({ count: 1, message: expect.stringContaining('Pages Router') }),
    ]);

    const claimed = unclaimedFrontendSurface(apiRepo, {
      substrate: { language: 'ts' },
      entrypoints: [
        { kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' },
        { kind: 'http', via: 'file-convention', framework: 'next-app-router', routeRoot: 'app' },
      ],
    });
    expect(claimed.find((s) => s.surface === 'api-handlers')).toBeUndefined();
  });

  it('does not let prefix-shaped HTTP route roots claim segment-shaped Next surfaces', () => {
    const apiRepo = makeRepo({
      packages: [makePackage('apps/studio', { next: '^15.0.0' }), makePackage('apps/docs', { next: '^15.0.0' })],
      files: [
        ...Array.from({ length: 5 }, (_, i) => makeFile(`apps/studio/pages/api/h${i}.ts`, 'apps/studio')),
        ...Array.from({ length: 5 }, (_, i) => makeFile(`apps/docs/app/api/h${i}/route.ts`, 'apps/docs')),
      ],
    });

    const signals = unclaimedFrontendSurface(apiRepo, {
      substrate: { language: 'ts' },
      entrypoints: [
        {
          kind: 'http',
          via: 'file-convention',
          framework: 'next-pages-api',
          routeRoot: 'apps/studio/pages',
        },
        {
          kind: 'http',
          via: 'file-convention',
          framework: 'next-app-router',
          routeRoot: 'apps/docs/app',
        },
      ],
    });

    expect(signals.filter((s) => s.surface === 'api-handlers')).toEqual([
      expect.objectContaining({ count: 5, message: expect.stringContaining("routeRoot: 'pages'") }),
      expect.objectContaining({ count: 5, message: expect.stringContaining("routeRoot: 'app'") }),
    ]);
  });

  it('keeps missing Next file-convention routes visible beside generic route rules', () => {
    const repo = makeRepo({
      packages: [makePackage('apps/web', { next: '^15.0.0' })],
      files: Array.from({ length: 6 }, (_, i) => makeFile(`apps/web/pages/p${i}.tsx`, 'apps/web')),
    });

    const signals = unclaimedFrontendSurface(repo, {
      substrate: { language: 'ts' },
      routes: { componentProp: true, renderProp: true, configArray: true },
    });

    expect(signals.filter((s) => s.surface === 'routes')).toEqual([
      expect.objectContaining({ count: 6, message: expect.stringContaining('routes.fileConvention') }),
    ]);
    const redFlags = unclaimedFrontendRedFlags(signals);
    expect(redFlags).toEqual([expect.stringContaining('routes.fileConvention')]);
    expect(isOverallPass([], [], redFlags)).toBe(false);
  });

  it('keeps path-only page and API conventions advisory without a Next dependency', () => {
    const repo = makeRepo({
      packages: [makePackage('.')],
      files: [
        makeFile('app/page.tsx', '.'),
        makeFile('app/api/health/route.ts', '.'),
        makeFile('src/pages/Home.tsx', '.'),
        makeFile('src/pages/api/health.ts', '.'),
      ],
    });

    const signals = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } });

    expect(signals.map((signal) => signal.surface)).toEqual(['routes', 'api-handlers', 'api-handlers']);
    expect(signals.every((signal) => signal.blocking !== true)).toBe(true);
    expect(unclaimedFrontendRedFlags(signals)).toEqual([]);
    expect(signals[0].message).toContain("does not declare 'next'");
  });

  it('uses the owning workspace package, not a root Next dependency, as blocking evidence', () => {
    const repo = makeRepo({
      packages: [
        makePackage('.', { next: '^15.0.0' }),
        makePackage('apps/vite'),
        makePackage('apps/next', { next: '^15.0.0' }),
      ],
      files: [makeFile('apps/vite/app/page.tsx', 'apps/vite'), makeFile('apps/next/app/page.tsx', 'apps/next')],
    });

    const signals = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } });

    expect(signals.filter((signal) => signal.surface === 'routes')).toEqual([
      expect.objectContaining({
        count: 1,
        blocking: true,
        message: expect.stringContaining('Next.js file-convention'),
      }),
      expect.objectContaining({ count: 1, message: expect.stringContaining("does not declare 'next'") }),
    ]);
    expect(unclaimedFrontendRedFlags(signals)).toEqual([expect.stringContaining('Next.js file-convention')]);
  });

  it('ignores Next-looking files outside the exact source scope supplied by the scorer', () => {
    const repo = makeRepo({
      packages: [makePackage('.', { next: '^15.0.0' })],
      files: [makeFile('src/main.tsx', '.'), makeFile('pages/settings.tsx', '.')],
    });

    const signals = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } }, new Set(['src/main.tsx']));

    expect(signals).toEqual([]);
    expect(unclaimedFrontendRedFlags(signals)).toEqual([]);
  });

  it('detects canonical package and src Next roots with deterministic bounded path samples', () => {
    const repo = makeRepo({
      packages: [makePackage('apps/studio', { next: '^15.0.0' })],
      files: [
        makeFile('apps/studio/pages/zeta.tsx', 'apps/studio'),
        makeFile('apps/studio/src/pages/beta.tsx', 'apps/studio'),
        makeFile('apps/studio/app/page.tsx', 'apps/studio'),
        makeFile('apps/studio/pages/alpha.tsx', 'apps/studio'),
        makeFile('apps/studio/src/app/zeta/page.tsx', 'apps/studio'),
        makeFile('apps/studio/src/app/account/page.tsx', 'apps/studio'),
      ],
    });

    const route = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } }).find(
      (signal) => signal.surface === 'routes',
    );

    expect(route).toEqual(expect.objectContaining({ count: 6, blocking: true }));
    expect(route?.message).toContain(
      'sample path(s): "apps/studio/app/page.tsx", "apps/studio/pages/alpha.tsx", "apps/studio/pages/zeta.tsx", "apps/studio/src/app/account/page.tsx", "apps/studio/src/app/zeta/page.tsx" (+1 more)',
    );
    expect(route?.message).not.toContain('"apps/studio/src/pages/beta.tsx"');
  });

  it('ignores deep documentation content paths named pages or app inside a Next package', () => {
    const repo = makeRepo({
      packages: [makePackage('apps/studio', { next: '^15.0.0' })],
      files: [
        makeFile(
          'apps/studio/components/interfaces/Connect/ConnectTabs/Connect/content/nextjs/pages/client/content.tsx',
          'apps/studio',
        ),
        makeFile(
          'apps/studio/components/interfaces/Connect/ConnectSheet/Connect/content/nextjs/pages/client/content.tsx',
          'apps/studio',
        ),
        makeFile('apps/studio/components/docs/app/example/page.tsx', 'apps/studio'),
        makeFile('apps/studio/components/docs/app/example/route.ts', 'apps/studio'),
      ],
    });

    const signals = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } });

    expect(signals.filter((signal) => signal.surface === 'routes')).toEqual([]);
    expect(signals.filter((signal) => signal.surface === 'api-handlers')).toEqual([]);
    expect(unclaimedFrontendRedFlags(signals)).toEqual([]);
  });

  it('derives a repeated app/pages route directory relative to the owning package', () => {
    const repo = makeRepo({
      packages: [makePackage('apps/app', { next: '^15.0.0' }), makePackage('apps/pages', { next: '^15.0.0' })],
      files: [makeFile('apps/app/app/page.tsx', 'apps/app'), makeFile('apps/pages/pages/index.tsx', 'apps/pages')],
    });

    const signals = unclaimedFrontendSurface(repo, {
      substrate: { language: 'ts' },
      routes: {
        fileConvention: [
          { framework: 'next-app', routeDir: 'apps/app/app' },
          { framework: 'next-pages', routeDir: 'apps/pages/pages' },
        ],
      },
    });

    expect(signals.filter((signal) => signal.surface === 'routes')).toEqual([]);
  });

  it('detects and claims API conventions after repeated app/pages package segments', () => {
    const repo = makeRepo({
      packages: [makePackage('apps/app', { next: '^15.0.0' }), makePackage('apps/pages', { next: '^15.0.0' })],
      files: [
        makeFile('apps/app/app/api/health/route.ts', 'apps/app'),
        makeFile('apps/pages/pages/api/health.ts', 'apps/pages'),
      ],
    });

    const missing = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } });
    expect(missing.filter((signal) => signal.surface === 'api-handlers')).toEqual([
      expect.objectContaining({ count: 1, blocking: true, message: expect.stringContaining('Pages Router') }),
      expect.objectContaining({ count: 1, blocking: true, message: expect.stringContaining('App Router') }),
    ]);

    const claimed = unclaimedFrontendSurface(repo, {
      substrate: { language: 'ts' },
      entrypoints: [
        { kind: 'http', via: 'file-convention', framework: 'next-pages-api', routeRoot: 'pages' },
        { kind: 'http', via: 'file-convention', framework: 'next-app-router', routeRoot: 'app' },
      ],
    });
    expect(claimed.filter((signal) => signal.surface === 'api-handlers')).toEqual([]);
  });

  it('stays silent for every surface the profile does declare', () => {
    const signals = unclaimedFrontendSurface(frontendRepo, {
      substrate: { language: 'ts' },
      components: { include: ['src/**'] },
      stateStores: [{ library: 'zustand' }],
      routes: { fileConvention: [{ framework: 'next-pages', routeDir: 'apps/web/pages' }] },
    });

    expect(signals).toEqual([]);
  });

  it('stays silent on a backend repo with no frontend surface', () => {
    const backend = makeRepo({
      files: [makeFile('src/main.ts', '.'), makeFile('src/app.module.ts', '.')],
      imports: [
        {
          id: 'i1',
          sourceFileId: `${H}:file:src/main.ts`,
          moduleSpecifier: '@nestjs/core',
          isTypeOnly: false,
          importKind: 'named',
        },
      ],
    });

    expect(unclaimedFrontendSurface(backend, { substrate: { language: 'ts' } })).toEqual([]);
  });

  it('counts <Route>-rendering components as a route signal', () => {
    const repo = makeRepo({
      files: [makeFile('src/App.tsx', '.')],
      components: Array.from({ length: 5 }, (_, i) => ({
        id: `comp${i}`,
        versionedId: `comp${i}@v1`,
        kind: 'component',
        name: `C${i}`,
        fileId: `${H}:file:src/App.tsx`,
        framework: 'react',
        componentType: 'functional',
        childComponents: [{ componentName: 'Route', location: { filePath: 'src/App.tsx', startLine: 1, endLine: 1 } }],
        location: { filePath: 'src/App.tsx', startLine: 1, endLine: 2 },
      })) as ParsedRepo['components'],
    });

    const routes = unclaimedFrontendSurface(repo, { substrate: { language: 'ts' } }).find(
      (s) => s.surface === 'routes',
    );

    expect(routes?.count).toBe(5);
    expect(unclaimedFrontendRedFlags(routes ? [routes] : [])).toEqual([]);
  });
});

describe('extractionErrorSummary', () => {
  it('groups repeated degrade reasons with counts, worst-first', () => {
    const repo = makeRepo({
      errors: [
        { file: '.', message: 'scip-typescript failed: tsconfig include missing', severity: 'warning' },
        { file: 'a.ts', message: 'structural parse failed (Unexpected token)', severity: 'warning' },
        { file: 'b.ts', message: 'structural parse failed (Unexpected token)', severity: 'warning' },
        { file: '<integrity>', message: '3 dangling reference(s) in functions.fileId', severity: 'error' },
      ],
    });

    const rows = extractionErrorSummary(repo);

    expect(rows[0]).toEqual({ severity: 'warning', message: 'structural parse failed', count: 2 });
    expect(rows.some((r) => r.severity === 'error')).toBe(true);
  });

  it('blocks extraction errors while leaving advisory warnings non-fatal', () => {
    const repo = makeRepo({
      errors: [
        { file: '.', message: 'recovered split diagnostic', severity: 'warning' },
        { file: '.', message: 'one project has no semantic index', severity: 'error' },
      ],
    });

    const redFlags = blockingExtractionErrors(repo);

    expect(redFlags).toEqual([expect.stringContaining('one project has no semantic index')]);
    expect(redFlags[0]).not.toContain('recovered split diagnostic');
    expect(isOverallPass([], [], redFlags)).toBe(false);
  });
});
