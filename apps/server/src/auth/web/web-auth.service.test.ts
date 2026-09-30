import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { SignJWT } from 'jose';
import { WebAuthService, TokenExchangeError } from './web-auth.service.js';
import {
  INVITATION_HANDOFF_COOKIE,
  PKCE_COOKIE,
  REFRESH_COOKIE,
  SESSION_COOKIE,
  WEB_CLIENT_ID,
} from './web-auth.constants.js';
import type { PrismaService } from '../../database/prisma.service.js';

const JWT_SECRET = 'a'.repeat(32);

function mockPrisma() {
  return {
    oAuthClient: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({ id: 'ws-1' }),
    },
    workspaceInvitation: {
      findFirst: vi.fn().mockResolvedValue({
        workspaceId: 'ws-1',
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
        lastSentAt: new Date('2026-08-05T00:00:00.000Z'),
        createdAt: new Date('2026-08-05T00:00:00.000Z'),
      }),
    },
    oAuthUserProfile: {
      findUnique: vi.fn().mockResolvedValue({
        provider: 'workos',
        provider_user_id: 'workos-user-1',
        email: 'person@example.com',
      }),
    },
    workspaceMember: {
      findUnique: vi.fn().mockResolvedValue({ pending: false }),
    },
  };
}

function mockRes() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };
}

