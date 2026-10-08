import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeliveryReport,
  type ProposeScopeRequest,
  type RepositoryReport,
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
import { GITHUB_CLIENT_FACTORY } from '../delivery/github-importer.service.js';
import { JiraApiError, JiraNotFoundError } from '../delivery/jira-client.js';
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunSweep } from './cloud-agent-run-sweep.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import {
  CLOUD_AGENT_RUNS_CLOCK,
  CLOUD_AGENT_RUNS_RETRY_DELAY,
  cloudAgentRunsCoreProviders,
} from './cloud-agent-runs.module.js';
import {
  DONE_STATUS,
  FakeGithubPulls,
  FakeJira,
  InMemoryArchiveStore,
  paragraphDoc,
} from './cloud-agent-runs.test-support.js';
import { commentHasMarker, runMarker } from './jira-comments.js';

/**
 * Delivery driven through the runner API and the run sweep on real
 * PostgreSQL with real guards: draft pull requests verified with the strict
 * pull read, then the Jira done comment and transition, or the failure
 * comment. Jira and GitHub are stateful fakes behind the client factories.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };
const HEAD = 'a'.repeat(40);
const NB = '‑';

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

const pushed = (key: string): RepositoryReport => ({
  key,
  pushedHead: HEAD,
  withheldPaths: [],
  workflowDiff: null,
  binaryPaths: [],
});

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: delivery (PostgreSQL integration)', () => {
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
  const github = new FakeGithubPulls();
  const archives = new InMemoryArchiveStore();
  let now = new Date('2026-10-10T09:00:00.000Z');
  const later = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `card-${RUN}`, slug: `card-${RUN}`, deliveryEnabled: true },
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
      data: ['orders-api', 'billing-api'].map((key) => ({
        workspaceId,
        repoKey: graphRepoHashOf(key),
        repoName: key,
        intentRepoKey: key,
        normalizedGitRemote: `github.com/example-org/${key}`,
      })),
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
        { provide: CLOUD_AGENT_RUNS_RETRY_DELAY, useValue: () => 0 },
        { provide: JIRA_CLIENT_FACTORY, useValue: () => jira.client() },
        { provide: GITHUB_CLIENT_FACTORY, useValue: () => github.client() },
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
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');
    sweep = moduleRef.get(CloudAgentRunSweep);

    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50, doneStatus: DONE_STATUS })
      .expect(200);
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: 'delivery-runner', scope: 'agent-runner' })
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
    await prisma.cloudAgentRunTurn.updateMany({
      where: { workspaceId, state: { in: ['queued', 'claimed'] } },
      data: { state: 'abandoned' },
    });
    // Runs of earlier scenarios are settled, so a tick acts only on this one's.
    await prisma.cloudAgentRun.updateMany({
      where: { workspaceId, status: { notIn: ['done', 'failed', 'cancelled'] } },
      data: { status: 'cancelled' },
    });
    await sweep.tick();
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

  const complete = (
    turn: Turn,
    body: { outcome?: unknown; repositories?: RepositoryReport[]; deliveries?: DeliveryReport[] } = {},
  ) =>
    turnCall(turn, 'complete', {
      outcome: body.outcome ?? { kind: 'ended' },
      spend: body.deliveries ? null : { costUsd: 0.5, sdkTurns: 4 },
      versions: VERSIONS,
      repositories: body.repositories ?? [],
      deliveries: body.deliveries ?? [],
    });

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const events = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}/events?after=0&limit=200`).set('Authorization', human(MEMBER)).expect(200))
      .body.events as Array<{ type: string; payload: Response['body'] }>;

  const opened = (key: string, number: number, created = true): DeliveryReport => ({
    key,
    pullRequest: { number, created },
  });

  /** Both repositories pushed and `submit_result` accepted; the delivery turn is claimed. */
  async function delivering() {
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
      .send({ issueKey: issue.key, repositoryKeys: ['orders-api'] })
      .expect(201);
    const runId = started.body.id as string;
    const scope = await claimTurn();
    await turnCall(scope, 'propose-scope', proposal).expect(200);
    await complete(scope).expect(200);
    await api().post(`${runsBase()}/${runId}/specs/1/accept`).set('Authorization', human(MEMBER)).expect(200);
    const implement = await claimTurn();
    await turnCall(implement, 'submit-result', {
      summary: 'Added the orders export.',
      repositories: [
        { key: 'orders-api', summary: 'Export endpoint, as OPS-9 asked ![shot](https://x.example/s.png)' },
        { key: 'billing-api', summary: 'Invoice columns' },
      ],
      assumptions: ['CSV only'],
      notBuiltOrTested: [{ key: 'billing-api', reason: 'Its tests need Docker compose' }],
    }).expect(200);
    for (const key of ['orders-api', 'billing-api']) {
      await turnCall(implement, 'branches', { repository: key }).expect(200);
    }
    await complete(implement, { repositories: [pushed('orders-api'), pushed('billing-api')] }).expect(200);
    const turn = await claimTurn();
    const branch = turn.body.run.branch as string;
    return { runId, issue, branch, turn };
  }

  /** Pull requests on the run branch in both repositories, as GitHub holds them. */
  function openPulls(branch: string, base = issueSeed * 10) {
    github.add('example-org/billing-api', { number: base + 1, headRepo: 'example-org/billing-api', headRef: branch });
    github.add('example-org/orders-api', { number: base + 2, headRepo: 'example-org/orders-api', headRef: branch });
    return [opened('billing-api', base + 1), opened('orders-api', base + 2)];
  }

  it('a delivery turn carries one pull request per touched repository, in merge order, with assembled bodies', async () => {
    const { runId, issue, turn } = await delivering();
    expect(turn.body.turn.kind).toBe('delivery');
    expect(turn.body.mcp).toBeNull();
    expect(turn.body.repositories.map((r: { key: string }) => r.key)).toEqual(['billing-api', 'orders-api']);
    const pulls = turn.body.delivery.pullRequests as Array<{ key: string; title: string; body: string }>;
    expect(pulls.map((pull) => pull.key)).toEqual(['billing-api', 'orders-api']);
    expect(pulls[0]!.title).toBe(`${issue.key}: Order exports`);
    expect(pulls[0]!.body).toMatch(/Not built or tested in the runner\n\nIts tests need Docker compose/);
    expect(pulls[1]!.body).toContain(`OPS${NB}9`);
    expect(pulls[1]!.body).not.toMatch(/OPS-9/);
    expect(pulls[1]!.body).toContain('\\![shot]');
    expect(pulls[1]!.body).toContain('- CSV only');
    expect(pulls[1]!.body).toContain(`/agent-runs/${runId}`);
    expect(pulls[1]!.body).not.toContain('Export orders as CSV');
  });

  it('verified pull requests are recorded; the sweep posts one done comment and one transition, then the run is done', async () => {
    const { runId, issue, branch, turn } = await delivering();
    const reports = openPulls(branch);
    github.transientFailures = 2;
    await complete(turn, { deliveries: reports }).expect(200);

    const delivered = await detail(runId);
    expect(delivered.status).toBe('delivering');
    expect(delivered.pullRequests).toEqual([
      expect.objectContaining({
        repository: 'billing-api',
        number: reports[0]!.pullRequest!.number,
        url: `https://github.com/example-org/billing-api/pull/${reports[0]!.pullRequest!.number}`,
        state: 'open',
        draft: true,
        verifiedAt: now.toISOString(),
      }),
      expect.objectContaining({ repository: 'orders-api', number: reports[1]!.pullRequest!.number }),
    ]);

    await sweep.tick();
    await sweep.tick();
    const done = await detail(runId);
    expect(done.status).toBe('done');
    expect(done.jiraOutcome).toMatchObject({ done: { state: 'posted' }, transition: { outcome: 'transitioned' } });
    const comments = jira.commentsOn(issue.key);
    expect(comments).toHaveLength(1);
    expect(commentHasMarker(comments[0]!.body, runMarker(runId, 'done'))).toBe(true);
    const text = JSON.stringify(comments[0]!.body);
    expect(text).toContain(`https://github.com/example-org/orders-api/pull/${reports[1]!.pullRequest!.number}`);
    expect(text).not.toMatch(/Export endpoint|CSV only|Docker/);
    // The transition without a screen is preferred.
    expect(jira.applied.filter((entry) => entry.startsWith(`${issue.id}:`))).toEqual([`${issue.id}:31`]);
    const timeline = await events(runId);
    expect(timeline.map((event) => event.payload.code).filter(Boolean)).toEqual(
      expect.arrayContaining(['pull_request_opened', 'jira_commented']),
    );
  });

  it('a crash after the done comment is recovered without a second comment or transition', async () => {
    const { runId, issue, branch, turn } = await delivering();
    await complete(turn, { deliveries: openPulls(branch) }).expect(200);
    jira.crashAfterNextComment = true;
    await sweep.tick();
    expect((await detail(runId)).status).toBe('delivering');
    expect(jira.commentsOn(issue.key)).toHaveLength(1);

    await sweep.tick();
    expect((await detail(runId)).status).toBe('delivering');
    later(5);
    await sweep.tick();
    expect(await detail(runId)).toMatchObject({ status: 'done', jiraOutcome: { done: { state: 'posted' } } });
    expect(jira.commentsOn(issue.key)).toHaveLength(1);
    expect(jira.applied.filter((entry) => entry.startsWith(`${issue.id}:`))).toHaveLength(1);
  });

  it('an issue already in the done status is not transitioned again', async () => {
    const { runId, issue, branch, turn } = await delivering();
    await complete(turn, { deliveries: openPulls(branch) }).expect(200);
    jira.issues.get(issue.key)!.statusId = DONE_STATUS.id;
    await sweep.tick();
    expect(await detail(runId)).toMatchObject({
      status: 'done',
      jiraOutcome: { transition: { outcome: 'already_in_status' } },
    });
    expect(jira.applied.filter((entry) => entry.startsWith(`${issue.id}:`))).toEqual([]);
  });

  it.each([
    ['a 400', new JiraNotFoundError('Jira API 400 for /transitions')],
    ['a 409', new JiraApiError(409, '/transitions')],
  ])('a transition answering %s still ends done, with a warning', async (_name, error) => {
    const { runId, branch, turn } = await delivering();
    await complete(turn, { deliveries: openPulls(branch) }).expect(200);
    jira.transitionError = error;
    await sweep.tick();
    const run = await detail(runId);
    expect(run).toMatchObject({ status: 'done', jiraOutcome: { transition: { outcome: 'warning' } } });
    expect((await events(runId)).some((event) => event.payload.code === 'warning')).toBe(true);
  });

  it('an issue moved out of the configured projects gets no comment and no transition', async () => {
    const { runId, issue, branch, turn } = await delivering();
    await complete(turn, { deliveries: openPulls(branch) }).expect(200);
    jira.issues.get(issue.key)!.project = 'OTHER';
    await sweep.tick();
    expect(await detail(runId)).toMatchObject({
      status: 'done',
      jiraOutcome: { done: { state: 'skipped' }, transition: { outcome: 'skipped' } },
    });
    expect(jira.commentsOn(issue.key)).toEqual([]);
    expect(jira.applied.filter((entry) => entry.startsWith(`${issue.id}:`))).toEqual([]);
  });

  it.each([
    ['a fork head', (branch: string) => ({ headRepo: 'someone-else/orders-api', headRef: branch })],
    ['a deleted head repository', (branch: string) => ({ headRepo: null, headRef: branch })],
    ['another head branch', () => ({ headRepo: 'example-org/orders-api', headRef: 'feature/elsewhere' })],
  ])('%s fails the run with delivery_failed; the failure comment lists the verified pull request', async (_name, head) => {
    const { runId, issue, branch, turn } = await delivering();
    const number = issueSeed * 10;
    github.add('example-org/billing-api', { number: number + 1, headRepo: 'example-org/billing-api', headRef: branch });
    github.add('example-org/orders-api', { number: number + 2, ...head(branch) });
    await complete(turn, { deliveries: [opened('billing-api', number + 1), opened('orders-api', number + 2)] }).expect(
      200,
    );

    const failed = await detail(runId);
    expect(failed).toMatchObject({ status: 'failed', failureCode: 'delivery_failed' });
    expect(failed.pullRequests.map((pull: { repository: string }) => pull.repository)).toEqual(['billing-api']);

    await sweep.tick();
    const comments = jira.commentsOn(issue.key);
    expect(comments).toHaveLength(1);
    const text = JSON.stringify(comments[0]!.body);
    expect(text).toContain('Opening or verifying the pull requests, or posting the Jira done comment, failed.');
    expect(text).toContain(`https://github.com/example-org/billing-api/pull/${number + 1}`);
    expect(text).not.toContain(`/pull/${number + 2}`);
    expect(await detail(runId)).toMatchObject({ jiraOutcome: { failure: { state: 'posted' } } });
  });

  it('a pull request GitHub cannot find fails the run with delivery_failed', async () => {
    const { runId, turn } = await delivering();
    await complete(turn, { deliveries: [opened('billing-api', 999_001), opened('orders-api', 999_002)] }).expect(200);
    expect(await detail(runId)).toMatchObject({ status: 'failed', failureCode: 'delivery_failed', pullRequests: [] });
  });

  it('a touched repository with no reported pull request fails the run; one GitHub found unchanged does not', async () => {
    const missing = await delivering();
    const [billing] = openPulls(missing.branch);
    await complete(missing.turn, { deliveries: [billing!] }).expect(200);
    expect(await detail(missing.runId)).toMatchObject({ status: 'failed', failureCode: 'delivery_failed' });

    const unchanged = await delivering();
    const [billing2] = openPulls(unchanged.branch);
    await complete(unchanged.turn, { deliveries: [billing2!, { key: 'orders-api', pullRequest: null }] }).expect(200);
    expect(await detail(unchanged.runId)).toMatchObject({ status: 'delivering' });
  });

  it('two concurrent sweep ticks post one failure comment, and a crash after posting is recovered by the marker', async () => {
    const first = await delivering();
    await complete(first.turn, { outcome: { kind: 'failed', code: 'delivery_failed', reason: 'GitHub refused.' } }).expect(
      200,
    );
    await Promise.all([sweep.tick(), sweep.tick()]);
    expect(jira.commentsOn(first.issue.key)).toHaveLength(1);
    await sweep.tick();
    expect(jira.commentsOn(first.issue.key)).toHaveLength(1);

    const second = await delivering();
    await complete(second.turn, { outcome: { kind: 'failed', code: 'delivery_failed', reason: 'GitHub refused.' } }).expect(
      200,
    );
    jira.crashAfterNextComment = true;
    await sweep.tick();
    expect(jira.commentsOn(second.issue.key)).toHaveLength(1);
    later(5);
    await sweep.tick();
    const comments = jira.commentsOn(second.issue.key);
    expect(comments).toHaveLength(1);
    expect(await detail(second.runId)).toMatchObject({
      jiraOutcome: { failure: { state: 'posted', commentId: comments[0]!.id } },
    });
    // The agent's reason stays on the run page.
    expect(JSON.stringify(comments[0]!.body)).not.toContain('GitHub refused.');
  });

  it('a permanent Jira error, or five failed attempts, records the failure comment as not posted', async () => {
    const permanent = await delivering();
    await complete(permanent.turn, { outcome: { kind: 'failed', code: 'delivery_failed', reason: 'x' } }).expect(200);
    jira.commentError = new JiraNotFoundError('Jira API 404 for /comment');
    try {
      await sweep.tick();
    } finally {
      jira.commentError = null;
    }
    expect(await detail(permanent.runId)).toMatchObject({
      jiraOutcome: { failure: { state: 'not_posted', attempts: 1 } },
    });

    const flaky = await delivering();
    await complete(flaky.turn, { outcome: { kind: 'failed', code: 'delivery_failed', reason: 'x' } }).expect(200);
    // Each attempt retries in process; every try answers 503.
    jira.commentError = new JiraApiError(503, '/comment');
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await sweep.tick();
        expect((await detail(flaky.runId)).jiraOutcome.failure.attempts).toBe(attempt);
        later(5);
      }
    } finally {
      jira.commentError = null;
    }
    expect(await detail(flaky.runId)).toMatchObject({
      jiraOutcome: { failure: { state: 'not_posted', attempts: 5 } },
    });
    await sweep.tick();
    expect(jira.commentsOn(flaky.issue.key)).toEqual([]);
  });

  it('a cancel during delivery records the pull requests already opened and posts no Jira comment', async () => {
    const { runId, issue, branch, turn } = await delivering();
    const [billing] = openPulls(branch);
    // A member cancels while the turn runs: the run is terminal and its turn abandoned.
    await prisma.$transaction([
      prisma.cloudAgentRun.update({ where: { id: runId }, data: { status: 'cancelled' } }),
      prisma.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { state: 'abandoned' } }),
    ]);
    await complete(turn, { deliveries: [billing!] }).expect(200);

    const run = await detail(runId);
    expect(run.status).toBe('cancelled');
    expect(run.pullRequests).toEqual([expect.objectContaining({ repository: 'billing-api' })]);
    await sweep.tick();
    expect(jira.commentsOn(issue.key)).toEqual([]);
  });
});
