/**
 * Symbol identity for a referenced TYPE-or-VALUE name: which FILE declares the enum, class or
 * interface a reference names, resolved over the module graph of the parse itself.
 *
 * Why not SCIP occurrences (the other candidate mechanism): the SCIP tier only runs when the
 * analyzed repo has `node_modules` (see `discover`), and even then it covers only the files an
 * indexed tsconfig claims — measured on this repo, hundreds of discovered files sit outside every
 * project's include. Identity that disappears with the indexer would make barrel resolution a
 * property of the checkout rather than of the code. The module graph (structural imports +
 * `export … from` re-exports + specifier resolution) is present in every parse, so identity is
 * resolved the same way everywhere.
 *
 * Three answers, and the refusal is a first-class one:
 *  - `declared` — the declaring file, found by resolving the specifier and, when the target only
 *    re-exports the name, following the re-export chain to the module that declares it;
 *  - `external` — the specifier provably names a module outside this repo (a dependency the repo
 *    declares, or an installed package), so the symbol is not this repo's and no edge should exist;
 *  - `unresolved` — nothing proved either way; the caller keeps the reference unresolved so the
 *    storage layer can mark it ambiguous. Never a name guess.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { StructuralFile } from './ts-structural.js';

/** Declaration form a referenced name can resolve to. */
export enum DeclKind {
  Enum = 'enum',
  Class = 'class',
  Interface = 'interface',
}

/** Where a referenced name is declared, or why that could not be decided. */
export type SymbolRefIdentity =
  | {
      kind: 'declared';
      filePath: string;
      /** Name the DECLARING module gives it — a re-export alias is unwound like an import alias. */
      declaredName: string;
      /** Declaration form found there (a name can be a class in one module, an interface in another). */
      declKind: DeclKind;
    }
  | { kind: 'external' }
  | { kind: 'unresolved' };

/** Re-export chains are bounded so a barrel ring can never loop. */
const MAX_REEXPORT_HOPS = 8;

/**
 * `extends` chains are bounded so a tsconfig that extends itself (directly or through a ring) can
 * never loop. Its own constant: the re-export bound describes a barrel graph and the two limits
 * happen to be similar today, but nothing ties them — reusing one for the other means retuning
 * barrel depth silently retunes config resolution.
 */
const MAX_TSCONFIG_EXTENDS_HOPS = 8;

/** Extension/index probes for an extensionless specifier, in TypeScript's own precedence order. */
const MODULE_PROBES = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
];

/** A tsconfig `paths` entry, with its targets already made repo-relative. */
interface AliasEntry {
  /** Key with any trailing `*` removed. */
  prefix: string;
  /** True when the key had no `*` — it matches the specifier exactly, never as a prefix. */
  exact: boolean;
  /** Repo-relative target prefixes (the `*` removed), in declaration order. */
  targets: string[];
}

interface ModuleResolutionConfig {
  aliases: AliasEntry[];
  /** Repo-relative `baseUrl` directory, when the tsconfig sets one. */
  baseUrl?: string;
}

export interface SymbolIdentityResolverOptions {
  repoRoot: string;
  /** package.json `name` of every workspace package — never external, whatever node_modules holds. */
  workspacePackageNames: string[];
  /**
   * Repo-relative directory of every detected workspace package (`detectWorkspacePackages`). Their
   * manifests are unioned into the declared-dependency set: in a pnpm/turbo monorepo a sub-package's
   * dependencies appear in `packages/x/package.json` and pnpm does NOT symlink them into the root
   * `node_modules`, so without this neither proof of externality is available for most specifiers
   * here and `isExternalSpecifier` answers `false` for genuinely external packages.
   */
  workspacePackagePaths?: string[];
}

/**
 * Resolver over one parse's structural files. Construction is async only because the tsconfig
 * reader is loaded lazily (the TypeScript compiler is not pulled in for repos without one).
 */
export async function createSymbolIdentityResolver(
  files: StructuralFile[],
  opts: SymbolIdentityResolverOptions,
): Promise<SymbolIdentityResolver> {
  return new SymbolIdentityResolver(files, opts, await readModuleResolutionConfig(opts.repoRoot));
}

