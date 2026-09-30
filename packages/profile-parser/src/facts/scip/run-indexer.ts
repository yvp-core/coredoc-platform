import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { SCIP_INDEXERS } from '../config.js';

const execFileAsync = promisify(execFile);

export interface IndexerResult {
  ok: boolean;
  scipPath?: string;
  /**
   * Per-project index paths when the workspace was indexed project by project
   * (see `runScipTypescript`). The caller decodes and merges them into one index;
   * `scipPath` stays unset in that mode because no single file holds the result.
   */
  scipPaths?: string[];
  /** Per-project outcomes of a per-project workspace run — ok/failed with a reason. */
  projectOutcomes?: ProjectIndexOutcome[];
  degradeReason?: string;
  /**
   * Set when an index WAS produced but the run also failed (non-zero exit,
   * crash part-way through a multi-project workspace). The index is usable but
   * may cover only the projects indexed before the failure — the exact
   * fail-quiet shape that used to be discarded here, leaving whole workspace
   * packages with an empty call graph and no error anywhere in the output.
   */
  partialReason?: string;
}

/** Outcome of indexing ONE enumerated project (workspace member or solo tsconfig root) in per-project mode. */
export interface ProjectIndexOutcome {
  /** Project dir, relative to the repo root (`.` for the root project). */
  project: string;
  /** The run produced a usable index for this project. */
  ok: boolean;
  /** The run succeeded but the project contributed no TS/JS files — expected, not a failure. */
  empty?: boolean;
  /** Why this project has no index (crash/OOM/timeout/missing indexer). Set when `ok` is false. */
  reason?: string;
  /** Index written for this project; set only when `ok`. */
  scipPath?: string;
  /**
   * This project OOMed as one program and was re-indexed as its nested tsconfig projects
   * instead (see `splitOomProject`). Its own coverage now comes from those sub-projects,
   * minus `residueFiles` that sit under no tsconfig at all.
   */
  split?: { subProjects: number; residueFiles: number };
  /** True when this outcome is a sub-project produced by splitting `parent`. */
  parent?: string;
}

/** Options for the SCIP runners. `outDir` is where `index.scip` (+ Ruby hash sidecar) is written. */
export interface ScipRunOpts {
  /**
   * Directory for the generated `index.scip` and cache sidecars — the repo's
   * `coredoc-output/<project>/` cache dir when the caller has one. NEVER the source
   * tree: writing build artifacts into the analyzed repo pollutes it and races other
   * parses. Falls back to a stable per-repo dir under the OS temp dir when omitted.
   */
  outDir?: string;
}

/** Stable per-repo scratch dir under the OS temp dir, used when the caller passes no outDir. */
function defaultScipDir(repoRoot: string): string {
  return join(tmpdir(), 'coredoc-scip', createHash('sha1').update(repoRoot).digest('hex').slice(0, 16));
}

/** Resolve + create the SCIP output dir for this run. */
function resolveScipDir(repoRoot: string, outDir?: string): string {
  const dir = outDir ?? defaultScipDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildIndexerArgs(
  _language: 'typescript' | 'javascript',
  opts: { pnpmWorkspaces?: boolean; projects?: string[] },
): string[] {
  const cfg = SCIP_INDEXERS.typescript; // scip-typescript handles both TS and JS
  // Workspace mode: index EVERY enumerated project (each with its own tsconfig) into one index,
  // so a call across a package boundary resolves to the callee package's in-repo definition.
  if (opts.pnpmWorkspaces) {
    // Preferred: pass the projects positionally (`scip-typescript index [projects...]`) — the pnpm
    // members `--pnpm-workspaces` would compute (minus the `pnpm ls` subprocess it needs to compute
    // them) PLUS the tsconfig-rooted projects outside the workspace globs (see
    // `enumerateIndexProjects`), which `--pnpm-workspaces` would never reach.
    if (opts.projects?.length) return [...cfg.baseArgs, ...opts.projects];
    // Intentional fallback: self-enumeration found nothing (e.g. an unreadable/exotic
    // pnpm-workspace.yaml), so let scip-typescript's own pnpm-based enumeration try — it works
    // wherever a real `pnpm` is on PATH.
    return [...cfg.baseArgs, '--pnpm-workspaces'];
  }
  // No-config projects are given an explicit synthetic config under the SCIP output directory.
  // `--infer-tsconfig` writes into the analyzed repo, so it is never a valid fallback here.
  return [...cfg.baseArgs];
}

/** True for any path with a `node_modules` segment — installed deps are never workspace members. */
function inNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes('node_modules');
}

/** Directories whose `package.json` matches `<pattern>/package.json`, relative to repoRoot. */
function globProjectDirs(repoRoot: string, pattern: string): string[] {
  const manifests = globSync(`${pattern.replace(/\/+$/, '')}/package.json`, {
    cwd: repoRoot,
    exclude: inNodeModules,
  });
  return manifests.map((manifest) => resolve(repoRoot, dirname(manifest)));
}

/**
 * Enumerate the pnpm workspace members of `repoRoot` ourselves — the same absolute project dirs
 * `pnpm ls -r --depth -1 --long --parseable` would report, including the root project.
 *
 * Why not just let scip-typescript's `--pnpm-workspaces` do it: that flag shells out to `pnpm ls`,
 * and inside the desktop parse sandbox (empty HOME, network denied) `pnpm` is typically a corepack
 * shim that can neither find a cached pnpm nor download one — it crashes, no index.scip is written,
 * and the whole SCIP tier degrades silently. Reading `pnpm-workspace.yaml` needs no subprocess.
 *
 * Never throws: any unreadable/unparseable/`packages`-less workspace file yields `[]`, which the
 * caller treats as "fall back to --pnpm-workspaces".
 */
