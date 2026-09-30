/**
 * Rust entrypoint extraction — smart-contract handlers, HTTP routes and tonic gRPC services.
 * Generic Rust: the route attributes, router methods and contract frameworks are
 * profile-configurable and no client names are hardcoded.
 *
 * ## Contract handlers are `queue`, never `event`
 *
 * `EntrypointType` is a closed set with no contract member, and `event` — the obvious
 * candidate, and what Celery tasks use — is counted in NO scorecard row
 * (`emittedCountsFromRepo` reads http/queue/entities/dbOperations/externalCalls/cli/grpc/
 * graphql). Emitting contract instructions as `event` would make them score as nothing at all.
 * `queue` is honest rather than a fudge: a queue entrypoint is "a handler dispatched by name on
 * a channel", which is exactly what a contract instruction is — the same modelling this repo
 * already applies to Electron IPC handlers (`system: 'electron-ipc'`, channel as topic).
 *
 * Every contract topic is NAMESPACED (`my_program::initialize`, never bare `initialize`).
 * The linker also scopes by system, but namespacing remains part of the public contract
 * address and prevents collisions between programs using the same instruction name.
 *
 * The whole contract lane is GATED on the framework's crate appearing in a `Cargo.toml`
 * dependency table. `#[program]` is a plausible attribute name in unrelated code, and a
 * fabricated smart contract is the one claim a reader scrutinizes hardest.
 */
import type {
  Entrypoint,
  GrpcEntrypointDetails,
  HttpEntrypointDetails,
  HttpMethod,
  QueueEntrypointDetails,
  StableIdGenerator,
} from '@coredoc/core';
import {
  CALL_EXPRESSION,
  FIELD_EXPRESSION,
  FUNCTION_ITEM,
  IMPL_ITEM,
  MOD_ITEM,
  type RustFile,
  type TsNode,
  attributeName,
  attributeStringArgs,
  attributesOf,
  baseTypeName,
  findAttribute,
  hasAttribute,
  implTraitName,
  implTypeName,
  isPublic,
  itemName,
  nearestAncestor,
  rustFunctionId,
  rustStringValue,
} from './rust-cst.js';
import { type RustCrate, crateCodeName, dependsOnAny } from './rust-crates.js';
import type { RouterRegistrationCall } from '../../types/rust-profile.js';

export interface RustEntrypointConfig {
  /** Attribute macros carrying a route. Default: the HTTP verbs plus `route`. */
  routeAttributes?: string[];
  /** Call-shape router builders. Default: ['route','nest','mount','service','scope']. */
  routerMethods?: string[];
  /** Hand-rolled registration call shapes (`r.insert(Method::GET, path, handler)`). No default. */
  registrationCalls?: RouterRegistrationCall[];
  /** Contract frameworks to detect. Default: all three (each still gated on its crate). */
  contractFrameworks?: string[];
  /** Trait-name suffixes that mark a generated tonic service impl. Default: ['Server']. */
  grpcServiceSuffixes?: string[];
  /** The repo's crates — the dependency gate for the contract lane. */
  crates: RustCrate[];
  /** repo-relative file → owning crate name, for namespacing CosmWasm topics. */
  crateNameOf?: Map<string, string>;
}

const DEFAULT_ROUTE_ATTRIBUTES = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route'];
const DEFAULT_ROUTER_METHODS = ['route', 'nest', 'mount', 'service', 'scope'];
const DEFAULT_CONTRACT_FRAMEWORKS = ['anchor', 'ink', 'cosmwasm'];
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** Which crate must be a declared dependency before a contract detector may run. */
const CONTRACT_GATE_CRATES: Record<string, string[]> = {
  anchor: ['anchor-lang', 'solana-program'],
  ink: ['ink', 'ink_lang'],
  cosmwasm: ['cosmwasm-std'],
};

/** Ensure a leading slash and collapse duplicate slashes. */
function normalizePath(p: string): string {
  return `/${p.trim()}`.replace(/\/{2,}/g, '/');
}

/**
 * Rust route params to the `{param}` template the cross-repo linker joins on:
 * axum/actix `{id}` is already the target form; rocket's `<id>` / `<id..>` converts.
 */
function templatize(raw: string): string {
  return raw.replace(/<([^>]+)>/g, (_m, inner: string) => `{${inner.replace(/\.\.$/, '').split(/\s+/)[0]}}`);
}

/** The method name of a `recv.m(...)` call, else undefined. */
function calleeMethodName(call: TsNode): string | undefined {
  const fn = call.childForFieldName?.('function');
  if (fn?.type !== FIELD_EXPRESSION) return undefined;
  return fn.childForFieldName?.('field')?.text as string | undefined;
}

