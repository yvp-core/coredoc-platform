/**
 * Ruby HTTP EGRESS extraction — generic outbound HTTP calls a Ruby app makes to
 * OTHER services, so a Rails/Ruby app becomes a cross-repo CONSUMER. Generic HTTP
 * client libraries only; NO client-specific hosts, paths, or class names.
 *
 * Detected client shapes (matched on the method-call shape, never on a host):
 *   - Faraday    `conn.get('/path')`, `Faraday.get(url)`, `Faraday.new(...).get('/path')`
 *   - HTTParty   `HTTParty.get('https://…')`, `self.class.get('/path')` (HTTParty-including class)
 *   - RestClient `RestClient.get(url)`, `RestClient::Request.execute(method: :get, url: '…')`
 *   - Net::HTTP  `Net::HTTP.get(URI('…'))` (best-effort: extract a URL literal if present, else skip)
 *
 * KISS heuristic to distinguish an egress call from a Grape route DEFINITION (which is
 * also `get`/`post`/…): only a verb call that HAS a RECEIVER is egress — `conn.get(…)`,
 * `HTTParty.get(…)`, `RestClient.delete(…)`, `Faraday.new(…).get(…)`, `http.request(…)`.
 * A bare command `get 'industry' do … end` has no receiver and is a Grape route, so it
 * is skipped. We further require the URL arg to look like a URL or path (starts with
 * `http` or `/`), which rejects ambiguous accessors like `obj.get('config')`.
 *
 * The `RestClient::Request.execute(method:, url:)` form is the one exception that carries
 * its verb/url in a keyword hash rather than as a verb method name + positional URL; it
 * is handled by a dedicated branch.
 */
import {
  type TsNode,
  collectCalls,
  isNestedOption,
  methodName,
  ownBlock,
  withParsedRuby,
  receiverText,
  tokenText,
} from './ruby-cst.js';

export interface RubyEgress {
  method: string;
  url: string;
  line: number;
}

/**
 * A custom request-wrapper method that carries its verb + url as keyword args, e.g. a
 * shared API client's `send_request(http_method: :post, url: ROUTE)`. The method name is
 * CLIENT-SPECIFIC, so it is declared per repo in the RubyProfile — never in shared code.
 */
export interface RequestWrapper {
  method: string;
  verbArg: string;
  urlArg: string;
}

export interface RubyEgressOptions {
  requestWrappers?: RequestWrapper[];
}

/** HTTP verbs that name an egress call (and also Grape route verbs — receiver disambiguates). */
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/**
 * A string is a URL/path if it has a real `http(s)://` scheme or a leading `/`. The scheme
 * must be complete — a bare `httpbin.org/get` (no `://`) is a host, NOT a path, and must be
 * rejected so urlToPath does not turn the host into the first path segment.
 */
function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//.test(value) || value.startsWith('/');
}

/** Whether a keyword-derived verb (`execute`/wrapper) is a real HTTP method. */
function isHttpVerb(verb: string): boolean {
  return VERBS.has(verb.toLowerCase());
}

/**
 * The keyword-hash value for `name:` in an `.execute(...)` call (RestClient::Request).
 * Returns the first string/symbol pair value whose key matches, ignoring nested options
 * from other keys. Used only for the keyword-driven `.execute` form.
 */
function keywordValue(call: TsNode, key: string): { kind: 'string' | 'symbol'; value: string } | undefined {
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    // Only the call's OWN top-level keyword args — never a same-named key inside a nested
    // option hash (descendantsOfType is recursive + document-ordered, so a nested key could
    // otherwise shadow the real argument).
    if (isNestedOption(pair, call)) continue;
    const k = pair.childForFieldName?.('key');
    // Hash-rocket / symbol keys both expose their label via tokenText (drops trailing `:`).
    const keyText = k ? tokenText(k).replace(/:$/, '') : undefined;
    if (keyText !== key) continue;
    const v = pair.childForFieldName?.('value');
    if (!v) continue;
    if (v.type === 'string') return { kind: 'string', value: tokenText(v) };
    if (v.type === 'simple_symbol') return { kind: 'symbol', value: tokenText(v) };
    return undefined;
  }
  return undefined;
}

