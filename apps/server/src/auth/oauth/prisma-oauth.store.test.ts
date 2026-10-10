import '../../config/load-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { OAuthClient } from '@rekog/mcp-nest';
import { PrismaClient } from '../../generated/prisma/client.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaOAuthStore } from './prisma-oauth.store.js';

/**
 * Integration test against an explicitly disposable control-plane Postgres. The store's value
 * is the SQL mapping (BigInt epochs, String[] arrays, upsert, expiry-on-read),
 * which a Prisma mock cannot exercise. OAUTH_STORE_TEST_DATABASE_URL is
 * intentionally separate from DATABASE_URL so a normal test run cannot mutate
 * a developer or production control plane. All artifacts are namespaced by a
 * unique RUN id and removed in afterAll.
 */
const RUN = `oauthtest_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
const TEST_DATABASE_URL = process.env.OAUTH_STORE_TEST_DATABASE_URL ?? '';

describe.skipIf(!TEST_DATABASE_URL)('PrismaOAuthStore (integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let store: PrismaOAuthStore;
  let previousDatabaseUrl: string | undefined;

  const baseClient = (): OAuthClient => ({
    client_id: '',
    client_name: `${RUN}-client`,
    redirect_uris: ['http://localhost:17433/callback', 'http://localhost:9999/cb'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    created_at: new Date(),
    updated_at: new Date(),
  });

  beforeAll(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    store = new PrismaOAuthStore(prisma);
  });

  afterAll(async () => {
    // Remove everything this run created, then release the connection.
    await prisma.oAuthClient.deleteMany({ where: { client_name: { startsWith: RUN } } });
    await prisma.authorizationCode.deleteMany({ where: { code: { startsWith: RUN } } });
    await prisma.oAuthSession.deleteMany({ where: { sessionId: { startsWith: RUN } } });
    await prisma.oAuthUserProfile.deleteMany({ where: { provider_user_id: { startsWith: RUN } } });
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: RUN } } });
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('generateClientId is deterministic and array-order independent', () => {
    const a = { ...baseClient() };
    const b = { ...baseClient(), redirect_uris: [...baseClient().redirect_uris].reverse() };
    expect(store.generateClientId(a)).toBe(store.generateClientId(a));
    expect(store.generateClientId(a)).toBe(store.generateClientId(b));
    expect(store.generateClientId(a)).toMatch(/^[a-z0-9]+_[0-9a-f]{16}$/);
  });

  it('stores/gets/finds a client and upsert is idempotent (arrays round-trip)', async () => {
    const c = baseClient();
    c.client_id = store.generateClientId(c);

    const stored = await store.storeClient(c);
    expect(stored.client_id).toBe(c.client_id);
    expect(stored.redirect_uris).toEqual(c.redirect_uris);
    expect(stored.grant_types).toEqual(c.grant_types);

    // Re-register the same client → no unique violation, single row.
    await expect(store.storeClient(c)).resolves.toBeDefined();

    const byId = await store.getClient(c.client_id);
    expect(byId?.client_name).toBe(c.client_name);
    const byName = await store.findClient(c.client_name);
    expect(byName?.client_id).toBe(c.client_id);

    expect(await store.getClient(`${RUN}-missing`)).toBeUndefined();
  });

  it('stores/gets/removes an auth code (BigInt epoch round-trips as number)', async () => {
    const code = `${RUN}-code-1`;
    const expires_at = Date.now() + 600_000;
    await store.storeAuthCode({
      code,
      user_id: 'user-1',
      client_id: 'client-1',
      redirect_uri: 'http://localhost/cb',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      expires_at,
      resource: 'http://localhost:3000/mcp',
      scope: 'offline_access',
    });

    const got = await store.getAuthCode(code);
    expect(typeof got?.expires_at).toBe('number');
    expect(got?.expires_at).toBe(expires_at);
    expect(got?.resource).toBe('http://localhost:3000/mcp');

    await store.removeAuthCode(code);
    expect(await store.getAuthCode(code)).toBeUndefined();
    // Idempotent: removing again does not throw.
    await expect(store.removeAuthCode(code)).resolves.toBeUndefined();
  });

  it('consumes an auth code atomically — concurrent reads yield exactly one hit', async () => {
    const code = `${RUN}-code-race`;
    await store.storeAuthCode({
      code,
      user_id: 'user-1',
      client_id: 'client-1',
      redirect_uri: 'http://localhost/cb',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      expires_at: Date.now() + 600_000,
      resource: 'http://localhost:3000/mcp',
    });

    // Two concurrent token exchanges race on the same code; single-use must hold.
    const results = await Promise.all([store.getAuthCode(code), store.getAuthCode(code)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);

    // The code is spent — a later read gets nothing.
    expect(await store.getAuthCode(code)).toBeUndefined();
  });

  it('expires sessions on read (delete + return undefined)', async () => {
    const live = `${RUN}-sess-live`;
    const dead = `${RUN}-sess-dead`;
    await store.storeOAuthSession(live, {
      sessionId: live,
      state: 'st',
      expiresAt: Date.now() + 600_000,
      codeChallenge: 'cc',
      codeChallengeMethod: 'S256',
    });
    await store.storeOAuthSession(dead, {
      sessionId: dead,
      state: 'st',
      expiresAt: Date.now() - 1_000,
    });

    expect((await store.getOAuthSession(live))?.sessionId).toBe(live);

    expect(await store.getOAuthSession(dead)).toBeUndefined();
    // The expired row was deleted on read — still gone on a second read.
    const stillGone = await prisma.oAuthSession.findUnique({ where: { sessionId: dead } });
    expect(stillGone).toBeNull();
  });

  it('upsertUserProfile is idempotent and getUserProfileById returns lean identity WITHOUT raw', async () => {
    const providerUserId = `${RUN}-gh-42`;
    const id1 = await store.upsertUserProfile(
      { id: providerUserId, username: 'octocat', email: 'o@example.com', raw: { login: 'octocat', x: 1 } },
      'github',
    );
    const id2 = await store.upsertUserProfile(
      { id: providerUserId, username: 'octocat-renamed', email: 'o@example.com', raw: { login: 'octocat', x: 2 } },
      'github',
    );
    expect(id1).toBe(id2);
    expect(id1).toHaveLength(24);

    const profile = await store.getUserProfileById(id1);
    expect(profile?.id).toBe(providerUserId);
    expect(profile?.username).toBe('octocat-renamed'); // second upsert updated it
    // `raw` must NOT be returned — the SDK spreads this object into the JWT
    // user_data claim, and a real GitHub raw profile overflows the 4KB cookie.
    expect(profile?.raw).toBeUndefined();

    expect(await store.getUserProfileById(`${RUN}-nope`)).toBeUndefined();
  });

  it('links a pending invite to the profile on first login (re-keys by email)', async () => {
    const ws = await prisma.workspace.create({ data: { name: `${RUN}-ws`, slug: `${RUN}-ws` } });
    const email = `invitee-${RUN}@example.com`;
    const placeholderUserId = `pending:${email.toLowerCase()}`;
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: placeholderUserId, email, role: 'member', pending: true },
    });
    await prisma.workspaceInvitation.create({ data: { workspaceId: ws.id, memberUserId: placeholderUserId } });

    // First login with the invited email reconciles the placeholder.
    const profileId = await store.upsertUserProfile({ id: `${RUN}-invitee`, username: 'invitee', email }, 'github');

    const linked = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: profileId } },
    });
    expect(linked).not.toBeNull();
    expect(linked?.pending).toBe(false);

    const placeholder = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: placeholderUserId } },
    });
    expect(placeholder).toBeNull();

    // A second login is a no-op (idempotent), not a throw.
    await expect(store.upsertUserProfile({ id: `${RUN}-invitee`, username: 'invitee', email }, 'github')).resolves.toBe(
      profileId,
    );

    await prisma.workspace.delete({ where: { id: ws.id } });
  });

  it('does not activate an expired pending invitation', async () => {
    const ws = await prisma.workspace.create({ data: { name: `${RUN}-expired-ws`, slug: `${RUN}-expired-ws` } });
    const email = `expired-${RUN}@example.com`;
    const placeholderUserId = `pending:${email.toLowerCase()}`;
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: placeholderUserId, email, role: 'member', pending: true },
    });
    await prisma.workspaceInvitation.create({
      data: { workspaceId: ws.id, memberUserId: placeholderUserId, expiresAt: new Date(Date.now() - 60_000) },
    });

    const profileId = await store.upsertUserProfile(
      { id: `${RUN}-expired-invitee`, username: 'expired', email },
      'github',
    );

    expect(
      await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: profileId } },
      }),
    ).toBeNull();
    expect(
      await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: ws.id, userId: placeholderUserId } },
      }),
    ).not.toBeNull();

    await prisma.workspace.delete({ where: { id: ws.id } });
  });
});
