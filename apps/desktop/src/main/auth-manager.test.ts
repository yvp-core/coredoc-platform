import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';

const TEST_USERDATA = join(tmpdir(), 'coredoc-auth-test');
const CREDS_DIR = join(TEST_USERDATA, 'auth');
const CREDS_FILE = join(CREDS_DIR, 'credentials.json');

// Keychain availability is per-test state: the default (unavailable) keeps the
// credentials store readable, while the e2e write-path test needs the branch a
// real macOS session takes.
const safeStorageState = vi.hoisted(() => ({ encryptionAvailable: false }));

// electron is imported at module load (app.getPath) — mock before importing auth-manager.
vi.mock('electron', () => ({
  app: { getPath: () => TEST_USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`ENCRYPTED:${s}`),
    decryptString: (b: Buffer) => b.toString('utf-8').replace(/^ENCRYPTED:/, ''),
  },
  shell: { openExternal: vi.fn() },
}));

// Keep the server URL deterministic and offline. `resolved` is per-test state:
// the credential/server binding check compares the stored tokens' issuer with
// the resolved URL for every source, so each test states which server the app
// resolves to.
const serverUrlState = vi.hoisted(() => ({
  resolved: { url: 'http://localhost:3000', source: 'override' } as { url: string; source: string },
}));

vi.mock('./server-url.js', () => ({
  getConfiguredServerUrl: () => serverUrlState.resolved.url,
  resolveServerConfig: () => serverUrlState.resolved,
  setServerUrl: vi.fn(),
  resetServerUrl: vi.fn(),
}));

const fetchMock = vi.fn();

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(payload), text: () => Promise.resolve('') } as unknown as Response;
}

/** A structurally-valid JWT (header.payload.sig) — only the payload is decoded by the code. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function tokenBody(callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return new URLSearchParams(init.body as string);
}

beforeEach(async () => {
  vi.resetModules();
  safeStorageState.encryptionAvailable = false;
  serverUrlState.resolved = { url: 'http://localhost:3000', source: 'override' };
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  await rm(TEST_USERDATA, { recursive: true, force: true });
});

afterEach(async () => {
  // Clear any refresh timer/state left in the module instance this test used.
  try {
    const m = await import('./auth-manager.js');
    await m.logout();
  } catch {
    /* module may not have been imported */
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(TEST_USERDATA, { recursive: true, force: true });
});

describe('startLogin', () => {
  it('registers a client and builds an /authorize URL with PKCE + state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-abc' })); // POST /register

    const { startLogin } = await import('./auth-manager.js');
    const url = await startLogin();

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/register$/);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client-abc');
    expect(parsed.searchParams.get('redirect_uri')).toBe('coredoc://auth/callback');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(parsed.searchParams.get('scope')).toBe('offline_access');
  });
});

describe('handleAuthCallback', () => {
  it('validates state, exchanges the code, and returns identity with a marked token stored', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-abc' })); // /register
    const accessToken = fakeJwt({
      type: 'access',
      user_profile_id: 'u1',
      user_data: { email: 'a@b.co', displayName: 'A B' },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: accessToken, refresh_token: 'rt', expires_in: 3600 })); // /token

    const m = await import('./auth-manager.js');
    const url = await m.startLogin();
    const state = new URL(url).searchParams.get('state')!;

    const result = await m.handleAuthCallback(`coredoc://auth/callback?code=CODE123&state=${state}`);
    expect(result).toEqual({ email: 'a@b.co', userId: 'u1' });

    // token exchange used authorization_code with our code + client
    const body = tokenBody(1);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/token$/);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE123');
    expect(body.get('client_id')).toBe('client-abc');
    expect(body.get('redirect_uri')).toBe('coredoc://auth/callback');
    expect(body.get('code_verifier')).toBeTruthy();

    // stored/cached token carries the migration marker
    const stored = await m.getStoredTokens();
    expect(stored?.tokenFormat).toBe('coredoc-as');
    expect(stored?.clientId).toBe('client-abc');
  });

  it('rejects a mismatched state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-abc' })); // /register
    const m = await import('./auth-manager.js');
    await m.startLogin();
    await expect(m.handleAuthCallback('coredoc://auth/callback?code=CODE&state=WRONG')).rejects.toThrow(/state/i);
  });

  it('rejects when there is no pending login', async () => {
    const m = await import('./auth-manager.js');
    await expect(m.handleAuthCallback('coredoc://auth/callback?code=CODE&state=X')).rejects.toThrow(/PKCE session/i);
  });
});

