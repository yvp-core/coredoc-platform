/**
 * Upstream identity-provider selection for the self-hosted OAuth server.
 *
 * `OAUTH_UPSTREAM` picks the provider the authorization server delegates
 * login to: `github` (default — existing GITHUB_* envs keep working
 * untouched) or `workos` (AuthKit OIDC — requires WORKOS_AUTHKIT_DOMAIN,
 * WORKOS_CLIENT_ID, WORKOS_CLIENT_SECRET). An unknown value throws at boot
 * (fail fast) — never a silent fallback.
 *
 * Kept out of oauth.module.ts so it can be unit-tested without evaluating
 * `McpAuthModule.forRoot()` (which runs at module-definition time and
 * validates jwtSecret etc.).
 */

import type { OAuthProviderConfig } from '@rekog/mcp-nest';
import { buildGitHubProvider } from './github-allowlist.provider.js';
import { buildWorkOSProvider } from './workos.provider.js';
import { type AuthConfig, authConfigFromEnv } from '../../config/app-config.js';

export interface UpstreamSelection {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret: string;
}

export function resolveUpstream(auth: AuthConfig = authConfigFromEnv()): UpstreamSelection {
  // Blank counts as unset (dotenv/compose yield '' for `OAUTH_UPSTREAM=`);
  // only a non-empty unknown value is a config error.
  const upstream = auth.upstream || 'github';

  switch (upstream) {
    case 'github':
      return {
        provider: buildGitHubProvider(auth),
        clientId: auth.githubClientId,
        clientSecret: auth.githubClientSecret,
      };

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
      throw new Error(`Unknown OAUTH_UPSTREAM "${upstream}" — expected "github" or "workos".`);
  }
}
