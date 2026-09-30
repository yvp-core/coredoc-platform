import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ROOT_ROUTES, isReservedPath, registerSpaServing, type SpaServingHost } from './spa-serving.js';

function makeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spa-serving-test-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
  return dir;
}

const noopLogger = { log: () => undefined };

describe('ROOT_ROUTES', () => {
  it('matches the exclude list wired into main.ts (drift lock)', async () => {
    // main.ts derives its setGlobalPrefix exclude list from ROOT_ROUTES — read
    // the source rather than importing main.ts (which boots a full Nest app)
    // to keep this a pure unit test of the contract.
    const mainTsSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8'),
    );
    // ROOT_ROUTES must be imported and referenced, not re-typed as a literal.
    expect(mainTsSource).toMatch(/import\s*\{[^}]*ROOT_ROUTES[^}]*\}\s*from\s*['"]\.\/libs\/spa-serving\.js['"]/);
    expect(mainTsSource).toMatch(/exclude:\s*ROOT_ROUTES/);
  });

  it('is the exact known root route set, in order', () => {
    expect(ROOT_ROUTES).toEqual([
      'sse',
      'messages',
      'mcp',
      '.well-known/*',
      'authorize',
      'callback',
      'token',
      'revoke',
      'register',
    ]);
  });
});

describe('isReservedPath', () => {
  const reserved: string[] = [
    '/api/v1/health',
    '/api',
    '/mcp',
    '/mcp/x',
    '/sse',
    '/messages',
    '/authorize',
    '/callback',
    '/token',
    '/revoke',
    '/register',
    '/robots.txt',
    '/.well-known/oauth-authorization-server',
  ];
  const notReserved: string[] = ['/', '/login', '/w/acme/repos', '/assets/index-abc123.js', '/mcpx', '/tokens-page'];

  it.each(reserved)('treats %s as reserved', (path) => {
    expect(isReservedPath(path)).toBe(true);
  });

  it.each(notReserved)('treats %s as NOT reserved', (path) => {
    expect(isReservedPath(path)).toBe(false);
  });

  it('strips query strings before matching', () => {
    expect(isReservedPath('/w/acme?tab=1')).toBe(false);
    expect(isReservedPath('/mcp?x=1')).toBe(true);
  });
});

