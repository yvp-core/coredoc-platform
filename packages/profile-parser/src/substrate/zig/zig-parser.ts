/**
 * Zig repo parser — discovery, the per-file fact walk, and `ParsedRepo` assembly.
 *
 * Every lane of the substrate meets here exactly once, in the only order their inputs allow:
 * `build.zig` first (it names the modules an `@import` can resolve to), then one walk per file
 * (BR-18: no lane re-walks a tree), then the import tables every name resolution keys on, then
 * calls / entrypoints / egress / entities+ops / constants on top of them.
 *
 * `interfaces` is the one collection that stays `[]`, by design (LIM-A): Zig has no interface
 * construct. Everything else is a real lane with its own fixture-backed test, and every
 * `stats.total*` is the length of what was emitted — never an estimate. Calls are precision-first
 * (LIM-B): a callee the tiers cannot name is DROPPED, so `callStats` records seen vs resolved.
 *
 * The parsed trees are released only after the LAST lane has read them: web-tree-sitter never
 * collects a tree and its heap is capped at 2 GB, but a lane reading a released tree is a
 * use-after-free, so `releaseParsedTrees` runs in a `finally` around every lane — a throw in
 * one of them must not leak a whole repo's trees into the 2 GB heap.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CallEdge,
  type CallResolutionStats,
  type DbOpResolutionStats,
  type ClassNode,
  type DbOperation,
  type EntityNode,
  type Entrypoint,
  type EnumNode,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type ImportEdge,
  type Package,
  type ParsedRepo,
  type RepoType,
  StableIdGenerator,
  type TypeAliasNode,
  type VariableNode,
} from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import type { ZigProfile } from '../../types/zig-profile.js';
import { toFileNodes } from '../file-nodes.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { parseZigBuild } from './zig-build.js';
import { resolveZigCalls } from './zig-callgraph.js';
import { classifyZigConstants } from './zig-constants.js';
import { emitZigDbOps, emitZigEntities } from './zig-dbops.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts, toZigFile } from './zig-declarations.js';
import { emitZigEgress } from './zig-egress.js';
import { emitZigEntrypoints } from './zig-entrypoints.js';
import { buildZigImportTables, emitZigImports } from './zig-imports.js';
import { toParsedRepo } from '../to-parsed-repo.js';

/** Zig's package manifest. Present at the root of a package; absent in a plain source tree. */
const ZIG_MANIFEST = 'build.zig.zon';

export interface ParseZigRepoOptions {
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)). */
  repoKey?: string;
  /** Unused today (no incremental cache for Zig yet); accepted for ParseOptions parity. */
  cacheDir?: string;
}

/** The Zig parser's output — the subset of `ParsedRepo` this substrate populates. */
export interface ZigParsedRepo {
  id: string;
  name: string;
  type: RepoType;
  packages: Package[];
  files: FileNode[];
  functions: FunctionNode[];
  classes: ClassNode[];
  enums: EnumNode[];
  variables: VariableNode[];
  typeAliases: TypeAliasNode[];
  imports: ImportEdge[];
  calls: CallEdge[];
  entrypoints: Entrypoint[];
  entities: EntityNode[];
  dbOperations: DbOperation[];
  externalCalls: ExternalCallEdge[];
  parseStats: {
    totalFiles: number;
    parsedFiles: number;
    skippedFiles: number;
    parseTimeMs: number;
  };
  /**
   * Call-resolution record (LIM-B). Zig-side only: `ParsedRepo` has no home for it, and the
   * invariant suite is the consumer that has to show how much of the call graph survived.
   */
  callStats: { seen: number; resolved: number; byTier: Record<string, number> };
  /**
   * The same measurement in the language-neutral shape `ParseStats.callResolution` carries,
   * so the graph reports in-repo call resolution for Zig like every other substrate.
   */
  callResolution: CallResolutionStats;
  /**
   * The db-op resolution record (BR-4), carried beside `callResolution` for the same reason:
   * the in-module `parseStats` has no home for it, and `toFullParsedRepo` folds it into
   * `ParseStats`.
   */
  dbOpResolution: DbOpResolutionStats;
}

/**
 * Built-in default excludes for Zig repos. These SHIP in code (a profile's `exclude` EXTENDS
 * them; `excludeDefaults: false` opts out entirely), exactly as `DEFAULT_RS_EXCLUDES` does.
 *
 * `build.zig` is a BUILD SCRIPT, not a source file: its `pub fn build` is not an entrypoint, its
 * `b.addExecutable` calls are not repo calls, and leaving it in scope also makes it an `@import`
 * target. `parseZigBuild` still reads it (root only), which is the only thing it is for.
 * `zig-out/` and the two cache directory spellings are build output and are NOT in the shared
 * enumerator's ignore floor.
 */
export const DEFAULT_ZIG_EXCLUDES: string[] = ['build.zig', '**/zig-out/**', '**/.zig-cache/**', '**/zig-cache/**'];

/** The scorer- and parser-facing source scope: git-aware discovery + the profile's globs. */
export const discoverZigFileScope = makeFileScopeDiscoverer({
  extensions: ['.zig'],
  defaultInclude: ['**/*.zig'],
  defaultExclude: DEFAULT_ZIG_EXCLUDES,
});

