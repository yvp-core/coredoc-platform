/**
 * Rust internal call graph — structural extraction + Tier-B call resolution.
 *
 * Emits a `FunctionNode` for EVERY `function_item` (free fns, `impl` methods, trait methods,
 * nested fns) so the graph has a real node for every potential caller/callee. Ids are canonical
 * via `rustFunctionId` (full enclosing scope chain), so a fn's node id matches the same fn's
 * db-op performer id and the two merge by id in the parser.
 *
 * There is no Rust semantic indexer wired into this repo (no scip-rust / rust-analyzer), so
 * this is Tier-B only and it is the load-bearing call graph. It is PRECISION-FIRST: a wrong
 * edge is worse than a missing one because it is indistinguishable from a real one to a reader.
 * Four syntactically-decidable shapes resolve and everything else is dropped:
 *
 *   - `rs-local` — bare `f()` → a fn in the caller's OWN file and module scope.
 *   - `rs-use`   — `f()` / `m::f()` resolved through the file's `use` table + module index.
 *   - `rs-path`  — `crate::a::f()` / `self::f()` / `super::f()` / `some_crate::f()` resolved
 *                  against the module index directly (the path is explicit in source).
 *   - `rs-self`  — `self.m()` / `Self::m()` → a method on the enclosing `impl`'s type, keyed
 *                  file-qualified so two files' same-named types cannot cross-link.
 *
 * Deliberately DROPPED as an intentional Tier-B gap (each needs type inference this substrate
 * does not have): trait-method dispatch through a generic or `dyn Trait`; `Type::assoc_fn()`
 * where `Type` arrived via a glob import or a `pub use` re-export chain; anything a macro body
 * generates; and every `receiver.method()` whose receiver is not `self`.
 */
import type {
  CallEdge,
  CallProvenance,
  CallResolutionStats,
  FunctionNode,
  ParameterInfo,
  StableIdGenerator,
} from '@coredoc/core';
import { type ModuleIndex, type UseTable, buildModuleIndex, buildUseTable, resolveUseTarget } from './rust-imports.js';
import {
  CALL_EXPRESSION,
  DEF_TYPES,
  FIELD_EXPRESSION,
  FUNCTION_ITEM,
  GENERIC_FUNCTION,
  IMPL_ITEM,
  MOD_ITEM,
  type RustFile,
  SCOPED_IDENTIFIER,
  TRAIT_ITEM,
  type TsNode,
  implTypeName,
  isAsyncFn,
  isPublic,
  itemName,
  nearestAncestor,
  rustFunctionId,
  rustTypeChain,
} from './rust-cst.js';
import type { RustCrate } from './rust-crates.js';

// =============================================================================
// Structural extraction
// =============================================================================

/** Parameter names from a fn's `parameters` field (`self` included, as Rust writes it down). */
function paramInfos(fn: TsNode): ParameterInfo[] {
  const params = fn.childForFieldName?.('parameters');
  if (!params) return [];
  const out: ParameterInfo[] = [];
  const n = params.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = params.namedChild(i) as TsNode | undefined;
    if (!c) continue;
    if (c.type === 'self_parameter') {
      out.push({ name: 'self', isOptional: false, isRest: false });
      continue;
    }
    if (c.type !== 'parameter' && c.type !== 'variadic_parameter') continue;
    const pattern = c.childForFieldName?.('pattern') ?? c.namedChild?.(0);
    const name = (pattern?.text ?? undefined) as string | undefined;
    if (!name) continue;
    const typeText = c.childForFieldName?.('type')?.text as string | undefined;
    out.push({
      name,
      type: typeText ? { text: typeText } : undefined,
      // Rust has no default arguments; `Option<T>` is the idiomatic optional and IS written down.
      isOptional: typeText?.startsWith('Option<') ?? false,
      isRest: c.type === 'variadic_parameter',
    });
  }
  return out;
}

/** The `mod` names enclosing a node, outermost first (module scope only — no impl/trait/fn). */
export function rustModChain(node: TsNode): string[] {
  const chain: string[] = [];
  let cur: TsNode | null = node?.parent ?? null;
  while (cur) {
    if (cur.type === MOD_ITEM) {
      const n = itemName(cur);
      if (n) chain.unshift(n);
    }
    cur = cur.parent;
  }
  return chain;
}

