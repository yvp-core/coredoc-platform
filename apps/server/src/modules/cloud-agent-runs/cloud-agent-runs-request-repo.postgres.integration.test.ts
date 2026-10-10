import '../../config/load-env.js';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_STATE_ARCHIVE_BYTES,
  type ProposeScopeRequest,
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL_VERSION,
} from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { STORAGE_CONFIG, configFromEnv } from '../../config/app-config.js';
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
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { CLOUD_AGENT_RUNS_CLOCK, cloudAgentRunsCoreProviders } from './cloud-agent-runs.module.js';
import { FakeJira, InMemoryArchiveStore, paragraphDoc } from './cloud-agent-runs.test-support.js';

const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };

const proposal: ProposeScopeRequest = {
  title: 'Order exports',
  summary: 'Adds CSV exports.',
  specMarkdown: '# Spec\n\nExport orders as CSV.\n',
  repositories: [
    { key: 'orders-api', reason: 'Owns the order records', changes: 'New export endpoint' },
    { key: 'billing-api', reason: 'Owns invoices', changes: 'Invoice columns' },
  ],
  mergeOrder: ['billing-api', 'orders-api'],
};

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: request_repo (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let runnerToken: string;
  let issueSeed = 0;
  const jira = new FakeJira();
  const archives = new InMemoryArchiveStore();
  const now = new Date('2026-10-10T09:00:00.000Z');

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `carr-${RUN}`, slug: `carr-${RUN}`, deliveryEnabled: true },
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
    await prisma.workspaceRepo.createMany({
      data: ['orders-api', 'billing-api', 'search-api', 'ledger-api'].map((key) => ({
        workspaceId,
        repoKey: graphRepoHashOf(key),
        repoName: key,
        intentRepoKey: key,
        normalizedGitRemote: `github.com/example-org/${key}`,
      })),
    });
    // Registered without a remote: not eligible for agent runs.
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphRepoHashOf('legacy-app'),
        repoName: 'legacy-app',
        intentRepoKey: 'legacy-app',
      },
    });

    const users = new Map([ADMIN, MEMBER].map((user) => [user.id, user]));
    const storage = configFromEnv().storage;
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

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    (app as NestExpressApplication).useBodyParser('raw', {
      limit: MAX_STATE_ARCHIVE_BYTES + 1024 * 1024,
      type: 'application/octet-stream',
    });
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');

    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50 })
      .expect(200);
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: 'request-repo-runner', scope: 'agent-runner' })
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
    await prisma.cloudAgentRunTurn.updateMany({
      where: { workspaceId, state: { in: ['queued', 'claimed'] } },
      data: { state: 'abandoned' },
    });
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = () => `/api/v1/workspaces/${workspaceId}/cloud-agent-runs`;
  const runnerBase = () => `/api/v1/workspaces/${workspaceId}/agent-runner`;

  type Turn = { id: string; lease: string; body: Response['body'] };

  async function claimTurn(): Promise<Turn> {
    const res = await api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS })
      .expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, body: res.body };
  }

  function turnCall(turn: Turn, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);
  }

  const complete = (turn: Turn, outcome: unknown = { kind: 'ended' }) =>
    turnCall(turn, 'complete', { outcome, spend: { costUsd: 0.5, sdkTurns: 4 }, versions: VERSIONS });

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const events = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}/events?after=0&limit=200`).set('Authorization', human(MEMBER)).expect(200))
      .body.events as Array<{ type: string; payload: Response['body'] }>;

  const answer = (runId: string, requestId: string, answers: unknown) =>
    api()
      .post(`${runsBase()}/${runId}/questions/${requestId}/answer`)
      .set('Authorization', human(MEMBER))
      .send({ answers });

  /** A run whose scope was accepted under the given policies, and its first implement turn claimed. */
  async function implementing(policies: { scopeAcceptancePolicy: string; questionsPolicy?: string }) {
    issueSeed += 1;
    const issue = jira.add({
      key: `PROJ-${issueSeed}`,
      summary: `Export orders ${issueSeed}`,
      project: 'PROJ',
      description: paragraphDoc('Customers need order exports.'),
    });
    const started = await api()
      .post(runsBase())
      .set('Authorization', human(MEMBER))
      .send({ issueKey: issue.key, questionsPolicy: 'pause', ...policies })
      .expect(201);
    const runId = started.body.id as string;
    const scope = await claimTurn();
    await turnCall(scope, 'propose-scope', proposal).expect(200);
    await complete(scope).expect(200);
    if (policies.scopeAcceptancePolicy === 'required') {
      await api().post(`${runsBase()}/${runId}/specs/1/accept`).set('Authorization', human(MEMBER)).expect(200);
    }
    return { runId, turn: await claimTurn() };
  }

  describe('under automatic acceptance', () => {
    it('appends the repository mid-turn with its clone URL; repeating the request returns the same repository', async () => {
      const { runId, turn } = await implementing({ scopeAcceptancePolicy: 'automatic' });
      const added = await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Owns the search index' }).expect(
        200,
      );
      const expected = {
        key: 'search-api',
        reason: 'Owns the search index',
        mergeOrder: 2,
        cloneUrl: 'https://github.com/example-org/search-api.git',
        github: { apiBaseUrl: 'https://api.github.com', owner: 'example-org', name: 'search-api' },
        branchCreated: false,
        withheldPaths: [],
      };
      expect(added.body).toEqual({ state: 'added', repository: expected, stop: false });

      const run = await detail(runId);
      expect(run).toMatchObject({ status: 'implementing', currentTurn: { state: 'claimed' } });
      expect(run.repositories).toContainEqual(
        expect.objectContaining({ key: 'search-api', origin: 'request', reason: 'Owns the search index' }),
      );
      expect(await events(runId)).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'repository_added', repository: 'search-api' }),
        }),
      );

      const repeated = await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Asked again' }).expect(200);
      expect(repeated.body).toEqual({ state: 'added', repository: expected, stop: false });
      expect((await detail(runId)).repositories.filter((r: { key: string }) => r.key === 'search-api')).toHaveLength(1);

      // The next turn clones it with the others.
      await complete(turn, { kind: 'checkpoint' }).expect(200);
      const next = await claimTurn();
      expect(next.body.repositories.map((r: { key: string }) => r.key)).toEqual([
        'billing-api',
        'orders-api',
        'search-api',
      ]);
    });

    it('refuses an unknown or ineligible repository and one over the cap, as tool errors that record nothing', async () => {
      const { runId, turn } = await implementing({ scopeAcceptancePolicy: 'automatic' });
      const unknown = await turnCall(turn, 'request-repo', { key: 'nope-api', reason: 'Guessing' }).expect(200);
      expect(unknown.body).toMatchObject({ state: 'rejected', stop: false });
      expect(unknown.body.errors.join('\n')).toMatch(/"nope-api" is not a repository key of this workspace/);

      const ineligible = await turnCall(turn, 'request-repo', { key: 'legacy-app', reason: 'Old code' }).expect(200);
      expect(ineligible.body.errors.join('\n')).toMatch(/"legacy-app" is not eligible for agent runs/);

      await prisma.cloudAgentRun.update({ where: { id: runId }, data: { maxRepositories: 3 } });
      await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Owns the search index' }).expect(200);
      const capped = await turnCall(turn, 'request-repo', { key: 'ledger-api', reason: 'Owns the ledger' }).expect(200);
      expect(capped.body.state).toBe('rejected');
      expect(capped.body.errors.join('\n')).toMatch(/at most 3 repositories/);

      expect((await detail(runId)).repositories.map((r: { key: string }) => r.key)).toEqual([
        'billing-api',
        'orders-api',
        'search-api',
      ]);
    });

    it('is a tool error outside implement turns, and tells a stopped run to stop', async () => {
      issueSeed += 1;
      const issue = jira.add({ key: `PROJ-${issueSeed}`, summary: 'Scoping', project: 'PROJ' });
      const started = await api()
        .post(runsBase())
        .set('Authorization', human(MEMBER))
        .send({ issueKey: issue.key, scopeAcceptancePolicy: 'automatic' })
        .expect(201);
      const scope = await claimTurn();
      const scoping = await turnCall(scope, 'request-repo', { key: 'search-api', reason: 'Search' }).expect(200);
      expect(scoping.body).toEqual({
        state: 'rejected',
        errors: ['request_repo is available only while implementing.'],
        stop: false,
      });

      // The run ended while the turn ran (a limit, or a member cancelling).
      await prisma.cloudAgentRun.update({ where: { id: started.body.id }, data: { status: 'cancelled' } });
      const cancelled = await turnCall(scope, 'request-repo', { key: 'search-api', reason: 'Search' }).expect(200);
      expect(cancelled.body).toMatchObject({ state: 'rejected', stop: true });
    });
  });

  describe('under required acceptance', () => {
    /** The run parked on a repository request for search-api; questions are answered at once otherwise. */
    async function requested() {
      const { runId, turn } = await implementing({ scopeAcceptancePolicy: 'required', questionsPolicy: 'assume' });
      const asked = await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Owns the search index' }).expect(
        200,
      );
      expect(asked.body).toEqual({ state: 'requested', stop: false });
      // Nothing changes until the turn ends.
      expect(await detail(runId)).toMatchObject({ status: 'implementing', openQuestion: null });
      await complete(turn).expect(200);
      const run = await detail(runId);
      return { runId, turn, run, requestId: run.openQuestion?.requestId as string };
    }

    it('opens a repository-request question with fixed options when the turn ends, whatever the questions policy', async () => {
      const { runId, turn, run } = await requested();
      expect(run).toMatchObject({ status: 'awaiting_answer', currentTurn: null });
      expect(run.repositories.map((r: { key: string }) => r.key)).toEqual(['billing-api', 'orders-api']);
      expect(run.openQuestion).toMatchObject({
        kind: 'repository_request',
        phase: 'implement',
        state: 'open',
        questions: [
          {
            header: 'Repository',
            multiSelect: false,
            options: [
              { label: 'Add', description: expect.stringContaining('Owns the search index') },
              { label: "Don't add", description: expect.any(String) },
            ],
          },
        ],
      });
      expect(run.openQuestion.questions[0].question).toContain('search-api');
      const ended = await prisma.cloudAgentRunTurn.findUniqueOrThrow({ where: { id: turn.id } });
      expect(ended.outcome).toBe('repository_requested');
      expect((await events(runId)).map((event) => event.type)).toContain('question');
    });

    it('"Add" appends the repository and resumes the session, which clones it in the next turn', async () => {
      const { runId, turn, requestId } = await requested();
      await answer(runId, requestId, [{ labels: ['Add'] }]).expect(200);
      const run = await detail(runId);
      expect(run.status).toBe('implementing');
      expect(run.repositories).toContainEqual(
        expect.objectContaining({
          key: 'search-api',
          origin: 'request',
          reason: 'Owns the search index',
          mergeOrder: 2,
        }),
      );
      expect(await events(runId)).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'repository_added', repository: 'search-api' }),
        }),
      );

      const next = await claimTurn();
      expect(next.body.run.sessionId).toBe(turn.body.run.sessionId);
      expect(next.body.repositories.map((r: { key: string }) => r.key)).toEqual([
        'billing-api',
        'orders-api',
        'search-api',
      ]);
      expect(next.body.repositoryDecision).toEqual({ key: 'search-api', added: true });
      // Not an AskUserQuestion call: there is no deferred call to re-run.
      expect(next.body.answer).toBeNull();
      expect(next.body.turn.inputText).toMatch(/search-api/);
    });

    it('"Don\'t add" resumes with the decline; requesting the declined repository again is a tool error', async () => {
      const { runId, requestId } = await requested();
      await answer(runId, requestId, [{ labels: ["Don't add"] }]).expect(200);
      const run = await detail(runId);
      expect(run.status).toBe('implementing');
      expect(run.repositories.map((r: { key: string }) => r.key)).toEqual(['billing-api', 'orders-api']);
      expect(await events(runId)).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'repository_declined', repository: 'search-api' }),
        }),
      );

      const next = await claimTurn();
      expect(next.body.repositoryDecision).toEqual({ key: 'search-api', added: false });
      expect(next.body.turn.inputText).toBe(
        'Repository `search-api` was declined; continue without it or call submit_result noting the gap.',
      );
      const again = await turnCall(next, 'request-repo', { key: 'search-api', reason: 'Really needed' }).expect(200);
      expect(again.body.state).toBe('rejected');
      expect(again.body.errors.join('\n')).toMatch(/declined repository "search-api"/);
    });

    it('takes exactly one of the fixed options: no free text, no other label', async () => {
      const { runId, requestId } = await requested();
      await answer(runId, requestId, [{ labels: [], other: 'Add it, but read only' }]).expect(400);
      await answer(runId, requestId, [{ labels: ['Add'], other: 'and more' }]).expect(400);
      await answer(runId, requestId, [{ labels: ['Maybe'] }]).expect(400);
      expect(await detail(runId)).toMatchObject({ status: 'awaiting_answer', openQuestion: { state: 'open' } });
    });

    it('a second, different request in the same turn is refused; repeating the same one is not', async () => {
      const { turn } = await implementing({ scopeAcceptancePolicy: 'required' });
      await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Owns the search index' }).expect(200);
      const same = await turnCall(turn, 'request-repo', { key: 'search-api', reason: 'Owns the search index' });
      expect(same.body).toEqual({ state: 'requested', stop: false });
      const other = await turnCall(turn, 'request-repo', { key: 'ledger-api', reason: 'Owns the ledger' });
      expect(other.body.state).toBe('rejected');
      expect(other.body.errors.join('\n')).toMatch(/"search-api" is already waiting/);
    });
  });
});
