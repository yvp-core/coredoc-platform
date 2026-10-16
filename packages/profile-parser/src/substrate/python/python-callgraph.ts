/**
 * Python internal call graph — structural extraction (S4) + Tier-B call resolution (S7).
 *
 * Emits a `FunctionNode` for EVERY Python `function_definition` (module functions, methods,
 * and nested/inner defs) so the graph has a real node for every potential caller/callee. Ids
 * are canonical via `pythonFunctionId` (StableIdGenerator, full enclosing scope chain), so a
 * def's node id matches the same def's db-op performer id — the two merge by id in the parser.
 *
 * The Tier-B resolver is PRECISION-FIRST: false edges are worse than missing edges for agent
 * consumers (spec S7). It resolves only three high-confidence shapes and drops everything else:
 *   - `py-local`  — bare `f()` → a module-level def named `f` in the SAME file.
 *   - `py-self`   — `self.m()` / `cls.m()` → a method on the enclosing class.
 *   - `py-import` — an imported symbol `f()` or module-alias attribute `m.f()` → a def in the
 *                   imported module's in-repo file (via the import table + module index).
 * Unknown receivers, external libs, dynamic dispatch, and duck-typed instance calls stay
 * UNRESOLVED. `resolvePythonCalls` returns only the shippable set (resolved, non-self,
 * SHIPPABLE_PROVENANCE); the internal resolver builds every edge for measurement parity with
 * the Ruby precedent. The parser optionally supplements these edges with scip-python; this is the
 * load-bearing call graph (spec execution Decision 2026-07-24, Fork B).
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
  ATTRIBUTE,
  CALL,
  CLASS_DEF,
  CLASS_TYPES,
  DEF_TYPES,
  FUNCTION_DEF,
  type PythonFile,
  type TsNode,
  defName,
  isAsyncDef,
  nearestAncestor,
  pythonClassChain,
  pythonFunctionId,
  pythonScopeChain,
  returnTypeText,
} from './python-cst.js';
import { buildImportTable, buildModuleIndex, resolveImportedTarget } from './python-imports.js';

// =============================================================================
// Structural extraction (Step 4, S4)
// =============================================================================

/**
 * Best-effort parameter NAMES + annotation TEXT from a def's `parameters` field child (mirrors
 * ruby paramInfos). The annotation is recorded verbatim (`typed_parameter` / `typed_default_
 * parameter` carry a `type` field); no resolution is attempted — a Python annotation is an
 * arbitrary expression and may be a forward-reference string.
 */
function paramInfos(def: TsNode): ParameterInfo[] {
  const params = def.childForFieldName?.('parameters');
  if (!params) return [];
  const out: ParameterInfo[] = [];
  for (let i = 0; i < params.namedChildCount; i++) {
    const c = params.namedChild(i);
    if (!c) continue;
    // `x` → identifier; `x: int` → typed_parameter (identifier descendant); `x=1` →
    // default_parameter (name field); `*args`/`**kwargs` → list/dictionary_splat_pattern.
    const nameNode =
      c.type === 'identifier' ? c : (c.childForFieldName?.('name') ?? c.descendantsOfType?.('identifier')?.[0]);
    const name = (nameNode?.text ?? undefined) as string | undefined;
    if (!name) continue;
    const isRest = c.type === 'list_splat_pattern' || c.type === 'dictionary_splat_pattern';
    const isOptional = c.type === 'default_parameter' || c.type === 'typed_default_parameter';
    const typeText = (c.childForFieldName?.('type')?.text ?? undefined) as string | undefined;
    out.push({ name, isOptional, isRest, ...(typeText ? { type: { text: typeText } } : {}) });
  }
  return out;
}