export class SymbolIdentityResolver {
  private readonly byPath = new Map<string, StructuralFile>();
  /** filePath → declared name → the forms that file declares it in. */
  private readonly declarations = new Map<string, Map<string, Set<DeclKind>>>();
  private readonly workspaceNames: Set<string>;
  private readonly declaredDependencies: Set<string>;
  private readonly specifierMemo = new Map<string, string | undefined>();
  private readonly identityMemo = new Map<string, SymbolRefIdentity>();
  /**
   * package NAME → externality. `isExternalSpecifier` ends in a synchronous `existsSync`, and it is
   * asked once per (file, specifier) pair while the answer depends only on the package name.
   */
  private readonly externalityMemo = new Map<string, boolean>();
  /**
   * Manifests that exist but could not be read or parsed. NOT silent: an unreadable package.json
   * shrinks the declared-dependency set, which makes externality unprovable, which re-enables the
   * by-name hierarchy fabrication this module exists to prevent (`hierarchy-ref-identity.ts` uses
   * `external` as the proof that suppresses it). The caller surfaces these in the parse's errors.
   */
  readonly manifestErrors: readonly string[];

  constructor(
    files: StructuralFile[],
    private readonly opts: SymbolIdentityResolverOptions,
    private readonly config: ModuleResolutionConfig,
  ) {
    for (const f of files) {
      this.byPath.set(f.path, f);
      const declared = new Map<string, Set<DeclKind>>();
      const add = (name: string, kind: DeclKind): void => {
        if (!name) return;
        const kinds = declared.get(name) ?? new Set<DeclKind>();
        kinds.add(kind);
        declared.set(name, kinds);
      };
      for (const e of f.enums ?? []) add(e.name, DeclKind.Enum);
      for (const c of f.classes ?? []) add(c.name, DeclKind.Class);
      for (const i of f.interfaces ?? []) add(i.name, DeclKind.Interface);
      this.declarations.set(f.path, declared);
    }
    this.workspaceNames = new Set(opts.workspacePackageNames);
    const declared = readDeclaredDependencies(opts.repoRoot, opts.workspacePackagePaths ?? []);
    this.declaredDependencies = declared.names;
    this.manifestErrors = declared.errors;
  }

  /**
   * Form `file` declares `name` in, preferring the first entry of `kinds` it actually declares
   * (a class and an interface of the same name in one file is legal declaration merging, and the
   * clause that asks decides which half it means). Undefined when the file declares none of them.
   */
  declares(file: string, name: string, kinds: readonly DeclKind[]): DeclKind | undefined {
    const declared = this.declarations.get(file)?.get(name);
    return declared ? kinds.find((kind) => declared.has(kind)) : undefined;
  }

  /**
   * The specifier names a file of THIS parse. Separates the two answers `unresolved` conflates:
   * a module this parse never saw (identity genuinely unknown) from a module it DID see that simply
   * declares no such symbol (a proven negative — the name is not the kind asked for).
   */
  resolvesToRepoFile(fromFile: string, specifier: string): boolean {
    return this.resolveSpecifier(fromFile, specifier) !== undefined;
  }

  /** Identity of `name` as imported by `specifier` from `fromFile`, as one of `kinds`. */
  resolve(fromFile: string, name: string, specifier: string, kinds: readonly DeclKind[]): SymbolRefIdentity {
    const key = `${fromFile}|${specifier}|${name}|${kinds.join(',')}`;
    const memo = this.identityMemo.get(key);
    if (memo) return memo;
    const answer = this.resolveUncached(fromFile, name, specifier, kinds);
    this.identityMemo.set(key, answer);
    return answer;
  }

  private resolveUncached(
    fromFile: string,
    name: string,
    specifier: string,
    kinds: readonly DeclKind[],
  ): SymbolRefIdentity {
    const target = this.resolveSpecifier(fromFile, specifier);
    if (!target) return this.isExternalSpecifier(specifier) ? { kind: 'external' } : { kind: 'unresolved' };
    const declared = this.declaringFile(target, name, kinds, 0, new Set());
    return declared ? { kind: 'declared', ...declared } : { kind: 'unresolved' };
  }