export function enumeratePnpmWorkspaceProjects(repoRoot: string): string[] {
  let patterns: unknown;
  try {
    patterns = (parseYaml(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf-8')) as { packages?: unknown })
      ?.packages;
  } catch {
    return []; // missing or malformed workspace file
  }
  if (!Array.isArray(patterns)) return [];

  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const entry of patterns) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const negated = entry.startsWith('!');
    const sink = negated ? excluded : included;
    try {
      for (const dir of globProjectDirs(repoRoot, negated ? entry.slice(1) : entry)) sink.add(dir);
    } catch {
      /* a single bad pattern must not lose the other members */
    }
  }
  // The root project is part of `pnpm ls -r` output. It is retained as an ownership slot, but the
  // per-project runner never launches its umbrella tsconfig; it indexes only root-owned residue.
  if (existsSync(join(repoRoot, 'package.json'))) included.add(resolve(repoRoot));

  return [...included].filter((dir) => !excluded.has(dir)).sort();
}

/**
 * A pnpm monorepo indexes as a WORKSPACE, not a single tsconfig project. Detected by a
 * `pnpm-workspace.yaml` at the repo root. This matters because a monorepo's root tsconfig is
 * typically a "solution" file (`include` matches nothing, `references` list only some members —
 * often omitting `apps/*`): a single-project index would silently skip most members, so
 * cross-package call sites emit no occurrences and vanish from the graph.
 */
export function isPnpmWorkspaceRoot(repoRoot: string): boolean {
  return existsSync(join(repoRoot, 'pnpm-workspace.yaml'));
}

/** Directories a project scan never descends into: installed deps, build output, dotdirs. */
const SPLIT_SCAN_PRUNED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

/** Source extensions scip-typescript indexes, including Node's explicit CJS/ESM variants. */
const TSJS_SOURCE_RE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;

/** One bounded scip-typescript invocation planned for an enumerated project root. */
export interface TypescriptProjectPlan {
  projectDir: string;
  /** Present when this project needs an output-dir synthetic config with these exact source files. */
  sourceFiles?: string[];
  /** Repo-owned config whose compiler semantics a bounded root-residue project should inherit. */
  extendsConfig?: string;
}

/** Is `target` the root itself or a descendant, without prefix-confusing sibling paths? */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Exact TS/JS files owned by `projectDir`: recurse within it, but never enter another enumerated
 * project root. This is the finite source list used by synthetic configs; it cannot accidentally
 * turn the workspace root into a whole-monorepo TypeScript program.
 */
function ownedTypescriptSourceFiles(projectDir: string, allProjects: string[]): string[] {
  const project = resolve(projectDir);
  const nestedProjects = new Set(
    allProjects
      .map((candidate) => resolve(candidate))
      .filter((candidate) => candidate !== project && isInside(project, candidate)),
  );
  const files: string[] = [];

  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SPLIT_SCAN_PRUNED.has(entry.name) || entry.name.startsWith('.') || nestedProjects.has(full)) continue;
        walk(full);
      } else if (entry.isFile() && TSJS_SOURCE_RE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(project);
  return files.sort();
}

/**
 * Plan workspace projects before any child starts.
 *
 * - A non-root project with `tsconfig.json` keeps the repo's own program semantics.
 * - A real no-tsconfig member gets an explicit-file synthetic config, so `.mjs`/`.cjs` tooling
 *   packages are indexed instead of being silently empty.
 * - The workspace root is always synthetic and contains only residue outside every other
 *   enumerated root. Its umbrella config is never allowed to pull the whole monorepo into one V8
 *   heap.
 *
 * Missing/out-of-repo project paths are left unplanned for `indexOneProject` to reject or report;
 * production enumeration only supplies existing in-repo directories, while this keeps the
 * containment check authoritative and avoids scanning outside the repo.
 */
export function planTypescriptProjects(repoRoot: string, projects: string[]): TypescriptProjectPlan[] {
  const root = resolve(repoRoot);
  const rootConfig = join(root, 'tsconfig.json');
  const resolvedProjects = projects.map((project) => resolve(project));
  return resolvedProjects.map((projectDir) => {
    const contained = isInside(root, projectDir);
    const needsSynthetic =
      contained && existsSync(projectDir) && (projectDir === root || !existsSync(join(projectDir, 'tsconfig.json')));
    if (!needsSynthetic) return { projectDir };
    return {
      projectDir,
      sourceFiles: ownedTypescriptSourceFiles(projectDir, resolvedProjects),
      ...(projectDir === root && existsSync(rootConfig) ? { extendsConfig: rootConfig } : {}),
    };
  });
}

/**
 * Tsconfig-rooted projects that the workspace globs do NOT reach — "solo projects".
 *
 * Why this exists: `enumeratePnpmWorkspaceProjects` answers "what does pnpm consider a member",
 * and a repo routinely holds real, first-party source outside that answer — a Claude plugin under
 * `plugins/`, a `scripts/` dir of build tooling. Those trees are not pnpm members (no member
 * manifest / not matched by `packages:`), so no project claimed them, nothing indexed them, and
 * every call site in them resolved to nothing while the parse looked healthy. Measured on this
 * repo before this pass: `plugins/coredoc-workflows` had 67 files and ~2k calls at 0% resolution.
 *
 * The OPT-IN is an explicit `tsconfig.json` at the root of such a tree, and deliberately nothing
 * weaker: it is the repo stating the program's shape (which files, which module resolution), so we
 * index the repo's own semantics rather than a config we invented. A tree with no tsconfig stays an
 * honestly-warned orphan in the SCIP coverage-gap warning (see `scipCoverageGaps`) — we never
 * synthesize one.
 *
 * Walk rules, mirroring `planOomSplit`:
 *   - the repo root is never a candidate (its own tsconfig is the root project, already enumerated
 *     — registering it twice would index the whole repo a second time);
 *   - an already-covered project root is not descended into: everything under it is that project's
 *     business, so a tsconfig nested inside a workspace member is never double-registered;
 *   - the OUTERMOST tsconfig on a branch wins — a tsconfig inside a discovered project is that
 *     project's own composite/nested detail;
 *   - installed deps, build output and dotdirs (incl. git worktrees, which duplicate the tree) are
 *     never entered.
 *
 * Never throws: an unreadable directory costs only its own subtree.
 */
