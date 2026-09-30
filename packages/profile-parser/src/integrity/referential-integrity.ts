// =============================================================================
// Referential-integrity validation at output-assembly time.
//
// The systemic failure this exists to stop: a target emits a partial graph
// (python target with no file/class nodes; a SCIP pass that died per-package;
// a tree-sitter WASM load failure) and the output still self-reports green —
// no errors, stats claiming more files than `files[]` holds, and a scorecard
// PASS. Extraction failure must be LOUD.
//
// Cost is linear: one Set per referenced node collection, one pass per edge
// collection, counting + at most SAMPLE_LIMIT sample ids per violation.
// =============================================================================
import { ALL_HTTP_METHODS } from '@coredoc/core/types';
import type { ParseError, ParsedRepo } from '@coredoc/core/types';

/** How many offending ids each violation carries, for the error message. */
const SAMPLE_LIMIT = 3;

/**
 * `file` value stamped on every ParseError this module appends. Also the marker
 * `applyIntegrityReport` uses to drop its own previous entries, so applying the
 * pass twice (per-target then post-merge) cannot double-report.
 */
export const INTEGRITY_ERROR_FILE = '<integrity>';

/**
 * The reference edges checked, named `<collection>.<field>`. The name is what
 * lands in the error message and in `stats.integrity.byCollection`, so it is a
 * closed vocabulary rather than an ad-hoc string at each call site.
 */
export enum IntegrityRef {
  FunctionFile = 'functions.fileId',
  FunctionClass = 'functions.classId',
  ClassFile = 'classes.fileId',
  EntityFile = 'entities.fileId',
  DbOperationPerformer = 'dbOperations.performerId',
  DbOperationEntity = 'dbOperations.entityId',
  CallCaller = 'calls.callerId',
  EnumMemberRefSource = 'enumMemberReferences.sourceId',
  ClassRefSource = 'classReferences.sourceId',
  CallCallee = 'calls.calleeId',
  EntrypointHandler = 'entrypoints.handlerId',
  ComponentFile = 'components.fileId',
  ComponentChild = 'components.childComponents.componentId',
  ImportSourceFile = 'imports.sourceFileId',
  ImportTargetFile = 'imports.targetFileId',
  FilePackage = 'files.packageId',
  /** Not a reference — `stats.parsedFiles` disagreeing with `files[].length`. */
  StatsParsedFiles = 'stats.parsedFiles',
}

export interface IntegrityViolation {
  /** Which reference edge broke. */
  ref: IntegrityRef;
  /** How many rows in that collection carry an unresolvable id. */
  count: number;
  /** Up to SAMPLE_LIMIT offending ids (the referenced value, not the row id). */
  samples: string[];
}

export interface IntegrityReport {
  danglingRefs: number;
  byCollection: Record<string, number>;
  violations: IntegrityViolation[];
  /**
   * Synthetic entrypoint handlers (route/queue rows whose handlerId names a
   * source-derived pseudo-function, not an emitted node) — a documented,
   * non-violating exception, counted so it stays visible.
   */
  syntheticHandlers: number;
}

/**
 * HTTP methods a synthetic route-handler id can be named after.
 *
 * Derived from the canonical `HttpMethod` vocabulary rather than re-listed: the previous local
 * copy admitted `TRACE`, `ANY` and `*`, none of which any producer in this repo mints, so those
 * branches were unreachable while quietly widening the synthetic-handler exemption.
 */
const HTTP_METHODS = new Set<string>(ALL_HTTP_METHODS);

/**
 * Documented synthetic-handler convention: substrates without a resolvable
 * handler node (python urlconf routes, ruby routes/queues) mint a function id
 * whose NAME segment is `"<METHOD> <path>"` or `"queue:<topic>"` rather than a
 * real symbol — see substrate/python/python-entrypoints.ts and
 * substrate/ruby/ruby-parser.ts. Ids are structured (`hash:function:path:name`),
 * not hashed, so the convention is readable straight off the id.
 */
export function isSyntheticHandlerId(id: string): boolean {
  const parts = id.split(':');
  if (parts.length < 4 || parts[1] !== 'function') return false;
  const name = parts.slice(3).join(':');
  if (name.startsWith('queue:')) return true;
  const [method, rest] = name.split(' ', 2);
  return rest !== undefined && HTTP_METHODS.has(method);
}

/** Accumulator for one reference edge: counts every miss, keeps the first few. */
class RefCheck {
  count = 0;
  readonly samples: string[] = [];
  constructor(
    readonly ref: IntegrityRef,
    private readonly known: ReadonlySet<string>,
  ) {}
  /** Record `id` if it is present and resolves to nothing. */
  check(id: string | undefined): void {
    if (id === undefined || this.known.has(id)) return;
    this.count++;
    if (this.samples.length < SAMPLE_LIMIT) this.samples.push(id);
  }
}

/**
 * Assert every cross-collection id in a ParsedRepo resolves to an emitted node,
 * plus the `stats.parsedFiles === files.length` honesty check. Pure: returns the
 * report, mutates nothing.
 */
