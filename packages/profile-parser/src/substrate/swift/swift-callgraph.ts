/**
 * Swift internal call graph (Tier-B, tree-sitter CST only — no SCIP).
 *
 * Emits a `FunctionNode` for EVERY `function_declaration` so the graph has a real node
 * for every potential caller/callee. Resolves a call only when the CST alone types its receiver:
 *   1. direct construction — `Foo().method()` (receiver type = the constructed type) — `di`;
 *   2. container DI — `DI.shared.<accessor>.method()` resolved via a pre-pass that indexes
 *      the DI container's typed accessors (accessor name → concrete type) — `di`;
 *   3. `self.m()` / bare `m()` inside a type → that type, then its supertypes — `swift-member`;
 *   4. `Foo.m()` on an in-repo type → its static method — `swift-static`;
 *   5. `r.m()` where `r` is a parameter, local or property with a declared type, a local
 *      initialised by construction / `resolve(Foo.self)` / `Foo.shared`, or a chain of typed
 *      properties — `swift-type`; a protocol-typed receiver binds only to its sole in-repo
 *      implementation of `m` — `iface-impl`;
 *   6. bare `f()` → a free function in the same file, else the uniquely named one — `swift-local`.
 * Method lookup walks the type's declarations, extensions and syntactic supertypes (superclass,
 * conformed protocols and their extensions), so a protocol-extension default implementation is
 * reached from a conforming type. Closure parameters, inferred return types, RxSwift/Combine/
 * NotificationCenter dispatch and every other shape stay a DOCUMENTED Tier-B recall gap —
 * dropped, never fabricated (the engine tolerates `calls: []`).
 *
 * Ids are canonical via `swiftMethodId`, so a def's node id matches the same def's db-op
 * performer id — the two merge by id in the orchestrator.
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
  CALL_EXPR,
  FUNC_DECL,
  NAV_EXPR,
  PROPERTY_DECL,
  PROTOCOL_DECL,
  TYPE_CONTAINERS,
  TYPE_DECL,
  type TsNode,
  baseTypeIdentifier,
  callMethodName,
  callReceiver,
  callSuffix,
  computedBody,
  constructedType,
  enclosingTypeName,
  inheritedTypes,
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

/** A type's method def ids by name (overloads kept), split by instance vs static scope. */
export interface TypeMethods {
  instance: Map<string, string[]>;
  static: Map<string, string[]>;
}

/** A type's property types (property name → type name), split by instance vs static scope. */
interface TypeProperties {
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
  /** type name → what its declarations and extensions inherit from or conform to. */
  supertypes: Map<string, Set<string>>;
  /** protocol name → the types declaring a direct conformance to it (in any declaration). */
  conformers: Map<string, Set<string>>;
  protocolNames: Set<string>;
  /** type name → its typed properties (declared annotation, or a typed initialiser). */
  propertyTypes: Map<string, TypeProperties>;
  /** free (type-less) function name → its defs. */
  freeFunctions: Map<string, Array<{ id: string; relPath: string }>>;
  /** def id → its parameters' argument labels ('' for `_`), in order. */
  argumentLabels: Map<string, string[]>;
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

/**
 * The nominal type a declared type node names: `Foo`, `Foo?`, `Foo!`, `Foo<T>` and `Module.Foo`
 * → 'Foo'. Arrays, dictionaries, tuples and function types name no receiver type → undefined,
 * so `[Foo]` never lets `.map` bind to a method of `Foo`.
 */
function declaredTypeName(typeNode: TsNode | undefined): string | undefined {
  if (!typeNode) return undefined;
  if (typeNode.type === 'optional_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const c = typeNode.child(i);
      if (c?.isNamed) return declaredTypeName(c);
    }
    return undefined;
  }
  if (typeNode.type !== 'user_type') return undefined;
  let last: string | undefined;
  for (let i = 0; i < typeNode.childCount; i++) {
    const c = typeNode.child(i);
    if (c?.type === 'type_identifier') last = c.text as string;
  }
  return last;
}

/** The declared type of a function `parameter` (`_ a: Foo` → 'Foo'). */
function parameterType(param: TsNode): string | undefined {
  for (let i = param.childCount - 1; i >= 0; i--) {
    const c = param.child(i);
    if (c?.isNamed && String(c.type).endsWith('_type')) return declaredTypeName(c);
  }
  return undefined;
}