describe('stored credentials vs. the resolved server', () => {
  const storedTokens = (serverUrl: string) => ({
    tokenFormat: 'coredoc-as',
    accessToken: fakeJwt({ type: 'access', user_profile_id: 'u1', user_data: { email: 'a@b.co' } }),
    refreshToken: 'rt',
    expiresAt: Date.now() + 3_600_000,
    userId: 'u1',
    email: 'a@b.co',
    serverUrl,
    clientId: 'client-abc',
  });

  async function writeCredentials(serverUrl: string): Promise<void> {
    await mkdir(CREDS_DIR, { recursive: true });
    await writeFile(CREDS_FILE, JSON.stringify(storedTokens(serverUrl)), 'utf-8');
  }

  it('reports logged out when a managed config pins a different server than the one that issued them', async () => {
    await writeCredentials('https://server-a.example');
    serverUrlState.resolved = { url: 'https://server-b.example', source: 'managed' };

    const m = await import('./auth-manager.js');

    expect(await m.getStoredTokens()).toBeNull();
    // Nothing downstream can attach the old bearer: getValidTokens is the only
    // token source for server-api's Authorization header, telemetry and chat.
    expect(await m.getValidTokens()).toBeNull();
    expect(m.isLoggedIn()).toBe(false);
    // The admin may roll the managed pin back — the session must survive on disk.
    expect(JSON.parse(await readFile(CREDS_FILE, 'utf-8')).serverUrl).toBe('https://server-a.example');
  });

  it('accepts credentials whose issuer is the managed server, ignoring trailing-slash spelling', async () => {
    await writeCredentials('https://server-a.example');
    serverUrlState.resolved = { url: 'https://server-a.example/', source: 'managed' };

    const { getValidTokens } = await import('./auth-manager.js');

    expect((await getValidTokens())?.email).toBe('a@b.co');
  });

  it('reports logged out when COREDOC_SERVER_URL selects a different server than the issuer', async () => {
    await writeCredentials('https://server-a.example');
    serverUrlState.resolved = { url: 'https://server-b.example', source: 'env' };

    const m = await import('./auth-manager.js');

    expect(await m.getStoredTokens()).toBeNull();
    expect(await m.getValidTokens()).toBeNull();
    // Restoring would install server A as the runtime override, which outranks
    // env — the configured server must win.
    expect(JSON.parse(await readFile(CREDS_FILE, 'utf-8')).serverUrl).toBe('https://server-a.example');
  });

  it("reports logged out when the user's persisted server choice differs from the issuer", async () => {
    await writeCredentials('https://server-a.example');
    serverUrlState.resolved = { url: 'https://server-b.example', source: 'user' };

    const m = await import('./auth-manager.js');

    expect(await m.getStoredTokens()).toBeNull();
    expect(await m.getValidTokens()).toBeNull();
    expect(JSON.parse(await readFile(CREDS_FILE, 'utf-8')).serverUrl).toBe('https://server-a.example');
  });

  it('restores the session when the bundled default is the server that issued them', async () => {
    await writeCredentials('https://server-a.example');
    serverUrlState.resolved = { url: 'https://server-a.example', source: 'bundled' };

    const { getStoredTokens } = await import('./auth-manager.js');

    expect((await getStoredTokens())?.serverUrl).toBe('https://server-a.example');
  });

  it('reports logged out when the stored issuer is not a usable URL', async () => {
    await writeCredentials('not-a-url');
    serverUrlState.resolved = { url: 'https://server-a.example', source: 'bundled' };

    const { getStoredTokens } = await import('./auth-manager.js');

    expect(await getStoredTokens()).toBeNull();
  });
});

