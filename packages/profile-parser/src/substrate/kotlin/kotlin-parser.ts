/**
 * Kotlin/Android repo parser — the one place every Kotlin lane meets.
 *
 * Order is forced by the lanes' inputs: discover → one parse+walk per file (no lane re-walks a
 * tree) → the FQCN index → the Gradle layout (module roots, manifests, navigation, layouts) →
 * imports → calls → egress → entities/db-ops (both gated on `profile.entities`, the Swift rule)
 * → entrypoints → components/routes. Only then are the trees released: web-tree-sitter never
 * collects a tree and its heap is capped at 2 GB, but a lane reading a released tree is a
 * use-after-free, so the release is the LAST thing that touches them (in a `finally`, so a
 * throwing lane cannot strand a repo's trees in that heap).
 *
 * A file that cannot be read is counted in `skippedFiles` and skipped; a file whose tree has
 * `ERROR` nodes is still walked and everything outside the error subtree survives.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CallEdge,
  type ClassNode,
  type ComponentNode,
  type DbOpResolutionStats,
  type DbOperation,
  type EntityNode,
  type Entrypoint,
  type EnumNode,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type ImportEdge,
  type InterfaceNode,
  type KotlinParseStats,
  type Package,
  type ParseError,
  type ParsedRepo,
  type RepoType,
  type RouteNode,
  StableIdGenerator,
  type TypeAliasNode,
  type VariableNode,
} from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import type { KotlinProfile } from '../../types/kotlin-profile.js';
import { toFileNodes } from '../file-nodes.js';
import { type SourceFileScope, applySourceFileScope } from '../source-file-scope.js';
import { resolveKotlinCalls } from './kotlin-callgraph.js';
import { extractKotlinComponents } from './kotlin-components.js';
import { extractKotlinDbOps } from './kotlin-dbops.js';
import { type KotlinFile, type KotlinFileFacts, extractKotlinFileFacts, toKotlinFile } from './kotlin-declarations.js';
import { extractKotlinEgress } from './kotlin-egress.js';
import { extractKotlinEntities } from './kotlin-entities.js';
import { extractKotlinEntrypoints, resolveAndroidBases } from './kotlin-entrypoints.js';
import { discoverGradleLayout, findSettingsFile, moduleBuildFile } from './kotlin-gradle.js';
import { buildKotlinImportEdges } from './kotlin-imports.js';
import { type AndroidManifestFacts, type NavGraphFacts, readManifest, readNavigationGraph } from './kotlin-xml.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';
import { toParsedRepo } from '../to-parsed-repo.js';

export interface ParseKotlinRepoOptions {
  /** Gateway prefix from RepoConfig.httpPrefix, propagated to the linker for prefix-aware matching. */
  httpPrefix?: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)). */
  repoKey?: string;
}

/** The Kotlin parser's output: every `ParsedRepo` collection plus the parse-time counters. */
export interface KotlinParsedRepo {
  id: string;
  name: string;
  type: RepoType;
  /** Gateway prefix for the cross-repo linker; not a `ParsedRepo` field (dropped below). */
  httpPrefix?: string;
  packages: Package[];
  files: FileNode[];
  functions: FunctionNode[];
  classes: ClassNode[];
  interfaces: InterfaceNode[];
  enums: EnumNode[];
  variables: VariableNode[];
  typeAliases: TypeAliasNode[];
  imports: ImportEdge[];
  calls: CallEdge[];
  entrypoints: Entrypoint[];
  entities: EntityNode[];
  dbOperations: DbOperation[];
  externalCalls: ExternalCallEdge[];
  components: ComponentNode[];
  routes: RouteNode[];
  /** Resource files (manifests, navigation graphs) that could not be read or parsed. */
  errors: ParseError[];
  parseStats: {
    totalFiles: number;
    parsedFiles: number;
    skippedFiles: number;
    parseTimeMs: number;
    dbOpResolution?: DbOpResolutionStats;
  };
  kotlinStats: KotlinParseStats;
}

