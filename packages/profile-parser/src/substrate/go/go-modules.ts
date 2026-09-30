/**
 * Go module enumeration — the package layer `facts/workspace.ts` cannot see.
 *
 * `facts/workspace.ts` reads `package.json` / `pnpm-workspace.yaml` only, so a Go repo looks like
 * one anonymous blob to it. A `go.mod` declares ONE module path for a whole directory tree, a repo
 * may hold several of them (multi-module repos are routine in Go), and an optional `go.work` ties
 * them together — that is the Go analogue of workspace packages, so the Go substrate emits it
 * itself: one `Package` per module, and every `FileNode` assigned to its owning module by
 * longest-prefix path match (mirroring `ownerPackagePath` in facts/workspace.ts).
 *
 * Two things differ from Cargo and are easy to get wrong:
 *
 *   1. The compilation unit BELOW the module is the DIRECTORY, not the manifest. A module declares
 *      one import prefix and every directory under it is a package whose import path is
 *      `<modulePath>/<dir-relative-to-module>`. So a module has to record its module PATH, not just
 *      a name — that string is what maps an import back to a repo directory (`go-imports.ts`).
 *   2. Modules are found by WALKING for `go.mod` files, never by expanding a `go.work`'s `use`
 *      list. A `use` list can omit a module that is still built (and a repo may have no `go.work`
 *      at all), while the file walk cannot miss one. `go.work` is read only for the fact that a
 *      workspace exists — the same reason a virtual Cargo workspace manifest is recorded.
 *
 * The reader is deliberately line-oriented (no dependency; same approach as `parseCargoManifest`
 * over `Cargo.toml`). `go.mod` and `go.work` share one directive grammar, so one reader serves
 * both. It reads exactly what this substrate needs — the module path, the language version, and
 * the set of REQUIRED module paths (which gates the framework lanes) — and ignores everything else.
 */
import { readFileSync } from 'node:fs';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';

/** One Go module (or the `go.work` file that groups several). */
export interface GoModule {
  /** The `module` directive's path (`github.com/acme/api`) — the import prefix for this tree. */
  modulePath: string;
  /** Repo-relative directory holding the manifest; the repo root is '.'. */
  path: string;
  /** Repo-relative path of the `go.mod` / `go.work`, when one exists. */
  manifestFile?: string;
  /** The `go` directive's language version (`1.22`). */
  goVersion?: string;
  /** Required module paths across every `require` directive (single-line and block form). */
  dependencies: Set<string>;
  /**
   * This manifest is a `go.work` (it declares `use` directives) rather than a `go.mod`.
   *
   * A workspace file has no `module` directive, so its `modulePath` is a directory-derived
   * FALLBACK and must never be used as an import prefix — `buildPackageIndex` skips these.
   */
  isWorkspace: boolean;
}