function lastNamedChild(node: TsNode): TsNode | undefined {
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (c?.isNamed) return c;
  }
  return undefined;
}

/** The member name of a `navigation_expression` (`a.b` → 'b'). */
function navMember(nav: TsNode): string | undefined {
  return nav.childForFieldName?.('suffix')?.childForFieldName?.('suffix')?.text as string | undefined;
}

/** Breadth-first walk of a type and its syntactic supertypes, nearest first. */
function* typeLineage(index: SwiftDefIndex, type: string): Generator<string> {
  const seen = new Set<string>();
  const queue = [type];
  while (queue.length > 0) {
    const t = queue.shift() as string;
    if (seen.has(t)) continue;
    seen.add(t);
    yield t;
    for (const s of index.supertypes.get(t) ?? []) queue.push(s);
  }
}

function lookupProperty(
  index: SwiftDefIndex,
  type: string,
  name: string,
  scope: 'instance' | 'static',
): string | undefined {
  for (const t of typeLineage(index, type)) {
    const hit = index.propertyTypes.get(t)?.[scope].get(name);
    if (hit) return hit;
  }
  return undefined;
}

/** The argument label of a `parameter` (`_ a: X` → '', `for key: X` → 'for', `b: X` → 'b'). */
function parameterLabel(param: TsNode): string | undefined {
  const name = param.childForFieldName?.('name');
  for (let i = 0; i < param.childCount; i++) {
    const c = param.child(i);
    if (c?.type === 'simple_identifier' && c.id !== name?.id) return c.text === '_' ? '' : (c.text as string);
  }
  return name?.text as string | undefined;
}

/** The labels a call passes in its parenthesised arguments ('' for an unlabeled one). */
function callArgumentLabels(call: TsNode): string[] {
  const out: string[] = [];
  const suffix = callSuffix(call);
  for (let i = 0; i < (suffix?.childCount ?? 0); i++) {
    const args = suffix.child(i);
    if (args?.type !== 'value_arguments') continue;
    for (let j = 0; j < args.childCount; j++) {
      const a = args.child(j);
      if (a?.type === 'value_argument') out.push((a.childForFieldName?.('name')?.text as string | undefined) ?? '');
    }
  }
  return out;
}

/**
 * Whether a call's labels can bind to a def's: in order, each call label must match a def label,
 * skipping def parameters the call leaves to their default. A trailing closure is outside the
 * parenthesised arguments, so it is not checked. Swift selects overloads by label, so this is what
 * keeps `defaults.set(x, forKey: k)` off a repo extension `set(_:for:)` of the same name.
 */
function labelsCompatible(defLabels: string[] | undefined, callLabels: string[]): boolean {
  if (!defLabels) return true;
  let i = 0;
  for (const label of callLabels) {
    while (i < defLabels.length && defLabels[i] !== label) i++;
    if (i === defLabels.length) return false;
    i++;
  }
  return true;
}

/**
 * The nearest def of `name` on the type's lineage whose labels fit the call. Two fitting
 * overloads on the same type differ only by parameter types, which a CST cannot tell apart, so
 * that abstains.
 */
function lookupMethod(
  index: SwiftDefIndex,
  type: string,
  name: string,
  scope: 'instance' | 'static',
  callLabels: string[],
): string | undefined {
  for (const t of typeLineage(index, type)) {
    const candidates = index.methodsByType.get(t)?.[scope].get(name) ?? [];
    const fitting = candidates.filter((id) => labelsCompatible(index.argumentLabels.get(id), callLabels));
    if (fitting.length === 1) return fitting[0];
    if (fitting.length > 1) return undefined;
  }
  return undefined;
}

/**
 * A protocol-typed receiver: the protocol declares the requirement but no body, so bind to the
 * implementation only when exactly one in-repo conformer (with its own lineage) provides `m`.
 */
function soleImplementation(
  index: SwiftDefIndex,
  protocol: string,
  name: string,
  callLabels: string[],
): string | undefined {
  const hits = new Set<string>();
  for (const conformer of index.conformers.get(protocol) ?? []) {
    if (index.protocolNames.has(conformer)) continue;
    const hit = lookupMethod(index, conformer, name, 'instance', callLabels);
    if (hit) hits.add(hit);
  }
  return hits.size === 1 ? [...hits][0] : undefined;
}