/**
 * Parse a Zig repo on disk. A file that cannot be read is counted in `skippedFiles` and
 * skipped; a file the grammar only partially understands is still walked, so the
 * declarations outside the error subtree survive (BR-8).
 */
export async function parseZigRepo(
  root: string,
  name: string,
  opts: ParseZigRepoOptions = {},
  profile?: ZigProfile,
): Promise<ZigParsedRepo> {
  const start = Date.now();
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);

  const scope = discoverZigFileScope(
    root,
    profile?.substrate.include ?? [],
    profile?.substrate.exclude,
    profile?.substrate.excludeDefaults,
  );

  const trees: ZigFile[] = [];
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
      trees.push(await toZigFile(relPath, source));
    }

    const files: ZigFileEntry[] = trees.map((tree) => ({
      relPath: tree.relPath,
      facts: extractZigFileFacts(tree, idGen),
    }));

    const classes: ClassNode[] = [];
    const enums: EnumNode[] = [];
    const functions: FunctionNode[] = [];
    for (const { facts } of files) {
      classes.push(...facts.decls.classes);
      enums.push(...facts.decls.enums);
      functions.push(...facts.decls.functions);
    }

    const build = await parseZigBuild(root);
    const index = buildZigImportTables(files, build, new Set(scope.included));
    const imports = emitZigImports(files, index, idGen);
    const callResolution = resolveZigCalls(files, index, idGen);
    const entrypoints = emitZigEntrypoints(files, build, idGen);
    const externalCalls = emitZigEgress(files, idGen);
    const entities = emitZigEntities(files, idGen, profile?.dbOperations?.methods);
    const dbOps = emitZigDbOps(files, entities, idGen, profile?.dbOperations?.methods);
    const dbOperations = dbOps.dbOperations;
    const { variables, typeAliases } = classifyZigConstants(files, index, idGen);

    // One root package: `build.zig.zon` is the manifest unit AND the module root; `build.zig`
    // names modules but not their file sets, so splitting packages per module is out (LIM-E).
    const rootPackageId = idGen.packageId('.');
    const manifestFile = existsSync(join(root, ZIG_MANIFEST)) ? ZIG_MANIFEST : undefined;
    const rootPackage: Package = { id: rootPackageId, name, path: '.', language: 'zig' };
    if (manifestFile) rootPackage.manifestFile = manifestFile;

    // Last read of a tree: every lane above has already taken what it needs.
    const fileNodes = toFileNodes(trees, idGen, {
      language: 'zig',
      commentPrefix: '//',
      packageIdFor: () => rootPackageId,
    });

    return {
      id: idGen.getRepoHash(),
      name,
      type: profile?.repoType ?? 'library',
      packages: [rootPackage],
      files: fileNodes,
      functions,
      classes,
      enums,
      variables,
      typeAliases,
      imports,
      calls: callResolution.calls,
      entrypoints,
      entities,
      dbOperations,
      externalCalls,
      parseStats: {
        totalFiles: scope.included.length,
        parsedFiles: fileNodes.length,
        skippedFiles,
        parseTimeMs: Date.now() - start,
      },
      callStats: { seen: callResolution.seen, resolved: callResolution.resolved, byTier: callResolution.byTier },
      callResolution: {
        callSites: callResolution.callSites,
        resolvedCalls: callResolution.resolved,
        outOfScopeCalls: callResolution.outOfScope,
      },
      dbOpResolution: dbOps.stats,
    };
  } finally {
    // Every exit path frees the trees — including a throw from a lane or from `toZigFile`,
    // which would otherwise strand this repo's trees in the 2 GB web-tree-sitter heap.
    releaseParsedTrees(trees);
  }
}

/**
 * Adapt a `ZigParsedRepo` to the full `ParsedRepo` the CLI parse → push → DB flow consumes.
 * Every stat is the length of the collection it counts.
 */
export function toFullParsedRepo(
  zig: ZigParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.1.0-zig',
): ParsedRepo {
  const stats = zig.parseStats;
  return toParsedRepo(
    {
      id: zig.id,
      name: zig.name,
      path: repoPath,
      type: zig.type,
      parsedAt,
      parserId,
      packages: zig.packages,
      files: zig.files,
      functions: zig.functions,
      classes: zig.classes,
      // LIM-A: Zig has no interface construct — the vtable-struct idiom is a plain struct and is
      // already emitted as a class, so `interfaces` is left to default to [].
      typeAliases: zig.typeAliases,
      enums: zig.enums,
      variables: zig.variables,
      entrypoints: zig.entrypoints,
      entities: zig.entities,
      dbOperations: zig.dbOperations,
      calls: zig.calls,
      imports: zig.imports,
      externalCalls: zig.externalCalls,
      stats: {
        totalFiles: stats.totalFiles,
        parsedFiles: stats.parsedFiles,
        skippedFiles: stats.skippedFiles,
        totalImports: zig.imports.length,
        parseTimeMs: stats.parseTimeMs,
        callResolution: zig.callResolution,
        dbOpResolution: zig.dbOpResolution,
      },
    },
    { parserVersion },
  );
}