/** A call's positional argument nodes, in order. */
function callArgs(call: TsNode): TsNode[] {
  const args = call.childForFieldName?.('arguments');
  const out: TsNode[] = [];
  const n = args?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = args.namedChild(i) as TsNode | undefined;
    if (c) out.push(c);
  }
  return out;
}

/** A node's value when it IS a string literal (a computed expression stays undefined). */
function literalValue(node: TsNode | undefined): string | undefined {
  if (node?.type !== 'string_literal' && node?.type !== 'raw_string_literal') return undefined;
  return rustStringValue(node);
}

/** The first argument's string value, when it is a literal. */
function firstStringArgValue(call: TsNode): string | undefined {
  return literalValue(callArgs(call)[0]);
}

// =============================================================================
// Contract handlers → `queue`
// =============================================================================

/** Build one contract entrypoint. */
function contractEntrypoint(
  idGen: StableIdGenerator,
  system: string,
  topic: string,
  relPath: string,
  fnNode: TsNode,
): Entrypoint {
  const id = idGen.queueEntrypointId(system, topic, relPath);
  const details: QueueEntrypointDetails = { type: 'queue', system, topic };
  return {
    id,
    versionedId: idGen.versionedId(id, `${system}:${topic}`),
    type: 'queue',
    handlerId: rustFunctionId(idGen, relPath, fnNode),
    location: {
      filePath: relPath,
      startLine: fnNode.startPosition.row + 1,
      endLine: fnNode.endPosition.row + 1,
    },
    details,
  };
}

/** The declared type of a fn's FIRST parameter (`ctx: Context<Initialize>` → 'Context<Initialize>'). */
function firstParamType(fn: TsNode): string | undefined {
  const params = fn.childForFieldName?.('parameters');
  const n = params?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = params.namedChild(i) as TsNode | undefined;
    if (c?.type === 'self_parameter') continue;
    if (c?.type !== 'parameter') continue;
    return c.childForFieldName?.('type')?.text as string | undefined;
  }
  return undefined;
}

/**
 * Anchor: every `pub fn` in a `#[program]` mod whose FIRST parameter is a `Context<_>`.
 *
 * The `Context<T>` gate is not a heuristic — it is what distinguishes an instruction from a
 * helper fn sharing the module, and the type argument names the instruction's
 * `#[derive(Accounts)]` struct, so the link is syntactically decidable rather than name-matched.
 */
function anchorEntrypoints(file: RustFile, idGen: StableIdGenerator): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const mod of file.root.descendantsOfType(MOD_ITEM) as TsNode[]) {
    if (!hasAttribute(mod, ['program'])) continue;
    const modName = itemName(mod);
    const body = mod.childForFieldName?.('body') as TsNode | undefined;
    if (!modName || !body) continue;
    const n = body.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      const fn = body.namedChild(i) as TsNode | undefined;
      if (fn?.type !== FUNCTION_ITEM || !isPublic(fn)) continue;
      const paramType = firstParamType(fn);
      if (!paramType || baseTypeName(paramType) !== 'Context') continue;
      const name = itemName(fn);
      if (!name) continue;
      out.push(contractEntrypoint(idGen, 'solana-anchor', `${modName}::${name}`, file.relPath, fn));
    }
  }
  return out;
}

/** ink!: `#[ink(message)]` / `#[ink(constructor)]` methods, namespaced by their `impl` type. */
function inkEntrypoints(file: RustFile, idGen: StableIdGenerator): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const fn of file.root.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
    const attr = findAttribute(fn, ['ink']);
    if (!attr) continue;
    const args = (attr.childForFieldName?.('arguments')?.text ?? '') as string;
    if (!/\b(message|constructor)\b/.test(args)) continue;
    const name = itemName(fn);
    if (!name) continue;
    const implNode = nearestAncestor(fn, new Set([IMPL_ITEM]));
    const typeName = implNode ? implTypeName(implNode) : undefined;
    out.push(contractEntrypoint(idGen, 'ink', typeName ? `${typeName}::${name}` : name, file.relPath, fn));
  }
  return out;
}

/**
 * CosmWasm: `#[entry_point]` fns. The real-world shape is
 * `#[cfg_attr(not(feature = "library"), entry_point)]`, which `attributeMatches` handles — a
 * bare path match would silently miss the majority of contracts.
 */
