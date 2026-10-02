/**
 * Zig substrate — the per-file fact walk and the lane wiring over the shared skeleton.
 *
 * Every lane of the substrate meets here exactly once, in the only order their inputs allow:
 * `build.zig` first (it names the modules an `@import` can resolve to), then one walk per file
 * (BR-18: no lane re-walks a tree), then the import tables every name resolution keys on, then
 * calls / entrypoints / egress / entities+ops / constants on top of them.
 *
 * `interfaces` is the one collection that stays `[]`, by design (LIM-A): Zig has no interface
 * construct. Everything else is a real lane with its own fixture-backed test, and every
 * `stats.total*` is the length of what was emitted — never an estimate. Calls are precision-first
 * (LIM-B): a callee the tiers cannot name is DROPPED; `resolveZigCalls` records seen vs resolved.
 *
 * Shared trees are parsed and released by `parseSubstrate`; `parseZigBuild` frees its own.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassNode, EnumNode, FunctionNode, Package } from '@coredoc/core';
import type { ZigProfile } from '../../types/zig-profile.js';
import { toFileNodes } from '../file-nodes.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import type { Substrate } from '../parse-substrate.js';
import { parseZigBuild } from './zig-build.js';
import { resolveZigCalls } from './zig-callgraph.js';
import { classifyZigConstants } from './zig-constants.js';
import { emitZigDbOps, emitZigEntities } from './zig-dbops.js';
import { type ZigFile, type ZigFileEntry, extractZigFileFacts } from './zig-declarations.js';
import { emitZigEgress } from './zig-egress.js';
import { emitZigEntrypoints } from './zig-entrypoints.js';
import { buildZigImportTables, emitZigImports } from './zig-imports.js';

/** Zig's package manifest. Present at the root of a package; absent in a plain source tree. */
const ZIG_MANIFEST = 'build.zig.zon';

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
 * The Zig substrate. A file that cannot be read is skipped (and reported by the skeleton); a file
 * the grammar only partially understands is still walked, so the declarations outside the error
 * subtree survive (BR-8). No SCIP: Zig has no wired semantic index.
 */
export const zigSubstrate: Substrate<ZigProfile, ZigFile> = {
  language: 'zig',
  parserVersion: '1.1.1-zig',
  grammar: 'zig',
  scope: (profile, root) =>
    discoverZigFileScope(
      root,
      profile.substrate.include ?? [],
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    ),

  async extract({ root, name, profile, idGen, files: trees, skipped }) {
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
    const index = buildZigImportTables(files, build, new Set([...trees.map((t) => t.relPath), ...skipped]));
    const imports = emitZigImports(files, index, idGen);
    const callResolution = resolveZigCalls(files, index, idGen);
    const entrypoints = emitZigEntrypoints(files, build, idGen);
    const externalCalls = emitZigEgress(files, idGen);
    const entities = emitZigEntities(files, idGen, profile.dbOperations?.methods);
    const dbOps = emitZigDbOps(files, entities, idGen, profile.dbOperations?.methods);
    const { variables, typeAliases } = classifyZigConstants(files, index, idGen);

    // One root package: `build.zig.zon` is the manifest unit AND the module root; `build.zig`
    // names modules but not their file sets, so splitting packages per module is out (LIM-E).
    const rootPackageId = idGen.packageId('.');
    const manifestFile = existsSync(join(root, ZIG_MANIFEST)) ? ZIG_MANIFEST : undefined;
    const rootPackage: Package = { id: rootPackageId, name, path: '.', language: 'zig' };
    if (manifestFile) rootPackage.manifestFile = manifestFile;

    return {
      type: profile.repoType ?? 'library',
      packages: [rootPackage],
      files: toFileNodes(trees, idGen, {
        language: 'zig',
        commentPrefix: '//',
        packageIdFor: () => rootPackageId,
      }),
      functions,
      classes,
      // LIM-A: Zig has no interface construct — the vtable-struct idiom is a plain struct and is
      // already emitted as a class, so `interfaces` is left to default to [].
      enums,
      variables,
      typeAliases,
      imports,
      calls: callResolution.calls,
      entrypoints,
      entities,
      dbOperations: dbOps.dbOperations,
      externalCalls,
      stats: {
        callResolution: {
          callSites: callResolution.callSites,
          resolvedCalls: callResolution.resolved,
          outOfScopeCalls: callResolution.outOfScope,
        },
        dbOpResolution: dbOps.stats,
      },
    };
  },
};
