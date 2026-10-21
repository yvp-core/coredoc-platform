/**
 * Several upstream IdPs on one deployment (`OAUTH_UPSTREAM=github,google`).
 *
 * The SDK binds exactly one provider and sends /authorize straight into its
 * passport strategy, so the chooser IS that one provider. Its strategy:
 *  - on a bare /authorize, renders a "Sign in with …" page whose links repeat
 *    the same /authorize request plus `idp=<name>`;
 *  - on /authorize?idp=<name>, remembers the pick in a short-lived cookie and
 *    hands the request to that IdP's own strategy;
 *  - on /callback (one URL shared by every IdP), routes by that cookie.
 *
 * The user keeps the real IdP's name as its `provider`, so a GitHub login
 * still maps to profile_id sha256('github:<id>') — enabling a second IdP does
 * not re-key existing members.
 */

import type { Request } from 'express';
import type { OAuthProviderConfig, OAuthUserProfile } from '@rekog/mcp-nest';
import type { UpstreamSelection } from './oauth-upstream.js';
import { chooserPage } from './chooser-page.js';

export const IDP_COOKIE = 'oauth_idp';

type StrategyContext = Parameters<OAuthProviderConfig['strategyOptions']>[0];
type Done = (err: unknown, user?: unknown) => void;
type Verify = (accessToken: string, refreshToken: string, profile: unknown, done: Done) => void;
type TaggedProfile = { idp: string; profile: unknown };
type Strategy = { authenticate(req: Request, options?: unknown): void };
/** What passport attaches to the per-request copy of a strategy. */
type PassportActions = Record<'success' | 'fail' | 'redirect' | 'pass' | 'error', (...args: unknown[]) => void>;

export function buildChooserProvider(upstreams: UpstreamSelection[], secureCookie: boolean): OAuthProviderConfig {
  const providers = new Map(upstreams.map((u) => [u.provider.name, u.provider]));

  class ChooserStrategy implements Strategy {
    readonly name = 'oauth-chooser';
    private readonly delegates = new Map<string, Strategy>();

    constructor(ctx: StrategyContext, verify: Verify) {
      for (const { provider, clientId, clientSecret } of upstreams) {
        const options = provider.strategyOptions({ ...ctx, clientId, clientSecret });
        const tagged: Verify = (accessToken, refreshToken, profile, done) =>
          verify(accessToken, refreshToken, { idp: provider.name, profile } satisfies TaggedProfile, (err, user) =>
            // The SDK stamps the chooser's name on the user; put the real IdP back.
            done(err, user && { ...(user as object), provider: provider.name }),
          );
        this.delegates.set(provider.name, new provider.strategy(options, tagged));
      }
    }

    authenticate(this: ChooserStrategy & PassportActions, req: Request, options?: unknown): void {
      // Only /authorize carries response_type (the SDK rejects it otherwise).
      const atAuthorize = req.query.response_type !== undefined;
      const idp: unknown = atAuthorize ? req.query.idp : req.cookies?.[IDP_COOKIE];
      const delegate = typeof idp === 'string' ? this.delegates.get(idp) : undefined;

      if (!delegate) {
        if (atAuthorize) {
          req.res
            ?.status(200)
            .type('html')
            .send(chooserPage(req, [...providers.values()]));
          return;
        }
        this.fail('Missing or unknown identity provider choice', 400);
        return;
      }

      if (atAuthorize) {
        req.res?.cookie(IDP_COOKIE, idp, {
          httpOnly: true,
          secure: secureCookie,
          sameSite: 'lax',
          maxAge: 10 * 60_000,
        });
      } else {
        req.res?.clearCookie(IDP_COOKIE);
      }
      // passport gives each request a fresh object carrying success/fail/…;
      // the delegate gets the same ones (closures — they don't use `this`).
      const { success, fail, redirect, pass, error } = this;
      Object.assign(Object.create(delegate), { success, fail, redirect, pass, error }).authenticate(req, options);
    }
  }

  return {
    name: 'chooser',
    strategy: ChooserStrategy,
    // Each delegate builds its own options from this context in the constructor.
    strategyOptions: (ctx) => ctx,
    profileMapper: ({ idp, profile }: TaggedProfile): OAuthUserProfile => {
      const provider = providers.get(idp);
      if (!provider) throw new Error(`Unknown identity provider "${idp}"`);
      return provider.profileMapper(profile);
    },
  };
}
