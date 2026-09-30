// =============================================================================
// Silent-failure signals for the coverage scorecard.
//
// Two shapes that make a broken extraction look complete:
//
//  1) Per-package CALLS-resolution blackout. When the semantic (SCIP) pass dies
//     for some workspace packages but not others, tree-sitter degrades
//     gracefully: node density stays normal and only the call edges vanish. The
//     signature is bimodal — some packages resolve fine, others sit at EXACTLY
//     0% with plenty of functions (supabase S1).
//  2) Unclaimed frontend surface. The repo obviously has a component/state/route
//     surface, and the profile declares no rule for it, so the whole surface is
//     absent from the graph without a single error (posthog G2 (c)).
//
// Both are computed off the emitted ParsedRepo + the profile — no source-text
// grepping (import specifiers come from the structural imports the engine
// already emitted).
// =============================================================================
import type { ParsedRepo } from '@coredoc/core/types';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { packageLocalRouteRootIndex } from '../substrate/engine/path-helpers.js';

/** A package must have at least this many functions before a 0% rate means anything. */
const MIN_FUNCTIONS_FOR_BLACKOUT = 20;
/** Another package must resolve at least this well for the shape to be "bimodal". */
const HEALTHY_RESOLUTION_RATE = 0.5;

export interface PackageCallResolution {
  /** Workspace-package path (`.`, `apps/www`, …). */
  packagePath: string;
  functions: number;
  /** Call sites whose caller lives in this package. */
  callSites: number;
  /** Call sites of those that carry a resolved calleeId. */
  resolved: number;
  /** resolved / callSites, or null when the package has no call sites at all. */
  rate: number | null;
}

/**
 * Per-workspace-package call-resolution rates, ordered worst-first among
 * packages that have functions. Ownership comes from the packages[]/files[]
 * attribution already in the output.
 */
export function perPackageCallResolution(repo: ParsedRepo): PackageCallResolution[] {
  const pkgPathById = new Map(repo.packages.map((p) => [p.id, p.path]));
  const filePkg = new Map(repo.files.map((f) => [f.id, pkgPathById.get(f.packageId) ?? f.packageId]));
  const fnPkg = new Map<string, string>();
  const rows = new Map<string, PackageCallResolution>();
  const row = (packagePath: string): PackageCallResolution => {
    const existing = rows.get(packagePath);
    if (existing) return existing;
    const fresh: PackageCallResolution = { packagePath, functions: 0, callSites: 0, resolved: 0, rate: null };
    rows.set(packagePath, fresh);
    return fresh;
  };

  for (const fn of repo.functions) {
    const pkgPath = filePkg.get(fn.fileId);
    // A function whose file was never emitted is a referential-integrity
    // violation, reported separately — it must not be attributed to a package.
    if (pkgPath === undefined) continue;
    fnPkg.set(fn.id, pkgPath);
    row(pkgPath).functions++;
  }
  for (const c of repo.calls) {
    const pkgPath = fnPkg.get(c.callerId);
    if (pkgPath === undefined) continue;
    const r = row(pkgPath);
    r.callSites++;
    if (c.calleeId) r.resolved++;
  }
  for (const r of rows.values()) r.rate = r.callSites > 0 ? r.resolved / r.callSites : null;

  return [...rows.values()]
    .filter((r) => r.functions > 0)
    .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.functions - a.functions);
}

/** Most blackout red-flags to render; the rest are summarized as a count. */
const MAX_BLACKOUT_ROWS = 10;

/**
 * The silent-SCIP-death signature: a substantial package resolving EXACTLY 0%
 * while another package resolves healthily. Returns one red-flag line per
 * blacked-out package, capped at {@link MAX_BLACKOUT_ROWS} with a trailing count,
 * or [] when the shape is absent.
 *
 * Deliberately BIMODAL-only. A repo where nothing resolves is not evidence of failure here:
 * it is the normal shape for a Tier-B-only substrate (ruby/swift/go/rust, python without a
 * provisioned venv), which has no semantic tier to lose. Distinguishing "the semantic pass
 * died" from "there is no semantic pass" needs a signal this function does not receive —
 * `scipCoverageGaps` / `partialReason` carry it, and that is where a total-blackout rule
 * belongs. See the "stays silent when the WHOLE repo resolves poorly" case in the tests.
 */
