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
  inheritedTypes,
  nearestAncestor,
  propertyName,
  stringTemplateWithParams,
  swiftMethodId,
  typeName,
} from './swift-cst.js';
import type { SwiftFile } from './swift-callgraph.js';

const DEFAULT_TARGET_PROTOCOLS = ['TargetType'];
const HTTP_METHODS = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

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
      const expr = stmts?.type === 'statements' ? firstNamed(stmts) : stmts;
      if (!expr || (expr.type !== 'line_string_literal' && expr.type !== 'additive_expression')) continue;
      const tmpl = renderPathExpr(expr);
      if (tmpl.includes('/')) rendered.set(name, tmpl);
    }
  }
  // Resolve nested prefix references so a fragment fully expands.
  for (const [name, tmpl] of rendered) rendered.set(name, resolvePrefixes(tmpl, rendered));
  return rendered;
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
    const endpoints = new Map<string, Endpoint>();
    for (const cn of cases) {
      const valueNode = pathMap.get(cn);
      const path = valueNode ? normalizePath(resolvePrefixes(renderPathExpr(valueNode), prefixes)) : '/';
      endpoints.set(cn, { method: httpMethodFrom(methodMap.get(cn)), path });
    }
    apis.set(name, { name, cases, endpoints });
  }
  return apis;
}

/**
 * Extract egress edges: one `ExternalCallEdge` per `<ApiEnum>.<case>` reference site across
 * all files. Bare `.case` sites (implicit enum type from a generic wrapper) are a documented
 * Tier-B gap — only the explicit enum-qualified form is captured here.
 */
export function extractSwiftEgress(
  files: SwiftFile[],
  idGen: StableIdGenerator,
  cfg: { targetTypeProtocols?: string[] } = {},
): ExternalCallEdge[] {
  const prefixes = buildPrefixTemplates(files);
  const apis = collectApiEnums(files, cfg.targetTypeProtocols ?? DEFAULT_TARGET_PROTOCOLS, prefixes);
  if (apis.size === 0) return [];

  const edges: ExternalCallEdge[] = [];
  for (const { relPath, root } of files) {
    for (const nav of root.descendantsOfType(NAV_EXPR) as TsNode[]) {
      const target = nav.childForFieldName?.('target');
      if (target?.type !== 'simple_identifier') continue;
      const api = apis.get(target.text as string);
      if (!api) continue;
      const suffix = navSuffixName(nav);
      if (!suffix || !api.cases.has(suffix)) continue;

      const endpoint = api.endpoints.get(suffix) ?? { method: 'GET' as HttpMethod, path: '/' };
      const line = nav.startPosition.row + 1;
      const func = nearestAncestor(nav, new Set([FUNC_DECL]));
      const callerId = func ? swiftMethodId(idGen, relPath, func) : idGen.functionId(relPath, `egress@${line}`);
      const id = idGen.externalCallId(callerId, '', endpoint.method, `${relPath}:${line}:${api.name}.${suffix}`);
      edges.push({
        id,
        versionedId: idGen.versionedId(id, `${endpoint.method} ${endpoint.path}`),
        callerId,
        // Empty — never the transport literal (see file header). Linker recovers the target
        // service from the route prefix.
        serviceName: '',
        method: endpoint.method,
        targetDescriptor: { protocol: 'http', http: { method: endpoint.method, pathTemplate: endpoint.path } },
        location: { filePath: relPath, startLine: line, endLine: nav.endPosition.row + 1 },
      });
    }
  }
  return edges;
}
