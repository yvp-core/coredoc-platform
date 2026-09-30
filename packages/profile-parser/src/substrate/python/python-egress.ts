/**
 * Python HTTP EGRESS extraction (Lane D, spec SF-20260724 S8 + the cross-repo "moat" S11) —
 * generic outbound HTTP calls a Python app makes to OTHER services, so a Django/DRF/plain
 * Python app becomes a cross-repo CONSUMER. Generic HTTP client MODULES only (`requests`/
 * `httpx`/`aiohttp`, profile-configurable); NO client-specific hosts, paths, or class names
 * (repo rule: never hardcode client patterns — decide on observed data shape).
 *
 * Detection (precision-first): an `attribute`-receiver `call` whose method name is an HTTP
 * verb (`get|post|put|patch|delete|head|options`) AND whose receiver ROOT token resolves to a
 * configured client module — either literally (`requests.post(...)`, `httpx.get(...)`) or via
 * the file's import table (`import httpx as h` → `h.get(...)`; `httpx.Client().get(...)` whose
 * chain roots at `httpx`). A bare `session.get(...)` whose origin is untraceable is SKIPPED
 * (a false egress edge is worse than a missing one for cross-repo consumers). The verb-call
 * SHAPE + receiver gate is what distinguishes egress from an ordinary accessor like
 * `obj.get('config')`.
 *
 * Path template (first positional arg → `pathTemplate`, interpolations PRESERVED per S8, the
 * join key the linker matches onto producer routes):
 *   - f-string  `f"/api/{uid}/events"`      → `/api/{uid}/events` (keep `{name}`); a LEADING
 *               `f"{BASE}/x"` host interpolation is dropped → `/x`.
 *   - `.format`  `"https://svc/users/{}".format(u)` → strip scheme+host → `/users/{_}` (an
 *               EMPTY/positional `{}` placeholder renders as the param token `{_}` so the linker
 *               normalizer collapses it like `{pk}`→`:_`; a numbered `{0}` / named `{name}` is
 *               kept verbatim — those already normalize).
 *   - `+`-concat `"/p/" + str(uid)`          → best-effort `/p/` (leading literal prefix kept,
 *               dynamic tail dropped).
 *   - plain literal `'/v1/users'`            → verbatim; full `http(s)://host/path` → `/path`.
 *   - no usable path (dynamic var, host-only URL with no path) → the site is SKIPPED (no
 *               hostless bogus edge — a host-only URL must NOT emit a spurious `/`).
 *
 * The emitted `ExternalCallEdge` mirrors ruby `httpEgressEdge`: `serviceName=''` (NOT the
 * literal 'http' — the linker recovers the target service from the route prefix, and 'http'
 * collides with `unresolvableServices`), `method` uppercased, and a structured
 * `targetDescriptor.http` carrying the path template.
 */
import type { ExternalCallEdge, HttpMethod, StableIdGenerator } from '@coredoc/core';
import { buildImportTable, type ImportTable } from './python-imports.js';
import {
  ATTRIBUTE,
  CALL,
  DEF_TYPES,
  type PythonFile,
  type TsNode,
  nearestAncestor,
  pythonFunctionId,
} from './python-cst.js';

/** Per-repo egress tuning — the HTTP client modules to treat as outbound calls. */
export interface PythonEgressConfig {
  /** Client modules whose verb methods are egress. Default `['requests','httpx','aiohttp']`. */
  clientModules?: string[];
}

const DEFAULT_CLIENT_MODULES = ['requests', 'httpx', 'aiohttp'];

/** HTTP verbs that name an egress call on a client module. */
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * The leftmost identifier token of a receiver expression — the "root" the call chains off.
 * Descends `attribute.object`, `call.function`, and `subscript.value` until an identifier is
 * reached: `requests` from `requests`, `httpx` from `httpx.Client()`, `h` from `h`. Returns
 * undefined when the chain roots at a non-identifier (a literal, a comprehension, …).
 */
