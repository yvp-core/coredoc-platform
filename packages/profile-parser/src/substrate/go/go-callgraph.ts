/**
 * Go internal call graph — structural extraction + Tier-B call resolution.
 *
 * Emits a `FunctionNode` for EVERY `function_declaration`, `method_declaration` AND `func_literal`
 * so the graph has a real node for every potential caller. Closures are included (unlike Rust,
 * which indexes only `function_item`) because Go's dominant HTTP idiom binds a handler to a
 * closure — `r.Get("/x", func(w http.ResponseWriter, r *http.Request) {…})` — and a call inside
 * one would otherwise have to be attributed to the enclosing `setupRoutes`, silently merging every
 * handler's outgoing calls into one node. Ids are canonical via `goFunctionId`, so a func's node id
 * matches the same func's db-op performer id and the two merge by id in the parser.
 *
 * This is the tree-sitter baseline; the Go parser optionally supplements it with scip-go calls. It is PRECISION-FIRST: a wrong edge is worse
 * than a missing one because it is indistinguishable from a real one to a reader. Three
 * syntactically-decidable shapes resolve and everything else is dropped:
 *
 *   - `go-local`  — bare `f()` → a package-scope func in the caller's OWN PACKAGE. Go's
 *                   compilation unit is the DIRECTORY, so this resolves across the files of one
 *                   package by the language's own rule, not by a heuristic.
 *   - `go-import` — `pkg.F()` → the import table gives `pkg`'s import path, the package index gives
 *                   that path's directory, and the def index gives the func in it.
 *   - `go-recv`   — `r.M()` where `r` is the enclosing method's own receiver variable → a method on
 *                   that receiver's type, in the same package. Read off the signature, no inference.
 *   - `go-type`   — `v.M()` on any other value whose named TYPE the shared type environment
 *                   (`go-types.ts`) could decide → a method on that type, in the package that
 *                   DECLARES the type. Without this tier the graph keeps only calls a method makes
 *                   on itself, which is a small minority of a real Go service's edges.
 *
 * The `go-type` tier is where the precision policy earns its keep. An interface-typed value
 * resolves to the INTERFACE, whose `method_spec`s have no bodies and are therefore not in the
 * method index at all, so interface dispatch is dropped rather than bound to one arbitrary
 * implementation — the single most damaging wrong edge a Go call graph can ship. A value the
 * environment cannot type is likewise dropped, and — this is the load-bearing half — it is never
 * re-read as a package qualifier, because a local that shadows an import must not resolve to that
 * import's package.
 *
 * Still DROPPED as an intentional Tier-B gap: method promotion through an embedded struct; a call
 * through a func-typed variable; a value whose type only a reassignment or a type switch decides;
 * and any bare call in a file with a dot import, where the name may belong to the dot-imported
 * package (see `go-imports.ts`).
 */
import type {
  CallEdge,
  CallProvenance,
  CallResolutionStats,
  FunctionNode,
  ParameterInfo,
  StableIdGenerator,
} from '@coredoc/core';
import {
  CALL_EXPRESSION,
  DEF_TYPES,
  FUNCTION_DECLARATION,
  FUNC_LITERAL,
  type GoFile,
  IDENTIFIER,
  METHOD_DECLARATION,
  PARAMETER_DECLARATION,
  SELECTOR_EXPRESSION,
  SHORT_VAR_DECLARATION,
  STRUCT_TYPE,
  TYPE_SPEC,
  VAR_SPEC,
  type TsNode,
  enclosingFunction,
  goDeclName,
  goFunctionId,
  isExported,
  itemName,
  namedChildrenOfType,
  nearestAncestor,
  receiverTypeName,
} from './go-cst.js';
import { type GoPackageIndex, buildImportTable, resolveQualifier } from './go-imports.js';
import type { GoTypeEnv } from './go-types.js';
import { repoDir } from '../glob.js';

// =============================================================================
// Structural extraction
// =============================================================================

/**
 * Parameter names from a func's `parameters` field.
 *
 * `fieldNames` is not reusable here — a `parameter_declaration` names its parameters with plain
 * `identifier` children (`a, b int`), not `field_identifier`s — but the same grouping trap applies:
 * one declaration can declare several names, and an UNNAMED parameter (`func(int) error`, legal in
 * a signature) declares none at all.
 */
