/**
 * WorkOS AuthKit (OIDC) upstream provider for the self-hosted OAuth server.
 *
 * Uses "AuthKit as an OIDC provider" (WorkOS Connect): a standard OAuth 2.0
 * authorization-code flow against the AuthKit domain
 * (`https://<subdomain>.authkit.app` or a custom auth domain), with the user
 * profile fetched from the OIDC userinfo endpoint (`/oauth2/userinfo`).
 *
 * Why a `passport-oauth2` subclass instead of an off-the-shelf OIDC strategy:
 * the SDK's OAuthStrategyService registers a fixed arity-4 verify callback
 * `(accessToken, refreshToken, profile, done)`. passport-openidconnect
 * dispatches on verify arity with a DIFFERENT signature order (its arity-4
 * form is `(issuer, profile, context, done)`), so it cannot be plugged in.
 * passport-oauth2's arity-4 path matches exactly, and its `userProfile()`
 * hook is where the profile must come from: the token-response params (which
 * carry WorkOS's id_token) are only passed to arity-5/6 verify callbacks, so
 * the userinfo endpoint is the one clean profile source.
 *
 * Login-gate posture (deliberately different from the GitHub provider):
 * WorkOS itself is the primary gate — the AuthKit tenant configuration
 * (allowed auth methods, SSO connections, domain policies) decides who can
 * authenticate at all. `ALLOWED_EMAIL_DOMAINS` is therefore an OPTIONAL
 * defense-in-depth allowlist here (empty = rely on tenant config), unlike the
 * GitHub provider where an empty gate is a boot error because GitHub has no
 * tenant restriction. Regardless of the allowlist, `email_verified === true`
 * is a hard requirement: an unverified email must never feed the
 * invite-linking in `PrismaOAuthStore.linkPendingMemberships` (an attacker
 * could otherwise hijack an invite keyed on someone else's address).
 */

import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import OAuth2Strategy from 'passport-oauth2';
import type { OAuthProviderConfig, OAuthUserProfile } from '@rekog/mcp-nest';
import { emailDomain, joinUrl, parseCsv } from './provider-utils.js';
import { type AuthConfig, authConfigFromEnv } from '../../config/app-config.js';

const gateLogger = new Logger('WorkOSLoginGate');

/** OIDC userinfo claims we consume (scopes: openid profile email). */
interface WorkOSClaims extends Record<string, unknown> {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

/**
 * Build a passport-oauth2 subclass bound to one AuthKit domain that
 * fetches the OIDC userinfo claims as the profile.
 */
function makeWorkOSStrategy(authkitDomain: string): typeof OAuth2Strategy {
  return class WorkOSStrategy extends OAuth2Strategy {
    override authorizationParams(options: unknown): object {
      // WorkOS Connect documents `nonce` as required on /oauth2/authorize.
      // We never consume the id_token (the profile comes from userinfo), so
      // the nonce is never validated on our side — a fresh random value per
      // redirect satisfies the authorization server.
      return { ...super.authorizationParams(options), nonce: randomBytes(16).toString('hex') };
    }

    override userProfile(accessToken: string, done: (err?: unknown, profile?: unknown) => void): void {
      fetch(`${authkitDomain}/oauth2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`userinfo returned HTTP ${res.status}`);
          }
          return (await res.json()) as WorkOSClaims;
        })
        .then((claims) => done(null, claims))
        .catch((e: unknown) => {
          // Rejects login BEFORE the gate (no "Login denied" line appears),
          // so surface exactly why — fail closed, like the GitHub
          // profile-fetch path.
          gateLogger.error(
            `WorkOS userinfo fetch failed (rejected before gate): ${e instanceof Error ? e.message : String(e)}`,
          );
          done(e);
        });
    }
  };
}

/**
 * Build the WorkOS AuthKit provider. Fails fast at startup when
 * WORKOS_AUTHKIT_DOMAIN is missing or not https. A thrown error in
 * `profileMapper` is surfaced by the SDK as "Authentication failed"
 * (fail closed) — same gate mechanism as the GitHub provider.
 */
export function buildWorkOSProvider(auth: AuthConfig = authConfigFromEnv()): OAuthProviderConfig {
  const rawDomain = auth.workos.authkitDomain?.trim();
  if (!rawDomain) {
    throw new Error(
      'WORKOS_AUTHKIT_DOMAIN is required for the WorkOS upstream (e.g. "https://acme.authkit.app" or your custom auth domain).',
    );
  }
  if (!rawDomain.startsWith('https://')) {
    throw new Error(`WORKOS_AUTHKIT_DOMAIN must be an https:// URL, got "${rawDomain}".`);
  }
  const authkitDomain = rawDomain.replace(/\/+$/, '');

  // Optional defense-in-depth (see header). Empty = rely on the AuthKit
  // tenant configuration to decide who may authenticate.
  const allowedDomains = parseCsv(auth.allowedEmailDomains);

  const enforceLoginGate = (claims: WorkOSClaims): string => {
    const email = typeof claims.email === 'string' ? claims.email : '';
    const sub = String(claims.sub ?? 'unknown');

    if (claims.email_verified !== true || !email) {
      gateLogger.warn(
        `Login denied for "${sub}": email=${email || '(none)'} email_verified=${String(claims.email_verified)}`,
      );
      throw new Error(`WorkOS user "${sub}" has no verified email`);
    }
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain(email.toLowerCase()))) {
      gateLogger.warn(`Login denied for "${sub}": verifiedEmail=${email} | gate domains=[${allowedDomains.join(',')}]`);
      throw new Error(`WorkOS user "${sub}" is not in an allowed email domain`);
    }
    return email;
  };

  return {
    name: 'workos',
    displayName: 'WorkOS',
    strategy: makeWorkOSStrategy(authkitDomain),
    strategyOptions: ({ serverUrl, clientId, clientSecret, callbackPath }) => ({
      authorizationURL: `${authkitDomain}/oauth2/authorize`,
      tokenURL: `${authkitDomain}/oauth2/token`,
      clientID: clientId,
      clientSecret,
      callbackURL: joinUrl(serverUrl, callbackPath ?? '/callback'),
      // passport joins with ' ' (default scopeSeparator) — correct for OIDC.
      scope: ['openid', 'profile', 'email'],
      // Deliberately NO `state: true` / `store` / `pkce` here: the SDK
      // controller passes its own state cookie as a plain string via
      // `passport.authenticate(name, { state })`, which passport-oauth2 only
      // forwards verbatim when its automatic state store is off. PKCE toward
      // the upstream is unnecessary — our AS already does PKCE with the MCP
      // client.
    }),
    profileMapper: (claims: WorkOSClaims): OAuthUserProfile => {
      const email = enforceLoginGate(claims);

      if (!claims.sub) {
        // Should be impossible for a spec-compliant OIDC userinfo response;
        // never mint an identity without a stable subject.
        throw new Error('WorkOS userinfo response is missing "sub"');
      }

      const displayName =
        (typeof claims.name === 'string' && claims.name) ||
        [claims.given_name, claims.family_name].filter((s) => typeof s === 'string' && s).join(' ') ||
        undefined;

      return {
        // Identity: the store derives the durable user id from
        // sha256('workos:' + sub); username is display/fallback only.
        id: String(claims.sub),
        username: email,
        email,
        displayName,
        avatarUrl: typeof claims.picture === 'string' ? claims.picture : undefined,
        raw: claims,
      };
    },
  };
}
