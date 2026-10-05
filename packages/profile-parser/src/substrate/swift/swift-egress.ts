/**
 * Swift → backend egress. Models a Moya-style endpoint table (an `enum` conforming to a
 * `TargetType` protocol) as cross-repo consumer facts: one `ExternalCallEdge` per CALL
 * SITE that references an endpoint case (`RailsApi.getProfiles`), so the linker can draw
 * iOS-app → backend-service edges. Endpoint method + path templates are resolved from the
 * enum's `path` / `method` computed properties (static CST — no types), handling both a
 * `switch` statement and a `return switch` EXPRESSION, both `return X` and bare-expression
 * arms, and `+`-concatenation with repo-wide path-prefix getters (`companyPath + "x"`).
 *
 * `serviceName` is DELIBERATELY '' (never a transport literal): a literal collides with the
 * linker's `unresolvableServices` and would drop every edge; the target service is unknown
 * at extraction and recovered from the route prefix at link time. This mirrors ruby-egress.
 */
import type { ExternalCallEdge, HttpMethod, StableIdGenerator } from '@coredoc/core';
import {
  ENUM_ENTRY,
  FUNC_DECL,
  NAV_EXPR,
  PROPERTY_DECL,
  TYPE_DECL,
  type TsNode,
  declKind,
  enclosingTypeName,
  inheritedTypes,
  isStaticDecl,
  nearestAncestor,
  propertyName,
  stringTemplateWithParams,
  swiftMethodId,
  typeName,
} from './swift-cst.js';
import type { SwiftFile } from './swift-callgraph.js';

const DEFAULT_TARGET_PROTOCOLS = ['TargetType'];
const HTTP_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
/** Members that only re-encode a value as a path segment (`id.uuidString` is still `{id}`). */
const STRING_TRANSFORMS = new Set(['lowercased', 'uppercased', 'description', 'uuidString', 'rawValue', 'stringValue']);

interface Endpoint {
  method: HttpMethod;
  path: string;
}

/** The suffix identifier of a `navigation_expression` (`RailsApi.getProfiles` → "getProfiles"). */
function navSuffixName(nav: TsNode): string | undefined {
  return nav.childForFieldName?.('suffix')?.childForFieldName?.('suffix')?.text as string | undefined;
}

/** The case names of an `enum_entry` (direct `simple_identifier` children; handles `case a, b`). */
function enumEntryCaseNames(entry: TsNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < entry.childCount; i++) {
    const c = entry.child(i);
    if (c?.type === 'simple_identifier') out.push(c.text as string);
  }
  return out;
}

/**
 * The DIRECT case names of an enum decl's body (not nested enums — an API enum may declare a
 * helper `enum X: String` inside it whose cases must NOT be treated as endpoints).
 */
function directEnumCases(enumNode: TsNode): string[] {
  const body = enumNode.childForFieldName?.('body');
  if (!body) return [];
  const out: string[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const c = body.child(i);
    if (c?.type === ENUM_ENTRY) out.push(...enumEntryCaseNames(c));
  }
  return out;
}

/** The first named child of a node (skips punctuation / operator tokens). */
function firstNamed(node: TsNode | undefined): TsNode | undefined {
  if (!node) return undefined;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c?.isNamed) return c;
  }
  return undefined;
}

/** Find the computed property named `name` inside a type body. */
function computedProperty(typeNode: TsNode, name: string): TsNode | undefined {
  for (const prop of typeNode.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
    if (propertyName(prop) === name && prop.childForFieldName?.('computed_value')) return prop;
  }
  return undefined;
}

/**
 * The value expression of one `switch_entry` — the arm's actual result. Scans only the arm's
 * DIRECT statements: the LAST top-level `return X` (so an early `return` nested inside a
 * `guard`/`if` is ignored), or, for a switch-EXPRESSION bare arm, the last direct expression.
 */