function paramInfos(fn: TsNode): ParameterInfo[] {
  const params = fn.childForFieldName?.('parameters');
  if (!params) return [];
  const out: ParameterInfo[] = [];
  for (const decl of namedChildrenOfType(params, PARAMETER_DECLARATION)) {
    const typeText = decl.childForFieldName?.('type')?.text as string | undefined;
    // A variadic parameter's type is written `...T`; Go has no default arguments, so `isOptional`
    // is always false — a pointer parameter is nilable, not optional, and conflating the two would
    // make every `*sql.DB` look like it could be omitted.
    const isRest = typeText?.startsWith('...') ?? false;
    for (const ident of namedChildrenOfType(decl, IDENTIFIER)) {
      out.push({
        name: ident.text as string,
        type: typeText ? { text: typeText } : undefined,
        isOptional: false,
        isRest,
      });
    }
  }
  return out;
}

/**
 * `${dir}#${Type}` → the file that DECLARES that struct. A method's `classId` must point at the
 * ClassNode, which is minted from the struct's own file — and Go routinely puts methods in a
 * sibling file (`consumer.go` declares `Consumer`, `dlq.go` adds `sendToDLQ`). Only structs become
 * ClassNodes, so a method on any other named type (`type repeated []string`) gets no `classId`.
 */
function structFilesByPackageType(files: GoFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { relPath, root } of files) {
    for (const spec of root.descendantsOfType(TYPE_SPEC) as TsNode[]) {
      const name = itemName(spec);
      if (!name || spec.childForFieldName?.('type')?.type !== STRUCT_TYPE) continue;
      const key = `${repoDir(relPath)}#${name}`;
      if (!out.has(key)) out.set(key, relPath);
    }
  }
  return out;
}

/** Build a `FunctionNode` for one func/method/closure (canonical scope-chain id). */
function fnToFunctionNode(
  fn: TsNode,
  relPath: string,
  idGen: StableIdGenerator,
  structFiles: Map<string, string>,
): FunctionNode {
  const name = goDeclName(fn);
  const receiver = fn.type === METHOD_DECLARATION ? receiverTypeName(fn) : undefined;
  const id = goFunctionId(idGen, relPath, fn);
  // Capped at 20000 chars to guard against pathological bodies bloating the output — matches the
  // TS structural path (to-nodes.ts) and the ruby/python/rust call-graph extractors.
  const sourceCode = (fn.text as string).slice(0, 20000);
  const result = fn.childForFieldName?.('result')?.text as string | undefined;
  return {
    id,
    versionedId: idGen.versionedId(id, fn.text as string),
    name,
    kind: receiver ? 'method' : 'function',
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1 },
    // Go has no `async` keyword — concurrency is `go f()` at the CALL site, a property of the call
    // and not of the declaration — so this is always false rather than guessed from the body.
    isAsync: false,
    isGenerator: false,
    parameters: paramInfos(fn),
    returnType: result ? { text: result } : undefined,
    classId: classIdOf(receiver, relPath, idGen, structFiles),
    // Go's ENTIRE visibility model is the first rune's case; `visibility` is only a FunctionNode
    // field for methods, so a package-scope func carries the same fact as `isExported` instead.
    visibility: receiver ? (isExported(name) ? 'public' : 'private') : undefined,
    isExported: receiver ? undefined : isExported(name),
    sourceCode,
  };
}

function classIdOf(
  receiver: string | undefined,
  relPath: string,
  idGen: StableIdGenerator,
  structFiles: Map<string, string>,
): string | undefined {
  if (!receiver) return undefined;
  const declFile = structFiles.get(`${repoDir(relPath)}#${receiver}`);
  return declFile ? idGen.classId(declFile, receiver) : undefined;
}

/** Repo-wide def index the Tier-B resolver reads. */
export interface GoDefIndex {
  /** def id → FunctionNode (every func, method and closure), keyed by `goFunctionId`. */
  byId: Map<string, FunctionNode>;
  /**
   * `${dir}#${name}` → def ids of PACKAGE-SCOPE funcs (no receiver, not nested in another func).
   *
   * Keyed by DIRECTORY, which is Go's own scope for an unqualified name — not by file. A list, not
   * a single id, so an ambiguous name (two `func init()` in one package, or a collapsed id) can be
   * DROPPED rather than resolved to an arbitrary winner.
   */
  funcIdsByPackageName: Map<string, string[]>;
  /** `${dir}#${Type}` → (method name → def id). Package-scoped for the same reason. */
  methodsByPackageType: Map<string, Map<string, string>>;
}

/**
 * Build the repo-wide def index (one walk per already-parsed file). De-duped by canonical id
 * (first occurrence wins), which collapses the two documented `goFunctionId` cases: repeated
 * `func init()` in one file, and two truly anonymous closures in one enclosing function.
 */
