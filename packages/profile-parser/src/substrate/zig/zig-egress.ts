/**
 * Zig HTTP EGRESS (BR-14) — outbound calls made through `std.http.Client`, so the repo reads as
 * a cross-repo CONSUMER. Only the standard client is recognised (LIM-D): a repo with a custom
 * client emits 0 and the scorecard denominator makes that visible, which is better than a knob
 * nobody has asked for.
 *
 * The receiver gate is the whole precision story, exactly as in `rust-egress.ts`: `fetch` /
 * `open` / `request` are ordinary method names, so a call counts only when its receiver is a
 * declaration the walk already typed as `std.http.Client` (`facts.httpClientDecls`) — a local /
 * file-scope binding by its plain name, or a container property by `Owner.field`.
 *
 * Only a LITERAL URL yields an edge — directly, or through ONE hop of constant folding, because
 * `.url = api_url` with `const api_url = "https://models.dev/api.json"` next to it is the common
 * way the real repos write it. A parameter and any deeper expression stay dynamic and are
 * dropped, as is a host-only URL: a bare `/` is not a joinable route and would pollute the
 * cross-repo path join.
 */
import { CONCRETE_HTTP_METHODS, type ExternalCallEdge, type HttpMethod, type StableIdGenerator } from '@coredoc/core';
import {
  BINARY_EXPRESSION,
  CALL_EXPRESSION,
  type TsNode,
  callArguments,
  enumLiteralName,
  initializerEntries,
  memberChain,
  stringConstText,
  unwrapTry,
} from './zig-cst.js';
import type { ZigCallSite, ZigFileEntry } from './zig-declarations.js';

/** `std.http.Client` methods that perform a request. */
const EGRESS_VERBS = new Set(['fetch', 'open', 'request']);
const DEFAULT_METHOD = 'GET';
/**
 * The verbs an `ExternalCallEdge.targetDescriptor.http.method` may carry. An enum literal is
 * whatever the source wrote (`.CONNECT`, `.Fetch`, a domain enum that merely has a `.method`
 * field), so it is VALIDATED, not cast: an unknown method would put a value outside the
 * `HttpMethod` union into the graph, where the cross-repo matcher can never join it.
 */
const HTTP_METHODS: ReadonlySet<string> = new Set(CONCRETE_HTTP_METHODS);
/** The SDK label the id mints under — `std.http` is the only client this lane knows (LIM-D). */
const SDK = 'std.http';
const EMPTY_LOCALS: ReadonlySet<string> = new Set<string>();

/**
 * Normalize a raw URL to a path template: strip a leading `scheme://host`, require a leading
 * `/`. Copied from `rust-egress.ts` rather than shared — the two substrates have no other reason
 * to couple, and the rule is four lines.
 */
function toPathTemplate(raw: string): string | undefined {
  let out = raw;
  const m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(out);
  if (m) {
    // Host-only URL → SKIP: there is no route to join on, and `/` would be a bogus edge.
    if (!m[1]) return undefined;
    out = m[1];
  }
  return out.startsWith('/') ? out : undefined;
}

/**
 * The request verb of a call site whose RECEIVER is a known `std.http.Client`; undefined for
 * every other call, including a `fetch` on something this file never typed as a client.
 */
function egressVerb(
  call: ZigCallSite,
  clients: Map<string, 'local' | 'field'>,
  locals: ReadonlySet<string>,
): string | undefined {
  const chain = call.chain;
  if (!chain || chain.length < 2) return undefined;
  const verb = chain[chain.length - 1];
  if (!EGRESS_VERBS.has(verb)) return undefined;

  // A local binding is keyed by the function it is declared in, so a `client` in one function
  // never types a same-named receiver in another; the empty scope is a file-scope binding.
  if (chain.length === 2) {
    const own = clients.get(`${call.callerId}:${chain[0]}`);
    if (own !== undefined) return own === 'local' ? verb : undefined;
    // A name the CALLER binds — a parameter, or a local this walk did not type as a client —
    // shadows the file-scope binding of the same name. Falling back would type it by a
    // declaration the source never referred to.
    if (locals.has(chain[0])) return undefined;
    return clients.get(`:${chain[0]}`) === 'local' ? verb : undefined;
  }
  if (chain.length === 3 && chain[0] === 'self' && call.callerOwnerQualifiedName) {
    const key = `${call.callerOwnerQualifiedName}.${chain[1]}`;
    return clients.get(key) === 'field' ? verb : undefined;
  }
  return undefined;
}

/**
 * The URL a node denotes: a literal, a `++` chain of literals, or an IDENTIFIER resolved one hop
 * through the file's string constants — file-scope first, the caller's own locals taking
 * precedence. A parameter is not a declaration, so it never resolves and stays dynamic.
 */
