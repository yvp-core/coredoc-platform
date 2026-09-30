import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildWorkOSProvider } from './workos.provider.js';

const ENV_KEYS = ['WORKOS_AUTHKIT_DOMAIN', 'ALLOWED_EMAIL_DOMAINS'] as const;

describe('buildWorkOSProvider', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WORKOS_AUTHKIT_DOMAIN = 'https://acme.authkit.app';
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  const verifiedClaims = {
    sub: 'user_01ABC',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice Doe',
    given_name: 'Alice',
    family_name: 'Doe',
    picture: 'https://img.example.com/alice.png',
  };

  describe('startup validation (fail fast)', () => {
    it('throws when WORKOS_AUTHKIT_DOMAIN is missing', () => {
      delete process.env.WORKOS_AUTHKIT_DOMAIN;
      expect(() => buildWorkOSProvider()).toThrow(/WORKOS_AUTHKIT_DOMAIN is required/);
    });

    it('throws when WORKOS_AUTHKIT_DOMAIN is not https', () => {
      process.env.WORKOS_AUTHKIT_DOMAIN = 'http://acme.authkit.app';
      expect(() => buildWorkOSProvider()).toThrow(/must be an https:\/\/ URL/);
    });
  });

  describe('strategyOptions', () => {
    function options() {
      return buildWorkOSProvider().strategyOptions({
        serverUrl: 'https://mcp.example.com/',
        clientId: 'client_123',
        clientSecret: 'secret_456',
        callbackPath: '/callback',
      });
    }

    it('points at the AuthKit oauth2 endpoints with OIDC scopes', () => {
      const opts = options();
      expect(opts.authorizationURL).toBe('https://acme.authkit.app/oauth2/authorize');
      expect(opts.tokenURL).toBe('https://acme.authkit.app/oauth2/token');
      expect(opts.clientID).toBe('client_123');
      expect(opts.clientSecret).toBe('secret_456');
      expect(opts.callbackURL).toBe('https://mcp.example.com/callback');
      expect(opts.scope).toEqual(['openid', 'profile', 'email']);
    });

    it('strips a trailing slash from the AuthKit domain', () => {
      process.env.WORKOS_AUTHKIT_DOMAIN = 'https://acme.authkit.app/';
      expect(options().authorizationURL).toBe('https://acme.authkit.app/oauth2/authorize');
    });

    // The SDK controller passes its own state cookie as a plain string via
    // passport.authenticate options; passport-oauth2 forwards it verbatim only
    // when the automatic state store is off. PKCE toward the upstream is the
    // MCP client's job, not ours.
    it('does not enable the passport state store or PKCE', () => {
      const opts = options();
      expect(opts.state).toBeUndefined();
      expect(opts.store).toBeUndefined();
      expect(opts.pkce).toBeUndefined();
    });

    it('defaults callbackPath to /callback', () => {
      const opts = buildWorkOSProvider().strategyOptions({
        serverUrl: 'https://mcp.example.com',
        clientId: 'id',
        clientSecret: 'secret',
      });
      expect(opts.callbackURL).toBe('https://mcp.example.com/callback');
    });
  });

  describe('profileMapper login gate', () => {
    function runMapper(claims: Record<string, unknown>) {
      return buildWorkOSProvider().profileMapper(claims);
    }

    it('maps verified OIDC claims to the SDK profile shape', () => {
      const result = runMapper(verifiedClaims);
      expect(result).toEqual({
        id: 'user_01ABC',
        username: 'alice@example.com',
        email: 'alice@example.com',
        displayName: 'Alice Doe',
        avatarUrl: 'https://img.example.com/alice.png',
        raw: verifiedClaims,
      });
    });

    it('allows any verified email when ALLOWED_EMAIL_DOMAINS is unset (WorkOS tenant is the gate)', () => {
      const result = runMapper({ ...verifiedClaims, email: 'bob@anywhere.io' });
      expect(result.email).toBe('bob@anywhere.io');
    });

    // The security invariant: an unverified email must never reach
    // linkPendingMemberships' invite-linking.
    it('rejects when email_verified is not true', () => {
      expect(() => runMapper({ ...verifiedClaims, email_verified: false })).toThrow(/no verified email/);
      expect(() => runMapper({ ...verifiedClaims, email_verified: undefined })).toThrow(/no verified email/);
    });

    it('rejects when the email is missing even if email_verified is true', () => {
      expect(() => runMapper({ ...verifiedClaims, email: undefined })).toThrow(/no verified email/);
    });

    it('enforces ALLOWED_EMAIL_DOMAINS when set (case-insensitive)', () => {
      process.env.ALLOWED_EMAIL_DOMAINS = 'example.com';
      expect(runMapper({ ...verifiedClaims, email: 'Alice@Example.com' }).email).toBe('Alice@Example.com');
      expect(() => runMapper({ ...verifiedClaims, email: 'eve@gmail.com' })).toThrow(/not in an allowed email domain/);
    });

    it('falls back to given_name + family_name when name is absent', () => {
      const result = runMapper({ ...verifiedClaims, name: undefined });
      expect(result.displayName).toBe('Alice Doe');
    });

    it('rejects a userinfo response without sub', () => {
      expect(() => runMapper({ ...verifiedClaims, sub: undefined })).toThrow(/missing "sub"/);
    });
  });

  describe('strategy subclass', () => {
    function makeStrategy() {
      const provider = buildWorkOSProvider();
      const opts = provider.strategyOptions({
        serverUrl: 'https://mcp.example.com',
        clientId: 'id',
        clientSecret: 'secret',
        callbackPath: '/callback',
      });
      return new provider.strategy(opts, () => undefined);
    }

    it('injects a fresh nonce into the authorization params on every redirect', () => {
      const strategy = makeStrategy();
      const a = strategy.authorizationParams({}) as { nonce?: string };
      const b = strategy.authorizationParams({}) as { nonce?: string };
      expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(b.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(a.nonce).not.toBe(b.nonce);
    });

    it('fetches the profile from the AuthKit userinfo endpoint', async () => {
      const claims = { sub: 'user_01ABC', email: 'alice@example.com', email_verified: true };
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => claims });
      vi.stubGlobal('fetch', fetchMock);

      const strategy = makeStrategy();
      const profile = await new Promise((resolve, reject) => {
        strategy.userProfile('token_abc', (err: unknown, p?: unknown) => (err ? reject(err) : resolve(p)));
      });

      expect(profile).toEqual(claims);
      expect(fetchMock).toHaveBeenCalledWith('https://acme.authkit.app/oauth2/userinfo', {
        headers: { Authorization: 'Bearer token_abc' },
      });
    });

    it('fails closed when userinfo returns a non-2xx status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

      const strategy = makeStrategy();
      await expect(
        new Promise((resolve, reject) => {
          strategy.userProfile('bad_token', (err: unknown, p?: unknown) => (err ? reject(err) : resolve(p)));
        }),
      ).rejects.toThrow(/userinfo returned HTTP 401/);
    });

    it('fails closed on a network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

      const strategy = makeStrategy();
      await expect(
        new Promise((resolve, reject) => {
          strategy.userProfile('token', (err: unknown, p?: unknown) => (err ? reject(err) : resolve(p)));
        }),
      ).rejects.toThrow(/ECONNREFUSED/);
    });
  });
});
