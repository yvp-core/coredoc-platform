import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../../auth/auth.service.js';
import { STORAGE_CONFIG, storageConfigFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { JiraClient, JiraIssue, JiraSearchOptions } from '../delivery/jira-client.js';
import { JIRA_CLIENT_FACTORY, type JiraClientFactory } from '../delivery/jira-importer.service.js';
import { graphRepoHashOf } from '../repos/repo-intent-identity.js';
import { CloudAgentRunTriggerCron } from './cloud-agent-run-trigger.cron.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { cloudAgentRunsCoreProviders, CLOUD_AGENT_RUNS_CLOCK } from './cloud-agent-runs.module.js';

/**
 * Starting runs, driven from outside: the human API (real guards) and the
 * trigger cron, on real PostgreSQL. Jira is a stateful in-memory fake behind
 * the existing client-factory seam; it answers a search the way Jira would,
 * by project and label. Each scenario gets its own workspace.
 */
const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const ENCRYPTION_KEY = randomBytes(32).toString('hex');

const OWNER = { id: `${RUN}-owner`, email: 'owner@example.com' };
const ADMIN = { id: `${RUN}-admin`, email: 'admin@example.com' };
const MEMBER = { id: `${RUN}-member`, email: 'member@example.com' };
const OTHER_MEMBER = { id: `${RUN}-member2`, email: 'member2@example.com' };
const USERS = [OWNER, ADMIN, MEMBER, OTHER_MEMBER];

interface FakeIssue {
  id: string;
  key: string;
  labels: string[];
}

/** One Jira site: issues, plus every search it was asked. */
class FakeJira {
  issues: FakeIssue[] = [];
  searches: Array<{ jql: string; fields: string[]; options: JiraSearchOptions }> = [];

  client(): JiraClient {
    return {
      searchIssues: async (jql: string, fields: string[], options: JiraSearchOptions = {}) => {
        this.searches.push({ jql, fields, options });
        const projects = /project in \(([^)]*)\)/
          .exec(jql)?.[1]
          ?.match(/"([^"]+)"/g)
          ?.map((p) => p.slice(1, -1));
        const label = /labels = "([^"]+)"/.exec(jql)?.[1];
        const items: JiraIssue[] = this.issues
          .filter((issue) => projects?.includes(issue.key.split('-')[0]!) && label && issue.labels.includes(label))
          .map((issue) => ({
            id: issue.id,
            key: issue.key,
            fields: { summary: `Summary of ${issue.key}`, labels: issue.labels, updated: '2026-10-10T08:00:00.000Z' },
          }));
        return { items, nextPageToken: null };
      },
    } as unknown as JiraClient;
  }
}

