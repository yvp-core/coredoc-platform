/**
 * Python repo parser — assembles a linker-ready `ParsedRepoLike` plus the intra-repo
 * `entities`/`dbOperations`/`calls` facts from the generic Python extractors. All
 * extraction is generic Python; per-repo TUNING comes from an optional PythonProfile
 * (globs, ORM base classes, route-table locations, task decorators, HTTP-client modules).
 * The cross-repo linker reads only the `ParsedRepoLike` subset — entities/db-ops/calls
 * never affect cross-repo edges.
 *
 * Tree-sitter extraction always works; an optional compiler index enriches internal calls.
 *
 * Each `.py` file is parsed ONCE (single cached Parser instance in python-cst) and its CST
 * root is reused across every extractor — never re-parsed per concern.
 */
import type { AnalysisRecord } from '@coredoc/core';
import { loadOptionalScip } from '../../facts/scip/source-manifest.js';
import { optionalAnalysis } from '../../facts/scip/index-host.js';
import { mergeScipCallFacts } from '../../facts/scip/call-facts.js';
import { pythonScipCallFacts } from './scip-calls.js';
import { runScipPython } from './scip-run.js';
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
  type ImportEdge,
  type Package,
  type ParseError,
  type ParsedRepo,
  type ParsedRepoLike,
  type RepoType,
  StableIdGenerator,
} from '@coredoc/core';
import { releaseParsedTrees } from '../../tree-sitter/tree-release.js';
import type { PythonProfile } from '../../types.js';
import { indexPythonDefs, resolvePythonCalls } from './python-callgraph.js';
import { extractPythonClasses } from './python-classes.js';
import { DEFAULT_PY_INCLUDES, type PythonFile, discoverPythonFiles, parsePython } from './python-cst.js';
import { extractPythonDbOps } from './python-dbops.js';
import { extractPythonEgress } from './python-egress.js';
import { extractPythonEntities } from './python-entities.js';
import { extractPythonEntrypoints } from './python-entrypoints.js';
import { buildImportTable, buildModuleIndex } from './python-imports.js';
import { extractPythonQueueEdges } from './python-queue.js';
import { detectPythonPackages, toPythonFileNodes, toPythonImportEdges, toPythonPackages } from './python-structure.js';
import { toParsedRepo } from '../to-parsed-repo.js';

export interface ParsePythonRepoOptions {
  /** Gateway prefix from RepoConfig.httpPrefix, propagated to the linker for prefix-aware matching. */
  httpPrefix?: string;
  /** Path-independent hash seed for StableIdGenerator (repoHash = hash(repoKey ?? name)); matches the TS/Ruby/Swift paths. */
  repoKey?: string;
  /** Unused today (no incremental cache for Python yet); accepted for ParseOptions parity. */
  cacheDir?: string;
  scipOutDir?: string;
}

/** In-module parse stats surfaced on the final ParseStats (built here, not via `assemble()`). */
export interface PythonParseStats {
  analysis?: AnalysisRecord;
  totalFiles: number;
  parsedFiles: number;
  skippedFiles: number;
  totalImports: number;
  parseTimeMs: number;
  /** Language-neutral call-resolution counters from the Tier-B pass (spec BR-1/BR-2). */
  callResolution: CallResolutionStats;
  /** Language-neutral db-op resolution counters from the ORM + raw-SQL lanes (spec BR-4). */
  dbOpResolution: DbOpResolutionStats;
}

/** The Python parser's full output — the linker reads only the ParsedRepoLike subset. */
export interface PythonParsedRepo extends ParsedRepoLike {
  entities: EntityNode[];
  dbOperations: DbOperation[];
  calls: CallEdge[];
  /** Structure nodes the rest of the graph joins on (G1): one per parsed file / distribution root. */
  packages: Package[];
  files: FileNode[];
  /** One node per `class_definition` — the target of every method's `classId`. */
  classes: ClassNode[];
  /** One edge per (file, imported module). */
  imports: ImportEdge[];
  /** One entry per file that could not be read or parsed — surfaced, not merely counted. */
  errors: ParseError[];
  /** Carrier for the in-module stats (toFullParsedRepo folds these into ParseStats). */
  parseStats: PythonParseStats;
}

/**
 * Parse a Python repo on disk into a `PythonParsedRepo`. Without a profile the defaults
 * reproduce generic Django/DRF/Celery behaviour (urls.py routes, shared_task events,
 * requests/httpx/aiohttp egress, Tier-B calls, no entities). Entity/db-op extraction runs
 * only when the profile declares `entities` (mirrors ruby/swift — else the language-neutral
 * entities-but-0-dbops red flag would be N/A anyway).
 */