export function discoverSoloTsconfigProjects(repoRoot: string, coveredProjects: string[]): string[] {
  const root = resolve(repoRoot);
  // The root project is a prefix of everything, so it can never be the "covering" project for this
  // purpose — the same root-is-not-a-container rule the ownership scoring uses (see
  // `projectOwnershipScore`). Every OTHER enumerated root prunes its subtree.
  const covered = new Set(coveredProjects.map((p) => resolve(p)));
  covered.delete(root);
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir must not lose the rest of the scan
    }
    if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'tsconfig.json')) {
      found.push(dir);
      return; // outermost wins — anything nested is this project's own business
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (SPLIT_SCAN_PRUNED.has(entry.name) || entry.name.startsWith('.') || covered.has(full)) continue;
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * Every project the per-project indexer should run: the pnpm workspace members PLUS the
 * tsconfig-rooted trees outside the workspace globs (`discoverSoloTsconfigProjects`).
 *
 * Both kinds are indexed identically — one child, one `.scip`, one `ProjectIndexOutcome` — so a
 * solo project gets the same failure reporting, the same ownership claim in the merge, and the
 * same coverage-gap classification as a workspace member. "Workspace project" elsewhere in this
 * file therefore means "one enumerated project", not "one pnpm member".
 *
 * Returns `[]` when workspace enumeration itself found nothing, which the caller reads as "fall
 * back to scip-typescript's own `--pnpm-workspaces` expansion". Discovery deliberately does not
 * rescue that case: with no member list we also have no covered-roots list, so the scan would
 * register subtrees of members as if they were independent projects.
 */
export function enumerateIndexProjects(repoRoot: string): string[] {
  const workspace = enumeratePnpmWorkspaceProjects(repoRoot);
  if (workspace.length === 0) return [];
  return [...workspace, ...discoverSoloTsconfigProjects(repoRoot, workspace)].sort();
}

/** Exact-file tsconfig content for a project that cannot safely use a repo-owned config directly. */
function syntheticTsconfig(sourceFiles: string[], extendsConfig?: string): string {
  const compilerOptions = extendsConfig
    ? {
        // Keep aliases, JSX, module resolution, libs and other repo semantics from the root config.
        allowJs: true,
        checkJs: false,
        noEmit: true,
      }
    : {
        allowJs: true,
        checkJs: false,
        noEmit: true,
        skipLibCheck: true,
        target: 'es2022',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        jsx: 'preserve',
        resolveJsonModule: true,
      };
  return JSON.stringify(
    {
      ...(extendsConfig ? { extends: extendsConfig } : {}),
      compilerOptions,
      files: sourceFiles,
      // A base config's broad include would otherwise union with `files` and recreate the OOM.
      ...(extendsConfig ? { include: [] } : {}),
    },
    null,
    2,
  );
}

/** Stable temporary config beside the index it feeds, always under the caller-owned SCIP dir. */
function syntheticConfigPath(scipPath: string): string {
  return `${scipPath.slice(0, -'.scip'.length)}.tsconfig.json`;
}

/** Write an exact-file synthetic config and return its path. The caller removes it in `finally`. */
function writeSyntheticConfig(scipPath: string, sourceFiles: string[], extendsConfig?: string): string {
  const configPath = syntheticConfigPath(scipPath);
  writeFileSync(configPath, syntheticTsconfig(sourceFiles, extendsConfig));
  return configPath;
}

/** Package entry used when a resolved scip-typescript package.json carries no readable `bin`. */
const SCIP_TS_FALLBACK_ENTRY = join('dist', 'src', 'main.js');

/** Degrade reason when every spawn candidate is missing — keep it honest about BOTH sources. */
const SCIP_TS_NOT_FOUND =
  'scip-typescript was not found on PATH and no bundled copy was resolvable ' +
  '(neither COREDOC_RUNTIME_MODULES nor a local @sourcegraph/scip-typescript install)';

/** Injection seams for `resolveScipTypescriptInvocations` — production defaults read env + require. */
export interface ScipInvocationDeps {
  /** Value of `COREDOC_RUNTIME_MODULES` (the bundled runtime `node_modules` dir), if set. */
  runtimeModules?: string;
  /** Resolves `@sourcegraph/scip-typescript/package.json`; may throw when the dep is not installed. */
  resolvePackageJson?: () => string;
  /** The runtime that can execute the package entry — `process.execPath` in production. */
  execPath?: string;
}

/** `bin` entry of the scip-typescript package.json, relative to the package dir. */
function scipTypescriptEntry(pkgDir: string): string {
  try {
    const bin = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { bin?: unknown }).bin;
    if (typeof bin === 'string') return resolve(pkgDir, bin);
    if (bin && typeof bin === 'object') {
      const named = (bin as Record<string, unknown>)[SCIP_INDEXERS.typescript.command];
      const entry = typeof named === 'string' ? named : Object.values(bin as Record<string, unknown>)[0];
      if (typeof entry === 'string') return resolve(pkgDir, entry);
    }
  } catch {
    /* unreadable/malformed manifest → fall back to the package's known entry */
  }
  return resolve(pkgDir, SCIP_TS_FALLBACK_ENTRY);
}

