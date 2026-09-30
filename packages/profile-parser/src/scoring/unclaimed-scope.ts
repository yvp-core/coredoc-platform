// =============================================================================
// Unclaimed-scope report (multi-target repos): source files with a registered-
// language extension that no target's parse claimed. An unclaimed file is
// invisible to extraction — that must show in the scorecard, never silently.
// =============================================================================
import { statSync } from 'node:fs';
import * as path from 'node:path';
// Import from the providers barrel (not registry.js): the barrel's registerLanguage()
// side effects populate the registry, so allLanguages() is non-empty even when this
// module is loaded in isolation (e.g. the unit test) rather than via score.ts.
import { allLanguages } from '../providers/index.js';
import { enumerateRepoFiles } from '../facts/discovery/discover.js';

export interface UnclaimedReport {
  total: number;
  intentionallyExcluded: number;
  unclaimed: number;
  topDirs: Array<{ dir: string; count: number }>;
  /** Exact examples keep the authoring loop from guessing which files a broad root count represents. */
  sampleFiles: string[];
}

export interface TargetFileScope {
  /** Same-language files removed by the provider's built-in policy. */
  excludedPaths: ReadonlySet<string>;
  /** Same-language files removed specifically by profile-authored exclude globs. */
  profileExcludedPaths: ReadonlySet<string>;
  /** Exact profile-authored paths may intentionally account for a minor non-target language file. */
  explicitExclude: readonly string[];
}

export function unclaimedScopeRedFlags(report: UnclaimedReport): string[] {
  if (report.unclaimed === 0) return [];
  const roots = report.topDirs.map((entry) => `${entry.dir} (${entry.count})`).join(', ');
  return [
    `${report.unclaimed}/${report.total} known-language file(s) are claimed by no target and are invisible to extraction` +
      (roots ? `; top roots: ${roots}` : ''),
  ];
}

/** Repo-relative files whose extension belongs to any registered language. */
function knownLanguageFiles(repoRoot: string): string[] {
  const exts = new Set(allLanguages().flatMap((p) => [...p.discovery.extensions]));
  return enumerateRepoFiles(repoRoot).filter((rel) => {
    if (!exts.has(path.extname(rel))) return false;
    try {
      return statSync(path.join(repoRoot, rel)).isFile();
    } catch {
      // `git ls-files` includes unstaged-deleted and sparse paths; extraction cannot claim them.
      return false;
    }
  });
}

const NON_PRODUCTION_SEGMENTS = new Set([
  '__fixtures__',
  '__mocks__',
  '__tests__',
  'benches',
  'build',
  'coverage',
  'dist',
  'e2e',
  'examples',
  'fixtures',
  'generated',
  'migrations',
  'spec',
  'specs',
  'target',
  'test',
  'testdata',
  'tests',
  'vendor',
]);

/** Conservative source shapes a profile may omit without hiding an application subtree. */
function isConventionalNonProductionSource(file: string): boolean {
  const segments = file.split('/');
  const base = segments.at(-1) ?? file;
  const publicIndex = segments.indexOf('public');
  const isBundledMonacoAsset = publicIndex >= 0 && segments.slice(publicIndex + 1).includes('monaco-editor');
  return (
    segments.some((segment) => NON_PRODUCTION_SEGMENTS.has(segment)) ||
    isBundledMonacoAsset ||
    /(?:^|[._-])(?:generated|spec|test)(?:[._-]|$)/i.test(base) ||
    /\.d\.[cm]?ts$/.test(base) ||
    /\.pb\.go$/.test(base) ||
    /_pb2\.pyi?$/.test(base) ||
    base === 'build.rs'
  );
}

function intentionallyExcluded(
  file: string,
  scopes: readonly TargetFileScope[],
  knownFilesByExtension: ReadonlyMap<string, number>,
): boolean {
  // Built-in provider policy is trusted because it ships with the parser. Profile-authored
  // globs are deliberately narrower: ordinary application source cannot disappear merely
  // because an authoring agent wrote `exclude: ['**/*']` to make the score green.
  if (scopes.some((scope) => scope.excludedPaths.has(file))) return true;

  const exactProfilePath = scopes.some((scope) => scope.explicitExclude.includes(file));
  if (scopes.some((scope) => scope.profileExcludedPaths.has(file))) {
    return exactProfilePath || isConventionalNonProductionSource(file);
  }

  // A target may account for one inventoried, non-target-language helper by exact path.
  // More than one file of that extension is a language population and needs its own target.
  return exactProfilePath && knownFilesByExtension.get(path.extname(file)) === 1;
}

/** Diff known-language files against claimed paths and each target's explicit scope. */
export function unclaimedScope(
  repoRoot: string,
  claimedPaths: Set<string>,
  targetScopes: readonly TargetFileScope[],
): UnclaimedReport {
  const all = knownLanguageFiles(repoRoot);
  const knownFilesByExtension = new Map<string, number>();
  for (const file of all) {
    const extension = path.extname(file);
    knownFilesByExtension.set(extension, (knownFilesByExtension.get(extension) ?? 0) + 1);
  }
  const unclaimed: string[] = [];
  let excluded = 0;
  for (const file of all) {
    if (claimedPaths.has(file)) continue;
    if (intentionallyExcluded(file, targetScopes, knownFilesByExtension)) excluded++;
    else unclaimed.push(file);
  }
  const byDir = new Map<string, number>();
  for (const f of unclaimed) {
    const dir = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.';
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
  }
  const topDirs = [...byDir.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dir, count]) => ({ dir, count }));
  return {
    total: all.length,
    intentionallyExcluded: excluded,
    unclaimed: unclaimed.length,
    topDirs,
    sampleFiles: unclaimed.slice(0, 20),
  };
}
