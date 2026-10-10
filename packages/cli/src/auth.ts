/**
 * CLI Auth Module - login, logout, whoami, credential storage
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { resolveCoredocHome } from '@coredoc/core/utils';

// Resolved lazily so a COREDOC_HOME override set after module load still applies.
const coredocDir = (): string => resolveCoredocHome();
const credentialsFile = (): string => join(coredocDir(), 'credentials.json');
const CALLBACK_PORT = 17433;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
  serverUrl: string;
}

type CredentialsDocument = Record<string, unknown>;

const AUTH_FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'userId', 'email', 'serverUrl'] as const;

function isCredentialsDocument(value: unknown): value is CredentialsDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStoredCredentials(value: CredentialsDocument | null): StoredCredentials | null {
  if (
    value === null ||
    typeof value.accessToken !== 'string' ||
    typeof value.expiresAt !== 'number' ||
    typeof value.serverUrl !== 'string'
  ) {
    return null;
  }
  return {
    accessToken: value.accessToken,
    refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : '',
    expiresAt: value.expiresAt,
    userId: typeof value.userId === 'string' ? value.userId : '',
    email: typeof value.email === 'string' ? value.email : '',
    serverUrl: value.serverUrl,
  };
}

async function readCredentialsDocument(): Promise<CredentialsDocument | null> {
  try {
    let raw = await readFile(credentialsFile(), 'utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const parsed: unknown = JSON.parse(raw);
    return isCredentialsDocument(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCredentialsDocument(document: CredentialsDocument): Promise<void> {
  const dir = coredocDir();
  const file = join(dir, 'credentials.json');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.credentials.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

/** Update login fields without clobbering workspace-scoped credentials such as OTel tokens. */
export async function storeCredentials(creds: StoredCredentials): Promise<void> {
  const existing = await readCredentialsDocument();
  await writeCredentialsDocument({ ...(existing ?? {}), ...creds });
}

export async function getToken(): Promise<string | null> {
  // Check env var first
  const envToken = process.env.COREDOC_TOKEN;
  if (envToken) return envToken;

  const creds = await getCredentials();
  if (!creds) return null;
  if (creds.expiresAt < Date.now()) {
    console.error('Token expired. Please run: coredoc login');
    return null;
  }
  return creds.accessToken;
}

/** Bearer auth header for the current token; throws when not logged in. */
export async function authHeaders(): Promise<{ Authorization: string }> {
  const token = await getToken();
  if (!token) throw new Error('Not authenticated. Run: coredoc login (or set COREDOC_TOKEN)');
  return { Authorization: `Bearer ${token}` };
}

export async function getCredentials(): Promise<StoredCredentials | null> {
  const document = await readCredentialsDocument();
  return toStoredCredentials(document);
}

export async function getServerUrl(): Promise<string> {
  // Env var takes precedence (CI/service-token contexts set this explicitly)
  if (process.env.COREDOC_SERVER_URL) return process.env.COREDOC_SERVER_URL;
  const creds = await getCredentials();
  return creds?.serverUrl ?? 'http://localhost:3000';
}

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

/**
 * Register this CLI as a public OAuth client via dynamic client registration
 * (RFC 7591). The server derives a deterministic client_id from the metadata,
 * so repeated registration is idempotent.
 */
async function registerClient(serverUrl: string): Promise<string> {
  const res = await fetch(`${serverUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'coredoc-cli',
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

export async function login(serverUrl: string): Promise<void> {
  console.log(`Opening browser for login at ${serverUrl}...`);

  // Public-client Authorization Code flow with PKCE against the self-hosted
  // OAuth server (GitHub upstream). Replaces the old WorkOS code exchange.
  const clientId = await registerClient(serverUrl);
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(400);
        res.end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }
      // CSRF protection: the state parameter must be present and match the
      // value we generated. Validate unconditionally — a missing state is a
      // rejection, not a bypass.
      if (!returnedState || returnedState !== state) {
        res.writeHead(400);
        res.end('State mismatch');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }

      try {
        const response = await fetch(`${serverUrl}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
          }).toString(),
        });

        if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);

        const tok = (await response.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
        };
        const payload = decodeJwtPayload(tok.access_token);
        const userData = payload['user_data'] as { email?: string } | undefined;
        const creds: StoredCredentials = {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token ?? '',
          expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
          userId: (payload['user_profile_id'] as string) ?? (payload['sub'] as string) ?? '',
          email: userData?.email ?? '',
          serverUrl,
        };

        await storeCredentials(creds);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Login successful!</h1><p>You can close this tab.</p></body></html>');

        console.log(`Logged in as ${creds.email || creds.userId}`);
        server.close();
        resolve();
      } catch (err) {
        res.writeHead(500);
        res.end('Login failed');
        server.close();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      const authUrl =
        `${serverUrl}/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          scope: 'offline_access',
        }).toString();

      // Try to open browser
      import('node:child_process').then(({ spawn }) => {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(cmd, [authUrl], { stdio: 'ignore', detached: true }).unref();
      });

      console.log(`\nIf browser doesn't open, visit:\n${authUrl}\n`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Login timeout'));
    }, 120_000);
  });
}

export async function logout(): Promise<void> {
  const existing = await readCredentialsDocument();
  if (existing) {
    const remaining = { ...existing };
    for (const field of AUTH_FIELDS) delete remaining[field];

    if (Object.keys(remaining).length > 0) {
      await writeCredentialsDocument(remaining);
      console.log('Logged out successfully.');
      return;
    }
  }

  try {
    await unlink(credentialsFile());
    console.log('Logged out successfully.');
  } catch {
    console.log('Already logged out.');
  }
}

export async function whoami(): Promise<void> {
  if (process.env.COREDOC_TOKEN) {
    console.log('Authenticated via COREDOC_TOKEN environment variable');
    return;
  }
  const creds = await getCredentials();
  if (!creds) {
    console.log('Not logged in. Run: coredoc login');
    return;
  }
  console.log(`Email: ${creds.email}`);
  console.log(`User ID: ${creds.userId}`);
  console.log(`Server: ${creds.serverUrl}`);
  console.log(`Expires: ${new Date(creds.expiresAt).toISOString()}`);
}