/**
 * Prefer Coredoc's pinned package: a stale global binary must not shadow the version we ship.
 * The runtime sidecar has no `.bin` shims, so invoke its entry through the runtime Node
 * (ELECTRON_RUN_AS_NODE is preserved in Desktop). PATH is only for distributions that have
 * no resolvable package; a broken bundled install must surface its own error.
 */
export function resolveScipTypescriptInvocations(deps: ScipInvocationDeps = {}): string[][] {
  const {
    runtimeModules = process.env.COREDOC_RUNTIME_MODULES,
    resolvePackageJson = () => createRequire(import.meta.url).resolve('@sourcegraph/scip-typescript/package.json'),
    execPath = process.execPath,
  } = deps;

  let pkgDir: string | undefined;
  const bundled = runtimeModules ? join(runtimeModules, '@sourcegraph', 'scip-typescript') : undefined;
  if (bundled && existsSync(bundled)) {
    pkgDir = bundled;
  } else {
    try {
      pkgDir = dirname(resolvePackageJson());
    } catch {
      /* Distributions without a resolvable package may supply the binary on PATH. */
    }
  }
  return pkgDir ? [[execPath, scipTypescriptEntry(pkgDir)]] : [[SCIP_INDEXERS.typescript.command]];
}

/** Outcome of walking the scip-typescript spawn candidates (see `resolveScipTypescriptInvocations`). */
export interface ScipSpawnOutcome {
  /** A candidate actually started; false only when EVERY candidate was missing (spawn ENOENT). */
  spawned: boolean;
  /** Failure message: the run's error, or the not-found reason when nothing could be spawned. */
  error: string;
}

/**
 * Child env for the indexer: the caller's env plus `--max-old-space-size` when
 * `COREDOC_SCIP_MAX_OLD_SPACE_MB` asks for it. OPT-IN, deliberately.
 *
 * scip-typescript holds a TypeScript program per project, so on a large monorepo indexed as ONE
 * workspace invocation it exhausts the V8 heap and aborts (`FATAL ERROR: … JavaScript heap out
 * of memory`) AFTER streaming a partial index — which downstream read as a complete index with
 * whole packages missing (audit S1). Raising the ceiling does NOT fix that, and it is not free:
 *   - supabase (25 projects) still aborts at a ~9 GB peak with the cap at 8 GB;
 *   - posthog indexed FURTHER with the bigger heap and then died mid-write, leaving a 1.5 GB
 *     truncated index that fails protobuf decode — turning a usable partial parse into no parse.
 * So the default is Node's own, and the correctness guarantee is `partialReason` + the SCIP
 * coverage-gap warning, not a bigger number. Per-project indexing (the default now, see
 * `runScipTypescript`) removes the cliff instead of moving it, and per-project children (plus the
 * single-project repo path) get `PER_PROJECT_HEAP_MB`; this var stays as an operator escape hatch
 * for a single oversized project and for COREDOC_SCIP_COMBINED=1 runs. An explicit
 * caller-set `--max-old-space-size` always wins.
 */
export function scipChildEnv(env: NodeJS.ProcessEnv = process.env, defaultMaxOldSpaceMb?: number): NodeJS.ProcessEnv {
  const requested = Number(env.COREDOC_SCIP_MAX_OLD_SPACE_MB);
  const mb = Number.isFinite(requested) && requested > 0 ? requested : defaultMaxOldSpaceMb;
  if (!mb || !Number.isFinite(mb) || mb <= 0) return env;
  const existing = env.NODE_OPTIONS ?? '';
  if (existing.includes('--max-old-space-size')) return env;
  return { ...env, NODE_OPTIONS: `${existing} --max-old-space-size=${mb}`.trim() };
}

/** Shared child-process options for every scip-typescript spawn (sync and async). */
const SCIP_SPAWN_OPTS = { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 } as const;

/**
 * Spawn scip-typescript with `args`, advancing to the next candidate ONLY on a spawn-level
 * ENOENT (the binary/entry itself is missing). A non-zero exit is a real run — it stops the
 * walk so callers keep the existing semantics (a written index still wins).
 */