export function callResolutionBlackouts(rows: PackageCallResolution[]): string[] {
  const healthy = rows.filter((r) => r.rate !== null && r.rate > HEALTHY_RESOLUTION_RATE);
  if (healthy.length === 0) return [];
  const best = healthy.reduce((a, b) => ((a.rate ?? 0) >= (b.rate ?? 0) ? a : b));
  const flagged = rows
    .filter((r) => r.functions >= MIN_FUNCTIONS_FOR_BLACKOUT && r.callSites > 0 && r.resolved === 0)
    .map(
      (r) =>
        `call-resolution blackout: package '${r.packagePath}' resolves 0/${r.callSites} call sites ` +
        `across ${r.functions} functions while '${best.packagePath}' resolves ${Math.round((best.rate ?? 0) * 100)}% ` +
        `— the semantic pass covered no symbol in this package (project not indexed, indexer crashed ` +
        `part-way, or the package's language has no semantic tier); its call graph is silently empty`,
    );
  if (flagged.length <= MAX_BLACKOUT_ROWS) return flagged;
  return [
    ...flagged.slice(0, MAX_BLACKOUT_ROWS),
    `call-resolution blackout: +${flagged.length - MAX_BLACKOUT_ROWS} further blacked-out package(s) not listed`,
  ];
}

/** State-management libraries whose factory import implies a store surface. */
const STATE_LIB_MODULES = new Set([
  'zustand',
  'zustand/vanilla',
  'zustand/middleware',
  'valtio',
  'valtio/vanilla',
  'kea',
  'redux',
  '@reduxjs/toolkit',
  'react-redux',
  'pinia',
  'jotai',
  'recoil',
  'mobx',
  'mobx-react',
  'mobx-react-lite',
]);

/** Component-file extensions that imply a declarable component surface. */
const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue']);

/** Minimum component-ish files before "no components rule" is worth saying. */
const MIN_COMPONENT_FILES = 20;
/** Minimum files importing a state library before "no stateStores rule" fires. */
const MIN_STATE_LIB_FILES = 10;
/**
 * Minimum page files / `<Route` usages before "no routes rule" fires. Small —
 * a route surface is worth naming as soon as it is more than an accident — but
 * not 1, so a single stray `app/page.tsx` in a backend repo stays quiet.
 */
const MIN_ROUTE_SIGNALS = 5;

/** Which frontend rule families the profile declares (read loosely — only TS profiles have them). */
export interface DeclaredFrontendRules {
  components: boolean;
  stateStores: boolean;
  routes: boolean;
}

/** Read the frontend rule families off any profile shape (absent on non-TS profiles). */
export function declaredFrontendRules(profile: unknown): DeclaredFrontendRules {
  const p = (profile ?? {}) as { components?: unknown; stateStores?: unknown; routes?: unknown };
  const declared = (v: unknown): boolean => v !== undefined && (!Array.isArray(v) || v.length > 0);
  return {
    components: declared(p.components),
    stateStores: declared(p.stateStores),
    routes: declared(p.routes),
  };
}

export interface UnclaimedFrontendSignal {
  surface: 'components' | 'stateStores' | 'routes' | 'api-handlers';
  count: number;
  message: string;
  /** Executable or deterministic file-convention surface whose complete loss blocks promotion. */
  blocking?: true;
}

const MAX_PATH_SAMPLES = 5;

function pathSampleSuffix(paths: readonly string[]): string {
  const sorted = [...new Set(paths)].sort();
  const samples = sorted.slice(0, MAX_PATH_SAMPLES).map((file) => JSON.stringify(file));
  const remaining = sorted.length - samples.length;
  return `; sample path(s): ${samples.join(', ')}${remaining > 0 ? ` (+${remaining} more)` : ''}`;
}