describe('WebAuthService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: WebAuthService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.OAUTH_JWT_SECRET = JWT_SECRET;
    delete process.env.SERVER_URL;
    delete process.env.MCP_SERVER_URL;
    delete process.env.WEB_ORIGINS;
    delete process.env.PORT;
    delete process.env.OAUTH_UPSTREAM;
    delete process.env.WORKOS_AUTHKIT_DOMAIN;
    delete process.env.WORKOS_CLIENT_ID;
    delete process.env.WORKOS_CLIENT_SECRET;
    delete process.env.WORKOS_AUTHKIT_CLIENT_ID;
    delete process.env.WORKOS_API_KEY;
    prisma = mockPrisma();
    service = new WebAuthService(prisma as unknown as PrismaService);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('WorkOS invitation completion', () => {
    beforeEach(() => {
      process.env.OAUTH_UPSTREAM = 'workos';
      process.env.WORKOS_AUTHKIT_CLIENT_ID = 'client_authkit_123';
      process.env.WORKOS_API_KEY = 'sk_test';
      process.env.SERVER_URL = 'https://coredoc.example.com';
    });

    it('exchanges the out-of-band WorkOS code at the dedicated redirect URI', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'workos-at',
          token_type: 'bearer',
          organization_id: 'workos-org-1',
          user: { id: 'workos-user-1', email: 'Person@Example.com', email_verified: true },
        }),
      });

      await expect(service.completeWorkosInvitation('invite-code')).resolves.toEqual({
        workosUserId: 'workos-user-1',
        email: 'person@example.com',
        organizationId: 'workos-org-1',
        workspaceId: 'ws-1',
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.workos.com/user_management/authenticate');
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({
        client_id: 'client_authkit_123',
        client_secret: 'sk_test',
        grant_type: 'authorization_code',
        code: 'invite-code',
      });
    });

    it('rejects an accepted identity that has no exact live local invitation', async () => {
      prisma.workspaceInvitation.findFirst.mockResolvedValue(null);
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'workos-at',
          organization_id: 'workos-org-1',
          user: { id: 'workos-user-2', email: 'other@example.com', email_verified: true },
        }),
      });

      await expect(service.completeWorkosInvitation('invite-code')).rejects.toThrow(/does not match a live/);
      expect(prisma.workspaceInvitation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ member: { pending: true, email: 'other@example.com' } }),
        }),
      );
    });

    it('binds the follow-up local login to the WorkOS identity and activated workspace', async () => {
      const handoff = await service.packInvitationHandoff({
        workosUserId: 'workos-user-1',
        email: 'person@example.com',
        organizationId: 'workos-org-1',
        workspaceId: 'ws-1',
      });
      const accessToken = await new SignJWT({ type: 'access', user_profile_id: 'profile-1' })
        .setProtectedHeader({ alg: 'HS256' })
        .sign(new TextEncoder().encode(JWT_SECRET));

      await expect(service.verifyInvitationLogin(handoff, accessToken)).resolves.toBeUndefined();
      expect(prisma.workspaceMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'profile-1' } },
        }),
      );

      prisma.oAuthUserProfile.findUnique.mockResolvedValue({
        provider: 'workos',
        provider_user_id: 'different-user',
        email: 'person@example.com',
      });
      await expect(service.verifyInvitationLogin(handoff, accessToken)).rejects.toThrow(/different WorkOS identity/);
    });

    it('does not call WorkOS for a non-WorkOS deployment', async () => {
      process.env.OAUTH_UPSTREAM = 'github';

      await expect(service.completeWorkosInvitation('invite-code')).rejects.toThrow(/not enabled/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fails closed when WorkOS rejects the code or omits the access token', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
      await expect(service.completeWorkosInvitation('bad-code')).rejects.toThrow(/failed \(400\)/);

      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
      await expect(service.completeWorkosInvitation('empty-code')).rejects.toThrow(/no access_token/);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OAUTH_ACCESS_TTL;
    delete process.env.OAUTH_REFRESH_TTL;
  });

  // ===========================================================================
  // PKCE generation
  // ===========================================================================

  describe('PKCE generation', () => {
    it('generates a code_verifier of 43-128 chars from the unreserved charset', () => {
      const { verifier } = service.generatePkce();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    });

    it('derives code_challenge as BASE64URL(SHA256(verifier))', () => {
      const { verifier, challenge } = service.generatePkce();
      const expected = createHash('sha256').update(verifier).digest('base64url');
      expect(challenge).toBe(expected);
    });

    it('generates a random state on every call', () => {
      const a = service.generatePkce();
      const b = service.generatePkce();
      expect(a.state).not.toBe(b.state);
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  // ===========================================================================
  // returnTo validation
  // ===========================================================================

  describe('validateReturnTo', () => {
    it.each([
      ['/w/acme', '/w/acme'],
      ['//evil.com', '/'],
      ['https://evil.com', '/'],
      ['javascript:alert(1)', '/'],
      ['', '/'],
      [undefined, '/'],
      // Browsers normalize \ to / in the Location header, so /\evil.com
      // navigates as protocol-relative //evil.com — any backslash is rejected.
      ['/\\evil.com', '/'],
      ['/\\\\evil.com', '/'],
      ['/w/acme\\..', '/'],
    ])('%s -> %s', (input, expected) => {
      expect(service.validateReturnTo(input)).toBe(expected);
    });

    it('falls back to / when returnTo exceeds 2000 chars (would inflate the PKCE JWS past the 4KB cookie cap)', () => {
      const oversized = `/${'a'.repeat(2000)}`;
      expect(service.validateReturnTo(oversized)).toBe('/');
    });

    it('accepts a returnTo at exactly the 2000 char cap', () => {
      const atCap = `/${'a'.repeat(1999)}`;
      expect(atCap.length).toBe(2000);
      expect(service.validateReturnTo(atCap)).toBe(atCap);
    });
  });

  // ===========================================================================
  // PKCE cookie JWS round-trip
  // ===========================================================================

  describe('PKCE cookie JWS', () => {
    it('round-trips verifier/state/returnTo/redirectUri through pack + unpack', async () => {
      const packed = await service.packPkceCookie({
        verifier: 'v',
        state: 's',
        returnTo: '/w/acme',
        redirectUri: 'https://ai-dashboard.example.com/api/v1/auth/web/callback',
      });
      const unpacked = await service.unpackPkceCookie(packed);
      expect(unpacked).toEqual({
        verifier: 'v',
        state: 's',
        returnTo: '/w/acme',
        redirectUri: 'https://ai-dashboard.example.com/api/v1/auth/web/callback',
      });
    });

    it('rejects an expired JWS', async () => {
      vi.useFakeTimers();
      const packed = await service.packPkceCookie({
        verifier: 'v',
        state: 's',
        returnTo: '/',
        redirectUri: 'https://coredoc.example.com/api/v1/auth/web/callback',
      });
      vi.advanceTimersByTime(11 * 60 * 1000); // > 10 min exp
      await expect(service.unpackPkceCookie(packed)).rejects.toThrow();
      vi.useRealTimers();
    });

    it('rejects a tampered/absent JWS', async () => {
      await expect(service.unpackPkceCookie('not-a-jws')).rejects.toThrow();
    });
  });

  // ===========================================================================
  // Token exchange (authorization_code)
  // ===========================================================================

  describe('exchangeCode', () => {
    it('calls the loopback /token endpoint with exact form fields', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 86400 }),
      });

      await service.exchangeCode({
        code: 'c1',
        verifier: 'v1',
        redirectUri: 'http://localhost:3000/api/v1/auth/web/callback',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3000/token');
      expect(init.method).toBe('POST');
      expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('c1');
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/api/v1/auth/web/callback');
      expect(body.get('client_id')).toBe(WEB_CLIENT_ID);
      expect(body.get('code_verifier')).toBe('v1');
    });

    it('uses PORT for the loopback URL when set', async () => {
      process.env.PORT = '4100';
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ access_token: 'at' }) });

      await service.exchangeCode({
        code: 'c1',
        verifier: 'v1',
        redirectUri: 'http://localhost:4100/api/v1/auth/web/callback',
      });

      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:4100/token');
    });

    it('throws with the AS error code on a non-200 response, never echoing tokens', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ statusCode: 400, message: 'Invalid PKCE verification', error: 'Bad Request' }),
      });

      await expect(
        service.exchangeCode({
          code: 'bad',
          verifier: 'v',
          redirectUri: 'http://localhost:3000/api/v1/auth/web/callback',
        }),
      ).rejects.toMatchObject({ message: 'Invalid PKCE verification' });
    });

    it('throws on a 200 response with an empty body instead of setting a cookie to "undefined"', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

      const res = mockRes();
      await expect(
        service.exchangeCode({
          code: 'c1',
          verifier: 'v1',
          redirectUri: 'http://localhost:3000/api/v1/auth/web/callback',
        }),
      ).rejects.toThrow(TokenExchangeError);
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('throws on a 200 response with a present-but-empty refresh_token', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at', refresh_token: '' }),
      });

      await expect(
        service.exchangeCode({
          code: 'c1',
          verifier: 'v1',
          redirectUri: 'http://localhost:3000/api/v1/auth/web/callback',
        }),
      ).rejects.toThrow(TokenExchangeError);
    });
  });

  // ===========================================================================
  // Token exchange (refresh_token)
  // ===========================================================================

  describe('exchangeRefreshToken', () => {
    it('calls the loopback /token endpoint with grant_type=refresh_token', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at2', refresh_token: 'rt2', token_type: 'bearer', expires_in: 86400 }),
      });

      await service.exchangeRefreshToken('rt-old');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://localhost:3000/token');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('rt-old');
      expect(body.get('client_id')).toBe(WEB_CLIENT_ID);
    });

    it('throws on a non-200 response', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ statusCode: 400, message: 'Invalid or expired refresh token', error: 'Bad Request' }),
      });
      await expect(service.exchangeRefreshToken('bad')).rejects.toThrow();
    });

    it('throws on a 200 response with an empty body instead of setting a cookie to "undefined"', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
      await expect(service.exchangeRefreshToken('rt-old')).rejects.toThrow(TokenExchangeError);
    });
  });

  // ===========================================================================
  // Cookie attributes
  // ===========================================================================

  describe('cookie attributes', () => {
    it('sets the PKCE cookie with SameSite=Lax, Path=/api/v1/auth/web, 600s maxAge', () => {
      const res = mockRes();
      service.setPkceCookie(res as never, 'jws-value');

      expect(res.cookie).toHaveBeenCalledWith(
        PKCE_COOKIE,
        'jws-value',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/api/v1/auth/web',
          maxAge: 600 * 1000,
          secure: false,
        }),
      );
    });

    it('sets the identity handoff cookie only on the short-lived web auth path', () => {
      const res = mockRes();
      service.setInvitationHandoffCookie(res as never, 'handoff-jws');
      expect(res.cookie).toHaveBeenCalledWith(
        INVITATION_HANDOFF_COOKIE,
        'handoff-jws',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/api/v1/auth/web',
          maxAge: 10 * 60 * 1000,
        }),
      );
    });

    it('sets a redirect-compatible session cookie and a Strict refresh cookie', () => {
      const res = mockRes();
      service.setSessionCookies(res as never, { access_token: 'at', refresh_token: 'rt' });

      expect(res.cookie).toHaveBeenCalledWith(
        SESSION_COOKIE,
        'at',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/api/v1',
          maxAge: 24 * 60 * 60 * 1000, // default OAUTH_ACCESS_TTL=1d
          secure: false,
        }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        'rt',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/api/v1/auth/web/refresh',
          maxAge: 30 * 24 * 60 * 60 * 1000, // default OAUTH_REFRESH_TTL=30d
          secure: false,
        }),
      );
    });

    it('toggles Secure on when SERVER_URL is https', () => {
      process.env.SERVER_URL = 'https://coredoc.example.com';
      const res = mockRes();
      service.setSessionCookies(res as never, { access_token: 'at', refresh_token: 'rt' });
      expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE, 'at', expect.objectContaining({ secure: true }));
    });

    it('respects custom OAUTH_ACCESS_TTL / OAUTH_REFRESH_TTL for maxAge', () => {
      process.env.OAUTH_ACCESS_TTL = '2h';
      process.env.OAUTH_REFRESH_TTL = '7d';
      const res = mockRes();
      service.setSessionCookies(res as never, { access_token: 'at', refresh_token: 'rt' });
      expect(res.cookie).toHaveBeenCalledWith(
        SESSION_COOKIE,
        'at',
        expect.objectContaining({ maxAge: 2 * 60 * 60 * 1000 }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        'rt',
        expect.objectContaining({ maxAge: 7 * 24 * 60 * 60 * 1000 }),
      );
    });

    it('clearSessionCookies clears both session and refresh cookies at their own paths', () => {
      const res = mockRes();
      service.clearSessionCookies(res as never);
      expect(res.clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, expect.objectContaining({ path: '/api/v1' }));
      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE,
        expect.objectContaining({ path: '/api/v1/auth/web/refresh' }),
      );
    });

    it('clearPkceCookie clears the PKCE cookie at its own path', () => {
      const res = mockRes();
      service.clearPkceCookie(res as never);
      expect(res.clearCookie).toHaveBeenCalledWith(PKCE_COOKIE, expect.objectContaining({ path: '/api/v1/auth/web' }));
    });
  });

  // ===========================================================================
  // First-party client seeding
  // ===========================================================================

  describe('seedClient', () => {
    it('upserts coredoc-web as a public client with the current serverUrl-derived redirect URI', async () => {
      process.env.SERVER_URL = 'https://coredoc.example.com';
      await service.seedClient();

      expect(prisma.oAuthClient.upsert).toHaveBeenCalledTimes(1);
      const call = prisma.oAuthClient.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ client_id: WEB_CLIENT_ID });
      expect(call.create).toMatchObject({
        client_id: WEB_CLIENT_ID,
        client_name: expect.any(String),
        redirect_uris: ['https://coredoc.example.com/api/v1/auth/web/callback'],
        grant_types: expect.arrayContaining(['authorization_code', 'refresh_token']),
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      expect(call.update).toMatchObject(call.create);
    });

    it('registers a callback for every allowed web origin, canonical first', async () => {
      process.env.SERVER_URL = 'https://coredoc.example.com';
      process.env.WEB_ORIGINS = 'https://ai-dashboard.example.com';
      await service.seedClient();

      expect(prisma.oAuthClient.upsert.mock.calls[0][0].create.redirect_uris).toEqual([
        'https://coredoc.example.com/api/v1/auth/web/callback',
        'https://ai-dashboard.example.com/api/v1/auth/web/callback',
      ]);
    });

    it('is idempotent — safe to call on every boot (self-heals a changed SERVER_URL)', async () => {
      process.env.SERVER_URL = 'https://old.example.com';
      await service.seedClient();
      process.env.SERVER_URL = 'https://new.example.com';
      await service.seedClient();

      expect(prisma.oAuthClient.upsert).toHaveBeenCalledTimes(2);
      const secondCall = prisma.oAuthClient.upsert.mock.calls[1][0];
      expect(secondCall.create.redirect_uris).toEqual(['https://new.example.com/api/v1/auth/web/callback']);
    });
  });
});
