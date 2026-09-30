/**
 * Swift internal call graph (Tier-B, tree-sitter CST only — no SCIP).
 *
 * Emits a `FunctionNode` for EVERY `function_declaration` so the graph has a real node
 * for every potential caller/callee. Resolves calls through only the two high-precision
 * idioms a CST can type without a symbol index:
 *   1. direct construction — `Foo().method()` (receiver type = the constructed type);
 *   2. container DI — `DI.shared.<accessor>.method()` resolved via a pre-pass that indexes
 *      the DI container's typed accessors (accessor name → concrete type).
 * Bare/`self` calls, RxSwift/Combine/NotificationCenter dispatch, and every other shape are
 * a DOCUMENTED Tier-B recall gap — dropped, never fabricated (the engine tolerates `calls: []`).
 *
 * Ids are canonical via `swiftMethodId`, so a def's node id matches the same def's db-op
 * performer id — the two merge by id in the orchestrator.
 */
import type { CallEdge, CallResolutionStats, FunctionNode, ParameterInfo, StableIdGenerator } from '@coredoc/core';
import {
  CALL_EXPR,
  FUNC_DECL,
  PROPERTY_DECL,
  TYPE_CONTAINERS,
  type TsNode,
  baseTypeIdentifier,
  callMethodName,
  callReceiver,
  computedBody,
  constructedType,
  enclosingTypeName,
  isStaticDecl,
  nameOf,
  nearestAncestor,
  propertyName,
  swiftMethodId,
  typeAnnotationNode,
  typeName,
} from './swift-cst.js';

/** Best-effort parameter names from a `function_declaration`'s `parameter` children. */
function paramInfos(func: TsNode): ParameterInfo[] {
  const out: ParameterInfo[] = [];
  for (let i = 0; i < func.childCount; i++) {
    const c = func.child(i);
    if (c?.type !== 'parameter') continue;
    const name = (c.childForFieldName?.('name')?.text ?? c.childForFieldName?.('external_name')?.text) as
      | string
      | undefined;
    if (name) out.push({ name, isOptional: false, isRest: false });
  }
  return out;
}

/** Whether a function's signature (before its body) contains the `async` keyword. */
function isAsyncFunc(func: TsNode): boolean {
  const body = func.childForFieldName?.('body');
  const sig = body ? (func.text as string).slice(0, body.startIndex - func.startIndex) : (func.text as string);
  return /\basync\b/.test(sig);
}

/** Build a `FunctionNode` for one `function_declaration` (canonical static-aware id). */
function defToFunctionNode(func: TsNode, relPath: string, idGen: StableIdGenerator): FunctionNode {
  const name = nameOf(func) ?? '(anonymous)';
  const type = enclosingTypeName(func);
  const id = swiftMethodId(idGen, relPath, func);
  // Cap at 20000 chars to guard against pathological bodies bloating output (matches the TS/Ruby paths).
  const sourceCode = (func.text as string).slice(0, 20000);
  const base: FunctionNode = {
    id,
    versionedId: idGen.versionedId(id, func.text as string),
    name,
    kind: type ? 'method' : 'function',
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: func.startPosition.row + 1, endLine: func.endPosition.row + 1 },
    isAsync: isAsyncFunc(func),
    isGenerator: false,
    parameters: paramInfos(func),
    sourceCode,
  };
  if (type) {
    base.classId = idGen.classId(relPath, type);
    base.isStatic = isStaticDecl(func);
    base.visibility = 'public';
  } else {
    base.isExported = true;
  }
  return base;
}

/** A type's method def ids, split by instance vs static scope. */
export interface TypeMethods {
  instance: Map<string, string>;
  static: Map<string, string>;
}

/** Repo-wide def index the call resolver reads. */
export interface SwiftDefIndex {
  /** def id → FunctionNode (every function_declaration). */
  byId: Map<string, FunctionNode>;
  /** bare method name → def ids. */
  byName: Map<string, string[]>;
  /** type name → its methods. */
  methodsByType: Map<string, TypeMethods>;
  /** every declared type name (class/struct/enum/actor/protocol) — for construction resolution. */
  typeNames: Set<string>;
  /** DI container accessor name → concrete return type (`employeeService` → `EmployeeService`). */
  diAccessorTypes: Map<string, string>;
}

/** Parsed file input shared across the substrate (parse once, reuse the root). */
export interface SwiftFile {
  relPath: string;
  source: string;
  root: TsNode;
}

/** The DI container root + accessor field from a `containerAccessor` like 'DI.shared'. */
export function parseDiContainer(containerAccessor: string | undefined): { root: string; field: string } | undefined {
  if (!containerAccessor) return undefined;
  const parts = containerAccessor.split('.');
  if (parts.length !== 2) return undefined;
  return { root: parts[0], field: parts[1] };
}

