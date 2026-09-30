/**
 * GitHub upstream provider for the self-hosted OAuth server, with an on-prem
 * login gate: a user may obtain a token only if their verified email is in an
 * allowed domain (e.g. example.com) OR they are a member of an allowed GitHub org
 * (e.g. example-org). Workspace access is gated separately by membership.
 *
 * Built on the library's `GitHubOAuthProvider` but:
 *  - requests scope via `strategyOptions` (passport reads scope there; the
 *    provider's top-level `scope` field is not used by the SDK), adding
 *    `read:org` when an org policy is configured;
 *  - swaps in a Strategy subclass that fetches the user's verified primary email
 *    (GitHub's basic profile omits private emails) and, when needed, their org
 *    logins, attaching both to the profile;
 *  - rejects users outside the allowed domains/orgs in `profileMapper` — a
 *    thrown error there is surfaced by the SDK as "Authentication failed"
 *    (fail closed).
 */

import { Logger } from '@nestjs/common';
import { type AuthConfig, authConfigFromEnv } from '../../config/app-config.js';
import { Strategy as GitHubStrategy } from 'passport-github';
import { GitHubOAuthProvider, type OAuthProviderConfig } from '@rekog/mcp-nest';
import { emailDomain, joinUrl, parseCsv } from './provider-utils.js';

const gateLogger = new Logger('GitHubLoginGate');

async function githubApi<T>(path: string, accessToken: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'coredoc-auth',
        Accept: 'application/vnd.github+json',
      },
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch (error) {
    // A GitHub outage must not read as "this user passed the gate": null is the
    // deny answer every caller already takes. Logged because, unlike a plain
    // 403, an unreachable API is an operator problem worth seeing.
    // Only the coarse endpoint (`user`, `orgs`, …) — the full path embeds the
    // org and login, so an outage would write a per-login identity trail.
    const endpoint = path.split('/').filter(Boolean)[0] ?? 'unknown';
    gateLogger.warn(`GitHub API /${endpoint} failed — ${(error as Error)?.message ?? error}`);
    return null;
  }
}

type GitHubEmail = { email: string; primary: boolean; verified: boolean };

/**
 * Select the only email the login gate may trust: the verified primary, else
 * any verified address. Returns undefined when the account has NO verified
 * email — we must never fall back to an unverified address. GitHub lets a user
 * add an arbitrary unverified email (e.g. `victim@example.com`) to their account; an
 * unverified address would otherwise satisfy the domain allowlist and let the
 * caller hijack an invite keyed on that email (see linkPendingMemberships).
 */
export function chooseVerifiedEmail(emails: GitHubEmail[] | null | undefined): string | undefined {
  if (!Array.isArray(emails)) return undefined;
  const verified = emails.filter((e) => e?.verified);
  return (verified.find((e) => e.primary) ?? verified[0])?.email;
}

/**
 * Build a GitHub strategy that enriches the profile with the user's verified
 * primary email (under `profile.emails`) for the domain gate. When `fetchOrgs`
 * is set it also attaches the user's org logins (under `profile.organizations`)
 * — currently unused, kept for re-enabling org-based access (callers pass
 * `false`).
 */
function makePolicyStrategy(fetchOrgs: boolean): typeof GitHubStrategy {
  return class extends GitHubStrategy {
    override userProfile(accessToken: string, done: (err: unknown, profile?: unknown) => void): void {
      super.userProfile(accessToken, (err: unknown, profile: Record<string, unknown> | undefined) => {
        if (err || !profile) {
          // Base GitHub /user fetch failed — this rejects login BEFORE the gate,
          // so no "Login denied" line appears. Surface exactly why.
          gateLogger.error(
            `GitHub profile fetch failed (rejected before gate): ${err instanceof Error ? err.message : String(err ?? 'no profile returned')}`,
          );
          done(err, profile);
          return;
        }
        Promise.all([
          githubApi<GitHubEmail[]>('/user/emails', accessToken),
          fetchOrgs
            ? githubApi<Array<{ login: string }>>('/user/orgs?per_page=100', accessToken)
            : Promise.resolve(null),
        ])
          .then(([emails, orgs]) => {
            // Overwrite whatever the base strategy set: the gate must see only
            // an email we confirmed verified via /user/emails, or none at all
            // (fail closed to denial).
            const chosen = chooseVerifiedEmail(emails);
            profile.emails = chosen ? [{ value: chosen }] : [];
            profile.organizations = Array.isArray(orgs) ? orgs.map((o) => o.login) : [];
            done(null, profile);
          })
          .catch((e) => {
            // Could not confirm email from GitHub — trust nothing, fail closed.
            gateLogger.error(`GitHub email fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            profile.emails = [];
            profile.organizations = [];
            done(null, profile);
          });
      });
    }
  };
}

/**
 * Build the GitHub provider with an email-domain login gate. A user may sign in
 * only if their verified GitHub email is in an allowed domain. Fails fast at
 * startup if no domain is configured — never silently allows every GitHub user.
 *
 * The org-membership path is intentionally disabled for now; the strategy no
 * longer requests `read:org` or fetches `/user/orgs`. Re-enable by reinstating
 * an org check here and passing `makePolicyStrategy(true)`.
 */
export function buildGitHubProvider(auth: AuthConfig = authConfigFromEnv()): OAuthProviderConfig {
  const allowedDomains = parseCsv(auth.allowedEmailDomains);

  if (allowedDomains.length === 0) {
    throw new Error('Login gate is empty: set ALLOWED_EMAIL_DOMAINS (comma-separated, e.g. "example.com").');
  }

  const scope = ['user:email'];

  const enforceLoginGate = (profile: Record<string, unknown>): void => {
    const emails = Array.isArray(profile.emails)
      ? (profile.emails as Array<{ value?: string }>).map((e) => String(e.value ?? '').toLowerCase()).filter(Boolean)
      : [];

    if (emails.some((em) => allowedDomains.includes(emailDomain(em)))) return;

    const username = String(profile.username ?? profile.login ?? 'unknown');
    // Diagnostic: show exactly what GitHub returned vs. the configured gate, so a
    // denied login is debuggable from the server logs.
    gateLogger.warn(
      `Login denied for "${username}": verifiedEmail=${emails[0] ?? '(none)'} | gate domains=[${allowedDomains.join(',')}]`,
    );
    throw new Error(`GitHub user "${username}" is not in an allowed email domain`);
  };

  return {
    name: 'github',
    strategy: makePolicyStrategy(false),
    strategyOptions: ({ serverUrl, clientId, clientSecret, callbackPath }) => ({
      clientID: clientId,
      clientSecret,
      callbackURL: joinUrl(serverUrl, callbackPath ?? '/callback'),
      scope,
    }),
    scope,
    profileMapper: (profile: Record<string, unknown>) => {
      enforceLoginGate(profile);
      return GitHubOAuthProvider.profileMapper(profile);
    },
  };
}
