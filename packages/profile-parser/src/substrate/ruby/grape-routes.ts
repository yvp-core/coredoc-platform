/**
 * Grape route extraction — generic Grape DSL, no client-specific assumptions.
 *
 * Each Grape endpoint's RELATIVE path (within its Grape::API class) is assembled by
 * walking UP the CST from the route verb call (`get`/`post`/…) collecting the path
 * segments contributed by its enclosing DSL blocks:
 *   - `resource :x` / `resources :x` / `namespace :x` / `segment :x` / `group :x` → `/x`
 *   - `route_param :id`                                                          → `/:id`
 *   - the verb's own string-literal arg (`get 'foo'` → `/foo`; `get do` → nothing)
 * The cross-file root-mount prefix (`/api/...`) is applied by the mount resolver, not here.
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

export interface GrapeRoute {
  method: string;
  /** Path relative to the Grape class (no root-mount prefix). */
  path: string;
  line: number;
}

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SCOPES = new Set(['resource', 'resources', 'namespace', 'segment', 'group', 'route_param']);

/** The path segment a scope call (resource/namespace/route_param/…) contributes. */
function scopeSegment(node: TsNode): string {
  const m = methodName(node);
  const arg = firstArg(node);
  if (m === 'route_param') return arg ? `:${arg.value}` : '';
  if (arg) return arg.value;
  return '';
}

/**
 * Block-yielding class-method scope macros, by name → the segments they wrap around `yield`
 * (outermost first). A base class commonly defines one so subclasses can share a scope:
 *
 *   def self.with_company
 *     namespace :companies do
 *       route_param :company_uuid do
 *         yield
 *
 * and a subclass's `with_company do … get … end` then routes under `/companies/:company_uuid`.
 */
export type GrapeScopeMacros = ReadonlyMap<string, readonly string[]>;

/** Enclosing scope segments of `node` (outermost first), walking up to `stop` (exclusive). */
function enclosingSegments(node: TsNode, macros: GrapeScopeMacros, stop?: TsNode): string[] {
  const segments: string[] = [];
  let cur: TsNode = node.parent;
  while (cur && cur !== stop) {
    if (isCall(cur)) {
      const sm = methodName(cur);
      if (sm && SCOPES.has(sm)) {
        const seg = scopeSegment(cur);
        if (seg) segments.unshift(seg);
      } else if (sm && ownBlock(cur)) {
        const macro = macros.get(sm);
        if (macro) segments.unshift(...macro);
      }
    }
    cur = cur.parent;
  }
  return segments;
}

/** Collect the `def self.<name>` scope macros (singleton methods that `yield`) under `root`. */
export function grapeScopeMacrosFromRoot(root: TsNode, out: Map<string, string[]>): void {
  for (const def of root.descendantsOfType('singleton_method') as TsNode[]) {
    const name = def.childForFieldName?.('name')?.text;
    const yieldNode = (def.descendantsOfType('yield') as TsNode[])[0];
    if (!name || !yieldNode || out.has(name)) continue;
    const segments = enclosingSegments(yieldNode, new Map(), def);
    if (segments.length) out.set(name, segments);
  }
}

export function grapeRoutesFromRoot(root: TsNode, macros: GrapeScopeMacros = new Map()): GrapeRoute[] {
  const routes: GrapeRoute[] = [];
  for (const call of collectCalls(root)) {
    const m = methodName(call);
    if (!m || !VERBS.has(m)) continue;

    // Walk up: collect enclosing scope segments (outermost first).
    const segments = enclosingSegments(call, macros);

    // The verb's own string path arg (symbols are not route paths for verbs).
    const verbArg = firstArg(call);
    if (verbArg?.kind === 'string' && verbArg.value) segments.push(verbArg.value);

    routes.push({ method: m.toUpperCase(), path: normalizePath(segments), line: call.startPosition.row + 1 });
  }
  return routes;
}

export async function extractGrapeRoutes(source: string): Promise<GrapeRoute[]> {
  return withParsedRuby(source, (root) => grapeRoutesFromRoot(root));
}
