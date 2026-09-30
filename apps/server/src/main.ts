import 'reflect-metadata';
// Load .env before any module is imported: OAuthModule reads OAuth/GitHub env
// vars at module-definition time (McpAuthModule.forRoot), which runs before
// ConfigModule initializes. dotenv does not override real environment vars.
import 'dotenv/config';

import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { GlobalExceptionFilter } from './libs/global-exception.filter.js';
import { isMcpRequestPath, McpRewriteMiddleware } from './mcp/mcp-rewrite.middleware.js';
import { TelemetryService } from './modules/telemetry/telemetry.service.js';
import { BODY_LIMIT_TIERS, bodyLimitFor } from './libs/body-limits.js';
import { ROOT_ROUTES, registerSpaServing } from './libs/spa-serving.js';
import { API_PREFIX } from './libs/api-prefix.js';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { parseProcessRole } from './process-role.js';
import { AppConfigError, assertAppConfigValid, miscConfigFromEnv } from './config/app-config.js';
import { assertEncryptionKeyValid } from './database/encryption.js';
import { SERVER_VERSION } from './modules/meta/server-version.js';
import { versionHeaderMiddleware } from './modules/meta/version-header.middleware.js';

type NestBootstrapFactory = Pick<typeof NestFactory, 'create' | 'createApplicationContext'>;