function switchEntryValue(entry: TsNode): TsNode | undefined {
  let stmts: TsNode | undefined;
  for (let i = 0; i < entry.childCount; i++) {
    if (entry.child(i)?.type === 'statements') {
      stmts = entry.child(i);
      break;
    }
  }
  if (!stmts) return undefined;
  let lastReturn: TsNode | undefined;
  let lastNamed: TsNode | undefined;
  for (let i = 0; i < stmts.childCount; i++) {
    const c = stmts.child(i);
    if (!c?.isNamed) continue;
    lastNamed = c;
    if (c.type === 'control_transfer_statement') lastReturn = c;
  }
  if (lastReturn) return lastReturn.childForFieldName?.('result') ?? lastReturn.child(lastReturn.childCount - 1);
  return lastNamed; // switch-expression bare-value arm
}

/**
 * Map `switch self { case .x: <value> }` → Map<caseName, valueNode>. Works for both a
 * `switch` statement and a `return switch` expression (the switch_statement is found as a
 * descendant either way), and for multi-pattern cases (`case .a, .b:`).
 */
function switchCaseValueMap(prop: TsNode | undefined): Map<string, TsNode> {
  const out = new Map<string, TsNode>();
  if (!prop) return out;
  const sw = prop.descendantsOfType('switch_statement')?.[0] as TsNode | undefined;
  if (!sw) return out;
  for (let i = 0; i < sw.childCount; i++) {
    const entry = sw.child(i);
    if (entry?.type !== 'switch_entry') continue;
    const value = switchEntryValue(entry);
    if (!value) continue;
    for (let j = 0; j < entry.childCount; j++) {
      const sp = entry.child(j);
      if (sp?.type !== 'switch_pattern') continue;
      const caseName = sp.descendantsOfType('simple_identifier')?.[0]?.text as string | undefined;
      if (caseName && !out.has(caseName)) out.set(caseName, value);
    }
  }
  return out;
}

/** `.get` / `return .post` / `Moya.Method.put` → 'GET'/'POST'/'PUT' (default GET). */
function httpMethodFrom(valueNode: TsNode | undefined): HttpMethod {
  if (!valueNode) return 'GET';
  const ids = valueNode.descendantsOfType?.('simple_identifier') as TsNode[] | undefined;
  const last = ids?.[ids.length - 1]?.text ?? (valueNode.text as string).replace(/^\./, '');
  const up = String(last).toUpperCase() as HttpMethod;
  return HTTP_METHODS.has(up) ? up : 'GET';
}

/** Render a path expression (literal / concatenation / prefix identifier) → a `{param}`-templated string. */
function renderPathExpr(node: TsNode | undefined): string {
  if (!node) return '';
  switch (node.type) {
    case 'line_string_literal':
      return stringTemplateWithParams(node);
    case 'additive_expression': {
      let s = '';
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c?.isNamed) s += renderPathExpr(c); // skip the `+` operator token
      }
      return s;
    }
    case 'simple_identifier':
      return `{${node.text}}`; // a path-prefix getter (resolved later) or a param
    case 'tuple_expression': {
      const inner = firstNamed(node);
      return inner && node.namedChildCount === 1 ? renderPathExpr(inner) : `{param}`;
    }
    case NAV_EXPR: {
      // tree-sitter-swift binds `.member` looser than `+`, so `"a/" + id.lowercased` arrives as
      // `("a/" + id).lowercased`: render the concatenation. A member applied to a parenthesized
      // value or a string transform names no segment of its own either.
      const target = node.childForFieldName?.('target');
      const member = navSuffixName(node);
      if (
        target &&
        (target.type === 'additive_expression' ||
          target.type === 'tuple_expression' ||
          STRING_TRANSFORMS.has(member ?? ''))
      ) {
        return renderPathExpr(target);
      }
      return `{${member ?? 'param'}}`;
    }
    default: {
      const lits = node.descendantsOfType?.('line_string_literal') as TsNode[] | undefined;
      if (lits?.length) return lits.map((l) => stringTemplateWithParams(l)).join('');
      const id = node.descendantsOfType?.('simple_identifier')?.[0]?.text as string | undefined;
      return `{${id ?? 'param'}}`;
    }
  }
}