export function indexGoDefs(files: GoFile[], idGen: StableIdGenerator): GoDefIndex {
  const byId = new Map<string, FunctionNode>();
  const funcIdsByPackageName = new Map<string, string[]>();
  const methodsByPackageType = new Map<string, Map<string, string>>();
  const structFiles = structFilesByPackageType(files);

  for (const { relPath, root } of files) {
    const dir = repoDir(relPath);
    const decls = [
      ...(root.descendantsOfType(FUNCTION_DECLARATION) as TsNode[]),
      ...(root.descendantsOfType(METHOD_DECLARATION) as TsNode[]),
      ...(root.descendantsOfType(FUNC_LITERAL) as TsNode[]),
    ];
    for (const fn of decls) {
      const node = fnToFunctionNode(fn, relPath, idGen, structFiles);
      if (byId.has(node.id)) continue; // de-dup, first wins
      byId.set(node.id, node);

      if (fn.type === METHOD_DECLARATION) {
        const typeName = receiverTypeName(fn);
        if (!typeName) continue;
        const key = `${dir}#${typeName}`;
        let m = methodsByPackageType.get(key);
        if (!m) {
          m = new Map<string, string>();
          methodsByPackageType.set(key, m);
        }
        if (!m.has(node.name)) m.set(node.name, node.id);
        continue;
      }
      // A package-scope func — the only shape a bare `f()` or a `pkg.F()` can name. A func nested
      // inside another func (or a closure) is reachable only through the value it is bound to,
      // which is not a name this substrate can resolve.
      if (fn.type === FUNCTION_DECLARATION && !nearestAncestor(fn, DEF_TYPES)) {
        const key = `${dir}#${node.name}`;
        const list = funcIdsByPackageName.get(key) ?? [];
        list.push(node.id);
        funcIdsByPackageName.set(key, list);
      }
    }
  }

  return { byId, funcIdsByPackageName, methodsByPackageType };
}

// =============================================================================
// Tier-B call resolver
// =============================================================================

/**
 * The Go provenance tiers SHIPPED as resolved graph edges. `resolveGoCalls` drops every edge whose
 * provenance is not in this set (plus unresolved + self edges), so a dynamic or type-dependent site
 * never fabricates a caller.
 */
export const SHIPPABLE_PROVENANCE = new Set<CallProvenance>(['go-local', 'go-import', 'go-recv', 'go-type']);

/** A resolved callee: the def id, how it was resolved, and the def NAME the guard re-checks. */
interface Resolution {
  calleeId: string;
  provenance: CallProvenance;
  name: string;
}

/**
 * Whether a bare `name` is bound as a LOCAL in the caller — a parameter, a `:=` / `var` binding, or
 * a closure assigned to that name.
 *
 * Go funcs are ordinary values, so `handle := func(){…}; handle()` calls the closure, not a
 * package-scope `handle`. A shadowed bare call is DROPPED rather than mis-attributed.
 */
function isLocallyBound(name: string, callerFn: TsNode): boolean {
  if (paramInfos(callerFn).some((p) => p.name === name)) return true;
  const body = callerFn.childForFieldName?.('body');
  if (!body) return false;
  for (const decl of body.descendantsOfType(SHORT_VAR_DECLARATION) as TsNode[]) {
    const left = decl.childForFieldName?.('left') as TsNode | undefined;
    if (namedChildrenOfType(left, IDENTIFIER).some((c) => (c.text as string) === name)) return true;
  }
  for (const spec of body.descendantsOfType(VAR_SPEC) as TsNode[]) {
    if (namedChildrenOfType(spec, IDENTIFIER).some((c) => (c.text as string) === name)) return true;
  }
  return false;
}

/** The single def id for a package-scope name, or undefined when the name is absent or ambiguous. */
function uniquePackageFunc(index: GoDefIndex, dir: string, name: string): string | undefined {
  const ids = index.funcIdsByPackageName.get(`${dir}#${name}`);
  return ids && ids.length === 1 ? ids[0] : undefined;
}

/** Resolve a bare `f()` against the caller's OWN package (directory). */
function resolveBareCall(name: string, relPath: string, callerFn: TsNode, index: GoDefIndex): Resolution | undefined {
  if (isLocallyBound(name, callerFn)) return undefined;
  const calleeId = uniquePackageFunc(index, repoDir(relPath), name);
  return calleeId ? { calleeId, provenance: 'go-local', name } : undefined;
}

/**
 * Resolve `x.F()` in Go's own name-resolution order: an enclosing binding shadows a file's imports,
 * so the VALUE reading is tried before the PACKAGE reading and a bound name is never re-read as a
 * qualifier. Three outcomes:
 *
 *   1. `r.M()` on the enclosing method's own receiver — read off the signature (`go-recv`).
 *   2. `v.M()` on any other value the type environment can type — a method on that value's type, in
 *      the package that declares it (`go-type`). A value it cannot type is DROPPED here and not
 *      allowed to fall through, because the name really is a variable at this site.
 *   3. `pkg.F()` where the operand names no binding at all — the import table's package (`go-import`).
 */