export async function parsePythonRepo(
  root: string,
  name: string,
  opts: ParsePythonRepoOptions = {},
  profile?: PythonProfile,
): Promise<PythonParsedRepo> {
  const start = Date.now();
  // One id generator for the whole repo — the two-ID invariant's single seed
  // (repoHash = hash(repoKey ?? name)), exactly like the TS/Ruby/Swift paths.
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);

  const include = profile?.substrate.include ?? DEFAULT_PY_INCLUDES;
  const exclude = profile?.substrate.exclude ?? [];
  const relPaths = discoverPythonFiles(root, include, exclude, profile?.substrate.excludeDefaults);

  // Parse each file exactly once; every extractor reuses the shared CST root.
  const files: PythonFile[] = [];
  const skippedFiles: string[] = [];
  for (const relPath of relPaths) {
    let source: string;
    try {
      source = readFileSync(`${root}/${relPath}`, 'utf-8');
    } catch {
      skippedFiles.push(relPath);
      continue;
    }
    try {
      const rootNode = await parsePython(source);
      files.push({ relPath, source, root: rootNode });
    } catch {
      // tree-sitter tolerates syntax errors (emits ERROR nodes, never throws) and utf-8 decode is
      // lenient (invalid bytes become U+FFFD, no throw) — so this catch only fires on an unexpected
      // parser/WASM failure. The file is dropped and counted (never crashing the whole run).
      skippedFiles.push(relPath);
    }
  }

  // Structure (G1): packages → files. Emitted BEFORE the code lanes because every FunctionNode's
  // `fileId` and every EntityNode's `fileId` is minted from the same `idGen.fileId(relPath)`, so
  // these are the nodes those references have always pointed at.
  const workspacePackages = detectPythonPackages(root, name, relPaths);
  const packages = toPythonPackages(root, workspacePackages, idGen);
  const fileNodes = toPythonFileNodes(files, workspacePackages, idGen);

  // Def index + a FunctionNode for every def (Lane A / step 4).
  const index = indexPythonDefs(files, idGen);
  const fnById = new Map<string, FunctionNode>(index.byId);

  // One ClassNode per class_definition — the target of every method's `classId`.
  const classes = extractPythonClasses(files, index, idGen);

  // Entrypoints (Lane B / step 5): Django/DRF routes → http; Celery task decorators → event.
  const entrypoints: Entrypoint[] = extractPythonEntrypoints(files, idGen, {
    routeFileGlobs: profile?.entrypoints?.djangoRoutes?.routeFileGlobs,
    taskDecorators: profile?.entrypoints?.queue?.taskDecorators,
  });

  // Intra-repo DB facts (Lane C / step 6). These run UNCONDITIONALLY, like entrypoints and
  // calls: `PythonProfile` documents every knob as optional with a code-level default so that
  // "a bare `{ parserId, substrate }` profile parses a Django/DRF/Celery repo out of the box",
  // and gating on the presence of the `entities` key contradicted that — omitting it yielded
  // zero entities AND zero db-ops with no error, the silent hole this substrate is meant to
  // avoid. Absence now means "use the default base classes", not "opt out".
  // Emit db-ops alongside entities so the language-neutral entities-but-0-dbops red flag
  // stays clear (spec S6).
  let dbOperations: DbOperation[] = [];
  let dbOpResolution: DbOpResolutionStats;
  const { entities, entityIdByName } = extractPythonEntities(files, {
    idGen,
    baseClasses: profile?.entities?.baseClasses ?? ['models.Model'],
    orm: profile?.entities?.orm ?? 'django',
  });
  {
    const entityNames = new Set(entities.map((e) => e.name));
    const dres = extractPythonDbOps(files, entityNames, entityIdByName, {
      idGen,
      methods: profile?.dbOperations?.methods,
      rawQueries: profile?.dbOperations?.rawQueries,
    });
    dbOperations = dres.dbOperations;
    dbOpResolution = dres.stats;
    // The db-op performers are a subset of defs; add any not already in the call-graph index
    // (index nodes win — they carry real endLine/params). Merged by canonical id.
    for (const f of dres.functions) if (!fnById.has(f.id)) fnById.set(f.id, f);
  }

  // Egress (Lane D / step 8): outbound HTTP-client call sites → ExternalCallEdge (serviceName='').
  const externalCalls: ExternalCallEdge[] = extractPythonEgress(files, idGen, {
    clientModules: profile?.egress?.clientModules,
  });

  // CALLS — Tier-B call graph (Lane A / step 7, already precision-filtered to SHIPPABLE_PROVENANCE)
  // merged with Celery producer→consumer queue edges (Lane B / step 8b). Deduped by edge id; both
  // sources already drop self-edges.
  const taskDecorators = profile?.entrypoints?.queue?.taskDecorators;
  const callsById = new Map<string, CallEdge>();
  const basicCalls = resolvePythonCalls(files, index, idGen);
  const enhanced = await optionalAnalysis(
    'python',
    files.length ? profile?.substrate.analysis : { mode: 'basic' },
    () => runScipPython(root, { outDir: opts.scipOutDir ?? opts.cacheDir }),
    (path) =>
      mergeScipCallFacts(loadOptionalScip(path), pythonScipCallFacts(files, idGen), basicCalls.calls, basicCalls.stats),
  ).catch((error) => {
    releaseParsedTrees(files);
    throw error;
  });
  const { calls: resolvedCalls, stats: callResolution } = enhanced.result ?? basicCalls;
  for (const e of resolvedCalls) callsById.set(e.id, e);
  for (const e of extractPythonQueueEdges(files, idGen, { taskDecorators })) {
    if (e.callerId !== e.calleeId) callsById.set(e.id, e);
  }
  const calls: CallEdge[] = [...callsById.values()];

  const functions: FunctionNode[] = [...fnById.values()];

  // Imports (G1) + observability (T7): one pass builds BOTH the emitted ImportEdges and the
  // unresolved-dynamic-site counters, so the table is built once per file rather than twice.
  const moduleIndex = buildModuleIndex(files);
  const imports: ImportEdge[] = [];
  let droppedDynamic = 0;
  for (const f of files) {
    const t = buildImportTable(f);
    droppedDynamic += t.droppedDynamic;
    imports.push(...toPythonImportEdges(f, t, moduleIndex, idGen));
  }
  if (skippedFiles.length > 0 || droppedDynamic > 0) {
    // Name only what is actually counted: `getattr` is ordinary attribute access and is
    // deliberately NOT counted by buildImportTable (969 sites on posthog contributed 0), so
    // listing it here described a number the code never produces.
    console.warn(
      `[coredoc] python ${name}: ${skippedFiles.length} file(s) skipped; ` +
        `${droppedDynamic} dynamic import site(s) unresolved (star-import/importlib/__import__ — a Tier-B gap).`,
    );
  }
  console.log(`[coredoc] python ${name}: ${enhanced.analysis.mode} analysis.`);

  const parsed: PythonParsedRepo = {
    id: idGen.getRepoHash(),
    name,
    entrypoints,
    externalCalls,
    functions,
    calls,
    type: 'backend',
    httpPrefix: opts.httpPrefix,
    entities,
    dbOperations,
    packages,
    files: fileNodes,
    classes,
    imports,
    // Every file that failed to parse or read is reported as a ParseError, not just counted:
    // `stats.skippedFiles` is invisible to the scorecard's silent-failure detector and to the
    // CLI's `parseErrors` gauge, both of which read `repo.errors`. Without this a run where
    // every file failed reports zero errors and scores as a clean parse.
    errors: skippedFiles.map((file) => ({
      file,
      message: 'python: file could not be read or parsed',
      severity: 'error' as const,
    })),
    parseStats: {
      totalFiles: relPaths.length,
      parsedFiles: files.length,
      skippedFiles: skippedFiles.length,
      // The EMITTED edge count, so `stats.totalImports` and `imports[]` can never disagree
      // (a per-binding count would over-report `from a import x, y` as two dependencies on `a`).
      totalImports: imports.length,
      parseTimeMs: Date.now() - start,
      callResolution,
      analysis: enhanced.analysis,
      dbOpResolution,
    },
  };

  // Free the WASM-side trees now that every lane has run and `parsed` holds only plain data.
  // web-tree-sitter never garbage-collects trees and its heap is hard-capped at 2GB, so
  // retaining one root per file across a large repo (or across targets in a multi-target run)
  // is what aborts the process with `Aborted()`.
  releaseParsedTrees(files);
  return parsed;
}