export async function bootstrap(
  rawRole: string | undefined = miscConfigFromEnv().processRole,
  factory: NestBootstrapFactory = NestFactory,
): Promise<void> {
  const role = parseProcessRole(rawRole);
  // Validate the whole environment for THIS role before anything is imported:
  // an app root's own modules run top-level side effects (the OAuth store opens
  // a Prisma client) while being imported, and a misconfigured deployment
  // should hear about the variable, not about the side effect.
  assertAppConfigValid(role);
  assertEncryptionKeyValid();
  if (role === 'worker') {
    const { WorkerAppModule } = await import('./worker-app.module.js');
    const worker = await factory.createApplicationContext(WorkerAppModule, { bufferLogs: true });
    worker.enableShutdownHooks();
    return;
  }

  const rootModule =
    role === 'api' ? (await import('./api-app.module.js')).ApiAppModule : (await import('./app.module.js')).AppModule;
  // No CORS: the SPA is served by this same server (single-origin), so a
  // cross-origin policy adds no protection here. Browser cookie-session auth
  // (coredoc_session/coredoc_refresh, set by WebAuthModule) exists ONLY on
  // /api/v1 routes via the composite AuthGuard, which requires the
  // X-Coredoc-Csrf custom header on any cookie-authenticated request whose
  // method is not GET/HEAD/OPTIONS. The MCP transport (/mcp, /sse, /messages)
  // remains Bearer-header only and never reads cookies — see
  // McpRewriteMiddleware and its cookie-rejection invariant tests.
  const app = await factory.create<NestExpressApplication>(rootModule, {
    rawBody: true,
    bodyParser: true,
    bufferLogs: true,
  });

  // First middleware: every response, including ones that never reach a Nest
  // route (413 refusal below, 404s, GlobalExceptionFilter 5xx), carries the
  // server version so a client can diagnose a version mismatch from a failure.
  app.use(versionHeaderMiddleware(SERVER_VERSION));

  app.use(cookieParser());

  // Per-route body-size guard. The global body parsers below allow up to
  // LARGE_UPLOAD_LIMIT (needed by the allow-listed upload routes), but that
  // limit applies to EVERY route — including unauthenticated ones like
  // /api/v1/auth/* — which would let a remote caller force the parser to
  // buffer ~100MB per request into memory and exhaust the process. We reject
  // oversize requests from the client-provided Content-Length header
  // (RFC-required for requests with a body) BEFORE the parser buffers them,
  // capping each route at bodyLimitFor(url). Chunked/streaming uploads without
  // a Content-Length, and gzipped bodies (the guard sees the compressed size),
  // fall through to the global parser limit — enforced on the inflated bytes —
  // and each route's own validation as a backstop; deployments should
  // additionally cap body size at the reverse proxy (e.g. nginx client_max_body_size).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['content-length'];
    const len = typeof raw === 'string' ? Number(raw) : Array.isArray(raw) ? Number(raw[0]) : NaN;
    if (Number.isFinite(len)) {
      const limit = bodyLimitFor(req.url, req.method);
      if (len > limit) {
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ statusCode: 413, message: `Request body exceeds ${limit} bytes` }));
        return;
      }
    }
    next();
  });

  // One parser per tier, each claiming only the routes at its ceiling, so a
  // gzipped body that passes the compressed-length guard above is still capped
  // at its route's limit once inflated. A single parser at the largest tier
  // would let an unauthenticated route inflate to that ceiling in memory.
  // `type` gates on method+URL as well as media type; exactly one tier matches
  // a request, and body-parser marks the body parsed so the rest skip it.
  for (const limit of BODY_LIMIT_TIERS) {
    const atTier = (req: Request) => bodyLimitFor(req.url, req.method) === limit;
    app.useBodyParser('json', { limit, type: (req: Request) => atTier(req) && Boolean(req.is('application/json')) });
    app.useBodyParser('raw', {
      limit,
      type: (req: Request) => atTier(req) && Boolean(req.is('application/octet-stream')),
    });
  }

  app.useGlobalFilters(new GlobalExceptionFilter(app.get(HttpAdapterHost), app.get(TelemetryService)));
  app.setGlobalPrefix(API_PREFIX, {
    // MCP transport (sse/messages/mcp), the OAuth discovery docs, and the
    // self-hosted OAuth server endpoints are served at the root so they match
    // the absolute URLs advertised in the authorization-server metadata.
    // Derived from ROOT_ROUTES (libs/spa-serving.ts) — the same array backs
    // isReservedPath, so the SPA fallback and this exclude list cannot drift.
    exclude: ROOT_ROUTES,
  });

  // Serve robots.txt (disallow all)
  app.use('/robots.txt', (_req: Request, res: Response) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  // Apply MCP rewrite + auth middleware at Express level (before NestJS
  // routing). Must run without a mount path so req.url rewrite is visible to
  // the NestJS router. Covers both the workspace-scoped API path and the
  // direct root transport paths (/mcp, /sse, /messages) — the predicate is
  // exported by the middleware so the two matchers cannot drift.
  const mcpRewrite = app.get(McpRewriteMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isMcpRequestPath(req.url)) {
      return mcpRewrite.use(req, res, next);
    }
    next();
  });

  // Single-origin SPA serving (docs/web-ui-plan-2026-07.md §3.4). Although
  // this is the last registration in bootstrap, Nest binds its controller
  // routes even later — during init(), inside app.listen() below — so in
  // the final Express stack the SPA static+fallback middleware dispatches
  // BEFORE every Nest route. Registration order protects nothing here:
  // isReservedPath (backed by ROOT_ROUTES) is the only guard keeping
  // API/MCP/OAuth traffic out of the SPA fallback. Any new root-served
  // route MUST be reserved via ROOT_ROUTES — routes excluded from the
  // global prefix are covered automatically (the exclude list IS
  // ROOT_ROUTES), but a root route mounted any other way gets shadowed by
  // index.html for browser GETs (pinned by the Nest-ordering tests in
  // libs/spa-serving.test.ts). WEB_DIST resolves relative to this compiled
  // module: dist/main.js lives in apps/server/dist, so two hops up reaches
  // apps/, then into web/dist (verified against apps/server/tsconfig.json's
  // rootDir:"./src"/outDir:"./dist" — src/main.ts compiles 1:1 to
  // dist/main.js, no extra nesting).
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // resolve() so a relative WEB_DIST_PATH can't half-work: express.static
  // would still serve assets off the relative path (resolved against
  // process.cwd() implicitly), but res.sendFile requires an absolute path
  // and throws "path must be absolute" on every SPA-fallback request.
  const { port: configuredPort, webDistPath } = miscConfigFromEnv();
  const WEB_DIST = webDistPath ? resolve(webDistPath) : join(moduleDir, '../../web/dist');
  registerSpaServing(app, WEB_DIST, new Logger('SpaServing'));

  app.enableShutdownHooks();
  const port = configuredPort ?? 3000;
  await app.listen(port);
  console.log(`Server listening on port ${port}`);
}

export function isMainEntrypoint(entrypoint: string | undefined, moduleUrl: string): boolean {
  if (!entrypoint) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entrypointPath = resolve(entrypoint);
  return entrypointPath === modulePath || `${entrypointPath}${extname(modulePath)}` === modulePath;
}

if (isMainEntrypoint(process.argv[1], import.meta.url)) {
  void bootstrap().catch((error: unknown) => {
    // A configuration failure is an operator's problem, not a stack trace:
    // print one line per bad or missing variable, each naming the variable.
    if (error instanceof AppConfigError) for (const line of error.lines) console.error(line);
    else console.error(error);
    process.exitCode = 1;
  });
}