/** The scorer- and parser-facing source scope: git-aware discovery + the profile's globs. */
export function discoverKotlinFileScope(root: string, include: string[], exclude: string[] = []): SourceFileScope {
  return kotlinScope(enumerateRepoFiles(root), include, exclude);
}

/** `.kt` only — a Kotlin target never claims `.java` (NG-1). */
function kotlinScope(allFiles: readonly string[], include: string[], exclude: string[]): SourceFileScope {
  const inc = include.length > 0 ? include : ['**/*.kt'];
  return applySourceFileScope(
    allFiles.filter((rel) => rel.endsWith('.kt')),
    inc,
    [],
    exclude,
  );
}

/** The directory of a repo-relative path (`''` for a root file). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Longest directory prefix shared by two repo-relative directories. */
function commonDir(a: string, b: string): string {
  const x = a.split('/');
  const y = b.split('/');
  const out: string[] = [];
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) out.push(x[i]);
  return out.join('/');
}

/**
 * The two kinds of package this substrate emits.
 *
 * The `kt:` prefix on the Kotlin-package key is load-bearing: `packageId` is an unnamespaced
 * string key, so a single-segment Kotlin package and a Gradle module directory of the same name
 * (`app` is routinely both) would otherwise mint ONE id and silently merge two nodes while
 * referential integrity stayed green. Two packages may legitimately share a `path`; nothing
 * joins on path.
 */
function emitPackages(
  facts: readonly KotlinFileFacts[],
  moduleRoots: readonly string[],
  allFiles: readonly string[],
  manifests: readonly AndroidManifestFacts[],
  repoName: string,
  idGen: StableIdGenerator,
): Package[] {
  const packages: Package[] = [];

  // One per distinct Kotlin package, at the common directory of its files.
  const dirsByPackage = new Map<string, string>();
  for (const f of facts) {
    const dir = dirOf(f.relPath);
    const seen = dirsByPackage.get(f.packageName);
    dirsByPackage.set(f.packageName, seen === undefined ? dir : commonDir(seen, dir));
  }
  for (const [packageName, dir] of [...dirsByPackage].sort(([a], [b]) => a.localeCompare(b))) {
    packages.push({
      id: idGen.packageId(`kt:${packageName}`),
      name: packageName,
      path: dir === '' ? '.' : dir,
      language: 'kotlin',
    });
  }

  // One per Gradle module root (the repo root included), owning no files of its own.
  const appDirs = new Set(manifests.filter((m) => m.hasApplication).map((m) => dirOf(m.filePath)));
  for (const dir of [...moduleRoots].sort()) {
    const path = dir === '' ? '.' : dir;
    const pkg: Package = {
      id: idGen.packageId(path),
      name: dir === '' ? repoName : dir.split('/').join(':'),
      path,
      language: 'kotlin',
      type: [...appDirs].some((d) => d === dir || d.startsWith(dir === '' ? '' : `${dir}/`)) ? 'mobile' : 'library',
    };
    const build = moduleBuildFile(dir, allFiles);
    if (build) pkg.manifestFile = build;
    packages.push(pkg);
  }
  return packages;
}

/**
 * Read and parse every discovered XML of one kind, REPORTING the ones that could not be read or
 * parsed. An unreadable resource file is not a Kotlin source file, so it is not counted in
 * `skippedFiles`; it is recorded in `errors` instead, because a broken `AndroidManifest.xml`
 * silently drops every Android entrypoint of that module and a silent `continue` makes that
 * look like a repository with no components.
 */