/** Names a function body binds locally, with the type each binding is known to have. */
interface Scope {
  enclosingType?: string;
  locals: Map<string, string>;
  /** Every parameter / local / pattern / closure-parameter name, typed or not. */
  shadowed: Set<string>;
}

const EMPTY_SCOPE: Scope = { locals: new Map(), shadowed: new Set() };

/** `x.resolve(Foo.self)` — a service-locator lookup whose single argument names the type. */
function resolvedLookupType(call: TsNode, index: SwiftDefIndex): string | undefined {
  if (callMethodName(call) !== 'resolve') return undefined;
  const args = callSuffix(call)?.descendantsOfType?.('value_arguments')?.[0] as TsNode | undefined;
  const argNodes: TsNode[] = [];
  for (let i = 0; i < (args?.childCount ?? 0); i++) {
    const c = args.child(i);
    if (c?.type === 'value_argument') argNodes.push(c);
  }
  if (argNodes.length !== 1) return undefined;
  const value = argNodes[0].childForFieldName?.('value');
  if (value?.type !== NAV_EXPR || navMember(value) !== 'self') return undefined;
  const target = value.childForFieldName?.('target');
  const name = target?.type === 'simple_identifier' ? (target.text as string) : undefined;
  return name && index.typeNames.has(name) ? name : undefined;
}

/** Whether a bare identifier in this scope refers to an in-repo TYPE (not a value of that name). */
function isTypeRef(name: string, scope: Scope, index: SwiftDefIndex): boolean {
  if (scope.shadowed.has(name) || !index.typeNames.has(name)) return false;
  return !(scope.enclosingType && lookupProperty(index, scope.enclosingType, name, 'instance'));
}

/** The receiver type an expression is known to have from declarations alone, else undefined. */
function typeOfExpr(node: TsNode | undefined, scope: Scope, index: SwiftDefIndex, depth = 0): string | undefined {
  if (!node || depth > 6) return undefined;
  switch (node.type) {
    case 'self_expression':
      return scope.enclosingType;
    case 'simple_identifier': {
      const name = node.text as string;
      if (scope.locals.has(name)) return scope.locals.get(name);
      if (scope.shadowed.has(name) || !scope.enclosingType) return undefined;
      return lookupProperty(index, scope.enclosingType, name, 'instance');
    }
    case 'postfix_expression': // `x!`
      return typeOfExpr(node.childForFieldName?.('target'), scope, index, depth + 1);
    case 'try_expression':
    case 'await_expression':
      return typeOfExpr(lastNamedChild(node), scope, index, depth + 1);
    case CALL_EXPR: {
      const ctor = constructedType(node);
      if (ctor) return index.typeNames.has(ctor) ? ctor : undefined;
      return resolvedLookupType(node, index);
    }
    case NAV_EXPR: {
      const member = navMember(node);
      const target = node.childForFieldName?.('target');
      if (!member || !target) return undefined;
      if (target.type === 'simple_identifier' && isTypeRef(target.text as string, scope, index)) {
        return lookupProperty(index, target.text as string, member, 'static'); // `Foo.shared`
      }
      const owner = typeOfExpr(target, scope, index, depth + 1);
      return owner ? lookupProperty(index, owner, member, 'instance') : undefined;
    }
    default:
      return undefined;
  }
}

/** Record a binding; a name bound twice to different types abstains rather than guesses. */
function bind(scope: Scope, name: string, type: string | undefined, conflicted: Set<string>): void {
  scope.shadowed.add(name);
  if (!type || conflicted.has(name)) return;
  const prior = scope.locals.get(name);
  if (prior && prior !== type) {
    scope.locals.delete(name);
    conflicted.add(name);
    return;
  }
  scope.locals.set(name, type);
}