function spawnScipTypescript(args: string[], cwd: string, defaultHeapMb?: number): ScipSpawnOutcome {
  for (const [command, ...prefix] of resolveScipTypescriptInvocations()) {
    try {
      execFileSync(command, [...prefix, ...args], {
        cwd,
        env: scipChildEnv(process.env, defaultHeapMb),
        ...SCIP_SPAWN_OPTS,
        stdio: 'pipe',
      });
      return { spawned: true, error: '' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue; // missing → try next candidate
      return { spawned: true, error: summarizeIndexerFailure(err, defaultHeapMb) };
    }
  }
  return { spawned: false, error: SCIP_TS_NOT_FOUND };
}

/**
 * Async twin of {@link spawnScipTypescript}, used by the per-project pool so several projects
 * index concurrently. Same candidate-walk semantics; additionally returns the child's stdout,
 * because scip-typescript reports the benign "no files got indexed" case there (it also exits
 * non-zero and deletes its own output for it — an EMPTY project, not a failed one).
 */
async function spawnScipTypescriptAsync(args: string[], cwd: string): Promise<ScipSpawnOutcome & { stdout: string }> {
  for (const [command, ...prefix] of resolveScipTypescriptInvocations()) {
    try {
      const { stdout } = await execFileAsync(command, [...prefix, ...args], {
        cwd,
        env: scipChildEnv(process.env, PER_PROJECT_HEAP_MB),
        ...SCIP_SPAWN_OPTS,
      });
      return { spawned: true, error: '', stdout: String(stdout ?? '') };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue; // missing → try next candidate
      const stdout = String((err as { stdout?: unknown } | null)?.stdout ?? '');
      return { spawned: true, error: summarizeIndexerFailure(err, PER_PROJECT_HEAP_MB), stdout };
    }
  }
  return { spawned: false, error: SCIP_TS_NOT_FOUND, stdout: '' };
}

/**
 * Default heap ceiling for a per-project indexer child and for the single-project repo path (one
 * repo = one project, same argument). NOT applied to the combined workspace invocation, which
 * keeps Node's default (see `scipChildEnv`).
 *
 * Measured, and it contradicts the earlier read of `COREDOC_SCIP_MAX_OLD_SPACE_MB`: raising the
 * heap of the ONE combined process only moved the cliff (posthog then died mid-write, leaving an
 * undecodable 1.5 GB index — one crash destroyed the whole parse). Per project, the same knob is
 * a real fix, because a monorepo project routinely does not fit in Node's ~4 GB default on its
 * own: posthog's `frontend` and every `products/*` (whose tsconfig extends the root and pulls the
 * whole frontend program in) OOM at 4 GB and index cleanly in ~72 s at 8 GB. What made the bigger
 * heap unsafe before — an unbounded blast radius — is exactly what per-project indexing removed:
 * a child that still dies costs only its own project, and its truncated file is discarded.
 * An operator-set COREDOC_SCIP_MAX_OLD_SPACE_MB still wins over this default.
 */
export const PER_PROJECT_HEAP_MB = 8192;

/**
 * A child failure as a reader can act on it. `execFile`'s message starts with the entire argv
 * ("Command failed: scip-typescript index --output /very/long/path …"), which is noise that also
 * used to get chopped mid-path by the caller's truncation and read as a mangled project path.
 * Keep the cause (V8 OOM / timeout / signal / stderr tail) and drop the argv.
 */
/** Prefix of an out-of-memory failure reason — the one failure the split retry acts on. */
export const OOM_REASON_PREFIX = 'out of memory:';

/** Did this project die because its TypeScript program did not fit in one V8 heap? */
export function isOomFailure(outcome: ProjectIndexOutcome): boolean {
  return !outcome.ok && (outcome.reason?.startsWith(OOM_REASON_PREFIX) ?? false);
}

export function summarizeIndexerFailure(err: unknown, heapMb?: number): string {
  const message = err instanceof Error ? err.message : String(err);
  const { signal, code, killed } = (err ?? {}) as { signal?: string | null; code?: unknown; killed?: boolean };
  // Strip the "Command failed: <argv>" first line; keep whatever stderr followed it.
  const stderr = message.replace(/^Command failed:[^\n]*\n?/, '').trim();
  if (/heap out of memory|Ineffective mark-compacts/.test(message)) {
    const ceiling = heapMb ? `${heapMb} MB by default` : "Node's default, which shrinks with container memory";
    return `${OOM_REASON_PREFIX} the TypeScript program for this project did not fit in the indexer's V8 heap (${ceiling}; raise COREDOC_SCIP_MAX_OLD_SPACE_MB)`;
  }
  // Async execFile reports a timeout as killed + SIGTERM with a null exit code.
  // Preserve explicit errors such as ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
  if (code === 'ETIMEDOUT' || (code == null && killed === true && signal === 'SIGTERM'))
    return `timed out after ${SCIP_SPAWN_OPTS.timeout / 60_000} minutes`;
  const head = stderr ? stderr.split('\n').slice(0, 4).join(' ').slice(0, 300) : message.slice(0, 300);
  return `exited with ${signal ? `signal ${signal}` : `code ${String(code ?? 'unknown')}`}: ${head}`;
}

/** The async spawn seam the per-project pool drives (see `spawnScipTypescriptAsync`). */
export type ScipAsyncSpawn = (args: string[], cwd: string) => Promise<ScipSpawnOutcome & { stdout: string }>;

/** Injection seams for the per-project pool — production defaults are the real spawn + env pool size. */
export interface PerProjectDeps {
  spawn?: ScipAsyncSpawn;
  concurrency?: number;
}

/** scip-typescript's own message for a project that contains no input files (exit 1, output removed). */
const NO_FILES_INDEXED = 'no files got indexed';

/** Env var overriding how many projects index concurrently. */
export const SCIP_CONCURRENCY_ENV = 'COREDOC_SCIP_PROJECT_CONCURRENCY';

/**
 * How many projects index at once. Each child is a full tsc-scale process (its own TypeScript
 * program, its own multi-GB-capable heap), so this is a MEMORY knob, not a CPU one: the whole
 * point of per-project indexing is that no single process has to hold the entire workspace, and
 * an unbounded pool would put the peak right back. 4 keeps a large monorepo comfortably under
 * the heap ceiling that killed the combined run while still hiding most of the wall-clock.
 */
export const DEFAULT_SCIP_CONCURRENCY = 4;

/** Resolve the project-pool size from env, ignoring junk/non-positive values. */
export function scipProjectConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[SCIP_CONCURRENCY_ENV]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SCIP_CONCURRENCY;
}

/** Env var restoring the pre-per-project single combined invocation (rollback path). */
export const SCIP_COMBINED_ENV = 'COREDOC_SCIP_COMBINED';

/**
 * Should this workspace be indexed project by project? No when the operator asked for the old
 * combined invocation (`COREDOC_SCIP_COMBINED=1`, the documented rollback), and no when we could
 * not enumerate any member — then scip-typescript's own `--pnpm-workspaces` expansion inside one
 * combined run is the only way to reach them at all.
 */
export function usePerProjectIndexing(projects: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return projects.length > 0 && env[SCIP_COMBINED_ENV] !== '1';
}

/** Subdirectory of the scip out dir holding the per-project indexes. */
const PROJECT_INDEX_DIR = 'scip-projects';