/** Build a `FunctionNode` for one `function_definition` (canonical scope-chain id). */
function defToFunctionNode(def: TsNode, relPath: string, idGen: StableIdGenerator): FunctionNode {
  const name = defName(def) ?? '(anonymous)';
  const inClass = nearestAncestor(def, CLASS_TYPES) !== undefined;
  const classChain = pythonClassChain(def);
  const id = pythonFunctionId(idGen, relPath, def);
  // The def node's own source slice. Capped at 20000 chars to guard against pathological bodies
  // bloating the output — matches the TS structural path (to-nodes.ts) and ruby-callgraph.
  const sourceCode = (def.text as string).slice(0, 20000);
  const returns = returnTypeText(def);
  return {
    id,
    versionedId: idGen.versionedId(id, def.text as string),
    name,
    kind: inClass ? 'method' : 'function',
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: def.startPosition.row + 1, endLine: def.endPosition.row + 1 },
    isAsync: isAsyncDef(def),
    isGenerator: false,
    parameters: paramInfos(def),
    ...(returns ? { returnType: { text: returns } } : {}),
    classId: classChain.length > 0 ? idGen.classId(relPath, classChain.join('.')) : undefined,
    visibility: inClass ? 'public' : undefined,
    sourceCode,
  };
}

// =============================================================================
// Def index (Step 4 → Step 7 foundation)
// =============================================================================

/** Repo-wide def index that the Tier-B call resolver reads. */
export interface PythonDefIndex {
  /** def id → FunctionNode (every function_definition), keyed by pythonFunctionId. */
  byId: Map<string, FunctionNode>;
  /** bare def name → def ids (unique-name / ambiguity signal for later steps). */
  byName: Map<string, string[]>;
  /** file-qualified class key (`${relPath}#${pythonClassChain.join('.')}`) → (direct-method name → def id). */
  methodsByClass: Map<string, Map<string, string>>;
  /** `${relPath}#${name}` → def id, MODULE-LEVEL defs only — for import-resolved + same-file lookup. */
  defByFileName: Map<string, string>;
}

