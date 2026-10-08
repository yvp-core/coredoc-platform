import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNNER_LEASE_HEADER, RUNNER_PROTOCOL_VERSION } from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { STORAGE_CONFIG, storageConfigFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { cloudAgentRunsCoreProviders, CLOUD_AGENT_RUNS_CLOCK } from './cloud-agent-runs.module.js';

/**
 * The cloud agent runs module driven through its two HTTP surfaces on real
 * PostgreSQL, with every guard REAL — AuthGuard included. Runner tokens are
 * minted through the real token API and presented as bearer tokens; only the
 * human JWT verification is stubbed (`Bearer jwt:<userId>`), because this
 * process has no token issuer. The runner is a scripted fake making runner
 * API calls; time comes from an injected clock.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;

const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const DEMOTED = { id: `${RUN}-demoted`, email: 'demoted@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285', claudeCode: '2.1.285', plugin: 'abc123' };

let issueSeed = 0;
function nextIssueKey(): string {
  issueSeed += 1;
  return `PROJ-${issueSeed}`;
}

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let now = new Date('2026-10-10T09:00:00.000Z');

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    // Available for agent runs: Delivery analytics with active Jira (project PROJ) and GitHub connectors.
    const workspace = await prisma.workspace.create({
      data: { name: `car-${RUN}`, slug: `car-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.deliveryConnector.createMany({
      data: [
        {
          workspaceId,
          provider: 'jira',
          displayName: 'Jira',
          baseUrl: 'https://example.atlassian.net',
          credentialsEncrypted: encrypt(JSON.stringify({ email: 'bot@example.com', apiToken: 'jira-token' })),
          config: { projects: ['PROJ'] },
        },
        { workspaceId, provider: 'github', displayName: 'GitHub', credentialsEncrypted: encrypt('github-token') },
      ],
    });
    const other = await prisma.workspace.create({ data: { name: `car-other-${RUN}`, slug: `car-other-${RUN}` } });
    otherWorkspaceId = other.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
        { workspaceId, userId: DEMOTED.id, email: DEMOTED.email, role: 'admin' },
        { workspaceId: otherWorkspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
      ],
    });

    const users = new Map([ADMIN, MEMBER, DEMOTED].map((user) => [user.id, user]));
    const storage = storageConfigFromEnv();
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudAgentRunsController, CloudAgentRunnerController, TokensController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        TokensService,
        ...cloudAgentRunsCoreProviders,
        { provide: CLOUD_AGENT_RUNS_CLOCK, useValue: () => now },
        { provide: STORAGE_CONFIG, useValue: { ...storage, r2: { ...storage.r2, endpoint: 'https://r2.example' } } },
        {
          provide: AuthService,
          useValue: {
            async verifyAccessToken(token: string) {
              const user = users.get(token.replace(/^jwt:/, ''));
              if (!user) throw new Error('unknown test user');
              return user;
            },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = (ws = workspaceId) => `/api/v1/workspaces/${ws}/cloud-agent-runs`;
  const runnerBase = (ws = workspaceId) => `/api/v1/workspaces/${ws}/agent-runner`;

  async function mintRunnerToken(name: string, admin = ADMIN): Promise<string> {
    const res = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(admin))
      .send({ name, scope: 'agent-runner' })
      .expect(201);
    return res.body.token as string;
  }

  /** A token row written directly, for credentials the token API (rightly) never mints. */
  async function insertToken(ws: string, permissions: string[], createdBy = ADMIN.id): Promise<string> {
    const plaintext = `cdt_${randomBytes(32).toString('hex')}`;
    await prisma.serviceToken.create({
      data: {
        workspaceId: ws,
        name: `direct-${randomBytes(4).toString('hex')}`,
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
        permissions,
        createdBy,
      },
    });
    return plaintext;
  }

  /** Runs never finish in this suite, so the concurrency limit is set high enough that every start starts. */
  async function enable(): Promise<void> {
    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50 })
      .expect(200);
  }

  function start(issueKey: string, user = MEMBER) {
    return api().post(runsBase()).set('Authorization', human(user)).send({ issueKey });
  }

  function claim(token: string, protocolVersion = RUNNER_PROTOCOL_VERSION) {
    return api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .send({ protocolVersion, versions: VERSIONS });
  }

  function turnCall(token: string, turnId: string, lease: string, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turnId}/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .set(RUNNER_LEASE_HEADER, lease)
      .send(body as object);
  }

  /** Claim until the runner gets nothing, so each scenario starts with an empty queue. */
  async function drainQueue(token: string): Promise<void> {
    for (;;) {
      const res = await claim(token);
      if (res.status === 204) return;
      expect(res.status).toBe(200);
      await turnCall(token, res.body.turn.id, res.body.lease.token, 'complete', {
        outcome: { kind: 'ended' },
        spend: null,
        versions: VERSIONS,
      }).expect(200);
    }
  }

  it('an admin enables agent runs as run owner and mints a runner token the settings list', async () => {
    await api().put(`${runsBase()}/settings`).set('Authorization', human(MEMBER)).send({ enabled: true }).expect(403);
    await enable();
    await mintRunnerToken('runner-settings');

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(MEMBER)).expect(200);
    expect(settings.body).toMatchObject({
      enabled: true,
      runOwner: { userId: ADMIN.id, email: ADMIN.email, valid: true },
    });
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'runner-settings', lastSeenAt: null, refusal: null })]),
    );
  });

  it('a member start queues a scope turn; a second start for the same issue is refused', async () => {
    await enable();
    const issueKey = nextIssueKey();

    const started = await start(issueKey).expect(201);
    expect(started.body).toMatchObject({
      issueKey,
      trigger: 'manual',
      runOwner: { userId: MEMBER.id },
      currentTurn: { kind: 'scope', state: 'queued', attempt: 0 },
    });

    const again = await start(issueKey).expect(409);
    expect(again.body.code).toBe('ACTIVE_RUN_EXISTS');

    const listed = await api().get(runsBase()).set('Authorization', human(MEMBER)).expect(200);
    expect(listed.body.runs.filter((run: { issueKey: string }) => run.issueKey === issueKey)).toHaveLength(1);
  });

  it('concurrent starts for one issue create exactly one run', async () => {
    await enable();
    const issueKey = nextIssueKey();
    const results = await Promise.all([start(issueKey), start(issueKey), start(issueKey)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
  });

  it('a runner claims, heartbeats, reports events and completes; the run page shows them in order', async () => {
    await enable();
    const token = await mintRunnerToken('runner-e2e');
    await drainQueue(token);
    const { body: run } = await start(nextIssueKey()).expect(201);

    const claimed = await claim(token).expect(200);
    expect(claimed.body).toMatchObject({
      turn: { kind: 'scope', ordinal: 1, attempt: 1, inputText: null },
      run: { id: run.id, issueKey: run.issueKey, questionsPolicy: 'pause', scopeAcceptancePolicy: 'required' },
    });
    const turnId = claimed.body.turn.id as string;
    const lease = claimed.body.lease.token as string;

    const beat = await turnCall(token, turnId, lease, 'heartbeat', { versions: VERSIONS }).expect(200);
    expect(beat.body.stop).toBe(false);

    const reported = await turnCall(token, turnId, lease, 'events', {
      events: [
        { type: 'phase', phase: 'scoping' },
        { type: 'raw', text: '[init] model=default' },
      ],
    }).expect(200);
    expect(reported.body.stop).toBe(false);

    const completion = { outcome: { kind: 'ended' }, spend: { costUsd: 0.25, sdkTurns: 3 }, versions: VERSIONS };
    await turnCall(token, turnId, lease, 'complete', completion).expect(200);
    // A repeated completion of a completed turn is a no-op, not a second spend.
    await turnCall(token, turnId, lease, 'complete', completion).expect(200);

    const detail = await api().get(`${runsBase()}/${run.id}`).set('Authorization', human(MEMBER)).expect(200);
    expect(detail.body).toMatchObject({ status: 'scoping', spend: { usd: 0.25, unknownTurns: 0 }, currentTurn: null });

    const timeline = await api()
      .get(`${runsBase()}/${run.id}/events?after=0`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    const events = timeline.body.events as Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
    expect(events.map((event) => event.type)).toEqual([
      'status_changed',
      'status_changed',
      'turn_started',
      'phase',
      'raw',
      'turn_ended',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[1]?.payload).toMatchObject({ from: 'queued', to: 'scoping' });

    const page = await api()
      .get(`${runsBase()}/${run.id}/events?after=4`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    expect(page.body.events.map((event: { seq: number }) => event.seq)).toEqual([5, 6]);

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'runner-e2e',
          lastSeenAt: now.toISOString(),
          lastAction: 'heartbeat',
          versions: VERSIONS,
          refusal: null,
        }),
      ]),
    );
  });

  it('two runners claiming at once get different turns, and a third finds nothing', async () => {
    await enable();
    const first = await mintRunnerToken('runner-a');
    const second = await mintRunnerToken('runner-b');
    await drainQueue(first);
    await start(nextIssueKey()).expect(201);
    await start(nextIssueKey()).expect(201);

    const [a, b] = await Promise.all([claim(first), claim(second)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.turn.id).not.toBe(b.body.turn.id);
    await claim(first).expect(204);
  });

  it('a stale lease gets LEASE_LOST', async () => {
    await enable();
    const token = await mintRunnerToken('runner-stale');
    await drainQueue(token);
    await start(nextIssueKey()).expect(201);
    const claimed = await claim(token).expect(200);
    const turnId = claimed.body.turn.id as string;

    const wrongLease = await turnCall(token, turnId, '00000000-0000-4000-8000-000000000000', 'heartbeat', {
      versions: VERSIONS,
    }).expect(409);
    expect(wrongLease.body.code).toBe('LEASE_LOST');

    now = new Date(now.getTime() + 3 * 60_000);
    const expired = await turnCall(token, turnId, claimed.body.lease.token, 'events', {
      events: [{ type: 'raw', text: 'late' }],
    }).expect(409);
    expect(expired.body.code).toBe('LEASE_LOST');
  });

  it('refuses a runner on an unsupported protocol version, and settings say why', async () => {
    await enable();
    const token = await mintRunnerToken('runner-old');
    const refused = await claim(token, 999).expect(409);
    expect(refused.body.code).toBe('RUNNER_INCOMPATIBLE');

    const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
    expect(settings.body.runnerTokens).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'runner-old', refusal: 'runner_incompatible' })]),
    );
  });

  it('the /me agent-runs flag is on while enabled, stays on for a workspace with runs, and is off otherwise', async () => {
    const controlPlane = app.get(ControlPlaneService);
    const flags = async () =>
      new Map(
        (await controlPlane.listWorkspacesForUser(ADMIN.id)).map((workspace) => [
          workspace.id,
          workspace.agentRunsEnabled,
        ]),
      );

    await enable();
    await start(nextIssueKey()).expect(201);
    expect((await flags()).get(workspaceId)).toBe(true);
    expect((await flags()).get(otherWorkspaceId)).toBe(false);

    await api().put(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).send({ enabled: false }).expect(200);
    expect((await flags()).get(workspaceId)).toBe(true);
    await enable();
  });

  describe('guards', () => {
    it('human routes refuse every service token, runner tokens included', async () => {
      const runner = await mintRunnerToken('runner-human-routes');
      const ci = await insertToken(workspaceId, [TokenPermission.ParserRead]);
      for (const token of [runner, ci]) {
        await api().get(runsBase()).set('Authorization', `Bearer ${token}`).expect(403);
        await api().post(runsBase()).set('Authorization', `Bearer ${token}`).send({ issueKey: 'PROJ-1' }).expect(403);
      }
    });

    it('runner routes refuse human sessions, other workspaces’ tokens and a legacy grant-all token', async () => {
      await api()
        .post(`${runnerBase()}/claim`)
        .set('Authorization', human(ADMIN))
        .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS })
        .expect(403);

      const foreign = await insertToken(otherWorkspaceId, [TokenPermission.AgentRunnerRun]);
      await claim(foreign).expect(403);

      const grantAll = await insertToken(workspaceId, ['*']);
      await claim(grantAll).expect(403);
    });

    it('a runner token whose creator was demoted is refused, and settings say why', async () => {
      const token = await mintRunnerToken('runner-demoted', DEMOTED);
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: DEMOTED.id } },
        data: { role: 'member' },
      });

      await claim(token).expect(403);
      const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
      expect(settings.body.runnerTokens).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'runner-demoted', refusal: 'creator_not_admin' })]),
      );
    });

    it('non-members get 403', async () => {
      await api().get(runsBase(otherWorkspaceId)).set('Authorization', human(MEMBER)).expect(403);
    });
  });

  describe('partial unique indexes', () => {
    async function expectUniqueViolation(operation: Promise<unknown>): Promise<void> {
      const error = await operation.then(
        () => null,
        (caught: unknown) => caught,
      );
      const code = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } } | null)?.meta
        ?.driverAdapterError?.cause?.originalCode;
      expect(code).toBe('23505');
    }

    it('allow one open run per Jira issue and one queued or claimed turn per run', async () => {
      await enable();
      const { body: run } = await start(nextIssueKey()).expect(201);
      const row = await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id: run.id } });
      const { id: _id, createdAt: _c, updatedAt: _u, ...copy } = row;

      await expectUniqueViolation(
        prisma.cloudAgentRun.create({
          data: { ...copy, repositories: [], droppedSeeds: [], pullRequests: [], jiraOutcome: {}, assumptions: [] },
        }),
      );
      await expectUniqueViolation(
        prisma.cloudAgentRunTurn.create({ data: { workspaceId, runId: run.id, ordinal: 2, kind: 'scope' } }),
      );

      // A terminal run frees the issue.
      await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { status: 'failed' } });
      await prisma.cloudAgentRun.create({
        data: { ...copy, repositories: [], droppedSeeds: [], pullRequests: [], jiraOutcome: {}, assumptions: [] },
      });
    });
  });
});