/**
 * Where project `projectDir` writes its index. Named by a hash of the repo-relative project
 * path (stable across runs, collision-free for sibling dirs with the same basename) with the
 * basename kept as a human-readable prefix.
 */
export function projectIndexPath(scipDir: string, repoRoot: string, projectDir: string): string {
  const rel = relative(repoRoot, projectDir) || '.';
  const slug = (rel === '.' ? 'root' : rel.split(/[\\/]/).pop() || 'project').replace(/[^\w.-]/g, '_');
  return join(scipDir, PROJECT_INDEX_DIR, `${slug}-${createHash('sha1').update(rel).digest('hex').slice(0, 12)}.scip`);
}

/** Index ONE enumerated project into its own file; never throws. */
async function indexOneProject(
  repoRoot: string,
  scipDir: string,
  plan: TypescriptProjectPlan,
  spawn: ScipAsyncSpawn,
): Promise<ProjectIndexOutcome> {
  const { projectDir, sourceFiles, extendsConfig } = plan;
  const project = relative(repoRoot, projectDir) || '.';
  // Fail fast on a project outside the repo: indexing a parent directory would pull in unrelated
  // trees (slow, wrong, and the resulting document paths would escape the repo-relative space the
  // merge assumes). `.` — the repo root itself — is the legitimate root project, not an escape.
  if (project.startsWith('..') || isAbsolute(project)) {
    return { project, ok: false, reason: `project path ${projectDir} is not inside the repo root ${repoRoot}` };
  }
  const scipPath = projectIndexPath(scipDir, repoRoot, projectDir);
  mkdirSync(dirname(scipPath), { recursive: true });
  // Never let a previous run's file masquerade as this run's output.
  try {
    rmSync(scipPath, { force: true });
  } catch {
    /* best-effort */
  }
  if (sourceFiles?.length === 0) return { project, ok: true, empty: true };

  let projectArg = projectDir;
  let configPath: string | undefined;
  if (sourceFiles) {
    try {
      configPath = writeSyntheticConfig(scipPath, sourceFiles, extendsConfig);
      projectArg = configPath;
    } catch (err) {
      return {
        project,
        ok: false,
        reason: `could not write synthetic tsconfig under the SCIP output directory: ${String(err).slice(0, 240)}`,
      };
    }
  }
  // cwd stays repoRoot so every project's index carries the SAME projectRoot and repo-relative
  // document paths — that is what makes the per-project indexes mergeable at all.
  const args = [...buildIndexerArgs('typescript', {}), '--output', scipPath, projectArg];
  let outcome: Awaited<ReturnType<ScipAsyncSpawn>>;
  try {
    outcome = await spawn(args, repoRoot);
  } finally {
    if (configPath) {
      try {
        rmSync(configPath, { force: true });
      } catch {
        /* best-effort cleanup; the config is in caller-owned output, never the source repo */
      }
    }
  }
  const { spawned, error, stdout } = outcome;
  if (!spawned) return { project, ok: false, reason: SCIP_TS_NOT_FOUND };
  if (error) {
    // Benign: the project has no input files, so scip-typescript removed its own output.
    if (stdout.includes(NO_FILES_INDEXED) || error.includes(NO_FILES_INDEXED)) {
      return sourceFiles
        ? {
            project,
            ok: false,
            reason: `scip-typescript indexed none of ${sourceFiles.length} explicitly selected source file(s)`,
          }
        : { project, ok: true, empty: true };
    }
    // A real crash (OOM/timeout). scip-typescript streams documents as it goes, so anything it
    // left behind is TRUNCATED — and one truncated file fails protobuf decode for the WHOLE
    // merge. Per-project indexing exists to contain a failure to its project, so drop it.
    try {
      rmSync(scipPath, { force: true });
    } catch {
      /* best-effort */
    }
    return { project, ok: false, reason: error.slice(0, 600) };
  }
  if (!existsSync(scipPath)) return { project, ok: true, empty: true };
  return { project, ok: true, scipPath };
}

/** What splitting a too-big project would produce. */
export interface SplitPlan {
  /** Nested project dirs (each holds its own tsconfig.json), absolute, outermost-wins. */
  nestedRoots: string[];
  /** TS/JS files under the project that no nested project covers — an accepted, named gap. */
  residueFiles: number;
}

/**
 * Plan a ONE-LEVEL split of a project that OOMed as a single program: find the independent
 * tsconfig projects nested beneath it, and count the files that no nested project claims.
 *
 * Measured shape this exists for: supabase's ROOT project is not one app but a monolith of ~24
 * independent mini-apps under `examples/**` (each with its own tsconfig) plus a handful of loose
 * `scripts/*.ts`. Indexed as one program it exceeds any heap; indexed as 24 programs each is
 * trivial. Only the OUTERMOST tsconfig on each branch is taken (a nested project inside a nested
 * project is that project's business), directories already owned by another enumerated project
 * (workspace member or discovered solo project — see `enumerateIndexProjects`) are skipped (they
 * are indexed on their own), and installed deps / build output / dotdirs (including git worktrees,
 * which duplicate the whole tree) are never descended into.
 *
 * One traversal answers both questions, and it never throws on an unreadable directory.
 */
export function planOomSplit(projectDir: string, otherProjects: string[] = []): SplitPlan {
  const covered = new Set(otherProjects.map((p) => resolve(p)));
  covered.delete(resolve(projectDir)); // the failing project itself is what we are splitting
  const nestedRoots: string[] = [];
  let residueFiles = 0;

  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir must not lose the rest of the scan
    }
    // A nested tsconfig marks an independent project: take it whole and stop descending.
    if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'tsconfig.json')) {
      nestedRoots.push(dir);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SPLIT_SCAN_PRUNED.has(entry.name) || entry.name.startsWith('.') || covered.has(full)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && TSJS_SOURCE_RE.test(entry.name)) {
        residueFiles++;
      }
    }
  };
  walk(resolve(projectDir), 0);
  return { nestedRoots: nestedRoots.sort(), residueFiles };
}