function resolveSelectorCall(
  callee: TsNode,
  file: GoFile,
  index: GoDefIndex,
  packageIndex: GoPackageIndex,
  typeEnv: GoTypeEnv,
): Resolution | undefined {
  const operand = callee.childForFieldName?.('operand') as TsNode | undefined;
  const name = callee.childForFieldName?.('field')?.text as string | undefined;
  if (!name || !operand) return undefined;

  // `r.M()` where `r` is the enclosing METHOD's receiver variable. The lookup walks past any
  // closures in between on purpose: a Go closure captures its enclosing method's receiver, so
  // `s.helper()` inside an inline handler is still a call on `s`. Kept ahead of the type
  // environment because it needs no inference at all — same answer, stronger provenance.
  const method = operand.type === IDENTIFIER ? nearestAncestor(callee, METHOD_DECL_ONLY) : undefined;
  if (method && receiverVarName(method) === (operand.text as string)) {
    const typeName = receiverTypeName(method);
    const hit = typeName
      ? index.methodsByPackageType.get(`${repoDir(file.relPath)}#${typeName}`)?.get(name)
      : undefined;
    // A receiver-qualified call that names no method on the type is a method PROMOTED from an
    // embedded struct — a real call this substrate cannot follow. Dropped, never guessed.
    return hit ? { calleeId: hit, provenance: 'go-recv', name } : undefined;
  }

  const receiver = typeEnv.resolveOperand(operand, file);
  if (receiver.kind === 'type') {
    // The method index is keyed by the type's OWN package, so a handler declared in
    // `internal/handler` resolves from a call site in `cmd/server`. An interface resolves to a type
    // with no method DECLARATIONS, so dispatch finds nothing and is dropped.
    const hit = index.methodsByPackageType.get(`${receiver.type.dir}#${receiver.type.name}`)?.get(name);
    return hit ? { calleeId: hit, provenance: 'go-type', name } : undefined;
  }
  // Bound to something untypable: a real variable, so reading it as a package would be a wrong edge.
  if (receiver.kind === 'unresolved') return undefined;

  // `pkg.F()` — the qualifier must be an IMPORT in this file, and the import must land inside the
  // repo. `resolveQualifier` corrects the last-segment guess against the package's DECLARED name,
  // so `internal/database` declaring `package db` resolves from `db.`.
  const importPath = resolveQualifier(buildImportTable(file), packageIndex, operand.text as string);
  if (!importPath) return undefined;
  const dir = packageIndex.byImportPath.get(importPath);
  if (dir === undefined) return undefined; // stdlib / third-party — not this repo's code
  const calleeId = uniquePackageFunc(index, dir, name);
  return calleeId ? { calleeId, provenance: 'go-import', name } : undefined;
}

/** Ancestor filter for "the method this call is lexically inside", closures walked past. */
const METHOD_DECL_ONLY = new Set<string>([METHOD_DECLARATION]);

/** The receiver VARIABLE of a `method_declaration` (`s` in `func (s *Svc) …`), if it is named. */
function receiverVarName(methodDecl: TsNode): string | undefined {
  const receiver = methodDecl?.childForFieldName?.('receiver') as TsNode | undefined;
  const decl = receiver?.descendantsOfType?.(PARAMETER_DECLARATION)?.[0] as TsNode | undefined;
  // `func (*Svc) Handle()` — a legal receiver with no name — binds nothing, so nothing can be
  // qualified by it. `fieldNames` is the wrong helper here: a receiver's name is an `identifier`.
  return decl ? (namedChildrenOfType(decl, IDENTIFIER)[0]?.text as string | undefined) : undefined;
}

/** The result of one resolver pass: the shippable edges plus the observability count. */
export interface GoCallResult {
  calls: CallEdge[];
  /**
   * Call sites that named something this substrate could not decide — a method on a non-receiver
   * value (all interface dispatch), a qualified call into a package outside the repo, an ambiguous
   * package-scope name. Reported by the parser rather than silently swallowed.
   */
  ambiguousCalls: number;
  /** Language-neutral call-resolution counters (spec BR-1/BR-2). */
  stats: CallResolutionStats;
}

