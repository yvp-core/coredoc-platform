import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { enumerateRepoFiles } from './discovery/discover.js';

/**
 * A workspace package: its repo-relative (forward-slash) root path and display name. The repo root
 * is always present as `{ path: '.' }` — the fallback owner for files that sit outside any nested
 * workspace package (root configs, scripts, a non-monorepo's whole tree).
 */
export interface WorkspacePackage {
  /** Repo-relative, forward-slash path to the package root; '.' for the repo root. */
  path: string;
  /** package.json `name`, falling back to the path. */
  name: string;
}

/** Workspace globs split into include / exclude (a leading '!' marks a pnpm-style exclusion). */
interface WorkspaceGlobs {
  includes: string[];
  excludes: string[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** pnpm-workspace.yaml `packages:` list, or null when the file is absent/unparseable/malformed. */
function readPnpmGlobs(repoRoot: string): string[] | null {
  const p = join(repoRoot, 'pnpm-workspace.yaml');
  if (!existsSync(p)) return null;
  try {
    const doc = parseYaml(readFileSync(p, 'utf8')) as { packages?: unknown } | null;
    const pkgs = doc?.packages;
    return Array.isArray(pkgs) ? pkgs.filter((g): g is string => typeof g === 'string') : null;
  } catch {
    return null;
  }
}

/** package.json `workspaces`: an array of globs, or `{ packages: [...] }` (Yarn/Lerna shape). */
function pkgJsonWorkspaceGlobs(pkg: unknown): string[] | null {
  if (!pkg || typeof pkg !== 'object') return null;
  const ws = (pkg as { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) return ws.filter((g): g is string => typeof g === 'string');
  const nested = ws && typeof ws === 'object' ? (ws as { packages?: unknown }).packages : undefined;
  if (Array.isArray(nested)) return nested.filter((g): g is string => typeof g === 'string');
  return null;
}

/** Strip a leading `./` and any trailing slash, so a glob like `./packages/*` normalizes cleanly. */
function normalizeGlob(g: string): string {
  return g.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Read workspace globs from the repo's config, preferring pnpm-workspace.yaml (its `packages:` list)
 * then a root package.json `workspaces` field. Returns null when neither declares a workspace — the
 * caller then falls back to a package.json directory scan.
 */
function readWorkspaceGlobs(repoRoot: string): WorkspaceGlobs | null {
  const globs = readPnpmGlobs(repoRoot) ?? pkgJsonWorkspaceGlobs(readJson(join(repoRoot, 'package.json')));
  if (!globs || globs.length === 0) return null;
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const g of globs) {
    if (g.startsWith('!')) excludes.push(normalizeGlob(g.slice(1)));
    else includes.push(normalizeGlob(g));
  }
  return includes.length ? { includes, excludes } : null;
}

/** Convert a workspace glob (`*` = one path segment, `**` = any depth) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // `**` spans any depth (.*), a lone `*` spans a single path segment ([^/]*). Match both in one
  // pass so the single-`*` rule never clobbers a `**`.
  const body = escaped.replace(/\*\*|\*/g, (m) => (m === '**' ? '.*' : '[^/]*'));
  return new RegExp(`^${body}$`);
}

function matchesAny(dir: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(dir));
}

/** Repo-relative dir of a package.json path: 'package.json' → '.', 'apps/x/package.json' → 'apps/x'. */
function packageDir(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? '.' : relPath.slice(0, i);
}

/** package.json `name` for a package dir, falling back to the dir path when absent/unnamed. */
function packageName(repoRoot: string, dir: string): string {
  const pkg = readJson(join(repoRoot, dir, 'package.json'));
  const name = pkg && typeof pkg === 'object' ? (pkg as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? name : dir;
}

/**
 * Enumerate the repo's workspace packages. The repo root ('.') is always included as the fallback
 * owner. Detection prefers declared workspaces (pnpm-workspace.yaml `packages:`, then a root
 * package.json `workspaces` field), resolving their globs against the package.json directories that
 * actually exist in the repo. With no workspace config it falls back to "every directory holding a
 * package.json"; a lone root package.json collapses to the single-package-at-'.' behavior.
 */
export function detectWorkspacePackages(repoRoot: string, repoName: string): WorkspacePackage[] {
  const root: WorkspacePackage = { path: '.', name: repoName };
  // Directories that actually contain a package.json (node_modules/build dirs already pruned by enumerate).
  const pkgDirs = new Set(
    enumerateRepoFiles(repoRoot)
      .filter((p) => p === 'package.json' || p.endsWith('/package.json'))
      .map(packageDir),
  );
  pkgDirs.delete('.'); // the root is handled separately as the fallback owner

  const globs = readWorkspaceGlobs(repoRoot);
  const memberDirs = globs
    ? [...pkgDirs].filter((d) => matchesAny(d, globs.includes) && !matchesAny(d, globs.excludes))
    : [...pkgDirs]; // no config → any directory with a package.json is a member

  memberDirs.sort();
  return [root, ...memberDirs.map((dir) => ({ path: dir, name: packageName(repoRoot, dir) }))];
}

/**
 * package.json `name` of every workspace package, the ROOT manifest included — the identity a
 * SCIP moniker and a bare module specifier both use. Distinct from `WorkspacePackage.name`, whose
 * root entry carries the caller-supplied repo NAME (a parse label, not an npm name) and whose
 * nested entries fall back to the directory path when a manifest is unnamed. Only real declared
 * names are returned; a package with no `name` field contributes nothing, because a directory path
 * can never be the package half of a moniker or specifier.
 */
export function workspacePackageJsonNames(repoRoot: string, packages: WorkspacePackage[]): string[] {
  const names = new Set<string>();
  for (const dir of ['.', ...packages.map((p) => p.path)]) {
    const pkg = readJson(join(repoRoot, dir, 'package.json'));
    const name = pkg && typeof pkg === 'object' ? (pkg as { name?: unknown }).name : undefined;
    if (typeof name === 'string' && name.length > 0) names.add(name);
  }
  return [...names];
}

/**
 * Longest-prefix owner: the package whose path is the longest prefix of `rel`. Files outside every
 * nested package fall back to the repo root ('.'). Assumes `packages` includes the root entry.
 */
export function ownerPackagePath(rel: string, packages: WorkspacePackage[]): string {
  let bestPath = '.';
  let bestLen = 0; // the root ('.') matches everything at prefix-length 0
  for (const p of packages) {
    if (p.path === '.') continue;
    if ((rel === p.path || rel.startsWith(`${p.path}/`)) && p.path.length > bestLen) {
      bestPath = p.path;
      bestLen = p.path.length;
    }
  }
  return bestPath;
}