/** Directives that open a parenthesized block. Only `require` contributes dependencies. */
const BLOCK_DIRECTIVE = /^(require|replace|exclude|retract|use|tool|godebug|ignore)\s*\($/;

/** Strip a `//` comment tail. go.mod has no string literals, so no quote tracking is needed. */
function stripComment(line: string): string {
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
}

/** The first whitespace-separated token of a line, unquoted. */
function firstToken(line: string): string | undefined {
  const token = line.split(/\s+/)[0];
  if (!token) return undefined;
  return token.replace(/^"(.*)"$/, '$1') || undefined;
}

/**
 * Parse the pieces of a `go.mod` (or `go.work`) this substrate needs.
 *
 * `// indirect` markers are stripped with every other comment BEFORE the dependency name is read,
 * so an indirect requirement is recorded like any other: it is still a module this build depends
 * on, and the framework gates ask "is this dependency present", not "is it direct".
 */
export function parseGoMod(source: string, fallbackName: string): Omit<GoModule, 'path' | 'manifestFile'> {
  let modulePath: string | undefined;
  let goVersion: string | undefined;
  let isWorkspace = false;
  const dependencies = new Set<string>();
  let block: string | null = null;

  for (const rawLine of source.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (block) {
      if (line.startsWith(')')) {
        block = null;
        continue;
      }
      // Inside `replace (…)` / `exclude (…)` / `use (…)` the lines name modules that are NOT
      // requirements, so only a `require` block contributes.
      if (block === 'require') {
        const dep = firstToken(line);
        if (dep) dependencies.add(dep);
      }
      continue;
    }

    const opener = BLOCK_DIRECTIVE.exec(line);
    if (opener) {
      block = opener[1];
      if (block === 'use') isWorkspace = true;
      continue;
    }

    const directive = /^([a-z]+)\s+(.*)$/.exec(line);
    if (!directive) continue;
    const rest = directive[2].trim();
    switch (directive[1]) {
      case 'module':
        modulePath = firstToken(rest) ?? modulePath;
        break;
      case 'go':
        goVersion = firstToken(rest) ?? goVersion;
        break;
      case 'require': {
        const dep = firstToken(rest);
        if (dep) dependencies.add(dep);
        break;
      }
      case 'use':
        isWorkspace = true;
        break;
      default:
        break; // replace / exclude / retract / toolchain / tool — not needed here
    }
  }

  return { modulePath: modulePath ?? fallbackName, goVersion, dependencies, isWorkspace };
}

/** The repo-relative directory of a manifest path; the repo root is '.'. */
function manifestDir(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '.' : rel.slice(0, i);
}

/**
 * Every Go module in the repo, ordered by path. Manifests under a vendored (`vendor/`) or fixture
 * (`testdata/`) tree are skipped: a vendored `go.mod` describes somebody else's module, and a
 * `testdata/` module is a compiler fixture the Go toolchain itself ignores.
 */
export function discoverGoModules(root: string): GoModule[] {
  const modules: GoModule[] = [];
  for (const rel of enumerateRepoFiles(root)) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base !== 'go.mod' && base !== 'go.work') continue;
    const segments = rel.split('/');
    if (segments.some((s) => s === 'vendor' || s === 'testdata')) continue;
    const path = manifestDir(rel);
    let source: string;
    try {
      source = readFileSync(`${root}/${rel}`, 'utf-8');
    } catch {
      continue; // unreadable manifest — the module simply isn't described
    }
    const fallbackName = path === '.' ? 'root' : (path.split('/').pop() as string);
    modules.push({ ...parseGoMod(source, fallbackName), path, manifestFile: rel });
  }
  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The module directory that owns a repo-relative file (or directory) — the longest matching path
 * prefix, mirroring `ownerPackagePath`. Returns undefined when no module contains it (the caller
 * decides the fallback), so a file is never silently attributed to an unrelated module.
 */
export function moduleOwnerPath(rel: string, modules: GoModule[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const m of modules) {
    if (m.path === '.') {
      if (bestLen < 0) {
        best = '.';
        bestLen = 0;
      }
      continue;
    }
    if ((rel === m.path || rel.startsWith(`${m.path}/`)) && m.path.length > bestLen) {
      best = m.path;
      bestLen = m.path.length;
    }
  }
  return best;
}

/**
 * Whether ANY module in the repo requires one of `modulePaths`. Gates the framework lanes that
 * would otherwise fabricate: `r.Get("/x", h)` is a plausible call shape in code that has never seen
 * a router, and a fabricated route is the claim a reader scrutinizes hardest — so a framework lane
 * only runs when the framework is actually required.
 *
 * Matching is on the module-path PREFIX because Go encodes the major version IN the path from v2
 * on: a repo that requires `github.com/go-chi/chi/v5` must match a gate written for
 * `github.com/go-chi/chi`. The reverse (a gate more specific than the requirement) deliberately
 * does NOT match — that would be a guess about a version the repo never asked for.
 */
export function dependsOnAny(modules: GoModule[], modulePaths: readonly string[]): boolean {
  return modules.some((m) =>
    modulePaths.some((q) => {
      for (const dep of m.dependencies) {
        if (dep === q || dep.startsWith(`${q}/`)) return true;
      }
      return false;
    }),
  );
}
