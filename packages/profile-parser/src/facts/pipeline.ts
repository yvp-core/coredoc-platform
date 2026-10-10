import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import type { ParsedRepo, TypeReference } from '@coredoc/core/types';
import { PARSER_ID, PARSER_VERSION } from './config.js';
import { discover } from './discovery/discover.js';
import { CodeGraph } from './graph/graph-builder.js';
import { type LoadedScip, type ScipIndexSource, loadScipIndexes, projectOwnershipScore } from './scip/decode.js';
import { type IndexerResult, type ProjectIndexOutcome, runScipTypescript } from './scip/run-indexer.js';
import { buildMappingHooks, scipToEdges } from './scip/to-edges.js';
import { hasHeritageClauses, resolveHierarchyRefIdentity } from './structural/hierarchy-ref-identity.js';
import {
  DeclKind,
  type SymbolIdentityResolver,
  type SymbolIdentityResolverOptions,
  createSymbolIdentityResolver,
} from './structural/symbol-ref-identity.js';
import { type StructuralFile, parseTsStructural } from './structural/ts-structural.js';
import { structuralToNodes } from './structural/to-nodes.js';
import { extractVueScript } from './structural/vue-sfc.js';
import { resolverFromStructuralFiles } from './value/resolver.js';
import { detectWorkspacePackages, ownerPackagePath, workspacePackageJsonNames } from './workspace.js';
import { compareCodeUnits } from '@coredoc/core/utils';

export interface PipelineOptions {
  repoRoot: string;
  repoName: string;
  repoKey?: string;
  /**
   * Directory for the generated SCIP index (`index.scip`, or `scip-projects/*.scip` when a
   * workspace is indexed project by project) — the repo's `coredoc-output/<project>/` cache dir
   * when available. Keeps SCIP build artifacts out of the analyzed source tree. Falls back to a
   * per-repo OS temp dir when omitted.
   */
  scipOutDir?: string;
}
export interface PipelineFlags {
  runScip?: boolean;
  /** Promote anonymous call-argument callbacks to citable function nodes (see CallGraphRule). */
  resolveAnonCallbacks?: boolean;
}

/**
 * Result of the deterministic substrate-facts build (discover → structural → SCIP → resolver). This is
 * the only extraction layer this facts module offers; higher-level extraction (entrypoints, entities,
 * call classification) is the profile engine's job (@coredoc/profile-parser), driven off these facts.
 */
export interface BaselineResult {
  graph: CodeGraph;
  structuralFiles: StructuralFile[];
  resolver: ReturnType<typeof resolverFromStructuralFiles>;
  idGen: StableIdGenerator;
  packageId: string;
  plan: ReturnType<typeof discover>;
  errors: NonNullable<ParsedRepo['errors']>;
  /**
   * The decoded SCIP index (occurrences per document), when the SCIP pass ran.
   * Surfaced so downstream consumers (e.g. the profile-parser frontend
   * substrate) can resolve a reference occurrence — e.g. a JSX tag — to its
   * definition symbol/file without re-indexing. Undefined when SCIP was skipped.
   */
  scip?: LoadedScip;
  /** An indexing failure can recover without a source edit; structural extraction errors cannot. */
  scipIncomplete?: boolean;
  /**
   * package.json `name` of every package in this repo's workspace (see `workspacePackageJsonNames`).
   * Surfaced so a substrate can tell an in-repo symbol from a dependency without re-walking the
   * repo's manifests. Optional: hand-built baselines in tests may omit it.
   */
  workspacePackageNames?: string[];
  /**
   * The ONE module-graph identity resolver this parse built, when it needed one. Surfaced so a
   * substrate (the interface-dispatch tier) reuses the filled memos instead of constructing a
   * fourth resolver over the same `structuralFiles`. Absent when nothing in the parse needed
   * identity resolution, and on hand-built baselines.
   */
  identityResolver?: SymbolIdentityResolver;
}