/** Build the repo-wide def index (one walk per file). */
export function indexSwiftDefs(files: SwiftFile[], idGen: StableIdGenerator, diRoot?: string): SwiftDefIndex {
  const byId = new Map<string, FunctionNode>();
  const byName = new Map<string, string[]>();
  const methodsByType = new Map<string, TypeMethods>();
  const typeNames = new Set<string>();
  const diAccessorTypes = new Map<string, string>();

  const typeMethods = (t: string): TypeMethods => {
    let m = methodsByType.get(t);
    if (!m) {
      m = { instance: new Map(), static: new Map() };
      methodsByType.set(t, m);
    }
    return m;
  };

  for (const { relPath, root } of files) {
    // type names (class/struct/enum/actor + protocol)
    for (const ct of TYPE_CONTAINERS) {
      for (const tnode of root.descendantsOfType(ct) as TsNode[]) {
        const n = typeName(tnode);
        if (n) typeNames.add(n);
      }
    }

    // functions → byId, byName, methodsByType
    for (const func of root.descendantsOfType(FUNC_DECL) as TsNode[]) {
      const fn = defToFunctionNode(func, relPath, idGen);
      if (!byId.has(fn.id)) {
        byId.set(fn.id, fn);
        const list = byName.get(fn.name) ?? [];
        list.push(fn.id);
        byName.set(fn.name, list);
      }
      const type = enclosingTypeName(func);
      if (type) {
        const tm = typeMethods(type);
        (isStaticDecl(func) ? tm.static : tm.instance).set(fn.name, fn.id);
      }
    }

    // DI accessors: typed properties declared on the DI container type (or its extensions).
    if (diRoot) {
      for (const prop of root.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
        const owner = nearestAncestor(prop, TYPE_CONTAINERS);
        if (!owner || typeName(owner) !== diRoot) continue;
        const accessor = propertyName(prop);
        if (!accessor) continue;
        // Prefer a declared type annotation; else the constructed type in the getter body.
        let ret = baseTypeIdentifier(typeAnnotationNode(prop));
        if (!ret) {
          const body = computedBody(prop);
          const firstCtor = body?.descendantsOfType?.(CALL_EXPR)?.[0];
          ret = constructedType(firstCtor);
        }
        if (ret && !diAccessorTypes.has(accessor)) diAccessorTypes.set(accessor, ret);
      }
    }
  }

  return { byId, byName, methodsByType, typeNames, diAccessorTypes };
}

/**
 * Resolve in-`func` call sites through the two high-precision Tier-B idioms. Returns a
 * resolved `CallEdge` (provenance 'di' — receiver type known via construction / DI accessor)
 * per site that resolves; unresolved / self-edge sites are DROPPED (never fabricated).
 */
export function resolveSwiftCalls(
  files: SwiftFile[],
  index: SwiftDefIndex,
  idGen: StableIdGenerator,
  di?: { root: string; field: string },
  measurement?: CallResolutionStats,
): CallEdge[] {
  const edges: CallEdge[] = [];
  for (const { relPath, root } of files) {
    for (const call of root.descendantsOfType(CALL_EXPR) as TsNode[]) {
      const func = nearestAncestor(call, new Set([FUNC_DECL]));
      if (!func) continue; // top-level / property-getter call site — out of Tier-B scope
      const method = callMethodName(call);
      if (!method) continue; // bare construction, not a method call (uncounted — LIM-6)
      // Observation only (BR-2/BR-5): the enumerated site is counted before any drop below.
      if (measurement) {
        measurement.callSites++;
        if (!index.byName.has(method)) measurement.outOfScopeCalls++; // declared nowhere in repo (BR-1)
      }
      const receiver = callReceiver(call);
      if (!receiver) continue;

      // Resolve the receiver's concrete type.
      let receiverType: string | undefined;
      const ctor = constructedType(receiver);
      if (ctor && index.typeNames.has(ctor)) {
        receiverType = ctor; // direct construction `Foo().method()`
      } else if (di) {
        // `DI.shared.<accessor>` — exact 3-part chain only, for precision.
        const parts = (receiver.text as string).split('.');
        if (parts.length === 3 && parts[0] === di.root && parts[1] === di.field) {
          receiverType = index.diAccessorTypes.get(parts[2]);
        }
      }
      if (!receiverType) continue;

      const calleeId = index.methodsByType.get(receiverType)?.instance.get(method);
      if (!calleeId) continue;

      const callerId = swiftMethodId(idGen, relPath, func);
      if (callerId === calleeId) continue; // no self-edge

      // Precision check: the resolved def's name must equal the call's method name.
      if (index.byId.get(calleeId)?.name !== method) continue;

      const startLine = call.startPosition.row + 1;
      const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);
      if (measurement) measurement.resolvedCalls++; // a shipped edge for this site
      edges.push({
        id: idGen.callEdgeId(callerId, calleeExpression, `${relPath}:${startLine}`),
        callerId,
        calleeId,
        provenance: 'di',
        calleeExpression,
        isMethodCall: true,
        location: { filePath: relPath, startLine, endLine: call.endPosition.row + 1 },
      });
    }
  }
  return edges;
}
