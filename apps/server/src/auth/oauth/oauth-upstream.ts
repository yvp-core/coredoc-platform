/**
 * Upstream identity-provider selection for the self-hosted OAuth server.
 *
 * `OAUTH_UPSTREAM` picks the provider the authorization server delegates
 * login to: `github` (default — existing GITHUB_* envs keep working
 * untouched), `google` (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) or `workos`
 * (AuthKit OIDC — requires WORKOS_AUTHKIT_DOMAIN, WORKOS_CLIENT_ID,
 * WORKOS_CLIENT_SECRET). A list such as `github,google` puts a sign-in chooser
 * in front of them (chooser.provider.ts). An unknown value throws at boot
 * (fail fast) — never a silent fallback.
 *
 * Kept out of oauth.module.ts so it can be unit-tested without evaluating
 * `McpAuthModule.forRoot()` (which runs at module-definition time and
 * validates jwtSecret etc.).
 */

import type { OAuthProviderConfig } from '@rekog/mcp-nest';
import { buildGitHubProvider } from './github-allowlist.provider.js';
import { buildWorkOSProvider } from './workos.provider.js';
import { buildGoogleProvider } from './google.provider.js';
import { buildChooserProvider } from './chooser.provider.js';
import { parseCsv } from './provider-utils.js';
import { cookieSecure } from './server-url.js';
import { type AuthConfig, configFromEnv } from '../../config/app-config.js';

export interface UpstreamSelection {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
}

export function resolveUpstream(auth: AuthConfig = configFromEnv().auth): UpstreamSelection {
  // Blank counts as unset (dotenv/compose yield '' for `OAUTH_UPSTREAM=`);
  // only a non-empty unknown value is a config error.
  const names = [...new Set(parseCsv(auth.upstream || 'github'))];
  if (names.length === 0) {
    throw new Error('OAUTH_UPSTREAM must name at least one provider.');
  }
  if (names.length === 1) return resolveOne(names[0] as string, auth);
  if (names.includes('workos')) {
    // AuthKit already offers its own method picker, and the WorkOS invitation
    // paths key off `OAUTH_UPSTREAM === 'workos'`.
    throw new Error('OAUTH_UPSTREAM=workos cannot be combined with other upstreams — enable them in AuthKit instead.');
  }
  const upstreams = names.map((name) => resolveOne(name, auth));
  // The SDK requires non-empty credentials; each delegate carries its own.
  return {
    provider: buildChooserProvider(upstreams, cookieSecure(auth)),
    clientId: 'chooser',
    clientSecret: 'chooser',
  };
}

function resolveOne(upstream: string, auth: AuthConfig): UpstreamSelection {
  switch (upstream) {
    case 'github':
      return {
        provider: buildGitHubProvider(auth),
        clientId: auth.githubClientId,
        clientSecret: auth.githubClientSecret,
      };

    case 'google': {
      const clientId = auth.googleClientId.trim();
      const clientSecret = auth.googleClientSecret.trim();
      const missing = [!clientId && 'GOOGLE_CLIENT_ID', !clientSecret && 'GOOGLE_CLIENT_SECRET'].filter(
        (v): v is string => Boolean(v),
      );
      if (missing.length > 0) {
        throw new Error(`OAUTH_UPSTREAM=google requires: ${missing.join(', ')} (see .env.example).`);
      }
      return { provider: buildGoogleProvider(auth), clientId, clientSecret };
    }

    case 'workos': {
      // Trim so a whitespace-only value fails the required-env check below
      // (rather than surviving boot) and trailing whitespace is never sent to
      // WorkOS as the client_id/secret. Mirrors the WORKOS_AUTHKIT_DOMAIN trim.
      const clientId = auth.workos.clientId?.trim();
      const clientSecret = auth.workos.clientSecret?.trim();
      const missing = [
        !auth.workos.authkitDomain?.trim() && 'WORKOS_AUTHKIT_DOMAIN',
        !clientId && 'WORKOS_CLIENT_ID',
        !clientSecret && 'WORKOS_CLIENT_SECRET',
      ].filter((v): v is string => Boolean(v));
      if (missing.length > 0) {
        throw new Error(`OAUTH_UPSTREAM=workos requires: ${missing.join(', ')} (see .env.example).`);
      }
      return {
        provider: buildWorkOSProvider(auth),
        clientId: clientId as string,
        clientSecret: clientSecret as string,
      };
    }

    default:
      throw new Error(
        `Unknown OAUTH_UPSTREAM "${upstream}" — expected "github", "google", "workos" or a list like "github,google".`,
      );
  }
}
