import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHECKOUT_PREFIX,
  CloudClient,
  DEFAULT_EVAL_SERVER_URL,
  SEED_PROBE_ID,
  probeIntentContext,
  readCliAccessToken,
  readMcpToken,
  readRunConfig,
  resolveAccessToken,
  resolveServerUrl,
  seedCloudWorkspace,
  stageCheckout,
  workspaceMcpUrl,
  writeRunConfig,
  type FetchLike,
  type IntentEvalRunConfig,
} from './setup.js';
import { readSeedIntent, seedToWorkspaceDocument } from './seed-document.js';

const SERVER = 'http://localhost:3000';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers from a route table and records every call. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const path = url.slice(SERVER.length);
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(`no route for ${method} ${path}`, { status: 500 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), { status: route.status ?? 200 });
  };
  return { fetch, calls };
}

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intent-eval-setup-test-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('server and credential resolution', () => {
  it('defaults to the server:dev port and strips trailing slashes from the env URL', () => {
    expect(resolveServerUrl({})).toBe(DEFAULT_EVAL_SERVER_URL);
    expect(resolveServerUrl({ COREDOC_EVAL_SERVER_URL: 'https://staging.example.com/' })).toBe(
      'https://staging.example.com',
    );
    expect(workspaceMcpUrl(SERVER, 'ws1')).toBe(`${SERVER}/api/v1/workspaces/ws1/mcp`);
  });

  it('prefers COREDOC_EVAL_ACCESS_TOKEN and refuses a service token, which the import would reject', () => {
    const unused = () => {
      throw new Error('should not read the CLI login');
    };
    expect(resolveAccessToken({ COREDOC_EVAL_ACCESS_TOKEN: 'jwt-1' }, SERVER, unused)).toBe('jwt-1');
    expect(resolveAccessToken({}, SERVER, () => 'jwt-2')).toBe('jwt-2');
    expect(() => resolveAccessToken({ COREDOC_EVAL_ACCESS_TOKEN: 'cdt_abc' }, SERVER, unused)).toThrow(/user session/);
  });

  it('reads the CLI login only when it is for this server and unexpired', () => {
    const path = join(tempDir(), 'credentials.json');
    writeFileSync(path, JSON.stringify({ accessToken: 'jwt', serverUrl: `${SERVER}/`, expiresAt: 2_000 }));
    expect(readCliAccessToken(SERVER, path, 1_000)).toBe('jwt');
    expect(() => readCliAccessToken('https://other.example.com', path, 1_000)).toThrow(/not https:\/\/other/);
    expect(() => readCliAccessToken(SERVER, path, 3_000)).toThrow(/expired/);
    expect(() => readCliAccessToken(SERVER, join(tempDir(), 'missing.json'))).toThrow(/cli login --server/);
  });
});

