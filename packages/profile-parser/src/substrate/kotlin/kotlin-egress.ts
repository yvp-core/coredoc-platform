/**
 * Kotlin → backend egress (Retrofit), per spec §Egress.
 *
 * Endpoint DEFINITIONS come from the verb annotations on the functions of an emitted
 * interface/abstract class; the BASE PATH comes from the `Retrofit.Builder()….baseUrl(<expr>)`
 * reachable from a `create(<Iface>::class.java)` site. Only LITERAL segments of that expression
 * contribute — an identifier or a `BuildConfig` member contributes nothing, because a
 * half-invented prefix would join to the wrong backend route at link time. Two `create` sites
 * disagreeing yield an EMPTY base path (counted), never a coin flip.
 *
 * `serviceName` is DELIBERATELY '' (mirrors swift-egress and ruby-egress): a literal collides
 * with the linker's `unresolvableServices` set and every edge would be dropped. The workspace
 * mapper derives the service from the path prefix at link time.
 */
import type { ExternalCallEdge, HttpMethod, StableIdGenerator } from '@coredoc/core';
import {
  MAX_ANCESTOR_HOPS,
  MAX_CHAIN_HOPS,
  MAX_DESCENDANT_DEPTH,
  MAX_NESTED_DEPTH,
  type TsNode,
  annotationName,
  annotationArg,
  annotationsOf,
  argValue,
  calleeChain,
  callArgs,
  firstChildOfType,
  hasModifier,
  namedChildren,
  parameterFacts,
  functionName,
  stringValue,
} from './kotlin-cst.js';
import {
  type KotlinFileFacts,
  type KotlinFileLookup,
  type KotlinTypeDecl,
  indexKotlinFile,
} from './kotlin-declarations.js';
import type { KotlinTypeIndex } from './kotlin-resolve.js';

/** The Retrofit verb vocabulary. A profile's `egress.verbAnnotations` REPLACES this set. */
export const DEFAULT_VERB_ANNOTATIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'HTTP'];

const HTTP_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface KotlinEndpoint {
  /** Method name on the interface. */
  name: string;
  method: HttpMethod;
  /** Path as written, `{x}` preserved. Absent when the endpoint is dynamic. */
  path?: string;
  /** No static path: a verb-only annotation, or an `@Url` parameter (D-8, EC-3). */
  dynamic: boolean;
}

export interface KotlinEgressResult {
  edges: ExternalCallEdge[];
  endpointsDefined: number;
  egressCallSites: number;
}

interface ApiInterface {
  decl: KotlinTypeDecl;
  endpoints: Map<string, KotlinEndpoint>;
  basePath: string;
}

// ---------------------------------------------------------------------------
// CST helpers (local: the sibling lanes need different slices of the same shapes)
// ---------------------------------------------------------------------------

function descendants(node: TsNode, type: string, depth = 0, out: TsNode[] = []): TsNode[] {
  if (depth > MAX_DESCENDANT_DEPTH) return out;
  if (node.type === type) out.push(node);
  for (const child of namedChildren(node)) descendants(child, type, depth + 1, out);
  return out;
}

/** The innermost declaration of `facts` whose node spans `node`. */
function owningDecl(facts: KotlinFileFacts, node: TsNode): KotlinTypeDecl | undefined {
  let best: KotlinTypeDecl | undefined;
  for (const decl of facts.declarations.values()) {
    if (decl.node.startIndex > node.startIndex || decl.node.endIndex < node.endIndex) continue;
    if (!best || decl.node.startIndex > best.node.startIndex) best = decl;
  }
  return best;
}

function annotationNamed(node: TsNode, name: string): TsNode | undefined {
  return annotationsOf(node).find((a) => annotationName(a) === name);
}

/**
 * The literal contribution of a `baseUrl(<expr>)` argument: the path part of a literal after any
 * `scheme://host`, the literal operands of a `+` chain, the literal `string_content` of a
 * template. Identifiers, `BuildConfig` members and call results contribute nothing.
 */
function literalSegments(node: TsNode | undefined, depth = 0): string {
  if (!node || depth > MAX_NESTED_DEPTH) return '';
  if (node.type === 'string_literal') {
    // NOT `kotlin-cst.stringValue`: an interpolated segment contributes NOTHING to a base URL,
    // where the shared reader renders it as `{expr}` to keep a path template joinable.
    let raw = '';
    for (const child of namedChildren(node)) {
      if (child.type === 'string_content') raw += child.text as string;
    }
    const scheme = raw.indexOf('://');
    if (scheme >= 0) {
      const slash = raw.indexOf('/', scheme + 3);
      return slash >= 0 ? raw.slice(slash) : '';
    }
    return raw;
  }
  if (node.type === 'additive_expression') {
    return namedChildren(node)
      .map((c) => literalSegments(c, depth + 1))
      .join('');
  }
  return '';
}