/** Deterministic file-convention routes and API handlers must not disappear from a promoted graph. */
export function unclaimedFrontendRedFlags(signals: UnclaimedFrontendSignal[]): string[] {
  return signals.filter((signal) => signal.blocking).map((signal) => signal.message);
}

/**
 * Frontend surfaces the repo clearly has and the profile never claimed. Missing
 * path-only conventions remain WARN rows; owning-package Next dependency evidence
 * lets {@link unclaimedFrontendRedFlags} promote missing Next routes/handlers to RED.
 */
export function unclaimedFrontendSurface(
  repo: ParsedRepo,
  profile: unknown,
  sourcePaths?: ReadonlySet<string>,
): UnclaimedFrontendSignal[] {
  const rules = declaredFrontendRules(profile);
  const signals: UnclaimedFrontendSignal[] = [];
  const nextPackageIds = packagesDeclaringNext(repo);
  const files = sourcePaths ? repo.files.filter((file) => sourcePaths.has(file.path)) : repo.files;
  const fileIds = sourcePaths ? new Set(files.map((file) => file.id)) : undefined;

  if (!rules.components) {
    const n = files.filter((f) => COMPONENT_EXTENSIONS.has(f.extension)).length;
    if (n >= MIN_COMPONENT_FILES) {
      signals.push({
        surface: 'components',
        count: n,
        message: `${n} .tsx/.jsx/.vue files in substrate scope but the profile declares no 'components' rule — that surface is invisible in the graph`,
      });
    }
  }

  if (!rules.stateStores) {
    const stateFiles = new Set<string>();
    for (const imp of repo.imports) {
      if ((!fileIds || fileIds.has(imp.sourceFileId)) && STATE_LIB_MODULES.has(imp.moduleSpecifier)) {
        stateFiles.add(imp.sourceFileId);
      }
    }
    if (stateFiles.size >= MIN_STATE_LIB_FILES) {
      signals.push({
        surface: 'stateStores',
        count: stateFiles.size,
        message: `${stateFiles.size} files import a state-management library (zustand/valtio/kea/redux/pinia/jotai/recoil/mobx) but the profile declares no 'stateStores' rule`,
      });
    }
  }

  const packagePathById = new Map(repo.packages.map((pkg) => [pkg.id, pkg.path]));
  const pageFiles = files.flatMap((file) => {
    const convention = nextPageConvention(file.path, packagePathById.get(file.packageId));
    return convention ? [{ ...convention, packageId: file.packageId, path: file.path }] : [];
  });
  const routeJsx = (repo.components ?? []).filter(
    (c) => (!fileIds || fileIds.has(c.fileId)) && (c.childComponents ?? []).some((u) => u.componentName === 'Route'),
  ).length;
  if (pageFiles.length > 0) {
    const unclaimedPages = pageFiles.filter((file) => !profileClaimsNextPage(profile, file));
    if (unclaimedPages.length > 0) {
      const confirmedNext = unclaimedPages.filter((file) => nextPackageIds.has(file.packageId));
      const pathOnly = unclaimedPages.filter((file) => !nextPackageIds.has(file.packageId));
      if (confirmedNext.length > 0) {
        const pagesRouter = confirmedNext.filter((file) => file.framework === 'next-pages').length;
        const appRouter = confirmedNext.length - pagesRouter;
        signals.push({
          surface: 'routes',
          count: confirmedNext.length,
          blocking: true,
          message:
            `${confirmedNext.length} Next.js file-convention page file(s) ` +
            `(${pagesRouter} Pages Router, ${appRouter} App Router) are outside every matching ` +
            `'routes.fileConvention' rule — each app root needs its repo-relative routeDir` +
            pathSampleSuffix(confirmedNext.map((file) => file.path)),
        });
      }
      if (pathOnly.length > 0) {
        signals.push({
          surface: 'routes',
          count: pathOnly.length,
          message:
            `${pathOnly.length} file path(s) match a Next.js page convention, but their owning package does not ` +
            `declare 'next' — verify whether this is an application route surface` +
            pathSampleSuffix(pathOnly.map((file) => file.path)),
        });
      }
    }
  }
  if (!rules.routes && routeJsx >= MIN_ROUTE_SIGNALS) {
    signals.push({
      surface: 'routes',
      count: routeJsx,
      message: `${routeJsx} component(s) render <Route> but the profile declares no 'routes' rule`,
    });
  }

  // API-handler file conventions no matching entrypoint rule consumes. Pages Router
  // and App Router are independent extraction rules; declaring either one must not
  // hide the other surface in a mixed Next.js monorepo.
  const pagesApiFiles = files.filter((file) =>
    isNextPagesApiHandlerFile(file.path, packagePathById.get(file.packageId)),
  );
  const appApiFiles = files.filter((file) =>
    isNextAppRouterHandlerFile(file.path, packagePathById.get(file.packageId)),
  );
  if (pagesApiFiles.length + appApiFiles.length > 0) {
    const unclaimedPagesApi = pagesApiFiles.filter(
      (file) => !profileClaimsPagesApiHandler(profile, file.path, packagePathById.get(file.packageId)),
    );
    const confirmedPagesApi = unclaimedPagesApi.filter((file) => nextPackageIds.has(file.packageId));
    const pathOnlyPagesApi = unclaimedPagesApi.filter((file) => !nextPackageIds.has(file.packageId));
    if (confirmedPagesApi.length > 0) {
      signals.push({
        surface: 'api-handlers',
        count: confirmedPagesApi.length,
        blocking: true,
        message:
          `${confirmedPagesApi.length} Next.js Pages Router API-handler file(s) are not covered by a matching ` +
          `next-pages-api entrypoint rule with routeRoot: 'pages' — that server surface is invisible` +
          pathSampleSuffix(confirmedPagesApi.map((file) => file.path)),
      });
    }
    if (pathOnlyPagesApi.length > 0) {
      signals.push({
        surface: 'api-handlers',
        count: pathOnlyPagesApi.length,
        message:
          `${pathOnlyPagesApi.length} file path(s) match the Next.js Pages Router API convention, but their owning ` +
          `package does not declare 'next' — verify whether these are HTTP handlers` +
          pathSampleSuffix(pathOnlyPagesApi.map((file) => file.path)),
      });
    }
    const unclaimedAppApi = appApiFiles.filter(
      (file) => !profileClaimsAppRouterHandler(profile, file.path, packagePathById.get(file.packageId)),
    );
    const confirmedAppApi = unclaimedAppApi.filter((file) => nextPackageIds.has(file.packageId));
    const pathOnlyAppApi = unclaimedAppApi.filter((file) => !nextPackageIds.has(file.packageId));
    if (confirmedAppApi.length > 0) {
      signals.push({
        surface: 'api-handlers',
        count: confirmedAppApi.length,
        blocking: true,
        message:
          `${confirmedAppApi.length} Next.js App Router API-handler file(s) are not covered by a matching ` +
          `next-app-router entrypoint rule with routeRoot: 'app' and compatible routeFiles — that server surface is invisible` +
          pathSampleSuffix(confirmedAppApi.map((file) => file.path)),
      });
    }
    if (pathOnlyAppApi.length > 0) {
      signals.push({
        surface: 'api-handlers',
        count: pathOnlyAppApi.length,
        message:
          `${pathOnlyAppApi.length} file path(s) match the Next.js App Router API convention, but their owning ` +
          `package does not declare 'next' — verify whether these are HTTP handlers` +
          pathSampleSuffix(pathOnlyAppApi.map((file) => file.path)),
      });
    }
  }

  return signals;
}

