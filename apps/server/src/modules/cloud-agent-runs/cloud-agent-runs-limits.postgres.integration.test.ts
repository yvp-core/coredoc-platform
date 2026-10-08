import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_LEASE_HEADER, RUNNER_PROTOCOL_VERSION } from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { STORAGE_CONFIG, storageConfigFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunSweep } from './cloud-agent-run-sweep.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { CLOUD_AGENT_RUNS_CLOCK, cloudAgentRunsCoreProviders } from './cloud-agent-runs.module.js';
import { FakeJira, InMemoryArchiveStore, paragraphDoc } from './cloud-agent-runs.test-support.js';

/**
 * How runs stop: cancel, lost runners, budgets, report caps and retention,
 * driven through the human API, the runner API and the run sweep on real
 * PostgreSQL with real guards. The runner is a scripted fake; the clock is
 * injected so leases and limits expire without real time passing.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: limits, cancel and failures (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let sweep: CloudAgentRunSweep;
  let workspaceId: string;
  let runnerToken: string;
  let issueSeed = 0;
  const jira = new FakeJira();
  const archives = new InMemoryArchiveStore();
  let now = new Date('2026-10-10T09:00:00.000Z');

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `carl-${RUN}`, slug: `carl-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'jira',
        displayName: 'Jira',
        baseUrl: 'https://example.atlassian.net',
        credentialsEncrypted: encrypt(JSON.stringify({ email: 'bot@example.com', apiToken: 'jira-token' })),
        config: { projects: ['PROJ'] },
      },
    });
    await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'github',
        displayName: 'GitHub',
        credentialsEncrypted: encrypt('ghp_read_only'),
        config: { repos: [] },
      },
    });
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphRepoHashOf('orders-api'),
        repoName: 'orders-api',
        intentRepoKey: 'orders-api',
        normalizedGitRemote: 'github.com/example-org/orders-api',
      },
    });

    const users = new Map([ADMIN, MEMBER].map((user) => [user.id, user]));
    const storage = storageConfigFromEnv();
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudAgentRunsController, CloudAgentRunnerController, TokensController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        TokensService,
        ...cloudAgentRunsCoreProviders,
        { provide: CLOUD_AGENT_RUNS_CLOCK, useValue: () => now },
        { provide: JIRA_CLIENT_FACTORY, useValue: () => jira.client() },
        { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useValue: archives },
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
    sweep = moduleRef.get(CloudAgentRunSweep);

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    (app as NestExpressApplication).useBodyParser('raw', { type: 'application/octet-stream' });
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');

    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50, maxSpendUsd: 10, maxActiveSeconds: 86_400 })
      .expect(200);
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: 'limits-runner', scope: 'agent-runner' })
      .expect(201);
    runnerToken = minted.body.token as string;
  });

  afterAll(async () => {
    await app?.close();
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  beforeEach(async () => {
    // Every scenario starts with nothing claimable.
    await prisma.cloudAgentRun.updateMany({
      where: { workspaceId, status: { notIn: ['done', 'failed', 'cancelled'] } },
      data: { status: 'cancelled', finishedAt: now },
    });
    await prisma.cloudAgentRunTurn.updateMany({
      where: { workspaceId, state: { in: ['queued', 'claimed'] } },
      data: { state: 'abandoned' },
    });
    now = new Date(now.getTime() + 30 * DAY);
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = () => `/api/v1/workspaces/${workspaceId}/cloud-agent-runs`;
  const runnerBase = () => `/api/v1/workspaces/${workspaceId}/agent-runner`;

  async function startRun() {
    issueSeed += 1;
    const issue = jira.add({
      key: `PROJ-${issueSeed}`,
      summary: `Export orders ${issueSeed}`,
      project: 'PROJ',
      description: paragraphDoc('Customers need order exports.'),
    });
    const res = await api()
      .post(runsBase())
      .set('Authorization', human(MEMBER))
      .send({ issueKey: issue.key })
      .expect(201);
    return res.body as { id: string };
  }

  const claim = () =>
    api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS });

  async function claimTurn() {
    const res = await claim().expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, body: res.body };
  }

  function turnCall(turn: { id: string; lease: string }, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);
  }

  const heartbeat = (turn: { id: string; lease: string }) => turnCall(turn, 'heartbeat', { versions: VERSIONS });

  const cancel = (runId: string) => api().post(`${runsBase()}/${runId}/cancel`).set('Authorization', human(MEMBER));

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const turnRow = (id: string) => prisma.cloudAgentRunTurn.findUniqueOrThrow({ where: { id } });

  describe('cancel', () => {
    it('while a turn is queued leaves nothing to claim', async () => {
      const run = await startRun();

      const cancelled = await cancel(run.id).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', currentTurn: null, failureCode: null });
      await claim().expect(204);
    });

    it('while a turn is claimed: the next heartbeat says stop, and lease expiry neither re-queues it nor changes the code', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      expect(await prisma.serviceToken.count({ where: { owningTurnId: turn.id } })).toBe(1);

      await cancel(run.id).expect(200);
      expect(await prisma.serviceToken.count({ where: { owningTurnId: turn.id } })).toBe(0);
      expect((await heartbeat(turn).expect(200)).body.stop).toBe(true);

      now = new Date(now.getTime() + 10 * MINUTE);
      await sweep.tick();
      expect(await turnRow(turn.id)).toMatchObject({ state: 'abandoned', attempts: 1 });
      expect(await detail(run.id)).toMatchObject({ status: 'cancelled', failureCode: null, currentTurn: null });
      await claim().expect(204);
    });

    it('while waiting for an answer cancels the open question', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      await turnCall(turn, 'questions', {
        toolUseId: 'toolu_1',
        questions: [
          {
            question: 'Which format?',
            header: 'Format',
            options: [
              { label: 'CSV', description: 'Spreadsheets' },
              { label: 'JSON', description: 'Integrations' },
            ],
            multiSelect: false,
          },
        ],
      }).expect(200);
      await turnCall(turn, 'complete', { outcome: { kind: 'ended' }, spend: null, versions: VERSIONS }).expect(200);
      expect((await detail(run.id)).status).toBe('awaiting_answer');

      const cancelled = await cancel(run.id).expect(200);
      expect(cancelled.body).toMatchObject({ status: 'cancelled', openQuestion: null });
      expect(cancelled.body.questions).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    });

    it('a run that already ended is refused with RUN_TERMINAL', async () => {
      const run = await startRun();
      await cancel(run.id).expect(200);
      expect((await cancel(run.id).expect(409)).body.code).toBe('RUN_TERMINAL');
    });
  });

  describe('budgets', () => {
    const complete = (turn: { id: string; lease: string }, extra: Record<string, unknown> = {}) =>
      turnCall(turn, 'complete', { outcome: { kind: 'checkpoint' }, spend: null, versions: VERSIONS, ...extra });

    it('active time counts from leaving queued, stops while a person is asked, and fails the run at the limit', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      now = new Date(now.getTime() + MINUTE);
      const asked = await turnCall(turn, 'questions', {
        toolUseId: 'toolu_1',
        questions: [
          {
            question: 'Which format?',
            header: 'Format',
            options: [
              { label: 'CSV', description: 'Spreadsheets' },
              { label: 'JSON', description: 'Integrations' },
            ],
            multiSelect: false,
          },
        ],
      }).expect(200);
      await complete(turn, { outcome: { kind: 'ended' }, spend: { costUsd: 1 } }).expect(200);

      // Two days waiting for a person do not count.
      now = new Date(now.getTime() + 2 * DAY);
      await sweep.tick();
      expect((await detail(run.id)).status).toBe('awaiting_answer');
      await api()
        .post(`${runsBase()}/${run.id}/questions/${asked.body.requestId}/answer`)
        .set('Authorization', human(MEMBER))
        .send({ answers: [{ labels: ['CSV'] }] })
        .expect(200);

      // Waiting for a runner counts.
      now = new Date(now.getTime() + 23 * HOUR + 58 * MINUTE);
      await sweep.tick();
      expect((await detail(run.id)).status).toBe('scoping');

      now = new Date(now.getTime() + MINUTE);
      await sweep.tick();
      expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'wall_clock_exceeded' });
      await claim().expect(204);
    });

    it('a turn that uses up the spend budget fails the run instead of queuing the next one', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      expect(turn.body.run.remainingSpendUsd).toBe(10);

      await complete(turn, { spend: { costUsd: 10.25, sdkTurns: 40 } }).expect(200);
      expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'budget_exhausted', currentTurn: null });
      await claim().expect(204);
    });

    it('a queued turn of a run whose spend is used up is never handed out', async () => {
      const run = await startRun();
      await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { spendUsd: 10 } });

      await claim().expect(204);
      expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'budget_exhausted' });
    });

    it('three turns of unknown spend fail the run with budget_exhausted', async () => {
      const run = await startRun();
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        await complete(await claimTurn()).expect(200);
        expect((await detail(run.id)).status).toBe('scoping');
      }
      await complete(await claimTurn()).expect(200);

      const failed = await detail(run.id);
      expect(failed).toMatchObject({ status: 'failed', failureCode: 'budget_exhausted', spend: { unknownTurns: 3 } });
      expect(failed.failureReason).toMatch(/unknown spend/i);
    });
  });

  describe('lost runners', () => {
    it('an expired lease re-queues the turn with a new lease; the stale runner gets LEASE_LOST, archive download included', async () => {
      const run = await startRun();
      const first = await claimTurn();

      now = new Date(now.getTime() + 3 * MINUTE);
      await sweep.tick();
      expect(await turnRow(first.id)).toMatchObject({ state: 'queued', attempts: 1 });
      expect((await turnRow(first.id)).leaseToken).not.toBe(first.lease);
      expect(await prisma.serviceToken.count({ where: { owningTurnId: first.id } })).toBe(0);

      const second = await claimTurn();
      expect(second.id).toBe(first.id);
      expect(second.body.turn.attempt).toBe(2);
      expect((await heartbeat(first).expect(409)).body.code).toBe('LEASE_LOST');
      const download = await api()
        .get(`${runnerBase()}/turns/${first.id}/archive`)
        .set('Authorization', `Bearer ${runnerToken}`)
        .set(RUNNER_LEASE_HEADER, first.lease)
        .expect(409);
      expect(download.body.code).toBe('LEASE_LOST');
      expect((await heartbeat(second).expect(200)).body.stop).toBe(false);
      expect((await detail(run.id)).status).toBe('scoping');
    });

    it('the third expiry fails the run with runner_lost and deletes the MCP token', async () => {
      const run = await startRun();
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await claimTurn();
        now = new Date(now.getTime() + 3 * MINUTE);
        await sweep.tick();
      }
      const third = await claimTurn();
      expect(third.body.turn.attempt).toBe(3);
      now = new Date(now.getTime() + 3 * MINUTE);
      await sweep.tick();

      expect(await turnRow(third.id)).toMatchObject({ state: 'abandoned', attempts: 3 });
      expect(await prisma.serviceToken.count({ where: { owningTurnId: third.id } })).toBe(0);
      expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'runner_lost' });
      await claim().expect(204);
    });

    it('an archive the lost attempt uploaded is deleted; the run keeps its previous one', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      await api()
        .put(`${runnerBase()}/turns/${turn.id}/archive`)
        .set('Authorization', `Bearer ${runnerToken}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('lost attempt'))
        .expect(200);
      const uploaded = (await turnRow(turn.id)).stateArchiveKey!;
      expect(archives.objects.has(uploaded)).toBe(true);

      now = new Date(now.getTime() + 3 * MINUTE);
      await sweep.tick();
      expect(archives.objects.has(uploaded)).toBe(false);
      expect((await turnRow(turn.id)).stateArchiveKey).toBeNull();
      expect((await claimTurn()).body.hasStateArchive).toBe(false);
      expect((await detail(run.id)).status).toBe('scoping');
    });
  });
});