function readXml<T>(
  root: string,
  paths: readonly string[],
  read: (path: string, xml: string, onWarn: (msg: string) => void) => T | undefined,
  warn: (file: string, message: string) => void,
): T[] {
  const out: T[] = [];
  for (const path of paths) {
    let xml: string;
    try {
      xml = readFileSync(join(root, path), 'utf-8');
    } catch (err) {
      warn(path, `kotlin: unreadable resource file: ${(err as Error).message}`);
      continue;
    }
    const parsed = read(path, xml, (msg) => warn(path, msg));
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Parse a Kotlin/Android repo on disk into a `KotlinParsedRepo`. */
export async function parseKotlinRepo(
  root: string,
  name: string,
  opts: ParseKotlinRepoOptions = {},
  profile?: KotlinProfile,
): Promise<KotlinParsedRepo> {
  const start = Date.now();
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);

  const allFiles = enumerateRepoFiles(root);
  const scope = kotlinScope(allFiles, profile?.substrate.include ?? [], profile?.substrate.exclude ?? []);

  const trees: KotlinFile[] = [];
  const errors: ParseError[] = [];
  // A parser message is repo-controlled text that reaches a terminal and a stored snapshot:
  // control characters are stripped so it cannot move a cursor or inject an escape sequence.
  const warn = (file: string, message: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0/C1 to strip them.
    errors.push({ file, message: message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), severity: 'warning' });
  let skippedFiles = 0;
  try {
    for (const relPath of scope.included) {
      let source: string;
      try {
        source = readFileSync(join(root, relPath), 'utf-8');
      } catch {
        skippedFiles++;
        continue;
      }
      trees.push(await toKotlinFile(relPath, source));
    }

    const koinAccessors = profile?.di?.koin?.accessors;
    const facts = trees.map((tree) => extractKotlinFileFacts(tree, idGen, { koinAccessors }));
    const index = new KotlinTypeIndex(facts);

    const settings = findSettingsFile(allFiles);
    // An unreadable settings file degrades to the no-settings layout (module roots inferred from
    // the build files alone) and is REPORTED, like a broken resource file: one unreadable Gradle
    // file must not abort a parse whose Kotlin sources all read fine.
    let settingsText: string | undefined;
    if (settings) {
      try {
        settingsText = readFileSync(join(root, settings), 'utf-8');
      } catch (err) {
        warn(
          settings,
          `kotlin: unreadable Gradle settings file, module layout inferred without it: ${(err as Error).message}`,
        );
      }
    }
    const layout = discoverGradleLayout(allFiles, scope.included, settingsText);
    const manifests = readXml(root, layout.manifestFiles, readManifest, warn);
    const navGraphs: NavGraphFacts[] = readXml(root, layout.navigationFiles, readNavigationGraph, warn);

    const imports = buildKotlinImportEdges(facts, index, idGen);
    const calls = resolveKotlinCalls(facts, index, idGen);
    const egress = extractKotlinEgress(facts, index, idGen, { verbAnnotations: profile?.egress?.verbAnnotations });

    // Entities and db-ops are gated together on the profile's `entities` block (the Swift rule):
    // emitting entities without operations would trip the language-neutral red flag.
    let entities: EntityNode[] = [];
    let dbOperations: DbOperation[] = [];
    let unparsedDaoQueries = 0;
    // Absent = not measured: with no `entities` block neither db-op lane ran.
    let dbOpResolution: DbOpResolutionStats | undefined;
    if (profile?.entities) {
      const extracted = extractKotlinEntities(facts, index, idGen, profile.entities);
      entities = extracted.entities;
      const ops = extractKotlinDbOps(facts, index, extracted.entityIdByName, idGen, {
        orm: profile.entities.orm,
        opMap: profile.dbOperations?.opMap,
        baseClasses: profile.entities.baseClasses,
      });
      dbOperations = ops.operations;
      unparsedDaoQueries = ops.unparsedDaoQueries;
      dbOpResolution = ops.stats;
    }

    const bases = resolveAndroidBases(profile?.android);
    const entrypoints = extractKotlinEntrypoints({ facts, index, bases, manifests, idGen });
    const components = extractKotlinComponents({
      facts,
      index,
      bases,
      idGen,
      navGraphs,
      layoutFiles: layout.layoutFiles,
    });

    // Last read of a tree source; every lane above has taken what it needs.
    const packageIdByFile = new Map(facts.map((f) => [f.relPath, idGen.packageId(`kt:${f.packageName}`)]));
    const rootPackageId = idGen.packageId('.');
    const files = toFileNodes(trees, idGen, {
      language: 'kotlin',
      commentPrefix: '//',
      packageIdFor: (relPath) => packageIdByFile.get(relPath) ?? rootPackageId,
    });

    const flat = <T>(pick: (f: KotlinFileFacts) => T[]): T[] => facts.flatMap(pick);
    const kotlinStats: KotlinParseStats = {
      filesParsed: files.length,
      filesWithSyntaxErrors: facts.filter((f) => f.hasSyntaxError).length,
      ...calls.stats,
      endpointsDefined: egress.endpointsDefined,
      egressCallSites: egress.egressCallSites,
      entrypointsWithoutHandler: entrypoints.entrypointsWithoutHandler,
      unparsedDaoQueries,
    };

    return {
      id: idGen.getRepoHash(),
      name,
      type: profile?.repoType ?? 'mobile',
      httpPrefix: opts.httpPrefix,
      packages: emitPackages(facts, layout.moduleRoots, allFiles, manifests, name, idGen),
      files,
      functions: flat((f) => f.functions),
      classes: flat((f) => f.classes),
      interfaces: flat((f) => f.interfaces),
      enums: flat((f) => f.enums),
      variables: flat((f) => f.variables),
      typeAliases: flat((f) => f.typeAliases),
      imports,
      calls: calls.calls,
      entrypoints: entrypoints.entrypoints,
      entities,
      dbOperations,
      externalCalls: egress.edges,
      components: components.components,
      routes: components.routes,
      errors,
      parseStats: {
        totalFiles: scope.included.length,
        parsedFiles: files.length,
        skippedFiles,
        parseTimeMs: Date.now() - start,
        ...(dbOpResolution ? { dbOpResolution } : {}),
      },
      kotlinStats,
    };
  } finally {
    // Every exit path frees the trees, including a throw from a lane.
    releaseParsedTrees(trees);
  }
}

/**
 * Adapt a `KotlinParsedRepo` to the full `ParsedRepo` the CLI parse → push → DB flow consumes.
 * Every `total*` is the length of the collection it counts; `httpPrefix` is dropped here (not a
 * `ParsedRepo` field — it is applied at link time), exactly as the Swift path does.
 */
export function toFullParsedRepo(
  kotlin: KotlinParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.1.0-kotlin',
): ParsedRepo {
  const stats = kotlin.parseStats;
  return toParsedRepo(
    {
      id: kotlin.id,
      name: kotlin.name,
      path: repoPath,
      type: kotlin.type,
      parsedAt,
      parserId,
      packages: kotlin.packages,
      files: kotlin.files,
      functions: kotlin.functions,
      classes: kotlin.classes,
      interfaces: kotlin.interfaces,
      typeAliases: kotlin.typeAliases,
      enums: kotlin.enums,
      variables: kotlin.variables,
      entrypoints: kotlin.entrypoints,
      entities: kotlin.entities,
      dbOperations: kotlin.dbOperations,
      calls: kotlin.calls,
      imports: kotlin.imports,
      externalCalls: kotlin.externalCalls,
      components: kotlin.components,
      routes: kotlin.routes,
      errors: kotlin.errors,
      stats: {
        totalFiles: stats.totalFiles,
        parsedFiles: stats.parsedFiles,
        skippedFiles: stats.skippedFiles,
        totalImports: kotlin.imports.length,
        parseTimeMs: stats.parseTimeMs,
        kotlin: kotlin.kotlinStats,
        // Same three values as the Kotlin record, in the language-neutral shape every
        // downstream consumer reads (spec D-7: both representations, one computation).
        ...(kotlin.parseStats.dbOpResolution ? { dbOpResolution: kotlin.parseStats.dbOpResolution } : {}),
        callResolution: {
          callSites: kotlin.kotlinStats.callSites,
          resolvedCalls: kotlin.kotlinStats.resolvedCalls,
          outOfScopeCalls: kotlin.kotlinStats.outOfScopeCalls,
        },
      },
    },
    { parserVersion },
  );
}
