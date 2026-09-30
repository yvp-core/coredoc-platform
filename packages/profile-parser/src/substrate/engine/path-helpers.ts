/**
 * Route-path / HTTP-method free helpers.
 */
import type { HttpMethod } from '@coredoc/core/types';
import type { HttpEntrypointRule } from '../../types.js';

export const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Next.js directory segments → a route path: route-groups `(grp)` and slots `@x`
 * are organizational, not routable, so they drop out; `[id]`/`[...slug]`/`[[...slug]]`
 * (optional catch-all) all become `{id}`/`{slug}`.
 */
export function nextSegmentsToRoutePath(segments: string[]): string {
  const routable = segments.filter((seg) => {
    if (!seg) return false;
    if (seg.startsWith('(') && seg.endsWith(')')) return false;
    if (seg.startsWith('@')) return false;
    return true;
  });
  const normalized = routable.map((seg) => {
    const m = seg.match(/^\[{1,2}\.{0,3}(.+?)\]{1,2}$/);
    return m ? `{${m[1]}}` : seg;
  });
  return `/${normalized.join('/')}`;
}

/**
 * Index of a convention root after the file's owning package boundary.
 *
 * A workspace package may itself be named `app` or `pages`; that package-name
 * segment is not a Next.js convention root. `apps/app/app/api/health/route.ts`
 * therefore resolves the second `app`, after the `apps/app` package boundary.
 */
export function packageLocalRouteRootIndex(filePath: string, routeRoot: string, packagePath = '.'): number {
  const parts = filePath.split('/');
  const packageParts = packagePath === '.' ? [] : packagePath.split('/');
  if (!packageParts.every((part, index) => parts[index] === part)) return -1;
  const localIdx = parts.slice(packageParts.length).indexOf(routeRoot);
  return localIdx === -1 ? -1 : packageParts.length + localIdx;
}

/** `app/api/finance/route.ts` → `/api/finance`; `routeRoot` is a path SEGMENT (e.g. `app`). */
export function deriveNextRoutePath(filePath: string, routeRoot: string, packagePath = '.'): string {
  const parts = filePath.split('/');
  const rootIdx = packageLocalRouteRootIndex(filePath, routeRoot, packagePath);
  if (rootIdx === -1) return '/';
  return nextSegmentsToRoutePath(parts.slice(rootIdx + 1, parts.length - 1));
}

/**
 * Next.js pages-router path for a page file's path RELATIVE to the route root:
 * `foo/index.tsx` → `/foo`, `index.tsx` → `/`, `p/[id].tsx` → `/p/{id}`.
 */
export function derivePagesRoutePath(relPath: string): string {
  const segments = relPath.replace(/\.[^./]+$/, '').split('/');
  if (segments[segments.length - 1] === 'index') segments.pop();
  return nextSegmentsToRoutePath(segments);
}

/**
 * Whether a pages-router file relative to the route root is a frontend page.
 * `_`-prefixed files/dirs are framework internals (`_app`, `_document`) and the
 * `api/` subtree is HTTP endpoints, not routes.
 */
export function isPagesRouteFile(relPath: string): boolean {
  // `.d.ts` is a declaration file, not a renderable module — excluded for the same reason
  // isPagesApiRouteFile excludes it. Without this, `pages/types.d.ts` is emitted as route
  // `/types.d`, a route the source never declares.
  if (!/\.(tsx|ts|jsx|js)$/.test(relPath) || relPath.endsWith('.d.ts')) return false;
  const segments = relPath.split('/');
  if (segments[0] === 'api') return false;
  return !segments.some((seg) => seg.startsWith('_'));
}

/**
 * Whether a pages-router file relative to the route root is an API handler file —
 * the exact complement of {@link isPagesRouteFile} inside the `api/` subtree. EVERY
 * module under `api/` is an endpoint (no marker base name), except `_`-prefixed
 * framework internals; `.d.ts` declaration files are not modules that can serve.
 */
export function isPagesApiRouteFile(relPath: string): boolean {
  if (!/\.(tsx|ts|jsx|js)$/.test(relPath) || relPath.endsWith('.d.ts')) return false;
  const segments = relPath.split('/');
  if (segments[0] !== 'api') return false;
  return !segments.some((seg) => seg.startsWith('_'));
}

/** Next.js app-router page file base names (`page.tsx` and friends). */
export const NEXT_APP_PAGE_FILES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js']);

export function normalizeSegment(seg: string): string {
  return seg.replace(/^\/+/, '').replace(/\/+$/, '');
}

export function joinPaths(base: string, method: string): string {
  const parts = [base, method].filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}

export function canonicalizeParams(p: string, syntax: 'colon' | 'brace' | 'template'): string {
  if (syntax === 'colon') return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return p;
}

export function extractParams(p: string, syntax: 'colon' | 'brace' | 'template'): string[] {
  const params: string[] = [];
  const re = syntax === 'colon' ? /:([A-Za-z0-9_]+)/g : /\{([A-Za-z0-9_]+)\}/g;
  for (let m = re.exec(p); m !== null; m = re.exec(p)) params.push(m[1]);
  return params;
}

/**
 * Prepend an app-level route prefix (NestJS `app.setGlobalPrefix(path, { exclude })`)
 * to a composed route path. An exclude entry is a route path, `*` matching any tail
 * (`.well-known/*`) — a route it matches keeps its unprefixed path, mirroring the
 * framework's serving behavior. A leading slash on either side is normalized away:
 * `exclude: ['/health']` is how a profile author naturally writes it, and matching
 * it against the stripped candidate would otherwise silently prefix the route.
 */
export function applyGlobalPrefix(
  prefix: { path: string; exclude?: string[] } | undefined,
  fullPathRaw: string,
): string {
  if (!prefix) return fullPathRaw;
  const bare = fullPathRaw.replace(/^\/+/, '');
  for (const pattern of prefix.exclude ?? []) {
    const barePattern = pattern.replace(/^\/+/, '');
    const source = `^${barePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`;
    if (new RegExp(source).test(bare)) return fullPathRaw;
  }
  return joinRoutePath(`/${normalizeSegment(prefix.path)}`, fullPathRaw);
}

export function joinRoutePath(base: string, route: string): string {
  const b = base.replace(/\/$/, '');
  if (route === '/' || route === '') return b || '/';
  return `${b}${route.startsWith('/') ? '' : '/'}${route}`;
}

export function httpMethodFromCallee(method: string | undefined, rule: HttpEntrypointRule): HttpMethod | undefined {
  if (!method) return undefined;
  let m = method.toLowerCase();
  if (rule.method === 'from-callee' || rule.method === undefined) {
    if (m === 'del') m = 'delete';
    // `router.all(path, h)` genuinely serves every verb — the wildcard, not GET.
    if (m === 'all') return 'ALL' as HttpMethod;
    const verb = m.toUpperCase();
    // A `router.*`/`app.*` callee that is not an HTTP verb is NOT an endpoint:
    // client-side routers expose push/replace/navigate, Express exposes use/param —
    // recording those as entrypoints fabricates an HTTP surface (measured: 58 phantom
    // PUSH/REPLACE/NAVIGATE/MOUNT/USE entrypoints on one repo).
    if (!HTTP_VERBS.has(verb)) return undefined;
    return verb as HttpMethod;
  }
  return (rule.method as Record<string, string>)[m] as HttpMethod | undefined;
}