/** The parameter / local scope of one function, built in source order so later locals see earlier ones. */
function functionScope(func: TsNode, enclosingType: string | undefined, index: SwiftDefIndex): Scope {
  const scope: Scope = { enclosingType, locals: new Map(), shadowed: new Set() };
  const conflicted = new Set<string>();
  for (let i = 0; i < func.childCount; i++) {
    const c = func.child(i);
    if (c?.type !== 'parameter') continue;
    const name = c.childForFieldName?.('name')?.text as string | undefined;
    if (name) bind(scope, name, parameterType(c), conflicted);
  }
  const body = func.childForFieldName?.('body');
  if (!body) return scope;
  const visit = (node: TsNode) => {
    if (node.type === FUNC_DECL) return; // a nested function has its own scope
    if (node.type === PROPERTY_DECL) {
      const name = propertyName(node);
      if (name) {
        const type =
          declaredTypeName(typeAnnotationNode(node)) ?? typeOfExpr(node.childForFieldName?.('value'), scope, index);
        bind(scope, name, type, conflicted);
      }
    } else if (node.type === 'if_statement' || node.type === 'guard_statement' || node.type === 'while_statement') {
      // `if let x = expr` / `guard let x = expr`: the bound name follows a value_binding_pattern.
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type !== 'value_binding_pattern') continue;
        const id = node.child(i + 1);
        if (id?.type !== 'simple_identifier') continue;
        // Shorthand `if let x {` unwraps the outer `x`, so it keeps that binding's type.
        const value = node.child(i + 2)?.text === '=' ? node.child(i + 3) : id;
        bind(scope, id.text as string, typeOfExpr(value, scope, index), conflicted);
      }
    } else if (node.type === 'pattern' || node.type === 'lambda_parameter') {
      // for-in / catch / case-let patterns and closure parameters: untyped here, so they only shadow.
      const ids =
        node.type === 'lambda_parameter'
          ? [node.childForFieldName?.('name')]
          : node.descendantsOfType('simple_identifier');
      for (const id of ids as TsNode[]) if (id) bind(scope, id.text as string, undefined, conflicted);
    }
    for (let i = 0; i < node.childCount; i++) visit(node.child(i));
  };
  visit(body);
  return scope;
}