  /**
   * File declaring `name`, starting at `file` and following its `export … from` chain.
   * Named re-exports honour the alias direction (`export { Status as RepoStatus }` re-exported
   * as `RepoStatus` means the source module declares `Status`); `export *` resolves only when
   * exactly one star target yields a declaration, because a name two barrels both claim has no
   * decidable owner.
   */
  private declaringFile(
    file: string,
    name: string,
    kinds: readonly DeclKind[],
    depth: number,
    seen: Set<string>,
  ): { filePath: string; declaredName: string; declKind: DeclKind } | undefined {
    if (depth >= MAX_REEXPORT_HOPS) return undefined;
    const key = `${file}::${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const local = this.declares(file, name, kinds);
    if (local) return { filePath: file, declaredName: name, declKind: local };
    const reExports = this.byPath.get(file)?.reExports ?? [];

    for (const re of reExports) {
      if (re.kind !== 'named') continue;
      for (const n of re.names ?? []) {
        if ((n.alias ?? n.name) !== name) continue;
        const target = this.resolveSpecifier(file, re.moduleSpecifier);
        if (!target) continue;
        const hit = this.declaringFile(target, n.name, kinds, depth + 1, seen);
        if (hit) return hit;
      }
    }

    const starHits = new Map<string, { filePath: string; declaredName: string; declKind: DeclKind }>();
    for (const re of reExports) {
      if (re.kind !== 'star') continue;
      const target = this.resolveSpecifier(file, re.moduleSpecifier);
      if (!target) continue;
      const hit = this.declaringFile(target, name, kinds, depth + 1, seen);
      if (hit) starHits.set(`${hit.filePath}::${hit.declaredName}`, hit);
    }
    return starHits.size === 1 ? [...starHits.values()][0] : undefined;
  }

  /** Module specifier → a file of THIS parse (relative path, tsconfig alias, or baseUrl). */
  private resolveSpecifier(fromFile: string, specifier: string): string | undefined {
    const key = `${fromFile}|${specifier}`;
    if (this.specifierMemo.has(key)) return this.specifierMemo.get(key);
    const resolved = this.resolveSpecifierUncached(fromFile, specifier);
    this.specifierMemo.set(key, resolved);
    return resolved;
  }

  private resolveSpecifierUncached(fromFile: string, specifier: string): string | undefined {
    if (specifier.startsWith('.')) {
      return this.probe(posix.normalize(posix.join(posix.dirname(fromFile), specifier)));
    }
    // Longest alias key wins, so a repo with both `X` and `X/*` does not let the exact key
    // swallow `X/sub`.
    for (const alias of this.config.aliases) {
      const matches = alias.exact ? specifier === alias.prefix : specifier.startsWith(alias.prefix);
      if (!matches) continue;
      const rest = specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const hit = this.probe(posix.normalize(posix.join(target, rest)));
        if (hit) return hit;
      }
    }
    if (this.config.baseUrl !== undefined) {
      return this.probe(posix.normalize(posix.join(this.config.baseUrl, specifier)));
    }
    return undefined;
  }

  /** A parsed file at `base`, with or without the extension the specifier omitted. */
  private probe(base: string): string | undefined {
    const rel = base.replace(/^\.\//, '');
    if (this.byPath.has(rel)) return rel;
    for (const ext of MODULE_PROBES) {
      if (this.byPath.has(rel + ext)) return rel + ext;
    }
    return undefined;
  }

  /**
   * The specifier names a module outside this repo. Proof is one of two facts the repo itself
   * states: the package is declared as a dependency, or it is installed under node_modules. A
   * workspace package is never external no matter what node_modules links.
   */
  private isExternalSpecifier(specifier: string): boolean {
    const pkg = packageNameOf(specifier);
    if (!pkg || this.workspaceNames.has(pkg)) return false;
    const memo = this.externalityMemo.get(pkg);
    if (memo !== undefined) return memo;
    const external =
      this.declaredDependencies.has(pkg) || existsSync(join(this.opts.repoRoot, 'node_modules', ...pkg.split('/')));
    this.externalityMemo.set(pkg, external);
    return external;
  }
}

/**
 * Package name a bare specifier belongs to (`@scope/pkg/sub` → `@scope/pkg`). Undefined for a
 * relative/absolute path and for a scoped-looking alias with no package part (`@/lib/x`), which
 * is a path alias, not a package.
 */
function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 && parts[0].length > 1 && parts[1].length > 0 ? `${parts[0]}/${parts[1]}` : undefined;
  }
  return parts[0] || undefined;
}

