import '../../config/load-env.js';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DeliveryKind,
  PhaseGate,
  type ProposeScopeRequest,
  RepositoryMode,
  type RepositoryReport,
  RUNNER_LEASE_HEADER,
  RUNNER_PROTOCOL_VERSION,
  type WorkflowShape,
} from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { STORAGE_CONFIG, configFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { GITHUB_CLIENT_FACTORY } from '../delivery/github-importer.service.js';
import { JIRA_CLIENT_FACTORY } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { TokensController } from '../tokens/tokens.controller.js';
import { TokensService } from '../tokens/tokens.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunSweep } from './cloud-agent-run-sweep.service.js';
import { CloudAgentRunWorkflows } from './cloud-agent-run-workflows.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import {
  CLOUD_AGENT_RUNS_CLOCK,
  CLOUD_AGENT_RUNS_RETRY_DELAY,
  cloudAgentRunsCoreProviders,
} from './cloud-agent-runs.module.js';
import {
  advertising,
  DEFAULT_WORKFLOW,
  DONE_STATUS,
  FakeGithubPulls,
  FakeJira,
  InMemoryArchiveStore,
  paragraphDoc,
  setAgentRunsEnabled,
} from './cloud-agent-runs.test-support.js';
import { RUNNER_RATE_LIMIT } from './runner-rate-limit.guard.js';

const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };

const workflow = (
  id: string,
  shape: Partial<WorkflowShape> & Pick<WorkflowShape, 'phases'>,
  title = `Workflow ${id}`,
): WorkflowShape => ({
  id,
  title,
  repositories: RepositoryMode.Write,
  delivery: DeliveryKind.PullRequest,
  ...shape,
});

/** No repositories, nothing delivered: one gated phase, then the result. */
const X = workflow('x', {
  repositories: RepositoryMode.None,
  delivery: DeliveryKind.None,
  phases: [
    { id: 'questions', gate: PhaseGate.Acceptance },
    { id: 'report', gate: PhaseGate.None },
  ],
});

/** The default pipeline's shape with one more gated phase and none of its phase ids. */
const THREE = workflow('three', {
  phases: [
    { id: 'outline', gate: PhaseGate.Acceptance },
    { id: 'draft', gate: PhaseGate.Acceptance },
    { id: 'publish', gate: PhaseGate.None },
  ],
});

const proposal: ProposeScopeRequest = {
  title: 'Order exports',
  summary: 'Adds CSV exports.',
  specMarkdown: '# Spec\n\nExport orders as CSV.\n',
  repositories: [{ key: 'orders-api', reason: 'Owns the order records', changes: 'New export endpoint' }],
};

const pushed = (key: string): RepositoryReport => ({
  key,
  pushedHead: 'a'.repeat(40),
  withheldPaths: [],
  workflowDiff: null,
  binaryPaths: [],
});