/** Build the repo-wide def index (one walk per file, then a pass that types properties). */
export function indexSwiftDefs(files: SwiftFile[], idGen: StableIdGenerator, diRoot?: string): SwiftDefIndex {
  const index: SwiftDefIndex = {
    byId: new Map(),
    byName: new Map(),
    methodsByType: new Map(),
    typeNames: new Set(),
    diAccessorTypes: new Map(),
    supertypes: new Map(),
    conformers: new Map(),
    protocolNames: new Set(),
    propertyTypes: new Map(),
    freeFunctions: new Map(),
    argumentLabels: new Map(),
  };

  const typeMethods = (t: string): TypeMethods => {
    let m = index.methodsByType.get(t);
    if (!m) {
      m = { instance: new Map(), static: new Map() };
      index.methodsByType.set(t, m);
    }
    return m;
  };
  const pendingProps: Array<{ owner: string; prop: TsNode }> = [];

  for (const { relPath, root } of files) {
    // type names (class/struct/enum/actor + protocol) and their syntactic supertypes
    for (const ct of [TYPE_DECL, PROTOCOL_DECL]) {
      for (const tnode of root.descendantsOfType(ct) as TsNode[]) {
        const n = typeName(tnode);
        if (!n) continue;
        index.typeNames.add(n);
        if (ct === PROTOCOL_DECL) index.protocolNames.add(n);
        for (const s of inheritedTypes(tnode)) {
          if (s === n) continue;
          index.supertypes.set(n, (index.supertypes.get(n) ?? new Set()).add(s));
          index.conformers.set(s, (index.conformers.get(s) ?? new Set()).add(n));
        }
      }
    }

    // functions → byId, byName, methodsByType, freeFunctions
    for (const func of root.descendantsOfType(FUNC_DECL) as TsNode[]) {
      const fn = defToFunctionNode(func, relPath, idGen);
      const labels: string[] = [];
      for (let i = 0; i < func.childCount; i++) {
        const c = func.child(i);
        if (c?.type === 'parameter') labels.push(parameterLabel(c) ?? '');
      }
      if (!index.argumentLabels.has(fn.id)) index.argumentLabels.set(fn.id, labels);
      if (!index.byId.has(fn.id)) {
        index.byId.set(fn.id, fn);
        const list = index.byName.get(fn.name) ?? [];
        list.push(fn.id);
        index.byName.set(fn.name, list);
      }
      const type = enclosingTypeName(func);
      if (type) {
        const tm = typeMethods(type);
        const byName = isStaticDecl(func) ? tm.static : tm.instance;
        const ids = byName.get(fn.name) ?? [];
        if (!ids.includes(fn.id)) ids.push(fn.id);
        byName.set(fn.name, ids);
      } else if (!nearestAncestor(func, new Set([FUNC_DECL]))) {
        const list = index.freeFunctions.get(fn.name) ?? [];
        if (!list.some((f) => f.id === fn.id)) list.push({ id: fn.id, relPath });
        index.freeFunctions.set(fn.name, list);
      }
    }

    for (const prop of root.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
      if (nearestAncestor(prop, new Set([FUNC_DECL]))) continue; // a local, typed per function scope
      const owner = nearestAncestor(prop, TYPE_CONTAINERS);
      const ownerName = owner ? typeName(owner) : undefined;
      if (ownerName) pendingProps.push({ owner: ownerName, prop });

      // DI accessors: typed properties declared on the DI container type (or its extensions).
      if (diRoot && ownerName === diRoot) {
        const accessor = propertyName(prop);
        if (!accessor) continue;
        // Prefer a declared type annotation; else the constructed type in the getter body.
        let ret = baseTypeIdentifier(typeAnnotationNode(prop));
        if (!ret) {
          const body = computedBody(prop);
          const firstCtor = body?.descendantsOfType?.(CALL_EXPR)?.[0];
          ret = constructedType(firstCtor);
        }
        if (ret && !index.diAccessorTypes.has(accessor)) index.diAccessorTypes.set(accessor, ret);
      }
    }
  }

  // Property types need the full type set (a `Foo()` initialiser types only an in-repo `Foo`), and
  // one may be initialised from another (`static let x = Other.shared`), so settle in two passes.
  for (let pass = 0; pass < 2; pass++) {
    for (const { owner, prop } of pendingProps) {
      const name = propertyName(prop);
      if (!name) continue;
      const scope = isStaticDecl(prop) ? 'static' : 'instance';
      let props = index.propertyTypes.get(owner);
      if (!props) {
        props = { instance: new Map(), static: new Map() };
        index.propertyTypes.set(owner, props);
      }
      if (props[scope].has(name)) continue;
      const type =
        declaredTypeName(typeAnnotationNode(prop)) ??
        typeOfExpr(prop.childForFieldName?.('value'), { ...EMPTY_SCOPE, enclosingType: owner }, index);
      if (type) props[scope].set(name, type);
    }
  }

  return index;
}

type Hit = { calleeId: string; provenance: CallProvenance };

/** Resolve `recv.m()` through the receiver's known type. */
function resolveMemberCall(
  receiver: TsNode,
  method: string,
  scope: Scope,
  index: SwiftDefIndex,
  di: { root: string; field: string } | undefined,
  labels: string[],
): Hit | undefined {
  const ctor = constructedType(receiver);
  if (ctor) {
    const hit = index.typeNames.has(ctor) ? lookupMethod(index, ctor, method, 'instance', labels) : undefined;
    return hit ? { calleeId: hit, provenance: 'di' } : undefined; // direct construction `Foo().m()`
  }
  if (di) {
    // `DI.shared.<accessor>` — exact 3-part chain only, for precision.
    const parts = (receiver.text as string).split('.');
    if (parts.length === 3 && parts[0] === di.root && parts[1] === di.field) {
      const type = index.diAccessorTypes.get(parts[2]);
      const hit = type ? lookupMethod(index, type, method, 'instance', labels) : undefined;
      if (hit) return { calleeId: hit, provenance: 'di' };
    }
  }
  if (receiver.type === 'self_expression') {
    const hit = scope.enclosingType ? lookupMethod(index, scope.enclosingType, method, 'instance', labels) : undefined;
    return hit ? { calleeId: hit, provenance: 'swift-member' } : undefined;
  }
  if (receiver.type === 'simple_identifier' && isTypeRef(receiver.text as string, scope, index)) {
    const hit = lookupMethod(index, receiver.text as string, method, 'static', labels);
    return hit ? { calleeId: hit, provenance: 'swift-static' } : undefined;
  }
  const type = typeOfExpr(receiver, scope, index);
  if (!type) return undefined;
  const hit = lookupMethod(index, type, method, 'instance', labels);
  if (hit) return { calleeId: hit, provenance: 'swift-type' };
  if (index.protocolNames.has(type)) {
    const impl = soleImplementation(index, type, method, labels);
    if (impl) return { calleeId: impl, provenance: 'iface-impl' };
  }
  return undefined;
}