/** The nearest lexical scope enclosing a def: a class, an enclosing def, or module scope. */
function nearestEnclosingScope(def: TsNode): 'class' | 'def' | undefined {
  let cur: TsNode | null = def.parent;
  while (cur) {
    if (cur.type === CLASS_DEF) return 'class';
    if (cur.type === FUNCTION_DEF) return 'def';
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Build the repo-wide def index (one walk per already-parsed file). De-duped by canonical id
 * (first occurrence wins) — this collapses same-scope `@overload` / `@singledispatch`
 * redefinitions onto one id, a documented boundary (spec Decision 2026-07-24).
 */
export function indexPythonDefs(files: PythonFile[], idGen: StableIdGenerator): PythonDefIndex {
  const byId = new Map<string, FunctionNode>();
  const byName = new Map<string, string[]>();
  const methodsByClass = new Map<string, Map<string, string>>();
  const defByFileName = new Map<string, string>();

  for (const { relPath, root } of files) {
    for (const def of root.descendantsOfType(FUNCTION_DEF) as TsNode[]) {
      const fn = defToFunctionNode(def, relPath, idGen);
      if (byId.has(fn.id)) continue; // de-dup, first wins (@overload collapse)
      byId.set(fn.id, fn);

      const list = byName.get(fn.name) ?? [];
      list.push(fn.id);
      byName.set(fn.name, list);

      // Direct methods (nearest enclosing scope is a class) register under the class chain, so
      // `self.m()` resolves to a genuine sibling method — NOT a closure/inner function that a
      // `self.` call could never reach.
      if (nearestEnclosingScope(def) === 'class') {
        // File-qualified: two files each with `class Config`/`Meta`/`Migration` must NOT share a
        // key, else file B's `self.method()` resolves to file A's method (cross-file collision).
        const classKey = `${relPath}#${pythonClassChain(def).join('.')}`;
        let m = methodsByClass.get(classKey);
        if (!m) {
          m = new Map<string, string>();
          methodsByClass.set(classKey, m);
        }
        if (!m.has(fn.name)) m.set(fn.name, fn.id);
      }

      // Module-level defs only: `import`/`from-import` bind top-level names, and a bare same-file
      // `f()` resolves to a module global (never a sibling method). First-wins.
      if (pythonScopeChain(def).length === 0) {
        const key = `${relPath}#${fn.name}`;
        if (!defByFileName.has(key)) defByFileName.set(key, fn.id);
      }
    }
  }

  return { byId, byName, methodsByClass, defByFileName };
}

// =============================================================================
// Tier-B call resolver (Step 7, S7)
// =============================================================================

/**
 * The Python Tier-B provenance tiers that are SHIPPED as resolved graph edges — each is
 * precision-first (name-verified, receiver-pinned). `resolvePythonCalls` drops every edge
 * whose provenance is not in this set (plus unresolved + self edges), so low-confidence /
 * dynamic sites never fabricate a caller. Tier-A (scip, when it lands) would REPLACE this set.
 */
export const SHIPPABLE_PROVENANCE = new Set<CallProvenance>(['py-import', 'py-self', 'py-local']);

/**
 * Whether a bare `name` is bound in the caller's LOCAL scope — a parameter, or a def nested
 * (at any control-flow depth) directly inside one of the enclosing functions. Python binds such
 * names function-locally, so a bare `name()` refers to that local, NOT a module-level def.
 * Precision-first: a shadowed bare call is DROPPED rather than mis-attributed to the module def.
 */
function isLocallyBound(name: string, callerDef: TsNode): boolean {
  let fn: TsNode | null = callerDef;
  while (fn) {
    if (fn.type === FUNCTION_DEF) {
      // (a) a PARAMETER of this function named `name` (its name identifier, not a type annotation).
      if (paramInfos(fn).some((p) => p.name === name)) return true;
      // (b) a function_definition named `name` whose NEAREST enclosing function is this one
      //     (defined directly in this function's body, control-flow blocks aside).
      const body = fn.childForFieldName?.('body');
      if (body) {
        for (const nested of body.descendantsOfType(FUNCTION_DEF) as TsNode[]) {
          if (defName(nested) !== name) continue;
          const owner = nearestAncestor(nested, DEF_TYPES);
          if (owner && owner.startIndex === fn.startIndex) return true;
        }
      }
    }
    fn = fn.parent;
  }
  return false;
}

/** Resolve a bare-identifier callee `f()` against same-file locals then the import table. */
function resolveBareCall(
  name: string,
  relPath: string,
  callerDef: TsNode,
  table: ReturnType<typeof buildImportTable>,
  moduleIndex: Map<string, string>,
  index: PythonDefIndex,
): { calleeId: string; provenance: CallProvenance; name: string } | undefined {
  // A local binding (param or nested def) shadows any module-level / imported `name` — the bare
  // call is to the LOCAL, which we can't pin to a def id. Drop it (precision-first) before lookup.
  if (isLocallyBound(name, callerDef)) return undefined;
  // (a) same-file module-level def — no import needed.
  const local = index.defByFileName.get(`${relPath}#${name}`);
  if (local) return { calleeId: local, provenance: 'py-local', name };
  // (b) imported symbol → its in-repo file's def. TYPE_CHECKING-only imports never make runtime edges.
  const imp = table.byLocal.get(name);
  if (!imp || imp.typeOnly) return undefined;
  const target = resolveImportedTarget(table, moduleIndex, name);
  if (!target?.filePath) return undefined;
  // The def in the target file is named by the imported SYMBOL, not the local alias
  // (`from a import f as g; g()` → look up `f`). Return the symbol so the precision guard matches.
  const sym = target.symbol ?? name;
  const hit = index.defByFileName.get(`${target.filePath}#${sym}`);
  return hit ? { calleeId: hit, provenance: 'py-import', name: sym } : undefined;
}

/** Resolve an attribute callee `recv.m()` — `self`/`cls` → class method, module alias → import. */
function resolveAttributeCall(
  fnField: TsNode,
  callerDef: TsNode,
  relPath: string,
  table: ReturnType<typeof buildImportTable>,
  moduleIndex: Map<string, string>,
  index: PythonDefIndex,
): { calleeId: string; provenance: CallProvenance; name: string } | undefined {
  const objNode = fnField.childForFieldName?.('object');
  const attrNode = fnField.childForFieldName?.('attribute');
  const name = attrNode?.text as string | undefined;
  const objText = objNode?.text as string | undefined;
  if (!name) return undefined;

  // `self.m()` / `cls.m()` → a method on the enclosing class. The class key is file-qualified with
  // the CALLER's relPath (self/cls methods are always same-file at the direct-method level).
  if (objText === 'self' || objText === 'cls') {
    const methods = index.methodsByClass.get(`${relPath}#${pythonClassChain(callerDef).join('.')}`);
    const hit = methods?.get(name);
    return hit ? { calleeId: hit, provenance: 'py-self', name } : undefined;
  }

  // `import a.b as m; m.f()` — the receiver is an imported MODULE alias (import table, no symbol).
  if (objNode?.type === 'identifier' && objText) {
    const imp = table.byLocal.get(objText);
    if (imp && imp.symbol === undefined && !imp.typeOnly) {
      const target = resolveImportedTarget(table, moduleIndex, `${objText}.${name}`);
      if (target?.filePath) {
        const hit = index.defByFileName.get(`${target.filePath}#${name}`);
        if (hit) return { calleeId: hit, provenance: 'py-import', name };
      }
    }
  }
  return undefined;
}

/**
 * Resolve every in-`def` call site through the precision-ordered tiers. Returns a CallEdge per
 * site (resolved → calleeId+provenance; otherwise a bare unresolved edge). The full set is for
 * MEASUREMENT parity with ruby; `resolvePythonCalls` ships only SHIPPABLE_PROVENANCE.
 */
function resolveAllPythonCalls(
  files: PythonFile[],
  index: PythonDefIndex,
  idGen: StableIdGenerator,
): { edges: CallEdge[]; outOfScopeCalls: number } {
  const moduleIndex = buildModuleIndex(files);
  const edges: CallEdge[] = [];
  // Every simple name this repo declares as a def. A callee name absent from it can have no
  // in-repo target, which is what separates "out of scope" from "missed" (BR-1).
  const callableNames = new Set([...index.byId.values()].map((fn) => fn.name));
  let outOfScopeCalls = 0;

  for (const file of files) {
    const { relPath, root } = file;
    const table = buildImportTable(file);

    for (const call of root.descendantsOfType(CALL) as TsNode[]) {
      const def = nearestAncestor(call, DEF_TYPES);
      if (!def) continue; // module-scope call site — no enclosing def, skipped
      const fnField = call.childForFieldName?.('function');
      if (!fnField) continue;

      const callerId = pythonFunctionId(idGen, relPath, def);
      const startLine = call.startPosition.row + 1;
      const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);
      const isMethodCall = fnField.type === ATTRIBUTE;

      let resolved: { calleeId: string; provenance: CallProvenance; name?: string } | undefined;
      let calledName: string | undefined;

      if (fnField.type === 'identifier') {
        calledName = fnField.text as string;
        resolved = resolveBareCall(calledName, relPath, def, table, moduleIndex, index);
        // Thread the resolved SYMBOL name back (aliased imports resolve `g()` → symbol `f`) so the
        // precision guard below compares the def's real name, not the call-site alias.
        if (resolved) calledName = resolved.name;
      } else if (fnField.type === ATTRIBUTE) {
        const r = resolveAttributeCall(fnField, def, relPath, table, moduleIndex, index);
        if (r) {
          resolved = r;
          calledName = r.name;
        } else {
          calledName = (fnField.childForFieldName?.('attribute')?.text ?? undefined) as string | undefined;
        }
      }

      let calleeId = resolved?.calleeId;
      let provenance = resolved?.provenance;

      // Precision guard (mirror ruby calleeTail): the resolved def's name must equal the called name.
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

/** The shipped Python call edges plus the language-neutral resolution counters (spec BR-2). */
export interface PythonCallResult {
  calls: CallEdge[];
  stats: CallResolutionStats;
}

/**
 * The SHIPPABLE call edges: resolved, non-self, high-confidence. Drops unresolved sites,
 * self-edges (a recursive fn is not its own caller — matches the TS SCIP + Ruby paths), and any
 * non-SHIPPABLE_PROVENANCE tier. Precision-first: false edges mislead `find_callers` more than
 * missing edges do (spec S7). This is the load-bearing Python call graph without a compiler.
 */
export function resolvePythonCalls(
  files: PythonFile[],
  index: PythonDefIndex,
  idGen: StableIdGenerator,
): PythonCallResult {
  const { edges, outOfScopeCalls } = resolveAllPythonCalls(files, index, idGen);
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