interface Runner {
  token: string;
  versions: ReturnType<typeof advertising>;
}
type Turn = { id: string; lease: string; runner: Runner; body: Response['body'] };

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: workflows (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let sweep: CloudAgentRunSweep;
  let workspaceId: string;
  /** Advertises `default`, `x` and `three`; every scenario that names no other runner uses it. */
  let runner: Runner;
  let issueSeed = 0;
  let tokenSeed = 0;
  const jira = new FakeJira();
  const github = new FakeGithubPulls();
  const now = new Date();

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `carw-${RUN}`, slug: `carw-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    const jiraConnector = await prisma.deliveryConnector.create({
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
    await prisma.deliveryStatusMap.createMany({
      data: [
        { workspaceId, connectorId: jiraConnector.id, statusRaw: 'To Do', lifecycle: null },
        { workspaceId, connectorId: jiraConnector.id, statusRaw: 'In Progress', lifecycle: 'active' },
        { workspaceId, connectorId: jiraConnector.id, statusRaw: 'Done', lifecycle: 'completed' },
      ],
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
    const storage = configFromEnv().storage;
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
        { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useValue: new InMemoryArchiveStore() },
        { provide: RUNNER_RATE_LIMIT, useValue: { burst: 10_000, refillPerSec: 100 } },
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

    await setAgentRunsEnabled(prisma, workspaceId);
    await saveSettings({ takeOverOwnership: true, maxStartedRuns: 50, doneStatus: DONE_STATUS.name }).expect(200);
    runner = await advertise([DEFAULT_WORKFLOW, X, THREE]);
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
    await prisma.cloudAgentRun.updateMany({
      where: { workspaceId, status: { notIn: ['done', 'failed', 'cancelled'] } },
      data: { status: 'cancelled' },
    });
    await sweep.tick();
    await saveSettings({ workflowAccess: {} }).expect(200);
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = () => `/api/v1/workspaces/${workspaceId}/cloud-agent-runs`;
  const runnerBase = () => `/api/v1/workspaces/${workspaceId}/agent-runner`;

  const saveSettings = (body: Record<string, unknown>) =>
    api().put(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).send(body);

  const claim = (as: Runner) =>
    api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${as.token}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: as.versions });

  /** A runner token whose first claim, with nothing queued for it, advertises the workflows. */
  async function advertise(workflows: WorkflowShape[]): Promise<Runner> {
    tokenSeed += 1;
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: `workflows-runner-${tokenSeed}`, scope: 'agent-runner' })
      .expect(201);
    const made = { token: minted.body.token as string, versions: advertising({ runner: '0.0.1-test' }, workflows) };
    await claim(made).expect(204);
    return made;
  }

  async function claimTurn(as: Runner = runner): Promise<Turn> {
    const res = await claim(as).expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, runner: as, body: res.body };
  }

  const turnCall = (turn: Turn, path: string, body: unknown) =>
    api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${turn.runner.token}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);

  const complete = (turn: Turn, body: { outcome?: unknown; repositories?: RepositoryReport[] } = {}) =>
    turnCall(turn, 'complete', {
      outcome: body.outcome ?? { kind: 'ended' },
      spend: { costUsd: 0.5, sdkTurns: 4 },
      versions: turn.runner.versions,
      repositories: body.repositories ?? [],
      deliveries: [],
    });

  function newIssue(): string {
    issueSeed += 1;
    return jira.add({
      key: `PROJ-${issueSeed}`,
      summary: `Review ${issueSeed}`,
      project: 'PROJ',
      description: paragraphDoc('A specification to review.'),
    }).key;
  }

  const start = (body: Record<string, unknown>, user = MEMBER) =>
    api()
      .post(runsBase())
      .set('Authorization', human(user))
      .send({ issueKey: newIssue(), ...body });

  const act = (runId: string, action: string, user = MEMBER, body: Record<string, unknown> = {}) =>
    api().post(`${runsBase()}/${runId}/${action}`).set('Authorization', human(user)).send(body);

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  const workflows = async (user = MEMBER) =>
    (await api().get(`${runsBase()}/workflows`).set('Authorization', human(user)).expect(200)).body.workflows as Array<
      WorkflowShape & { startable: boolean; reason: string | null }
    >;

  const turnsOf = (runId: string, kind: string) => prisma.cloudAgentRunTurn.count({ where: { runId, kind } });

  /** A run of the workflow whose first turn a runner failed: it can be continued and re-run. */
  async function failedRun(workflowId: string, user = MEMBER): Promise<string> {
    const { body: run } = await start({ workflow: workflowId }, user).expect(201);
    await complete(await claimTurn(), { outcome: { kind: 'failed', code: 'agent_error', reason: 'boom' } }).expect(200);
    expect((await detail(run.id)).status).toBe('failed');
    return run.id as string;
  }

  it('a runner’s claim lists every workflow of its manifest with its title and phases', async () => {
    const alpha = workflow('alpha', { phases: [{ id: 'only', gate: PhaseGate.None }] }, 'Alpha review');
    const beta = workflow('beta', { ...X, id: 'beta' }, 'Beta review');
    expect((await workflows()).map(({ id }) => id)).not.toEqual(expect.arrayContaining(['alpha', 'beta']));

    await advertise([alpha, beta]);

    const listed = await workflows();
    expect(listed.find(({ id }) => id === 'alpha')).toMatchObject({ ...alpha, startable: true });
    expect(listed.find(({ id }) => id === 'beta')).toMatchObject({ ...beta, startable: true });
  });

  it('runners advertising different shapes under one id make it not startable, and a start is refused', async () => {
    await advertise([workflow('clash', { phases: [{ id: 'only', gate: PhaseGate.None }] })]);
    await advertise([workflow('clash', { phases: THREE.phases })]);

    const clash = (await workflows()).find(({ id }) => id === 'clash');
    expect(clash).toMatchObject({ startable: false, reason: expect.any(String) });

    const before = await prisma.cloudAgentRun.count({ where: { workspaceId } });
    const refused = await start({ workflow: 'clash' }).expect(400);
    expect(refused.body.code).toBe('UNKNOWN_WORKFLOW');
    expect(await prisma.cloudAgentRun.count({ where: { workspaceId } })).toBe(before);
  });

  it.each([
    { name: 'without a workflow', body: {} },
    { name: 'naming a workflow no runner advertises', body: { workflow: 'ghost' }, code: 'UNKNOWN_WORKFLOW' },
  ])('a start $name is refused and creates no run', async ({ body, code }) => {
    const before = await prisma.cloudAgentRun.count({ where: { workspaceId } });
    const refused = await start(body).expect(400);
    if (code) expect(refused.body.code).toBe(code);
    expect(await prisma.cloudAgentRun.count({ where: { workspaceId } })).toBe(before);
  });

  it('a queued turn is handed to, and counted for, only a runner that advertises its workflow', async () => {
    const onlyDefault = await advertise([DEFAULT_WORKFLOW]);
    const onlyX = await advertise([X]);
    const queued = async (as: Runner) =>
      (await api().get(`${runnerBase()}/queue`).set('Authorization', `Bearer ${as.token}`).expect(200)).body.queued;

    const { body: run } = await start({ workflow: 'x' }).expect(201);

    expect(await queued(onlyDefault)).toBe(0);
    expect(await queued(onlyX)).toBe(1);
    await claim(onlyDefault).expect(204);
    const turn = await claimTurn(onlyX);
    expect(turn.body).toMatchObject({ run: { id: run.id }, workflow: { id: 'x' }, turn: { kind: 'questions' } });
  });

  it('a queued turn counts for a runner token whose last report predates workflows', async () => {
    tokenSeed += 1;
    const name = `workflows-runner-${tokenSeed}`;
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name, scope: 'agent-runner' })
      .expect(201);
    const token = await prisma.serviceToken.findFirstOrThrow({ where: { workspaceId, name } });
    await prisma.agentRunnerSeen.create({
      data: {
        serviceTokenId: token.id,
        workspaceId,
        lastSeenAt: new Date(),
        lastAction: 'claim',
        protocolVersion: 1,
        versions: { runner: '0.0.1-old', manifest: { digest: 'sha256:old', models: {}, plugins: [] } },
      },
    });
    const queued = async () =>
      (await api().get(`${runnerBase()}/queue`).set('Authorization', `Bearer ${minted.body.token}`).expect(200)).body
        .queued as number;
    const before = await queued();

    await start({ workflow: 'x' }).expect(201);

    expect(await queued()).toBe(before + 1);
  });

  it('a workspace whose runners have advertised nothing has the default workflow', async () => {
    const bare = await prisma.workspace.create({ data: { name: `wf-bare-${RUN}`, slug: `wf-bare-${RUN}` } });
    try {
      const registry = new CloudAgentRunWorkflows(prisma as unknown as PrismaService);
      expect((await registry.advertised(bare.id)).map(({ shape }) => shape.id)).toEqual(['default']);
    } finally {
      await prisma.workspace.delete({ where: { id: bare.id } });
    }
  });

  it('a continued run and a re-run keep the workflow', async () => {
    const runId = await failedRun('x');

    await act(runId, 'continue', MEMBER, { text: 'Try again.' }).expect(200);
    expect(await detail(runId)).toMatchObject({
      status: 'running',
      workflow: { id: 'x' },
      currentTurn: { kind: 'questions', state: 'queued' },
    });

    await act(runId, 'cancel').expect(200);
    const rerun = await act(runId, 'rerun').expect(201);
    expect(rerun.body).toMatchObject({
      previousRunId: runId,
      workflow: { id: 'x' },
      currentTurn: { kind: 'questions', state: 'queued' },
    });
  });

  it('a three-phase workflow runs proposal, acceptance, changes and result in order, one session per phase', async () => {
    const { body: run } = await start({ workflow: 'three' }).expect(201);
    const at = async () => {
      const { status, phase } = await detail(run.id);
      return { status, phase };
    };
    const propose = async (turn: Turn) => {
      expect((await turnCall(turn, 'propose-scope', proposal).expect(200)).body.accepted).toBe(true);
      await complete(turn).expect(200);
    };
    const review = (version: number, action: string, body = {}) =>
      act(run.id, `specs/${version}/${action}`, MEMBER, body).expect(200);
    const result = { summary: 'Published.', repositories: [{ key: 'orders-api', summary: 'Export endpoint' }] };
    expect(await at()).toEqual({ status: 'running', phase: 'outline' });

    const outline = await claimTurn();
    expect(outline.body).toMatchObject({ workflow: { id: 'three' }, turn: { kind: 'outline' } });
    expect((await turnCall(outline, 'submit-result', result).expect(200)).body.accepted).toBe(false);
    await propose(outline);
    expect(await at()).toEqual({ status: 'awaiting_scope_acceptance', phase: 'outline' });
    await review(1, 'accept');
    expect(await at()).toEqual({ status: 'running', phase: 'draft' });

    const draft = await claimTurn();
    expect(draft.body.turn.kind).toBe('draft');
    await propose(draft);
    expect(await at()).toEqual({ status: 'awaiting_scope_acceptance', phase: 'draft' });
    await review(2, 'request-changes', { text: 'Name the columns.' });
    expect(await at()).toEqual({ status: 'running', phase: 'draft' });

    const redraft = await claimTurn();
    expect(redraft.body.turn).toMatchObject({ kind: 'draft', inputText: expect.stringContaining('Name the columns.') });
    await propose(redraft);
    await review(3, 'accept');
    expect(await at()).toEqual({ status: 'running', phase: 'publish' });

    const publish = await claimTurn();
    expect(publish.body.turn.kind).toBe('publish');
    expect((await turnCall(publish, 'propose-scope', proposal).expect(200)).body.accepted).toBe(false);
    expect((await turnCall(publish, 'submit-result', result).expect(200)).body.accepted).toBe(true);
    await turnCall(publish, 'branches', { repository: 'orders-api' }).expect(200);
    await complete(publish, { repositories: [pushed('orders-api')] }).expect(200);
    expect(await detail(run.id)).toMatchObject({ status: 'delivering', currentTurn: { kind: 'delivery' } });
    expect((await claimTurn()).body).toMatchObject({
      turn: { kind: 'delivery' },
      repositories: [{ key: 'orders-api' }],
      delivery: { pullRequests: [{ key: 'orders-api' }] },
    });

    const sessions = [outline, draft, redraft, publish].map((turn) => turn.body.run.sessionId as string);
    expect(sessions[2]).toBe(sessions[1]);
    expect(new Set(sessions).size).toBe(3);
  });

  describe('a workflow without repositories or delivery', () => {
    /** Its gated phase accepted and its final turn claimed. */
    async function reporting() {
      const { body: run } = await start({ workflow: 'x' }).expect(201);
      const questions = await claimTurn();
      const withRepositories = await turnCall(questions, 'propose-scope', proposal).expect(200);
      expect(withRepositories.body.accepted).toBe(false);
      const proposed = await turnCall(questions, 'propose-scope', { ...proposal, repositories: [] }).expect(200);
      expect(proposed.body).toMatchObject({ accepted: true });
      await complete(questions).expect(200);
      await act(run.id, 'specs/1/accept').expect(200);
      return { runId: run.id as string, questions, report: await claimTurn() };
    }

    it('hands out no repositories and no branch scan in any phase', async () => {
      const { questions, report } = await reporting();
      for (const turn of [questions, report]) {
        expect(turn.body.repositories).toEqual([]);
        expect(turn.body.branchScan).toBeNull();
      }
    });

    it.each([
      { name: 'a complete result ends done once Jira has the outcome', result: {}, ends: { status: 'done' } },
      {
        name: 'a partial result ends incomplete_result',
        result: { status: 'partial', unmetCriteria: ['Section 3 was not reviewed'] },
        ends: { status: 'failed', failureCode: 'incomplete_result' },
      },
    ])('$name, with no delivery turn', async ({ result, ends }) => {
      const { runId, report } = await reporting();
      const submitted = await turnCall(report, 'submit-result', { summary: 'Reviewed.', ...result }).expect(200);
      expect(submitted.body.accepted).toBe(true);
      await complete(report).expect(200);

      await sweep.tick();
      await sweep.tick();
      expect(await detail(runId)).toMatchObject({ ...ends, currentTurn: null });
      expect(await turnsOf(runId, 'delivery')).toBe(0);
    });

    it('continuing a run that failed after its result goes back to the final phase, never to a delivery turn', async () => {
      const { runId, report } = await reporting();
      await turnCall(report, 'submit-result', { summary: 'Reviewed.' }).expect(200);
      await complete(report).expect(200);
      expect(await detail(runId)).toMatchObject({ status: 'delivering', phase: 'delivery' });
      await prisma.cloudAgentRun.update({
        where: { id: runId },
        data: { status: 'failed', failureCode: 'delivery_failed', finishedAt: new Date(), jiraOutcome: {} },
      });

      await act(runId, 'continue').expect(200);

      expect(await detail(runId)).toMatchObject({ phase: 'report', currentTurn: { kind: 'report' } });
      expect(await turnsOf(runId, 'delivery')).toBe(0);
    });
  });

  describe('workflow access', () => {
    it.each([
      { name: 'a minimum role of admin', access: { minRole: 'admin' }, allowed: ADMIN, refused: MEMBER },
      { name: 'named members', access: { members: [MEMBER.id] }, allowed: MEMBER, refused: ADMIN },
    ])('$name limits who starts, re-runs and continues the workflow', async ({ access, allowed, refused }) => {
      const runId = await failedRun('x');
      await saveSettings({ workflowAccess: { x: access } }).expect(200);

      const before = await prisma.cloudAgentRun.count({ where: { workspaceId } });
      for (const attempt of [
        start({ workflow: 'x' }, refused),
        act(runId, 'continue', refused, { text: 'Again.' }),
        act(runId, 'rerun', refused),
      ]) {
        const res = await attempt.expect(403);
        expect(res.body.code).toBe('WORKFLOW_NOT_ALLOWED');
      }
      expect(await prisma.cloudAgentRun.count({ where: { workspaceId } })).toBe(before);
      expect((await detail(runId)).status).toBe('failed');

      await act(runId, 'continue', allowed, { text: 'Again.' }).expect(200);
      await act(runId, 'cancel').expect(200);
      await act(runId, 'rerun', allowed).expect(201);
      await start({ workflow: 'x' }, allowed).expect(201);
      await start({ workflow: 'default' }, MEMBER).expect(201);
    });

    it('refuses to name a user who is not a member of the workspace', async () => {
      await saveSettings({ workflowAccess: { x: { members: [MEMBER.id, `${RUN}-outsider`] } } }).expect(400);
      const settings = await api().get(`${runsBase()}/settings`).set('Authorization', human(ADMIN)).expect(200);
      expect(settings.body.workflowAccess).toEqual({});
    });
  });
});
