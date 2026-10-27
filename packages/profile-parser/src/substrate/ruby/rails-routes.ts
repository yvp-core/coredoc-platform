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
 * Each route also carries its Rails `controller`/`action` when the DSL decides them: a
 * resource route's RESTful action, a verb's `to: 'ctrl#act'` / `controller:` / `action:`,
 * else the owning resource's controller with the verb's own word as the action. The
 * controller is the qualified class (`AdminApi::WidgetsController`); `namespace`
 * (or its `module:`) and `scope module:` ancestors contribute the module.
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
  tokenText,
  withParsedRuby,
} from './ruby-cst.js';
import { pascalCase, pluralize, singularize } from './ruby-inflect.js';

export interface RailsRoute {
  method: string;
  path: string;
  /** Qualified controller class, e.g. `AdminApi::WidgetsController`. */
  controller?: string;
  action?: string;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SCOPE_KEYWORDS = new Set(['namespace', 'scope']);

/** Routing context a verb sits in within a `resources` block. */
type RestContext = 'member' | 'collection';

/** The standard 7 RESTful actions for a plural `resources` collection. */
function pluralResourceRoutes(name: string, prefix: string[]): RailsRoute[] {
  const base = [...prefix, name];
  const member = [...base, ':id'];
  return [
    { method: 'GET', path: normalizePath(base), action: 'index' },
    { method: 'POST', path: normalizePath(base), action: 'create' },
    { method: 'GET', path: normalizePath([...base, 'new']), action: 'new' },
    { method: 'GET', path: normalizePath(member), action: 'show' },
    { method: 'GET', path: normalizePath([...member, 'edit']), action: 'edit' },
    { method: 'PATCH', path: normalizePath(member), action: 'update' },
    { method: 'PUT', path: normalizePath(member), action: 'update' },
    { method: 'DELETE', path: normalizePath(member), action: 'destroy' },
  ];
}

/** The singular `resource` set — no `:id` member segment. */
function singularResourceRoutes(name: string, prefix: string[]): RailsRoute[] {
  const base = [...prefix, name];
  return [
    { method: 'GET', path: normalizePath([...base, 'new']), action: 'new' },
    { method: 'POST', path: normalizePath(base), action: 'create' },
    { method: 'GET', path: normalizePath(base), action: 'show' },
    { method: 'GET', path: normalizePath([...base, 'edit']), action: 'edit' },
    { method: 'PATCH', path: normalizePath(base), action: 'update' },
    { method: 'PUT', path: normalizePath(base), action: 'update' },
    { method: 'DELETE', path: normalizePath(base), action: 'destroy' },
  ];
}

/**
 * The value node of the call's OWN `key:` option — never one of a call inside its block
 * (`resources :a, only: [] do resources :b, only: [:index] end` must not read `:index` for `:a`).
 */
function ownOption(call: TsNode, key: string): TsNode | undefined {
  const block = ownBlock(call);
  const blockStart = block ? block.startIndex : Number.POSITIVE_INFINITY;
  for (const pair of call.descendantsOfType('pair') as TsNode[]) {
    if (pair.startIndex >= blockStart) continue;
    const k = (pair.childForFieldName?.('key')?.text ?? pair.child(0)?.text)?.replace(/^:|:$/g, '');
    if (k === key) return pair.childForFieldName?.('value') ?? pair.child(pair.childCount - 1);
  }
  return undefined;
}

/** A string/symbol option's value (`module: 'a'` / `module: :a` → `a`); undefined for anything else. */
function optionValue(call: TsNode, key: string): string | undefined {
  const value = ownOption(call, key);
  if (value?.type !== 'string' && value?.type !== 'simple_symbol') return undefined;
  return tokenText(value) || undefined;
}

/** Controller modules contributed by `namespace` (its `module:`, else its name) and `scope module:` ancestors, outermost first. */
function ancestorModules(node: TsNode, stop?: TsNode): string[] {
  const modules: string[] = [];
  for (let cur: TsNode = node.parent; cur && cur.id !== stop?.id; cur = cur.parent) {
    if (!isCall(cur)) continue;
    const m = methodName(cur);
    if (m !== 'namespace' && m !== 'scope') continue;
    const mod = optionValue(cur, 'module') ?? (m === 'namespace' ? firstArg(cur)?.value : undefined);
    if (mod) modules.unshift(mod);
  }
  return modules;
}

/** The nearest enclosing `resources`/`resource` — the controller a verb inside it defaults to. */
function ownerResource(node: TsNode, stop?: TsNode): TsNode | undefined {
  for (let cur: TsNode = node.parent; cur && cur.id !== stop?.id; cur = cur.parent) {
    const m = isCall(cur) ? methodName(cur) : undefined;
    if (m === 'resources' || m === 'resource') return cur;
  }
  return undefined;
}

/** `resources :photos` → `photos`, `resource :profile` → `profiles`; a `controller:` option wins. */
function resourceController(call: TsNode): string | undefined {
  const explicit = optionValue(call, 'controller');
  if (explicit) return explicit;
  const name = firstArg(call)?.value;
  if (!name || methodName(call) === 'resources') return name;
  // Rails pluralizes an already-plural name to itself (`resource :sessions` → SessionsController);
  // the naive pluralizer would append `es`, so round-trip through the singular.
  return pluralize(singularize(name));
}

/**
 * `['admin_api']` + `locations` → `AdminApi::WidgetsController` (`a/b` nests too). A
 * leading `/` is absolute: `controller: '/users'` inside a namespace is the top-level `UsersController`.
 */
function controllerClass(modules: string[], controller: string): string {
  const parts = [...(controller.startsWith('/') ? [] : modules), controller]
    .flatMap((s) => s.split('/'))
    .filter(Boolean);
  return `${parts.map(pascalCase).join('::')}Controller`;
}

/**
 * A verb route's handler: `to: 'ctrl#act'`, else `controller:` / `action:`, else the owning
 * resource's controller with the verb's own word as the action (`post :sync` → `#sync`).
 * Undefined fields when the DSL does not decide both.
 */
function verbHandler(
  call: TsNode,
  pathArg: string,
  baseModules: string[],
  stop?: TsNode,
): { controller?: string; action?: string } {
  const to = optionValue(call, 'to');
  const [toController, toAction] = to?.includes('#') ? to.split('#') : [];
  const owner = ownerResource(call, stop);
  const controller = toController || optionValue(call, 'controller') || (owner && resourceController(owner));
  const action =
    toAction || optionValue(call, 'action') || (/^[\w-]+$/.test(pathArg) ? pathArg.replace(/-/g, '_') : undefined);
  if (!controller || !action) return {};
  return { controller: controllerClass([...baseModules, ...ancestorModules(call, stop)], controller), action };
}

/**
 * The path segment a `scope`/`namespace` ancestor contributes, if any. A `path:`
 * option ALWAYS overrides the positional name for the URL (Rails: `namespace 'api',
 * path: 'api/admin'` serves `/api/admin`, not `/api`; `module:`/`as:` don't
 * affect the URL). `scope module: 'x'` (no path, no positional) contributes nothing.
 */
function scopePrefix(node: TsNode): string | undefined {
  const m = methodName(node);
  if (m === 'namespace' || m === 'scope') {
    return optionValue(node, 'path') ?? firstArg(node)?.value;
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
  const v = optionValue(call, 'on');
  return v === 'member' || v === 'collection' ? v : undefined;
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
function routesForCall(call: TsNode, basePrefix: string[], baseModules: string[], stop: TsNode): RailsRoute[] {
  const m = methodName(call);
  if (!m) return [];
  if (m === 'resources' || m === 'resource') {
    const prefix = [...basePrefix, ...ancestorPrefix(call, stop)];
    const arg = firstArg(call);
    const controllerName = resourceController(call);
    if (!arg || !controllerName) return [];
    const controller = controllerClass([...baseModules, ...ancestorModules(call, stop)], controllerName);
    const routes =
      m === 'resources' ? pluralResourceRoutes(arg.value, prefix) : singularResourceRoutes(arg.value, prefix);
    return applyFilter(routes, actionFilter(call)).map((r) => ({ ...r, controller }));
  }
  if (VERBS.has(m)) {
    const arg = firstArg(call);
    // A symbol action name (`get :preview`) is only a route in member/collection/on: context;
    // a bare symbol verb elsewhere is not a route target.
    const ctx = restContext(call, stop);
    if (!arg?.value || (arg.kind === 'symbol' && !ctx)) return [];
    const prefix = [...basePrefix, ...ancestorPrefix(call, stop, ctx)];
    return [
      {
        method: m.toUpperCase(),
        path: normalizePath([...prefix, arg.value]),
        ...verbHandler(call, arg.value, baseModules, stop),
      },
    ];
  }
  return [];
}

/** Restricted action set from the call's own `only:`/`except:` (a symbol or a symbol array). */
function actionFilter(node: TsNode): { only?: Set<string>; except?: Set<string> } {
  const filter: { only?: Set<string>; except?: Set<string> } = {};
  for (const key of ['only', 'except'] as const) {
    const value = ownOption(node, key);
    if (!value) continue;
    const syms = new Set<string>();
    if (value.type === 'simple_symbol') syms.add(tokenText(value));
    for (const sym of value.descendantsOfType('simple_symbol') as TsNode[]) syms.add(tokenText(sym));
    // `only: []` is a real, empty action set: Rails draws no RESTful route for it.
    if (syms.size > 0 || value.type === 'array') filter[key] = syms;
  }
  return filter;
}

function applyFilter(routes: RailsRoute[], filter: { only?: Set<string>; except?: Set<string> }): RailsRoute[] {
  return routes.filter((r) => {
    if (!r.action) return true;
    if (filter.only) return filter.only.has(r.action);
    if (filter.except) return !filter.except.has(r.action);
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
      // The enclosing namespace(s) at the include site.
      const prefix = ancestorPrefix(call);
      const modules = ancestorModules(call);
      for (const name of symbolArgs(call)) {
        const cc = concernByName.get(name);
        const block = cc && ownBlock(cc);
        if (!cc || !block) continue;
        for (const inner of collectCalls(block)) {
          routes.push(...routesForCall(inner, prefix, modules, cc));
        }
      }
      continue;
    }

    routes.push(...routesForCall(call, [], [], root));
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