describe('getStoredTokens', () => {
  it('discards legacy credentials without the coredoc-as marker', async () => {
    await mkdir(CREDS_DIR, { recursive: true });
    await writeFile(
      CREDS_FILE,
      JSON.stringify({ accessToken: 'workos-rs256', refreshToken: 'x', expiresAt: Date.now() + 1_000_000 }),
      'utf-8',
    );
    const { getStoredTokens } = await import('./auth-manager.js');
    expect(await getStoredTokens()).toBeNull();
  });
});

describe('e2e credential seam', () => {
  const SEED_FILE = join(TEST_USERDATA, 'seed-credentials.json');
  /** The fixture server the harness seeds into both the boundary and the tokens. */
  const E2E_SERVER_URL = 'http://127.0.0.1:41999';

  const seedTokens = (overrides: Record<string, unknown> = {}) => ({
    tokenFormat: 'coredoc-as',
    accessToken: fakeJwt({ type: 'access', user_profile_id: 'u-e2e' }),
    refreshToken: 'rt-e2e',
    expiresAt: Date.now() + 3_600_000,
    userId: 'u-e2e',
    email: 'e2e@example.test',
    serverUrl: E2E_SERVER_URL,
    clientId: 'client-e2e',
    ...overrides,
  });

  async function writeSeed(tokens: unknown): Promise<void> {
    await mkdir(TEST_USERDATA, { recursive: true });
    await writeFile(SEED_FILE, JSON.stringify(tokens), 'utf-8');
  }

  /**
   * The applied boundary: app.getPath('userData') is the mocked TEST_USERDATA,
   * and the resolved server is the fixture origin — `e2e-mode-boot` installs
   * that override before any module can restore tokens, so the seeded issuer
   * and the resolved URL agree by construction.
   */
  function stubAppliedE2E(): void {
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');
    vi.stubEnv('COREDOC_DESKTOP_E2E_USER_DATA_DIR', TEST_USERDATA);
    serverUrlState.resolved = { url: E2E_SERVER_URL, source: 'override' };
  }

  it('loads the session from the seed file when e2e mode points at one', async () => {
    await writeSeed(seedTokens());
    stubAppliedE2E();
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const { getStoredTokens, isLoggedIn } = await import('./auth-manager.js');

    expect((await getStoredTokens())?.email).toBe('e2e@example.test');
    expect(isLoggedIn()).toBe(true);
    // The seed file is the only source — no credentials store was consulted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws instead of booting logged out when the seed file does not exist', async () => {
    stubAppliedE2E();
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', join(TEST_USERDATA, 'missing.json'));

    const { getStoredTokens } = await import('./auth-manager.js');
    await expect(getStoredTokens()).rejects.toThrow(/not an existing file/);
  });

  it('throws instead of booting logged out when the seed file is unparseable', async () => {
    await mkdir(TEST_USERDATA, { recursive: true });
    await writeFile(SEED_FILE, 'not json', 'utf-8');
    stubAppliedE2E();
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const { getStoredTokens } = await import('./auth-manager.js');
    await expect(getStoredTokens()).rejects.toThrow(/COREDOC_DESKTOP_E2E_AUTH_FILE could not be read/);
  });

  it('throws when the seed file is not a coredoc-as credentials object', async () => {
    await writeSeed(seedTokens({ tokenFormat: 'workos' }));
    stubAppliedE2E();
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const { getStoredTokens } = await import('./auth-manager.js');
    await expect(getStoredTokens()).rejects.toThrow(/not a coredoc-as credentials object/);
  });

  it('refuses to read the seed file when the boundary was not applied to userData', async () => {
    await writeSeed(seedTokens());
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');
    vi.stubEnv('COREDOC_DESKTOP_E2E_USER_DATA_DIR', join(TEST_USERDATA, 'elsewhere'));
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const { getStoredTokens } = await import('./auth-manager.js');
    await expect(getStoredTokens()).rejects.toThrow(/requires the applied e2e boundary/);
  });

  it('does not resurrect the seeded session after an explicit logout', async () => {
    await writeSeed(seedTokens());
    stubAppliedE2E();
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const m = await import('./auth-manager.js');
    expect(await m.getStoredTokens()).not.toBeNull();

    await m.logout();

    expect(await m.getStoredTokens()).toBeNull();
    expect(m.isLoggedIn()).toBe(false);
  });

  it('boots logged out in e2e mode without a seed file', async () => {
    stubAppliedE2E();

    const { getStoredTokens } = await import('./auth-manager.js');
    expect(await getStoredTokens()).toBeNull();
  });

  it('persists plaintext credentials in e2e mode even when the Keychain is available', async () => {
    safeStorageState.encryptionAvailable = true;
    stubAppliedE2E();
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-abc' })); // /register
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: fakeJwt({ type: 'access', user_profile_id: 'u1', user_data: { email: 'a@b.co' } }),
        refresh_token: 'rt',
        expires_in: 3600,
      }),
    ); // /token

    const m = await import('./auth-manager.js');
    const state = new URL(await m.startLogin()).searchParams.get('state')!;
    await m.handleAuthCallback(`coredoc://auth/callback?code=CODE123&state=${state}`);

    const written = await readFile(CREDS_FILE, 'utf-8');
    expect(written.startsWith('ENCRYPTED:')).toBe(false);
    expect(JSON.parse(written).tokenFormat).toBe('coredoc-as');
  });

  it('refuses to persist plaintext credentials when the boundary was not applied to userData', async () => {
    safeStorageState.encryptionAvailable = true;
    vi.stubEnv('COREDOC_DESKTOP_E2E', '1');
    vi.stubEnv('COREDOC_DESKTOP_E2E_USER_DATA_DIR', join(TEST_USERDATA, 'elsewhere'));
    fetchMock.mockResolvedValueOnce(jsonResponse({ client_id: 'client-abc' })); // /register
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: fakeJwt({ type: 'access', user_profile_id: 'u1', user_data: { email: 'a@b.co' } }),
        refresh_token: 'rt',
        expires_in: 3600,
      }),
    ); // /token

    const m = await import('./auth-manager.js');
    const state = new URL(await m.startLogin()).searchParams.get('state')!;

    await expect(m.handleAuthCallback(`coredoc://auth/callback?code=CODE123&state=${state}`)).rejects.toThrow(
      /requires the applied e2e boundary/,
    );
  });

  it('ignores the seed file outside e2e mode', async () => {
    await writeSeed(seedTokens());
    vi.stubEnv('COREDOC_DESKTOP_E2E_AUTH_FILE', SEED_FILE);

    const { getStoredTokens } = await import('./auth-manager.js');
    expect(await getStoredTokens()).toBeNull();
  });
});

describe('getValidTokens', () => {
  it('refreshes via /token grant_type=refresh_token when the access token is near expiry', async () => {
    const at0 = fakeJwt({ type: 'access', user_profile_id: 'u1', user_data: { email: 'a@b.co' } });
    await mkdir(CREDS_DIR, { recursive: true });
    await writeFile(
      CREDS_FILE,
      JSON.stringify({
        tokenFormat: 'coredoc-as',
        accessToken: at0,
        refreshToken: 'rt',
        expiresAt: Date.now() + 60_000, // < 5-min buffer → triggers refresh
        userId: 'u1',
        email: 'a@b.co',
        serverUrl: 'http://localhost:3000',
        clientId: 'client-abc',
      }),
      'utf-8',
    );
    const at1 = fakeJwt({ type: 'access', user_profile_id: 'u1', user_data: { email: 'a@b.co' } });
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: at1, refresh_token: 'rt2', expires_in: 3600 }));

    const { getValidTokens } = await import('./auth-manager.js');
    const t = await getValidTokens();

    expect(t?.accessToken).toBe(at1);
    const body = tokenBody(0);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('client-abc');
  });
});
