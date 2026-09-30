/**
 * Auth Manager — Desktop OAuth via the self-hosted coredoc AS.
 *
 * PKCE Authorization-Code flow against ${serverUrl}/register + /authorize +
 * /token (the @rekog/mcp-nest McpAuthModule). The AS delegates the actual
 * login to its configured upstream (WorkOS AuthKit for SaaS, or an on-prem
 * provider) — the desktop never talks to any IdP directly. startLogin() returns
 * the authorize URL for the caller to open via shell.openExternal(); the AS
 * redirects back to coredoc://auth/callback, routed to handleAuthCallback() by
 * the deep-link handler in index.ts.
 *
 * Tokens are the HS256 access tokens the AS mints (type: 'access') — exactly
 * what the server's AuthGuard / AuthService.verifyAccessToken accept.
 */

import { safeStorage } from 'electron';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { randomBytes, createHash } from 'node:crypto';
import { getConfiguredServerUrl, resetServerUrl, resolveServerConfig } from './server-url.js';
import { isE2EMode, resolveE2EAuthFile } from './e2e-mode.js';
import { normalizeServerUrl } from '../shared/server-url-format.js';

const CREDENTIALS_DIR = join(app.getPath('userData'), 'auth');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');
const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const REDIRECT_URI = 'coredoc://auth/callback';
const TOKEN_FORMAT = 'coredoc-as';

export interface AuthTokens {
  /** Marker distinguishing AS-issued creds from legacy WorkOS creds. */
  tokenFormat: typeof TOKEN_FORMAT;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
  displayName?: string;
  serverUrl: string;
  /** Public OAuth client id (from dynamic registration) — used to refresh. */
  clientId: string;
}

let cachedTokens: AuthTokens | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<AuthTokens | null> | null = null;
export type AuthChangeReason = 'callback' | 'refresh' | 'logout' | 'refresh-failed';

let authChangeCallback:
  | ((status: { isLoggedIn: boolean; email: string | null; userId: string | null; reason: AuthChangeReason }) => void)
  | null = null;

// PKCE + provider selection state for the in-flight login — cleared after use/expiry.
let pendingPkce: {
  codeVerifier: string;
  state: string;
  clientId: string;
  serverUrl: string;
  expiresAt: number;
} | null = null;

/**
 * True once logout() ran: the harness seed file is a boot-time fixture, not a
 * credentials store, so without this a post-logout cache miss would re-read it
 * and resurrect the session the test just ended.
 */
let e2eSeedInvalidated = false;

const isExistingFile = (candidate: string): boolean => existsSync(candidate) && statSync(candidate).isFile();

/**
 * Couple the e2e credential paths to the APPLIED boundary, not the raw flag.
 * If userData was not actually redirected (e2e-mode-boot.js no longer imported
 * first in index.ts), plaintext credentials would be written into — or read
 * from — the developer's real profile. Checked lazily at call time because
 * app.getPath reflects the setPath that module scope may precede.
 */
function assertE2EBoundaryApplied(): void {
  const expected = process.env.COREDOC_DESKTOP_E2E_USER_DATA_DIR?.trim();
  const actual = app.getPath('userData');
  if (!expected || actual !== expected) {
    throw new Error(
      'E2E credential handling requires the applied e2e boundary: ' +
        `userData is ${actual}, expected ${expected ?? '(COREDOC_DESKTOP_E2E_USER_DATA_DIR unset)'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function buildAuthorizeUrl(params: {
  serverUrl: string;
  clientId: string;
  challenge: string;
  state: string;
}): string {
  return (
    `${params.serverUrl}/authorize?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: params.clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: params.challenge,
      code_challenge_method: 'S256',
      state: params.state,
      scope: 'offline_access',
    }).toString()
  );
}

// ---------------------------------------------------------------------------
// AS HTTP
// ---------------------------------------------------------------------------

/**
 * Register this desktop app as a public OAuth client (RFC 7591). The AS derives
 * a deterministic client_id from the metadata, so repeated registration is
 * idempotent (no duplicate rows).
 */
