/**
 * Rails routing-DSL extraction — generic Rails `config/routes.rb`, distinct
 * from Grape (handled in `grape-routes.ts`). For each routing call we assemble the
 * path by walking UP the CST collecting the prefixes contributed by enclosing DSL
 * blocks, then emit the route(s) the call itself defines:
 *
 *   - `namespace :admin do … end`            → prefix `/admin`
 *   - `scope :v1 do … end` / `scope path: …` → prefix `/v1`
 *   - an enclosing `resources :photos do …`  → prefix `/photos/:photo_id` (collection member)
 *   - an enclosing `resource :profile do …`  → prefix `/profile`
 *   - `resources :photos`                    → the 7 RESTful routes (honors `only:`/`except:`)
 *   - `resource :profile` (singular)         → GET/POST/PATCH/PUT/DELETE /profile (no :id)
 *   - `get 'foo'` / `post 'foo/bar'` / …     → that verb + path
 *
 * Ignored: `root`, `mount` (Grape lives elsewhere), and redirects.
 */
import {
  type TsNode,
  collectCalls,
  firstArg,
  isCall,
  methodName,
  normalizePath,
  ownBlock,
  withParsedRuby,
} from './ruby-cst.js';

export interface RailsRoute {
  method: string;
  path: string;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SCOPE_KEYWORDS = new Set(['namespace', 'scope']);

/** Routing context a verb sits in within a `resources` block. */
type RestContext = 'member' | 'collection';

/** Crude singularization for nested-resource member params (`photos` → `photo`). */
function singularize(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('ses')) return name.slice(0, -2);
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/** The standard 7 RESTful actions for a plural `resources` collection. */
function pluralResourceRoutes(name: string, prefix: string[]): RailsRoute[] {
  const base = [...prefix, name];
  const member = [...base, ':id'];
  return [
    { method: 'GET', path: normalizePath(base) },
    { method: 'POST', path: normalizePath(base) },
    { method: 'GET', path: normalizePath([...base, 'new']) },
    { method: 'GET', path: normalizePath(member) },
    { method: 'GET', path: normalizePath([...member, 'edit']) },
    { method: 'PATCH', path: normalizePath(member) },
    { method: 'PUT', path: normalizePath(member) },
    { method: 'DELETE', path: normalizePath(member) },
  ];
}

/** The singular `resource` set — no `:id` member segment. */
function singularResourceRoutes(name: string, prefix: string[]): RailsRoute[] {
  const base = [...prefix, name];
  return [
    { method: 'GET', path: normalizePath([...base, 'new']) },
    { method: 'POST', path: normalizePath(base) },
    { method: 'GET', path: normalizePath(base) },
    { method: 'GET', path: normalizePath([...base, 'edit']) },
    { method: 'PATCH', path: normalizePath(base) },
    { method: 'PUT', path: normalizePath(base) },
    { method: 'DELETE', path: normalizePath(base) },
  ];
}

/**
 * The path segment a `scope`/`namespace` ancestor contributes, if any. A `path:`
 * option ALWAYS overrides the positional name for the URL (Rails: `namespace 'api',
 * path: 'api/management'` serves `/api/management`, not `/api`; `module:`/`as:` don't
 * affect the URL). `scope module: 'x'` (no path, no positional) contributes nothing.
 */
function scopePrefix(node: TsNode): string | undefined {
  const m = methodName(node);
  if (m === 'namespace' || m === 'scope') {
    return scopePathOption(node) ?? firstArg(node)?.value;
  }
  return undefined;
}

/** Read the value of a `path:` keyword option on a `scope` call (`scope path: 'v1'`). */
function scopePathOption(node: TsNode): string | undefined {
  for (const pair of node.descendantsOfType('pair') as TsNode[]) {
    const key = pair.childForFieldName?.('key')?.text ?? pair.child(0)?.text;
    if (key === 'path:' || key === 'path') {
      const val = pair.childForFieldName?.('value') ?? pair.child(pair.childCount - 1);
      // NOT `ruby-cst.tokenText`: this fallback strips a LEADING `:` too, so one read handles both
      // `path: 'v1'` and `path: :v1` without first branching on the value's node type.
      const inner = (val?.descendantsOfType('string_content')[0]?.text ?? val?.text?.replace(/^['":]+|['"]+$/g, '')) as
        | string
        | undefined;
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * Path prefixes contributed by all DSL-block ancestors of `node`, outermost first.
 * Enclosing `resources`/`resource` contribute their member path so nested routes
 * land under e.g. `/photos/:photo_id/...`.
 *
 * When `ctx` is set, the route is a `member`/`collection` custom route OWNED by the
 * nearest enclosing `resources`/`resource`: that owner contributes `/name` (collection,
 * no id) or `/name/:id` (member), NOT the nested `/name/:name_id` form. Any FURTHER-OUT
 * resources are true parent resources and keep the nested `:name_id` form.
 */
function ancestorPrefix(node: TsNode, stop?: TsNode, ctx?: RestContext): string[] {
  const segments: string[] = [];
  let cur: TsNode = node.parent;
  let ownerHandled = false;
  while (cur && cur.id !== stop?.id) {
    if (isCall(cur)) {
      const m = methodName(cur);
      if (m && SCOPE_KEYWORDS.has(m)) {
        const seg = scopePrefix(cur);
        if (seg) segments.unshift(seg);
      } else if (m === 'resources') {
        const arg = firstArg(cur);
        if (arg) {
          if (ctx && !ownerHandled) {
            ownerHandled = true;
            // Owner of a member/collection route: member adds /:id, collection adds nothing.
            if (ctx === 'member') segments.unshift(arg.value, ':id');
            else segments.unshift(arg.value);
          } else {
            segments.unshift(arg.value, `:${singularize(arg.value)}_id`);
          }
        }
      } else if (m === 'resource') {
        const arg = firstArg(cur);
        // Singular resource has no collection index → no :id for either context.
        if (arg) {
          if (ctx && !ownerHandled) ownerHandled = true;
          segments.unshift(arg.value);
        }
      }
    }
    cur = cur.parent;
  }
  return segments;
}

/** The `on: :member` / `on: :collection` inline option on a verb call, if present. */
function onOption(call: TsNode): RestContext | undefined {
  const block = ownBlock(call);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    if (pair.startIndex >= blockStart) continue;
    const key = (pair.childForFieldName?.('key')?.text ?? pair.child(0)?.text)?.replace(/:$/, '');
    if (key !== 'on') continue;
    const value = pair.childForFieldName?.('value') ?? pair.child(pair.childCount - 1);
    const v = (value?.text as string | undefined)?.replace(/^:/, '');
    if (v === 'member' || v === 'collection') return v;
  }
  return undefined;
}

/**
 * The routing context of a verb call: a `member`/`collection` block ancestor (before
 * the owning `resources`) or an inline `on:` option, else undefined (a plain verb or a
 * nested-resource route). The walk stops at the first `resources`/`resource` ancestor.
 */
function restContext(call: TsNode, stop?: TsNode): RestContext | undefined {
  const on = onOption(call);
  if (on) return on;
  let cur: TsNode = call.parent;
  while (cur && cur.id !== stop?.id) {
    if (isCall(cur)) {
      const m = methodName(cur);
      if (m === 'member' || m === 'collection') return m;
      if (m === 'resources' || m === 'resource') return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** All positional symbol args of a call (`concerns :a, :b` / `concerns [:a, :b]` → ['a','b']). */
function symbolArgs(call: TsNode): string[] {
  const block = ownBlock(call);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  const out: string[] = [];
  for (const s of call.descendantsOfType('simple_symbol') as TsNode[]) {
    if (s.startIndex >= blockStart) continue;
    let p = s.parent;
    let inPair = false;
    while (p && p.id !== call.id) {
      if (p.type === 'pair' || p.type === 'hash' || p.type === 'keyword_argument') {
        inPair = true;
        break;
      }
      p = p.parent;
    }
    if (!inPair) out.push((s.text as string).replace(/^:/, ''));
  }
  return out;
}

/** True if `node` is inside any of the given concern-definition call blocks. */
function insideAny(node: TsNode, blocks: TsNode[]): boolean {
  for (const b of blocks) {
    let p = node.parent;
    while (p) {
      if (p.id === b.id) return true;
      p = p.parent;
    }
  }
  return false;
}

/** The route(s) a single resources/resource/verb call yields, with a base prefix and an ancestor-walk boundary. */
function routesForCall(call: TsNode, basePrefix: string[], stop: TsNode): RailsRoute[] {
  const m = methodName(call);
  if (!m) return [];
  if (m === 'resources') {
    const prefix = [...basePrefix, ...ancestorPrefix(call, stop)];
    const arg = firstArg(call);
    if (!arg) return [];
    const base = normalizePath([...prefix, arg.value]);
    return applyFilter(pluralResourceRoutes(arg.value, prefix), base, actionFilter(call));
  }
  if (m === 'resource') {
    const prefix = [...basePrefix, ...ancestorPrefix(call, stop)];
    const arg = firstArg(call);
    if (!arg) return [];
    const base = normalizePath([...prefix, arg.value]);
    return applyFilter(singularResourceRoutes(arg.value, prefix), base, actionFilter(call));
  }
  if (VERBS.has(m)) {
    const arg = firstArg(call);
    // A symbol action name (`get :preview`) is only a route in member/collection/on: context;
    // a bare symbol verb elsewhere is not a route target.
    const ctx = restContext(call, stop);
    if (!arg?.value || (arg.kind === 'symbol' && !ctx)) return [];
    const prefix = [...basePrefix, ...ancestorPrefix(call, stop, ctx)];
    return [{ method: m.toUpperCase(), path: normalizePath([...prefix, arg.value]) }];
  }
  return [];
}

/** Restricted action set from `only:`/`except:` if a positional-symbol array is given. */
function actionFilter(node: TsNode): { only?: Set<string>; except?: Set<string> } {
  const filter: { only?: Set<string>; except?: Set<string> } = {};
  for (const pair of node.descendantsOfType('pair') as TsNode[]) {
    const key = (pair.childForFieldName?.('key')?.text ?? pair.child(0)?.text)?.replace(/:$/, '');
    if (key !== 'only' && key !== 'except') continue;
    const value = pair.childForFieldName?.('value') ?? pair.child(pair.childCount - 1);
    const syms = new Set<string>();
    if (value?.type === 'simple_symbol') syms.add((value.text as string).replace(/^:/, ''));
    for (const sym of (value?.descendantsOfType?.('simple_symbol') ?? []) as TsNode[]) {
      syms.add((sym.text as string).replace(/^:/, ''));
    }
    if (syms.size > 0) {
      if (key === 'only') filter.only = syms;
      else filter.except = syms;
    }
  }
  return filter;
}

const ACTION_OF: Record<string, string> = {
  'GET /': 'index',
  'POST /': 'create',
  'GET /new': 'new',
  'GET /:id': 'show',
  'GET /:id/edit': 'edit',
  'PATCH /:id': 'update',
  'PUT /:id': 'update',
  'DELETE /:id': 'destroy',
};

/** Map a generated RESTful route back to its Rails action name (for only/except). */
function restAction(route: RailsRoute, base: string): string | undefined {
  const tail = route.path.slice(base.length) || '/';
  return ACTION_OF[`${route.method} ${tail}`];
}

function applyFilter(
  routes: RailsRoute[],
  base: string,
  filter: { only?: Set<string>; except?: Set<string> },
): RailsRoute[] {
  if (!filter.only && !filter.except) return routes;
  return routes.filter((r) => {
    const action = restAction(r, base);
    if (!action) return true;
    if (filter.only) return filter.only.has(action);
    if (filter.except) return !filter.except.has(action);
    return true;
  });
}

export function railsRoutesFromRoot(root: TsNode): RailsRoute[] {
  const calls = collectCalls(root);

  // Rails `concern :name do … end` defines a reusable route fragment that only
  // becomes real routes where `concerns :name` includes it (under that point's
  // namespace prefix). Collect the concern blocks; routes INSIDE them are templates,
  // not standalone routes — they're emitted only via the `concerns` expansion below.
  const concernByName = new Map<string, TsNode>();
  for (const c of calls) {
    if (methodName(c) === 'concern') {
      const name = firstArg(c)?.value;
      if (name) concernByName.set(name, c);
    }
  }
  const concernBlocks = [...concernByName.values()];

  const routes: RailsRoute[] = [];
  for (const call of calls) {
    if (insideAny(call, concernBlocks)) continue; // template — applied via `concerns`
    const m = methodName(call);
    if (!m) continue;

    if (m === 'concerns') {
      const prefix = ancestorPrefix(call); // the enclosing namespace(s) at the include site
      for (const name of symbolArgs(call)) {
        const cc = concernByName.get(name);
        const block = cc && ownBlock(cc);
        if (!cc || !block) continue;
        for (const inner of collectCalls(block)) {
          routes.push(...routesForCall(inner, prefix, cc));
        }
      }
      continue;
    }

    routes.push(...routesForCall(call, [], root));
  }

  // De-dupe (nested blocks / multi-namespace concerns can produce identical routes).
  const seen = new Set<string>();
  return routes.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function extractRailsRoutes(routesSource: string): Promise<RailsRoute[]> {
  return withParsedRuby(routesSource, (root) => railsRoutesFromRoot(root));
}