/**
 * Run `indexOneProject` over every project with at most `concurrency` in flight. A plain
 * cursor-shared worker pool — no dependency on the order projects complete in, since each
 * writes its own file.
 */
async function runProjectPool(
  repoRoot: string,
  scipDir: string,
  projects: string[],
  concurrency: number,
  spawn: ScipAsyncSpawn,
): Promise<ProjectIndexOutcome[]> {
  const plans = planTypescriptProjects(repoRoot, projects);
  const outcomes: ProjectIndexOutcome[] = new Array(plans.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let i = cursor++; i < plans.length; i = cursor++) {
      outcomes[i] = await indexOneProject(repoRoot, scipDir, plans[i], spawn);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
  return outcomes;
}

/**
 * Index a pnpm workspace ONE PROJECT AT A TIME (bounded pool), each into its own `.scip`.
 *
 * Why: the single combined invocation holds a TypeScript program for every project in one V8
 * heap and dies on a large monorepo (supabase aborts past a ~9 GB peak), leaving a partial index
 * that used to read as a complete one — whole packages with an empty call graph (audit S1).
 * Each project alone indexes in seconds with a normal heap. Cross-package resolution survives
 * the split because SCIP symbols are package-qualified monikers, and every child runs with
 * cwd=repoRoot so document paths stay repo-relative (see `packageSymbolKey` in decode.ts).
 *
 * Failure isolation: a project that crashes costs exactly that project — the rest still merge,
 * and the failures are named in `partialReason` (plus they show up per-directory in the caller's
 * SCIP coverage-gap warning).
 */
export async function runScipTypescriptPerProject(
  repoRoot: string,
  scipDir: string,
  projects: string[],
  deps: PerProjectDeps = {},
): Promise<IndexerResult> {
  const { spawn = spawnScipTypescriptAsync, concurrency = scipProjectConcurrency() } = deps;
  const outcomes = await runProjectPool(repoRoot, scipDir, projects, concurrency, spawn);
  outcomes.push(...(await splitOomProjects(repoRoot, scipDir, projects, outcomes, concurrency, spawn)));

  const scipPaths = outcomes.flatMap((o) => (o.scipPath ? [o.scipPath] : []));
  const failed = outcomes.filter((o) => !o.ok);

  if (scipPaths.length === 0) {
    const detail = failed[0]?.reason ? `: ${failed[0].reason}` : '';
    return {
      ok: false,
      projectOutcomes: outcomes,
      degradeReason: `scip-typescript produced no index for any of the ${projects.length} enumerated projects${detail}`,
    };
  }
  // One line per split project (not per sub-project), then the genuinely-failed ones.
  const notes = [
    ...outcomes.flatMap((o) =>
      o.split
        ? [
            `${o.project} OOM → split into ${o.split.subProjects} nested project(s), ` +
              `${o.split.residueFiles} residue file(s) unindexed (no tsconfig)`,
          ]
        : [],
    ),
    ...(failed.length
      ? [
          `scip-typescript failed for ${failed.length}/${projects.length} project(s) — those files have no ` +
            `resolved call edges: ${failed.map((f) => `${f.project} [${f.reason ?? 'unknown'}]`).join('; ')}`,
        ]
      : []),
  ];
  return {
    ok: true,
    scipPaths,
    projectOutcomes: outcomes,
    partialReason: notes.length ? notes.join('. ') : undefined,
  };
}

/**
 * Bounded retry for the ONE failure a split can fix: a project whose TypeScript program does not
 * fit in a heap, but which is really N independent nested projects (supabase's root over
 * `examples/**`). Each nested project is indexed exactly like an enumerated project — same slug
 * scheme, same heap, same outcome tracking — and the merge's dedupe-by-relative-path already
 * absorbs any overlap.
 *
 * Deliberately ONE level: a sub-project that OOMs in turn is reported failed, never split again.
 * Unbounded recursive splitting would turn a pathological repo into an unbounded process fan-out,
 * and the second level has never been the shape in the field. Non-OOM failures (timeout, broken
 * tsconfig, missing indexer) are NOT retried — splitting cannot fix them, and re-running a broken
 * project N times just multiplies the failure. The failing project's own directory is never
 * re-indexed: that is precisely what ran out of memory.
 */
async function splitOomProjects(
  repoRoot: string,
  scipDir: string,
  projects: string[],
  outcomes: ProjectIndexOutcome[],
  concurrency: number,
  spawn: ScipAsyncSpawn,
): Promise<ProjectIndexOutcome[]> {
  const subOutcomes: ProjectIndexOutcome[] = [];
  // `.` already ran as a bounded explicit residue project. Rediscovering nested tsconfigs after a
  // root failure would violate the workspace ownership plan and can fan back out across the repo.
  // Non-root umbrella projects retain the existing one-level recovery.
  for (const oomed of outcomes.filter((outcome) => outcome.project !== '.' && isOomFailure(outcome))) {
    const projectDir = resolve(repoRoot, oomed.project);
    const { nestedRoots, residueFiles } = planOomSplit(projectDir, projects);
    if (nestedRoots.length === 0) continue; // nothing to split into — keep the honest OOM failure
    const results = await runProjectPool(repoRoot, scipDir, nestedRoots, concurrency, spawn);
    for (const r of results) subOutcomes.push({ ...r, parent: oomed.project });
    // The parent's coverage now comes from its sub-projects; the un-tsconfig'd remainder is a
    // named gap rather than a whole-project blackout.
    oomed.ok = true;
    oomed.reason = undefined;
    oomed.split = { subProjects: nestedRoots.length, residueFiles };
  }
  return subOutcomes;
}

/**
 * Today's single combined invocation over all enumerated projects. Kept reachable behind
 * `COREDOC_SCIP_COMBINED=1` as the rollback path for per-project indexing, and used verbatim
 * when project enumeration finds nothing (an exotic/unreadable pnpm-workspace.yaml), where
 * scip-typescript's own `--pnpm-workspaces` enumeration is the only remaining option.
 */
function runScipTypescriptCombined(repoRoot: string, scipPath: string, projects: string[]): IndexerResult {
  const args = [...buildIndexerArgs('typescript', { pnpmWorkspaces: true, projects }), '--output', scipPath];
  // fall through on failure — a valid index may still have been written despite a non-zero exit.
  // But an index written by a FAILED run is partial (scip-typescript streams project by
  // project), so the error is reported alongside it instead of being dropped.
  const capturedErr = spawnScipTypescript(args, repoRoot).error;
  if (existsSync(scipPath)) {
    return {
      ok: true,
      scipPath,
      partialReason: capturedErr
        ? `scip-typescript (pnpm workspaces) wrote an index but exited with an error — the index may cover only the projects indexed before the failure: ${capturedErr.slice(0, 2000)}`
        : undefined,
    };
  }
  return {
    ok: false,
    degradeReason: `scip-typescript (pnpm workspaces) produced no index.scip${capturedErr ? `: ${capturedErr.slice(0, 2000)}` : ''}`,
  };
}

/**
 * Run scip-typescript over repoRoot, writing into `opts.outDir` (the repo's coredoc-output dir,
 * or a per-repo temp dir) — NOT the source tree. Returns a degrade reason (never throws) when the
 * indexer binary is missing or exits non-zero — the pipeline then proceeds with structural + AI
 * tiers only. For repos with no tsconfig, an exact-file allowJs config is created temporarily
 * under `opts.outDir` and removed afterward; the analyzed repo is never modified.
 *
 * Three shapes, in precedence order:
 *   1. pnpm workspace with enumerable members → PER-PROJECT: `scipPaths`, one index per member
 *      (`runScipTypescriptPerProject`). `COREDOC_SCIP_COMBINED=1` forces (2) instead.
 *   2. pnpm workspace with no enumerable members (or the rollback flag) → one combined index.
 *   3. single-project repo → one index, unchanged.
 *
 * Async only because of (1)'s bounded pool; (2) and (3) still run the indexer synchronously, so a
 * caller that hits them has no interleaving window (relevant to parseMultiTarget, which relies on
 * that when targets share a default scip dir). Per-project indexes are namespaced per project
 * path, so they never collide with `index.scip` from another target.
 */
export async function runScipTypescript(repoRoot: string, opts: ScipRunOpts = {}): Promise<IndexerResult> {
  const scipDir = resolveScipDir(repoRoot, opts.outDir);
  const scipPath = join(scipDir, 'index.scip');

  // Monorepo path: index every enumerated project so cross-package references resolve. No tsconfig
  // synthesis (projects bring their own). Default is per-project (one child per project, bounded
  // pool) because one process cannot hold a large workspace; the combined invocation stays
  // reachable via COREDOC_SCIP_COMBINED=1 and is the only option when enumeration finds nothing.
  if (isPnpmWorkspaceRoot(repoRoot)) {
    // Enumerate ourselves; `--pnpm-workspaces` is only the fallback (see
    // enumeratePnpmWorkspaceProjects — it spawns `pnpm ls`, which dies in the desktop sandbox
    // where HOME is empty and the network is denied). Ours also reaches the tsconfig-rooted trees
    // outside the workspace globs, which `pnpm ls` by definition does not know about.
    const projects = enumerateIndexProjects(repoRoot);
    return usePerProjectIndexing(projects)
      ? runScipTypescriptPerProject(repoRoot, scipDir, projects)
      : runScipTypescriptCombined(repoRoot, scipPath, projects);
  }

  const hasTsconfig = existsSync(join(repoRoot, 'tsconfig.json'));
  const sourceFiles = hasTsconfig ? undefined : planTypescriptProjects(repoRoot, [repoRoot])[0].sourceFiles;
  if (sourceFiles?.length === 0) {
    return { ok: false, degradeReason: 'scip-typescript found no TS/JS source files to index' };
  }

  let projectArg: string | undefined;
  let configPath: string | undefined;
  if (sourceFiles) {
    try {
      configPath = writeSyntheticConfig(scipPath, sourceFiles);
      projectArg = configPath;
    } catch (err) {
      return {
        ok: false,
        degradeReason: `could not write synthetic tsconfig under the SCIP output directory: ${String(err).slice(0, 160)}`,
      };
    }
  }

  let outcome: ScipSpawnOutcome;
  try {
    const args = [...buildIndexerArgs('typescript', {}), '--output', scipPath, ...(projectArg ? [projectArg] : [])];
    // Same ceiling as a per-project child: a lone repo is exactly one project, and Node's own
    // default is sized from container memory (~2 GB on a 4 GB CI runner), which OOMs mid-size repos.
    outcome = spawnScipTypescript(args, repoRoot, PER_PROJECT_HEAP_MB);
  } finally {
    if (configPath) {
      try {
        rmSync(configPath, { force: true });
      } catch {
        /* best-effort cleanup; the config is in caller-owned output, never the source repo */
      }
    }
  }
  if (!outcome.spawned) return { ok: false, degradeReason: outcome.error };
  if (outcome.error) return { ok: false, degradeReason: `scip-typescript failed: ${outcome.error.slice(0, 2000)}` };
  if (!existsSync(scipPath)) {
    return { ok: false, degradeReason: 'scip-typescript produced no index.scip' };
  }
  return { ok: true, scipPath };
}
