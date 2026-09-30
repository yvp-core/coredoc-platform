/**
 * Single-origin SPA static serving.
 *
 * The web UI (apps/web, built separately) is served by this same NestJS
 * server — no CORS, no separate origin. Two responsibilities live here:
 *
 * 1. ROOT_ROUTES is the single source of truth for the handful of route
 *    prefixes that are intentionally served OUTSIDE the /api/v1 prefix (the
 *    MCP transport, OAuth discovery + endpoints). main.ts's
 *    `setGlobalPrefix` exclude list is derived from this array so the two
 *    can never drift apart.
 * 2. registerSpaServing mounts static serving for the built SPA assets and
 *    a predicated fallback that serves index.html for client-side routes —
 *    while never intercepting API/MCP/OAuth traffic (isReservedPath) or
 *    non-HTML requests.
 *
 * Design decision (locked, docs/web-ui-plan-2026-07.md §3.4): a manual
 * static mount (the Express adapter's useStaticAssets — express.static
 * under the hood) + predicated fallback, NOT Nest's ServeStaticModule —
 * this repo needs the "only fall back for text/html GET/HEAD, everything
 * else falls through" predicate, which ServeStaticModule does not offer.
 * Only type-only imports from 'express' here: the runtime static handler
 * comes from the Nest adapter, so the server ships no direct express dep.
 */

import type { Request, Response, NextFunction } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Root-served route prefixes, in the exact form `setGlobalPrefix`'s exclude
 * option expects: no leading slash, and `.well-known/*` uses Nest's own
 * wildcard syntax (not a regex). main.ts imports this array directly for its
 * `exclude` list — do not hand-copy the strings there.
 */
export const ROOT_ROUTES: string[] = [
  'sse',
  'messages',
  'mcp',
  '.well-known/*',
  'authorize',
  'callback',
  'token',
  'revoke',
  'register',
];

// Reserved-path matching operates on the URL's pathname alone.
const API_PREFIX = '/api/';
const ROBOTS_PATH = '/robots.txt';

// Precompute each ROOT_ROUTES entry into an exact-or-prefix matcher:
//  - '.well-known/*' → first segment '.well-known' (the '*' is Nest's own
//    wildcard syntax, not part of the segment name).
//  - everything else → exact first-segment match, but a request to that
//    prefix's own subpaths (e.g. /mcp/anything) is reserved too, while a
//    path that merely starts with the same characters (/mcpx) is NOT.
const ROOT_SEGMENTS = new Set(ROOT_ROUTES.map((route) => route.split('/')[0]!.replace(/\*$/, '')));

/**
 * True when `url` must never be handled by the SPA fallback: any `/api/`
 * request, `/robots.txt`, or a path whose first segment matches a
 * ROOT_ROUTES entry. Query strings are stripped before matching.
 */
export function isReservedPath(url: string): boolean {
  const pathname = url.split('?')[0]!;

  if (pathname === ROBOTS_PATH) return true;
  if (pathname.startsWith(API_PREFIX) || pathname === '/api') return true;

  const firstSegment = pathname.split('/')[1] ?? '';
  return ROOT_SEGMENTS.has(firstSegment);
}

/**
 * The slice of NestExpressApplication that SPA serving needs. Structural on
 * purpose: it keeps this module free of a runtime `express` import — the
 * adapter's useStaticAssets IS express.static under the hood — and lets
 * tests drive the disabled path with a plain fake host.
 */
export interface SpaServingHost {
  useStaticAssets(path: string, options: { index: false; immutable: boolean; maxAge: string }): unknown;
  use(handler: (req: Request, res: Response, next: NextFunction) => void): unknown;
}

/**
 * Mount static SPA serving on the given host (the Nest Express app). If
 * `webDist` has no index.html (API-only deployment, or the SPA hasn't been
 * built yet), logs once and returns without registering anything — the
 * rest of the server (API, MCP) is unaffected either way.
 *
 * Ordering reality check: bootstrap calls this before app.listen(), but
 * Nest binds its controller routes even later — during init(), which
 * listen() runs — so in the final Express stack these handlers dispatch
 * BEFORE every Nest route. Registration order therefore protects nothing;
 * isReservedPath is the load-bearing guard that keeps API/MCP/OAuth
 * traffic out of the SPA fallback. Consequence: every root-served route
 * MUST be reserved through ROOT_ROUTES. Routes excluded from the global
 * prefix the normal way are covered automatically (main.ts derives the
 * exclude list from ROOT_ROUTES), but a root route mounted by any other
 * mechanism gets shadowed by index.html for browser GET/HEAD requests.
 * /api/v1 routes need no entry — the /api prefix check covers them.
 */
export function registerSpaServing(app: SpaServingHost, webDist: string, logger: { log(msg: string): void }): void {
  const indexHtml = join(webDist, 'index.html');
  if (!existsSync(indexHtml)) {
    logger.log(`SPA serving disabled — ${webDist} not found`);
    return;
  }

  // The app shell must never be cacheable: it is the freshness signal that
  // references the hashed assets. The static mount's `index: false` only
  // disables directory-index resolution — a direct GET /index.html would
  // still be served from disk with the immutable header below. Redirect it
  // to `/` (before the static mount) so the shell is only ever served by
  // the fallback (no-store).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url.split('?')[0] === '/index.html') {
      res.redirect(308, '/');
      return;
    }
    next();
  });

  // The 1y-immutable policy assumes every file under webDist's root is a
  // content-hashed build asset (safe to cache forever) plus the
  // redirected-away index.html — revisit this if unhashed public/ assets
  // (favicons, robots.txt-style static files) ever land in dist root.
  app.useStaticAssets(webDist, {
    index: false,
    immutable: true,
    maxAge: '1y',
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (isReservedPath(req.url)) return next();
    if (!req.headers.accept?.includes('text/html')) return next();

    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexHtml);
  });
}