/** Resolve a bare `m()`: a member of the enclosing type, else a free function. */
function resolveBareCall(
  name: string,
  func: TsNode,
  scope: Scope,
  index: SwiftDefIndex,
  relPath: string,
  labels: string[],
): Hit | undefined {
  if (scope.shadowed.has(name)) return undefined; // a closure-typed local or parameter, not a def
  if (scope.enclosingType) {
    const hit = lookupMethod(index, scope.enclosingType, name, isStaticDecl(func) ? 'static' : 'instance', labels);
    if (hit) return { calleeId: hit, provenance: 'swift-member' };
  }
  const free = (index.freeFunctions.get(name) ?? []).filter((f) =>
    labelsCompatible(index.argumentLabels.get(f.id), labels),
  );
  const sameFile = free.filter((f) => f.relPath === relPath);
  if (sameFile.length === 1) return { calleeId: sameFile[0].id, provenance: 'swift-local' };
  if (sameFile.length === 0 && free.length === 1) return { calleeId: free[0].id, provenance: 'swift-local' };
  return undefined;
}

/**
 * Resolve in-`func` call sites through the Tier-B idioms in the file header. Returns a resolved
 * `CallEdge` per site that resolves; unresolved / self-edge sites are DROPPED (never fabricated).
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
    const scopes = new Map<number, Scope>();
    for (const call of root.descendantsOfType(CALL_EXPR) as TsNode[]) {
      const func = nearestAncestor(call, new Set([FUNC_DECL]));
      if (!func) continue; // top-level / property-getter call site — out of Tier-B scope
      const head = call.child(0);
      const bareName = head?.type === 'simple_identifier' ? (head.text as string) : undefined;
      // A bare `Foo(…)` is a construction, not a call of a def (uncounted — LIM-6).
      if (bareName && (index.typeNames.has(bareName) || /^[A-Z]/.test(bareName))) continue;
      const method = bareName ?? callMethodName(call);
      if (!method) continue;
      // Observation only (BR-2/BR-5): the enumerated site is counted before any drop below.
      if (measurement) {
        measurement.callSites++;
        if (!index.byName.has(method)) measurement.outOfScopeCalls++; // declared nowhere in repo (BR-1)
      }
      if (!index.byName.has(method)) continue;

      let scope = scopes.get(func.id);
      if (!scope) {
        scope = functionScope(func, enclosingTypeName(func), index);
        scopes.set(func.id, scope);
      }
      const labels = callArgumentLabels(call);
      let hit: Hit | undefined;
      if (bareName) {
        hit = resolveBareCall(bareName, func, scope, index, relPath, labels);
      } else {
        const receiver = callReceiver(call);
        hit = receiver ? resolveMemberCall(receiver, method, scope, index, di, labels) : undefined;
      }
      if (!hit) continue;

      const callerId = swiftMethodId(idGen, relPath, func);
      if (callerId === hit.calleeId) continue; // no self-edge

      // Precision check: the resolved def's name must equal the call's method name.
      if (index.byId.get(hit.calleeId)?.name !== method) continue;

      const startLine = call.startPosition.row + 1;
      const calleeExpression = (call.text as string).split('\n')[0].slice(0, 120);
      if (measurement) measurement.resolvedCalls++; // a shipped edge for this site
      edges.push({
        id: idGen.callEdgeId(callerId, calleeExpression, `${relPath}:${startLine}`),
        callerId,
        calleeId: hit.calleeId,
        provenance: hit.provenance,
        calleeExpression,
        isMethodCall: !bareName,
        location: { filePath: relPath, startLine, endLine: call.endPosition.row + 1 },
      });
    }
  }
  return edges;
}