/** Build a `FunctionNode` for one `function_item` (canonical scope-chain id). */
function fnToFunctionNode(fn: TsNode, relPath: string, idGen: StableIdGenerator): FunctionNode {
  const name = itemName(fn) ?? '(anonymous)';
  const typeChain = rustTypeChain(fn);
  const inType = nearestAncestor(fn, new Set([IMPL_ITEM, TRAIT_ITEM])) !== undefined;
  const id = rustFunctionId(idGen, relPath, fn);
  // Capped at 20000 chars to guard against pathological bodies bloating the output — matches
  // the TS structural path (to-nodes.ts) and the ruby/python call-graph extractors.
  const sourceCode = (fn.text as string).slice(0, 20000);
  const returnType = fn.childForFieldName?.('return_type')?.text as string | undefined;
  return {
    id,
    versionedId: idGen.versionedId(id, fn.text as string),
    name,
    kind: inType ? 'method' : 'function',
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1 },
    isAsync: isAsyncFn(fn),
    isGenerator: false,
    parameters: paramInfos(fn),
    returnType: returnType ? { text: returnType } : undefined,
    classId: typeChain.length > 0 ? idGen.classId(relPath, typeChain.join('::')) : undefined,
    // `pub` is Rust's export marker for both free fns and methods; visibility is only a
    // FunctionNode field for methods, so free fns carry it as `isExported` instead.
    visibility: inType ? (isPublic(fn) ? 'public' : 'private') : undefined,
    isExported: inType ? undefined : isPublic(fn),
    sourceCode,
  };
}

/** Repo-wide def index the Tier-B resolver reads. */
export interface RustDefIndex {
  /** def id → FunctionNode (every function_item), keyed by rustFunctionId. */
  byId: Map<string, FunctionNode>;
  /** `${relPath}#${modChain}#${name}` → def id — same-file, same-module-scope lookup (rs-local). */
  defByScope: Map<string, string>;
  /**
   * `${relPath}#${name}` → def ids for FREE fns only — the cross-file tail lookup; resolves only
   * when UNIQUE.
   *
   * Free fns ONLY, deliberately: a `mod::fn` path can name nothing else. Indexing every
   * `function_item` lets `crate::util::run()` resolve to an inherent `impl Runner { fn run }` in
   * `util.rs` — a path that reaches nothing in real Rust — and it ships as `rs-path`, the tier
   * that claims the path was explicit in source.
   */
  freeFnIdsByFileName: Map<string, string[]>;
  /** file-qualified type key (`${relPath}#${Type}`) → (method name → def id) — rs-self / Type::fn. */
  methodsByType: Map<string, Map<string, string>>;
}

/**
 * Build the repo-wide def index (one walk per already-parsed file). De-duped by canonical id
 * (first occurrence wins) — this collapses an inherent `impl Foo` and a trait `impl T for Foo`
 * that both define the same method name onto one id, a documented boundary.
 */
export function indexRustDefs(files: RustFile[], idGen: StableIdGenerator): RustDefIndex {
  const byId = new Map<string, FunctionNode>();
  const defByScope = new Map<string, string>();
  const freeFnIdsByFileName = new Map<string, string[]>();
  const methodsByType = new Map<string, Map<string, string>>();

  for (const { relPath, root } of files) {
    for (const fn of root.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
      const node = fnToFunctionNode(fn, relPath, idGen);
      if (byId.has(node.id)) continue; // de-dup, first wins
      byId.set(node.id, node);

      const implNode = nearestAncestor(fn, new Set([IMPL_ITEM, TRAIT_ITEM]));
      if (implNode) {
        // File-qualified: two files each with `impl Config`/`impl Client` must NOT share a key,
        // else file B's `self.method()` resolves to file A's method (cross-file collision).
        const typeName = implNode.type === IMPL_ITEM ? implTypeName(implNode) : itemName(implNode);
        if (typeName) {
          const key = `${relPath}#${typeName}`;
          let m = methodsByType.get(key);
          if (!m) {
            m = new Map<string, string>();
            methodsByType.set(key, m);
          }
          if (!m.has(node.name)) m.set(node.name, node.id);
        }
      } else if (!nearestAncestor(fn, DEF_TYPES)) {
        // A free fn at module scope (not nested inside another fn) — the bare-call target, and
        // the ONLY shape a `mod::fn` path from another file can name.
        const key = `${relPath}#${rustModChain(fn).join('::')}#${node.name}`;
        if (!defByScope.has(key)) defByScope.set(key, node.id);
        const list = freeFnIdsByFileName.get(`${relPath}#${node.name}`) ?? [];
        list.push(node.id);
        freeFnIdsByFileName.set(`${relPath}#${node.name}`, list);
      }
    }
  }

  return { byId, defByScope, freeFnIdsByFileName, methodsByType };
}

// =============================================================================
// Tier-B call resolver
// =============================================================================

/**
 * The Rust provenance tiers SHIPPED as resolved graph edges. `resolveRustCalls` drops every
 * edge whose provenance is not in this set (plus unresolved + self edges), so a dynamic or
 * type-dependent site never fabricates a caller.
 */