type DependencyManifest = Partial<
  Record<'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies', unknown>
>;

function dependencySectionDeclares(section: unknown, dependency: string): boolean {
  return typeof section === 'object' && section !== null && Object.hasOwn(section, dependency);
}

/** Next path conventions become promotion blockers only with owning-package dependency evidence. */
function packagesDeclaringNext(repo: ParsedRepo): Set<string> {
  const packageIds = new Set<string>();
  for (const pkg of repo.packages) {
    if (dependencySectionDeclares(pkg.dependencies, 'next') || dependencySectionDeclares(pkg.devDependencies, 'next')) {
      packageIds.add(pkg.id);
      continue;
    }

    try {
      const packageRoot = pkg.path === '.' ? repo.path : path.join(repo.path, pkg.path);
      const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as DependencyManifest;
      if (
        dependencySectionDeclares(manifest.dependencies, 'next') ||
        dependencySectionDeclares(manifest.devDependencies, 'next') ||
        dependencySectionDeclares(manifest.peerDependencies, 'next') ||
        dependencySectionDeclares(manifest.optionalDependencies, 'next')
      ) {
        packageIds.add(pkg.id);
      }
    } catch {
      // Missing or malformed manifests cannot establish framework ownership; path-only matches stay advisory.
    }
  }
  return packageIds;
}

