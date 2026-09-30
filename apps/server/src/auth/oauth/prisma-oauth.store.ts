/**
 * Prisma-backed IOAuthStore for the @rekog/mcp-nest authorization server.
 *
 * The library only ships TypeORM + in-memory stores. We back the AS with the
 * Postgres control plane so OAuth state (clients, codes, sessions, profiles) is
 * durable and shared across stateless replicas — `MemoryStore` would break
 * across instances (a code issued on one process couldn't be exchanged on
 * another).
 *
 * Semantics mirror the shipped `MemoryStore` exactly:
 *  - deterministic `generateClientId` → idempotent (re)registration;
 *  - `profile_id = sha256("<provider>:<id>").slice(0,24)`;
 *  - sessions expire on read (delete + return undefined);
 *  - `expires_at` / `expiresAt` are BigInt millisecond epochs.
 *
 * The store is registered as a `useValue` provider and is therefore NOT
 * DI-managed: it owns a standalone PrismaClient and is disposed by `OAuthModule`
 * on shutdown.
 */

import { createHash } from 'node:crypto';
import type { IOAuthStore, OAuthClient, AuthorizationCode, OAuthSession, OAuthUserProfile } from '@rekog/mcp-nest';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createStandalonePrismaClient } from '../../database/create-prisma-client.js';
import { linkPendingMemberships } from './link-pending-memberships.js';
import type pg from 'pg';

type StoredUserProfile = OAuthUserProfile & { profile_id: string; provider: string };

export class PrismaOAuthStore implements IOAuthStore {
  private readonly prisma: PrismaClient;
  private readonly pool: pg.Pool | null;

  /**
   * In production, constructed with no argument — it builds and owns a
   * standalone client (the custom store is a `useValue` provider and cannot
   * receive the DI `PrismaService`). Tests may inject a client; when injected
   * the store does not own the pool and `dispose()` leaves it to the caller.
   */
  constructor(prisma?: PrismaClient) {
    if (prisma) {
      this.prisma = prisma;
      this.pool = null;
    } else {
      const { client, pool } = createStandalonePrismaClient();
      this.prisma = client;
      this.pool = pool;
    }
  }

  /** Release the dedicated client + pool. Called by OAuthModule.onModuleDestroy. */
  async dispose(): Promise<void> {
    try {
      await this.prisma.$disconnect();
    } finally {
      if (this.pool) await this.pool.end();
    }
  }

  // ===========================================================================
  // OAuth clients
  // ===========================================================================

  async storeClient(client: OAuthClient): Promise<OAuthClient> {
    // created_at/updated_at are managed by the DB (default now / @updatedAt) so
    // they are not overwritten on re-registration.
    const data = {
      client_id: client.client_id,
      client_secret: client.client_secret ?? null,
      client_name: client.client_name,
      client_description: client.client_description ?? null,
      logo_uri: client.logo_uri ?? null,
      client_uri: client.client_uri ?? null,
      developer_name: client.developer_name ?? null,
      developer_email: client.developer_email ?? null,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
    };
    const row = await this.prisma.oAuthClient.upsert({
      where: { client_id: client.client_id },
      create: data,
      update: data,
    });
    return this.toClient(row);
  }

  async getClient(client_id: string): Promise<OAuthClient | undefined> {
    const row = await this.prisma.oAuthClient.findUnique({ where: { client_id } });
    return row ? this.toClient(row) : undefined;
  }

  async findClient(client_name: string): Promise<OAuthClient | undefined> {
    const row = await this.prisma.oAuthClient.findFirst({ where: { client_name } });
    return row ? this.toClient(row) : undefined;
  }

