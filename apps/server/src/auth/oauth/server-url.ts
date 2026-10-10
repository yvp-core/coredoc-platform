/**
 * Server URL derivation shared by the self-hosted OAuth AS (oauth.module.ts)
 * and the web session auth module (auth/web/*). Kept in one place so the
 * `/authorize`, `/token`, and `/api/v1/auth/web/callback` URLs — and the
 * cookie `Secure` flag derived from the same scheme — never drift apart.
 */

import { type AuthConfig, configFromEnv } from '../../config/app-config.js';

/**
 * MCP_SERVER_URL is preferred over SERVER_URL — a deliberate deviation from
 * the design doc — so this reuses the AS's own derivation and the seeded
 * client redirect_uri and /authorize can never disagree. Operational caveat:
 * if both are set and differ, the login flow follows MCP_SERVER_URL.
 */
export function serverUrl(auth: AuthConfig = configFromEnv().auth): string {
  return auth.mcpServerUrl ?? auth.serverUrl ?? 'http://localhost:3000';
}

/** Cookies are Secure only when actually served over HTTPS (see oauth.module.ts). */
export function cookieSecure(auth: AuthConfig = configFromEnv().auth): boolean {
  return serverUrl(auth).startsWith('https://');
}

/**
 * The OAuth resource identifier for the MCP transport — a single global
 * resource covering every workspace endpoint (per-workspace authorization is
 * enforced by membership checks, not by the audience).
 *
 * Two places must agree on this exact string: the AS mints access tokens with
 * it as `aud` (oauth.module.ts), and the protected-resource document
 * advertises it to clients (mcp-discovery.controller.ts).
 *
 * It MUST be the bare origin, never a path like `<base>/mcp`: the MCP SDK
 * (Claude Code as of 2026-08) validates RFC 9728 metadata by requiring the
 * advertised `resource` to equal the exact MCP endpoint URL **or its origin**.
 * Workspace endpoints live at `<base>/api/v1/workspaces/:id/mcp`, so only the
 * origin form satisfies every endpoint; `<base>/mcp` matches neither and the
 * client refuses to start the auth flow at all ("Protected resource ... does
 * not match expected"). Changing this value invalidates all previously minted
 * MCP tokens (audience mismatch) — every connected client re-authorizes once.
 */
export function mcpResourceIdentifier(auth: AuthConfig = configFromEnv().auth): string {
  return serverUrl(auth);
}

/**
 * Trailing-slash-trimmed base URL, validated as http(s). Throws rather than
 * skipping a bad entry: a typo in the operator's origin list must fail at
 * boot (seedClient calls this) instead of silently dropping a host and
 * surfacing later as an unexplainable "Invalid redirect_uri".
 */
function normalizeBase(raw: string, source: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${source} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${source} must be an http(s) URL: ${raw}`);
  }
  return trimmed;
}

/**
 * Every base URL the SPA and the web login may be served from: the canonical
 * serverUrl() first, then anything in WEB_ORIGINS (comma-separated).
 *
 * This exists so the UI can live on a second hostname without moving the
 * OAuth issuer / MCP resource identifier, which is pinned to serverUrl() and
 * cannot change without invalidating every MCP token already issued to
 * connected clients (see mcpResourceIdentifier). Only the *web login*
 * round-trip is made per-host: `/authorize` and the upstream IdP callback stay
 * on serverUrl(), because the SDK is configured with a single serverUrl at
 * module-definition time (auth/oauth/oauth.module.ts).
 */
export function webOrigins(auth: AuthConfig = configFromEnv().auth): string[] {
  const canonical = normalizeBase(serverUrl(auth), 'MCP_SERVER_URL/SERVER_URL');
  const extra = auth.webOrigins
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => normalizeBase(value, 'WEB_ORIGINS'));
  return [...new Set([canonical, ...extra])];
}

/**
 * Which allowlisted base URL served this request, matched on the Host header.
 *
 * Returns a configured origin string — never the header itself — so a spoofed
 * or unknown Host can only fall back to the canonical origin (today's
 * behaviour: the login finishes on serverUrl()), never redirect an
 * authorization code to an attacker-chosen host. X-Forwarded-Host is
 * deliberately ignored: Express `trust proxy` is off, and the ingress in front
 * of us preserves Host.
 */
export function resolveWebOrigin(hostHeader: string | undefined, auth: AuthConfig = configFromEnv().auth): string {
  const canonical = normalizeBase(serverUrl(auth), 'MCP_SERVER_URL/SERVER_URL');
  if (!hostHeader) return canonical;
  const host = hostHeader.trim().toLowerCase();
  return webOrigins(auth).find((origin) => new URL(origin).host.toLowerCase() === host) ?? canonical;
}
