import { seedMembers } from '../../database/seed-members.test-support.js';
import '../../config/load-env.js';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryKind, PhaseGate, RepositoryMode, type WorkflowShape } from '@coredoc/core/agent-runner';
import { AuthService } from '../../auth/auth.service.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { CloudAgentRunConsultantService } from './cloud-agent-run-consultant.service.js';
import { CloudAgentRunsConsultantController } from './cloud-agent-runs-consultant.controller.js';
import { DEFAULT_WORKFLOW } from './cloud-agent-runs.test-support.js';

const TEST_DATABASE_URL = process.env.CLOUD_AGENT_RUNS_TEST_DATABASE_URL ?? '';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const user = (role: string) => ({ id: `${RUN}-${role}`, email: `${role}@example.test`, role });
const OWNER = user('owner');
const ADMIN = user('admin');
const MEMBER = user('member');
const PRODUCT = user('product');
const SUPPORT = user('support');
const CONSULTANT = user('consultant');
const USERS = [OWNER, ADMIN, MEMBER, PRODUCT, SUPPORT, CONSULTANT];

const NO_REPOSITORY: WorkflowShape = {
  id: 'review',
  title: 'Review',
  repositories: RepositoryMode.None,
  delivery: DeliveryKind.None,
  phases: [
    { id: 'questions', gate: PhaseGate.Acceptance },
    { id: 'report', gate: PhaseGate.None },
  ],
};

const ASKED = [
  {
    question: 'Which total applies?',
    header: 'Total',
    options: [
      { label: 'Gross', description: 'Before deductions' },
      { label: 'Net', description: 'After deductions' },
    ],
    multiSelect: false,
  },
];

const RUN_KEYS = ['createdAt', 'id', 'name', 'openQuestions', 'unansweredQuestions', 'updatedAt'];
const RECORD_KEYS = ['answeredAt', 'answers', 'askedAt', 'questions', 'requestId', 'state'];