/**
 * The endpoint path resolved against the base URL with URL-REFERENCE semantics, which is what
 * Retrofit does (OkHttp `HttpUrl.resolve`): a path starting with `/` is ROOT-RELATIVE and
 * discards the base path entirely (`baseUrl("…/v1/")` + `@GET("/users")` → `/users`), while a
 * relative one appends to it (`@GET("users")` → `/v1/users`). Single-slashed, leading slash,
 * no trailing slash.
 */
export function joinPathTemplate(base: string, path: string): string {
  const resolved = path.startsWith('/') ? path : `/${base}/${path}`;
  const joined = resolved.replace(/\/{2,}/g, '/');
  const trimmed = joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
  return trimmed === '' ? '/' : trimmed;
}

// ---------------------------------------------------------------------------
// Endpoint definitions
// ---------------------------------------------------------------------------

function endpointOf(fn: TsNode, verbs: readonly string[]): KotlinEndpoint | undefined {
  const name = functionName(fn);
  if (!name) return undefined;
  for (const verb of verbs) {
    const ann = annotationNamed(fn, verb);
    if (!ann) continue;
    const isHttp = verb === 'HTTP';
    const method = (
      isHttp ? (stringValue(annotationArg(ann, 'method')) ?? '').toUpperCase() : verb.toUpperCase()
    ) as HttpMethod;
    if (!HTTP_METHODS.has(method)) return undefined; // an unknown verb is dropped
    const path = stringValue(isHttp ? annotationArg(ann, 'path') : annotationArg(ann, 0));
    const hasUrlParam = parameterFacts(fn).some((p) => p.annotations.some((a) => annotationName(a) === 'Url'));
    return { name, method, path: hasUrlParam ? undefined : path, dynamic: hasUrlParam || path === undefined };
  }
  return undefined;
}

/** An interface, or an abstract class, is an endpoint holder; a plain class is not. */
function isEndpointHolder(decl: KotlinTypeDecl): boolean {
  return decl.kind === 'interface' || (decl.kind === 'class' && hasModifier(decl.node, 'abstract'));
}

