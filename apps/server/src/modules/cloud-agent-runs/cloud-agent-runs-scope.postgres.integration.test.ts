import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_STATE_ARCHIVE_BYTES,
  type ProposeScopeRequest,
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
 * The scope phase driven through the human API and the runner API on real
 * PostgreSQL with real guards. Jira and the archive store are in-memory fakes
 * at their ports; the runner is a scripted fake making runner API calls.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
/** A member of another workspace only. */
const OUTSIDER = { id: `${RUN}-outsider`, email: 'outsider@example.com' };
const VERSIONS = { runner: '0.0.1-test', sdk: '0.3.285' };

const proposal = (overrides: Partial<ProposeScopeRequest> = {}): ProposeScopeRequest => ({
  title: 'Order exports',
  summary: 'Adds CSV exports to the orders service.',
  specMarkdown: '# Spec\n\nExport orders as CSV.\n\n![diagram](https://example.com/x.png)',
  repositories: [{ key: 'orders-api', reason: 'Owns the order records', changes: 'New export endpoint' }],
  risks: ['Large exports may time out'],
  assumptions: ['Exports are CSV only'],
  ...overrides,
});

describe.skipIf(!TEST_DATABASE_URL)('cloud agent runs: scope phase (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let githubConnectorId: string;
  let runnerToken: string;
  let otherRunnerToken: string;
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
      data: { name: `cars-${RUN}`, slug: `cars-${RUN}`, deliveryEnabled: true },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
      ],
    });
    const other = await prisma.workspace.create({ data: { name: `cars-other-${RUN}`, slug: `cars-other-${RUN}` } });
    otherWorkspaceId = other.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: otherWorkspaceId, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId: otherWorkspaceId, userId: OUTSIDER.id, email: OUTSIDER.email, role: 'admin' },
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
      data: [
        { key: 'orders-api', remote: 'github.com/example-org/orders-api' },
        { key: 'billing-api', remote: 'github.com/example-org/billing-api' },
        { key: 'legacy-tool', remote: null },
      ].map(({ key, remote }) => ({
        workspaceId,
        repoKey: graphRepoHashOf(key),
        repoName: key,
        intentRepoKey: key,
        normalizedGitRemote: remote,
      })),
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

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    (app as NestExpressApplication).useBodyParser('raw', {
      limit: MAX_STATE_ARCHIVE_BYTES + 1024 * 1024,
      type: 'application/octet-stream',
    });
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0, '127.0.0.1');

    // Scenarios leave runs open; the concurrency queue is ticket 09's subject, not this suite's.
    await api()
      .put(`${runsBase()}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ enabled: true, maxStartedRuns: 50 })
      .expect(200);
    const minted = await api()
      .post(`/api/v1/workspaces/${workspaceId}/tokens`)
      .set('Authorization', human(ADMIN))
      .send({ name: 'scope-runner', scope: 'agent-runner' })
      .expect(201);
    runnerToken = minted.body.token as string;
    const otherMinted = await api()
      .post(`/api/v1/workspaces/${otherWorkspaceId}/tokens`)
      .set('Authorization', human(OUTSIDER))
      .send({ name: 'other-runner', scope: 'agent-runner' })
      .expect(201);
    otherRunnerToken = otherMinted.body.token as string;
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

  function newIssue(
    description = 'Customers need order exports.',
    extra: Partial<Parameters<FakeJira['add']>[0]> = {},
  ) {
    issueSeed += 1;
    return jira.add({
      key: `PROJ-${issueSeed}`,
      summary: `Export orders ${issueSeed}`,
      project: 'PROJ',
      labels: ['coredoc-agent'],
      description: paragraphDoc(description),
      ...extra,
    });
  }

  async function startRun(body: Record<string, unknown> = {}) {
    const issue = newIssue();
    const res = await api()
      .post(runsBase())
      .set('Authorization', human(MEMBER))
      .send({ issueKey: issue.key, ...body })
      .expect(201);
    return res.body as { id: string; issueKey: string };
  }

  function claim() {
    return api()
      .post(`${runnerBase()}/claim`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .send({ protocolVersion: RUNNER_PROTOCOL_VERSION, versions: VERSIONS });
  }

  function turnCall(turn: { id: string; lease: string }, path: string, body: unknown) {
    return api()
      .post(`${runnerBase()}/turns/${turn.id}/${path}`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, turn.lease)
      .send(body as object);
  }

  async function claimTurn() {
    const res = await claim().expect(200);
    return { id: res.body.turn.id as string, lease: res.body.lease.token as string, body: res.body };
  }

  const complete = (turn: { id: string; lease: string }, outcome: unknown = { kind: 'ended' }) =>
    turnCall(turn, 'complete', { outcome, spend: { costUsd: 0.5, sdkTurns: 4 }, versions: VERSIONS });

  const detail = async (runId: string) =>
    (await api().get(`${runsBase()}/${runId}`).set('Authorization', human(MEMBER)).expect(200)).body;

  it('a scope turn carries the PRD read from Jira, the seeds and a per-turn MCP token that ends with the turn', async () => {
    const run = await startRun();
    await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { seeds: ['billing-api'] } });

    const turn = await claimTurn();
    expect(turn.body.prd.markdown).toContain(`# ${run.issueKey}: Export orders`);
    expect(turn.body.prd.markdown).toContain(`https://example.atlassian.net/browse/${run.issueKey}`);
    expect(turn.body.prd.markdown).toContain('Customers need order exports.');
    expect(turn.body.run).toMatchObject({ seeds: ['billing-api'], priorSessionSpendUsd: 0 });
    expect(turn.body.hasStateArchive).toBe(false);
    expect(turn.body.mcp.path).toBe(`/api/v1/workspaces/${workspaceId}/mcp`);

    const tokenRow = await prisma.serviceToken.findFirst({ where: { owningTurnId: turn.id } });
    expect(tokenRow).toMatchObject({ permissions: ['intent:read'], createdBy: MEMBER.id, tokenEncrypted: null });
    // MCP-only: the per-turn token is refused on REST.
    await api().get(runsBase()).set('Authorization', `Bearer ${turn.body.mcp.token}`).expect(403);

    await complete(turn).expect(200);
    expect(await prisma.serviceToken.count({ where: { owningTurnId: turn.id } })).toBe(0);
  });

  it('an epic’s PRD carries its child issues in configured projects only', async () => {
    const epic = newIssue('Shared decisions for exports.', { issueType: 'Epic' });
    jira.add({
      key: 'PROJ-900',
      summary: 'Request an export',
      project: 'PROJ',
      parent: epic.key,
      description: paragraphDoc('Child story text.'),
    });
    jira.add({
      key: 'OTHER-1',
      summary: 'Elsewhere',
      project: 'OTHER',
      parent: epic.key,
      description: paragraphDoc('Foreign text.'),
    });
    await api().post(runsBase()).set('Authorization', human(MEMBER)).send({ issueKey: epic.key }).expect(201);

    const turn = await claimTurn();
    expect(turn.body.prd.markdown).toContain('### PROJ-900: Request an export');
    expect(turn.body.prd.markdown).toContain('Child story text.');
    expect(turn.body.prd.markdown).not.toContain('Foreign text.');
  });

  it('a manual start for a missing issue or one outside the configured projects is refused', async () => {
    jira.add({ key: 'OTHER-7', summary: 'Elsewhere', project: 'OTHER' });
    for (const issueKey of ['OTHER-7', 'PROJ-404404']) {
      const res = await api().post(runsBase()).set('Authorization', human(MEMBER)).send({ issueKey }).expect(400);
      expect(res.body.code).toBe('ISSUE_NOT_READABLE');
    }
  });

  it('an issue that left the configured projects fails the run at claim instead of handing out the turn', async () => {
    const run = await startRun();
    jira.issues.get(run.issueKey)!.project = 'OTHER';

    await claim().expect(204);
    expect(await detail(run.id)).toMatchObject({ status: 'failed', failureCode: 'issue_not_readable' });
  });

  it('rate-limited Jira reads are retried in process before the turn is handed out', async () => {
    await startRun();
    jira.rateLimitedReads = 2;
    const turn = await claimTurn();
    expect(turn.body.prd.markdown).toContain('Customers need order exports.');
  });

  it('propose_scope errors go back to the agent; a valid proposal is published as proposed at completion', async () => {
    const run = await startRun();
    await prisma.cloudAgentRun.update({ where: { id: run.id }, data: { seeds: ['billing-api'] } });
    const turn = await claimTurn();

    const invalid = await turnCall(
      turn,
      'propose-scope',
      proposal({
        repositories: [
          { key: 'legacy-tool', reason: 'Old exporter', changes: 'Remove' },
          { key: 'nope-api', reason: 'Unknown', changes: 'None' },
        ],
      }),
    ).expect(200);
    expect(invalid.body.accepted).toBe(false);
    expect(invalid.body.errors.join('\n')).toMatch(/legacy-tool/);
    expect(invalid.body.errors.join('\n')).toMatch(/nope-api/);
    expect(invalid.body.errors.join('\n')).toMatch(/billing-api/);

    const empty = await turnCall(turn, 'propose-scope', proposal({ repositories: [] })).expect(200);
    expect(empty.body.errors.join('\n')).toMatch(/at least one repository/i);

    const valid = await turnCall(
      turn,
      'propose-scope',
      proposal({ droppedSeeds: [{ key: 'billing-api', reason: 'Billing is not affected' }] }),
    ).expect(200);
    expect(valid.body).toEqual({ accepted: true, version: 1, stop: false });

    // A draft is not visible before the turn completes.
    const specsBefore = await api()
      .get(`${runsBase()}/${run.id}/specs`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    expect(specsBefore.body.versions).toEqual([]);

    await complete(turn).expect(200);
    const after = await detail(run.id);
    expect(after).toMatchObject({
      status: 'awaiting_scope_acceptance',
      latestSpec: {
        version: 1,
        status: 'proposed',
        title: 'Order exports',
        repositories: [{ key: 'orders-api', reason: 'Owns the order records', eligible: true, mergeOrder: 0 }],
        droppedSeeds: [{ key: 'billing-api', reason: 'Billing is not affected' }],
      },
    });
  });

  it('change requests resume the scope session; a stale version is refused; accepting starts implementation', async () => {
    const run = await startRun();
    const first = await claimTurn();
    await turnCall(first, 'propose-scope', proposal()).expect(200);
    await complete(first).expect(200);

    await api()
      .post(`${runsBase()}/${run.id}/specs/1/request-changes`)
      .set('Authorization', human(MEMBER))
      .send({ text: 'Also cover billing exports.' })
      .expect(200);
    expect((await detail(run.id)).status).toBe('scoping');

    const second = await claimTurn();
    expect(second.body.turn.inputText).toContain('Also cover billing exports.');
    expect(second.body.run.sessionId).toBe(first.body.run.sessionId);
    expect(second.body.run.priorSessionSpendUsd).toBe(0.5);
    await turnCall(
      second,
      'propose-scope',
      proposal({
        repositories: [
          { key: 'orders-api', reason: 'Owns orders', changes: 'Export endpoint' },
          { key: 'billing-api', reason: 'Owns invoices', changes: 'Export endpoint' },
        ],
        mergeOrder: ['billing-api', 'orders-api'],
      }),
    ).expect(200);
    await complete(second).expect(200);

    const stale = await api()
      .post(`${runsBase()}/${run.id}/specs/1/accept`)
      .set('Authorization', human(MEMBER))
      .expect(409);
    expect(stale.body.code).toBe('SPEC_VERSION_STALE');

    const specs = await api().get(`${runsBase()}/${run.id}/specs`).set('Authorization', human(MEMBER)).expect(200);
    expect(specs.body.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
      [1, 'changes_requested'],
      [2, 'proposed'],
    ]);
    expect(specs.body.versions[0].reviewText).toBe('Also cover billing exports.');

    await api().post(`${runsBase()}/${run.id}/specs/2/accept`).set('Authorization', human(MEMBER)).expect(200);
    const accepted = await detail(run.id);
    expect(accepted).toMatchObject({
      status: 'implementing',
      phase: 'implement',
      latestSpec: { version: 2, status: 'accepted', reviewedBy: MEMBER.id },
      currentTurn: { kind: 'implement', state: 'queued' },
    });
    expect(accepted.repositories.map((r: { key: string; mergeOrder: number }) => [r.key, r.mergeOrder])).toEqual([
      ['billing-api', 0],
      ['orders-api', 1],
    ]);

    const implement = await claimTurn();
    expect(implement.body.run.sessionId).not.toBe(first.body.run.sessionId);
    expect(implement.body.prd).toBeNull();
    const implementToken = await prisma.serviceToken.findFirst({ where: { owningTurnId: implement.id } });
    expect(implementToken?.permissions.sort()).toEqual(['intent:propose', 'intent:read']);
  });

  describe('automatic acceptance', () => {
    it('accepts at completion when every repository is eligible and no candidate is open', async () => {
      const run = await startRun({ scopeAcceptancePolicy: 'automatic' });
      const turn = await claimTurn();
      await turnCall(turn, 'propose-scope', proposal()).expect(200);
      await complete(turn).expect(200);
      expect(await detail(run.id)).toMatchObject({
        status: 'implementing',
        latestSpec: { status: 'accepted', autoAccepted: true, reviewedBy: null },
      });
    });

    it('waits for a person while a candidate for the PRD is open', async () => {
      const run = await startRun({ scopeAcceptancePolicy: 'automatic' });
      const turn = await claimTurn();
      await turnCall(
        turn,
        'propose-scope',
        proposal({ candidates: [{ question: 'Should exports include refunds?', blocks: 'The export columns' }] }),
      ).expect(200);
      await complete(turn).expect(200);
      expect(await detail(run.id)).toMatchObject({
        status: 'awaiting_scope_acceptance',
        latestSpec: { status: 'proposed', candidates: [{ question: 'Should exports include refunds?' }] },
      });
    });

    it('waits for a person when a repository stopped being eligible before completion', async () => {
      const run = await startRun({ scopeAcceptancePolicy: 'automatic' });
      const turn = await claimTurn();
      await turnCall(turn, 'propose-scope', proposal()).expect(200);
      await prisma.deliveryConnector.update({ where: { id: githubConnectorId }, data: { status: 'paused' } });
      try {
        await complete(turn).expect(200);
      } finally {
        await prisma.deliveryConnector.update({ where: { id: githubConnectorId }, data: { status: 'active' } });
      }
      expect(await detail(run.id)).toMatchObject({
        status: 'awaiting_scope_acceptance',
        latestSpec: { repositories: [{ key: 'orders-api', eligible: false }] },
      });
    });
  });

  describe('workspace isolation', () => {
    async function proposedRun() {
      const run = await startRun();
      const turn = await claimTurn();
      await turnCall(turn, 'propose-scope', proposal()).expect(200);
      await complete(turn).expect(200);
      return run;
    }

    it('a member of another workspace cannot read, accept or send back a run through that workspace', async () => {
      const run = await proposedRun();
      const foreign = `/api/v1/workspaces/${otherWorkspaceId}/cloud-agent-runs/${run.id}`;

      for (const user of [ADMIN, OUTSIDER]) {
        await api().get(foreign).set('Authorization', human(user)).expect(404);
        await api().get(`${foreign}/specs`).set('Authorization', human(user)).expect(404);
        const accept = await api().post(`${foreign}/specs/1/accept`).set('Authorization', human(user)).expect(404);
        expect(accept.body.code).toBe('RUN_NOT_FOUND');
        await api()
          .post(`${foreign}/specs/1/request-changes`)
          .set('Authorization', human(user))
          .send({ text: 'Widen it.' })
          .expect(404);
      }
      // Not a member of the run's workspace: refused before any lookup.
      await api().post(`${runsBase()}/${run.id}/specs/1/accept`).set('Authorization', human(OUTSIDER)).expect(403);

      expect(await detail(run.id)).toMatchObject({
        status: 'awaiting_scope_acceptance',
        latestSpec: { version: 1, status: 'proposed', reviewedBy: null },
      });
    });

    it('requesting changes on a version other than the latest proposed one is refused', async () => {
      const run = await proposedRun();
      for (const version of [0, 2]) {
        const res = await api()
          .post(`${runsBase()}/${run.id}/specs/${version}/request-changes`)
          .set('Authorization', human(MEMBER))
          .send({ text: 'Widen it.' })
          .expect(409);
        expect(res.body.code).toBe('SPEC_VERSION_STALE');
      }
      expect((await detail(run.id)).status).toBe('awaiting_scope_acceptance');
    });

    it('a runner of another workspace cannot propose, upload or complete on this workspace’s turn', async () => {
      const run = await startRun();
      const turn = await claimTurn();
      const foreignTurn = (path: string) =>
        `/api/v1/workspaces/${otherWorkspaceId}/agent-runner/turns/${turn.id}/${path}`;

      const proposed = await api()
        .post(foreignTurn('propose-scope'))
        .set('Authorization', `Bearer ${otherRunnerToken}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .send(proposal())
        .expect(409);
      expect(proposed.body.code).toBe('LEASE_LOST');
      await api()
        .put(foreignTurn('archive'))
        .set('Authorization', `Bearer ${otherRunnerToken}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('foreign'))
        .expect(409);
      await api()
        .post(foreignTurn('complete'))
        .set('Authorization', `Bearer ${otherRunnerToken}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .send({ outcome: { kind: 'failed', code: 'agent_error', reason: 'forged' }, spend: null, versions: VERSIONS })
        .expect(409);
      // Its own workspace's path with this workspace's turn is refused by the token's workspace binding.
      await api()
        .post(`${runnerBase()}/turns/${turn.id}/propose-scope`)
        .set('Authorization', `Bearer ${otherRunnerToken}`)
        .set(RUNNER_LEASE_HEADER, turn.lease)
        .send(proposal())
        .expect(403);

      expect(await prisma.cloudAgentRunSpecVersion.count({ where: { runId: run.id } })).toBe(0);
      expect(await detail(run.id)).toMatchObject({ status: 'scoping', failureCode: null });
      await turnCall(turn, 'propose-scope', proposal()).expect(200);
      await complete(turn).expect(200);
      expect((await detail(run.id)).latestSpec).toMatchObject({ version: 1, status: 'proposed' });
    });
  });

  it.each([
    ['agent_error', 'The model API refused the key'],
    ['budget_exhausted', 'No spend remains for this run (remaining: 0 USD).'],
  ])('a %s failure the runner reports fails the run with its code and reason', async (code, reason) => {
    const run = await startRun();
    const turn = await claimTurn();
    await complete(turn, { kind: 'failed', code, reason }).expect(200);
    expect(await detail(run.id)).toMatchObject({
      status: 'failed',
      failureCode: code,
      failureReason: reason,
      currentTurn: null,
    });
  });

  it('the state archive round-trips between turns under the live lease, replacing the previous one', async () => {
    const run = await startRun();
    const first = await claimTurn();
    const uploaded = Buffer.from('first archive bytes');
    await api()
      .put(`${runnerBase()}/turns/${first.id}/archive`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, first.lease)
      .set('Content-Type', 'application/octet-stream')
      .send(uploaded)
      .expect(200);
    await turnCall(first, 'propose-scope', proposal()).expect(200);
    await complete(first).expect(200);
    const firstKey = (await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id: run.id } })).stateArchiveKey!;
    expect(archives.objects.get(firstKey)).toEqual(uploaded);

    await api()
      .post(`${runsBase()}/${run.id}/specs/1/request-changes`)
      .set('Authorization', human(MEMBER))
      .send({ text: 'Narrow it down.' })
      .expect(200);
    const second = await claimTurn();
    expect(second.body.hasStateArchive).toBe(true);

    const stale = await api()
      .get(`${runnerBase()}/turns/${second.id}/archive`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, first.lease)
      .expect(409);
    expect(stale.body.code).toBe('LEASE_LOST');

    const downloaded = await api()
      .get(`${runnerBase()}/turns/${second.id}/archive`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, second.lease)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(downloaded.body).toEqual(uploaded);

    await api()
      .put(`${runnerBase()}/turns/${second.id}/archive`)
      .set('Authorization', `Bearer ${runnerToken}`)
      .set(RUNNER_LEASE_HEADER, second.lease)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('second archive bytes'))
      .expect(200);
    await complete(second).expect(200);
    const secondKey = (await prisma.cloudAgentRun.findUniqueOrThrow({ where: { id: run.id } })).stateArchiveKey!;
    expect(secondKey).not.toBe(firstKey);
    expect(archives.objects.has(firstKey)).toBe(false);
    expect(archives.objects.get(secondKey)?.toString()).toBe('second archive bytes');
  });
});