describe.skipIf(!TEST_DATABASE_URL)('consultant runs API (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let previousDatabaseUrl: string | undefined;
  let app: INestApplication;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let seed = 0;

  /** Runs of `workspaceId`, oldest first: each a minute after the previous. */
  const base = new Date('2026-11-01T10:00:00.000Z');
  async function createRun(shape: WorkflowShape, issueTitle: string | null = null, inWorkspace = workspaceId) {
    seed += 1;
    return prisma.cloudAgentRun.create({
      data: {
        workspaceId: inWorkspace,
        jiraIssueId: `${RUN}-${seed}`,
        issueKey: `ACME-${seed}`,
        issueTitle,
        trigger: 'manual',
        startedBy: OWNER.id,
        runOwnerId: OWNER.id,
        status: 'done',
        phase: shape.phases.at(-1)!.id,
        scopeQuestionsPolicy: 'pause',
        scopeAcceptancePolicy: 'required',
        runOrdinal: 1,
        branch: `coredoc/ACME-${seed}`,
        workflow: shape.id,
        workflowShape: shape as never,
        sessionIds: {},
        maxSpendUsd: 10,
        maxActiveSeconds: 3600,
        waitingLimitSeconds: 3600,
        maxTurnDurationSeconds: 600,
        maxRepositories: 3,
        createdAt: new Date(base.getTime() + seed * 60_000),
      },
    });
  }

  async function ask(runId: string, kind: string, state: string, minutes: number) {
    const askedAt = new Date(base.getTime() + minutes * 60_000);
    const answered = state === 'answered' || state === 'auto_answered';
    return prisma.cloudAgentRunQuestion.create({
      data: {
        workspaceId,
        runId,
        kind,
        phase: 'questions',
        state,
        toolUseId: `tool-${minutes}`,
        questions: ASKED,
        answers: answered ? [{ labels: ['Net'] }] : undefined,
        askedAt,
        answeredAt: answered ? new Date(askedAt.getTime() + 1_000) : null,
        answeredBy: state === 'answered' ? OWNER.id : null,
      },
    });
  }

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    pool = buildPrismaAdapter();
    prisma = new PrismaClient({ adapter: pool?.adapter } as never);
    await prisma.$connect();

    workspaceId = (await prisma.workspace.create({ data: { name: `acme-${RUN}`, slug: `acme-${RUN}` } })).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { name: `acme-other-${RUN}`, slug: `acme-other-${RUN}` } })
    ).id;
    await seedMembers(
      prisma,
      USERS.map(({ id, email, role }) => ({ workspaceId, userId: id, email, role })),
    );

    const users = new Map(USERS.map((u) => [u.id, { id: u.id, email: u.email }]));
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudAgentRunsConsultantController],
      providers: [
        { provide: PrismaService, useValue: prisma as unknown as PrismaService },
        ControlPlaneService,
        CloudAgentRunConsultantService,
        {
          provide: AuthService,
          useValue: {
            async verifyAccessToken(token: string) {
              const found = users.get(token.replace(/^jwt:/, ''));
              if (!found) throw new Error('unknown test user');
              return found;
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
    for (const id of [workspaceId, otherWorkspaceId]) {
      if (id) await prisma.workspace.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  const get = (path: string, as: { id: string } = CONSULTANT, inWorkspace = workspaceId) =>
    request(app.getHttpServer())
      .get(`/api/v1/workspaces/${inWorkspace}/consultant-runs${path}`)
      .set('Authorization', `Bearer jwt:${as.id}`);

  it('lists only runs on no repository, newest first, with their counts and nothing else', async () => {
    const older = await createRun(NO_REPOSITORY, 'Overtime rules');
    await createRun(DEFAULT_WORKFLOW, 'Order exports');
    const newer = await createRun(NO_REPOSITORY);
    await createRun(NO_REPOSITORY, 'Elsewhere', otherWorkspaceId);
    // A run holds at most one open question of either kind.
    await ask(older.id, 'clarification', 'open', 1);
    await ask(older.id, 'clarification', 'cancelled', 2);
    await ask(older.id, 'clarification', 'cancelled', 3);
    await ask(older.id, 'clarification', 'answered', 4);
    await ask(older.id, 'clarification', 'auto_answered', 5);
    await ask(older.id, 'repository_request', 'cancelled', 6);
    await ask(newer.id, 'repository_request', 'open', 7);

    const { body } = await get('').expect(200);

    expect(body).toEqual({
      runs: [
        {
          id: newer.id,
          name: null,
          createdAt: newer.createdAt.toISOString(),
          updatedAt: newer.updatedAt.toISOString(),
          openQuestions: 0,
          unansweredQuestions: 0,
        },
        {
          id: older.id,
          name: 'Overtime rules',
          createdAt: older.createdAt.toISOString(),
          updatedAt: older.updatedAt.toISOString(),
          openQuestions: 1,
          unansweredQuestions: 2,
        },
      ],
      nextOffset: null,
    });
    for (const run of body.runs) expect(Object.keys(run).sort()).toEqual(RUN_KEYS);
  });

  it('pages with limit and offset', async () => {
    const all = (await get('').expect(200)).body.runs.map((run: { id: string }) => run.id);
    expect(all.length).toBeGreaterThanOrEqual(2);

    const first = await get('?limit=1').expect(200);
    expect(first.body.runs.map((run: { id: string }) => run.id)).toEqual([all[0]]);
    expect(first.body.nextOffset).toBe(1);

    const last = await get(`?limit=1&offset=${all.length - 1}`).expect(200);
    expect(last.body.runs.map((run: { id: string }) => run.id)).toEqual([all.at(-1)]);
    expect(last.body.nextOffset).toBeNull();

    await get('?limit=0').expect(400);
    await get('?limit=101').expect(400);
    await get('?offset=-1').expect(400);
  });

  it("returns a run's clarification records newest first, without auto-answered ones or repository requests", async () => {
    const run = await createRun(NO_REPOSITORY, 'Leave balance');
    const open = await ask(run.id, 'clarification', 'open', 30);
    const answered = await ask(run.id, 'clarification', 'answered', 20);
    const cancelled = await ask(run.id, 'clarification', 'cancelled', 10);
    await ask(run.id, 'clarification', 'auto_answered', 40);
    await ask(run.id, 'repository_request', 'cancelled', 50);

    const { body } = await get(`/${run.id}/questions`).expect(200);

    expect(body.run).toEqual({
      id: run.id,
      name: 'Leave balance',
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    });
    expect(body.records.map((record: { requestId: string }) => record.requestId)).toEqual([
      open.requestId,
      answered.requestId,
      cancelled.requestId,
    ]);
    expect(body.records[1]).toEqual({
      requestId: answered.requestId,
      state: 'answered',
      questions: ASKED,
      answers: [{ labels: ['Net'] }],
      askedAt: answered.askedAt.toISOString(),
      answeredAt: answered.answeredAt!.toISOString(),
    });
    expect(body.records[0]).toMatchObject({ state: 'open', answers: null, answeredAt: null });
    expect(Object.keys(body).sort()).toEqual(['records', 'run']);
    expect(Object.keys(body.run).sort()).toEqual(['createdAt', 'id', 'name', 'updatedAt']);
    for (const record of body.records) expect(Object.keys(record).sort()).toEqual(RECORD_KEYS);
  });

  it('answers 404 for a run on a repository and for a run of another workspace', async () => {
    const onRepository = await createRun(DEFAULT_WORKFLOW, 'Order exports');
    await ask(onRepository.id, 'clarification', 'open', 60);
    const elsewhere = await createRun(NO_REPOSITORY, 'Elsewhere', otherWorkspaceId);

    const repositoryRun = await get(`/${onRepository.id}/questions`).expect(404);
    const foreignRun = await get(`/${elsewhere.id}/questions`).expect(404);
    const missing = await get(`/00000000-0000-4000-8000-000000000000/questions`).expect(404);
    expect(repositoryRun.body).toEqual(missing.body);
    expect(foreignRun.body).toEqual(missing.body);
  });

  it('admits consultant, admin and owner; refuses member, product, support and non-members', async () => {
    const run = await createRun(NO_REPOSITORY);
    for (const as of [CONSULTANT, ADMIN, OWNER]) {
      await get('', as).expect(200);
      await get(`/${run.id}/questions`, as).expect(200);
    }
    for (const as of [MEMBER, PRODUCT, SUPPORT]) {
      await get('', as).expect(403);
      await get(`/${run.id}/questions`, as).expect(403);
    }
    await get('', CONSULTANT, otherWorkspaceId).expect(403);
  });
});