function cosmwasmEntrypoints(file: RustFile, idGen: StableIdGenerator, crateName: string): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const fn of file.root.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
    if (!hasAttribute(fn, ['entry_point'])) continue;
    const name = itemName(fn);
    if (!name) continue;
    // `instantiate` / `execute` / `query` are the SAME three names in every CosmWasm contract
    // on earth, so the crate namespace is what keeps the cross-repo topic join meaningful.
    out.push(contractEntrypoint(idGen, 'cosmwasm', `${crateName}::${name}`, file.relPath, fn));
  }
  return out;
}

// =============================================================================
// HTTP
// =============================================================================

/** Build one http entrypoint; `handlerId` falls back to a synthetic id when unresolvable. */
function httpEntrypoint(
  idGen: StableIdGenerator,
  method: HttpMethod,
  fullPath: string,
  relPath: string,
  node: TsNode,
  handlerId?: string,
): Entrypoint {
  const id = idGen.httpEntrypointId(method, fullPath, relPath);
  const details: HttpEntrypointDetails = { type: 'http', method, path: fullPath, fullPath };
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${fullPath}`),
    type: 'http',
    handlerId: handlerId ?? idGen.functionId(relPath, `${method} ${fullPath}`),
    location: { filePath: relPath, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 },
    details,
  };
}

/**
 * Base paths a handler NAME is mounted under, from `.mount("/base", routes![a, b])` (rocket)
 * and `web::scope("/api")…​.service(handler)` (actix).
 *
 * Composing the base onto the handler's own `#[get("/x")]` is what makes the emitted route the
 * one the server actually serves. Emitting the mount itself as an endpoint would invent a route
 * nothing serves AND leave the real ones unprefixed — wrong at both ends of the cross-repo join.
 */
function mountPrefixes(files: RustFile[], routerMethods: string[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  // A handler NAME mounted under two DIFFERENT bases is not statically decidable from the name
  // alone (mounts routinely name handlers in other modules, so the map cannot be file-keyed).
  // Same rule as a prefix held in a variable: emit the leaf path unprefixed rather than pick one
  // of the two and be wrong about which routes live under which base.
  const ambiguous = new Set<string>();
  const mountMethods = routerMethods.filter((m) => m !== 'route' && m !== 'service');
  for (const file of files) {
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const method = calleeMethodName(call) ?? calleeScopedName(call);
      if (!method || !mountMethods.includes(method)) continue;
      const base = firstStringArgValue(call);
      if (base === undefined) continue;
      const prefix = normalizePath(templatize(base));
      // Handler names appear either inside the mount's own arguments (`routes![a, b]`) or
      // chained onto its result (`web::scope("/api").service(handler)`), so both the argument
      // list and the whole enclosing call chain are searched.
      const scopes = [callArgs(call)[1], outermostChainNode(call)];
      for (const scope of scopes) {
        for (const name of handlerNamesIn(scope)) {
          const existing = prefixes.get(name);
          if (existing === undefined) prefixes.set(name, prefix);
          else if (existing !== prefix) ambiguous.add(name);
        }
      }
    }
  }
  for (const name of ambiguous) prefixes.delete(name);
  return prefixes;
}

/** The outermost node of the method-call chain `call` participates in (its receiver-chain root). */
function outermostChainNode(call: TsNode): TsNode {
  let cur: TsNode = call;
  while (cur.parent && (cur.parent.type === FIELD_EXPRESSION || cur.parent.type === CALL_EXPRESSION)) {
    cur = cur.parent;
  }
  return cur;
}

/** The name of a `mod::fn(...)` scoped call (`web::scope("/x")` → 'scope'). */
function calleeScopedName(call: TsNode): string | undefined {
  const fn = call.childForFieldName?.('function');
  if (fn?.type !== 'scoped_identifier') return undefined;
  return fn.childForFieldName?.('name')?.text as string | undefined;
}

/** Handler identifiers referenced inside a mount's argument subtree. */
function handlerNamesIn(node: TsNode | undefined | null): string[] {
  if (!node) return [];
  const out = new Set<string>();
  for (const macro of (node.descendantsOfType?.('macro_invocation') ?? []) as TsNode[]) {
    if ((macro.childForFieldName?.('macro')?.text as string | undefined) !== 'routes') continue;
    const tree = macro.child(macro.childCount - 1) as TsNode;
    for (const id of (tree.descendantsOfType?.('identifier') ?? []) as TsNode[]) out.add(id.text as string);
  }
  for (const call of (node.descendantsOfType?.(CALL_EXPRESSION) ?? []) as TsNode[]) {
    if (calleeMethodName(call) !== 'service') continue;
    const arg = callArgs(call)[0];
    if (arg?.type === 'identifier') out.add(arg.text as string);
  }
  return [...out];
}

/**
 * The base path a `.route(…)` site inherits. Two composition shapes, and they are NOT
 * interchangeable — conflating them prefixes routes that are not under the prefix:
 *
 *   - ARGUMENT composition (axum `.nest("/a", Router::new().route("/b", …))`, rocket `.mount`):
 *     the prefix applies to routes nested INSIDE the mount's argument list. In the chained form
 *     `Router::new().nest("/a", r).route("/b", …)` the `.nest(…)` call is the RECEIVER of
 *     `.route`, so `/b` is not under `/a` — hence the containment check.
 *   - CHAIN composition (actix `web::scope("/api").route("/x", …)`): the prefix applies to
 *     routes chained onto the scope's result, i.e. reachable down `.route`'s receiver chain.
 *
 * Only string-literal prefixes compose; a prefix held in a variable is not statically decidable,
 * so the leaf path is emitted unprefixed rather than invented.
 */
function routeBasePath(node: TsNode, routerMethods: string[]): string {
  const argMounts: string[] = routerMethods.filter((m) => m === 'nest' || m === 'mount');
  const chainMounts: string[] = routerMethods.filter((m) => m === 'scope');
  const parts: string[] = [];

  // Argument composition — walk ancestors, keeping only mounts whose ARGUMENTS contain `node`.
  let cur: TsNode | null = node.parent;
  while (cur) {
    if (cur.type === CALL_EXPRESSION) {
      const method = calleeMethodName(cur) ?? calleeScopedName(cur);
      const args = cur.childForFieldName?.('arguments') as TsNode | undefined;
      const contains = args && node.startIndex >= args.startIndex && node.endIndex <= args.endIndex;
      if (method && argMounts.includes(method) && contains) {
        const base = firstStringArgValue(cur);
        if (base !== undefined) parts.unshift(templatize(base));
      }
    }
    cur = cur.parent;
  }

  // Chain composition — walk `node`'s own receiver chain down to its root.
  const chain: string[] = [];
  let recv: TsNode | undefined = node;
  while (recv) {
    if (recv.type === CALL_EXPRESSION) {
      const method = calleeMethodName(recv) ?? calleeScopedName(recv);
      if (method && chainMounts.includes(method)) {
        const base = firstStringArgValue(recv);
        if (base !== undefined) chain.unshift(templatize(base));
      }
      const fn = recv.childForFieldName?.('function') as TsNode | undefined;
      recv = fn?.type === FIELD_EXPRESSION ? (fn.childForFieldName?.('value') as TsNode | undefined) : undefined;
      continue;
    }
    recv = undefined;
  }

  return [...parts, ...chain].join('/');
}

/** The HTTP verbs named by a route's second argument (`get(h)`, `web::post().to(h)`, `get(a).post(b)`). */
function combinatorMethods(arg: TsNode | undefined): HttpMethod[] {
  if (!arg) return [];
  const out = new Set<HttpMethod>();
  const consider = (name: string | undefined): void => {
    if (name && HTTP_VERBS.has(name)) out.add(name.toUpperCase() as HttpMethod);
  };
  if (arg.type === 'identifier') consider(arg.text as string);
  for (const call of (arg.descendantsOfType?.(CALL_EXPRESSION) ?? []) as TsNode[]) {
    const fn = call.childForFieldName?.('function');
    if (fn?.type === 'identifier') consider(fn.text as string);
    else if (fn?.type === 'scoped_identifier') consider(fn.childForFieldName?.('name')?.text as string | undefined);
    else if (fn?.type === FIELD_EXPRESSION) consider(fn.childForFieldName?.('field')?.text as string | undefined);
  }
  return [...out];
}

/** The handler identifier a route combinator wires (`get(handler)` / `.to(handler)`). */
function combinatorHandler(arg: TsNode | undefined): string | undefined {
  if (!arg) return undefined;
  for (const call of (arg.descendantsOfType?.(CALL_EXPRESSION) ?? []) as TsNode[]) {
    const fn = call.childForFieldName?.('function');
    const name =
      fn?.type === 'identifier'
        ? (fn.text as string)
        : fn?.type === FIELD_EXPRESSION
          ? (fn.childForFieldName?.('field')?.text as string | undefined)
          : fn?.type === 'scoped_identifier'
            ? (fn.childForFieldName?.('name')?.text as string | undefined)
            : undefined;
    if (!name || (!HTTP_VERBS.has(name) && name !== 'to')) continue;
    const first = callArgs(call)[0];
    if (first?.type === 'identifier') return first.text as string;
    if (first?.type === 'scoped_identifier') {
      return first.childForFieldName?.('name')?.text as string | undefined;
    }
  }
  return undefined;
}

// =============================================================================
// Custom registration call shapes (`r.insert(Method::GET, path, handler)`)
// =============================================================================

/**
 * Repo-wide const/static string values by name. A name declared with two DIFFERENT values is
 * ambiguous and resolves to nothing (`null`) — substituting one of the two would fabricate a
 * path; the same rule mountPrefixes applies to an ambiguous mount base.
 */
function constStringIndex(files: RustFile[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const file of files) {
    for (const kind of ['const_item', 'static_item']) {
      for (const item of (file.root.descendantsOfType?.(kind) ?? []) as TsNode[]) {
        // Module-level items only: an ASSOCIATED const inside an impl/trait is referenced as
        // `Self::X` / `Type::X`, never as the bare identifier a format! hole names — indexing it
        // would let an unrelated `impl` poison a same-named module const into ambiguity.
        if (nearestAncestor(item, new Set([IMPL_ITEM, 'trait_item']))) continue;
        const name = item.childForFieldName?.('name')?.text as string | undefined;
        const value = literalValue(item.childForFieldName?.('value') as TsNode | undefined);
        if (!name || value === undefined) continue;
        const existing = map.get(name);
        if (existing === undefined) map.set(name, value);
        else if (existing !== value) map.set(name, null);
      }
    }
  }
  return map;
}

/** Strip `&x`, `x.as_str()`, `x.to_string()`, `x.as_ref()` wrappers around a path expression. */
function unwrapPathExpr(node: TsNode | undefined): TsNode | undefined {
  let cur = node;
  for (let depth = 0; cur && depth < 8; depth++) {
    if (cur.type === 'reference_expression') {
      cur = (cur.childForFieldName?.('value') ?? cur.namedChild?.(0)) as TsNode | undefined;
      continue;
    }
    if (cur.type === CALL_EXPRESSION) {
      const m = calleeMethodName(cur);
      if (m === 'as_str' || m === 'to_string' || m === 'as_ref') {
        const fn = cur.childForFieldName?.('function') as TsNode | undefined;
        cur = fn?.childForFieldName?.('value') as TsNode | undefined;
        continue;
      }
    }
    break;
  }
  return cur;
}

/** An expression's name for const lookup: `IDENT` or the last segment of `mod::IDENT`. */
function constRefName(node: TsNode | undefined): string | undefined {
  if (node?.type === 'identifier') return node.text as string;
  if (node?.type === 'scoped_identifier') return node.childForFieldName?.('name')?.text as string | undefined;
  return undefined;
}

/**
 * A path expression's string value: a literal, a const/static reference, or a `format!(…)`
 * composition. Unresolvable format parts become `{name}` template segments — the linker treats
 * those as params, which keeps the route emitted rather than silently dropped.
 */
function resolvePathExpr(node: TsNode | undefined, consts: Map<string, string | null>): string | undefined {
  const expr = unwrapPathExpr(node);
  if (!expr) return undefined;
  const literal = literalValue(expr);
  if (literal !== undefined) return literal;
  const constName = constRefName(expr);
  if (constName !== undefined) {
    const value = consts.get(constName);
    return typeof value === 'string' ? value : undefined;
  }
  if (expr.type !== 'macro_invocation') return undefined;
  if ((expr.childForFieldName?.('macro')?.text as string | undefined) !== 'format') return undefined;
  const tree = expr.child(expr.childCount - 1) as TsNode | undefined;
  if (!tree) return undefined;
  // token_tree children: the template literal first, then the positional argument tokens.
  let template: string | undefined;
  const args: Array<{ value?: string; name?: string }> = [];
  const n = tree.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const child = tree.namedChild(i) as TsNode | undefined;
    if (!child) continue;
    const value = literalValue(child);
    if (template === undefined) {
      if (value === undefined) return undefined; // format! must lead with its template literal
      template = value;
      continue;
    }
    const name = constRefName(child);
    const resolved = value ?? (name !== undefined ? (consts.get(name) ?? undefined) : undefined);
    args.push({ ...(typeof resolved === 'string' ? { value: resolved } : {}), ...(name ? { name } : {}) });
  }
  if (template === undefined) return undefined;
  // One pass so `{{`/`}}` (literal braces, not holes) are consumed before hole matching.
  let argIndex = 0;
  return template.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, innerRaw: string | undefined) => {
    if (whole === '{{') return '{';
    if (whole === '}}') return '}';
    const inner = (innerRaw ?? '').split(':')[0] ?? '';
    if (inner === '') {
      const arg = args[argIndex++];
      return arg?.value ?? `{${arg?.name ?? `arg${argIndex}`}}`;
    }
    const value = consts.get(inner);
    return typeof value === 'string' ? value : `{${inner}}`;
  });
}