interface FileConventionHttpDeclaration {
  kind?: unknown;
  via?: unknown;
  framework?: unknown;
  routeRoot?: unknown;
  routeFiles?: unknown;
}

function fileConventionHttpDeclarations(profile: unknown): FileConventionHttpDeclaration[] {
  const eps = (profile as { entrypoints?: unknown })?.entrypoints;
  if (!Array.isArray(eps)) return [];
  return eps.filter(
    (rule): rule is FileConventionHttpDeclaration =>
      typeof rule === 'object' &&
      rule !== null &&
      (rule as FileConventionHttpDeclaration).kind === 'http' &&
      (rule as FileConventionHttpDeclaration).via === 'file-convention',
  );
}

function profileClaimsPagesApiHandler(profile: unknown, relPath: string, packagePath?: string): boolean {
  const parts = relPath.split('/');
  return fileConventionHttpDeclarations(profile).some((rule) => {
    if (rule.framework !== 'next-pages-api' || typeof rule.routeRoot !== 'string') return false;
    const rootIdx = packageLocalRouteRootIndex(relPath, rule.routeRoot, packagePath);
    return rootIdx >= 0 && isPagesApiPath(parts.slice(rootIdx + 1));
  });
}

function profileClaimsAppRouterHandler(profile: unknown, relPath: string, packagePath?: string): boolean {
  const parts = relPath.split('/');
  const appIdx = canonicalNextRouteRootIndex(relPath, 'app', packagePath);
  const base = parts[parts.length - 1];
  return fileConventionHttpDeclarations(profile).some((rule) => {
    if (rule.framework !== 'next-app-router' || typeof rule.routeRoot !== 'string') return false;
    const rootIdx = packageLocalRouteRootIndex(relPath, rule.routeRoot, packagePath);
    if (rootIdx !== appIdx || rootIdx === parts.length - 1) return false;
    const routeFiles = Array.isArray(rule.routeFiles) ? rule.routeFiles : ['route.ts', 'route.tsx'];
    return routeFiles.includes(base);
  });
}

/** Pages Router API handler under the canonical `pages/api/**` tree. */
function isNextPagesApiHandlerFile(relPath: string, packagePath?: string): boolean {
  const parts = relPath.split('/');
  const rootIdx = canonicalNextRouteRootIndex(relPath, 'pages', packagePath);
  return rootIdx >= 0 && isPagesApiPath(parts.slice(rootIdx + 1));
}

function isPagesApiPath(parts: string[]): boolean {
  if (parts[0] !== 'api' || parts.some((part) => part.startsWith('_'))) return false;
  const base = parts[parts.length - 1];
  return /\.(tsx|jsx|ts|js)$/.test(base) && !base.endsWith('.d.ts');
}