function receiverRootToken(node: TsNode | undefined | null): string | undefined {
  let cur: TsNode | undefined | null = node;
  while (cur) {
    switch (cur.type) {
      case 'identifier':
        return cur.text as string;
      case ATTRIBUTE:
        cur = cur.childForFieldName?.('object');
        break;
      case CALL:
        cur = cur.childForFieldName?.('function');
        break;
      case 'subscript':
        cur = cur.childForFieldName?.('value');
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Whether a receiver root token resolves to one of the configured client modules. An import
 * binding is authoritative and takes precedence: a `TYPE_CHECKING`-only import NEVER yields a
 * runtime egress edge (import policy), and a binding to a non-client module rejects the site
 * even if the token happens to share a client's name. With no binding we fall back to a literal
 * match on a well-known client module name (`httpx.get(...)` with no explicit import in-file).
 */
function receiverIsClient(rootToken: string, table: ImportTable, clientModules: string[]): boolean {
  const imp = table.byLocal.get(rootToken);
  if (imp) {
    if (imp.typeOnly) return false;
    const moduleRoot = imp.module.split('.')[0];
    return clientModules.includes(imp.module) || clientModules.includes(moduleRoot);
  }
  return clientModules.includes(rootToken);
}

/**
 * Local names bound to a client-library object, so a session receiver counts as a client.
 *
 * Rooting the receiver directly in an imported module only matches `requests.get(url)`. The
 * two shapes that carry most real traffic bind an object first — `s = requests.Session()`,
 * and `async with aiohttp.ClientSession() as s:` — and `s.get(url)` roots at `s`, which is
 * neither an import nor a module name. `aiohttp` and `httpx` are in the default client list
 * while being used almost exclusively through a session, so without this an async Python
 * service reads as having near-zero egress and nothing says otherwise.
 *
 * Bindings are collected per file and not flow-sensitive: a name bound to a client anywhere
 * in the file counts throughout it. Rebinding the same name to a non-client is the cost, and
 * it is a far rarer shape than the sessions this recovers.
 */
function clientLocalNames(file: PythonFile, table: ImportTable, clientModules: string[]): Set<string> {
  const names = new Set<string>();
  const constructsClient = (node: TsNode | undefined): boolean => {
    if (node?.type !== CALL) return false;
    const callee = node.childForFieldName?.('function');
    if (!callee) return false;
    // `requests.Session()` roots at the module; `Session()` after `from requests import
    // Session` is a bare identifier the import table resolves.
    const root = callee.type === ATTRIBUTE ? receiverRootToken(callee.childForFieldName?.('object')) : callee.text;
    return typeof root === 'string' && root.length > 0 && receiverIsClient(root, table, clientModules);
  };
  const bind = (target: TsNode | undefined): void => {
    if (target?.type === 'identifier') names.add(target.text as string);
  };

  for (const node of file.root.descendantsOfType('assignment') as TsNode[]) {
    if (constructsClient(node.childForFieldName?.('right'))) bind(node.childForFieldName?.('left'));
  }
  // `with X() as y:` / `async with X() as y:` — the aliased value is an `as_pattern`.
  for (const node of file.root.descendantsOfType('as_pattern') as TsNode[]) {
    if (!constructsClient(node.namedChild?.(0))) continue;
    const alias = node.namedChild?.(1) as TsNode | undefined;
    // `as_pattern_target` wraps the bound name; a bare identifier appears directly.
    bind(alias?.type === 'identifier' ? alias : (alias?.namedChild?.(0) as TsNode | undefined));
  }
  return names;
}

/** The last identifier in an interpolation expression → the placeholder name (`user.id`→`id`, `uid`→`uid`). */
function interpolationName(interp: TsNode): string | undefined {
  // namedChild(0) is the interpolated EXPRESSION (excludes any `:spec` / `!conv` suffix).
  const expr = interp.namedChild?.(0);
  const text = (expr?.text ?? '') as string;
  const ids = text.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  return ids && ids.length > 0 ? ids[ids.length - 1] : undefined;
}

/**
 * Reconstruct a template from a `string` node, concatenating `string_content` pieces and
 * rendering each `interpolation` as `{name}` (f-strings). A LEADING interpolation — one before
 * any literal content — is the host (`f"{BASE}/x"`) and is dropped. Plain strings have no
 * interpolation children, so `.format` placeholders (`{}`/`{0}`) survive as literal content.
 */
function stringNodeToTemplate(node: TsNode): string {
  let out = '';
  let sawContent = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'string_content') {
      out += c.text as string;
      if ((c.text as string).length > 0) sawContent = true;
    } else if (c.type === 'interpolation') {
      // Leading interpolation = the host (e.g. `#{BASE_URL}` equivalent) → dropped.
      if (!sawContent) continue;
      const name = interpolationName(c);
      // A named interpolation keeps its name; an anonymous one (no identifier in the expr)
      // renders as the linker's positional param token `{_}`, not a bare `{}` that never joins.
      out += name ? `{${name}}` : '{_}';
    }
  }
  return out;
}

/** Descend the left edge of a `+`-concat / parenthesized expression to its leading string literal. */
function leftmostString(node: TsNode | undefined | null): TsNode | undefined {
  let cur: TsNode | undefined | null = node;
  while (cur) {
    if (cur.type === 'string') return cur;
    if (cur.type === 'binary_operator') {
      cur = cur.childForFieldName?.('left') ?? cur.child(0);
      continue;
    }
    if (cur.type === 'parenthesized_expression') {
      cur = cur.namedChild?.(0);
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** The first positional argument of a call (skips `keyword_argument`s like `json={}` and punctuation). */
function firstPositionalArg(call: TsNode): TsNode | undefined {
  const args = call.childForFieldName?.('arguments');
  if (!args) return undefined;
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c && c.type !== 'keyword_argument') return c;
  }
  return undefined;
}

/**
 * The RAW template (host may still be present) of a call's first positional arg — string
 * literal, f-string, `"...".format(...)`, or `"literal" + dynamic` concat. Undefined when no
 * usable literal is present (a bare dynamic variable).
 */
function argToRawTemplate(arg: TsNode | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.type === 'string') return stringNodeToTemplate(arg);
  if (arg.type === CALL) {
    // `"...".format(...)` — function is `attribute{ object: string, attribute: 'format' }`.
    const fn = arg.childForFieldName?.('function');
    if (fn?.type === ATTRIBUTE && (fn.childForFieldName?.('attribute')?.text as string) === 'format') {
      const obj = fn.childForFieldName?.('object');
      // In a plain (non-f) string the `.format` placeholders are LITERAL `string_content`, not
      // interpolation nodes. Render an EMPTY positional placeholder `{}` as the param token `{_}`
      // so the linker normalizer collapses it (`{pk}`→`:_`); numbered `{0}`/named `{name}` stay.
      if (obj?.type === 'string') return stringNodeToTemplate(obj).replace(/\{\}/g, '{_}');
    }
    return undefined;
  }
  if (arg.type === 'binary_operator') {
    const s = leftmostString(arg.childForFieldName?.('left') ?? arg.child(0));
    return s ? stringNodeToTemplate(s) : undefined;
  }
  return undefined;
}

/** Normalize a raw template to a path: strip a leading `http(s)://host`; require a leading `/`. */
function toPathTemplate(raw: string): string | undefined {
  let out = raw;
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(out);
  if (m) {
    // A host-only URL (`https://svc` with NO path) has no joinable route → SKIP. Emitting a
    // bare `/` here would be a bogus ExternalCallEdge that contradicts the "no usable path →
    // SKIPPED" contract and pollutes the cross-repo route join.
    if (!m[1]) return undefined;
    out = m[1];
  }
  return out.startsWith('/') ? out : undefined;
}

/** Build the `ExternalCallEdge` for one egress call site (mirrors ruby `httpEgressEdge`). */
function egressEdge(
  idGen: StableIdGenerator,
  file: PythonFile,
  callNode: TsNode,
  method: string,
  path: string,
  originalPath: string,
): ExternalCallEdge {
  const relPath = file.relPath;
  const line = (callNode.startPosition.row as number) + 1;
  // Caller = the enclosing def (scope-chain id); module-scope egress → a synthetic `egress@<line>`.
  const enclosing = nearestAncestor(callNode, DEF_TYPES);
  const callerId = enclosing
    ? pythonFunctionId(idGen, relPath, enclosing)
    : idGen.functionId(relPath, `egress@${line}`);
  const id = idGen.externalCallId(callerId, '', method, `${relPath}:${line}:${path}`);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${path}`),
    callerId,
    // NOT the transport literal 'http' — that collides with the linker's `unresolvableServices`
    // ('http') and would exclude every egress call. The target service is unknown at extraction;
    // the linker recovers it from the route prefix (resolveRepoByRoutePrefix) instead.
    serviceName: '',
    method,
    targetDescriptor: {
      protocol: 'http',
      http: { method: method as HttpMethod, pathTemplate: path, originalPath },
    },
    location: { filePath: relPath, startLine: line, endLine: line },
  };
}

/**
 * Extract outbound HTTP client calls across `files` into `ExternalCallEdge`s (`serviceName=''`,
 * a joinable path template with interpolations preserved). One edge per call site; files and
 * call sites are emitted in document order.
 */
export function extractPythonEgress(
  files: PythonFile[],
  idGen: StableIdGenerator,
  cfg: PythonEgressConfig,
): ExternalCallEdge[] {
  const clientModules = cfg.clientModules ?? DEFAULT_CLIENT_MODULES;
  const out: ExternalCallEdge[] = [];

  for (const file of files) {
    const table = buildImportTable(file);
    const clientLocals = clientLocalNames(file, table, clientModules);
    for (const call of file.root.descendantsOfType(CALL) as TsNode[]) {
      const fn = call.childForFieldName?.('function');
      if (fn?.type !== ATTRIBUTE) continue;

      const verb = (fn.childForFieldName?.('attribute')?.text ?? '') as string;
      if (!VERBS.has(verb.toLowerCase())) continue;

      const rootToken = receiverRootToken(fn.childForFieldName?.('object'));
      if (!rootToken) continue;
      if (!receiverIsClient(rootToken, table, clientModules) && !clientLocals.has(rootToken)) continue;

      const raw = argToRawTemplate(firstPositionalArg(call));
      if (raw === undefined) continue;
      const path = toPathTemplate(raw);
      if (!path) continue; // host-only / non-path literal → no bogus hostless edge (S8).

      out.push(egressEdge(idGen, file, call, verb.toUpperCase(), path, raw));
    }
  }
  return out;
}
