/**
 * Swift/iOS repo parser — assembles a linker-ready `ParsedRepoLike` plus the intra-repo
 * `entities`/`dbOperations`/`calls` facts from the generic Swift extractors. All extraction
 * is generic Swift; per-repo TUNING comes from an optional SwiftProfile (globs, ORM base
 * classes, the API-protocol names, the DI container accessor). The cross-repo linker reads
 * only the `ParsedRepoLike` subset — entities/db-ops/calls never affect cross-repo edges.
 *
 * Tier-B only: tree-sitter CST, no SCIP. Never throws on a missing semantic index (there is
 * none for Swift). Frontend concepts (SwiftUI components/routes/stateStores) and iOS
 * entrypoints are a deferred follow-up increment — `entrypoints` is empty here.
 */
import { readFileSync } from 'node:fs';
import {
  type CallEdge,
  type CallResolutionStats,
  type ClassNode,
  type DbOperation,
  type DbOpResolutionStats,
  type EntityNode,
  type Entrypoint,
  type ExternalCallEdge,
  type FileNode,
  type FunctionNode,
  type Package,
  type ParsedRepo,
  type ParsedRepoLike,
  type RepoType,
  StableIdGenerator,
} from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import type { SwiftProfile } from '../../types.js';
import { makeFileScopeDiscoverer } from '../cst-kit/file-scope.js';
import { type SwiftFile, indexSwiftDefs, parseDiContainer, resolveSwiftCalls } from './swift-callgraph.js';
import { PROTOCOL_DECL, TYPE_CONTAINERS, type TsNode, declKind, parseSwift, typeName } from './swift-cst.js';
import { extractSwiftDbOps } from './swift-dbops.js';
import { extractSwiftEgress } from './swift-egress.js';
import { extractSwiftEntities } from './swift-entities.js';
import { toParsedRepo } from '../to-parsed-repo.js';

export interface ParseSwiftRepoOptions {
  /** Gateway prefix from RepoConfig.httpPrefix, propagated to the linker for prefix-aware matching. */
  httpPrefix?: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)); matches the TS/Ruby paths. */
  repoKey?: string;
  /** Unused today (no incremental cache for Swift yet); accepted for ParseOptions parity. */
  cacheDir?: string;
}

/** The Swift parser's full output — the linker reads only the ParsedRepoLike subset. */
export interface SwiftParsedRepo extends ParsedRepoLike {
  entities: EntityNode[];
  dbOperations: DbOperation[];
  calls: CallEdge[];
  packages: Package[];
  files: FileNode[];
  classes: ClassNode[];
  parseStats: {
    totalFiles: number;
    parsedFiles: number;
    skippedFiles: number;
    parseTimeMs: number;
    /** In-repo call resolution over the enumerated Tier-B sites (BR-2, LIM-6). */
    callResolution?: CallResolutionStats;
    /** In-repo db-op resolution over the enumerated op sites (BR-4). Absent = lane not run. */
    dbOpResolution?: DbOpResolutionStats;
  };
}

/** One Swift source file, owned by the shared repo-root package. */
function toSwiftFileNode(file: SwiftFile, packageId: string, idGen: StableIdGenerator): FileNode {
  const contentHash = idGen.contentHash(file.source);
  return {
    id: idGen.fileId(file.relPath),
    versionedId: idGen.versionedFileId(file.relPath, contentHash),
    path: file.relPath,
    extension: '.swift',
    packageId,
    language: 'swift',
    contentHash,
    loc: file.source.split('\n').filter((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//');
    }).length,
  };
}

interface SwiftClassFacts {
  name: string;
  relPath: string;
  nodes: TsNode[];
  protocol: boolean;
}

/** Whether a type declaration is visible outside its Swift module. */
function isExportedType(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const modifiers = node.child(i);
    if (modifiers?.type !== 'modifiers') continue;
    for (let j = 0; j < modifiers.childCount; j++) {
      const modifier = modifiers.child(j);
      if (modifier && modifier.type !== 'attribute' && /\b(public|open)\b/.test(modifier.text as string)) return true;
    }
  }
  return false;
}

