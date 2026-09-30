/**
 * Django URLconf primitives shared by the two route lanes: the `path()`/`re_path()` lane in
 * python-entrypoints.ts and the DRF router lane in python-drf.ts.
 *
 * They live here (rather than in either lane) because the two MUST agree on what a path template
 * looks like: a router-derived path and a urlconf-derived path end up in the same cross-repo
 * linker keyspace, so a divergence in `{param}` spelling between the lanes silently splits the
 * same endpoint into two unjoinable routes.
 */
import { type TsNode, stringValue as pythonStringValue } from './python-cst.js';

/** Ensure a leading slash and collapse duplicate slashes; trailing slash preserved (Django keeps it). */
export function normalizePath(p: string): string {
  const s = p.trim();
  return `/${s}`.replace(/\/{2,}/g, '/');
}

/**
 * Turn a Django/DRF route literal into a `{param}` path template, best-effort:
 *   - `path()` converters `<int:pk>` / `<slug:s>` / `<pk>` → `{pk}` / `{s}` / `{pk}`.
 *   - `re_path()` regex: named groups `(?P<pk>...)` → `{pk}`; any residual UNNAMED (or nested)
 *     capture group `(...)` → the positional param token `{_}` (collapsed innermost-out so a
 *     nested group leaves no stray `)`); `^`/`$` anchors stripped and backslash escapes removed.
 *     `{_}` is the same token the egress path uses for a positional placeholder, so a producer
 *     route and a consumer egress agree under the linker's `\{[^}]+\}`→`:_` normalizer.
 */
export function templatize(raw: string, isRegex: boolean): string {
  if (!isRegex) {
    // `<int:pk>` / `<pk>` → `{pk}` (the optional `converter:` prefix is dropped).
    return raw.replace(/<(?:[^:>]+:)?([^>]+)>/g, '{$1}');
  }
  let out = raw.replace(/\(\?P<([^>]+)>[^)]*\)/g, '{$1}'); // named groups → {name}
  // Collapse any leftover capture group (unnamed, or nested) to a positional token. Iterate on
  // the INNERMOST group `\([^()]*\)` until none remain so nesting never leaves a dangling paren.
  while (/\([^()]*\)/.test(out)) {
    out = out.replace(/\([^()]*\)/g, '{_}');
  }
  return out.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1'); // unescape \. \/ etc.
}

/** The last dotted segment of a call's callee (`path` / `re_path` / `router.register` → `register`). */
export function calleeLastName(call: TsNode): string | undefined {
  const fn = call.childForFieldName?.('function');
  if (!fn) return undefined;
  if (fn.type === 'identifier') return fn.text as string;
  if (fn.type === 'attribute') return fn.childForFieldName?.('attribute')?.text as string | undefined;
  return undefined;
}

/** The receiver of an attribute call (`projects_router.register(...)` → 'projects_router'); undefined unless a bare name. */
export function calleeReceiverName(call: TsNode): string | undefined {
  const fn = call.childForFieldName?.('function');
  if (fn?.type !== 'attribute') return undefined;
  const obj = fn.childForFieldName?.('object');
  return obj?.type === 'identifier' ? (obj.text as string) : undefined;
}

/** The unquoted content of a `string` node (raw-string prefix and quotes excluded); '' for an empty literal. */
export function stringValue(node: TsNode): string {
  return pythonStringValue(node) ?? '';
}

/** The POSITIONAL argument nodes of a call, in order (keyword args excluded). */
export function positionalArgs(call: TsNode): TsNode[] {
  const args = call.childForFieldName?.('arguments');
  if (!args) return [];
  const out: TsNode[] = [];
  const n = args.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const a = args.namedChild?.(i) as TsNode | undefined;
    if (a && a.type !== 'keyword_argument' && a.type !== 'comment') out.push(a);
  }
  return out;
}

/** The first POSITIONAL argument's string literal, if the first arg is a plain string. */
export function firstPositionalString(call: TsNode): string | undefined {
  const first = positionalArgs(call)[0];
  return first?.type === 'string' ? stringValue(first) : undefined;
}

/** The value node of a call's `key=` keyword argument, if present. */
export function keywordArg(call: TsNode, key: string): TsNode | undefined {
  const args = call.childForFieldName?.('arguments');
  const n = args?.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const a = args.namedChild?.(i) as TsNode | undefined;
    if (a?.type !== 'keyword_argument') continue;
    if ((a.childForFieldName?.('name')?.text as string | undefined) === key) {
      return a.childForFieldName?.('value') as TsNode | undefined;
    }
  }
  return undefined;
}

/** The string elements of a list/tuple literal node; undefined when the node is not such a literal. */
export function stringListValue(node: TsNode | undefined): string[] | undefined {
  if (node?.type !== 'list' && node?.type !== 'tuple') return undefined;
  const out: string[] = [];
  const n = node.namedChildCount ?? 0;
  for (let i = 0; i < n; i++) {
    const c = node.namedChild?.(i) as TsNode | undefined;
    if (c?.type === 'string') out.push(stringValue(c));
  }
  return out;
}

/** The `include(...)` call inside a `path(prefix, include(...))`, if the second positional arg is one. */
export function includeCall(call: TsNode): TsNode | undefined {
  const second = positionalArgs(call)[1];
  if (second?.type !== 'call') return undefined;
  return calleeLastName(second) === 'include' ? second : undefined;
}

/**
 * The URLconf module a `path(prefix, include(…))` mounts, if the call is a mount.
 *
 * `include` takes either a dotted module string (`include('orders.urls')`) or a
 * `(urlconf, app_namespace)` tuple whose first element is that string. Anything else
 * (`include(router.urls)`, a list literal) has no module to follow, so the mount is
 * reported with no target: the prefix is still known, the child routes just aren't.
 * `include(router.urls)` is picked up by the DRF lane instead (python-drf.ts).
 */
export function includedModule(call: TsNode): { isMount: boolean; module?: string } {
  const inner = includeCall(call);
  if (!inner) return { isMount: false };
  const arg = positionalArgs(inner)[0];
  if (arg?.type === 'string') return { isMount: true, module: stringValue(arg) };
  if (arg?.type === 'tuple') {
    const head = arg.namedChild?.(0) as TsNode | undefined;
    if (head?.type === 'string') return { isMount: true, module: stringValue(head) };
  }
  return { isMount: true };
}
