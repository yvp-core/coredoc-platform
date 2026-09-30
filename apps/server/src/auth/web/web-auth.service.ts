/**
 * Server-driven PKCE login against our self-hosted OAuth 2.1 AS
 * (@rekog/mcp-nest McpAuthModule — see auth/oauth/oauth.module.ts). The
 * browser never talks to /authorize or /token directly: this service
 * generates the PKCE pair, stashes it in a short-lived signed cookie, and
 * exchanges the returned code for tokens via a loopback call to our own
 * /token endpoint, then hands the browser first-party session cookies.
 *
 * The SDK's own /callback sets an `auth_token` cookie (type: 'user') as a
 * side effect of the upstream IdP round-trip — that is NOT our session and
 * is never read here. Our session cookie carries the `type: 'access'` token
 * that AuthService.verifyAccessToken validates.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaService } from '../../database/prisma.service.js';
import { isInvitationLive } from '../oauth/invitation-eligibility.js';
import { cookieSecure, resolveWebOrigin, webOrigins } from '../oauth/server-url.js';
import { authConfigFromEnv, miscConfigFromEnv } from '../../config/app-config.js';
import {
  INVITATION_HANDOFF_COOKIE,
  PKCE_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  WEB_CLIENT_ID,
} from './web-auth.constants.js';

const PKCE_COOKIE_TTL_SECONDS = 600; // 10 min
const PKCE_COOKIE_PATH = '/api/v1/auth/web';
const INVITATION_HANDOFF_TTL_SECONDS = 600;
const SESSION_COOKIE_PATH = '/api/v1';
const REFRESH_COOKIE_PATH = '/api/v1/auth/web/refresh';
const CALLBACK_PATH = '/api/v1/auth/web/callback';
const WORKOS_REQUEST_TIMEOUT_MS = 10_000;
const WORKOS_API_BASE_URL = 'https://api.workos.com';

interface PkceState {
  verifier: string;
  challenge: string;
  state: string;
}

interface PkcePayload {
  verifier: string;
  state: string;
  returnTo: string;
  /**
   * The exact redirect_uri sent to /authorize. Carried in the cookie rather
   * than recomputed at the callback: with more than one allowed web origin
   * (see webOrigins) the two could disagree, and the authorization code grant
   * is only valid for the uri the authorization request was made with.
   */
  redirectUri: string;
}

export interface AcceptedWorkOSInvitation {
  workosUserId: string;
  email: string;
  organizationId: string;
  workspaceId: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Thrown when the loopback /token exchange returns a non-200 response. */
export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

export class WorkOSInvitationExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkOSInvitationExchangeError';
  }
}