describe.skipIf(!TEST_DATABASE_URL)('starting cloud agent runs: Jira trigger and queue (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  let app: INestApplication;
  const workspaces: string[] = [];
  const jiraSites = new Map<string, FakeJira>();
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 10, 9, 0, 0) + tick++ * 1000);

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = ENCRYPTION_KEY;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    const users = new Map(USERS.map((user) => [user.id, user]));
    const jiraFactory: JiraClientFactory = ({ baseUrl }) => (jiraSites.get(baseUrl) ?? new FakeJira()).client();
    const storage = storageConfigFromEnv();
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudAgentRunsController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        ...cloudAgentRunsCoreProviders,
        CloudAgentRunTriggerCron,
        { provide: CLOUD_AGENT_RUNS_CLOCK, useValue: clock },
        { provide: JIRA_CLIENT_FACTORY, useValue: jiraFactory },
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
  });

  afterAll(async () => {
    await app?.close();
    for (const id of workspaces) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    await prisma?.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  const api = () => request(app.getHttpServer());
  const human = (user: { id: string }) => `Bearer jwt:${user.id}`;
  const runsBase = (ws: string) => `/api/v1/workspaces/${ws}/cloud-agent-runs`;
  const trigger = () => app.get(CloudAgentRunTriggerCron).run();

  /**
   * A workspace ready for agent runs: Delivery analytics on, an active Jira
   * connector with the given project keys and an active GitHub connector, two
   * eligible repositories, and agent runs switched on by OWNER.
   */
  async function workspace(options: { projects?: string[]; settings?: Record<string, unknown> } = {}) {
    const slug = `cat-${RUN}-${workspaces.length}`;
    const { id } = await prisma.workspace.create({ data: { name: slug, slug, deliveryEnabled: true } });
    workspaces.push(id);
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: id, userId: OWNER.id, email: OWNER.email, role: 'admin' },
        { workspaceId: id, userId: ADMIN.id, email: ADMIN.email, role: 'admin' },
        { workspaceId: id, userId: MEMBER.id, email: MEMBER.email, role: 'member' },
        { workspaceId: id, userId: OTHER_MEMBER.id, email: OTHER_MEMBER.email, role: 'member' },
      ],
    });
    const baseUrl = `https://${slug}.atlassian.net`;
    const jira = new FakeJira();
    jiraSites.set(baseUrl, jira);
    await prisma.deliveryConnector.createMany({
      data: [
        {
          workspaceId: id,
          provider: 'jira',
          displayName: 'Jira',
          baseUrl,
          authKind: 'basic',
          credentialsEncrypted: encrypt(JSON.stringify({ email: 'bot@example.com', apiToken: 'jira-token' })),
          config: { projects: options.projects ?? ['ORD'] },
        },
        {
          workspaceId: id,
          provider: 'github',
          displayName: 'GitHub',
          authKind: 'token',
          credentialsEncrypted: encrypt('github-token'),
          config: {},
        },
      ],
    });
    for (const key of ['orders-api', 'billing-api']) await repository(id, key);
    await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(OWNER))
      .send({ enabled: true, ...options.settings })
      .expect(200);
    return { id, jira };
  }

  async function repository(workspaceId: string, key: string, remote: string | null = `github.com/acme/${key}`) {
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: graphRepoHashOf(key),
        repoName: key,
        intentRepoKey: key,
        normalizedGitRemote: remote,
      },
    });
  }

  async function runs(workspaceId: string) {
    const res = await api()
      .get(`${runsBase(workspaceId)}?limit=100`)
      .set('Authorization', human(MEMBER))
      .expect(200);
    return res.body.runs as Array<Record<string, unknown> & { id: string; issueKey: string; status: string }>;
  }

  async function settings(workspaceId: string) {
    return (
      await api()
        .get(`${runsBase(workspaceId)}/settings`)
        .set('Authorization', human(MEMBER))
        .expect(200)
    ).body;
  }

  function start(workspaceId: string, body: Record<string, unknown>, user = MEMBER) {
    return api().post(runsBase(workspaceId)).set('Authorization', human(user)).send(body);
  }

  /** What a terminal transition does to the run row; cancel and the failure paths arrive with ticket 10. */
  async function finish(runId: string) {
    await prisma.cloudAgentRun.update({ where: { id: runId }, data: { status: 'failed', finishedAt: clock() } });
    await prisma.cloudAgentRunTurn.updateMany({
      where: { runId, state: { in: ['queued', 'claimed'] } },
      data: { state: 'abandoned' },
    });
  }

  it('concurrent trigger ticks create exactly one run per labelled issue, a failing one included; the label never re-creates a run', async () => {
    const { id, jira } = await workspace({ settings: { maxStartedRuns: 5 } });
    jira.issues = [
      { id: '10001', key: 'ORD-1', labels: ['coredoc-agent', 'coredoc-repo:orders-api'] },
      { id: '10002', key: 'ORD-2', labels: ['coredoc-agent', 'coredoc-repo:nope'] },
      { id: '10003', key: 'ORD-3', labels: ['unrelated'] },
      { id: '20001', key: 'OPS-1', labels: ['coredoc-agent'] },
    ];

    await Promise.all([trigger(), trigger(), trigger()]);

    const created = await runs(id);
    expect(created.map((run) => run.issueKey).sort()).toEqual(['ORD-1', 'ORD-2']);
    const started = created.find((run) => run.issueKey === 'ORD-1')!;
    expect(started).toMatchObject({
      trigger: 'jira_label',
      status: 'scoping',
      runOwner: { userId: OWNER.id },
      seeds: ['orders-api'],
      branch: 'coredoc/ORD-1',
      currentTurn: { kind: 'scope', state: 'queued' },
    });
    expect(created.find((run) => run.issueKey === 'ORD-2')).toMatchObject({
      trigger: 'jira_label',
      status: 'failed',
      failureCode: 'invalid_repository_label',
      currentTurn: null,
    });
    expect(jira.searches[0]?.jql).toBe(
      'project in ("ORD") AND labels = "coredoc-agent" AND updated >= "-1d" ORDER BY created ASC',
    );
    expect(jira.searches[0]?.options.expandChangelog).toBe(false);

    await finish(started.id);
    await trigger();
    expect((await runs(id)).map((run) => run.issueKey).sort()).toEqual(['ORD-1', 'ORD-2']);
  });

  it('no project keys means no search, the reason is in settings, and every manual start is refused', async () => {
    const { id, jira } = await workspace({ projects: [] });
    jira.issues = [{ id: '10001', key: 'ORD-1', labels: ['coredoc-agent'] }];

    await trigger();

    expect(jira.searches).toEqual([]);
    expect(await runs(id)).toEqual([]);
    expect((await settings(id)).trigger).toMatchObject({
      ready: false,
      projectKeys: [],
      reasons: [expect.objectContaining({ code: 'no_project_keys' })],
    });
    const refused = await start(id, { issueKey: 'ORD-1' }).expect(400);
    expect(refused.body.code).toBe('ISSUE_NOT_READABLE');
  });

  it('a manual start for an issue outside the configured projects is refused', async () => {
    const { id } = await workspace({ projects: ['ORD'] });
    const refused = await start(id, { issueKey: 'OPS-7' }).expect(400);
    expect(refused.body.code).toBe('ISSUE_NOT_READABLE');
    expect(await runs(id)).toEqual([]);
  });

  it('label seeds that are unknown, ambiguous or not eligible fail with invalid_repository_label; too many fail with too_many_repositories', async () => {
    const { id, jira } = await workspace({ settings: { maxRepositories: 2, maxStartedRuns: 5 } });
    await repository(id, 'Ledger');
    await repository(id, 'ledger');
    await repository(id, 'no-remote', null);
    jira.issues = [
      { id: '1', key: 'ORD-11', labels: ['coredoc-agent', 'coredoc-repo:LEDGER'] },
      { id: '2', key: 'ORD-12', labels: ['coredoc-agent', 'coredoc-repo:no-remote'] },
      {
        id: '3',
        key: 'ORD-13',
        labels: ['coredoc-agent', 'coredoc-repo:orders-api', 'coredoc-repo:billing-api', 'coredoc-repo:ledger'],
      },
      { id: '4', key: 'ORD-14', labels: ['coredoc-agent', 'coredoc-repo:orders-api', 'coredoc-repo:billing-api'] },
    ];

    await trigger();

    const byKey = new Map((await runs(id)).map((run) => [run.issueKey, run]));
    expect(byKey.get('ORD-11')).toMatchObject({ status: 'failed', failureCode: 'invalid_repository_label' });
    expect(byKey.get('ORD-11')?.failureReason).toContain('coredoc-repo:LEDGER');
    expect(byKey.get('ORD-12')).toMatchObject({ status: 'failed', failureCode: 'invalid_repository_label' });
    expect(byKey.get('ORD-12')?.failureReason).toContain('repository_remote_missing');
    expect(byKey.get('ORD-13')).toMatchObject({ status: 'failed', failureCode: 'too_many_repositories' });
    expect(byKey.get('ORD-14')).toMatchObject({ status: 'scoping', seeds: ['orders-api', 'billing-api'] });
  });

  it('a manual start validates its repository keys and stores them as seeds', async () => {
    const { id } = await workspace({ settings: { maxRepositories: 2 } });

    const unknown = await start(id, { issueKey: 'ORD-21', repositoryKeys: ['orders-api', 'nope'] }).expect(400);
    expect(unknown.body.code).toBe('UNKNOWN_REPOSITORY');
    const tooMany = await start(id, {
      issueKey: 'ORD-21',
      repositoryKeys: ['orders-api', 'billing-api', 'orders-api-2'],
    }).expect(400);
    expect(tooMany.body.code).toBe('TOO_MANY_REPOSITORIES');
    expect(await runs(id)).toEqual([]);

    const started = await start(id, { issueKey: 'ORD-21', repositoryKeys: ['billing-api'] }).expect(201);
    expect(started.body).toMatchObject({ trigger: 'manual', seeds: ['billing-api'], runOwner: { userId: MEMBER.id } });
  });

  it('a removed run owner stops Jira-triggered creation with a reason until an admin takes over', async () => {
    const { id, jira } = await workspace();
    jira.issues = [{ id: '10031', key: 'ORD-31', labels: ['coredoc-agent'] }];
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: id, userId: OWNER.id } } });

    await trigger();
    expect(jira.searches).toEqual([]);
    expect(await runs(id)).toEqual([]);
    expect((await settings(id)).trigger.reasons).toEqual([expect.objectContaining({ code: 'run_owner_removed' })]);

    await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ takeOverOwnership: true })
      .expect(200);
    await trigger();
    expect(await runs(id)).toEqual([
      expect.objectContaining({
        issueKey: 'ORD-31',
        trigger: 'jira_label',
        runOwner: expect.objectContaining({ userId: ADMIN.id }),
      }),
    ]);
  });

  it('the concurrency queue starts runs oldest first under concurrent manual starts and promotion', async () => {
    const { id } = await workspace({ settings: { maxStartedRuns: 1 } });

    const results = await Promise.all(['ORD-41', 'ORD-42', 'ORD-43'].map((issueKey) => start(id, { issueKey })));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201]);
    const first = await runs(id);
    const startedFirst = first.filter((run) => run.status === 'scoping');
    expect(startedFirst).toHaveLength(1);
    const queued = first
      .filter((run) => run.status === 'queued')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    expect(queued).toHaveLength(2);
    expect(queued.every((run) => run.currentTurn === null)).toBe(true);
    // The started run is the one created first.
    expect(String(startedFirst[0]!.createdAt) < String(queued[0]!.createdAt)).toBe(true);

    await finish(startedFirst[0]!.id);
    await Promise.all([trigger(), trigger()]);

    const after = new Map((await runs(id)).map((run) => [run.id, run]));
    expect(after.get(queued[0]!.id)).toMatchObject({
      status: 'scoping',
      currentTurn: { kind: 'scope', state: 'queued' },
    });
    expect(after.get(queued[1]!.id)).toMatchObject({ status: 'queued', currentTurn: null });
  });

  it('while unavailable, starting and switching on are refused with the reasons, and queued runs stay queued', async () => {
    const { id } = await workspace({ settings: { maxStartedRuns: 1 } });
    await start(id, { issueKey: 'ORD-51' }).expect(201);
    const { body: waiting } = await start(id, { issueKey: 'ORD-52' }).expect(201);
    expect(waiting.status).toBe('queued');

    await prisma.deliveryConnector.updateMany({
      where: { workspaceId: id, provider: 'github' },
      data: { status: 'paused' },
    });
    const view = await settings(id);
    expect(view.availability).toEqual({
      available: false,
      reasons: [expect.objectContaining({ code: 'github_connector_inactive' })],
    });

    const refused = await start(id, { issueKey: 'ORD-53' }).expect(400);
    expect(refused.body.code).toBe('AGENT_RUNS_UNAVAILABLE');

    const started = (await runs(id)).find((run) => run.status === 'scoping')!;
    await finish(started.id);
    await trigger();
    expect((await runs(id)).find((run) => run.id === waiting.id)).toMatchObject({ status: 'queued' });

    await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(OWNER))
      .send({ enabled: false })
      .expect(200);
    const switchOn = await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(OWNER))
      .send({ enabled: true })
      .expect(400);
    expect(switchOn.body.code).toBe('AGENT_RUNS_UNAVAILABLE');
  });

  it('re-run creates a new run for the same issue from a terminal run, linked to it, on the next branch', async () => {
    const { id } = await workspace({ settings: { maxStartedRuns: 5 } });
    const { body: first } = await start(id, {
      issueKey: 'ORD-61',
      questionsPolicy: 'assume',
      scopeAcceptancePolicy: 'automatic',
      repositoryKeys: ['orders-api'],
    }).expect(201);

    const early = await api()
      .post(`${runsBase(id)}/${first.id}/rerun`)
      .set('Authorization', human(OTHER_MEMBER))
      .expect(409);
    expect(early.body.code).toBe('RUN_NOT_TERMINAL');

    await finish(first.id);
    await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(OWNER))
      .send({ model: 'test-model', maxSpendUsd: 40 })
      .expect(200);
    const rerun = await api()
      .post(`${runsBase(id)}/${first.id}/rerun`)
      .set('Authorization', human(OTHER_MEMBER))
      .expect(201);
    expect(rerun.body).toMatchObject({
      issueKey: 'ORD-61',
      trigger: 'rerun',
      previousRunId: first.id,
      branch: 'coredoc/ORD-61-2',
      status: 'scoping',
      runOwner: { userId: OTHER_MEMBER.id },
      questionsPolicy: 'assume',
      scopeAcceptancePolicy: 'automatic',
      seeds: ['orders-api'],
      model: 'test-model',
      spend: { maxUsd: 40 },
    });

    const again = await api()
      .post(`${runsBase(id)}/${first.id}/rerun`)
      .set('Authorization', human(MEMBER))
      .expect(409);
    expect(again.body.code).toBe('ACTIVE_RUN_EXISTS');
  });

  it('settings save policies, budgets, trigger label, done status and model without changing the run owner', async () => {
    const { id } = await workspace();
    const saved = await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(ADMIN))
      .send({
        triggerLabel: 'ai-build',
        doneStatus: { id: '31', name: 'In Review' },
        questionsPolicy: 'assume',
        scopeAcceptancePolicy: 'automatic',
        maxSpendUsd: 10,
        maxTurnDurationSeconds: 3600,
        maxActiveSeconds: 7200,
        waitingLimitSeconds: 86_400,
        maxStartedRuns: 3,
        maxRepositories: 4,
        model: 'test-model',
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      runOwner: { userId: OWNER.id, valid: true },
      triggerLabel: 'ai-build',
      doneStatus: { id: '31', name: 'In Review' },
      questionsPolicy: 'assume',
      maxStartedRuns: 3,
      model: 'test-model',
      repositories: expect.arrayContaining([
        expect.objectContaining({ key: 'orders-api', eligible: true, reason: null }),
      ]),
    });

    const invalid = await api()
      .put(`${runsBase(id)}/settings`)
      .set('Authorization', human(ADMIN))
      .send({ triggerLabel: 'has space' })
      .expect(400);
    expect(invalid.body.message).toBeDefined();
  });
});