function collectEndpoints(facts: KotlinFileFacts, verbs: readonly string[]): Map<string, ApiInterface> {
  const out = new Map<string, ApiInterface>();
  for (const decl of facts.declarations.values()) {
    if (!isEndpointHolder(decl)) continue;
    const endpoints = new Map<string, KotlinEndpoint>();
    for (const fn of descendants(decl.node, 'function_declaration')) {
      if (owningDecl(facts, fn)?.fqcn !== decl.fqcn) continue; // a nested type's member
      const endpoint = endpointOf(fn, verbs);
      if (endpoint) endpoints.set(endpoint.name, endpoint);
    }
    if (endpoints.size > 0) out.set(decl.fqcn, { decl, endpoints, basePath: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base path
// ---------------------------------------------------------------------------

interface BaseUrlSite {
  /** Literal contribution of its argument. */
  value: string;
  /** Name of the property/local whose initializer holds it, for the one-hop rule. */
  propertyName?: string;
  /** Koin qualifier of the enclosing `single(named("q")) { … }` binding, when any. */
  qualifier?: string;
  node: TsNode;
}

/** The `named("q")` qualifier of a call's value arguments. */
function qualifierOf(call: TsNode): string | undefined {
  for (const arg of callArgs(call)) {
    const value = namedChildren(arg).find((c) => c.type === 'call_expression');
    if (!value) continue;
    const chain = calleeChain(value);
    const name = chain?.members[chain.members.length - 1] ?? (chain?.root.text as string | undefined);
    if (name !== 'named') continue;
    const first = callArgs(value)[0];
    return stringValue(first ? argValue(first) : undefined);
  }
  return undefined;
}

function ancestorFacts(node: TsNode): { propertyName?: string; qualifier?: string } {
  let current: TsNode | undefined = node.parent;
  let propertyName: string | undefined;
  let qualifier: string | undefined;
  for (let hop = 0; current && hop < MAX_ANCESTOR_HOPS; hop++) {
    if (current.type === 'property_declaration' && !propertyName) {
      const decl = firstChildOfType(current, 'variable_declaration');
      propertyName = firstChildOfType(decl, 'simple_identifier')?.text as string | undefined;
    }
    if (current.type === 'call_expression' && !qualifier) qualifier = qualifierOf(current);
    current = current.parent;
  }
  return { propertyName, qualifier };
}

/** The `baseUrl` call a node sits inside, within a bounded ancestor walk. */
function enclosingBaseUrlCall(node: TsNode): TsNode | undefined {
  let current: TsNode | undefined = node.parent;
  for (let hop = 0; current && hop < MAX_CHAIN_HOPS; hop++) {
    if (current.type === 'call_expression') {
      const chain = calleeChain(current);
      if (chain && chain.members[chain.members.length - 1] === 'baseUrl') return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Every `baseUrl(<expr>)` site in a file. A builder chain sitting in a PROPERTY INITIALIZER has
 * no enclosing function, so it never reaches `facts.calls` — those sites are recovered through
 * the string literals, which are collected unconditionally.
 */
function collectBaseUrlSites(facts: KotlinFileFacts): BaseUrlSite[] {
  const byOffset = new Map<number, TsNode>();
  for (const call of facts.calls) {
    if (call.name === 'baseUrl') byOffset.set(call.node.startIndex, call.node);
  }
  for (const literal of facts.strings) {
    const call = enclosingBaseUrlCall(literal.node);
    if (call) byOffset.set(call.startIndex, call);
  }
  const out: BaseUrlSite[] = [];
  for (const node of byOffset.values()) {
    const [arg] = callArgs(node);
    out.push({ value: literalSegments(arg ? argValue(arg) : undefined), node, ...ancestorFacts(node) });
  }
  return out;
}

/** The sole site matching a predicate, or undefined when none or more than one does. */
function soleSite(sites: readonly BaseUrlSite[], match: (s: BaseUrlSite) => boolean): BaseUrlSite | undefined {
  const hits = sites.filter(match);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * The base path a single `create(<Iface>::class.java)` site yields, or undefined when none.
 *
 * `local` is the sites of the create site's OWN file; node offsets and bare property names are
 * both file-scoped facts, so matching either against the whole repository is what made a second
 * module's `private val retrofit = …baseUrl("/b/")` resolve to the first module's prefix. Only
 * the Koin qualifier — a written string, not a coincidence of spelling — is looked up repo-wide,
 * because a `single(named("q"))` binding legitimately lives in another file; even there a
 * contested qualifier abstains.
 */
function basePathForCreateSite(
  createNode: TsNode,
  local: readonly BaseUrlSite[],
  all: readonly BaseUrlSite[],
): string | undefined {
  const chain = calleeChain(createNode);
  const root = chain?.root;
  // (1) `Retrofit.Builder()….baseUrl(x)….create(…)` — the same expression.
  const inExpression = local.find(
    (s) => s.node.startIndex >= createNode.startIndex && s.node.endIndex <= createNode.endIndex,
  );
  if (inExpression) return inExpression.value;
  if (!root) return undefined;
  // (2) one hop through the property or local the receiver names, in this file.
  if (root.type === 'simple_identifier') {
    return soleSite(local, (s) => s.propertyName === (root.text as string))?.value;
  }
  // (3) one hop through a Koin qualifier: `get<Retrofit>(named("q"))` → the `single(named("q"))` binding.
  if (root.type === 'call_expression') {
    const qualifier = qualifierOf(root);
    if (!qualifier) return undefined;
    return soleSite(all, (s) => s.qualifier === qualifier)?.value;
  }
  return undefined;
}

function resolveBasePaths(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  apis: Map<string, ApiInterface>,
): void {
  const sitesByFile = new Map<string, BaseUrlSite[]>();
  const sites: BaseUrlSite[] = [];
  for (const facts of allFacts) {
    const own = collectBaseUrlSites(facts);
    sitesByFile.set(facts.relPath, own);
    sites.push(...own);
  }

  const candidates = new Map<string, Set<string>>();
  for (const facts of allFacts) {
    const local = sitesByFile.get(facts.relPath) ?? [];
    for (const site of facts.createSites) {
      if (!site.targetType) continue;
      const hit = index.resolve(site.targetType, facts);
      if (hit.status !== 'resolved' || !apis.has(hit.decl.fqcn)) continue;
      const base = basePathForCreateSite(site.node, local, sites);
      if (base === undefined) continue;
      const set = candidates.get(hit.decl.fqcn) ?? new Set<string>();
      set.add(base);
      candidates.set(hit.decl.fqcn, set);
    }
  }
  for (const [fqcn, values] of candidates) {
    const api = apis.get(fqcn);
    if (!api) continue;
    // Disagreement is not a majority vote: an empty base is the honest answer.
    api.basePath = values.size === 1 ? [...values][0] : '';
  }
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

/** The declared type of a single-name receiver: a local of the enclosing function, or a property. */
function receiverTypeName(
  facts: KotlinFileFacts,
  lookup: KotlinFileLookup,
  index: KotlinTypeIndex,
  call: KotlinFileFacts['calls'][number],
  name: string,
): string | undefined {
  const local = lookup.localsByFunction.get(call.enclosingFunctionId)?.get(name);
  if (local?.typeName) return local.typeName;
  if (!call.enclosingClassFqcn) return undefined;
  const owner = facts.declarations.get(call.enclosingClassFqcn);
  if (!owner) return undefined;
  for (const decl of index.supertypeChain(owner)) {
    const hit = decl.propertyTypes.get(name) ?? decl.diProperties.get(name)?.typeName;
    if (hit) return hit;
  }
  return undefined;
}

/** The declared type of a property `name` on `decl` or any resolved supertype of it. */
function propertyTypeOn(index: KotlinTypeIndex, decl: KotlinTypeDecl, name: string): string | undefined {
  for (const owner of index.supertypeChain(decl)) {
    const hit = owner.propertyTypes.get(name) || owner.diProperties.get(name)?.typeName;
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The declaration a call's RECEIVER chain names, or undefined when any link is unresolved.
 *
 * `x.get(…)` is the one-hop shape: the receiver is a local, a parameter-less property or a
 * DI-delegated property whose declared type is the endpoint interface. An OBJECT FACADE adds one
 * more hop — `Facade.api.get(…)`, where `Facade` is an emitted `object` and `api` a property of
 * it typed by the interface. The walk is bounded at ONE intermediate member on purpose: deeper
 * chains are not resolvable from declared types alone and would be guesses.
 */
function receiverDecl(
  facts: KotlinFileFacts,
  lookup: KotlinFileLookup,
  factsByPath: ReadonlyMap<string, KotlinFileFacts>,
  index: KotlinTypeIndex,
  call: KotlinFileFacts['calls'][number],
): KotlinTypeDecl | undefined {
  const chain = calleeChain(call.node);
  if (!chain || chain.members.length === 0) return undefined;
  if (chain.root.type !== 'simple_identifier') return undefined;
  const rootName = chain.root.text as string;
  // The final member is the endpoint method; everything before it is a property hop.
  const hops = chain.members.slice(0, -1);
  if (hops.length > 1) return undefined;

  // The root is a binding whose declared type names a type, or a type (an `object`) itself.
  const rootType = receiverTypeName(facts, lookup, index, call, rootName);
  const rootHit = index.resolve(rootType ?? rootName, facts);
  if (rootHit.status !== 'resolved') return undefined;

  let decl = rootHit.decl;
  for (const hop of hops) {
    const propertyType = propertyTypeOn(index, decl, hop);
    if (!propertyType) return undefined;
    // The property's type name is written in the file that declares its owner.
    const scope = factsByPath.get(decl.filePath);
    if (!scope) return undefined;
    const hit = index.resolve(propertyType, scope);
    if (hit.status !== 'resolved') return undefined;
    decl = hit.decl;
  }
  return decl;
}

export function extractKotlinEgress(
  allFacts: readonly KotlinFileFacts[],
  index: KotlinTypeIndex,
  idGen: StableIdGenerator,
  cfg: { verbAnnotations?: string[] } = {},
): KotlinEgressResult {
  const verbs = cfg.verbAnnotations ?? DEFAULT_VERB_ANNOTATIONS;
  const apis = new Map<string, ApiInterface>();
  for (const facts of allFacts) {
    for (const [fqcn, api] of collectEndpoints(facts, verbs)) apis.set(fqcn, api);
  }
  const endpointsDefined = [...apis.values()].reduce((n, api) => n + api.endpoints.size, 0);
  if (apis.size === 0) return { edges: [], endpointsDefined: 0, egressCallSites: 0 };
  resolveBasePaths(allFacts, index, apis);

  const factsByPath = new Map(allFacts.map((f) => [f.relPath, f]));
  const edges: ExternalCallEdge[] = [];
  for (const facts of allFacts) {
    const lookup = indexKotlinFile(facts);
    for (const call of facts.calls) {
      const decl = receiverDecl(facts, lookup, factsByPath, index, call);
      if (!decl) continue;
      const api = apis.get(decl.fqcn);
      const endpoint = api?.endpoints.get(call.name);
      if (!api || !endpoint) continue;

      const line = call.location.startLine;
      const template = endpoint.dynamic ? '' : joinPathTemplate(api.basePath, endpoint.path ?? '');
      const id = idGen.externalCallId(
        call.enclosingFunctionId,
        api.decl.simpleName,
        endpoint.method,
        `${facts.relPath}:${line}:${template}`,
      );
      edges.push({
        id,
        versionedId: idGen.versionedId(id, `${endpoint.method} ${template}`),
        callerId: call.enclosingFunctionId,
        // Empty on purpose — see the file header.
        serviceName: '',
        method: endpoint.method,
        targetDescriptor: endpoint.dynamic
          ? { protocol: 'http' }
          : { protocol: 'http', http: { method: endpoint.method, pathTemplate: template } },
        location: call.location,
      });
    }
  }
  return { edges, endpointsDefined, egressCallSites: edges.length };
}