/**
 * Adapt a `PythonParsedRepo` to a full `ParsedRepo` for the CLI parse → push → DB flow. `stats`
 * is built here in-module from the parser's own `parseStats` (NOT via `assemble()`);
 * `httpPrefix` is dropped (not a `ParsedRepo` field; applied at link time).
 *
 * Packages/files/classes/imports now come THROUGH from the parser (G1). The collections that
 * remain empty are the ones Python has no construct for (`interfaces`, `typeAliases`, `enums` —
 * an `Enum` subclass is a class, and is emitted as one) plus `variables`, which no Python lane
 * extracts today: emitting an empty array is the honest report of that, not a placeholder for a
 * lane that exists.
 */
export function toFullParsedRepo(
  py: PythonParsedRepo,
  repoPath: string,
  parserId: string,
  parsedAt: string,
  parserVersion = '1.2.0-python',
): ParsedRepo {
  const functions = py.functions ?? [];
  const calls = py.calls ?? [];
  const classes = py.classes;
  const s = py.parseStats;
  return toParsedRepo(
    {
      id: py.id,
      name: py.name,
      path: repoPath,
      type: (py.type as RepoType | undefined) ?? 'backend',
      parsedAt,
      parserId,
      packages: py.packages,
      files: py.files,
      functions,
      classes,
      entrypoints: py.entrypoints,
      entities: py.entities,
      dbOperations: py.dbOperations,
      calls,
      imports: py.imports,
      externalCalls: py.externalCalls,
      // Carried through so the coverage scorecard's silent-failure detector and the CLI's
      // `parseErrors` gauge (both read `repo.errors`) can see a parse that produced nothing.
      errors: py.errors,
      stats: {
        totalFiles: s.totalFiles,
        parsedFiles: s.parsedFiles,
        skippedFiles: s.skippedFiles,
        totalImports: s.totalImports,
        parseTimeMs: s.parseTimeMs,
        callResolution: s.callResolution,
        dbOpResolution: s.dbOpResolution,
        analysis: s.analysis,
      },
    },
    { parserVersion },
  );
}