/**
 * Emit the method-bearing facet of every Swift type referenced by `FunctionNode.classId`.
 * Extensions in another file intentionally get a file-local class node: that is the same
 * Tier-B identity the function lane already mints without a semantic cross-file index.
 */
function extractSwiftClasses(files: SwiftFile[], functions: FunctionNode[], idGen: StableIdGenerator): ClassNode[] {
  const methodsByClass = new Map<string, string[]>();
  for (const fn of functions) {
    if (fn.kind !== 'method' || fn.classId === undefined) continue;
    const methods = methodsByClass.get(fn.classId) ?? [];
    methods.push(fn.id);
    methodsByClass.set(fn.classId, methods);
  }

  const factsById = new Map<string, SwiftClassFacts>();
  for (const { relPath, root } of files) {
    for (const containerType of TYPE_CONTAINERS) {
      for (const node of root.descendantsOfType(containerType) as TsNode[]) {
        const name = typeName(node);
        if (!name) continue;
        const id = idGen.classId(relPath, name);
        if (!methodsByClass.has(id)) continue;
        const facts = factsById.get(id);
        if (facts) {
          facts.nodes.push(node);
          facts.protocol = facts.protocol || node.type === PROTOCOL_DECL;
        } else {
          factsById.set(id, { name, relPath, nodes: [node], protocol: node.type === PROTOCOL_DECL });
        }
      }
    }
  }

  return [...factsById.entries()].map(([id, facts]) => {
    facts.nodes.sort((a, b) => a.startIndex - b.startIndex);
    const declaration = facts.nodes.find((node) => declKind(node) !== 'extension') ?? facts.nodes[0];
    const source = facts.nodes.map((node) => node.text as string).join('\n');
    return {
      id,
      versionedId: idGen.versionedId(id, source),
      name: facts.name,
      kind: 'class',
      fileId: idGen.fileId(facts.relPath),
      isExported: isExportedType(declaration),
      isAbstract: facts.protocol,
      methods: methodsByClass.get(id) ?? [],
      properties: [],
      constructor: undefined,
      location: {
        filePath: facts.relPath,
        startLine: declaration.startPosition.row + 1,
        endLine: declaration.endPosition.row + 1,
      },
    };
  });
}

/** Enumerate `.swift` sources in scope: gitignore-honoring walk + the profile's include/exclude globs. */
export function discoverSwiftFiles(root: string, include: string[], exclude: string[] = []): string[] {
  return discoverSwiftFileScope(root, include, exclude).included;
}

/**
 * The scorer-facing source scope, derived by the same discovery policy as the parser.
 *
 * It takes `excludeDefaults` like every sibling substrate, but this one ships no built-in
 * exclusions, so there is nothing for the opt-out to remove until it does.
 */
export const discoverSwiftFileScope = makeFileScopeDiscoverer({
  extensions: ['.swift'],
  defaultInclude: ['**/*.swift'],
});

/**
 * Parse a Swift/iOS repo on disk into a `SwiftParsedRepo`. Entity/db-op extraction runs when
 * the profile declares `entities` (the ORM base classes); egress + call graph always run.
 */
