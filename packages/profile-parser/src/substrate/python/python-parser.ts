/**
 * Python substrate — extracts the structural and intra-repo
 * (`entrypoints`/`entities`/`dbOperations`/`calls`/`externalCalls`) facts from the generic Python
 * extractors. All
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
import type { CallEdge, DbOperation, Entrypoint, ExternalCallEdge, FunctionNode, ImportEdge } from '@coredoc/core';
import type { PythonProfile } from '../../types.js';
import type { Substrate } from '../parse-substrate.js';
import { indexPythonDefs, resolvePythonCalls } from './python-callgraph.js';
import { extractPythonClasses } from './python-classes.js';
import { type PythonFile, discoverPythonFileScope } from './python-cst.js';
import { extractPythonDbOps } from './python-dbops.js';
import { extractPythonEgress } from './python-egress.js';
import { extractPythonEntities } from './python-entities.js';
import { extractPythonEntrypoints } from './python-entrypoints.js';
import { buildImportTable, buildModuleIndex } from './python-imports.js';
import { extractPythonQueueEdges } from './python-queue.js';
import { detectPythonPackages, toPythonFileNodes, toPythonImportEdges, toPythonPackages } from './python-structure.js';
import { pythonScipCallFacts } from './scip-calls.js';
import { runScipPython } from './scip-run.js';

/**
 * Without profile tuning the defaults reproduce generic Django/DRF/Celery behaviour (urls.py
 * routes, shared_task events, requests/httpx/aiohttp egress, Tier-B calls, default ORM bases).
 * `variables`/`interfaces`/`typeAliases`/`enums` stay empty: no Python lane extracts them (an
 * `Enum` subclass is a class, and is emitted as one).
 */
export const pythonSubstrate: Substrate<PythonProfile, PythonFile> = {
  language: 'python',
  parserVersion: '1.2.0-python',
  grammar: 'python',
  scope: (profile, root) =>
    discoverPythonFileScope(
      root,
      profile.substrate.include ?? [],
      profile.substrate.exclude ?? [],
      profile.substrate.excludeDefaults,
    ),
  scip: { language: 'python', run: runScipPython, facts: pythonScipCallFacts },

  async extract({ root, name, profile, idGen, files, skipped, enhanceCalls }) {
    // Structure (G1): packages → files. Emitted BEFORE the code lanes because every FunctionNode's
    // `fileId` and every EntityNode's `fileId` is minted from the same `idGen.fileId(relPath)`, so
    // these are the nodes those references have always pointed at.
    // Order-independent (a Set of candidate dirs, sorted), so files + skipped is the full scope.
    const workspacePackages = detectPythonPackages(root, name, [...files.map((f) => f.relPath), ...skipped]);
    const packages = toPythonPackages(root, workspacePackages, idGen);
    const fileNodes = toPythonFileNodes(files, workspacePackages, idGen);

    // Def index + a FunctionNode for every def (Lane A / step 4).
    const index = indexPythonDefs(files, idGen);
    const fnById = new Map<string, FunctionNode>(index.byId);

    // One ClassNode per class_definition — the target of every method's `classId`.
    const classes = extractPythonClasses(files, index, idGen);

    // Entrypoints (Lane B / step 5): Django/DRF routes → http; Celery task decorators → event.
    const entrypoints: Entrypoint[] = extractPythonEntrypoints(files, idGen, {
      routeFileGlobs: profile.entrypoints?.djangoRoutes?.routeFileGlobs,
      taskDecorators: profile.entrypoints?.queue?.taskDecorators,
    });

    // Intra-repo DB facts (Lane C / step 6). These run UNCONDITIONALLY, like entrypoints and
    // calls: `PythonProfile` documents every knob as optional with a code-level default so that
    // "a bare `{ parserId, substrate }` profile parses a Django/DRF/Celery repo out of the box",
    // and gating on the presence of the `entities` key contradicted that — omitting it yielded
    // zero entities AND zero db-ops with no error, the silent hole this substrate is meant to
    // avoid. Absence now means "use the default base classes", not "opt out".
    // Emit db-ops alongside entities so the language-neutral entities-but-0-dbops red flag
    // stays clear (spec S6).
    const { entities, entityIdByName } = extractPythonEntities(files, {
      idGen,
      baseClasses: profile.entities?.baseClasses ?? ['models.Model'],
      orm: profile.entities?.orm ?? 'django',
    });
    const dres = extractPythonDbOps(files, new Set(entities.map((e) => e.name)), entityIdByName, {
      idGen,
      methods: profile.dbOperations?.methods,
      rawQueries: profile.dbOperations?.rawQueries,
    });
    const dbOperations: DbOperation[] = dres.dbOperations;
    const dbOpResolution = dres.stats;
    // The db-op performers are a subset of defs; add any not already in the call-graph index
    // (index nodes win — they carry real endLine/params). Merged by canonical id.
    for (const f of dres.functions) if (!fnById.has(f.id)) fnById.set(f.id, f);

    // Egress (Lane D / step 8): outbound HTTP-client call sites → ExternalCallEdge (serviceName='').
    const externalCalls: ExternalCallEdge[] = extractPythonEgress(files, idGen, {
      clientModules: profile.egress?.clientModules,
    });

    // CALLS — Tier-B call graph (Lane A / step 7, already precision-filtered to SHIPPABLE_PROVENANCE)
    // merged with Celery producer→consumer queue edges (Lane B / step 8b). Deduped by edge id; both
    // sources already drop self-edges.
    const taskDecorators = profile.entrypoints?.queue?.taskDecorators;
    const callsById = new Map<string, CallEdge>();
    const basicCalls = resolvePythonCalls(files, index, idGen);
    const { calls: resolvedCalls, stats: callResolution } = await enhanceCalls(basicCalls);
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
    if (skipped.length > 0 || droppedDynamic > 0) {
      // Name only what is actually counted: `getattr` is ordinary attribute access and is
      // deliberately NOT counted by buildImportTable (969 sites on posthog contributed 0), so
      // listing it here described a number the code never produces.
      console.warn(
        `[coredoc] python ${name}: ${skipped.length} file(s) skipped; ` +
          `${droppedDynamic} dynamic import site(s) unresolved (star-import/importlib/__import__ — a Tier-B gap).`,
      );
    }

    return {
      type: 'backend',
      entrypoints,
      externalCalls,
      functions,
      calls,
      entities,
      dbOperations,
      packages,
      files: fileNodes,
      classes,
      imports,
      stats: { callResolution, dbOpResolution },
    };
  },
};
