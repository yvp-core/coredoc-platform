import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig, configFromEnv } from '../config/app-config.js';
import { jwtVerify } from 'jose';
import type { AuthUser } from './decorators/current-user.decorator.js';

/**
 * Verifies the access tokens issued by our self-hosted OAuth server
 * (@rekog/mcp-nest McpAuthModule). Tokens are HS256 JWTs signed with
 * OAUTH_JWT_SECRET — the same secret the auth server signs with — so they can
 * be validated locally without a network round-trip.
 *
 * Service tokens (`cdt_…`) are handled separately by the AuthGuard /
 * McpRewriteMiddleware and never reach this service.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret: Uint8Array;

  constructor(@Optional() @Inject(AUTH_CONFIG) auth: AuthConfig = configFromEnv().auth) {
    const secret = auth.jwtSecret;
    if (!secret) {
      this.logger.warn('OAUTH_JWT_SECRET is not set — access-token verification will fail');
    }
    this.secret = new TextEncoder().encode(secret);
  }

  /**
   * Cryptographically verify a locally-issued OAuth access token. Fail closed —
   * reject anything that isn't a valid, unexpired access token. `algorithms`
   * is pinned to HS256 to prevent algorithm-confusion attacks.
   *
   * Identity keys on the stable `user_profile_id` (derived from the immutable
   * GitHub numeric id); `sub` carries the GitHub username, which can change.
   * Profile fields are read from the `user_data` claim the auth server embeds.
   */
  async verifyAccessToken(accessToken: string): Promise<AuthUser> {
    const { payload } = await jwtVerify(accessToken, this.secret, { algorithms: ['HS256'] });

    if (payload['type'] !== 'access') {
      throw new Error('Invalid token: not an access token');
    }

    const id = (payload['user_profile_id'] as string | undefined) ?? payload.sub;
    if (!id) {
      throw new Error('Invalid token: missing subject');
    }

    const userData = (payload['user_data'] ?? {}) as { email?: string; displayName?: string };
    return {
      id,
      email: userData.email ?? '',
      displayName: userData.displayName,
    };
  }
}
