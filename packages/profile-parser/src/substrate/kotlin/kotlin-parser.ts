/**
 * Kotlin/Android substrate — the one place every Kotlin lane meets.
 *
 * Order is forced by the lanes' inputs: discover → one parse+walk per file (no lane re-walks a
 * tree) → the FQCN index → the Gradle layout (module roots, manifests, navigation, layouts) →
 * imports → calls → egress → entities/db-ops (both gated on `profile.entities`, the Swift rule)
 * → entrypoints → components/routes. The shared parse and the tree release belong to
 * `parseSubstrate`.
 *
 * A file whose tree has `ERROR` nodes is still walked and everything outside the error subtree
 * survives.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DbOpResolutionStats,
  type DbOperation,
  type EntityNode,
  type KotlinParseStats,
  type Package,
  type ParseError,
  type StableIdGenerator,
} from '@coredoc/core';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import type { KotlinProfile } from '../../types/kotlin-profile.js';
import { toFileNodes } from '../file-nodes.js';
import { type SourceFileScope, applySourceFileScope } from '../source-file-scope.js';
import { resolveKotlinCalls } from './kotlin-callgraph.js';
import { extractKotlinComponents } from './kotlin-components.js';
import { extractKotlinDbOps } from './kotlin-dbops.js';
import { type KotlinFile, type KotlinFileFacts, extractKotlinFileFacts } from './kotlin-declarations.js';
import { extractKotlinEgress } from './kotlin-egress.js';
import { extractKotlinEntities } from './kotlin-entities.js';
import { extractKotlinEntrypoints, resolveAndroidBases } from './kotlin-entrypoints.js';
import { discoverGradleLayout, findSettingsFile, moduleBuildFile } from './kotlin-gradle.js';
import { buildKotlinImportEdges } from './kotlin-imports.js';
import { type AndroidManifestFacts, type NavGraphFacts, readManifest, readNavigationGraph } from './kotlin-xml.js';
import { KotlinTypeIndex } from './kotlin-resolve.js';
import type { Substrate } from '../parse-substrate.js';
import { repoDir } from '../glob.js';

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
    const dir = repoDir(f.relPath);
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
  const appDirs = new Set(manifests.filter((m) => m.hasApplication).map((m) => repoDir(m.filePath)));
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

/** The Kotlin/Android substrate. No SCIP: every collection comes from the tree-sitter CST. */
export const kotlinSubstrate: Substrate<KotlinProfile, KotlinFile> = {
  language: 'kotlin',
  parserVersion: '1.1.1-kotlin',
  grammar: 'kotlin',
  scope: (profile, root) =>
    discoverKotlinFileScope(root, profile.substrate.include ?? [], profile.substrate.exclude ?? []),

  async extract({ root, name, profile, idGen, files: trees }) {
    // The Gradle layout reads build files, manifests and resources outside the `.kt` scope.
    const allFiles = enumerateRepoFiles(root);
    const scope = kotlinScope(allFiles, profile.substrate.include ?? [], profile.substrate.exclude ?? []);

    const errors: ParseError[] = [];
    // A parser message is repo-controlled text that reaches a terminal and a stored snapshot:
    // control characters are stripped so it cannot move a cursor or inject an escape sequence.
    const warn = (file: string, message: string) =>
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0/C1 to strip them.
      errors.push({ file, message: message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), severity: 'warning' });

    const koinAccessors = profile.di?.koin?.accessors;
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
    const egress = extractKotlinEgress(facts, index, idGen, { verbAnnotations: profile.egress?.verbAnnotations });

    // Entities and db-ops are gated together on the profile's `entities` block (the Swift rule):
    // emitting entities without operations would trip the language-neutral red flag.
    let entities: EntityNode[] = [];
    let dbOperations: DbOperation[] = [];
    let unparsedDaoQueries = 0;
    // Absent = not measured: with no `entities` block neither db-op lane ran.
    let dbOpResolution: DbOpResolutionStats | undefined;
    if (profile.entities) {
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

    const bases = resolveAndroidBases(profile.android);
    const entrypoints = extractKotlinEntrypoints({ facts, index, bases, manifests, idGen });
    const components = extractKotlinComponents({
      facts,
      index,
      bases,
      idGen,
      navGraphs,
      layoutFiles: layout.layoutFiles,
    });

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
      type: profile.repoType ?? 'mobile',
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
      stats: {
        kotlin: kotlinStats,
        // Same three values as the Kotlin record, in the language-neutral shape every
        // downstream consumer reads (spec D-7: both representations, one computation).
        ...(dbOpResolution ? { dbOpResolution } : {}),
        callResolution: {
          callSites: kotlinStats.callSites,
          resolvedCalls: kotlinStats.resolvedCalls,
          outOfScopeCalls: kotlinStats.outOfScopeCalls,
        },
      },
    };
  },
};