/** The value node of a TOP-LEVEL keyword pair (`url: GET_USERS` → the `GET_USERS` node). */
function keywordValueNode(call: TsNode, key: string): TsNode | undefined {
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    // Skip same-named keys inside a nested option hash — only the call's own args count.
    if (isNestedOption(pair, call)) continue;
    const k = pair.childForFieldName?.('key');
    const keyText = k ? tokenText(k).replace(/:$/, '') : undefined;
    if (keyText === key) return pair.childForFieldName?.('value') ?? undefined;
  }
  return undefined;
}

/**
 * File-scoped constant table: `CONST = <string>` → the string node. Picks up constants
 * defined at module/class level AND as array elements (`ROUTES = [ NAME = "…", … ]`),
 * since the path constants in real API clients are often grouped in a ROUTES array.
 */
function buildConstantTable(root: TsNode): Map<string, TsNode> {
  const table = new Map<string, TsNode>();
  for (const a of root.descendantsOfType('assignment') as TsNode[]) {
    const left = a.childForFieldName?.('left');
    const right = a.childForFieldName?.('right');
    if (left?.type === 'constant' && right?.type === 'string') table.set(left.text as string, right);
  }
  return table;
}

/**
 * Extract a routing PATH from a (possibly interpolated) string node. Concatenates the
 * literal `string_content` pieces; a LEADING `#{…}` interpolation is the host (e.g.
 * `#{CLIENT_URL}` = `ENV[…]`) and is dropped; a non-leading interpolation becomes a
 * path-param placeholder; `%{name}` format placeholders become `:name`; a full
 * `http(s)://host` prefix is stripped to its path. Returns the path (leading `/`) or
 * undefined when the result is not a path.
 */
/**
 * Derive a route-param name from a `#{…}` interpolation, using the last identifier in the
 * expression (`#{user.id}`→`id`, `#{params[:postId]}`→`postId`, `#{uid}`→`uid`). Returns
 * undefined when no identifier is present (e.g. `#{1 + 2}`) so the caller can fall back to an
 * anonymous placeholder.
 */
function paramNameFromInterpolation(node: TsNode): string | undefined {
  const inner = (node.text as string).replace(/^#\{/, '').replace(/\}$/, '');
  const ids = inner.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  return ids && ids.length > 0 ? ids[ids.length - 1] : undefined;
}

function pathFromStringNode(node: TsNode): string | undefined {
  let out = '';
  // Track emitted param names so two interpolations never collapse to the same placeholder
  // (`/users/#{uid}/posts/#{pid}` must stay two distinct segments, not `/users/:_/posts/:_`).
  const used = new Map<string, number>();
  let anon = 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'string_content') out += c.text as string;
    else if (c.type === 'interpolation') {
      // Leading interpolation (out === '') is the host (e.g. `#{BASE_URL}`) → dropped.
      if (out !== '') {
        const base = paramNameFromInterpolation(c) ?? `_${++anon}`;
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        out += `:${seen === 0 ? base : `${base}_${seen + 1}`}`;
      }
    }
  }
  out = out.replace(/%\{(\w+)\}/g, ':$1');
  const httpMatch = /^https?:\/\/[^/]+(\/.*)?$/i.exec(out);
  if (httpMatch) out = httpMatch[1] ?? '/';
  return out.startsWith('/') ? out : undefined;
}

/** Resolve a node (string literal or constant reference) to a routing path, or undefined. */
function resolveToPath(node: TsNode | undefined, constants: Map<string, TsNode>): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') return pathFromStringNode(node);
  if (node.type === 'constant') {
    const value = constants.get(node.text as string);
    return value ? pathFromStringNode(value) : undefined;
  }
  return undefined;
}

/**
 * Path from a Faraday request-builder block: `recv.<verb> do |req| req.url <path> … end`.
 * The path is the first positional arg of a `.url(…)` call inside the block, resolved
 * (string literal or constant) to a path. Returns the path or undefined.
 */
function urlFromRequestBlock(call: TsNode, constants: Map<string, TsNode>): string | undefined {
  const block = ownBlock(call);
  if (!block) return undefined;
  for (const inner of collectCalls(block)) {
    if (methodName(inner) !== 'url' || !receiverText(inner)) continue;
    const list = inner.descendantsOfType('argument_list')[0] as TsNode | undefined;
    const argNode = list ? firstNonPunctChild(list) : inner.child(inner.childCount - 1);
    const path = resolveToPath(argNode, constants);
    if (path) return path;
  }
  return undefined;
}

