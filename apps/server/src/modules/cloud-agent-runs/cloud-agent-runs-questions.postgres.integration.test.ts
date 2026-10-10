import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type ProposeScopeRequest,
  type ReportQuestionRequest,
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL_VERSION,
} from '@coredoc/core/agent-runner';
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

const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const OUTSIDER = { id: `${RUN}-outsider`, email: 'outsider@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const COLOUR = 'Which colour should the export button use?';
const FORMATS = 'Which formats should the export offer?';

const question = (toolUseId = 'toolu_ask_1'): ReportQuestionRequest => ({
  toolUseId,
  questions: [
    {
      question: COLOUR,
      header: 'Colour',
      options: [
        { label: 'Red', description: 'Matches the alerts' },
        { label: 'Blue', description: 'Matches the brand', preview: '<button class="blue">Export</button>' },
      ],
      multiSelect: false,
    },
    {
      question: FORMATS,
      header: 'Formats',
      options: [
        { label: 'CSV', description: 'Spreadsheets' },
        { label: 'JSON', description: 'Integrations' },
        { label: 'XLSX', description: 'Excel' },
      ],
      multiSelect: true,
    },
  ],
});

const proposal = (overrides: Partial<ProposeScopeRequest> = {}): ProposeScopeRequest => ({
  title: 'Order exports',
  summary: 'Adds CSV exports to the orders service.',
  specMarkdown: '# Spec\n\nExport orders as CSV.',
  repositories: [{ key: 'orders-api', reason: 'Owns the order records', changes: 'New export endpoint' }],
  ...overrides,
});

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: questions and policies (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let sweep: CloudAgentRunSweep;
  let workspaceId: string;
  let otherWorkspaceId: string;
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
      data: { name: `carq-${RUN}`, slug: `carq-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    const other = await prisma.workspace.create({ data: { name: `carq-other-${RUN}`, slug: `carq-other-${RUN}` } });
    otherWorkspaceId = other.id;
    await prisma.workspaceMember.create({
      data: { workspaceId: otherWorkspaceId, userId: OUTSIDER.id, email: OUTSIDER.email, role: 'admin' },
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

    const users = new Map([ADMIN, MEMBER, OUTSIDER].map((user) => [user.id, user]));
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

    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');

    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50, waitingLimitSeconds: 7 * 86_400 })
      .expect(200);
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: 'questions-runner', scope: 'agent-runner' })
      .expect(201);
    runnerToken = minted.body.token as string;
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

  beforeEach(async () => {
    // Every scenario starts with nothing claimable and nothing waiting.
    await prisma.cloudAgentRun.updateMany({
      where: { workspaceId, status: { notIn: ['done', 'failed', 'cancelled'] } },
      data: { status: 'cancelled' },
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

  async function startRun(body: Record<string, unknown> = {}) {
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
      .send({ issueKey: issue.key, ...body })
      .expect(201);
    return res.body as { id: string };
  }

  async function claimTurn() {
    const res = await api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS })
      .expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, body: res.body };
  }

  function turnCall(turn: { id: string; lease: string }, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);
  }

  const complete = (turn: { id: string; lease: string }, extra: Record<string, unknown> = {}) =>
    turnCall(turn, 'complete', {
      outcome: { kind: 'ended' },
      spend: { costUsd: 0.5, sdkTurns: 4 },
      versions: VERSIONS,
      ...extra,
    });

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const answer = (runId: string, requestId: string, answers: unknown, user = MEMBER) =>
    api()
      .post(`${runsBase()}/${runId}/questions/${requestId}/answer`)
      .set('Authorization', human(user))
      .send({ answers });

  const goodAnswers = [{ labels: ['Blue'] }, { labels: ['CSV', 'JSON'], other: 'Parquet' }];

  const pendingTurns = (runId: string) =>
    prisma.cloudAgentRunTurn.findMany({ where: { runId, state: { in: ['queued', 'claimed'] } } });

  describe('pause policy', () => {
    it('parks the question, ends the turn as paused, and an answer resumes the same session once', async () => {
      const run = await startRun();
      const first = await claimTurn();

      const reported = await turnCall(first, 'questions', question()).expect(200);
      expect(reported.body).toEqual({ state: 'open', requestId: expect.any(String), stop: false });
      const parked = await detail(run.id);
      expect(parked).toMatchObject({
        status: 'awaiting_answer',
        openQuestion: {
          requestId: reported.body.requestId,
          kind: 'clarification',
          phase: 'scope',
          questions: question().questions,
        },
      });

      await complete(first).expect(200);
      expect(await detail(run.id)).toMatchObject({ status: 'awaiting_answer', currentTurn: null });
      expect((await prisma.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: first.id } })).outcome).toBe(
        'question_asked',
      );

      await answer(run.id, reported.body.requestId, goodAnswers).expect(200);
      const resumed = await detail(run.id);
      expect(resumed).toMatchObject({ status: 'scoping', openQuestion: null, currentTurn: { state: 'queued' } });
      expect(resumed.questions).toEqual([
        expect.objectContaining({
          state: 'answered',
          answeredBy: MEMBER.id,
          answers: goodAnswers,
          askedInTurnId: first.id,
        }),
      ]);

      const second = await claimTurn();
      expect(second.body.run.sessionId).toBe(first.body.run.sessionId);
      expect(second.body.answer).toEqual({
        requestId: reported.body.requestId,
        toolUseId: 'toolu_ask_1',
        answers: { [COLOUR]: 'Blue', [FORMATS]: 'CSV, JSON, Parquet' },
      });
      expect(second.body.turn.inputText).toContain('Blue');

      const again = await answer(run.id, reported.body.requestId, goodAnswers).expect(409);
      expect(again.body.code).toBe('QUESTION_ALREADY_ANSWERED');
      expect(await pendingTurns(run.id)).toHaveLength(1);
    });

    it('an answer that arrives while the turn is completing queues exactly one resume turn at completion', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);

      await answer(run.id, reported.body.requestId, goodAnswers).expect(200);
      expect((await pendingTurns(run.id)).map((t) => t.id)).toEqual([turn.id]);

      await complete(turn).expect(200);
      const pending = await pendingTurns(run.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ state: 'queued', kind: 'scope' });
      const resumed = await claimTurn();
      expect(resumed.body.answer).toMatchObject({ requestId: reported.body.requestId });
    });

    it('two concurrent answers: one wins, the other is refused, and one resume turn is queued', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);
      await complete(turn).expect(200);

      const results = await Promise.all([
        answer(run.id, reported.body.requestId, goodAnswers),
        answer(run.id, reported.body.requestId, [{ labels: ['Red'] }, { labels: ['XLSX'] }]),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await pendingTurns(run.id)).toHaveLength(1);
    });

    it.each([
      ['an unknown option', [{ labels: ['Green'] }, { labels: ['CSV'] }]],
      ['two options on a single-choice question', [{ labels: ['Red', 'Blue'] }, { labels: ['CSV'] }]],
      ['an unanswered question', [{ labels: ['Red'] }, { labels: [] }]],
      ['too few answers', [{ labels: ['Red'] }]],
    ])('refuses %s and leaves the question open', async (_name, answers) => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);

      await answer(run.id, reported.body.requestId, answers).expect(400);
      expect((await detail(run.id)).openQuestion).toMatchObject({ requestId: reported.body.requestId });
    });

    it('a free-text "Other" answer alone answers a single-choice question', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);
      await complete(turn).expect(200);

      await answer(run.id, reported.body.requestId, [{ labels: [], other: 'Brand green' }, { labels: ['CSV'] }]).expect(
        200,
      );
      expect((await claimTurn()).body.answer.answers).toEqual({ [COLOUR]: 'Brand green', [FORMATS]: 'CSV' });
    });

    it('a lease that expires after the turn parked a question completes the turn as paused', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);

      now = new Date(now.getTime() + 10 * 60_000);
      await sweep.tick();

      const row = await prisma.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id } });
      expect(row).toMatchObject({ state: 'completed', outcome: 'question_asked', attempts: 1 });
      expect(await prisma.serviceToken.count({ where: { owningTurnId: turn.id } })).toBe(0);
      expect(await detail(run.id)).toMatchObject({ status: 'awaiting_answer', currentTurn: null });

      await answer(run.id, reported.body.requestId, goodAnswers).expect(200);
      expect(await pendingTurns(run.id)).toEqual([expect.objectContaining({ state: 'queued' })]);
    });

    it('a member of another workspace cannot answer through it', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);

      const foreign = await api()
        .post(
          `/api/v1/workspaces/${otherWorkspaceId}/cloud-agent-runs/${run.id}/questions/${reported.body.requestId}/answer`,
        )
        .set('Authorization', human(OUTSIDER))
        .send({ answers: goodAnswers })
        .expect(404);
      expect(foreign.body.code).toBe('RUN_NOT_FOUND');
      expect((await detail(run.id)).status).toBe('awaiting_answer');
    });
  });

  describe('assume policy', () => {
    it('answers at once, keeps the run going and records the assumptions the proposal lists', async () => {
      const run = await startRun({ questionsPolicy: 'assume' });
      const turn = await claimTurn();

      const reported = await turnCall(turn, 'questions', question()).expect(200);
      expect(reported.body).toMatchObject({ state: 'auto_answered', requestId: expect.any(String) });
      expect(reported.body.answers[COLOUR]).toMatch(/No one is available to answer/);
      expect(reported.body.answers[FORMATS]).toMatch(/assumptions/);

      const during = await detail(run.id);
      expect(during).toMatchObject({ status: 'scoping', openQuestion: null });
      expect(during.questions).toEqual([expect.objectContaining({ state: 'auto_answered', answeredBy: null })]);

      await turnCall(turn, 'propose-scope', proposal({ assumptions: ['The button is blue'] })).expect(200);
      await complete(turn).expect(200);
      expect(await detail(run.id)).toMatchObject({
        status: 'awaiting_scope_acceptance',
        assumptions: [{ phase: 'scope', text: 'The button is blue' }],
      });
    });
  });

  describe('outcome-less turns', () => {
    it('get one nudge under pause, and a second in a row fails the run with the agent’s last message', async () => {
      const run = await startRun();
      const first = await claimTurn();
      await complete(first, { lastMessage: 'Reading the PRD.' }).expect(200);

      const nudged = await claimTurn();
      expect(nudged.body.run.sessionId).toBe(first.body.run.sessionId);
      expect(nudged.body.turn.inputText).toMatch(/propose_scope/);
      expect(nudged.body.turn.inputText).toMatch(/AskUserQuestion/);

      await complete(nudged, { lastMessage: 'I am not sure which service owns exports.' }).expect(200);
      expect(await detail(run.id)).toMatchObject({
        status: 'failed',
        failureCode: 'no_outcome',
        failureReason: 'I am not sure which service owns exports.',
        currentTurn: null,
      });
    });

    it('are nudged to finish on stated assumptions under assume', async () => {
      await startRun({ questionsPolicy: 'assume' });
      await complete(await claimTurn()).expect(200);
      expect((await claimTurn()).body.turn.inputText).toMatch(/assumptions/);
    });

    it('a question between two outcome-less turns resets the count', async () => {
      const run = await startRun();
      await complete(await claimTurn()).expect(200);

      const asking = await claimTurn();
      const reported = await turnCall(asking, 'questions', question()).expect(200);
      await complete(asking).expect(200);
      await answer(run.id, reported.body.requestId, goodAnswers).expect(200);

      await complete(await claimTurn()).expect(200);
      expect(await detail(run.id)).toMatchObject({ status: 'scoping', currentTurn: { state: 'queued' } });
    });
  });

  describe('waiting limit', () => {
    it('fails a run forgotten in awaiting_answer with waiting_expired; elapsed time never answers', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const reported = await turnCall(turn, 'questions', question()).expect(200);
      await complete(turn).expect(200);

      now = new Date(now.getTime() + 7 * DAY - HOUR);
      await sweep.tick();
      expect((await detail(run.id)).status).toBe('awaiting_answer');

      now = new Date(now.getTime() + 2 * HOUR);
      await sweep.tick();
      const failed = await detail(run.id);
      expect(failed).toMatchObject({ status: 'failed', failureCode: 'waiting_expired', openQuestion: null });
      expect(failed.questions).toEqual([expect.objectContaining({ state: 'cancelled', answers: null })]);
      expect(await pendingTurns(run.id)).toEqual([]);

      const late = await answer(run.id, reported.body.requestId, goodAnswers).expect(409);
      expect(late.body.code).toBe('RUN_TERMINAL');
    });

    it('fails a run whose scope waits for review longer than the limit', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      await turnCall(turn, 'propose-scope', proposal()).expect(200);
      await complete(turn).expect(200);
      expect((await detail(run.id)).status).toBe('awaiting_scope_acceptance');

      now = new Date(now.getTime() + 7 * DAY + HOUR);
      await sweep.tick();
      expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'waiting_expired' });
    });
  });
});