/** The HTTP verb named by a method argument: `Method::POST`, `"POST"`, or a bare `POST`. */
function verbFromArg(arg: TsNode | undefined): HttpMethod | undefined {
  const text =
    literalValue(arg) ??
    (arg?.type === 'scoped_identifier'
      ? (arg.childForFieldName?.('name')?.text as string | undefined)
      : arg?.type === 'identifier'
        ? (arg.text as string)
        : undefined);
  const verb = text?.toLowerCase();
  return verb && HTTP_VERBS.has(verb) ? (verb.toUpperCase() as HttpMethod) : undefined;
}

/**
 * Fn ids of every method in `impl … for <Type>` / `impl <Type>` blocks, keyed by type name.
 * A handler STRUCT resolves to its impl's method only when exactly ONE exists repo-wide —
 * two candidates would mean guessing which one serves the route.
 */
function implMethodIndex(files: RustFile[], idGen: StableIdGenerator): Map<string, Set<string>> {
  const byType = new Map<string, Set<string>>();
  for (const file of files) {
    for (const implNode of file.root.descendantsOfType(IMPL_ITEM) as TsNode[]) {
      const typeName = implTypeName(implNode);
      if (!typeName) continue;
      const body = implNode.childForFieldName?.('body') as TsNode | undefined;
      const n = body?.namedChildCount ?? 0;
      for (let i = 0; i < n; i++) {
        const fn = body?.namedChild(i) as TsNode | undefined;
        if (fn?.type !== FUNCTION_ITEM) continue;
        const ids = byType.get(typeName) ?? new Set<string>();
        ids.add(rustFunctionId(idGen, file.relPath, fn));
        byType.set(typeName, ids);
      }
    }
  }
  return byType;
}