/** Replace `{name}` tokens with a known path-prefix template (bounded passes for nested prefixes). */
function resolvePrefixes(template: string, prefixes: Map<string, string>): string {
  let out = template;
  for (let pass = 0; pass < 4; pass++) {
    const next = out.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => prefixes.get(name) ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Normalize a rendered path to a leading-slash, single-slash template. */
function normalizePath(s: string): string {
  const p = (s || '').trim();
  if (!p) return '/';
  return `/${p}`.replace(/\/{2,}/g, '/');
}

/**
 * Repo-wide index of path-prefix getters: single-expression computed String properties whose
 * rendered value looks path-like (contains a `/`), e.g. `var companyPath: String {
 * "companies/\(id)/" }`. Nested references (`profileInCompamyPath = "\(companyPath)\(profilePath)"`)
 * are resolved iteratively so an endpoint's `companyPath + "x"` renders to the full path.
 */
function buildPrefixTemplates(files: SwiftFile[]): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const { root } of files) {
    for (const prop of root.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
      const name = propertyName(prop);
      const body = prop.childForFieldName?.('computed_value');
      if (!name || !body || rendered.has(name)) continue;
      const stmts = firstNamed(body);
      let expr = stmts?.type === 'statements' ? firstNamed(stmts) : stmts;
      // `{ return "companies/" + id + "/" }` — the same single expression behind an explicit return.
      if (expr?.type === 'control_transfer_statement') expr = expr.childForFieldName?.('result');
      if (!expr || (expr.type !== 'line_string_literal' && expr.type !== 'additive_expression')) continue;
      const tmpl = renderPathExpr(expr);
      // A getter composed only of other getters (`"\(companyPath)\(profilePath)"`) is a
      // candidate too; it is kept below only if it expands to something path-like.
      if (tmpl.includes('/') || /^(\{[A-Za-z_][A-Za-z0-9_]*\})+$/.test(tmpl)) rendered.set(name, tmpl);
    }
  }
  // Resolve nested prefix references so a fragment fully expands.
  for (const [name, tmpl] of rendered) rendered.set(name, resolvePrefixes(tmpl, rendered));
  for (const [name, tmpl] of rendered) if (!tmpl.includes('/')) rendered.delete(name);
  return rendered;
}

/** A URL-valued declaration a `baseURL` may reference, with its literal parameter defaults. */
interface UrlDecl {
  expr: TsNode;
  defaults: Map<string, string>;
}

/** The value of a single-expression body: its last top-level `return X`, or last expression. */
function bodyValue(body: TsNode | undefined): TsNode | undefined {
  const stmts = body?.type === 'statements' ? body : body?.descendantsOfType?.('statements')?.[0];
  if (!stmts) return undefined;
  let last: TsNode | undefined;
  for (let i = 0; i < stmts.childCount; i++) {
    const c = stmts.child(i);
    if (c?.isNamed) last = c;
  }
  return last?.type === 'control_transfer_statement' ? last.childForFieldName?.('result') : last;
}

/**
 * Repo-wide index of declarations a `baseURL` can chain through, keyed by member name:
 * stored property initializers (`static let railsApiUrl = URL(…)!`), computed properties,
 * and functions (`static func gatewayApiUrl(version v: Int = 3) -> URL { … }`). First wins.
 */
function buildUrlDeclIndex(files: SwiftFile[]): Map<string, UrlDecl> {
  const out = new Map<string, UrlDecl>();
  for (const { root } of files) {
    for (const prop of root.descendantsOfType(PROPERTY_DECL) as TsNode[]) {
      const name = propertyName(prop);
      if (!name || name === 'baseURL' || out.has(name)) continue;
      const value = prop.childForFieldName?.('value');
      const expr = value ?? bodyValue(firstNamed(prop.childForFieldName?.('computed_value')));
      if (expr) out.set(name, { expr, defaults: new Map() });
    }
    for (const fn of root.descendantsOfType(FUNC_DECL) as TsNode[]) {
      const name = fn.childForFieldName?.('name')?.text as string | undefined;
      const expr = bodyValue(firstNamed(fn.childForFieldName?.('body')));
      if (!name || !expr || out.has(name)) continue;
      const defaults = new Map<string, string>();
      for (let i = 0; i < fn.childCount; i++) {
        if (fn.child(i)?.type !== 'parameter') continue;
        const param = fn.child(i)!;
        const names = (param.descendantsOfType('simple_identifier') as TsNode[]).map((n) => n.text as string);
        // `version v: Int = 3` — the default value is a sibling of the parameter node.
        for (let j = i + 1; j < fn.childCount; j++) {
          const sib = fn.child(j);
          if (sib?.type === 'parameter') break;
          if (fn.fieldNameForChild?.(j) === 'default_value' && sib) {
            const local = names[names.length - 1];
            if (local) defaults.set(local, sib.text as string);
            break;
          }
        }
      }
      out.set(name, { expr, defaults });
    }
  }
  return out;
}

