// =============================================================================
// mergeParsedRepos — combine per-target ParsedRepos into one repo graph.
//
// Safe by construction: every target parsed the same repo with the same repoKey,
// so all IDs share one repoHash, and node IDs can only collide if two targets
// claimed the same file — exactly the scope-overlap error guarded below.
// =============================================================================
import type { FileNode, Package, ParsedRepo, RepoType } from '@coredoc/core/types';
import { applyIntegrityReport } from '../integrity/referential-integrity.js';

export interface TargetResult {
  name: string;
  repo: ParsedRepo;
}

/** Concatenated optional array — present on the merged repo only when some target emitted it. */
function optional<T>(vals: (T[] | undefined)[]): T[] | undefined {
  const all = vals.filter((v): v is T[] => v !== undefined).flat();
  return all.length > 0 ? all : undefined;
}

/** Sum a set of `Record<string, number>` maps key by key (e.g. Kotlin's per-tier counts). */
function sumByKey(maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Merge per-target unresolved-module tallies, most-frequent first (the per-target contract). */
function mergeUnresolvedModules(lists: { module: string; count: number }[][]): { module: string; count: number }[] {
  const byModule = new Map<string, number>();
  for (const list of lists) for (const m of list) byModule.set(m.module, (byModule.get(m.module) ?? 0) + m.count);
  return [...byModule.entries()]
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
}

export function mergeParsedRepos(
  parserId: string,
  repoType: RepoType | undefined,
  results: TargetResult[],
): ParsedRepo {
  if (results.length === 0) throw new Error('mergeParsedRepos: no target results');
  const first = results[0].repo;
  for (const r of results.slice(1)) {
    if (r.repo.id !== first.id) {
      throw new Error(
        `Target '${r.name}' produced repo id '${r.repo.id}' but '${results[0].name}' produced '${first.id}' — targets must share repoKey/repoName`,
      );
    }
  }

  // Scope-overlap guard: two targets claiming one file would duplicate every node in it.
  // Same pass stamps each file with its owning target's name (multi-target attribution).
  const fileOwner = new Map<string, { target: string; path: string }>();
  const files: FileNode[] = [];
  for (const { name, repo } of results) {
    for (const f of repo.files) {
      const owner = fileOwner.get(f.id);
      if (owner) {
        throw new Error(
          `Targets '${owner.target}' and '${name}' both claimed file '${f.path}' — make their substrate include/exclude globs disjoint`,
        );
      }
      fileOwner.set(f.id, { target: name, path: f.path });
      files.push({ ...f, target: name });
    }
  }

  const repos = results.map((r) => r.repo);
  const analysis = results.flatMap(({ name, repo }) =>
    (repo.stats.analysis ?? []).map((record) => ({ ...record, target: name })),
  );
  const functions = repos.flatMap((r) => r.functions);
  const classes = repos.flatMap((r) => r.classes);
  const interfaces = repos.flatMap((r) => r.interfaces);
  const typeAliases = repos.flatMap((r) => r.typeAliases);
  const enums = repos.flatMap((r) => r.enums);
  const variables = repos.flatMap((r) => r.variables);
  const entrypoints = repos.flatMap((r) => r.entrypoints);
  const entities = repos.flatMap((r) => r.entities);
  const dbOperations = repos.flatMap((r) => r.dbOperations);
  const calls = repos.flatMap((r) => r.calls);
  const imports = repos.flatMap((r) => r.imports);
  const externalCalls = repos.flatMap((r) => r.externalCalls);

  // Packages: every target enumerates the same workspace — de-dupe by id, then
  // attribute each package's dominant language from its merged files (the first
  // place Package.language is populated).
  const packagesById = new Map<string, Package>();
  for (const r of repos) {
    for (const p of r.packages) if (!packagesById.has(p.id)) packagesById.set(p.id, { ...p });
  }
  const langCounts = new Map<string, Map<string, number>>();
  for (const f of files) {
    const m = langCounts.get(f.packageId) ?? new Map<string, number>();
    m.set(f.language, (m.get(f.language) ?? 0) + 1);
    langCounts.set(f.packageId, m);
  }
  for (const p of packagesById.values()) {
    const m = langCounts.get(p.id);
    if (m && p.language === undefined) {
      p.language = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  const sum = (pick: (r: ParsedRepo) => number): number => repos.reduce((acc, r) => acc + pick(r), 0);

  const measured = repos.map((r) => r.stats.callResolution).filter((c) => c !== undefined);
  const callResolution = measured.length
    ? {
        callSites: measured.reduce((a, c) => a + c.callSites, 0),
        resolvedCalls: measured.reduce((a, c) => a + c.resolvedCalls, 0),
        outOfScopeCalls: measured.reduce((a, c) => a + c.outOfScopeCalls, 0),
      }
    : undefined;

  const dbOpMeasured = repos.map((r) => r.stats.dbOpResolution).filter((c) => c !== undefined);
  const dbOpResolution = dbOpMeasured.length
    ? {
        dbOpSites: dbOpMeasured.reduce((a, c) => a + c.dbOpSites, 0),
        boundDbOps: dbOpMeasured.reduce((a, c) => a + c.boundDbOps, 0),
        outOfScopeDbOps: dbOpMeasured.reduce((a, c) => a + c.outOfScopeDbOps, 0),
      }
    : undefined;

  // Per-language diagnostic records. A multi-target profile runs at most one target per
  // language today, but summing keeps the merge total even if that stops being true — and a
  // target that ran no Kotlin/Python pass contributes nothing, exactly as it contributes
  // nothing to `callResolution`.
  const kotlinStats = repos.map((r) => r.stats.kotlin).filter((k) => k !== undefined);
  const kotlin = kotlinStats.length
    ? {
        filesParsed: kotlinStats.reduce((a, k) => a + k.filesParsed, 0),
        filesWithSyntaxErrors: kotlinStats.reduce((a, k) => a + k.filesWithSyntaxErrors, 0),
        callSites: kotlinStats.reduce((a, k) => a + k.callSites, 0),
        resolvedCalls: kotlinStats.reduce((a, k) => a + k.resolvedCalls, 0),
        ambiguousCalls: kotlinStats.reduce((a, k) => a + k.ambiguousCalls, 0),
        outOfScopeCalls: kotlinStats.reduce((a, k) => a + k.outOfScopeCalls, 0),
        byTier: sumByKey(kotlinStats.map((k) => k.byTier)),
        endpointsDefined: kotlinStats.reduce((a, k) => a + k.endpointsDefined, 0),
        egressCallSites: kotlinStats.reduce((a, k) => a + k.egressCallSites, 0),
        entrypointsWithoutHandler: kotlinStats.reduce((a, k) => a + k.entrypointsWithoutHandler, 0),
        unparsedDaoQueries: kotlinStats.reduce((a, k) => a + k.unparsedDaoQueries, 0),
      }
    : undefined;

  const pythonStats = repos.map((r) => r.stats.python).filter((py) => py !== undefined);
  const python = pythonStats.length
    ? {
        filesParsed: pythonStats.reduce((a, py) => a + py.filesParsed, 0),
        syntaxErrors: pythonStats.reduce((a, py) => a + py.syntaxErrors, 0),
        skippedFiles: pythonStats.flatMap((py) => py.skippedFiles),
        unresolvedImports: pythonStats.reduce((a, py) => a + py.unresolvedImports, 0),
        // Targets are dispatched concurrently, so this is cumulative pass time, not wall clock
        // (`parseTimeMs` below is the wall-clock figure).
        durationMs: pythonStats.reduce((a, py) => a + py.durationMs, 0),
        topUnresolvedModules: mergeUnresolvedModules(pythonStats.map((py) => py.topUnresolvedModules)),
      }
    : undefined;

  const merged: ParsedRepo = {
    id: first.id,
    name: first.name,
    path: first.path,
    type: repoType ?? first.type,
    parsedAt: first.parsedAt,
    parserVersion: first.parserVersion,
    parserId,
    git: first.git,
    packages: [...packagesById.values()],
    files,
    functions,
    classes,
    interfaces,
    typeAliases,
    enums,
    variables,
    entrypoints,
    entities,
    dbOperations,
    calls,
    imports,
    externalCalls,
    referencesVariables: optional(repos.map((r) => r.referencesVariables)),
    enumMemberReferences: optional(repos.map((r) => r.enumMemberReferences)),
    classReferences: optional(repos.map((r) => r.classReferences)),
    sdkDefinitions: optional(repos.map((r) => r.sdkDefinitions)),
    components: optional(repos.map((r) => r.components)),
    routes: optional(repos.map((r) => r.routes)),
    stateStores: optional(repos.map((r) => r.stateStores)),
    stats: {
      ...(analysis.length ? { analysis } : {}),
      totalFiles: sum((r) => r.stats.totalFiles),
      parsedFiles: sum((r) => r.stats.parsedFiles),
      skippedFiles: sum((r) => r.stats.skippedFiles),
      totalFunctions: functions.length,
      totalClasses: classes.length,
      totalEntrypoints: entrypoints.length,
      totalEntities: entities.length,
      totalCalls: calls.length,
      totalImports: imports.length,
      totalExternalCalls: externalCalls.length,
      // Advisory: max of per-target times. Targets are dispatched concurrently,
      // though synchronous indexer steps may serialize them in practice.
      parseTimeMs: Math.max(...repos.map((r) => r.stats.parseTimeMs)),
      // Per-repository signal (LIM-5): one summed record over the targets that measured it.
      // Spread so the key stays absent when none did — an absent record means "not measured",
      // which zeros would misreport as a fully unresolved graph.
      ...(callResolution ? { callResolution } : {}),
      ...(dbOpResolution ? { dbOpResolution } : {}),
      ...(kotlin ? { kotlin } : {}),
      ...(python ? { python } : {}),
    },
    errors: optional(repos.map((r) => r.errors)),
  };

  // Cross-target dangling references (a target emitting functions but no file
  // nodes; a handler bound to a node another target owns) only become visible
  // once the graphs are one. Record them on the merged output — never throw:
  // a partial graph is still worth shipping, it just must not claim to be whole.
  applyIntegrityReport(merged);
  return merged;
}