/**
 * Candidate handler names in a registration's handler argument, innermost first: the handler
 * struct in `AdminOperation(&CreateKeyHandler {})` is `CreateKeyHandler`, not the wrapper.
 */
function registrationHandlerNames(arg: TsNode | undefined): string[] {
  if (!arg) return [];
  const names: string[] = [];
  for (const struct of (arg.descendantsOfType?.('struct_expression') ?? []) as TsNode[]) {
    const name = struct.childForFieldName?.('name')?.text as string | undefined;
    if (name) names.push(name.includes('::') ? (name.split('::').pop() as string) : name);
  }
  const direct = constRefName(arg);
  if (direct) names.push(direct);
  if (arg.type === CALL_EXPRESSION) {
    const first = callArgs(arg)[0];
    const inner = constRefName(first?.type === 'reference_expression' ? (first.namedChild?.(0) as TsNode) : first);
    if (inner) names.push(inner);
  }
  return names;
}

// =============================================================================
// gRPC (tonic)
// =============================================================================

/**
 * Streaming kind from a tonic method's signature. The request side is always `Streaming<T>`;
 * the response side is the service's generated associated type, conventionally named
 * `<Method>Stream` (`Response<Self::WatchStream>`), so the suffix — not a bare `Stream` word —
 * is what identifies it.
 */