/** A host / runtime value inside a rendered URL string. */
const HOST = '\uE000';

/**
 * Render a URL string expression, keeping literal text and substituting interpolations with
 * their literal default when known, else the {@link HOST} marker.
 */
function renderUrlString(node: TsNode, defaults: Map<string, string>): string {
  if (node.type === 'line_string_literal') {
    let s = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c?.isNamed) continue;
      if (c.type === 'interpolated_expression') {
        const id = c.childForFieldName?.('value')?.text as string | undefined;
        s += (id && defaults.get(id)) ?? HOST;
      } else s += c.text as string;
    }
    return s;
  }
  if (node.type === 'additive_expression') {
    let s = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c?.isNamed) s += renderUrlString(c, defaults);
    }
    return s;
  }
  return HOST;
}

/** The route part of a rendered URL: drop the scheme+host (or a leading host value). */
function routeOfUrl(rendered: string): string {
  let s = rendered;
  const scheme = s.indexOf('://');
  if (scheme >= 0) {
    const slash = s.indexOf('/', scheme + 3);
    s = slash >= 0 ? s.slice(slash) : '';
  } else {
    while (s.startsWith(HOST)) s = s.slice(HOST.length);
  }
  return s.split(HOST).join('{param}');
}

/**
 * The static route prefix a `baseURL` expression evaluates to, following `URL(string:)`,
 * `.appendingPathComponent(…)`, force-unwraps and references to indexed declarations.
 * undefined when any link is not statically known.
 */
function urlRoute(
  expr: TsNode | undefined,
  decls: Map<string, UrlDecl>,
  defaults: Map<string, string>,
  depth = 0,
): string | undefined {
  if (!expr || depth > 8) return undefined;
  const follow = (name: string | undefined): string | undefined => {
    const d = name ? decls.get(name) : undefined;
    return d ? urlRoute(d.expr, decls, d.defaults, depth + 1) : undefined;
  };
  switch (expr.type) {
    case 'postfix_expression': // `URL(…)!`
    case 'tuple_expression': // `(expr)`
      return urlRoute(expr.childForFieldName?.('target') ?? firstNamed(expr), decls, defaults, depth + 1);
    case 'simple_identifier':
      return follow(expr.text as string);
    case NAV_EXPR:
      return follow(navSuffixName(expr));
    case 'call_expression': {
      const callee = firstNamed(expr);
      const arg = expr.descendantsOfType?.('value_argument')?.[0]?.childForFieldName?.('value') as TsNode | undefined;
      if (callee?.type === 'simple_identifier' && callee.text === 'URL') {
        return arg ? routeOfUrl(renderUrlString(arg, defaults)) : undefined;
      }
      if (callee?.type === NAV_EXPR && navSuffixName(callee) === 'appendingPathComponent') {
        const base = urlRoute(callee.childForFieldName?.('target'), decls, defaults, depth + 1);
        if (base === undefined || !arg) return undefined;
        return `${base}/${routeOfUrl(renderUrlString(arg, defaults))}`;
      }
      if (callee?.type === 'simple_identifier') return follow(callee.text as string);
      if (callee?.type === NAV_EXPR) return follow(navSuffixName(callee));
      return undefined;
    }
    default:
      return undefined;
  }
}

/** An API enum's endpoint table + case set. */
interface ApiEnum {
  name: string;
  cases: Set<string>;
  endpoints: Map<string, Endpoint>;
}

/**
 * Pass A — collect every API enum (TargetType-conforming) with its resolved endpoint table.
 * Swift commonly SPLITS an API enum: cases live in `enum RailsApi { … }` while the TargetType
 * conformance + the `path`/`method` switches live in a separate `extension RailsApi:
 * RequestTargetType { … }`. So declarations (enum + extensions) are grouped by type name; a
 * group is an API when it has an enum body AND any of its declarations conforms to a target
 * protocol. Cases come from the enum body; path/method switches from anywhere in the group.
 */