describe('registerSpaServing when webDist is unusable', () => {
  // The disabled path needs no HTTP server: a fake structural host proves
  // registerSpaServing registers NOTHING (not merely "nothing that answers").
  function fakeHost(): SpaServingHost & { registrations: string[] } {
    const registrations: string[] = [];
    return {
      registrations,
      useStaticAssets: () => registrations.push('static'),
      use: () => registrations.push('middleware'),
    };
  }

  it('logs once and registers nothing when the directory does not exist', () => {
    const messages: string[] = [];
    const host = fakeHost();
    const missing = join(tmpdir(), 'spa-serving-test-does-not-exist');
    registerSpaServing(host, missing, { log: (m) => messages.push(m) });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('SPA serving disabled');
    expect(messages[0]).toContain(missing);
    expect(host.registrations).toEqual([]);
  });

  it('logs once and registers nothing when index.html is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spa-serving-test-noindex-'));
    try {
      const messages: string[] = [];
      const host = fakeHost();
      registerSpaServing(host, dir, { log: (m) => messages.push(m) });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('SPA serving disabled');
      expect(messages[0]).toContain(dir);
      expect(host.registrations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Root-served controller: 'token' is in ROOT_ROUTES, so with
// setGlobalPrefix(..., { exclude: ROOT_ROUTES }) it answers at /token.
@Controller('token')
class FakeRootServedController {
  @Get()
  get() {
    return { root: 'token' };
  }
}

// Prefixed controller: answers at /api/v1/health.
@Controller('health')
class FakeApiController {
  @Get()
  get() {
    return { ok: true };
  }
}

// Root-served controller whose exclusion BYPASSES ROOT_ROUTES — used to pin
// the drift trap: isReservedPath has never heard of it.
@Controller('probe')
class FakeUnlistedRootController {
  @Get()
  get() {
    return { probe: true };
  }
}

/** Bind the Nest app to an ephemeral 127.0.0.1 port and return its base URL. */
async function listenNest(app: INestApplication): Promise<string> {
  // Explicit 127.0.0.1 (not the dual-stack wildcard) so the fetch target is
  // exactly — and only — this server.
  await app.listen(0, '127.0.0.1');
  const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * Destroy keep-alive sockets, then close. fetch/undici pools idle
 * connections per host:port origin; if a later test's server gets an old
 * ephemeral port back from the kernel while a pooled socket to the OLD
 * server is still alive, requests would silently be answered by the wrong
 * server (observed as a rare flake before this teardown existed).
 */
async function closeNest(app: INestApplication): Promise<void> {
  (app.getHttpServer() as Server).closeAllConnections();
  await app.close();
}

describe('registerSpaServing under real Nest bootstrap ordering', () => {
  // Mirrors main.ts bootstrap exactly: setGlobalPrefix with
  // exclude: ROOT_ROUTES, express-level middlewares (the MCP matcher
  // stand-in) via app.use, registerSpaServing on the Nest app itself, THEN
  // app.listen() — which is what runs init() and binds the controller
  // routes. Nest routes therefore sit AFTER the SPA middleware in the
  // final Express stack, so these tests prove isReservedPath, not
  // registration order, is what keeps Nest routes reachable.
  let tmpDir: string;
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = makeWebDist();
    const moduleRef = await Test.createTestingModule({
      controllers: [FakeRootServedController, FakeApiController],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('/api/v1', { exclude: ROOT_ROUTES });

    // Express-level stand-ins for the bootstrap middlewares that really do
    // register before the SPA (the MCP matcher, robots.txt).
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.url.split('?')[0] === '/mcp') {
        res.status(200).send('mcp-handler');
        return;
      }
      next();
    });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'POST' && req.url.split('?')[0] === '/w/acme') {
        res.status(201).json({ created: true });
        return;
      }
      next();
    });

    registerSpaServing(app, tmpDir, noopLogger);
    baseUrl = await listenNest(app);
  });

  afterAll(async () => {
    await closeNest(app);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('root-served controller route answers JSON, not index.html — even for a browser GET', async () => {
    const res = await fetch(`${baseUrl}/token`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('<!doctype');
    expect(JSON.parse(text)).toEqual({ root: 'token' });
  });

  it('prefixed API route answers JSON — even for a browser GET', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('unknown /api/v1 path gets the Nest JSON 404, never html', async () => {
    const res = await fetch(`${baseUrl}/api/v1/nonexistent`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<!doctype');
  });

  it('express-level MCP handler wins over the fallback — never served as html', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('mcp-handler');
  });

  it('serves hashed assets with the immutable cache header', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('serves the shell at / with no-store for a browser GET', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('non-reserved browser GET falls back to index.html with no-store', async () => {
    const res = await fetch(`${baseUrl}/w/acme`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('same path with a JSON Accept header is not served html (Nest 404)', async () => {
    const res = await fetch(`${baseUrl}/w/acme`, { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<!doctype');
  });

  it('POST to a client-side route reaches its handler — the fallback only matches GET/HEAD', async () => {
    const res = await fetch(`${baseUrl}/w/acme`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true });
  });

  it('redirects direct GET /index.html to / — the shell must never be immutable', async () => {
    // The static mount's `index: false` only disables directory-index
    // resolution; without the explicit redirect a direct /index.html GET
    // would be served from disk with the 1y-immutable header, freezing the
    // app shell (the freshness signal for all hashed assets) in caches.
    const res = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('cache-control') ?? '').not.toContain('immutable');

    // Following the redirect lands on the fallback-served shell: no-store.
    const followed = await fetch(`${baseUrl}/index.html`, { headers: { Accept: 'text/html' } });
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain('app');
    expect(followed.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps API routes working and 404s the fallback when webDist is missing', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FakeApiController],
    }).compile();
    const bareApp = moduleRef.createNestApplication<NestExpressApplication>();
    bareApp.setGlobalPrefix('/api/v1', { exclude: ROOT_ROUTES });
    registerSpaServing(bareApp, join(tmpdir(), 'spa-serving-test-does-not-exist'), noopLogger);
    const bareUrl = await listenNest(bareApp);
    try {
      const apiRes = await fetch(`${bareUrl}/api/v1/health`);
      expect(apiRes.status).toBe(200);
      expect(await apiRes.json()).toEqual({ ok: true });

      const rootRes = await fetch(`${bareUrl}/`, { headers: { Accept: 'text/html' } });
      expect(rootRes.status).toBe(404);
    } finally {
      await closeNest(bareApp);
    }
  });

  it('pins the drift trap: a root route excluded WITHOUT a ROOT_ROUTES entry is shadowed for browser GETs', async () => {
    // A hand-drifted exclude list (bypassing the ROOT_ROUTES derivation)
    // leaves isReservedPath blind to the route — and because the SPA
    // middleware dispatches before Nest routes, the fallback swallows
    // browser GETs to it. This is WHY main.ts must keep deriving its
    // exclude list from ROOT_ROUTES, and why the comments there say
    // registration order protects nothing.
    const moduleRef = await Test.createTestingModule({
      controllers: [FakeUnlistedRootController],
    }).compile();
    const trapApp = moduleRef.createNestApplication<NestExpressApplication>();
    trapApp.setGlobalPrefix('/api/v1', { exclude: [...ROOT_ROUTES, 'probe'] });
    registerSpaServing(trapApp, tmpDir, noopLogger);
    const trapUrl = await listenNest(trapApp);
    try {
      // Browser GET: the SPA fallback wins — the controller never runs.
      const htmlRes = await fetch(`${trapUrl}/probe`, { headers: { Accept: 'text/html' } });
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain('<!doctype html>');
      // Non-HTML clients still reach the controller (fallback declines).
      const jsonRes = await fetch(`${trapUrl}/probe`, { headers: { Accept: 'application/json' } });
      expect(jsonRes.status).toBe(200);
      expect(await jsonRes.json()).toEqual({ probe: true });
    } finally {
      await closeNest(trapApp);
    }
  });
});