/**
 * Every in-func call site, resolved where it is syntactically decidable.
 *
 * The caller is `enclosingFunction` — the INNERMOST func scope, closures included — so a call in an
 * inline handler is attributed to that handler and not to the router-setup function around it.
 * A call at PACKAGE scope (`var db = mustOpen()`) has no enclosing function and produces no edge:
 * the call graph's caller must be a real node, and Go's package-init order is not a function. (The
 * db-op lane synthesizes an `init` performer for its own attribution; a call edge from a
 * synthesized node would claim a caller that does not exist in source.)
 */
function resolveAllGoCalls(
  files: GoFile[],
  index: GoDefIndex,
  idGen: StableIdGenerator,
  packageIndex: GoPackageIndex,
  typeEnv: GoTypeEnv,
): { edges: CallEdge[]; outOfScopeCalls: number } {
  const edges: CallEdge[] = [];
  // Every simple name this repo declares as a func or method. A callee name absent from it can
  // have no in-repo target, which is what separates "out of scope" from "missed" (BR-1).
  const callableNames = new Set([...index.byId.values()].map((fn) => fn.name));
  let outOfScopeCalls = 0;

  for (const file of files) {
    const { relPath, root } = file;
    // A dot import drops an unknowable set of names into this file's namespace, so a bare call
    // here could name that package's func or this one's. Bare calls are skipped in such a file;
    // qualified ones are unaffected (a dot import binds no qualifier).
    const hasDotImport = buildImportTable(file).dotImports.length > 0;

    for (const call of root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const callerFn = enclosingFunction(call);
      if (!callerFn) continue; // package-scope call site — no caller node
      const callee = call.childForFieldName?.('function') as TsNode | undefined;
      if (!callee) continue;

      const callerId = goFunctionId(idGen, relPath, callerFn);
      const startLine = call.startPosition.row + 1;
      const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);
      const isMethodCall = callee.type === SELECTOR_EXPRESSION;

      let resolved: Resolution | undefined;
      let calledName: string | undefined;

      if (callee.type === IDENTIFIER) {
        calledName = callee.text as string;
        resolved = hasDotImport ? undefined : resolveBareCall(calledName, relPath, callerFn, index);
      } else if (callee.type === SELECTOR_EXPRESSION) {
        calledName = callee.childForFieldName?.('field')?.text as string | undefined;
        resolved = resolveSelectorCall(callee, file, index, packageIndex, typeEnv);
      }
      if (resolved) calledName = resolved.name;

      let calleeId = resolved?.calleeId;
      let provenance = resolved?.provenance;

      // Precision guard (mirrors the ruby/python/rust resolvers): the resolved def's name must
      // equal the called name, so an index mismatch drops the edge instead of shipping a wrong one.
      if (calleeId) {
        const target = index.byId.get(calleeId);
        if (!target || (calledName && target.name !== calledName)) {
          calleeId = undefined;
          provenance = undefined;
        }
      }

      // Counted per ENUMERATED site (BR-1): a resolved site's name is declared by construction,
      // so the two classes never overlap.
      if (calledName !== undefined && !callableNames.has(calledName)) outOfScopeCalls++;

      edges.push({
        id: idGen.callEdgeId(callerId, calleeExpression, `${relPath}:${startLine}`),
        callerId,
        calleeId,
        provenance,
        calleeExpression,
        isMethodCall,
        location: { filePath: relPath, startLine, endLine: call.endPosition.row + 1 },
      });
    }
  }
  return { edges, outOfScopeCalls };
}

/**
 * The SHIPPABLE call edges: resolved, non-self, high-confidence. Drops unresolved sites, self-edges
 * (a recursive func is not its own caller — matches the TS SCIP + ruby/python/rust paths), and any
 * non-SHIPPABLE_PROVENANCE tier. The dropped count comes back as `ambiguousCalls` so the parser can
 * report the Tier-B hole instead of hiding it.
 */
export function resolveGoCalls(
  files: GoFile[],
  index: GoDefIndex,
  idGen: StableIdGenerator,
  packageIndex: GoPackageIndex,
  typeEnv: GoTypeEnv,
): GoCallResult {
  const { edges, outOfScopeCalls } = resolveAllGoCalls(files, index, idGen, packageIndex, typeEnv);
  const calls = edges.filter(
    (e) =>
      e.calleeId !== undefined &&
      e.callerId !== e.calleeId &&
      e.provenance !== undefined &&
      SHIPPABLE_PROVENANCE.has(e.provenance),
  );
  // `resolvedCalls` is counted off the SHIPPED array, so a site dropped by the provenance or
  // self-edge filter reads as unresolved rather than as a bound one.
  return {
    calls,
    ambiguousCalls: edges.length - calls.length,
    stats: { callSites: edges.length, resolvedCalls: calls.length, outOfScopeCalls },
  };
}