function collectApiEnums(
  files: SwiftFile[],
  targetProtocols: string[],
  prefixes: Map<string, string>,
  urlDecls: Map<string, UrlDecl>,
): Map<string, ApiEnum> {
  const protoSet = new Set(targetProtocols);
  const groups = new Map<string, { isEnum: boolean; conforms: boolean; nodes: TsNode[] }>();
  for (const { root } of files) {
    for (const tnode of root.descendantsOfType(TYPE_DECL) as TsNode[]) {
      const kind = declKind(tnode);
      if (kind !== 'enum' && kind !== 'extension') continue;
      const name = typeName(tnode);
      if (!name) continue;
      let g = groups.get(name);
      if (!g) {
        g = { isEnum: false, conforms: false, nodes: [] };
        groups.set(name, g);
      }
      g.nodes.push(tnode);
      if (kind === 'enum') g.isEnum = true;
      if (inheritedTypes(tnode).some((t) => protoSet.has(t))) g.conforms = true;
    }
  }

  const apis = new Map<string, ApiEnum>();
  for (const [name, g] of groups) {
    if (!g.isEnum || !g.conforms) continue;
    const cases = new Set<string>();
    const pathMap = new Map<string, TsNode>();
    const methodMap = new Map<string, TsNode>();
    for (const node of g.nodes) {
      if (declKind(node) === 'enum') for (const cn of directEnumCases(node)) cases.add(cn);
      for (const [k, v] of switchCaseValueMap(computedProperty(node, 'path'))) if (!pathMap.has(k)) pathMap.set(k, v);
      for (const [k, v] of switchCaseValueMap(computedProperty(node, 'method')))
        if (!methodMap.has(k)) methodMap.set(k, v);
    }
    // The route prefix of the API's `baseURL` — declared in the group, or inherited from a
    // protocol extension it conforms to (`extension RailsTarget where Self: TargetType`).
    let baseProp: TsNode | undefined;
    for (const node of g.nodes) baseProp ??= computedProperty(node, 'baseURL');
    for (const node of g.nodes) {
      for (const proto of inheritedTypes(node)) {
        for (const pnode of groups.get(proto)?.nodes ?? []) baseProp ??= computedProperty(pnode, 'baseURL');
      }
    }
    const baseValue = baseProp ? bodyValue(firstNamed(baseProp.childForFieldName?.('computed_value'))) : undefined;
    const base = urlRoute(baseValue, urlDecls, new Map()) ?? '';
    const endpoints = new Map<string, Endpoint>();
    for (const cn of cases) {
      const valueNode = pathMap.get(cn);
      const route = valueNode ? resolvePrefixes(renderPathExpr(valueNode), prefixes) : '';
      endpoints.set(cn, { method: httpMethodFrom(methodMap.get(cn)), path: normalizePath(`${base}/${route}`) });
    }
    apis.set(name, { name, cases, endpoints });
  }
  return apis;
}

/**
 * Member names an implicit `.name` could refer to OUTSIDE the API enums: cases of every other
 * enum and every static property/function in the repo. An implicit member whose name is in
 * this set is ambiguous without a type checker, so it is never attributed to an API.
 */
function nonApiMemberNames(files: SwiftFile[], apis: Map<string, ApiEnum>): Set<string> {
  const out = new Set<string>();
  for (const { root } of files) {
    for (const tnode of root.descendantsOfType(TYPE_DECL) as TsNode[]) {
      const name = typeName(tnode);
      if (declKind(tnode) === 'enum' && name && !apis.has(name)) for (const cn of directEnumCases(tnode)) out.add(cn);
    }
    for (const type of [PROPERTY_DECL, FUNC_DECL]) {
      for (const decl of root.descendantsOfType(type) as TsNode[]) {
        if (!isStaticDecl(decl)) continue;
        const name = type === PROPERTY_DECL ? propertyName(decl) : (decl.childForFieldName?.('name')?.text as string);
        if (name) out.add(name);
      }
    }
  }
  return out;
}

