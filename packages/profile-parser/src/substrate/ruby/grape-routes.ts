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
import { type TsNode, collectCalls, firstArg, isCall, methodName, normalizePath, withParsedRuby } from './ruby-cst.js';

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

export function grapeRoutesFromRoot(root: TsNode): GrapeRoute[] {
  const routes: GrapeRoute[] = [];
  for (const call of collectCalls(root)) {
    const m = methodName(call);
    if (!m || !VERBS.has(m)) continue;

    // Walk up: collect enclosing scope segments (outermost first).
    const segments: string[] = [];
    let cur: TsNode = call.parent;
    while (cur) {
      if (isCall(cur)) {
        const sm = methodName(cur);
        if (sm && SCOPES.has(sm)) {
          const seg = scopeSegment(cur);
          if (seg) segments.unshift(seg);
        }
      }
      cur = cur.parent;
    }

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