/** The first real argument node of an argument_list (skipping parens/commas). */
function firstNonPunctChild(list: TsNode): TsNode | undefined {
  for (let i = 0; i < list.childCount; i++) {
    const c = list.child(i);
    if (c && c.type !== '(' && c.type !== ')' && c.type !== ',') return c;
  }
  return undefined;
}

/** First positional string-literal NODE of a call (before the block, not in an option hash). */
function firstPositionalStringNode(call: TsNode): TsNode | undefined {
  const block = ownBlock(call);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  return (call.descendantsOfType('string') as TsNode[])
    .filter((s) => s.startIndex < blockStart && !isNestedOption(s, call))
    .sort((a, b) => a.startIndex - b.startIndex)[0];
}

/** Whether a string node contains interpolation (`#{…}`). */
function isInterpolated(node: TsNode): boolean {
  return (node.descendantsOfType('interpolation') as TsNode[]).length > 0;
}

/** First positional string arg anywhere under the call (e.g. inside `URI('…')`), not in an option hash. */
function firstUrlStringLiteral(call: TsNode): string | undefined {
  const strings = (call.descendantsOfType('string') as TsNode[])
    .filter((s) => !isNestedOption(s, call))
    .map((s) => ({ start: s.startIndex, value: tokenText(s) }))
    .sort((a, b) => a.start - b.start);
  for (const s of strings) {
    if (looksLikeUrl(s.value)) return s.value;
  }
  return undefined;
}

export function rubyEgressFromRoot(root: TsNode, opts: RubyEgressOptions = {}): RubyEgress[] {
  const out: RubyEgress[] = [];
  const constants = buildConstantTable(root);
  const wrappers = new Map((opts.requestWrappers ?? []).map((w) => [w.method, w]));
  for (const call of collectCalls(root)) {
    const m = methodName(call);
    if (!m) continue;
    const line = call.startPosition.row + 1;

    // RestClient::Request.execute(method: :get, url: '…') — verb + url live in a keyword hash.
    if (m === 'execute') {
      const verb = keywordValue(call, 'method');
      const url = keywordValue(call, 'url');
      if (verb && isHttpVerb(verb.value) && url && looksLikeUrl(url.value)) {
        out.push({ method: verb.value.toUpperCase(), url: url.value, line });
      }
      continue;
    }

    // Profile-declared request wrapper (`send_request(http_method:, url:)`) — verb + url
    // in keyword args; the url is usually a constant resolved to its path.
    const wrapper = wrappers.get(m);
    if (wrapper) {
      const verb = keywordValue(call, wrapper.verbArg);
      const path = resolveToPath(keywordValueNode(call, wrapper.urlArg), constants);
      // Validate the verb — a wrapper arg that isn't a real HTTP method must not emit an
      // ExternalCallEdge with a bogus (unmatchable) method.
      if (verb && isHttpVerb(verb.value) && path) {
        out.push({ method: verb.value.toUpperCase(), url: path, line });
      }
      continue;
    }

    if (!VERBS.has(m)) continue;

    // Egress requires a RECEIVER — disambiguates from bare Grape route DSL (`get 'x' do`).
    if (!receiverText(call)) continue;

    // The first positional string arg is the URL. For an INTERPOLATED literal
    // (`conn.get("/v1/users/#{id}/posts")`) the flattened token text is just the first
    // segment, so resolve the node through pathFromStringNode (interpolation→:name, %{name}→
    // :name, host strip); a plain literal keeps its verbatim value. When the interpolated
    // parse fails we leave url undefined (skip) rather than emit the truncated first segment,
    // then fall back to the first URL-shaped literal under the call (Net::HTTP.get(URI('…'))),
    // then to a Faraday request block (`req.url CONST`) resolved through the constant table.
    const strNode = firstPositionalStringNode(call);
    let url: string | undefined;
    if (strNode && looksLikeUrl(tokenText(strNode))) {
      url = isInterpolated(strNode) ? pathFromStringNode(strNode) : tokenText(strNode);
    }
    url ??= firstUrlStringLiteral(call) ?? urlFromRequestBlock(call, constants);
    if (!url) continue;

    out.push({ method: m.toUpperCase(), url, line });
  }
  return out;
}

export async function extractRubyEgress(source: string, opts: RubyEgressOptions = {}): Promise<RubyEgress[]> {
  return withParsedRuby(source, (root) => rubyEgressFromRoot(root, opts));
}