/**
 * The API case an implicit member expression (`.authenticate(…)` / `.employees`) refers to, or
 * undefined. Only an argument position counts — that is where a request wrapper
 * (`NetworkRequestParams<Api, …>(.authenticate(…))`) takes the endpoint. The name must belong to
 * exactly one API enum and to no other enum or static member, and a site inside the API's own
 * declarations (its `switch self` arms, comparisons) is never a request.
 */
function implicitApiCase(
  prefix: TsNode,
  apiByCase: Map<string, ApiEnum[]>,
  ambiguous: Set<string>,
): { api: ApiEnum; caseName: string } | undefined {
  if (prefix.childForFieldName?.('operation')?.text !== '.') return undefined;
  const target = prefix.childForFieldName?.('target');
  if (target?.type !== 'simple_identifier') return undefined;
  const caseName = target.text as string;
  const owners = apiByCase.get(caseName);
  if (owners?.length !== 1 || ambiguous.has(caseName)) return undefined;
  const api = owners[0];

  const parent = prefix.parent;
  const expr = parent?.type === 'call_expression' && parent.child(0)?.id === prefix.id ? parent : prefix;
  if (expr.parent?.type !== 'value_argument') return undefined;
  if (nearestAncestor(prefix, new Set(['switch_pattern']))) return undefined;
  if (enclosingTypeName(prefix) === api.name) return undefined;
  return { api, caseName };
}

/**
 * Extract egress edges: one `ExternalCallEdge` per `<ApiEnum>.<case>` reference site across
 * all files, plus implicit `.case` arguments whose enum is unambiguous (see `implicitApiCase`).
 */
export function extractSwiftEgress(
  files: SwiftFile[],
  idGen: StableIdGenerator,
  cfg: { targetTypeProtocols?: string[] } = {},
): ExternalCallEdge[] {
  const prefixes = buildPrefixTemplates(files);
  const apis = collectApiEnums(
    files,
    cfg.targetTypeProtocols ?? DEFAULT_TARGET_PROTOCOLS,
    prefixes,
    buildUrlDeclIndex(files),
  );
  if (apis.size === 0) return [];

  const apiByCase = new Map<string, ApiEnum[]>();
  for (const api of apis.values()) for (const cn of api.cases) apiByCase.set(cn, [...(apiByCase.get(cn) ?? []), api]);
  const ambiguous = nonApiMemberNames(files, apis);

  const edges: ExternalCallEdge[] = [];
  const emit = (relPath: string, site: TsNode, api: ApiEnum, caseName: string) => {
    const endpoint = api.endpoints.get(caseName) ?? { method: 'GET' as HttpMethod, path: '/' };
    const line = site.startPosition.row + 1;
    const func = nearestAncestor(site, new Set([FUNC_DECL]));
    const callerId = func ? swiftMethodId(idGen, relPath, func) : idGen.functionId(relPath, `egress@${line}`);
    const id = idGen.externalCallId(callerId, '', endpoint.method, `${relPath}:${line}:${api.name}.${caseName}`);
    edges.push({
      id,
      versionedId: idGen.versionedId(id, `${endpoint.method} ${endpoint.path}`),
      callerId,
      // Empty — never the transport literal (see file header). Linker recovers the target
      // service from the route prefix.
      serviceName: '',
      method: endpoint.method,
      targetDescriptor: { protocol: 'http', http: { method: endpoint.method, pathTemplate: endpoint.path } },
      location: { filePath: relPath, startLine: line, endLine: site.endPosition.row + 1 },
    });
  };

  for (const { relPath, root } of files) {
    for (const nav of root.descendantsOfType(NAV_EXPR) as TsNode[]) {
      const target = nav.childForFieldName?.('target');
      if (target?.type !== 'simple_identifier') continue;
      const api = apis.get(target.text as string);
      if (!api) continue;
      const suffix = navSuffixName(nav);
      if (!suffix || !api.cases.has(suffix)) continue;
      emit(relPath, nav, api, suffix);
    }
    for (const prefix of root.descendantsOfType('prefix_expression') as TsNode[]) {
      const hit = implicitApiCase(prefix, apiByCase, ambiguous);
      if (hit) emit(relPath, prefix, hit.api, hit.caseName);
    }
  }
  return edges;
}
