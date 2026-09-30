import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Loopback stand-in for the coredoc cloud API.
 *
 * The desktop main process routes every `server-api` call here through the e2e
 * boundary (`COREDOC_DESKTOP_E2E_SERVER_URL`). Routes are declared by the seed profile
 * (`profiles/<name>/server.json`), keyed `"<METHOD> <path>"` — an exact literal
 * match, because fixtures own the ids they seed. Anything else answers 500 and
 * is recorded, so new egress fails the run loudly instead of passing on a
 * silent 200 (spec acceptance 3).
 */

export interface RecordedRequest {
  method: string;
  path: string;
  status: number;
  matched: boolean;
  auth: 'accepted' | 'rejected' | 'not-required';
}

/** `"GET /api/v1/workspaces"` → response body (JSON-serialisable). */
export type RouteTable = Record<string, unknown>;

export interface FixtureServer {
  origin: string;
  requests: RecordedRequest[];
  unmatched(): RecordedRequest[];
  close(): Promise<void>;
}

// Explicit IPv4 loopback on both bind and origin: `localhost` resolves to ::1
// first on this platform, which silently splits server and client.
const HOST = '127.0.0.1';

export async function loadRouteTable(profileDir: string): Promise<RouteTable> {
  const file = `${profileDir}/server.json`;
  if (!existsSync(file)) return {};
  return JSON.parse(await readFile(file, 'utf-8')) as RouteTable;
}

async function readProfileAccessToken(profileDir: string | undefined): Promise<string | null> {
  if (!profileDir) return null;
  const file = `${profileDir}/auth.json`;
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(await readFile(file, 'utf-8')) as { accessToken?: unknown };
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
    throw new Error('Authenticated fixture profile must provide a non-empty access token');
  }
  return parsed.accessToken;
}

export async function startFixtureServer(routes: RouteTable, profileDir?: string): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const accessToken = await readProfileAccessToken(profileDir);

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    const key = `${method} ${path}`;
    const matched = Object.hasOwn(routes, key);
    const requiresAuth = accessToken !== null && path.startsWith('/api/');
    const auth = requiresAuth
      ? req.headers.authorization === `Bearer ${accessToken}`
        ? 'accepted'
        : 'rejected'
      : 'not-required';
    const status = auth === 'rejected' ? 401 : matched ? 200 : 500;

    requests.push({ method, path, status, matched, auth });

    if (auth === 'rejected') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized fixture request' }));
      return;
    }

    if (!matched) {
      console.error(`[fixture-server] unstubbed request ${key} → 500`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No fixture for ${key}` }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(routes[key] ?? null));
  });

  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not bind to a TCP port');
  }

  return {
    origin: `http://${HOST}:${address.port}`,
    requests,
    unmatched: () => requests.filter((entry) => !entry.matched),
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `server.close()` only stops accepting NEW connections — it waits for
        // existing ones to end. Electron's HTTP agent keeps sockets alive, so
        // without this the callback never fires and teardown hangs to timeout.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