export const SHIPPABLE_PROVENANCE = new Set<CallProvenance>(['rs-path', 'rs-use', 'rs-self', 'rs-local']);

/** A resolved callee: the def id, how it was resolved, and the def NAME the guard re-checks. */
interface Resolution {
  calleeId: string;
  provenance: CallProvenance;
  name: string;
}

/**
 * Whether a bare `name` is bound as a LOCAL in the caller — a parameter, a `let` binding, or a
 * fn nested directly in the caller's body. Rust closures are ordinary values, so `let f = |x| …;
 * f()` calls the closure, not a module-level `f`. Precision-first: a shadowed bare call is
 * DROPPED rather than mis-attributed.
 */
function isLocallyBound(name: string, callerFn: TsNode): boolean {
  if (paramInfos(callerFn).some((p) => p.name === name)) return true;
  const body = callerFn.childForFieldName?.('body');
  if (!body) return false;
  for (const decl of body.descendantsOfType('let_declaration') as TsNode[]) {
    if ((decl.childForFieldName?.('pattern')?.text as string | undefined) === name) return true;
  }
  for (const nested of body.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
    if (itemName(nested) === name) return true;
  }
  return false;
}

/** Resolve the 1–2 tail segments of a path against a target file's defs. */
function resolveTail(index: RustDefIndex, filePath: string, tail: string[]): string | undefined {
  if (tail.length === 1) {
    // A free fn in the target file. Resolve only when the name is UNIQUE there — a name that
    // is also an `impl` method elsewhere in the file is ambiguous without type information.
    const ids = index.freeFnIdsByFileName.get(`${filePath}#${tail[0]}`);
    return ids && ids.length === 1 ? ids[0] : undefined;
  }
  // `Type::assoc_fn` — the type is named explicitly in the path, so the method index resolves it.
  return index.methodsByType.get(`${filePath}#${tail[0]}`)?.get(tail[1]);
}

/** Resolve a bare `f()` — same-module first, then the `use` table / module index. */
function resolveBareCall(
  name: string,
  relPath: string,
  callerFn: TsNode,
  table: UseTable,
  moduleIndex: ModuleIndex,
  index: RustDefIndex,
): Resolution | undefined {
  if (isLocallyBound(name, callerFn)) return undefined;
  const local = index.defByScope.get(`${relPath}#${rustModChain(callerFn).join('::')}#${name}`);
  if (local) return { calleeId: local, provenance: 'rs-local', name };
  const target = resolveUseTarget(table, moduleIndex, relPath, name, rustModChain(callerFn));
  if (!target || !target.viaUse) return undefined; // a bare name with no `use` binding is not a path
  const calleeId = resolveTail(index, target.filePath, target.tail);
  return calleeId ? { calleeId, provenance: 'rs-use', name: target.tail[target.tail.length - 1] } : undefined;
}

/** Resolve a qualified `a::b::f()` — through the `use` table (rs-use) or as an explicit path. */
function resolvePathCall(
  path: string,
  relPath: string,
  callerFn: TsNode,
  table: UseTable,
  moduleIndex: ModuleIndex,
  index: RustDefIndex,
): Resolution | undefined {
  const segments = path.split('::');
  const name = segments[segments.length - 1];

  // `Self::m()` — the enclosing impl's own type, same file.
  if (segments.length === 2 && segments[0] === 'Self') {
    const implNode = nearestAncestor(callerFn, new Set([IMPL_ITEM]));
    const typeName = implNode ? implTypeName(implNode) : undefined;
    const hit = typeName ? index.methodsByType.get(`${relPath}#${typeName}`)?.get(name) : undefined;
    return hit ? { calleeId: hit, provenance: 'rs-self', name } : undefined;
  }

  const target = resolveUseTarget(table, moduleIndex, relPath, path, rustModChain(callerFn));
  if (!target) return undefined;
  const calleeId = resolveTail(index, target.filePath, target.tail);
  if (!calleeId) return undefined;
  return {
    calleeId,
    provenance: target.viaUse ? 'rs-use' : 'rs-path',
    name: target.tail[target.tail.length - 1],
  };
}

/** Resolve `self.m()` — a method on the enclosing `impl`'s type (always same-file). */
function resolveSelfMethodCall(
  fnField: TsNode,
  callerFn: TsNode,
  relPath: string,
  index: RustDefIndex,
): Resolution | undefined {
  const receiver = fnField.childForFieldName?.('value');
  const name = fnField.childForFieldName?.('field')?.text as string | undefined;
  if (!name || (receiver?.text as string | undefined) !== 'self') return undefined;
  const implNode = nearestAncestor(callerFn, new Set([IMPL_ITEM, TRAIT_ITEM]));
  if (!implNode) return undefined;
  const typeName = implNode.type === IMPL_ITEM ? implTypeName(implNode) : itemName(implNode);
  const hit = typeName ? index.methodsByType.get(`${relPath}#${typeName}`)?.get(name) : undefined;
  return hit ? { calleeId: hit, provenance: 'rs-self', name } : undefined;
}