function streamingKind(fn: TsNode): GrpcEntrypointDetails['streaming'] {
  const params = (fn.childForFieldName?.('parameters')?.text ?? '') as string;
  const ret = (fn.childForFieldName?.('return_type')?.text ?? '') as string;
  const inbound = /\bStreaming</.test(params);
  const outbound = /Streaming<|[A-Za-z]*Stream\b/.test(ret);
  if (inbound && outbound) return 'bidirectional';
  if (inbound) return 'client';
  if (outbound) return 'server';
  return 'unary';
}

/**
 * tonic: `impl <Svc>Server for <T>` — the generated trait name IS the service name, so every
 * method in the impl is one RPC. The trait SUFFIX is the only marker: `#[tonic::async_trait]`
 * sits on ordinary async traits too, so on its own it identifies nothing.
 */
function grpcEntrypoints(file: RustFile, idGen: StableIdGenerator, suffixes: string[]): Entrypoint[] {
  const out: Entrypoint[] = [];
  for (const implNode of file.root.descendantsOfType(IMPL_ITEM) as TsNode[]) {
    const traitName = implTraitName(implNode);
    if (!traitName) continue;
    const suffix = suffixes.find((s) => traitName.endsWith(s) && traitName.length > s.length);
    if (!suffix) continue; // an `#[async_trait]` impl of an unsuffixed trait is not a tonic service
    const serviceName = traitName.slice(0, -suffix.length);
    const body = implNode.childForFieldName?.('body') as TsNode | undefined;
    const n = body?.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
      const fn = body.namedChild(i) as TsNode | undefined;
      if (fn?.type !== FUNCTION_ITEM) continue;
      const methodName = itemName(fn);
      if (!methodName) continue;
      const id = idGen.grpcEntrypointId(serviceName, methodName, file.relPath);
      const details: GrpcEntrypointDetails = {
        type: 'grpc',
        serviceName,
        methodName,
        streaming: streamingKind(fn),
      };
      out.push({
        id,
        versionedId: idGen.versionedId(id, `${serviceName}/${methodName}`),
        type: 'grpc',
        handlerId: rustFunctionId(idGen, file.relPath, fn),
        location: { filePath: file.relPath, startLine: fn.startPosition.row + 1, endLine: fn.endPosition.row + 1 },
        details,
      });
    }
  }
  return out;
}

