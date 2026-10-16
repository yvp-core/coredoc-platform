import '../../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import {
  CodeChangeState,
  DeliveryProvider,
  Prisma,
  PrismaClient,
  type PushJob,
} from '../../generated/prisma/client.js';
import { CaptureService } from '../capture/capture.service.js';
import { IntentReleaseService } from '../intent/intent-release.service.js';
import { JobProcessor } from '../jobs/job-processor.service.js';
import {
  GITHUB_CANONICAL_PROJECTION_VERSION,
  GithubCanonicalProjectionService,
} from './github-canonical-projection.service.js';
import { GithubCodeChangePersistenceService } from './github-code-change-persistence.service.js';
import { GithubIntentReleaseService } from '../intent/github-intent-release.service.js';
import { CODE_CHANGE_NORM_VERSION, normalizePullRequest } from './github-normalizer.js';
import { RenormalizeService } from './renormalize.service.js';

// C0.7=B: every provider-shaped value in this suite is synthetic. No real or
// redacted GitHub workspace fixture was supplied before provider acceptance.
const TEST_DATABASE_URL = process.env.GITHUB_CANONICAL_TEST_DATABASE_URL ?? '';
const RUN = `github-canonical-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const OBSERVED_AT = new Date('2026-08-17T12:00:00.000Z');

type ChangeSeed = {
  repo: string;
  number: number;
  workspaceRepoId?: string | null;
  issueKeys?: string[];
  runIds?: string[];
  runIdsPartial?: true;
  commitsIncomplete?: boolean;
  truncated?: boolean;
  mergedAt?: Date;
  /** Provider reviews stored verbatim in the raw envelope, with one commit inside each window. */
  reviews?: { id: number; state: string; submitted_at: string; html_url?: string }[];
  projectionVersion?: number | null;
};

describe.skipIf(!TEST_DATABASE_URL)('GitHub canonical projection (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let projection: GithubCanonicalProjectionService;
  let codeChanges: GithubCodeChangePersistenceService;
  let replay: RenormalizeService;
  let capture: CaptureService;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    const prismaService = prisma as unknown as PrismaService;
    // A `manual` workspace (the default for every workspace this suite creates) leaves
    // the intent actors inert, so the real service is wired rather than a stub.
    projection = new GithubCanonicalProjectionService(
      prismaService,
      new GithubIntentReleaseService(prismaService, new IntentReleaseService(prismaService)),
    );
    codeChanges = new GithubCodeChangePersistenceService(prismaService);
    replay = new RenormalizeService(prismaService, codeChanges, projection);
    capture = new CaptureService(prismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  async function createGithubConnector(workspaceId: string, suffix: string): Promise<string> {
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: DeliveryProvider.github,
        providerVariant: suffix,
        displayName: `Synthetic GitHub ${suffix}`,
        config: { repos: [`synthetic/${suffix}`] },
      },
      select: { id: true },
    });
    return connector.id;
  }

  async function createTask(workspaceId: string, suffix: string, repositoryKey?: string): Promise<string> {
    const id = `cdt_${randomUUID()}`;
    await prisma.deliveryTask.create({
      data: {
        workspaceId,
        id,
        repositoryKey,
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: `synthetic:${suffix}`,
      },
    });
    return id;
  }

  async function createWorkspaceRepo(
    workspaceId: string,
    suffix: string,
    githubRepo: string,
    captureRepositoryKey: string,
  ): Promise<string> {
    const repo = await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: `${RUN}-${suffix}`,
        repoName: `Synthetic ${suffix}`,
        gitUrl: `https://github.com/${githubRepo}.git`,
        captureRepositoryKey,
      },
      select: { id: true },
    });
    return repo.id;
  }

  async function createIssueRef(
    workspaceId: string,
    deliveryTaskId: string,
    externalId: string,
    externalKey: string,
  ): Promise<void> {
    await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId,
        provider: 'jira',
        externalId,
        externalKey,
        externalUrl: `https://synthetic-jira.invalid/browse/${externalKey}`,
      },
    });
  }

  async function createRun(
    workspaceId: string,
    deliveryTaskId: string,
    runId: string,
    repositoryKey: string | null,
  ): Promise<void> {
    const session = await prisma.agentSession.create({
      data: {
        workspaceId,
        provider: 'synthetic-capture',
        sessionId: `${RUN}-${randomUUID()}`,
      },
      select: { id: true },
    });
    await prisma.workflowRun.create({
      data: {
        workspaceId,
        runId,
        agentSessionId: session.id,
        actorId: 'synthetic-actor',
        repositoryKey,
        deliveryTaskId,
      },
    });
  }

  async function createRawAndChange(
    workspaceId: string,
    connectorId: string,
    seed: ChangeSeed,
  ): Promise<{ rawPayloadId: bigint; codeChangeId: string }> {
    const mergedAt = seed.mergedAt?.toISOString();
    const issueKeySources = Object.fromEntries((seed.issueKeys ?? []).map((key) => [key, 'branch']));
    const normalizedRunIds = [...(seed.runIds ?? [])];
    if (seed.runIdsPartial) {
      for (let index = 0; normalizedRunIds.length < 50; index += 1) {
        normalizedRunIds.push(`cdr-20260818-b${index.toString().padStart(5, '0')}`);
      }
    }
    const providerRunIds = seed.runIdsPartial ? [...normalizedRunIds, 'cdr-20260818-cfffff'] : normalizedRunIds;
    const attrs = {
      ...(seed.issueKeys ? { issueKeys: seed.issueKeys, issueKeySources } : {}),
      ...(seed.runIds ? { runIds: normalizedRunIds } : {}),
      ...(seed.runIdsPartial ? { runIdsPartial: true } : {}),
      sourceUpdatedAt: OBSERVED_AT.toISOString(),
    };
    const pr = {
      number: seed.number,
      title: `Synthetic pull request #${seed.number}`,
      body: '',
      state: mergedAt ? 'closed' : 'open',
      draft: false,
      created_at: '2026-08-17T10:00:00.000Z',
      updated_at: OBSERVED_AT.toISOString(),
      merged_at: mergedAt ?? null,
      closed_at: mergedAt ?? null,
      head: {
        ref: seed.issueKeys?.length ? `feature/${seed.issueKeys.join('-')}` : 'feature/synthetic',
      },
      base: { ref: 'main', repo: { full_name: seed.repo } },
      user: { login: 'synthetic-contributor' },
    };
    const raw = await prisma.deliveryRawPayload.create({
      data: {
        workspaceId,
        connectorId,
        resourceType: 'pull_request',
        externalId: String(seed.number),
        payload: {
          repo: seed.repo,
          pr,
          prDetail: {},
          reviews: (seed.reviews ?? []).map((review) => ({
            ...review,
            user: { login: 'synthetic-reviewer', type: 'User' },
          })),
          files: [],
          commits: seed.truncated
            ? []
            : [
                ...providerRunIds.map((runId, index) => ({
                  sha: `${index.toString(16).padStart(40, '0')}`,
                  commit: {
                    message: `Synthetic commit ${index}\n\nCoredoc-Run-Id: ${runId}`,
                    committer: { date: '2026-08-17T11:00:00.000Z' },
                  },
                })),
                // One commit a minute after each review, i.e. inside that review's own window
                // (the next review is seeded at least an hour later).
                ...(seed.reviews ?? []).map((review, index) => ({
                  sha: `re${index.toString(16).padStart(38, '0')}`,
                  commit: {
                    message: `Rework commit ${index}`,
                    committer: { date: new Date(Date.parse(review.submitted_at) + 60_000).toISOString() },
                  },
                })),
              ],
          commitsIncomplete: seed.commitsIncomplete ?? false,
        },
        truncated: seed.truncated ?? false,
        fetchedAt: OBSERVED_AT,
        processedAt: OBSERVED_AT,
        normVersion: CODE_CHANGE_NORM_VERSION,
        canonicalProjectionVersion: seed.projectionVersion ?? null,
      },
      select: { id: true },
    });
    const change = await prisma.codeChange.create({
      data: {
        workspaceId,
        connectorId,
        provider: DeliveryProvider.github,
        repoExternalId: seed.repo,
        workspaceRepoId: seed.workspaceRepoId ?? null,
        externalId: String(seed.number),
        number: seed.number,
        title: pr.title,
        sourceBranch: pr.head.ref,
        targetBranch: pr.base.ref,
        state: mergedAt ? CodeChangeState.merged : CodeChangeState.open,
        isDraft: false,
        createdAtSource: new Date(pr.created_at),
        mergedAt: seed.mergedAt,
        closedAt: seed.mergedAt,
        attrs: attrs as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { rawPayloadId: raw.id, codeChangeId: change.id };
  }

  async function project(workspaceId: string, input: { rawPayloadId: bigint; codeChangeId: string }) {
    return projection.projectRawPayload({ workspaceId, ...input });
  }

  it('keeps synthetic repo A #7 and repo B #7 collision-free and refuses ambiguous or absent issue keys', async () => {
    const workspaceId = await createWorkspace('repo-scope');
    const connectorId = await createGithubConnector(workspaceId, 'repo-scope');
    const exactTaskId = await createTask(workspaceId, 'exact');
    const ambiguousTaskA = await createTask(workspaceId, 'ambiguous-a');
    const ambiguousTaskB = await createTask(workspaceId, 'ambiguous-b');
    await createIssueRef(workspaceId, exactTaskId, `${RUN}-exact`, 'EXACT-7');
    await createIssueRef(workspaceId, ambiguousTaskA, `${RUN}-ambiguous-a`, 'AMB-7');
    await createIssueRef(workspaceId, ambiguousTaskB, `${RUN}-ambiguous-b`, 'AMB-7');

    const repoA = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/repo-a',
      number: 7,
      issueKeys: ['EXACT-7'],
    });
    const repoB = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/repo-b',
      number: 7,
      issueKeys: ['AMB-7', 'MISSING-7'],
    });

    await expect(Promise.all([project(workspaceId, repoA), project(workspaceId, repoB)])).resolves.toHaveLength(2);

    const changes = await prisma.codeChange.findMany({
      where: { workspaceId, externalId: '7' },
      orderBy: { repoExternalId: 'asc' },
    });
    expect(changes.map(({ repoExternalId, externalId }) => ({ repoExternalId, externalId }))).toEqual([
      { repoExternalId: 'synthetic/repo-a', externalId: '7' },
      { repoExternalId: 'synthetic/repo-b', externalId: '7' },
    ]);
    expect(
      await prisma.deliveryTaskCodeChange.findMany({
        where: { workspaceId },
        select: {
          deliveryTaskId: true,
          codeChangeId: true,
          associationSource: true,
          associationSourceValue: true,
        },
      }),
    ).toEqual([
      {
        deliveryTaskId: exactTaskId,
        codeChangeId: repoA.codeChangeId,
        associationSource: 'issue_key',
        associationSourceValue: 'EXACT-7',
      },
    ]);
  });

  it('persists the review rework kinds the widened CHECK constraint allows, idempotently', async () => {
    const workspaceId = await createWorkspace('review-rework');
    const connectorId = await createGithubConnector(workspaceId, 'review-rework');
    const taskId = await createTask(workspaceId, 'review-rework');
    await createIssueRef(workspaceId, taskId, `${RUN}-review-rework`, 'REWORK-7');

    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/review-rework',
      number: 77,
      issueKeys: ['REWORK-7'],
      reviews: [
        {
          id: 5001,
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-17T09:00:00.000Z',
          html_url: 'https://github.com/synthetic/review-rework/pull/77#pullrequestreview-5001',
        },
        { id: 5002, state: 'COMMENTED', submitted_at: '2026-08-17T10:00:00.000Z' },
      ],
    });

    await expect(project(workspaceId, seed)).resolves.toEqual({
      associations: 1,
      shipEvidence: 0,
      reworkSignals: 2,
    });
    const signals = await prisma.deliveryReworkSignal.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: 'asc' },
      select: { deliveryTaskId: true, kind: true, sourceRef: true, occurredAt: true },
    });
    expect(signals).toEqual([
      {
        deliveryTaskId: taskId,
        kind: 'review_changes_requested',
        sourceRef: 'https://github.com/synthetic/review-rework/pull/77#pullrequestreview-5001',
        occurredAt: new Date('2026-08-17T09:00:00.000Z'),
      },
      {
        deliveryTaskId: taskId,
        kind: 'review_commented',
        sourceRef: 'pr#77:review:5002',
        occurredAt: new Date('2026-08-17T10:00:00.000Z'),
      },
    ]);

    // Replay writes nothing new.
    await expect(project(workspaceId, seed)).resolves.toEqual({
      associations: 0,
      shipEvidence: 0,
      reworkSignals: 0,
    });
    expect(await prisma.deliveryReworkSignal.count({ where: { workspaceId } })).toBe(2);
  });

  it('accepts only a complete exact run with matching repository and gives run_id precedence', async () => {
    const workspaceId = await createWorkspace('run-provenance');
    const connectorId = await createGithubConnector(workspaceId, 'run-provenance');
    const workspaceRepoId = await createWorkspaceRepo(
      workspaceId,
      'run-provenance',
      'synthetic/run-repo',
      'capture/run-repo',
    );
    const validTaskId = await createTask(workspaceId, 'valid-run', 'capture/run-repo');
    await createIssueRef(workspaceId, validTaskId, `${RUN}-valid-run`, 'RUN-1');
    const mismatchedTaskId = await createTask(workspaceId, 'mismatch-run', 'capture/other-repo');
    const missingRepoTaskId = await createTask(workspaceId, 'missing-repo');
    const partialTaskId = await createTask(workspaceId, 'partial-run', 'capture/run-repo');
    const incompleteTaskId = await createTask(workspaceId, 'incomplete-run', 'capture/run-repo');
    const truncatedTaskId = await createTask(workspaceId, 'truncated-run', 'capture/run-repo');
    const runIds = {
      valid: 'cdr-20260817-a10001',
      mismatch: 'cdr-20260817-a10002',
      missing: 'cdr-20260817-a10003',
      partial: 'cdr-20260817-a10004',
      incomplete: 'cdr-20260817-a10005',
      truncated: 'cdr-20260817-a10006',
    };
    await Promise.all([
      createRun(workspaceId, validTaskId, runIds.valid, 'capture/run-repo'),
      createRun(workspaceId, mismatchedTaskId, runIds.mismatch, 'capture/other-repo'),
      createRun(workspaceId, missingRepoTaskId, runIds.missing, 'capture/run-repo'),
      createRun(workspaceId, partialTaskId, runIds.partial, 'capture/run-repo'),
      createRun(workspaceId, incompleteTaskId, runIds.incomplete, 'capture/run-repo'),
      createRun(workspaceId, truncatedTaskId, runIds.truncated, 'capture/run-repo'),
    ]);
    const seeds = await Promise.all([
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 11,
        workspaceRepoId,
        issueKeys: ['RUN-1'],
        runIds: [runIds.valid],
      }),
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 12,
        workspaceRepoId,
        runIds: [runIds.mismatch],
      }),
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 13,
        runIds: [runIds.missing],
      }),
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 14,
        workspaceRepoId,
        runIds: [runIds.partial],
        runIdsPartial: true,
      }),
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 15,
        workspaceRepoId,
        runIds: [runIds.incomplete],
        commitsIncomplete: true,
      }),
      createRawAndChange(workspaceId, connectorId, {
        repo: 'synthetic/run-repo',
        number: 16,
        workspaceRepoId,
        runIds: [runIds.truncated],
        truncated: true,
      }),
    ]);

    await Promise.all(seeds.map((seed) => project(workspaceId, seed)));

    expect(
      await prisma.deliveryTaskCodeChange.findMany({
        where: { workspaceId },
        select: {
          deliveryTaskId: true,
          codeChangeId: true,
          associationSource: true,
          associationSourceValue: true,
        },
      }),
    ).toEqual([
      {
        deliveryTaskId: validTaskId,
        codeChangeId: seeds[0]?.codeChangeId,
        associationSource: 'run_id',
        associationSourceValue: runIds.valid,
      },
    ]);
    expect(
      await prisma.deliveryRawPayload.count({
        where: { workspaceId, canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION },
      }),
    ).toBe(seeds.length);
  });

  it('fans one exact V3 run_id association and merge evidence out to both matched canonical tasks', async () => {
    const workspaceId = await createWorkspace('v3-run-provenance');
    const connectorId = await createGithubConnector(workspaceId, 'v3-run-provenance');
    const captureRepositoryKey = 'capture/v3-run-repo';
    const workspaceRepoId = await createWorkspaceRepo(
      workspaceId,
      'v3-run-provenance',
      'synthetic/v3-run-repo',
      captureRepositoryKey,
    );
    const firstTaskId = await createTask(workspaceId, 'v3-run-a', captureRepositoryKey);
    const secondTaskId = await createTask(workspaceId, 'v3-run-b', captureRepositoryKey);
    const firstExternalId = `${RUN}-v3-run-a`;
    const secondExternalId = `${RUN}-v3-run-b`;
    await Promise.all([
      createIssueRef(workspaceId, firstTaskId, firstExternalId, 'V3-RUN-A'),
      createIssueRef(workspaceId, secondTaskId, secondExternalId, 'V3-RUN-B'),
    ]);

    const runId = 'cdr-20260818-d40001';
    const startEventId = randomUUID();
    const start = {
      schemaVersion: 3,
      eventId: startEventId,
      occurredAt: '2026-08-18T11:00:00.000Z',
      host: 'claude-code',
      sessionId: `${RUN}-v3-run-provenance`,
      runId,
      repositoryKey: captureRepositoryKey,
      type: 'workflow.run.started',
      data: {
        workflowId: 'change:high',
        intent: 'change',
        risk: 'high',
        scale: 'large',
        stages: [{ stageId: 'implement', after: [] }],
        workItems: [
          { provider: 'jira', externalId: secondExternalId, externalKey: 'V3-RUN-B' },
          { provider: 'jira', externalId: firstExternalId, externalKey: 'V3-RUN-A' },
        ],
      },
    };
    await expect(
      capture.ingest(
        workspaceId,
        { id: `${RUN}-v3-run-actor`, email: `${RUN}-v3-run@example.com` },
        { events: [start] },
      ),
    ).resolves.toEqual({ acceptedEventIds: [startEventId], duplicateEventIds: [], rejected: [] });
    const persistedRun = await prisma.workflowRun.findUniqueOrThrow({
      where: { workspaceId_runId: { workspaceId, runId } },
      include: { workItems: { orderBy: [{ provider: 'asc' }, { externalId: 'asc' }] } },
    });
    expect(persistedRun.deliveryTaskId).toBeNull();
    expect(persistedRun.workItems.map(({ provider, externalId }) => ({ provider, externalId }))).toEqual([
      { provider: 'jira', externalId: firstExternalId },
      { provider: 'jira', externalId: secondExternalId },
    ]);

    const mergedAt = new Date('2026-08-18T11:30:00.000Z');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/v3-run-repo',
      number: 33,
      workspaceRepoId,
      runIds: [runId],
      mergedAt,
    });
    expect(await prisma.deliveryTaskCodeChange.count({ where: { workspaceId } })).toBe(0);
    await expect(project(workspaceId, seed)).resolves.toEqual({ associations: 2, shipEvidence: 2, reworkSignals: 0 });

    const associations = await prisma.deliveryTaskCodeChange.findMany({
      where: { workspaceId, codeChangeId: seed.codeChangeId },
      orderBy: { deliveryTaskId: 'asc' },
      select: {
        deliveryTaskId: true,
        associationSource: true,
        associationSourceValue: true,
      },
    });
    expect(new Set(associations.map((row) => row.deliveryTaskId))).toEqual(new Set([firstTaskId, secondTaskId]));
    expect(
      associations.map(({ associationSource, associationSourceValue }) => ({
        associationSource,
        associationSourceValue,
      })),
    ).toEqual([
      { associationSource: 'run_id', associationSourceValue: runId },
      { associationSource: 'run_id', associationSourceValue: runId },
    ]);
    const evidence = await prisma.deliveryShipEvidence.findMany({
      where: { workspaceId, source: 'github_pr_merged', externalId: '33' },
      orderBy: { deliveryTaskId: 'asc' },
    });
    expect(new Set(evidence.map((row) => row.deliveryTaskId))).toEqual(new Set([firstTaskId, secondTaskId]));
    expect(evidence).toHaveLength(2);
    expect(evidence.every((row) => row.occurredAt.getTime() === mergedAt.getTime())).toBe(true);
  });

  it('derives immutable merge evidence per task across replay and connector replacement', async () => {
    const workspaceId = await createWorkspace('multi-task-ship');
    const connectorId = await createGithubConnector(workspaceId, 'multi-task-ship');
    const firstTaskId = await createTask(workspaceId, 'ship-a');
    const secondTaskId = await createTask(workspaceId, 'ship-b');
    await createIssueRef(workspaceId, firstTaskId, `${RUN}-ship-a`, 'SHIP-1');
    await createIssueRef(workspaceId, secondTaskId, `${RUN}-ship-b`, 'SHIP-2');
    const mergedAt = new Date('2026-08-17T11:45:00.000Z');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/shipping',
      number: 22,
      issueKeys: ['SHIP-1', 'SHIP-2'],
      mergedAt,
    });

    await expect(Promise.all([project(workspaceId, seed), project(workspaceId, seed)])).resolves.toHaveLength(2);
    await expect(project(workspaceId, seed)).resolves.toBeDefined();

    const associations = await prisma.deliveryTaskCodeChange.findMany({
      where: { workspaceId, codeChangeId: seed.codeChangeId },
      orderBy: { deliveryTaskId: 'asc' },
    });
    expect(associations).toHaveLength(2);
    expect(new Set(associations.map((row) => row.deliveryTaskId))).toEqual(new Set([firstTaskId, secondTaskId]));
    const evidence = await prisma.deliveryShipEvidence.findMany({
      where: { workspaceId, source: 'github_pr_merged' },
      orderBy: { deliveryTaskId: 'asc' },
    });
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((row) => row.deliveryTaskId))).toEqual(new Set([firstTaskId, secondTaskId]));
    expect(new Set(evidence.map((row) => row.sourceKey)).size).toBe(2);
    for (const row of evidence) {
      expect(row).toMatchObject({
        source: 'github_pr_merged',
        occurredAt: mergedAt,
        provider: 'github',
        repoExternalId: 'synthetic/shipping',
        externalId: '22',
      });
    }

    // Historical evidence identifies the provider PR, task, and workspace rather
    // than either connector or CodeChange surrogate. Replacing the connector and
    // re-importing the same PR therefore recreates only the typed associations.
    const sourceKeys = evidence.map((row) => row.sourceKey).sort();
    await prisma.deliveryConnector.delete({ where: { id: connectorId } });
    expect(await prisma.deliveryShipEvidence.count({ where: { workspaceId } })).toBe(2);
    const replacementConnectorId = await createGithubConnector(workspaceId, 'multi-task-ship-replacement');
    const replacement = await createRawAndChange(workspaceId, replacementConnectorId, {
      repo: 'synthetic/shipping',
      number: 22,
      issueKeys: ['SHIP-1', 'SHIP-2'],
      mergedAt,
    });
    await expect(project(workspaceId, replacement)).resolves.toBeDefined();
    const afterReplacement = await prisma.deliveryShipEvidence.findMany({
      where: { workspaceId, source: 'github_pr_merged' },
      orderBy: { sourceKey: 'asc' },
    });
    expect(afterReplacement).toHaveLength(2);
    expect(afterReplacement.map((row) => row.sourceKey)).toEqual(sourceKeys);
    expect(
      await prisma.deliveryTaskCodeChange.count({
        where: { workspaceId, codeChangeId: replacement.codeChangeId },
      }),
    ).toBe(2);
  });

  it('replays a norm-v4 projection-null row and converges with a concurrent live projector call', async () => {
    const workspaceId = await createWorkspace('concurrent-replay');
    const connectorId = await createGithubConnector(workspaceId, 'concurrent-replay');
    const taskId = await createTask(workspaceId, 'concurrent-replay');
    await createIssueRef(workspaceId, taskId, `${RUN}-concurrent-replay`, 'REPLAY-4');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/replay',
      number: 44,
      issueKeys: ['REPLAY-4'],
      mergedAt: new Date('2026-08-17T11:50:00.000Z'),
      projectionVersion: null,
    });

    await expect(
      Promise.all([project(workspaceId, seed), replay.renormalizeWorkspace(workspaceId, { connectorId })]),
    ).resolves.toHaveLength(2);

    expect(await prisma.deliveryTaskCodeChange.count({ where: { workspaceId, codeChangeId: seed.codeChangeId } })).toBe(
      1,
    );
    expect(await prisma.deliveryShipEvidence.count({ where: { workspaceId, source: 'github_pr_merged' } })).toBe(1);
    expect(await prisma.deliveryRawPayload.findUnique({ where: { id: seed.rawPayloadId } })).toMatchObject({
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION,
    });
  });

  it('keeps the fresher live snapshot while stale raw replay projects historical positive evidence', async () => {
    const workspaceId = await createWorkspace('freshness-race');
    const connectorId = await createGithubConnector(workspaceId, 'freshness-race');
    const taskId = await createTask(workspaceId, 'freshness-race');
    await createIssueRef(workspaceId, taskId, `${RUN}-freshness-race`, 'HIST-81');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/freshness-race',
      number: 81,
      issueKeys: ['HIST-81'],
      mergedAt: new Date('2026-08-17T11:30:00.000Z'),
      projectionVersion: null,
    });
    await prisma.deliveryRawPayload.update({
      where: { id: seed.rawPayloadId },
      data: { normVersion: CODE_CHANGE_NORM_VERSION - 1 },
    });

    const freshUpdatedAt = '2026-08-17T14:00:00.000Z';
    const freshMergedAt = new Date('2026-08-17T13:30:00.000Z');
    const freshNorm = normalizePullRequest(
      {
        number: 81,
        title: 'Fresher live pull request snapshot',
        body: '',
        state: 'closed',
        draft: false,
        created_at: '2026-08-17T10:00:00.000Z',
        updated_at: freshUpdatedAt,
        merged_at: freshMergedAt.toISOString(),
        closed_at: freshMergedAt.toISOString(),
        head: { ref: 'feature/current-without-ticket' },
        base: { ref: 'main', repo: { full_name: 'synthetic/freshness-race' } },
        user: { login: 'synthetic-contributor' },
      },
      [],
      [],
      [],
      {},
    );
    if (!freshNorm) throw new Error('Synthetic fresh PR did not normalize');

    const [freshWrite] = await Promise.all([
      codeChanges.persist({
        workspaceId,
        connectorId,
        repoExternalId: 'synthetic/freshness-race',
        externalId: '81',
        sourceUpdatedAt: freshUpdatedAt,
        workspaceRepoId: null,
        norm: freshNorm,
      }),
      replay.renormalizeWorkspace(workspaceId, { connectorId }),
    ]);

    expect(freshWrite).toMatchObject({ id: seed.codeChangeId, applied: 'updated' });
    const current = await prisma.codeChange.findUniqueOrThrow({ where: { id: seed.codeChangeId } });
    expect(current).toMatchObject({ title: freshNorm.title, mergedAt: freshMergedAt });
    expect(current.attrs).toMatchObject({ sourceUpdatedAt: freshUpdatedAt });
    expect(
      await prisma.deliveryTaskCodeChange.findUnique({
        where: {
          workspaceId_deliveryTaskId_codeChangeId: {
            workspaceId,
            deliveryTaskId: taskId,
            codeChangeId: seed.codeChangeId,
          },
        },
      }),
    ).toMatchObject({ associationSource: 'issue_key', associationSourceValue: 'HIST-81' });
    expect(
      await prisma.deliveryShipEvidence.count({
        where: {
          workspaceId,
          deliveryTaskId: taskId,
          source: 'github_pr_merged',
          repoExternalId: 'synthetic/freshness-race',
          externalId: '81',
        },
      }),
    ).toBe(1);
    expect(await prisma.deliveryRawPayload.findUnique({ where: { id: seed.rawPayloadId } })).toMatchObject({
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION,
    });
  });

  it('runs projection-null replay through the job boundary', async () => {
    const workspaceId = await createWorkspace('projection-only-replay');
    const connectorId = await createGithubConnector(workspaceId, 'projection-only-replay');
    const taskId = await createTask(workspaceId, 'projection-only-replay');
    await createIssueRef(workspaceId, taskId, `${RUN}-projection-only-replay`, 'BACKFILL-4');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/backfill',
      number: 45,
      issueKeys: ['BACKFILL-4'],
      // Version 1 is the first canonical projector; the schema therefore uses
      // null, not an invalid zero, to represent every pre-Phase-C raw row.
      projectionVersion: null,
    });

    const processor = new JobProcessor(
      {} as never,
      {} as never,
      { isDeliveryEnabled: async () => true } as never,
      replay,
      {} as never,
    );
    await expect(
      processor.process({
        id: randomUUID(),
        workspaceId,
        type: 'renormalize',
        payload: { connectorId },
      } as PushJob),
    ).resolves.toMatchObject({ scanned: 1, renormalized: 1, skipped: 0 });

    expect(
      await prisma.deliveryTaskCodeChange.findUnique({
        where: {
          workspaceId_deliveryTaskId_codeChangeId: {
            workspaceId,
            deliveryTaskId: taskId,
            codeChangeId: seed.codeChangeId,
          },
        },
      }),
    ).toMatchObject({ associationSource: 'issue_key', associationSourceValue: 'BACKFILL-4' });
    expect(await prisma.deliveryRawPayload.findUnique({ where: { id: seed.rawPayloadId } })).toMatchObject({
      normVersion: CODE_CHANGE_NORM_VERSION,
      canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION,
    });
  });

  it('does not stamp canonical projection when the workspace-scoped projection fails', async () => {
    const workspaceId = await createWorkspace('failure-stamp');
    const connectorId = await createGithubConnector(workspaceId, 'failure-stamp');
    const taskId = await createTask(workspaceId, 'failure-stamp');
    await createIssueRef(workspaceId, taskId, `${RUN}-failure-stamp`, 'FAIL-1');
    const seed = await createRawAndChange(workspaceId, connectorId, {
      repo: 'synthetic/failure',
      number: 51,
      issueKeys: ['FAIL-1'],
      projectionVersion: null,
    });
    const otherWorkspaceId = await createWorkspace('failure-stamp-other');
    const otherConnectorId = await createGithubConnector(otherWorkspaceId, 'failure-stamp-other');
    const otherSeed = await createRawAndChange(otherWorkspaceId, otherConnectorId, {
      repo: 'synthetic/other',
      number: 51,
    });

    await expect(
      projection.projectRawPayload({
        workspaceId,
        rawPayloadId: seed.rawPayloadId,
        codeChangeId: otherSeed.codeChangeId,
      }),
    ).rejects.toBeDefined();
    expect(await prisma.deliveryRawPayload.findUnique({ where: { id: seed.rawPayloadId } })).toMatchObject({
      canonicalProjectionVersion: null,
    });

    await expect(project(workspaceId, seed)).resolves.toBeDefined();
    expect(await prisma.deliveryRawPayload.findUnique({ where: { id: seed.rawPayloadId } })).toMatchObject({
      canonicalProjectionVersion: GITHUB_CANONICAL_PROJECTION_VERSION,
    });
  });
});