/** App Router API handler named `route.*` anywhere below a canonical `app` root. */
function isNextAppRouterHandlerFile(relPath: string, packagePath?: string): boolean {
  const parts = relPath.split('/');
  const appIdx = canonicalNextRouteRootIndex(relPath, 'app', packagePath);
  if (appIdx === -1 || appIdx === parts.length - 1) return false;
  return /^route\.(tsx|jsx|ts|js)$/.test(parts[parts.length - 1]);
}

interface NextPageConvention {
  framework: 'next-pages' | 'next-app';
  routeDir: string;
}

/** Automatic scoring recognizes only framework roots at the package root or under its `src/` directory. */
function canonicalNextRouteRootIndex(filePath: string, routeRoot: 'pages' | 'app', packagePath = '.'): number {
  const parts = filePath.split('/');
  const packageParts = packagePath === '.' ? [] : packagePath.split('/');
  if (!packageParts.every((part, index) => parts[index] === part)) return -1;
  const localParts = parts.slice(packageParts.length);
  if (localParts[0] === routeRoot) return packageParts.length;
  return localParts[0] === 'src' && localParts[1] === routeRoot ? packageParts.length + 1 : -1;
}

/** The exact file-convention rule a Next.js page file needs to be extracted. */
function nextPageConvention(relPath: string, packagePath?: string): NextPageConvention | undefined {
  const parts = relPath.split('/');
  const pagesIdx = canonicalNextRouteRootIndex(relPath, 'pages', packagePath);
  if (pagesIdx >= 0 && isPagesPagePath(parts.slice(pagesIdx + 1))) {
    return { framework: 'next-pages', routeDir: parts.slice(0, pagesIdx + 1).join('/') };
  }
  const appIdx = canonicalNextRouteRootIndex(relPath, 'app', packagePath);
  if (appIdx >= 0 && /^page\.(tsx|jsx|ts|js)$/.test(parts[parts.length - 1])) {
    return { framework: 'next-app', routeDir: parts.slice(0, appIdx + 1).join('/') };
  }
  return undefined;
}

function isPagesPagePath(parts: string[]): boolean {
  if (parts.length === 0 || parts[0] === 'api' || parts.some((part) => part.startsWith('_'))) return false;
  const base = parts[parts.length - 1];
  return /\.(tsx|jsx|ts|js)$/.test(base) && !base.endsWith('.d.ts');
}

function profileClaimsNextPage(
  profile: unknown,
  page: { framework: NextPageConvention['framework']; routeDir: string },
): boolean {
  const routes = (profile as { routes?: { fileConvention?: unknown } })?.routes;
  const rules = routes?.fileConvention;
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => {
    if (typeof rule !== 'object' || rule === null) return false;
    const candidate = rule as { framework?: unknown; routeDir?: unknown };
    return (
      candidate.framework === page.framework &&
      typeof candidate.routeDir === 'string' &&
      candidate.routeDir.replace(/\/+$/, '') === page.routeDir
    );
  });
}

/**
 * Per-target extraction errors grouped for the scorecard — the degrade reasons
 * buildBaseline collects (SCIP skipped/failed, structural parse failures) get
 * surfaced instead of buried in the JSON.
 */
export function extractionErrorSummary(repo: ParsedRepo): Array<{ severity: string; message: string; count: number }> {
  const groups = new Map<string, { severity: string; message: string; count: number }>();
  for (const e of repo.errors ?? []) {
    // Group by severity + the message head so N identical per-file failures
    // collapse into one row with a count.
    const head = e.message.split('(')[0].trim().slice(0, 120);
    const key = `${e.severity}|${head}`;
    const g = groups.get(key) ?? { severity: e.severity, message: head, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Extraction errors represent known graph loss; warnings remain diagnostic and non-blocking. */
export function blockingExtractionErrors(repo: ParsedRepo): string[] {
  return extractionErrorSummary(repo)
    .filter((error) => error.severity === 'error')
    .map((error) => `extraction error (${error.count} occurrence${error.count === 1 ? '' : 's'}): ${error.message}`);
}