// =============================================================================
// Entry point
// =============================================================================

/**
 * Extract Rust entrypoints across parsed files:
 *   - contracts (Anchor / ink! / CosmWasm) → `queue`, gated on the framework's crate;
 *   - HTTP from route ATTRIBUTES (`#[get("/p")]`, actix/rocket) and from router CALL SHAPES
 *     (`.route("/p", get(handler))`, axum), with statically-decidable base-path composition;
 *   - tonic gRPC service impls.
 *
 * De-duped by entrypoint id. `warp`'s filter combinators are deliberately out of scope: they
 * are not statically decidable without type inference.
 */
export function extractRustEntrypoints(
  files: RustFile[],
  idGen: StableIdGenerator,
  cfg: RustEntrypointConfig,
): Entrypoint[] {
  const routeAttributes = cfg.routeAttributes ?? DEFAULT_ROUTE_ATTRIBUTES;
  const routerMethods = cfg.routerMethods ?? DEFAULT_ROUTER_METHODS;
  const frameworks = cfg.contractFrameworks ?? DEFAULT_CONTRACT_FRAMEWORKS;
  const grpcSuffixes = cfg.grpcServiceSuffixes ?? ['Server'];
  // `.route(…)` has its own dedicated lane; a registration entry for it would double-emit.
  const registrations = new Map(
    (cfg.registrationCalls ?? []).filter((r) => r.callee !== 'route').map((r) => [r.callee, r]),
  );
  const consts = registrations.size > 0 ? constStringIndex(files) : new Map<string, string | null>();
  const implFnIds = registrations.size > 0 ? implMethodIndex(files, idGen) : new Map<string, Set<string>>();

  const enabled = new Set(
    frameworks.filter((f) => {
      const gate = CONTRACT_GATE_CRATES[f];
      // An unknown framework name has no gate crate to check; running it would be exactly the
      // fabrication risk the gate exists to prevent, so it stays off.
      return gate !== undefined && dependsOnAny(cfg.crates, gate);
    }),
  );

  const out: Entrypoint[] = [];
  const seen = new Set<string>();
  const push = (ep: Entrypoint): void => {
    if (seen.has(ep.id)) return;
    seen.add(ep.id);
    out.push(ep);
  };

  const mounted = mountPrefixes(files, routerMethods);
  // Handler name → its fn id, so a router-wired entrypoint points at a REAL FunctionNode.
  //
  // File-qualified FIRST. `index`, `list`, `create` and `health` are the same handler names in
  // every module of a modular router, so a single global name→id map hands file B's route file
  // A's handler — a WRONG handlerId that the "every handlerId resolves to a real FunctionNode"
  // invariant cannot see, because it does resolve, just to the wrong fn. A cross-file name
  // resolves only when it is UNIQUE repo-wide (the normal shape: `get(users::index)` naming
  // another module's handler); an ambiguous one falls back to the synthetic id.
  const fnIdByFileName = new Map<string, string>();
  const fnIdsByName = new Map<string, Set<string>>();
  for (const file of files) {
    for (const fn of file.root.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
      const name = itemName(fn);
      if (!name) continue;
      const id = rustFunctionId(idGen, file.relPath, fn);
      const fileKey = `${file.relPath}#${name}`;
      if (!fnIdByFileName.has(fileKey)) fnIdByFileName.set(fileKey, id);
      const ids = fnIdsByName.get(name) ?? new Set<string>();
      ids.add(id);
      fnIdsByName.set(name, ids);
    }
  }
  /** The fn a handler NAME refers to from `relPath`: same file first, else a unique repo-wide fn. */
  const handlerIdFor = (name: string, relPath: string): string | undefined => {
    const sameFile = fnIdByFileName.get(`${relPath}#${name}`);
    if (sameFile) return sameFile;
    const ids = fnIdsByName.get(name);
    return ids?.size === 1 ? [...ids][0] : undefined;
  };

  for (const file of files) {
    // --- contracts ---
    if (enabled.has('anchor')) for (const ep of anchorEntrypoints(file, idGen)) push(ep);
    if (enabled.has('ink')) for (const ep of inkEntrypoints(file, idGen)) push(ep);
    if (enabled.has('cosmwasm')) {
      const crateName = crateCodeName(cfg.crateNameOf?.get(file.relPath) ?? 'contract');
      for (const ep of cosmwasmEntrypoints(file, idGen, crateName)) push(ep);
    }

    // --- HTTP: route attributes (actix / rocket) ---
    for (const fn of file.root.descendantsOfType(FUNCTION_ITEM) as TsNode[]) {
      for (const attr of attributesOf(fn)) {
        const name = attributeName(attr);
        if (!routeAttributes.includes(name)) continue;
        const args = attributeStringArgs(attr);
        if (args.length === 0) continue;
        // `#[route("/p", method = "GET")]` names its verb; a verb-named attribute IS the verb.
        const verb = HTTP_VERBS.has(name)
          ? (name.toUpperCase() as HttpMethod)
          : ((
              /\bmethod\s*=\s*"([A-Za-z]+)"/.exec((attr.childForFieldName?.('arguments')?.text ?? '') as string)?.[1] ??
              'GET'
            ).toUpperCase() as HttpMethod);
        const fnName = itemName(fn);
        const base = fnName ? (mounted.get(fnName) ?? '') : '';
        const fullPath = normalizePath(`${base}/${templatize(args[0])}`);
        push(httpEntrypoint(idGen, verb, fullPath, file.relPath, fn, rustFunctionId(idGen, file.relPath, fn)));
      }
    }

    // --- HTTP: router call shapes (axum / actix builder) ---
    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const method = calleeMethodName(call);
      if (method === 'route') {
        const args = callArgs(call);
        const rawPath = literalValue(args[0]);
        if (rawPath === undefined) continue;
        const prefix = routeBasePath(call, routerMethods);
        const fullPath = normalizePath(`${prefix}/${templatize(rawPath)}`);
        const verbs = combinatorMethods(args[1]);
        const handlerName = combinatorHandler(args[1]);
        const handlerId = handlerName ? handlerIdFor(handlerName, file.relPath) : undefined;
        // A `.route(path, …)` with no recognizable verb combinator still serves that path; GET is
        // the label the linker joins on (it matches by prefix, not method), not a claim.
        for (const verb of verbs.length > 0 ? verbs : (['GET'] as HttpMethod[])) {
          push(httpEntrypoint(idGen, verb, fullPath, file.relPath, call, handlerId));
        }
        continue;
      }

      // --- HTTP: profile-declared registration shapes (`r.insert(Method::GET, path, handler)`) ---
      const shape = method !== undefined ? registrations.get(method) : undefined;
      if (!shape) continue;
      const args = callArgs(call);
      const rawPath = resolvePathExpr(args[shape.pathArg], consts);
      if (rawPath === undefined) continue;
      const verb = shape.methodArg !== undefined ? verbFromArg(args[shape.methodArg]) : undefined;
      // A declared method position that does NOT hold a recognizable verb means this is not a
      // route registration at all (`map.insert(Key::Foo, "value")`) — skip, don't fabricate.
      if (shape.methodArg !== undefined && verb === undefined) continue;
      let handlerId: string | undefined;
      for (const name of shape.handlerArg !== undefined ? registrationHandlerNames(args[shape.handlerArg]) : []) {
        // A fn identifier resolves like any other handler name; a handler STRUCT resolves to
        // its impl's method only when exactly one exists repo-wide.
        handlerId = handlerIdFor(name, file.relPath);
        if (handlerId) break;
        const implIds = implFnIds.get(name);
        if (implIds?.size === 1) {
          handlerId = [...implIds][0];
          break;
        }
      }
      push(httpEntrypoint(idGen, verb ?? 'GET', normalizePath(templatize(rawPath)), file.relPath, call, handlerId));
    }

    // --- gRPC ---
    for (const ep of grpcEntrypoints(file, idGen, grpcSuffixes)) push(ep);
  }

  return out;
}