@Injectable()
export class WebAuthService {
  private readonly logger = new Logger(WebAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // PKCE
  // ===========================================================================

  /** code_verifier (43-128 chars, unreserved charset) + S256 code_challenge + random state. */
  generatePkce(): PkceState {
    // 96 random bytes -> 128-char base64url string (the RFC 7636 max length).
    const verifier = randomBytes(96).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    return { verifier, challenge, state };
  }

  private jwtSecretKey(): Uint8Array {
    const secret = authConfigFromEnv().jwtSecret;
    return new TextEncoder().encode(secret);
  }

  async packPkceCookie(payload: PkcePayload): Promise<string> {
    return new SignJWT({
      verifier: payload.verifier,
      state: payload.state,
      returnTo: payload.returnTo,
      redirectUri: payload.redirectUri,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('10m')
      .sign(this.jwtSecretKey());
  }

  /** Verify + decode the coredoc_pkce JWS. Throws on missing/expired/tampered/malformed input. */
  async unpackPkceCookie(jws: string): Promise<PkcePayload> {
    const { payload } = await jwtVerify(jws, this.jwtSecretKey(), { algorithms: ['HS256'] });
    const { verifier, state, returnTo, redirectUri } = payload;
    if (
      typeof verifier !== 'string' ||
      typeof state !== 'string' ||
      typeof returnTo !== 'string' ||
      typeof redirectUri !== 'string'
    ) {
      throw new Error('Malformed PKCE cookie payload');
    }
    return { verifier, state, returnTo, redirectUri };
  }

  /**
   * Same-origin relative paths only: must start with `/`, must not start with
   * `//` (protocol-relative), carry a scheme (`javascript:`, `https:`...), or
   * contain a backslash — browsers normalize `\` to `/` in the Location
   * header, so `/\evil.com` would navigate as protocol-relative `//evil.com`.
   * Also capped at 2000 chars — an oversize value would inflate the PKCE JWS
   * past the 4KB cookie cap and fail confusingly later. Falls back to `/` on
   * any violation (or an absent/empty value).
   */
  validateReturnTo(returnTo: string | undefined): string {
    if (
      !returnTo ||
      !returnTo.startsWith('/') ||
      returnTo.startsWith('//') ||
      returnTo.includes(':') ||
      returnTo.includes('\\') ||
      returnTo.length > 2000
    ) {
      return '/';
    }
    return returnTo;
  }

  // ===========================================================================
  // Loopback token exchange
  // ===========================================================================

  private loopbackTokenUrl(): string {
    const port = miscConfigFromEnv().port ?? 3000;
    // `localhost`, not a hardcoded IPv4 `127.0.0.1`: Node's default
    // `app.listen(port)` binds IPv6 (`::`, V6ONLY on macOS), so an IPv4 literal
    // can miss our own server entirely — or, worse, silently hit an unrelated
    // process squatting on 127.0.0.1:PORT. `localhost` resolves to whichever
    // family the server actually listens on (Happy Eyeballs picks the live one).
    return `http://localhost:${port}/token`;
  }

  private async postToken(form: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(this.loopbackTokenUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
      access_token?: unknown;
      refresh_token?: unknown;
    };
    if (!response.ok) {
      // Surface only the AS's error code/message — never the request/response
      // bodies, which may carry tokens.
      throw new TokenExchangeError(body.message ?? body.error ?? `Token exchange failed (${response.status})`);
    }

    // A 200 with a missing/empty access_token (or a present-but-empty
    // refresh_token) would otherwise set a cookie to "undefined" — treat it
    // the same as a failed exchange rather than handing out a broken session.
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new TokenExchangeError('Token exchange returned no access_token');
    }
    if ('refresh_token' in body && (typeof body.refresh_token !== 'string' || body.refresh_token.length === 0)) {
      throw new TokenExchangeError('Token exchange returned an empty refresh_token');
    }

    return body as unknown as TokenResponse;
  }

  /**
   * The callback uri for one web origin. Defaults to the canonical origin so
   * callers without a request in hand (tests, tooling) keep the old behaviour;
   * the login route passes the origin the browser actually reached us on.
   */
  redirectUri(origin: string = resolveWebOrigin(undefined)): string {
    return `${origin}${CALLBACK_PATH}`;
  }

  /** The allowlisted web origin that served this request — see resolveWebOrigin. */
  webOrigin(hostHeader: string | undefined): string {
    return resolveWebOrigin(hostHeader);
  }

  async exchangeCode(opts: { code: string; verifier: string; redirectUri: string }): Promise<TokenResponse> {
    return this.postToken({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: WEB_CLIENT_ID,
      code_verifier: opts.verifier,
    });
  }

  /**
   * WorkOS-hosted invitation acceptance starts outside Coredoc, so its final
   * authorization code has no local oauth_session/state cookie and cannot be
   * sent to the SDK-owned /callback. Exchange that one-time code at a
   * dedicated redirect URI, then let the controller begin the normal Coredoc
   * PKCE login. The resulting login is what creates our first-party session
   * and reconciles the pending local workspace membership.
   */
  async completeWorkosInvitation(code: string): Promise<AcceptedWorkOSInvitation> {
    const auth = authConfigFromEnv();
    if (auth.upstream !== 'workos') {
      throw new WorkOSInvitationExchangeError('WorkOS invitation completion is not enabled');
    }

    const authkitClientId = auth.workos.authkitClientId?.trim();
    const apiKey = auth.workos.apiKey?.trim();
    if (!authkitClientId || !apiKey) {
      throw new WorkOSInvitationExchangeError('WorkOS invitation completion is not configured');
    }

    let response: globalThis.Response;
    try {
      response = await fetch(`${WORKOS_API_BASE_URL}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: authkitClientId,
          client_secret: apiKey,
          grant_type: 'authorization_code',
          code,
        }),
        signal: AbortSignal.timeout(WORKOS_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WorkOSInvitationExchangeError(
        `WorkOS invitation token exchange failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new WorkOSInvitationExchangeError(`WorkOS invitation token exchange failed (${response.status})`);
    }

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      organization_id?: unknown;
      user?: { id?: unknown; email?: unknown; email_verified?: unknown };
    };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new WorkOSInvitationExchangeError('WorkOS invitation token exchange returned no access_token');
    }
    if (
      typeof body.organization_id !== 'string' ||
      typeof body.user?.id !== 'string' ||
      typeof body.user.email !== 'string' ||
      body.user.email_verified !== true
    ) {
      throw new WorkOSInvitationExchangeError('WorkOS invitation token exchange returned no verified identity');
    }

    const email = body.user.email.toLowerCase();
    const workspace = await this.prisma.workspace.findUnique({
      where: { workosOrganizationId: body.organization_id },
      select: { id: true },
    });
    if (!workspace) {
      throw new WorkOSInvitationExchangeError('The accepted WorkOS organization is not linked to Coredoc');
    }
    const invitation = await this.prisma.workspaceInvitation.findFirst({
      where: {
        workspaceId: workspace.id,
        workosInvitationId: { not: null },
        member: { pending: true, email },
      },
      select: { workspaceId: true, expiresAt: true, lastSentAt: true, createdAt: true },
    });
    if (!invitation || !isInvitationLive(invitation, new Date())) {
      throw new WorkOSInvitationExchangeError(
        'The accepted WorkOS identity does not match a live Coredoc workspace invitation',
      );
    }

    return {
      workosUserId: body.user.id,
      email,
      organizationId: body.organization_id,
      workspaceId: workspace.id,
    };
  }

  async packInvitationHandoff(payload: AcceptedWorkOSInvitation): Promise<string> {
    return new SignJWT({ ...payload, type: 'workos_invitation_handoff' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(`${INVITATION_HANDOFF_TTL_SECONDS}s`)
      .sign(this.jwtSecretKey());
  }

  private async unpackInvitationHandoff(jws: string): Promise<AcceptedWorkOSInvitation> {
    const { payload } = await jwtVerify(jws, this.jwtSecretKey(), { algorithms: ['HS256'] });
    if (
      payload.type !== 'workos_invitation_handoff' ||
      typeof payload.workosUserId !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.organizationId !== 'string' ||
      typeof payload.workspaceId !== 'string'
    ) {
      throw new Error('Malformed invitation handoff');
    }
    return {
      workosUserId: payload.workosUserId,
      email: payload.email,
      organizationId: payload.organizationId,
      workspaceId: payload.workspaceId,
    };
  }

  /** Verify that the ordinary OAuth login completed as the identity that accepted the WorkOS invitation. */
  async verifyInvitationLogin(handoffJws: string, accessToken: string): Promise<void> {
    const handoff = await this.unpackInvitationHandoff(handoffJws);
    const { payload } = await jwtVerify(accessToken, this.jwtSecretKey(), { algorithms: ['HS256'] });
    if (payload.type !== 'access') throw new Error('Invitation login returned a non-access token');
    const profileId = (payload.user_profile_id as string | undefined) ?? payload.sub;
    if (!profileId) throw new Error('Invitation login returned no local profile');

    const profile = await this.prisma.oAuthUserProfile.findUnique({
      where: { profile_id: profileId },
      select: { provider: true, provider_user_id: true, email: true },
    });
    if (
      profile?.provider !== 'workos' ||
      profile.provider_user_id !== handoff.workosUserId ||
      profile.email?.toLowerCase() !== handoff.email
    ) {
      throw new Error('Invitation login completed as a different WorkOS identity');
    }

    const membership = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: handoff.workspaceId, userId: profileId } },
      select: { pending: true },
    });
    if (!membership || membership.pending) {
      throw new Error('Invitation login did not activate the expected workspace membership');
    }
  }

  /**
   * The SDK's refresh tokens are stateless HS256 JWTs with no jti/store
   * tracking: a rotated-away refresh token stays valid against this exchange
   * until its own exp. There is no server-side revocation list.
   */
  async exchangeRefreshToken(refreshToken: string): Promise<TokenResponse> {
    return this.postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: WEB_CLIENT_ID,
    });
  }

  // ===========================================================================
  // Cookies
  // ===========================================================================

  private accessTokenMaxAgeMs(): number {
    return parseDurationToMs(authConfigFromEnv().accessTtl);
  }

  private refreshTokenMaxAgeMs(): number {
    return parseDurationToMs(authConfigFromEnv().refreshTtl);
  }

  setPkceCookie(res: Response, jws: string): void {
    res.cookie(PKCE_COOKIE, jws, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(),
      path: PKCE_COOKIE_PATH,
      maxAge: PKCE_COOKIE_TTL_SECONDS * 1000,
    });
  }

  setInvitationHandoffCookie(res: Response, jws: string): void {
    res.cookie(INVITATION_HANDOFF_COOKIE, jws, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(),
      path: PKCE_COOKIE_PATH,
      maxAge: INVITATION_HANDOFF_TTL_SECONDS * 1000,
    });
  }

  clearInvitationHandoffCookie(res: Response): void {
    res.clearCookie(INVITATION_HANDOFF_COOKIE, { path: PKCE_COOKIE_PATH });
  }

  clearPkceCookie(res: Response): void {
    res.clearCookie(PKCE_COOKIE, { path: PKCE_COOKIE_PATH });
  }

  setSessionCookies(res: Response, tokens: TokenResponse): void {
    res.cookie(SESSION_COOKIE, tokens.access_token, {
      httpOnly: true,
      // OAuth and WorkOS invitation completion return through a cross-site
      // top-level redirect. Strict cookies can be stored by the callback yet
      // withheld from its immediate redirect target, which makes the guarded
      // success page see no session. Lax permits that safe top-level GET while
      // AuthGuard still requires the CSRF header on every mutating cookie-auth
      // request; the narrowly-scoped refresh cookie remains Strict below.
      sameSite: 'lax',
      secure: cookieSecure(),
      path: SESSION_COOKIE_PATH,
      maxAge: this.accessTokenMaxAgeMs(),
    });
    if (tokens.refresh_token) {
      res.cookie(REFRESH_COOKIE, tokens.refresh_token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: cookieSecure(),
        path: REFRESH_COOKIE_PATH,
        maxAge: this.refreshTokenMaxAgeMs(),
      });
    }
  }

  clearSessionCookies(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  // ===========================================================================
  // First-party client seeding
  // ===========================================================================

  /**
   * Idempotently upsert the `coredoc-web` public client on every boot, so a
   * changed SERVER_URL / WEB_ORIGINS self-heals the registered redirect_uris
   * instead of leaving a stale set that fails `validateRedirectUri` in the
   * SDK's /authorize handler (an exact-match membership test against this
   * array). This overwrite is also why hand-editing oauth_clients does not
   * survive a restart — add the origin to WEB_ORIGINS instead.
   */
  async seedClient(): Promise<void> {
    const redirectUris = webOrigins().map((origin) => this.redirectUri(origin));
    const data = {
      client_id: WEB_CLIENT_ID,
      client_name: 'Coredoc Web',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    await this.prisma.oAuthClient.upsert({
      where: { client_id: WEB_CLIENT_ID },
      create: data,
      update: data,
    });
    this.logger.log(`Seeded OAuth client ${WEB_CLIENT_ID} (redirect_uris=${redirectUris.join(', ')})`);
  }
}

/** Mirrors the SDK's own '<n><unit>' duration format (JwtTokenService), but returns ms for Express cookies. */
function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}`);
  }
  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * unitMs;
}