  /**
   * Deterministic client id (mirrors MemoryStore): a normalized name plus a
   * stable hash of the canonicalized client object. Deterministic ids make
   * concurrent/repeated dynamic registration idempotent — the `storeClient`
   * upsert collapses duplicates instead of throwing a unique violation.
   */
  generateClientId(client: OAuthClient): string {
    const normalized = this.normalizeClientObject(client);
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    const normalizedName = client.client_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${normalizedName}_${hash.substring(0, 16)}`;
  }

  // ===========================================================================
  // Authorization codes
  // ===========================================================================

  async storeAuthCode(code: AuthorizationCode): Promise<void> {
    await this.prisma.authorizationCode.create({
      data: {
        code: code.code,
        user_id: code.user_id,
        client_id: code.client_id,
        redirect_uri: code.redirect_uri,
        code_challenge: code.code_challenge,
        code_challenge_method: code.code_challenge_method,
        expires_at: BigInt(code.expires_at),
        resource: code.resource ?? null,
        scope: code.scope ?? null,
        used_at: code.used_at ?? null,
        user_profile_id: code.user_profile_id ?? null,
      },
    });
  }

  async getAuthCode(code: string): Promise<AuthorizationCode | undefined> {
    // Atomic single-use consumption. The SDK reads the code here, validates
    // PKCE, issues the token pair, and only THEN calls removeAuthCode — leaving
    // a replay window on stateless replicas where two concurrent POST /token
    // with the same code both pass and both receive tokens. Marking `used_at`
    // in a conditional UPDATE (only while still NULL) closes it: the first
    // caller updates one row and proceeds; a concurrent caller updates zero
    // rows, gets undefined, and the SDK rejects it as an invalid code.
    const consumed = await this.prisma.authorizationCode.updateMany({
      where: { code, used_at: null },
      data: { used_at: new Date() },
    });
    if (consumed.count === 0) return undefined;
    const row = await this.prisma.authorizationCode.findUnique({ where: { code } });
    if (!row) return undefined;
    return {
      code: row.code,
      user_id: row.user_id,
      client_id: row.client_id,
      redirect_uri: row.redirect_uri,
      code_challenge: row.code_challenge,
      code_challenge_method: row.code_challenge_method,
      expires_at: Number(row.expires_at),
      resource: row.resource ?? undefined,
      scope: row.scope ?? undefined,
      used_at: row.used_at ?? undefined,
      user_profile_id: row.user_profile_id ?? undefined,
    };
  }

  async removeAuthCode(code: string): Promise<void> {
    // deleteMany never throws when the row is already gone (idempotent).
    await this.prisma.authorizationCode.deleteMany({ where: { code } });
  }

  // ===========================================================================
  // OAuth sessions (short-lived; expire on read)
  // ===========================================================================

  async storeOAuthSession(sessionId: string, session: OAuthSession): Promise<void> {
    const data = {
      state: session.state,
      clientId: session.clientId ?? null,
      redirectUri: session.redirectUri ?? null,
      codeChallenge: session.codeChallenge ?? null,
      codeChallengeMethod: session.codeChallengeMethod ?? null,
      oauthState: session.oauthState ?? null,
      resource: session.resource ?? null,
      scope: session.scope ?? null,
      expiresAt: BigInt(session.expiresAt),
    };
    await this.prisma.oAuthSession.upsert({
      where: { sessionId },
      create: { sessionId, ...data },
      update: data,
    });
  }

  async getOAuthSession(sessionId: string): Promise<OAuthSession | undefined> {
    const row = await this.prisma.oAuthSession.findUnique({ where: { sessionId } });
    if (!row) return undefined;
    if (Number(row.expiresAt) < Date.now()) {
      await this.prisma.oAuthSession.deleteMany({ where: { sessionId } });
      return undefined;
    }
    return {
      sessionId: row.sessionId,
      state: row.state,
      clientId: row.clientId ?? undefined,
      redirectUri: row.redirectUri ?? undefined,
      codeChallenge: row.codeChallenge ?? undefined,
      codeChallengeMethod: row.codeChallengeMethod ?? undefined,
      oauthState: row.oauthState ?? undefined,
      resource: row.resource ?? undefined,
      scope: row.scope ?? undefined,
      expiresAt: Number(row.expiresAt),
    };
  }

  async removeOAuthSession(sessionId: string): Promise<void> {
    await this.prisma.oAuthSession.deleteMany({ where: { sessionId } });
  }

  // ===========================================================================
  // User profiles
  // ===========================================================================

  async upsertUserProfile(profile: OAuthUserProfile, provider: string): Promise<string> {
    const raw = profile.raw !== undefined ? JSON.stringify(profile.raw) : null;

    // `profile_id` is a deterministic hash of (provider, providerUserId) and is
    // the only writer of the row, so it IS the natural key. Upserting on it is
    // idempotent and race-safe: concurrent first-logins for the same GitHub id
    // collapse onto one row via ON CONFLICT, instead of racing
    // findFirst→create into a primary-key unique violation that fails one login.
    const profileId = this.generateProfileId(provider, profile.id);
    const mutable = {
      username: profile.username,
      email: profile.email ?? null,
      displayName: profile.displayName ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      raw,
    };
    await this.prisma.oAuthUserProfile.upsert({
      where: { profile_id: profileId },
      create: { profile_id: profileId, provider_user_id: profile.id, provider, ...mutable },
      update: mutable,
    });

    // upsertUserProfile is the one reliable per-login event we own, so it is
    // also where invited-by-email members are linked to their real identity.
    await linkPendingMemberships(this.prisma, profileId, profile.email, profile.displayName);
    return profileId;
  }

  async getUserProfileById(profileId: string): Promise<StoredUserProfile | undefined> {
    const row = await this.prisma.oAuthUserProfile.findUnique({ where: { profile_id: profileId } });
    if (!row) return undefined;
    // NB: `raw` is deliberately NOT returned. The OAuth SDK spreads this whole
    // object into the access/refresh token's `user_data` claim, and a GitHub
    // `raw` profile (~3KB) blows the signed JWT past the browser's 4096-byte
    // per-cookie limit — the browser then silently drops `coredoc_session`,
    // leaving the session unauthenticated (a /me 401 → refresh loop). The token
    // only needs identity fields; `raw` stays persisted for potential future
    // use but must never enter the token/cookie.
    return {
      profile_id: row.profile_id,
      provider: row.provider,
      id: row.provider_user_id,
      username: row.username,
      email: row.email ?? undefined,
      displayName: row.displayName ?? undefined,
      avatarUrl: row.avatarUrl ?? undefined,
    };
  }

  // ===========================================================================
  // Helpers (mirror MemoryStore)
  // ===========================================================================

  private generateProfileId(provider: string, providerUserId: string): string {
    return createHash('sha256').update(`${provider}:${providerUserId}`).digest('hex').slice(0, 24);
  }

  private normalizeClientObject(client: OAuthClient): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    const source = client as unknown as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      const value = source[key];
      normalized[key] = Array.isArray(value) ? [...value].sort() : value;
    }
    return normalized;
  }

  private toClient(row: {
    client_id: string;
    client_secret: string | null;
    client_name: string;
    client_description: string | null;
    logo_uri: string | null;
    client_uri: string | null;
    developer_name: string | null;
    developer_email: string | null;
    redirect_uris: string[];
    grant_types: string[];
    response_types: string[];
    token_endpoint_auth_method: string;
    created_at: Date;
    updated_at: Date;
  }): OAuthClient {
    return {
      client_id: row.client_id,
      client_secret: row.client_secret ?? undefined,
      client_name: row.client_name,
      client_description: row.client_description ?? undefined,
      logo_uri: row.logo_uri ?? undefined,
      client_uri: row.client_uri ?? undefined,
      developer_name: row.developer_name ?? undefined,
      developer_email: row.developer_email ?? undefined,
      redirect_uris: row.redirect_uris,
      grant_types: row.grant_types,
      response_types: row.response_types,
      token_endpoint_auth_method: row.token_endpoint_auth_method,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