export function checkReferentialIntegrity(repo: ParsedRepo): IntegrityReport {
  const fileIds = new Set(repo.files.map((f) => f.id));
  const packageIds = new Set(repo.packages.map((p) => p.id));
  const functionIds = new Set(repo.functions.map((f) => f.id));
  const classIds = new Set(repo.classes.map((c) => c.id));
  const entityIds = new Set(repo.entities.map((e) => e.id));
  const componentIds = new Set((repo.components ?? []).map((c) => c.id));

  const checks: RefCheck[] = [];
  const add = (ref: IntegrityRef, known: ReadonlySet<string>): RefCheck => {
    const c = new RefCheck(ref, known);
    checks.push(c);
    return c;
  };

  const fnFile = add(IntegrityRef.FunctionFile, fileIds);
  const fnClass = add(IntegrityRef.FunctionClass, classIds);
  for (const fn of repo.functions) {
    fnFile.check(fn.fileId);
    // Any function carrying a container reference is checked, whatever its `kind`: a substrate
    // that names a class its structure lane never emitted is the defect, and narrowing this to
    // kind 'method' let exactly that shape through.
    fnClass.check(fn.classId);
  }

  const clsFile = add(IntegrityRef.ClassFile, fileIds);
  for (const c of repo.classes) clsFile.check(c.fileId);

  const entFile = add(IntegrityRef.EntityFile, fileIds);
  for (const e of repo.entities) entFile.check(e.fileId);

  const opPerformer = add(IntegrityRef.DbOperationPerformer, functionIds);
  const opEntity = add(IntegrityRef.DbOperationEntity, entityIds);
  for (const op of repo.dbOperations) {
    opPerformer.check(op.performerId);
    opEntity.check(op.entityId);
  }

  const callCaller = add(IntegrityRef.CallCaller, functionIds);
  const callCallee = add(IntegrityRef.CallCallee, functionIds);
  for (const c of repo.calls) {
    callCaller.check(c.callerId);
    // Unresolved calls legitimately carry no calleeId — only a SET id that
    // names nothing is a violation.
    callCallee.check(c.calleeId);
  }

  const enumRefSource = add(IntegrityRef.EnumMemberRefSource, functionIds);
  for (const ref of repo.enumMemberReferences ?? []) enumRefSource.check(ref.sourceId);

  // A class reference is sourced at a FUNCTION (construction site) or at a FILE (import site), so
  // both id sets are legal referents — the row's own refKind says which one it must be.
  const classRefSource = add(IntegrityRef.ClassRefSource, new Set([...functionIds, ...fileIds]));
  for (const ref of repo.classReferences ?? []) classRefSource.check(ref.sourceId);

  const impSource = add(IntegrityRef.ImportSourceFile, fileIds);
  const impTarget = add(IntegrityRef.ImportTargetFile, fileIds);
  for (const i of repo.imports) {
    impSource.check(i.sourceFileId);
    impTarget.check(i.targetFileId);
  }

  const filePackage = add(IntegrityRef.FilePackage, packageIds);
  for (const f of repo.files) filePackage.check(f.packageId);

  const compFile = add(IntegrityRef.ComponentFile, fileIds);
  // A child usage with NO componentId is an unresolved (name-only) reference, not a
  // violation — only a SET id pointing at no emitted component is.
  const compChild = add(IntegrityRef.ComponentChild, componentIds);
  for (const c of repo.components ?? []) {
    compFile.check(c.fileId);
    for (const u of c.childComponents ?? []) compChild.check(u.componentId);
  }

  // Entrypoints: synthetic handler ids are the documented exception.
  const epHandler = add(IntegrityRef.EntrypointHandler, functionIds);
  let syntheticHandlers = 0;
  for (const ep of repo.entrypoints) {
    if (!functionIds.has(ep.handlerId) && isSyntheticHandlerId(ep.handlerId)) {
      syntheticHandlers++;
      continue;
    }
    epHandler.check(ep.handlerId);
  }

  const violations: IntegrityViolation[] = checks
    .filter((c) => c.count > 0)
    .map((c) => ({ ref: c.ref, count: c.count, samples: c.samples }));

  // Stats honesty: parsedFiles is the number the CLI/telemetry/db report, so it
  // must equal the emitted file nodes or every downstream count is a lie.
  if (repo.stats.parsedFiles !== repo.files.length) {
    violations.push({
      ref: IntegrityRef.StatsParsedFiles,
      count: Math.abs(repo.stats.parsedFiles - repo.files.length),
      samples: [`stats.parsedFiles=${repo.stats.parsedFiles}`, `files[].length=${repo.files.length}`],
    });
  }

  const byCollection: Record<string, number> = {};
  let danglingRefs = 0;
  for (const v of violations) {
    byCollection[v.ref] = v.count;
    if (v.ref !== IntegrityRef.StatsParsedFiles) danglingRefs += v.count;
  }
  return { danglingRefs, byCollection, violations, syntheticHandlers };
}

/** One-line human form of a violation, used for the ParseError message. */
export function formatViolation(v: IntegrityViolation): string {
  if (v.ref === IntegrityRef.StatsParsedFiles) {
    return `stats dishonesty: ${v.samples.join(' vs ')} — stats.parsedFiles must equal the emitted file nodes`;
  }
  return `${v.count} dangling reference(s) in ${v.ref} (samples: ${v.samples.join(', ')})`;
}

/**
 * Run the integrity pass and record it on the repo: structured `errors[]`
 * entries (severity 'error' — never thrown away) plus `stats.integrity`.
 * Idempotent — re-applying replaces the previous integrity entries rather than
 * appending a second set.
 */
export function applyIntegrityReport(repo: ParsedRepo): IntegrityReport {
  const report = checkReferentialIntegrity(repo);
  const kept = (repo.errors ?? []).filter((e) => e.file !== INTEGRITY_ERROR_FILE);
  const added: ParseError[] = report.violations.map((v) => ({
    file: INTEGRITY_ERROR_FILE,
    message: formatViolation(v),
    severity: 'error',
  }));
  const errors = [...kept, ...added];
  repo.errors = errors.length > 0 ? errors : undefined;
  repo.stats.integrity = { danglingRefs: report.danglingRefs, byCollection: report.byCollection };
  return report;
}