function urlText(
  node: TsNode | undefined,
  callerId: string,
  consts: Map<string, string>,
  locals: ReadonlySet<string>,
): string | undefined {
  if (!node) return undefined;
  const literal = stringConstText(node);
  if (literal !== undefined) return literal;
  if (node.type === BINARY_EXPRESSION && node.childForFieldName?.('operator')?.text === '++') {
    const left = urlText(node.childForFieldName?.('left'), callerId, consts, locals);
    const right = urlText(node.childForFieldName?.('right'), callerId, consts, locals);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  const chain = memberChain(node);
  if (chain?.length !== 1) return undefined;
  const own = consts.get(`${callerId}:${chain[0]}`);
  if (own !== undefined) return own;
  // `fn get(url: []const u8)` next to a file-level `const url = "https://…"` is the trap: the
  // identifier means the PARAMETER, and folding the file constant in would publish a route the
  // code never requests. A name the caller binds is dynamic, full stop.
  return locals.has(chain[0]) ? undefined : consts.get(`:${chain[0]}`);
}

/** An enum literal as an `HttpMethod`; undefined when it is not one of the seven verbs. */
function httpMethod(name: string | undefined): HttpMethod | undefined {
  const upper = name?.toUpperCase();
  return upper !== undefined && HTTP_METHODS.has(upper) ? (upper as HttpMethod) : undefined;
}

/** `fetch(.{ .location = .{ .url = "…" }, .method = .POST })` → method + URL. */
function fetchTarget(
  args: TsNode[],
  callerId: string,
  consts: Map<string, string>,
  locals: ReadonlySet<string>,
): { method: HttpMethod; url: string } | undefined {
  const options = initializerEntries(args[0]);
  const location = options.get('location');
  const url = location ? urlText(initializerEntries(location).get('url'), callerId, consts, locals) : undefined;
  if (!url) return undefined;
  const method = httpMethod(enumLiteralName(options.get('method')) ?? DEFAULT_METHOD);
  return method ? { method, url } : undefined;
}

/** `open(.POST, try std.Uri.parse("…"), …)` → method + URL. */
function openTarget(
  args: TsNode[],
  callerId: string,
  consts: Map<string, string>,
  locals: ReadonlySet<string>,
): { method: HttpMethod; url: string } | undefined {
  const method = httpMethod(enumLiteralName(args[0]));
  if (!method) return undefined;
  const uri = unwrapTry(args[1]);
  if (uri?.type !== CALL_EXPRESSION) return undefined;
  // The URI must come from a `Uri.parse` literal; any other call is an expression we cannot read.
  const callee = memberChain(uri.childForFieldName?.('function'));
  if (callee?.slice(-2).join('.') !== 'Uri.parse') return undefined;
  const url = urlText(callArguments(uri)[0], callerId, consts, locals);
  return url ? { method, url } : undefined;
}

/** `ExternalCallEdge`s for every literal-URL `std.http.Client` request across `files` (BR-14). */
export function emitZigEgress(files: ReadonlyArray<ZigFileEntry>, idGen: StableIdGenerator): ExternalCallEdge[] {
  const out: ExternalCallEdge[] = [];
  // Two identical requests on one source line mint one id: first wins, as in every other
  // lane (BR-4). Without it a duplicate id reaches the store as a conflicting row.
  const seen = new Set<string>();

  for (const { relPath, facts } of files) {
    for (const call of facts.callSites) {
      const locals = facts.localsByCaller.get(call.callerId) ?? EMPTY_LOCALS;
      const verb = egressVerb(call, facts.httpClientDecls, locals);
      if (!verb) continue;

      const args = callArguments(call.node);
      const consts = facts.stringConstDecls;
      const target =
        verb === 'fetch'
          ? fetchTarget(args, call.callerId, consts, locals)
          : openTarget(args, call.callerId, consts, locals);
      if (!target) continue;
      const pathTemplate = toPathTemplate(target.url);
      if (!pathTemplate) continue;

      const line = call.location.startLine;
      const id = idGen.externalCallId(call.callerId, SDK, target.method, `${relPath}:${line}:${pathTemplate}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        versionedId: idGen.versionedId(id, call.node.text as string),
        callerId: call.callerId,
        // NOT the transport literal 'http': that collides with the linker's
        // `unresolvableServices` sentinel and would exclude every edge. The target service is
        // unknown at extraction; the linker recovers it from the route prefix.
        serviceName: '',
        method: target.method,
        targetDescriptor: {
          protocol: 'http',
          http: { method: target.method, pathTemplate, originalPath: target.url },
        },
        location: call.location,
      });
    }
  }
  return out;
}
