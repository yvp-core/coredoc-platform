import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_STATE_ARCHIVE_BYTES,
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
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { CLOUD_AGENT_RUNS_CLOCK, cloudAgentRunsCoreProviders } from './cloud-agent-runs.module.js';
import { FakeJira, InMemoryArchiveStore, paragraphDoc } from './cloud-agent-runs.test-support.js';

/**
 * The implement phase driven through the human API and the runner API on real
 * PostgreSQL with real guards. Jira and the archive store are in-memory fakes
 * at their ports; the runner is a scripted fake making runner API calls.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

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

const report = (key: string, overrides: Partial<RepositoryReport> = {}): RepositoryReport => ({
  key,
  pushedHead: null,
  withheldPaths: [],
  workflowDiff: null,
  binaryPaths: [],
  ...overrides,
});

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: implement phase (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let githubConnectorId: string;
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
      data: { name: `cari-${RUN}`, slug: `cari-${RUN}`, deliveryEnabled: true },
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
    const github = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'github',
        displayName: 'GitHub',
        credentialsEncrypted: encrypt('ghp_read_only'),
        config: { repos: [] },
      },
    });
    githubConnectorId = github.id;
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
      .send({ name: 'implement-runner', scope: 'agent-runner' })
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

  function claim() {
    return api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS });
  }

  async function claimTurn(): Promise<Turn> {
    const res = await claim().expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, body: res.body };
  }

  function turnCall(turn: Turn, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);
  }

  const complete = (turn: Turn, outcome: unknown = { kind: 'ended' }, repositories: RepositoryReport[] = []) =>
    turnCall(turn, 'complete', {
      outcome,
      spend: { costUsd: 0.5, sdkTurns: 4 },
      versions: VERSIONS,
      repositories,
    });

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const events = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}/events?after=0&limit=200`).set('Authorization', human(MEMBER)).expect(200))
      .body.events as Array<{ type: string; payload: Response['body']; truncated: boolean }>;

  /** A run whose scope (with a seed) was accepted, and its first implement turn claimed. */
  async function implementing() {
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
    return { runId, issueKey: issue.key, scope, turn: await claimTurn() };
  }

  it('a scope turn carries its seed repositories for the bot check; an implement turn carries clones, the branch and the accepted spec', async () => {
    issueSeed += 1;
    const issue = jira.add({ key: `PROJ-${issueSeed}`, summary: 'Seeded', project: 'PROJ' });
    await api()
      .post(runsBase())
      .set('Authorization', human(MEMBER))
      .send({ issueKey: issue.key, repositoryKeys: ['orders-api'] })
      .expect(201);
    const scope = await claimTurn();
    expect(scope.body.repositories).toEqual([
      expect.objectContaining({
        key: 'orders-api',
        cloneUrl: 'https://github.com/example-org/orders-api.git',
        github: { apiBaseUrl: 'https://api.github.com', owner: 'example-org', name: 'orders-api' },
      }),
    ]);
    await turnCall(scope, 'propose-scope', proposal).expect(200);
    await complete(scope).expect(200);
    const runId = (await prisma.cloudAgentRun.findFirstOrThrow({ where: { workspaceId, issueKey: issue.key } })).id;
    await api().post(`${runsBase()}/${runId}/specs/1/accept`).set('Authorization', human(MEMBER)).expect(200);

    const turn = await claimTurn();
    expect(turn.body.run.branch).toBe(`coredoc/${issue.key}`);
    expect(turn.body.repositories).toEqual([
      {
        key: 'billing-api',
        reason: 'Owns invoices',
        mergeOrder: 0,
        cloneUrl: 'https://github.com/example-org/billing-api.git',
        github: { apiBaseUrl: 'https://api.github.com', owner: 'example-org', name: 'billing-api' },
        branchCreated: false,
        withheldPaths: [],
      },
      expect.objectContaining({ key: 'orders-api', mergeOrder: 1, branchCreated: false }),
    ]);
    expect(turn.body.acceptedSpec).toEqual({
      version: 1,
      markdown: proposal.specMarkdown,
      acceptedBy: MEMBER.email,
      acceptedAt: now.toISOString(),
      digest: createHash('sha256').update(proposal.specMarkdown).digest('hex'),
    });

    // The per-turn MCP token reads and proposes intent as the run owner, and is not in the token list.
    const tokenRow = await prisma.serviceToken.findFirstOrThrow({ where: { owningTurnId: turn.id } });
    expect(tokenRow.permissions.sort()).toEqual(['intent:propose', 'intent:read']);
    const listed = await api().get(`/api/v1/workspaces/${workspaceId}/tokens`).set('Authorization', human(ADMIN));
    expect(JSON.stringify(listed.body)).not.toContain(tokenRow.id);
  });

  it('a reserved branch is the run’s own on a retried attempt; reserving outside the run or while scoping is refused', async () => {
    const { scope, turn } = await implementing();
    const scoped = await turnCall(scope, 'branches', { repository: 'orders-api' }).expect(409);
    expect(scoped.body.code).toBe('LEASE_LOST');

    const unknown = await turnCall(turn, 'branches', { repository: 'nope-api' }).expect(400);
    expect(unknown.body.code).toBe('UNKNOWN_REPOSITORY');
    const reserved = await turnCall(turn, 'branches', { repository: 'orders-api' }).expect(200);
    expect(reserved.body).toEqual({ reserved: true, branch: turn.body.run.branch });

    // The runner dies after reserving; lease expiry re-queues the turn (the run sweep's job).
    await prisma.cloudAgentRunTurn.update({ where: { id: turn.id }, data: { state: 'queued' } });
    const retried = await claimTurn();
    expect(retried.id).toBe(turn.id);
    expect(retried.body.turn.attempt).toBe(2);
    const byKey = Object.fromEntries(
      (retried.body.repositories as Array<{ key: string; branchCreated: boolean }>).map((r) => [
        r.key,
        r.branchCreated,
      ]),
    );
    expect(byKey).toEqual({ 'billing-api': false, 'orders-api': true });
  });

  it('submit_result and a pushed head move the run to delivery; the run page lists pushes, withheld paths and the workflow diff', async () => {
    const { runId, turn } = await implementing();
    const invalid = await turnCall(turn, 'submit-result', {
      summary: 'Done.',
      notBuiltOrTested: [{ key: 'nope-api', reason: 'Docker compose' }],
    }).expect(200);
    expect(invalid.body.accepted).toBe(false);
    expect(invalid.body.errors.join('\n')).toMatch(/nope-api/);

    const accepted = await turnCall(turn, 'submit-result', {
      summary: 'Added the orders export.',
      repositories: [{ key: 'orders-api', summary: 'Export endpoint' }],
      assumptions: ['CSV only'],
      notBuiltOrTested: [{ key: 'billing-api', reason: 'Its tests need Docker compose' }],
    }).expect(200);
    expect(accepted.body).toEqual({ accepted: true, stop: false });

    await turnCall(turn, 'branches', { repository: 'orders-api' }).expect(200);
    const diff = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n${'+  - run: echo\n'.repeat(2_500)}`;
    await complete(turn, { kind: 'ended' }, [
      report('billing-api', { withheldPaths: ['.env'] }),
      report('orders-api', {
        pushedHead: HEAD_A,
        withheldPaths: ['.github/workflows/ci.yml'],
        workflowDiff: { paths: ['.github/workflows/ci.yml'], diff, note: null },
      }),
    ]).expect(200);

    const run = await detail(runId);
    expect(run.assumptions).toContainEqual({ phase: 'implement', text: 'CSV only' });
    expect(run).toMatchObject({
      status: 'delivering',
      currentTurn: { kind: 'delivery', state: 'queued' },
      result: {
        summary: 'Added the orders export.',
        repositories: [{ key: 'orders-api', summary: 'Export endpoint' }],
      },
    });
    expect(run.repositories).toEqual([
      expect.objectContaining({
        key: 'billing-api',
        touched: false,
        lastPushedHead: null,
        withheldPaths: ['.env'],
        notBuiltOrTested: 'Its tests need Docker compose',
      }),
      expect.objectContaining({
        key: 'orders-api',
        branchCreated: true,
        touched: true,
        lastPushedHead: HEAD_A,
        withheldPaths: ['.github/workflows/ci.yml'],
        notBuiltOrTested: null,
      }),
    ]);
    const timeline = await events(runId);
    expect(timeline).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ code: 'branch_pushed', repository: 'orders-api', head: HEAD_A }),
      }),
    );
    const withheld = timeline.find((event) => event.payload.code === 'workflow_diff_withheld')!;
    // Above the 16 KiB event cap, within the 64 KiB one for workflow diffs.
    expect(Buffer.byteLength(diff)).toBeGreaterThan(16 * 1024);
    expect(withheld).toMatchObject({ truncated: false, payload: { repository: 'orders-api', diff } });
  });

  it('submit_result with no touched repository fails the run with no_changes, keeping the summary and withheld paths', async () => {
    const { runId, turn } = await implementing();
    await turnCall(turn, 'submit-result', { summary: 'Nothing needed changing.' }).expect(200);
    await complete(turn, { kind: 'ended' }, [report('orders-api', { withheldPaths: ['config/id_rsa'] })]).expect(200);
    const run = await detail(runId);
    expect(run).toMatchObject({
      status: 'failed',
      failureCode: 'no_changes',
      result: { summary: 'Nothing needed changing.' },
      currentTurn: null,
    });
    expect(run.repositories.find((r: { key: string }) => r.key === 'orders-api').withheldPaths).toEqual([
      'config/id_rsa',
    ]);
  });

  it('a duration checkpoint records the push and continues the same session in a new turn', async () => {
    const { runId, turn } = await implementing();
    await turnCall(turn, 'branches', { repository: 'orders-api' }).expect(200);
    await complete(turn, { kind: 'checkpoint' }, [report('orders-api', { pushedHead: HEAD_A })]).expect(200);
    expect(await detail(runId)).toMatchObject({
      status: 'implementing',
      currentTurn: { kind: 'implement', state: 'queued' },
    });

    const next = await claimTurn();
    expect(next.body.turn.inputText).toBe('Continue where you stopped.');
    expect(next.body.run.sessionId).toBe(turn.body.run.sessionId);
    expect(next.body.run.priorSessionSpendUsd).toBe(0.5);
    // The run's later turns see the branch as theirs.
    expect(next.body.repositories.find((r: { key: string }) => r.key === 'orders-api').branchCreated).toBe(true);
    await turnCall(next, 'submit-result', { summary: 'Finished.' }).expect(200);
    await complete(next, { kind: 'ended' }, [report('orders-api', { pushedHead: HEAD_B })]).expect(200);
    expect(await detail(runId)).toMatchObject({ status: 'delivering' });
  });

  it('a checkpoint neither counts toward nor resets the outcome-less nudge rule', async () => {
    const { runId, turn } = await implementing();
    await complete(turn).expect(200);
    const nudged = await claimTurn();
    expect(nudged.body.turn.inputText).toMatch(/without an outcome/);

    // Counting it would fail the run here; resetting it would let the next outcome-less turn be nudged again.
    await complete(nudged, { kind: 'checkpoint' }).expect(200);
    expect((await detail(runId)).status).toBe('implementing');
    const continued = await claimTurn();
    expect(continued.body.turn.inputText).toBe('Continue where you stopped.');

    await complete(continued).expect(200);
    expect(await detail(runId)).toMatchObject({ status: 'failed', failureCode: 'no_outcome' });
  });

  it('a pushed head for a repository the run never reserved, or outside the run, is refused', async () => {
    const { runId, turn } = await implementing();
    const unreserved = await complete(turn, { kind: 'ended' }, [report('orders-api', { pushedHead: HEAD_A })]).expect(
      400,
    );
    expect(unreserved.body.message).toMatch(/orders-api/);
    await complete(turn, { kind: 'ended' }, [report('nope-api')]).expect(400);
    expect(await detail(runId)).toMatchObject({ status: 'implementing', currentTurn: { state: 'claimed' } });
  });

  it.each([
    'branch_exists',
    'push_rejected',
    'secret_scan_blocked',
    'github_error',
    'repository_not_eligible',
  ])('the runner’s %s failure fails the run with its code and reason', async (code) => {
    const { runId, turn } = await implementing();
    await complete(turn, { kind: 'failed', code, reason: `The runner reported ${code}.` }).expect(200);
    expect(await detail(runId)).toMatchObject({
      status: 'failed',
      failureCode: code,
      failureReason: `The runner reported ${code}.`,
    });
  });

  it('an implement turn whose repository is no longer eligible fails the run at claim', async () => {
    const { runId, turn } = await implementing();
    await complete(turn, { kind: 'checkpoint' }).expect(200);
    await prisma.deliveryConnector.update({ where: { id: githubConnectorId }, data: { status: 'paused' } });
    try {
      await claim().expect(204);
    } finally {
      await prisma.deliveryConnector.update({ where: { id: githubConnectorId }, data: { status: 'active' } });
    }
    expect(await detail(runId)).toMatchObject({ status: 'failed', failureCode: 'repository_not_eligible' });
  });
});