export async function parseSwiftRepo(
  root: string,
  name: string,
  opts: ParseSwiftRepoOptions = {},
  profile?: SwiftProfile,
): Promise<SwiftParsedRepo> {
  const start = Date.now();
  // One id generator for the whole repo — seeded exactly like the TS/Ruby paths
  // (repoHash = hash(repoKey ?? name)) so Swift IDs are canonical + cross-repo-consistent.
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);

  const include = profile?.substrate.include ?? ['**/*.swift'];
  const exclude = profile?.substrate.exclude ?? [];
  const relPaths = discoverSwiftFiles(root, include, exclude);

  // Parse each file exactly once; every extractor reuses the shared root node.
  const files: SwiftFile[] = [];
  let skippedFiles = 0;
  for (const relPath of relPaths) {
    let source: string;
    try {
      source = readFileSync(`${root}/${relPath}`, 'utf-8');
    } catch {
      skippedFiles++;
      continue;
    }
    files.push({ relPath, source, root: await parseSwift(source) });
  }

  // DI-accessor resolution runs only when the profile declares its container (no hardcoded default).
  const di = parseDiContainer(profile?.di?.containerAccessor);
  const index = indexSwiftDefs(files, idGen, di?.root);

  // Egress — the cross-repo win.
  const externalCalls: ExternalCallEdge[] = extractSwiftEgress(files, idGen, {
    targetTypeProtocols: profile?.egress?.targetTypeProtocols,
  });

  // Intra-repo data facts. Emit db-ops whenever entities are emitted (else the language-neutral
  // entities-but-0-dbops red flag would force a FAIL).
  let entities: EntityNode[] = [];
  let dbOperations: DbOperation[] = [];
  let dbOpResolution: DbOpResolutionStats | undefined;
  if (profile?.entities) {
    const res = extractSwiftEntities(files, {
      idGen,
      baseClasses: profile.entities.baseClasses ?? ['Object'],
      orm: profile.entities.orm,
    });
    entities = res.entities;
    const dbRes = extractSwiftDbOps(files, res.entityIdByName, idGen, {
      opMap: profile.dbOperations?.opMap,
      entityTypealias: profile.dbOperations?.entityTypealias,
      receiverPattern: profile.dbOperations?.receiverPattern,
    });
    dbOperations = dbRes.dbOperations;
    dbOpResolution = dbRes.stats;
  }

  // Tier-B call graph (resolved, high-precision idioms only).
  const callResolution: CallResolutionStats = { callSites: 0, resolvedCalls: 0, outOfScopeCalls: 0 };
  const calls: CallEdge[] = resolveSwiftCalls(files, index, idGen, di, callResolution);

  const functions: FunctionNode[] = [...index.byId.values()];
  const rootPackageId = idGen.packageId('.');
  const packages: Package[] = [{ id: rootPackageId, name, path: '.' }];
  const fileNodes = files.map((file) => toSwiftFileNode(file, rootPackageId, idGen));
  const classes = extractSwiftClasses(files, functions, idGen);
  const entrypoints: Entrypoint[] = []; // deferred to the follow-up increment (step 10)

  // Free the WASM-side trees: every lane has run and the returned repo holds only plain data.
  // web-tree-sitter never garbage-collects trees and its heap is hard-capped at 2GB.
  releaseParsedTrees(files);

  return {
    id: idGen.getRepoHash(),
    name,
    entrypoints,
    externalCalls,
    functions,
    calls,
    type: 'mobile',
    httpPrefix: opts.httpPrefix,
    entities,
    dbOperations,
    packages,
    files: fileNodes,
    classes,
    parseStats: {
      totalFiles: relPaths.length,
      parsedFiles: fileNodes.length,
      skippedFiles,
      parseTimeMs: Date.now() - start,
      callResolution,
      dbOpResolution,
    },
  };
}

/**
 * Adapt a `SwiftParsedRepo` to a full `ParsedRepo` for the CLI parse → push → DB flow. The
 * Swift parser extracts the cross-repo + data-layer facts + the Tier-B call graph and carries
 * its package/file/class structure through so every function reference remains joinable.
 * `httpPrefix` is dropped (not a `ParsedRepo` field; applied at link time).
 */
export function toFullParsedRepo(
  swift: SwiftParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.2.0-swift',
): ParsedRepo {
  const functions = swift.functions ?? [];
  const calls = swift.calls ?? [];
  const classes = swift.classes;
  const stats = swift.parseStats;
  return toParsedRepo(
    {
      id: swift.id,
      name: swift.name,
      path: repoPath,
      type: (swift.type as RepoType | undefined) ?? 'mobile',
      parsedAt,
      parserId,
      packages: swift.packages,
      files: swift.files,
      functions,
      classes,
      entrypoints: swift.entrypoints,
      entities: swift.entities,
      dbOperations: swift.dbOperations,
      calls,
      externalCalls: swift.externalCalls,
      stats: {
        totalFiles: stats.totalFiles,
        parsedFiles: stats.parsedFiles,
        skippedFiles: stats.skippedFiles,
        totalImports: 0,
        parseTimeMs: stats.parseTimeMs,
        callResolution: stats.callResolution,
        dbOpResolution: stats.dbOpResolution,
      },
    },
    { parserVersion },
  );
}
