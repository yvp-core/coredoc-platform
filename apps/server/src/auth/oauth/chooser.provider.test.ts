import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import type { OAuthProviderConfig } from '@rekog/mcp-nest';
import { buildChooserProvider, IDP_COOKIE } from './chooser.provider.js';

/** Stand-in IdP strategy: redirects on /authorize, verifies on /callback. */
function fakeIdp(name: string): OAuthProviderConfig {
  class FakeStrategy {
    constructor(
      private readonly options: { clientId: string },
      private readonly verify: (
        at: string,
        rt: string,
        profile: unknown,
        done: (e: unknown, u?: unknown) => void,
      ) => void,
    ) {}
    authenticate(this: FakeStrategy & Record<string, (...a: unknown[]) => void>, req: Request): void {
      if (req.query.code) {
        this.verify('at', 'rt', { sub: `${name}-user` }, (err, user) => (err ? this.error(err) : this.success(user)));
      } else {
        this.redirect(`https://${name}.example/authorize?client_id=${this.options.clientId}`);
      }
    }
  }
  return {
    name,
    displayName: name.toUpperCase(),
    strategy: FakeStrategy,
    strategyOptions: ({ clientId }) => ({ clientId }),
    profileMapper: (p: { sub: string }) => ({ id: p.sub, username: p.sub }),
  };
}

const ctx = {
  serverUrl: 'https://coredoc.example',
  clientId: 'chooser',
  clientSecret: 'chooser',
  callbackPath: 'callback',
};

/** Builds the chooser the way the SDK does and runs one request through it, as passport would. */
function authenticateOnce(
  query: Record<string, string>,
  cookies: Record<string, string> = {},
  originalUrl = '/authorize',
) {
  const provider = buildChooserProvider(
    [
      { provider: fakeIdp('github'), clientId: 'gh_id', clientSecret: 'gh_secret' },
      { provider: fakeIdp('google'), clientId: 'g_id', clientSecret: 'g_secret' },
    ],
    true,
  );
  // Mirrors OAuthStrategyService: map the profile, stamp the provider's own name.
  const strategy = new provider.strategy(
    provider.strategyOptions(ctx),
    (at: string, _rt: string, profile: unknown, done: (e: unknown, u?: unknown) => void) =>
      done(null, { profile: provider.profileMapper(profile), accessToken: at, provider: provider.name }),
  );
  const res = { status: vi.fn(), type: vi.fn(), send: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  const actions = { success: vi.fn(), fail: vi.fn(), redirect: vi.fn(), pass: vi.fn(), error: vi.fn() };
  const req = { query, cookies, originalUrl, res } as unknown as Request;
  Object.assign(Object.create(strategy), actions).authenticate(req, {});
  return { res, ...actions };
}

describe('chooser provider', () => {
  const authorize = { response_type: 'code', client_id: 'c1', redirect_uri: 'http://127.0.0.1:9/cb', state: 's' };

  it('renders a sign-in page whose links repeat the authorize request with idp', () => {
    const { res, redirect } = authenticateOnce(
      authorize,
      {},
      '/authorize?response_type=code&client_id=c1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&state=s',
    );
    const html = res.send.mock.calls[0]?.[0] as string;
    expect(html).toContain(
      'href="?response_type=code&amp;client_id=c1&amp;redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&amp;state=s&amp;idp=google"',
    );
    expect(html).toContain('Sign in with GITHUB');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('hands /authorize?idp to that IdP with its own credentials and remembers the pick', () => {
    const { res, redirect } = authenticateOnce({ ...authorize, idp: 'google' });
    expect(redirect).toHaveBeenCalledWith('https://google.example/authorize?client_id=g_id');
    expect(res.cookie).toHaveBeenCalledWith(
      IDP_COOKIE,
      'google',
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
  });

  it('routes /callback by the cookie and keeps the real IdP as provider (profile_id stays per-IdP)', () => {
    const { success, res } = authenticateOnce({ code: 'abc', state: 's' }, { [IDP_COOKIE]: 'github' });
    expect(success).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'github', profile: expect.objectContaining({ id: 'github-user' }) }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(IDP_COOKIE);
  });

  it('fails a /callback without a known pick instead of guessing', () => {
    expect(authenticateOnce({ code: 'abc' }).fail).toHaveBeenCalled();
    expect(authenticateOnce({ code: 'abc' }, { [IDP_COOKIE]: 'okta' }).fail).toHaveBeenCalled();
  });

  it('shows the chooser again for an unknown idp on /authorize', () => {
    const { res, redirect } = authenticateOnce({ ...authorize, idp: 'okta' });
    expect(res.send).toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