async function registerClient(serverUrl: string): Promise<string> {
  const res = await fetch(`${serverUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'coredoc-desktop',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw new Error(`Client registration failed: ${res.status}`);
  const data = (await res.json()) as { client_id?: string };
  if (!data.client_id) throw new Error('Client registration returned no client_id');
  return data.client_id;
}

interface RawTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postToken(serverUrl: string, form: Record<string, string>): Promise<RawTokenResponse> {
  const res = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const data = (await res.json()) as RawTokenResponse;
  if (!data.access_token) throw new Error('Token exchange returned no access_token');
  return data;
}

/** Build AuthTokens from a raw /token response, reading identity from the JWT. */
function tokensFromResponse(raw: RawTokenResponse, serverUrl: string, clientId: string): AuthTokens {
  const payload = decodeJwtPayload(raw.access_token);
  const userData = (payload['user_data'] ?? {}) as { email?: string; displayName?: string };
  return {
    tokenFormat: TOKEN_FORMAT,
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? '',
    expiresAt: Date.now() + (raw.expires_in ?? 3600) * 1000,
    userId: (payload['user_profile_id'] as string) ?? (payload['sub'] as string) ?? '',
    email: userData.email ?? '',
    displayName: userData.displayName,
    serverUrl,
    clientId,
  };
}

// ---------------------------------------------------------------------------
// Auth-change notification
// ---------------------------------------------------------------------------

export function onAuthChange(
  cb: (status: { isLoggedIn: boolean; email: string | null; userId: string | null; reason: AuthChangeReason }) => void,
): void {
  authChangeCallback = cb;
}

function emitAuthChange(reason: AuthChangeReason): void {
  if (!authChangeCallback) return;
  authChangeCallback({
    isLoggedIn: cachedTokens !== null && cachedTokens.expiresAt > Date.now(),
    email: cachedTokens?.email ?? null,
    userId: cachedTokens?.userId ?? null,
    reason,
  });
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!cachedTokens?.expiresAt) return;

  const timeUntilExpiry = cachedTokens.expiresAt - Date.now();
  const buffer = Math.min(5 * 60 * 1000, timeUntilExpiry * 0.2);
  const delay = Math.max(30 * 1000, timeUntilExpiry - buffer);

  if (timeUntilExpiry <= 0) {
    void doProactiveRefresh();
  } else {
    refreshTimer = setTimeout(() => void doProactiveRefresh(), delay);
  }
}

async function doProactiveRefresh(): Promise<void> {
  const tokens = await getValidTokens();
  if (!tokens) {
    cachedTokens = null;
    emitAuthChange('refresh-failed');
  }
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------

/**
 * Start the PKCE login. Registers the client, stashes PKCE + state in memory,
 * and returns the AS authorize URL for the caller to open in the browser.
 * Login completes when handleAuthCallback() runs from the deep-link handler.
 */
export async function startLogin(): Promise<string> {
  const serverUrl = getConfiguredServerUrl();
  const clientId = await registerClient(serverUrl);
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  pendingPkce = { codeVerifier: verifier, state, clientId, serverUrl, expiresAt: Date.now() + PKCE_TTL_MS };

  return buildAuthorizeUrl({ serverUrl, clientId, challenge, state });
}

/**
 * Handle the deep-link callback (coredoc://auth/callback?code=…&state=…).
 * Validates state, exchanges the code at /token, and stores the AS tokens.
 */
export async function handleAuthCallback(url: string): Promise<{ email: string; userId: string }> {
  const parsed = new URL(url);
  const code = parsed.searchParams.get('code');
  const returnedState = parsed.searchParams.get('state');

  if (!code) {
    throw new Error('Missing authorization code in callback URL');
  }
  if (!pendingPkce || Date.now() > pendingPkce.expiresAt) {
    pendingPkce = null;
    throw new Error('PKCE session expired or not found. Please try logging in again.');
  }
  // CSRF: the returned state must match the value we generated.
  if (!returnedState || returnedState !== pendingPkce.state) {
    pendingPkce = null;
    throw new Error('OAuth state mismatch');
  }

  const { codeVerifier, clientId, serverUrl } = pendingPkce;
  pendingPkce = null;

  const raw = await postToken(serverUrl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
  });

  const tokens = tokensFromResponse(raw, serverUrl, clientId);
  await storeTokens(tokens);
  cachedTokens = tokens;
  scheduleRefresh();
  emitAuthChange('callback');

  return { email: tokens.email, userId: tokens.userId };
}

export async function logout(): Promise<void> {
  cachedTokens = null;
  e2eSeedInvalidated = true;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  pendingPkce = null;
  // The runtime server-url override was pinned from this session's tokens; a
  // re-login must start from env/bundled default, not the old server.
  resetServerUrl();
  emitAuthChange('logout');

  try {
    await unlink(CREDENTIALS_FILE);
  } catch {
    /* file may not exist */
  }
}

/**
 * Load the harness-seeded session. No fallback: with
 * COREDOC_DESKTOP_E2E_AUTH_FILE set, an unreadable or malformed file means the
 * test intended a logged-in run and would otherwise silently assert against a
 * logged-out app.
 */
async function readE2ESeedTokens(file: string): Promise<AuthTokens> {
  let parsed: Partial<AuthTokens>;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8')) as Partial<AuthTokens>;
  } catch (err) {
    throw new Error(`COREDOC_DESKTOP_E2E_AUTH_FILE could not be read: ${file} (${(err as Error).message})`);
  }
  if (parsed.tokenFormat !== TOKEN_FORMAT || !parsed.accessToken || !parsed.serverUrl || !parsed.expiresAt) {
    throw new Error(
      `COREDOC_DESKTOP_E2E_AUTH_FILE is not a ${TOKEN_FORMAT} credentials object ` +
        `(needs tokenFormat/accessToken/serverUrl/expiresAt): ${file}`,
    );
  }
  return parsed as AuthTokens;
}

/**
 * Are these stored credentials usable against the server the app now resolves?
 *
 * The comparison is uniform across every source in the URL chain (managed, env,
 * persisted user choice, bundled, default): the configured server always
 * decides, and stored credentials never move the app off it. Restoring a
 * session installs `tokens.serverUrl` as the runtime override, which outranks
 * env / user / bundled — so accepting a mismatched token for those sources
 * would silently re-point the install at the token's issuer. Comparing through
 * the shared normalizer keeps `https://host/` and `https://host` one origin;
 * an unparseable value on either side is a mismatch.
 *
 * A mismatch means this install now points somewhere else (server A's bearer
 * must never reach server B), so every reader of stored credentials — the auth
 * status the UI renders, `server-api`'s Authorization header, telemetry-token
 * minting, chat, cloud docs — sees "logged out" and offers a fresh login. The
 * credentials file is deliberately left on disk: the configuration may be
 * rolled back, and deleting it would silently destroy a still-valid session.
 *
 * Checked on load rather than on the in-memory cache: anything already cached
 * either passed this check or came from a login that resolved through the same
 * chain.
 */
function issuedByResolvedServer(tokens: AuthTokens): boolean {
  const issuer = normalizeServerUrl(tokens.serverUrl ?? '');
  return issuer !== null && issuer === normalizeServerUrl(resolveServerConfig().url);
}

export async function getStoredTokens(): Promise<AuthTokens | null> {
  if (cachedTokens) return cachedTokens;

  const seedFile = e2eSeedInvalidated ? null : resolveE2EAuthFile(process.env, isExistingFile);
  if (seedFile) {
    assertE2EBoundaryApplied();
    const seeded = await readE2ESeedTokens(seedFile);
    if (!issuedByResolvedServer(seeded)) return null;
    cachedTokens = seeded;
    scheduleRefresh();
    return cachedTokens;
  }

  try {
    const raw = await readFile(CREDENTIALS_FILE);
    let json: string;
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(raw);
    } else {
      json = raw.toString('utf-8');
    }
    const parsed = JSON.parse(json) as Partial<AuthTokens>;
    // Discard legacy (pre-migration WorkOS) credentials lacking the marker —
    // they carry RS256 tokens the migrated server rejects. Forces a clean
    // re-login into the AS flow.
    if (parsed.tokenFormat !== TOKEN_FORMAT) {
      return null;
    }
    if (!issuedByResolvedServer(parsed as AuthTokens)) {
      return null;
    }
    cachedTokens = parsed as AuthTokens;
    scheduleRefresh();
    return cachedTokens;
  } catch {
    return null;
  }
}

export function isLoggedIn(): boolean {
  return cachedTokens !== null && cachedTokens.expiresAt > Date.now();
}

/**
 * Get valid tokens, refreshing via the AS /token endpoint if near expiry.
 * Returns null if not logged in or refresh fails.
 */
export async function getValidTokens(): Promise<AuthTokens | null> {
  const tokens = await getStoredTokens();
  if (!tokens) return null;

  if (tokens.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokens;
  }
  if (!tokens.refreshToken) return null;

  // Single-flight refresh (refresh-token rotation: only the first caller refreshes).
  if (refreshPromise) {
    return refreshPromise;
  }
  refreshPromise = doRefresh(tokens);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(tokens: AuthTokens): Promise<AuthTokens | null> {
  try {
    const raw = await postToken(tokens.serverUrl, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
    const next = tokensFromResponse(raw, tokens.serverUrl, tokens.clientId);
    // A refresh response's access token may omit user_data / refresh_token —
    // preserve the known identity + rotate refresh token only when present.
    const merged: AuthTokens = {
      ...next,
      userId: next.userId || tokens.userId,
      email: next.email || tokens.email,
      displayName: next.displayName ?? tokens.displayName,
      refreshToken: next.refreshToken || tokens.refreshToken,
    };
    await storeTokens(merged);
    cachedTokens = merged;
    scheduleRefresh();
    emitAuthChange('refresh');
    return merged;
  } catch {
    return null;
  }
}

async function storeTokens(tokens: AuthTokens): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  const json = JSON.stringify(tokens);
  // E2E writes plaintext on purpose: the flag is development-only (packaged
  // builds reject it), userData is a throwaway temp dir, and the tokens are
  // fixture values for a loopback stub server — while safeStorage would bind
  // them to the developer's login Keychain for no test value.
  if (isE2EMode(process.env)) {
    assertE2EBoundaryApplied();
    await writeFile(CREDENTIALS_FILE, json, 'utf-8');
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(json);
    await writeFile(CREDENTIALS_FILE, encrypted);
  } else {
    await writeFile(CREDENTIALS_FILE, json, 'utf-8');
  }
}