/**
 * Every dependency name declared across the repo's manifests — the ROOT package.json plus every
 * detected workspace package's, unioned. The root alone is not enough in a pnpm/turbo monorepo: a
 * sub-package's dependencies live in `packages/x/package.json` and pnpm does not symlink them into
 * the root `node_modules`, so neither proof of externality holds and every such specifier reads as
 * `unresolved` — which is precisely the state that lets a by-name hierarchy edge be fabricated.
 *
 * A MISSING manifest is normal (a directory without one, a repo without a root package.json) and
 * contributes nothing. A manifest that exists but cannot be read or parsed is reported, never
 * swallowed: it silently shrinks this set, and the cost of that is a symbol whose externality can
 * no longer be proven — the one fact that stops `resolveHierarchyRefIdentity` from name-matching
 * an npm base class onto an unrelated same-named local class.
 */
function readDeclaredDependencies(
  repoRoot: string,
  workspacePackagePaths: string[],
): { names: Set<string>; errors: string[] } {
  const names = new Set<string>();
  const errors: string[] = [];
  const manifests = [
    'package.json',
    ...workspacePackagePaths.map((p) => (p === '.' ? 'package.json' : `${p}/package.json`)),
  ];

  for (const rel of new Set(manifests)) {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, rel), 'utf8');
    } catch (err) {
      // No manifest here at all — the expected case for a directory that is not a package.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      errors.push(`${rel} could not be read (${String(err).slice(0, 120)})`);
      continue;
    }
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      errors.push(`${rel} is not valid JSON (${String(err).slice(0, 120)})`);
      continue;
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return { names, errors };
}

/**
 * `baseUrl` + `paths` of the repo's root tsconfig, made repo-relative. TypeScript's own reader is
 * used (tsconfigs legally carry comments and trailing commas) and is imported lazily, so a repo
 * without a root tsconfig never loads the compiler. `extends` is followed for the alias fields
 * only, since that is all this resolver reads.
 */
async function readModuleResolutionConfig(repoRoot: string): Promise<ModuleResolutionConfig> {
  const rootConfig = join(repoRoot, 'tsconfig.json');
  if (!existsSync(rootConfig)) return { aliases: [] };
  const { default: ts } = await import('typescript');

  let configPath: string | undefined = rootConfig;
  for (let depth = 0; configPath && depth < MAX_TSCONFIG_EXTENDS_HOPS; depth++) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const config = read.config as { compilerOptions?: Record<string, unknown>; extends?: unknown } | undefined;
    if (!config) return { aliases: [] };
    const options = config.compilerOptions ?? {};
    const paths = options.paths as Record<string, string[]> | undefined;
    const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : undefined;
    if (paths || baseUrl !== undefined) {
      // `paths` targets and `baseUrl` are relative to the config that declares them.
      const configDir = posix.dirname(toPosix(relativeToRoot(repoRoot, configPath)));
      const base = posix.normalize(posix.join(configDir, baseUrl ?? '.'));
      return {
        baseUrl: baseUrl === undefined ? undefined : base,
        aliases: Object.entries(paths ?? {})
          .map(([key, targets]) => ({
            prefix: key.replace(/\*$/, ''),
            exact: !key.includes('*'),
            targets: (Array.isArray(targets) ? targets : [])
              .filter((t): t is string => typeof t === 'string')
              .map((t) => posix.normalize(posix.join(base, t.replace(/\*$/, '')))),
          }))
          .sort((a, b) => b.prefix.length - a.prefix.length),
      };
    }
    const parent = typeof config.extends === 'string' ? config.extends : undefined;
    configPath = parent?.startsWith('.') ? join(configPath, '..', parent) : undefined;
    if (configPath && !existsSync(configPath))
      configPath = existsSync(`${configPath}.json`) ? `${configPath}.json` : undefined;
  }
  return { aliases: [] };
}

function relativeToRoot(repoRoot: string, absolute: string): string {
  return absolute.startsWith(repoRoot) ? absolute.slice(repoRoot.length).replace(/^[/\\]/, '') : absolute;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}