describe('seedCloudWorkspace', () => {
  const document = seedToWorkspaceDocument(readSeedIntent());
  const happyRoutes = {
    'DELETE /api/v1/workspaces/old-ws': { status: 404, body: { message: 'Workspace not found' } },
    'POST /api/v1/workspaces': { status: 201, body: { id: 'ws-new', slug: 'intent-eval-x' } },
    'PATCH /api/v1/workspaces/ws-new': { body: { id: 'ws-new', intentEnabled: true } },
    'POST /api/v1/workspaces/ws-new/intent/import/workspace': {
      status: 201,
      body: { counts: { items: { accepted: 7, candidate: 2, superseded: 0, rejected: 1 } } },
    },
    'POST /api/v1/workspaces/ws-new/tokens': { status: 201, body: { id: 'tok-1', token: 'cdt_secret' } },
  };

  it('replaces the previous workspace, enables intent, imports the seed and mints an intent-agent token', async () => {
    const { fetch, calls } = fakeFetch(happyRoutes);
    const seeded = await seedCloudWorkspace({
      client: new CloudClient(SERVER, 'jwt-user', fetch),
      document,
      previousWorkspaceId: 'old-ws',
      now: 1_700_000_000_000,
    });

    expect(calls.map((call) => `${call.method} ${call.url.slice(SERVER.length)}`)).toEqual([
      'DELETE /api/v1/workspaces/old-ws',
      'POST /api/v1/workspaces',
      'PATCH /api/v1/workspaces/ws-new',
      'POST /api/v1/workspaces/ws-new/intent/import/workspace',
      'POST /api/v1/workspaces/ws-new/tokens',
    ]);
    for (const call of calls) expect(call.headers.Authorization).toBe('Bearer jwt-user');
    expect(calls[1]!.body).toEqual({ name: 'Intent eval', slug: `intent-eval-${(1_700_000_000_000).toString(36)}` });
    expect(calls[2]!.body).toEqual({ intentEnabled: true });
    expect(calls[3]!.body).toEqual({
      idempotencyKey: `intent-eval-seed-${document.source.revision.slice(0, 16)}`,
      document,
    });
    expect(calls[4]!.body).toEqual({ name: 'intent-eval-mcp', scope: 'intent-agent' });
    expect(seeded).toMatchObject({ workspaceId: 'ws-new', tokenId: 'tok-1', token: 'cdt_secret' });
    expect(seeded.importCounts).toEqual({ items: { accepted: 7, candidate: 2, superseded: 0, rejected: 1 } });
  });

  it('creates without deleting when no previous workspace was recorded', async () => {
    const { fetch, calls } = fakeFetch(happyRoutes);
    await seedCloudWorkspace({ client: new CloudClient(SERVER, 'jwt-user', fetch), document });
    expect(calls[0]!.method).toBe('POST');
  });

  it('stops on a refused import and reports the server answer', async () => {
    const { fetch, calls } = fakeFetch({
      ...happyRoutes,
      'POST /api/v1/workspaces/ws-new/intent/import/workspace': {
        status: 403,
        body: { message: 'This endpoint requires a user session, not a service token' },
      },
    });
    await expect(
      seedCloudWorkspace({ client: new CloudClient(SERVER, 'jwt-user', fetch), document }),
    ).rejects.toThrow(/import\/workspace failed \(403\).*user session/);
    expect(calls.some((call) => call.url.endsWith('/tokens'))).toBe(false);
  });
});

describe('probeIntentContext', () => {
  const path = `GET /api/v1/workspaces/ws-new/intent/context?intentIds=${SEED_PROBE_ID}`;

  it('accepts a context answer that serves the seeded item, read with the agents token', async () => {
    const { fetch, calls } = fakeFetch({ [path]: { body: { items: [{ id: SEED_PROBE_ID }] } } });
    await probeIntentContext(SERVER, 'ws-new', 'cdt_secret', fetch);
    expect(calls[0]!.headers.Authorization).toBe('Bearer cdt_secret');
  });

  it('refuses an answer without the seeded item', async () => {
    const { fetch } = fakeFetch({ [path]: { body: { items: [] } } });
    await expect(probeIntentContext(SERVER, 'ws-new', 'cdt_secret', fetch)).rejects.toThrow(/eval:intent:setup/);
  });
});

describe('run config and checkout', () => {
  function config(dir: string): IntentEvalRunConfig {
    return {
      version: 1,
      serverUrl: SERVER,
      workspaceId: 'ws-new',
      workspaceSlug: 'intent-eval-x',
      mcpUrl: workspaceMcpUrl(SERVER, 'ws-new'),
      tokenId: 'tok-1',
      tokenFile: join(dir, 'mcp-token'),
      checkoutRoot: '/tmp/x',
      seedRevision: 'a'.repeat(64),
      importCounts: null,
      anchorsStaged: false,
      createdAt: '2026-10-03T00:00:00.000Z',
    };
  }

  it('keeps the token out of the config and in a mode-0600 file', () => {
    const dir = tempDir();
    writeRunConfig(config(dir), 'cdt_secret', dir);
    const written = readRunConfig(join(dir, 'cloud-run.json'))!;
    expect(written.workspaceId).toBe('ws-new');
    expect(readFileSync(join(dir, 'cloud-run.json'), 'utf8')).not.toContain('cdt_secret');
    expect(statSync(written.tokenFile).mode & 0o777).toBe(0o600);
    expect(readMcpToken(written, {})).toBe('cdt_secret');
    expect(readMcpToken(written, { COREDOC_EVAL_MCP_TOKEN: 'cdt_env' })).toBe('cdt_env');
  });

  it('stages the fixture outside the repository and removes only its own previous checkout', () => {
    const first = stageCheckout();
    scratch.push(first);
    expect(first.startsWith(join(tmpdir(), CHECKOUT_PREFIX))).toBe(true);
    expect(existsSync(join(first, 'src'))).toBe(true);

    const second = stageCheckout(first);
    scratch.push(second);
    expect(existsSync(first)).toBe(false);

    const foreign = tempDir();
    const third = stageCheckout(foreign);
    scratch.push(third);
    expect(existsSync(foreign)).toBe(true);
  });
});