/**
 * The callee expression of a call, with a turbofish unwrapped.
 *
 * `.load::<User>(conn)` inserts a `generic_function` between the `call_expression` and the
 * `field_expression`, so a walker that only knows `field_expression` / `identifier` skips every
 * turbofished call — which in diesel code is most of the interesting ones.
 */
export function unwrapCallee(fnField: TsNode | undefined): TsNode | undefined {
  if (fnField?.type !== GENERIC_FUNCTION) return fnField;
  return (fnField.childForFieldName?.('function') ?? fnField.namedChild?.(0)) as TsNode | undefined;
}

/** Every in-fn call site as a `CallEdge` (resolved ones carry calleeId + provenance). */
function resolveAllRustCalls(
  files: RustFile[],
  index: RustDefIndex,
  idGen: StableIdGenerator,
  moduleIndex: ModuleIndex,
): { edges: CallEdge[]; outOfScopeCalls: number } {
  const edges: CallEdge[] = [];
  // Every simple name this repo declares as a fn or method. A callee name absent from it can have
  // no in-repo target, which is what separates "out of scope" from "missed" (BR-1).
  const callableNames = new Set([...index.byId.values()].map((fn) => fn.name));
  let outOfScopeCalls = 0;

  for (const file of files) {
    const { relPath, root } = file;
    const table = buildUseTable(file);

    for (const call of root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const callerFn = nearestAncestor(call, DEF_TYPES);
      if (!callerFn) continue; // module-scope call site (a `static` initializer) — no caller node
      const callee = unwrapCallee(call.childForFieldName?.('function'));
      if (!callee) continue;

      const callerId = rustFunctionId(idGen, relPath, callerFn);
      const startLine = call.startPosition.row + 1;
      const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);
      const isMethodCall = callee.type === FIELD_EXPRESSION;

      let resolved: Resolution | undefined;
      let calledName: string | undefined;

      if (callee.type === 'identifier') {
        calledName = callee.text as string;
        resolved = resolveBareCall(calledName, relPath, callerFn, table, moduleIndex, index);
      } else if (callee.type === SCOPED_IDENTIFIER) {
        const path = callee.text as string;
        calledName = path.slice(path.lastIndexOf('::') + 2);
        resolved = resolvePathCall(path, relPath, callerFn, table, moduleIndex, index);
      } else if (callee.type === FIELD_EXPRESSION) {
        calledName = callee.childForFieldName?.('field')?.text as string | undefined;
        resolved = resolveSelfMethodCall(callee, callerFn, relPath, index);
      }
      if (resolved) calledName = resolved.name;

      let calleeId = resolved?.calleeId;
      let provenance = resolved?.provenance;

      // Precision guard (mirrors the ruby/python resolvers): the resolved def's name must equal
      // the called name, so an index mismatch drops the edge instead of shipping a wrong one.
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

/** The shipped Rust call edges plus the language-neutral resolution counters (spec BR-2). */
export interface RustCallResult {
  calls: CallEdge[];
  stats: CallResolutionStats;
}

/**
 * The SHIPPABLE call edges: resolved, non-self, high-confidence. Drops unresolved sites,
 * self-edges (a recursive fn is not its own caller — matches the TS SCIP + ruby/python paths),
 * and any non-SHIPPABLE_PROVENANCE tier.
 */
export function resolveRustCalls(
  files: RustFile[],
  index: RustDefIndex,
  idGen: StableIdGenerator,
  crates: RustCrate[],
  moduleIndex?: ModuleIndex,
): RustCallResult {
  const modIndex = moduleIndex ?? buildModuleIndex(files, crates);
  const { edges, outOfScopeCalls } = resolveAllRustCalls(files, index, idGen, modIndex);
  const calls = edges.filter(
    (e) =>
      e.calleeId !== undefined &&
      e.callerId !== e.calleeId &&
      e.provenance !== undefined &&
      SHIPPABLE_PROVENANCE.has(e.provenance),
  );
  // `resolvedCalls` is counted off the SHIPPED array, so a site dropped by the provenance or
  // self-edge filter reads as unresolved rather than as a bound one.
  return { calls, stats: { callSites: edges.length, resolvedCalls: calls.length, outOfScopeCalls } };
}