/** A partial index is advisory only when every project recovered and an OOM split left no residue. */
export function indexerPartialSeverity(result: IndexerResult): 'warning' | 'error' {
  const outcomes = result.projectOutcomes;
  if (!outcomes || outcomes.length === 0) return 'error';
  const knownLoss = outcomes.some(
    (outcome) => !outcome.ok || (outcome.split !== undefined && outcome.split.residueFiles > 0),
  );
  return knownLoss ? 'error' : 'warning';
}

/**
 * Build the deterministic substrate-facts baseline: discover files, parse structure, run SCIP semantic
 * edges, then derive the value resolver. No higher-level extraction (entrypoints/entities/call
 * classification) — that is the profile engine's concern, applied over these facts.
 */
export async function buildBaseline(opts: PipelineOptions, flags: PipelineFlags = {}): Promise<BaselineResult> {
  const idGen = new StableIdGenerator(opts.repoRoot, opts.repoKey ?? opts.repoName);
  const g = new CodeGraph();
  const errors: NonNullable<ParsedRepo['errors']> = [];

  // Enumerate workspace packages (monorepo apps/*, packages/*, …) and register one Package each.
  // The root '.' is always present as the fallback owner; a single-package repo yields just that,
  // preserving the legacy single-package-at-'.' behavior. `packageId` (root) is retained on the
  // result for backward compatibility with the BaselineResult contract.
  const workspacePackages = detectWorkspacePackages(opts.repoRoot, opts.repoName);
  for (const pkg of workspacePackages) {
    g.addPackage({ id: idGen.packageId(pkg.path), name: pkg.name, path: pkg.path });
  }
  const packageId = idGen.packageId('.');

  const plan = discover(opts.repoRoot);
  const tsjsFiles = [...plan.languages.typescript.files, ...plan.languages.javascript.files];

  // Layer 2: structural. Retain the parsed StructuralFiles — the profile engine reads their
  // decorators declaratively off the substrate, so they must not be discarded after node emission.
  const structuralFiles: StructuralFile[] = [];
  for (const rel of [...tsjsFiles, ...plan.vueFiles]) {
    let source: string;
    try {
      source = readFileSync(join(opts.repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    // A `.vue` file is parsed as its script block: the blanked-outside form keeps every
    // location identical to the SFC. Cross-file call resolution out of a vue script is
    // structural-only — scip-typescript does not index `.vue`.
    const isVue = rel.endsWith('.vue');
    const vue = isVue ? extractVueScript(source) : undefined;
    const lang = vue ? vue.language : rel.match(/\.(m|c)?jsx?$/) ? 'javascript' : 'typescript';
    const parseSource = vue ? vue.script : source;
    const contentHash = idGen.contentHash(source);
    // Assign this file to its owning workspace package by longest-prefix path match.
    const filePackageId = idGen.packageId(ownerPackagePath(rel, workspacePackages));
    g.addFile({
      id: idGen.fileId(rel),
      versionedId: idGen.versionedFileId(rel, contentHash),
      path: rel,
      extension: rel.slice(rel.lastIndexOf('.')),
      packageId: filePackageId,
      language: lang,
      contentHash,
    });
    try {
      const structural = await parseTsStructural(rel, parseSource, lang as 'typescript' | 'javascript', {
        resolveAnonCallbacks: flags.resolveAnonCallbacks,
      });
      structuralFiles.push(structural);
      structuralToNodes(structural, g, idGen, filePackageId, parseSource);
    } catch (err) {
      errors.push({ file: rel, message: `structural parse failed: ${String(err).slice(0, 160)}`, severity: 'error' });
    }
  }

  const packageJsonNames = workspacePackageJsonNames(opts.repoRoot, workspacePackages);
  const identityOpts: SymbolIdentityResolverOptions = {
    repoRoot: opts.repoRoot,
    workspacePackageNames: workspacePackages.map((pkg) => pkg.name),
    workspacePackagePaths: workspacePackages.map((pkg) => pkg.path),
  };
  // ONE resolver for the whole parse. All four consumers (enum refs, class refs, heritage clauses
  // and the substrate's interface-dispatch tier) read the SAME `structuralFiles`; a resolver each
  // re-walked every file, re-read the manifests, re-ran `await import('typescript')` plus the
  // tsconfig `extends` walk, and started from empty memos — so every barrel chain was walked four
  // times. Built only when something needs it, so a repo with no refs and no heritage still never
  // loads the compiler.
  const needsIdentity =
    hasHeritageClauses(structuralFiles) ||
    [...g.enumMemberRefs.values()].some((ref) => ref.importedFrom !== undefined) ||
    [...g.classRefs.values()].some((ref) => ref.importedFrom !== undefined);
  const identityResolver = needsIdentity
    ? await createSymbolIdentityResolver(structuralFiles, identityOpts)
    : undefined;
  if (identityResolver) {
    // A manifest that exists but will not parse leaves externality unprovable, which is what keeps
    // a by-name hierarchy edge from being fabricated — say so rather than degrade quietly.
    for (const message of identityResolver.manifestErrors) {
      errors.push({
        file: '.',
        message: `${message} — dependency names from it are missing, so symbols imported from those packages cannot be proven external and their references stay unresolved`,
        severity: 'warning',
      });
    }
    resolveEnumMemberRefIdentity(g, idGen, identityResolver);
    resolveClassRefIdentity(g, idGen, identityResolver);
    await resolveHierarchyRefIdentity(g, structuralFiles, idGen, identityOpts, identityResolver);
  }

  // Layer 3: SCIP semantic. scip-typescript indexes BOTH .ts and .js (the latter via --infer-tsconfig),
  // so run it whenever either language's prerequisites are met. A JS-only repo (e.g. sample-schedules)
  // must not silently skip the SCIP pass.
  const wantScip = flags.runScip ?? true;
  const ts = plan.languages.typescript;
  const js = plan.languages.javascript;
  const scipPrereqsMet = ts.scipPrereqsMet || js.scipPrereqsMet;
  const degradeReason = ts.degradeReason ?? js.degradeReason;
  let loadedScip: LoadedScip | undefined;
  let scipIncomplete = false;
  if (wantScip && scipPrereqsMet) {
    const res = await runScipTypescript(opts.repoRoot, { outDir: opts.scipOutDir });
    // One index in single-project/combined mode; one per enumerated project in per-project mode.
    // Per-project outcomes carry the OWNING project of each index — that is what makes the
    // duplicate-document dedupe deterministic (longest path prefix wins) instead of order-dependent.
    const scipSources = scipIndexSources(res);
    const scipPaths = scipSources.map((s) => s.scipPath);
    if (res.ok && scipPaths.length > 0) {
      // Some projects failed to index (per-project mode) or the single index covers an unknown
      // prefix of the workspace (combined mode) — say so, never let either pass as a complete
      // semantic tier. The uncovered files also surface per-directory in scipCoverageGaps below.
      if (res.partialReason) {
        scipIncomplete = indexerPartialSeverity(res) === 'error';
        errors.push({ file: '.', message: res.partialReason, severity: indexerPartialSeverity(res) });
      }
      // A run that crashed can also leave the index truncated mid-write, so it
      // will not decode. Undecodable + KNOWN-crashed is a loud degrade to the
      // structural tier, not a lost parse; an undecodable index from a run that
      // reported success is real corruption (or a concurrent writer) and still
      // throws, because silently re-indexing would hide it.
      let scip: LoadedScip;
      try {
        const merged = loadScipIndexes(scipSources);
        scip = merged;
        // Overlapping tsconfig `include`/`paths` across indexed projects: the same file was
        // indexed by more than one project and the duplicate documents were dropped (first wins).
        // A per-project index that will not decode costs its project, loudly — never the parse.
        scipIncomplete ||= merged.undecodable.length > 0;
        for (const bad of merged.undecodable) {
          errors.push({
            file: '.',
            message: `a per-project SCIP index was dropped because it could not be decoded — the files of that project have NO resolved call edges: ${bad.scipPath}: ${bad.error}`,
            severity: 'error',
          });
        }
        // Intact but for invalid UTF-8 in a string field: kept (leniently decoded) rather than
        // dropped, because losing the index costs that project's entire call graph. Loud because
        // a replaced byte sequence inside a SYMBOL string changes that symbol's identity.
        for (const lenient of merged.lenientUtf8Indexes) {
          errors.push({
            file: '.',
            message:
              `a per-project SCIP index contained invalid UTF-8 in ${lenient.invalidStrings} string field(s) ` +
              `and was decoded leniently (invalid sequences replaced); symbol identity may be affected if the ` +
              `invalid bytes were in symbol strings: ${lenient.scipPath}`,
            severity: 'warning',
          });
        }
        if (merged.duplicateDocuments > 0) {
          errors.push({
            file: '.',
            message:
              `${merged.duplicateDocuments} duplicate SCIP document(s) across ${scipPaths.length} per-project ` +
              `indexes were dropped (a file claimed by more than one indexed project; the project whose root ` +
              `is the file's longest path prefix owns it)` +
              (merged.orderResolvedDuplicates > 0
                ? `, of which ${merged.orderResolvedDuplicates} file(s) are inside NO claiming project ` +
                  `(a tsconfig \`paths\` alias) and were resolved by index order instead`
                : ''),
            severity: 'warning',
          });
        }
      } catch (err) {
        if (!res.partialReason) throw err;
        errors.push({
          file: '.',
          message: `the partial index left by the failed scip-typescript run could not be decoded — this parse has NO semantic call resolution: ${String(err).slice(0, 400)}`,
          severity: 'error',
        });
        return {
          graph: g,
          structuralFiles,
          resolver: resolverFromStructuralFiles(structuralFiles),
          idGen,
          packageId,
          plan,
          errors,
          workspacePackageNames: packageJsonNames,
          identityResolver,
        };
      }
      loadedScip = scip;
      const hooks = buildMappingHooks(scip, g);
      scipToEdges(scip, g, idGen, hooks, { workspacePackageNames: packageJsonNames });
      for (const gap of scipCoverageGaps(scip, tsjsFiles, res.projectOutcomes)) errors.push(gap);
    } else if (res.degradeReason) {
      errors.push({ file: '.', message: res.degradeReason, severity: 'error' });
    }
  } else if (wantScip && degradeReason) {
    // A fresh checkout can still provide structural facts. Missing optional dependencies
    // are a visible limitation; an indexer that actually fails remains an extraction error.
    errors.push({ file: '.', message: degradeReason, severity: 'warning' });
  }

  const resolver = resolverFromStructuralFiles(structuralFiles);

  return {
    graph: g,
    structuralFiles,
    resolver,
    idGen,
    packageId,
    plan,
    errors,
    scip: loadedScip,
    scipIncomplete,
    workspacePackageNames: packageJsonNames,
    identityResolver,
  };
}

/**
 * Resolve the declaring file of every imported enum-member reference over the module graph of
 * this parse (see `createSymbolIdentityResolver`). Runs once the whole structural layer is present,
 * because a barrel hop reads other files' re-exports.
 *
 * A reference whose module is provably OUTSIDE the repo is removed: the enum belongs to that
 * package, and keeping the reference would let the storage layer name-match it onto an unrelated
 * same-named enum of this repo. A reference that resolves to nothing keeps its raw specifier and
 * no declaring file — the honest "identity unchecked" state.
 */
function resolveEnumMemberRefIdentity(g: CodeGraph, idGen: StableIdGenerator, resolver: SymbolIdentityResolver): void {
  for (const ref of [...g.enumMemberRefs.values()].filter((ref) => ref.importedFrom !== undefined)) {
    const specifier = ref.importedFrom as string;
    const identity = resolver.resolve(ref.location.filePath, ref.enumName, specifier, [DeclKind.Enum]);
    if (identity.kind === 'external') {
      g.enumMemberRefs.delete(ref.id);
      continue;
    }
    if (identity.kind === 'unresolved') {
      // The target module was read and declares no enum of that name (an imported class, const or
      // function in value position, e.g. `Logger.instance`): it was never an enum-member reference.
      // Dropping it here keeps a named import from becoming a name-matched edge onto an unrelated
      // same-named enum, exactly as the class-ref pass does.
      if (resolver.resolvesToRepoFile(ref.location.filePath, specifier)) g.enumMemberRefs.delete(ref.id);
      continue;
    }
    if (identity.kind !== 'declared') continue;
    ref.declaringFile = identity.filePath;
    // A re-export alias (`export { Status as RepoStatus }`) renames the symbol on the way out,
    // exactly as an import alias does: the reference must carry the DECLARED name, or it names an
    // enum node that does not exist. The id is keyed on that name, so it is re-derived with it.
    if (identity.declaredName !== ref.enumName) {
      g.enumMemberRefs.delete(ref.id);
      ref.enumName = identity.declaredName;
      ref.id = idGen.enumMemberRefEdgeId(ref.sourceId, ref.enumName, ref.member, specifier);
      g.addEnumMemberRef(ref);
    }
  }
}

/**
 * Resolve the declaring file of every imported class reference (construction and import sites) over
 * the module graph of this parse, on the same discipline as the enum pass.
 *
 * Three outcomes, and two of them delete the reference:
 *  - `external` — the class belongs to that package, not this repo;
 *  - `unresolved` WITH a resolvable module — this parse read the target module and it declares no
 *    class of that name (an imported function, type or constant), so the candidate was never a class
 *    reference. Dropping it here is what keeps every named import in the repo from becoming a
 *    name-matched edge onto an unrelated same-named class;
 *  - `unresolved` with an UNRESOLVABLE module — nothing is proved either way, so the reference
 *    survives with no declaring file and the storage layer marks it ambiguous.
 */
function resolveClassRefIdentity(g: CodeGraph, idGen: StableIdGenerator, resolver: SymbolIdentityResolver): void {
  for (const ref of [...g.classRefs.values()].filter((ref) => ref.importedFrom !== undefined)) {
    const specifier = ref.importedFrom as string;
    const identity = resolver.resolve(ref.location.filePath, ref.className, specifier, [DeclKind.Class]);
    if (identity.kind === 'external') {
      g.classRefs.delete(ref.id);
      continue;
    }
    if (identity.kind === 'unresolved') {
      if (resolver.resolvesToRepoFile(ref.location.filePath, specifier)) g.classRefs.delete(ref.id);
      continue;
    }
    ref.declaringFile = identity.filePath;
    // A re-export alias (`export { Service as RepoService }`) renames the symbol on the way out,
    // exactly as an import alias does: the reference must carry the DECLARED name, or it names a
    // class node that does not exist. The id is keyed on that name, so it is re-derived with it.
    if (identity.declaredName !== ref.className) {
      g.classRefs.delete(ref.id);
      ref.className = identity.declaredName;
      ref.id = idGen.classRefEdgeId(ref.sourceId, ref.className, ref.refKind, specifier);
      g.addClassRef(ref);
    }
  }
}

/**
 * The per-project indexes to merge, each tagged with the project that produced it. Per-project
 * mode carries that mapping in `projectOutcomes`; the combined/single-project modes have one
 * index and no per-project identity, so `project` stays unset (ownership then falls back to
 * index order, which for a single index is not a choice at all).
 */
export function scipIndexSources(res: IndexerResult): ScipIndexSource[] {
  if (res.scipPaths?.length) {
    const owners = new Map((res.projectOutcomes ?? []).flatMap((o) => (o.scipPath ? [[o.scipPath, o.project]] : [])));
    return res.scipPaths.map((scipPath) => ({ scipPath, project: owners.get(scipPath) }));
  }
  return res.scipPath ? [{ scipPath: res.scipPath }] : [];
}

/** Below this share of discovered TS/JS files covered by SCIP documents, say so per directory. */
const SCIP_COVERAGE_FLOOR = 0.95;
/** How many top uncovered directories the warning names. */
const SCIP_GAP_DIRS = 5;

/** Why one discovered file carries no SCIP document. */
enum UncoveredCause {
  /** An indexed project contains the file but its index has no document for it — its
   *  tsconfig `exclude`/`include` left it out (test and e2e globs, overwhelmingly). */
  ProjectExcluded = 'excluded',
  /** An indexed project contains the file but that project's index failed outright. */
  ProjectFailed = 'failed',
  /**
   * No indexed project's root is an ancestor of the file — no tsconfig covers it at all.
   * "Indexed project" is the pnpm workspace members PLUS the tsconfig-rooted trees discovered
   * outside the workspace globs (`enumerateIndexProjects`), so a tree that HAS a tsconfig is
   * never in this class: it is a real claimant, and an uncovered file under it is an
   * include/exclude gap (excluded) or a lost project (failed).
   */
  Orphan = 'orphan',
}

/**
 * The indexed project owning `path` — the one whose root is the file's longest path prefix,
 * mirroring the merge's ownership rule. Undefined when no project contains the file.
 *
 * The ROOT project (`.`) is a prefix of everything, which would make the orphan class empty and
 * turn "nothing indexes plugins/" into the useless "the root tsconfig left it out". In a
 * monorepo the root project is a solution/umbrella tsconfig, so it only counts as a container
 * when it is the ONLY project — a single-package repo, where it really is the covering project.
 */
function owningProject(path: string, outcomes: ProjectIndexOutcome[]): ProjectIndexOutcome | undefined {
  const nested = outcomes.filter((o) => o.project !== '.' && o.project !== '');
  let best: ProjectIndexOutcome | undefined;
  let bestScore = -1;
  for (const o of nested.length > 0 ? nested : outcomes) {
    const score = projectOwnershipScore(o.project, path);
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}

/** Root a gap is attributed to in the warning: the first two path segments (`plugins/x/y.ts` → `plugins/x`). */
function gapRoot(path: string): string {
  const parts = path.split('/');
  return parts.length <= 1 ? '.' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/** `root (n)` for the biggest `SCIP_GAP_DIRS` roots in `paths`. */
function topRoots(paths: string[], key: (p: string) => string): string {
  const byRoot = new Map<string, number>();
  for (const p of paths) byRoot.set(key(p), (byRoot.get(key(p)) ?? 0) + 1);
  return [...byRoot.entries()]
    .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
    .slice(0, SCIP_GAP_DIRS)
    .map(([root, n]) => `${root} (${n})`)
    .join(', ');
}

/**
 * Discovered TS/JS files the SCIP index carries no document for. A gap means those files got
 * the structural tier only — their call sites resolve to nothing. Reported as a warning so the
 * failure is visible in `errors[]` instead of showing up as a mysteriously empty call graph.
 *
 * The gap is CLASSIFIED by cause (see UncoveredCause), because the three causes need different
 * actions and lumping them made an expected exclusion look like a loss. Measured on this repo:
 * 459/558 uncovered files were `*.test.ts`/e2e specs their own project's tsconfig excludes (and
 * the profile excludes too), while 99 sat under no tsconfig at all.
 *
 * DECISION (deliberate, do not "fix" by synthesizing): orphan files are NOT indexed by a
 * generated catch-all tsconfig. A synthetic project would have to claim every uncovered file —
 * including the hundreds of tests the workspace excludes on purpose — from a temp dir outside
 * the repo, i.e. index a program nobody type-checks, at real cost, and then present the result
 * as if it were the repo's own semantics. Naming the orphan roots is the honest fix instead: a
 * profile author (or the repo) commits a tsconfig where the loud gap says one is missing, and the
 * indexer then picks that root up as its own project (`discoverSoloTsconfigProjects`) — an opt-in
 * the repo makes explicitly, not a config we invent for it.
 *
 * `.vue` files are excluded from the denominator: scip-typescript does not index them at all,
 * which is a documented, permanent structural-only path (see the parse loop above).
 */
export function scipCoverageGaps(
  scip: LoadedScip,
  tsjsFiles: string[],
  projectOutcomes: ProjectIndexOutcome[] = [],
): NonNullable<ParsedRepo['errors']> {
  if (tsjsFiles.length === 0) return [];
  const covered = new Set(scip.documents.map((d) => d.relativePath));
  const uncovered = tsjsFiles.filter((f) => !covered.has(f));
  if (uncovered.length / tsjsFiles.length <= 1 - SCIP_COVERAGE_FLOOR) return [];
  const pct = Math.round((uncovered.length / tsjsFiles.length) * 100);
  const head =
    `SCIP indexed no document for ${uncovered.length}/${tsjsFiles.length} discovered TS/JS files (${pct}%) — ` +
    `those files have structural nodes but no resolved call edges.`;

  // Without per-project outcomes (combined/single-project mode) there is no project map to
  // classify against, so report the flat per-directory shape.
  if (projectOutcomes.length === 0) {
    return [
      {
        file: '.',
        message: `${head} Top directories: ${topRoots(uncovered, (f) => posix.dirname(f))}`,
        severity: 'warning',
      },
    ];
  }

  const byCause = new Map<UncoveredCause, string[]>();
  const excludedBy = new Map<string, string[]>();
  for (const f of uncovered) {
    const owner = owningProject(f, projectOutcomes);
    const cause = !owner
      ? UncoveredCause.Orphan
      : owner.ok
        ? UncoveredCause.ProjectExcluded
        : UncoveredCause.ProjectFailed;
    byCause.set(cause, [...(byCause.get(cause) ?? []), f]);
    if (cause === UncoveredCause.ProjectExcluded && owner) {
      excludedBy.set(owner.project, [...(excludedBy.get(owner.project) ?? []), f]);
    }
  }
  const excluded = byCause.get(UncoveredCause.ProjectExcluded) ?? [];
  const failed = byCause.get(UncoveredCause.ProjectFailed) ?? [];
  const orphans = byCause.get(UncoveredCause.Orphan) ?? [];

  const parts: string[] = [];
  if (excluded.length) {
    const projects = [...excludedBy.entries()]
      .sort((a, b) => b[1].length - a[1].length || compareCodeUnits(a[0], b[0]))
      .slice(0, SCIP_GAP_DIRS)
      .map(([project, files]) => `${project} (${files.length})`)
      .join(', ');
    parts.push(
      `${excluded.length} sit inside a project that indexed fine but whose tsconfig include/exclude ` +
        `leaves them out (test/e2e globs, typically) — by project: ${projects}`,
    );
  }
  if (orphans.length) {
    const roots = topRoots(orphans, gapRoot);
    parts.push(
      `${orphans.length} are under NO tsconfig project — nothing indexes them. Committing a tsconfig.json ` +
        `at these roots IS the whole fix: the indexer discovers tsconfig-rooted projects outside the ` +
        `workspace globs and indexes each as its own project (dot-directories are never scanned, so a ` +
        `root inside one stays uncovered): ${roots}` +
        // `.` is repo-root files (`vitest.config.ts` and friends): a tsconfig is already there, so the
        // fix for those is its `include`, not a new file. Say so instead of asking for a duplicate.
        (roots.includes('. (') ? ` — except the \`.\` root, where the fix is the repo-root tsconfig's include` : ''),
    );
  }
  if (failed.length) {
    parts.push(
      `${failed.length} belong to a project whose index FAILED (a real loss, see the per-project ` +
        `failure above): ${topRoots(failed, gapRoot)}`,
    );
  }
  return [{ file: '.', message: `${head} ${parts.join('. ')}`, severity: 'warning' }];
}

/**
 * The same reference, stripped of a resolved id that no longer names an emitted class/interface
 * node. The transformer then renders it by name again (a USES_TYPE usage) instead of writing a
 * dangling EXTENDS / IMPLEMENTS_INTERFACE edge.
 */
function scopedTypeRef(g: CodeGraph, ref: TypeReference): TypeReference {
  if (!ref.resolvedId) return ref;
  if (g.classes.has(ref.resolvedId) || g.interfaces.has(ref.resolvedId)) return ref;
  const { resolvedId: _dropped, ...rest } = ref;
  return rest;
}

export function assemble(
  g: CodeGraph,
  opts: PipelineOptions,
  errors: NonNullable<ParsedRepo['errors']>,
  parseTimeMs: number,
  plan: ReturnType<typeof discover>,
): ParsedRepo {
  const functions = [...g.functions.values()];
  // Heritage references keep their resolved id only while the node they name survives scoping —
  // a base class the profile excluded must leave a NAME, not an edge into a node nobody emitted.
  const classes = [...g.classes.values()].map((cls) => ({
    ...cls,
    extends: cls.extends ? scopedTypeRef(g, cls.extends) : undefined,
    implements: cls.implements?.map((impl) => scopedTypeRef(g, impl)),
  }));
  const calls = [...g.calls.values()];
  const externalCalls = [...g.externalCalls.values()];
  const entrypoints = [...g.entrypoints.values()];
  const entities = [...g.entities.values()];
  const dbOperations = [...g.dbOperations.values()];
  // Enum-member references survive only when BOTH endpoints exist after scoping: the referencing
  // function is still an emitted node, and the name resolves to an emitted enum. Anything else would
  // be a dangling edge into a symbol this parse never described.
  const enumNames = new Set([...g.enums.values()].map((e) => e.name));
  const enumMemberReferences = [...g.enumMemberRefs.values()].filter(
    (ref) => g.functions.has(ref.sourceId) && enumNames.has(ref.enumName),
  );
  // Class references survive on the same both-endpoints rule: the name must resolve to an emitted
  // class, and the referencing side must still be an emitted node — a function for a construction
  // inside one, the file for an import site or for a MODULE-SCOPE construction (which has no
  // enclosing function to be sourced at).
  const classNames = new Set([...g.classes.values()].map((c) => c.name));
  const classReferences = [...g.classRefs.values()].filter(
    (ref) =>
      classNames.has(ref.className) &&
      (ref.refKind === 'import'
        ? g.files.has(ref.sourceId)
        : g.functions.has(ref.sourceId) || g.files.has(ref.sourceId)),
  );
  return {
    // Repo id is the bare repoHash (first segment of any node id), matching the baseline JSON `id` field.
    id: new StableIdGenerator(opts.repoRoot, opts.repoKey ?? opts.repoName).fileId('.').split(':')[0],
    name: opts.repoName,
    path: opts.repoRoot,
    // `type` (RepoType) is declarative — the profile author sets it and the engine stamps it onto
    // the result (see SubstrateProfileEngine.run). assemble has no profile, so it leaves it unset.
    parsedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
    parserId: PARSER_ID,
    packages: [...g.packages.values()],
    files: [...g.files.values()],
    functions,
    classes,
    interfaces: [...g.interfaces.values()].map((iface) => ({
      ...iface,
      extends: iface.extends?.map((ext) => scopedTypeRef(g, ext)),
    })),
    typeAliases: [...g.typeAliases.values()],
    enums: [...g.enums.values()],
    variables: [...g.variables.values()],
    entrypoints,
    entities,
    dbOperations,
    calls,
    imports: [...g.imports.values()],
    externalCalls,
    ...(enumMemberReferences.length ? { enumMemberReferences } : {}),
    ...(classReferences.length ? { classReferences } : {}),
    stats: {
      totalFiles: plan.languages.typescript.fileCount + plan.languages.javascript.fileCount + plan.vueFiles.length,
      parsedFiles: g.files.size,
      skippedFiles: 0,
      totalFunctions: functions.length,
      totalClasses: classes.length,
      totalEntrypoints: entrypoints.length,
      totalEntities: entities.length,
      totalCalls: calls.length,
      totalImports: g.imports.size,
      totalExternalCalls: externalCalls.length,
      parseTimeMs,
    },
    errors: errors.length ? errors : undefined,
  };
}
