/**
 * Self-hosted OAuth 2.1 authorization server.
 *
 * Wraps `McpAuthModule.forRoot()` with a pluggable upstream identity provider
 * (OAUTH_UPSTREAM=github|workos — see oauth-upstream.ts) and a Postgres-backed
 * custom store. The store is constructed here at module load because the SDK
 * registers a custom store as a `useValue` provider (no DI), so it owns its
 * own PrismaClient; this module disposes it on shutdown.
 *
 * `forRoot()` (and hence the upstream selection) runs at module-definition
 * time — main.ts loads dotenv before importing AppModule, so envs are visible.
 *
 * Re-exports `McpAuthModule` so importers (AuthModule) can inject the SDK's
 * `JwtTokenService` to validate the access tokens this server issues.
 */

import { Module, type OnModuleDestroy } from '@nestjs/common';
import { McpAuthModule } from '@rekog/mcp-nest';
import { PrismaOAuthStore } from './prisma-oauth.store.js';
import { resolveUpstream } from './oauth-upstream.js';
import { authConfigFromEnv } from '../../config/app-config.js';
import { serverUrl, cookieSecure, mcpResourceIdentifier } from './server-url.js';

// Owned by this module (registered as a useValue store — not DI-managed).
const store = new PrismaOAuthStore();

const auth = authConfigFromEnv();
const upstream = resolveUpstream(auth);

@Module({
  imports: [
    McpAuthModule.forRoot({
      provider: upstream.provider,
      clientId: upstream.clientId,
      clientSecret: upstream.clientSecret,
      // ≥32 chars, validated by the SDK at boot. No insecure default.
      jwtSecret: auth.jwtSecret,
      serverUrl: serverUrl(auth),
      // Mark the oauth_session/oauth_state/auth_token cookies Secure only when
      // actually served over HTTPS. Otherwise (e.g. NODE_ENV=production behind
      // http://localhost) they are dropped by the browser and the callback fails
      // with "Missing OAuth session" (400). Derive from the URL scheme, not
      // NODE_ENV, so local http and prod https both behave correctly.
      cookieSecure: cookieSecure(auth),
      // Single global resource (audience) for all workspace MCP endpoints;
      // per-workspace authorization stays enforced by membership checks. Shared
      // with the protected-resource document so the two cannot drift.
      resource: mcpResourceIdentifier(auth),
      jwtAccessTokenExpiresIn: auth.accessTtl,
      jwtRefreshTokenExpiresIn: auth.refreshTtl,
      enableRefreshTokens: true,
      // Endpoints served at the root (excluded from the /api/v1 global prefix).
      apiPrefix: '',
      storeConfiguration: { type: 'custom', store },
      // Our McpDiscoveryController keeps serving the per-workspace
      // protected-resource document; the SDK owns the AS metadata well-known.
      disableEndpoints: { wellKnownProtectedResourceMetadata: true },
    }),
  ],
  exports: [McpAuthModule],
})
export class OAuthModule implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await store.dispose();
  }
}
