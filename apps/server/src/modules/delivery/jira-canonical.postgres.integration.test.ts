import '../../config/load-env.js';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import { encrypt } from '../../database/encryption.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { DeliveryProvider, PrismaClient } from '../../generated/prisma/client.js';
import { CaptureService } from '../capture/capture.service.js';
import { ActorRegistryService } from './actor-registry.service.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { JiraImporterService } from './jira-importer.service.js';
import { StatusMapService } from './status-map.service.js';

// Every Jira response below is an inline synthetic provider-shaped payload. No
// provider account, network request, or genuine/redacted workspace fixture is used.
const TEST_DATABASE_URL = process.env.JIRA_CANONICAL_TEST_DATABASE_URL ?? '';
const RUN = `jira-canonical-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const SYNTHETIC_ENCRYPTION_KEY = '7a'.repeat(32);

type SyntheticHistory = {
  id: string;
  created: string;
  author: { accountId: string; displayName: string; accountType: string };
  items: { field: string; fromString: string; toString: string }[];
};

type SyntheticIssue = ReturnType<typeof syntheticIssue>;

function syntheticHistory(id: string, from: string, to: string, occurredAt: string): SyntheticHistory {
  return {
    id,
    created: occurredAt,
    author: {
      accountId: 'synthetic-jira-actor',
      displayName: 'Synthetic Jira Actor',
      accountType: 'atlassian',
    },
    items: [{ field: 'status', fromString: from, toString: to }],
  };
}

function syntheticIssue(input: {
  id: string;
  key: string;
  status: string;
  updated: string;
  histories: SyntheticHistory[];
}) {
  return {
    id: input.id,
    key: input.key,
    fields: {
      summary: `Synthetic issue ${input.key}`,
      status: { name: input.status },
      issuetype: { name: 'Story' },
      created: '2026-08-17T08:00:00.000Z',
      updated: input.updated,
      resolutiondate: input.status === 'Done' ? input.updated : null,
      assignee: null,
      reporter: null,
      labels: ['synthetic-provider-fixture'],
      parent: null,
      priority: { name: 'High' },
      project: { key: 'SYN' },
    },
    changelog: { total: input.histories.length, histories: input.histories },
  };
}

function syntheticClient(pages: SyntheticIssue[][]) {
  let page = 0;
  return {
    listStatuses: vi.fn().mockResolvedValue([
      { id: '1', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      { id: '2', name: 'Done', statusCategory: { key: 'done' } },
    ]),
    listProjectStatuses: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn(async () => ({
      items: pages[Math.min(page++, pages.length - 1)] ?? [],
      nextPageToken: null,
    })),
    listChangelog: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      nextStartAt: null,
      incomplete: false,
    }),
  };
}

describe.skipIf(!TEST_DATABASE_URL)('Jira canonical projection (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let canonical: CanonicalDeliveryService;
  let projection: JiraCanonicalProjectionService;
  let actorRegistry: ActorRegistryService;
  let statusMap: StatusMapService;
  let capture: CaptureService;
  let previousDatabaseUrl: string | undefined;
  let previousEncryptionKey: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousEncryptionKey = process.env.SERVER_ENCRYPTION_KEY;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SERVER_ENCRYPTION_KEY = SYNTHETIC_ENCRYPTION_KEY;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    const prismaService = prisma as unknown as PrismaService;
    canonical = new CanonicalDeliveryService(prismaService);
    actorRegistry = new ActorRegistryService(prismaService);
    statusMap = new StatusMapService(prismaService);
    projection = new JiraCanonicalProjectionService(prismaService, statusMap);
    capture = new CaptureService(prismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      // Workspace cascade is itself part of the C1 exact-authority contract. A
      // cleanup failure must stay visible instead of leaking rows and hiding an FK regression.
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    await prisma.$disconnect();
    if (pool?.pool) await pool.pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.SERVER_ENCRYPTION_KEY;
    else process.env.SERVER_ENCRYPTION_KEY = previousEncryptionKey;
  });

  async function createWorkspace(suffix: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: `${RUN}-${suffix}`, slug: `${RUN}-${suffix}` },
    });
    workspaceIds.push(workspace.id);
    return workspace.id;
  }

  async function createConnector(workspaceId: string, suffix: string): Promise<string> {
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: DeliveryProvider.jira,
        providerVariant: suffix,
        displayName: `Synthetic Jira ${suffix}`,
        baseUrl: 'https://synthetic-jira.invalid',
        authKind: 'api_token',
        credentialsEncrypted: encrypt(
          JSON.stringify({ email: 'synthetic-bot@example.invalid', apiToken: 'synthetic-token' }),
        ),
        config: {},
        cursors: {},
      },
      select: { id: true },
    });
    return connector.id;
  }

  async function createCanonicalStatusPolicy(workspaceId: string, connectorId: string): Promise<void> {
    await prisma.deliveryStatusMap.createMany({
      data: [
        {
          workspaceId,
          connectorId,
          statusRaw: 'In Progress',
          lifecycle: 'active',
          createsShipEvidence: false,
          source: 'admin',
        },
        {
          workspaceId,
          connectorId,
          statusRaw: 'Done',
          lifecycle: 'completed',
          createsShipEvidence: true,
          source: 'admin',
        },
      ],
    });
  }

  function importer(client: ReturnType<typeof syntheticClient>): JiraImporterService {
    const Constructor = JiraImporterService as unknown as new (
      prismaService: PrismaService,
      actors: ActorRegistryService,
      statuses: StatusMapService,
      canonicalDelivery: CanonicalDeliveryService,
      jiraProjection: JiraCanonicalProjectionService,
      clientFactory: () => ReturnType<typeof syntheticClient>,
    ) => JiraImporterService;
    return new Constructor(
      prisma as unknown as PrismaService,
      actorRegistry,
      statusMap,
      canonical,
      projection,
      () => client,
    );
  }

  it('converges synthetic import, refetch, and detach/reattach onto one task and stable historical evidence', async () => {
    const workspaceId = await createWorkspace('authoritative');
    const connectorId = await createConnector(workspaceId, 'authoritative');
    await createCanonicalStatusPolicy(workspaceId, connectorId);

    const closed = syntheticHistory('synthetic-history-close', 'In Progress', 'Done', '2026-08-17T09:00:00.000Z');
    // Provider edits stay in the bounded raw row; canonical projection consumes
    // lifecycle transitions and current task facts only.
    closed.items.push({
      field: 'summary',
      fromString: 'Synthetic issue before edit',
      toString: 'Synthetic issue after edit',
    });
    const reopened = syntheticHistory('synthetic-history-reopen', 'Done', 'In Progress', '2026-08-17T11:00:00.000Z');
    const first = syntheticIssue({
      id: 'synthetic-issue-10001',
      key: 'SYN-1',
      status: 'Done',
      updated: '2026-08-17T10:00:00.000Z',
      histories: [closed],
    });
    const changed = syntheticIssue({
      id: 'synthetic-issue-10001',
      key: 'RENAMED-9',
      status: 'In Progress',
      updated: '2026-08-17T12:00:00.000Z',
      // Provider order is intentionally newest-first; the projector owns chronology.
      histories: [reopened, closed],
    });
    const jira = syntheticClient([[first], [changed], [changed]]);
    const service = importer(jira);

    await expect(service.syncConnector(connectorId)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });
    await expect(service.syncConnector(connectorId)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    // An operational cursor reset causes a full provider refetch, not a second identity.
    await prisma.deliveryConnector.update({ where: { id: connectorId }, data: { cursors: {} } });
    await expect(service.syncConnector(connectorId)).resolves.toEqual({
      issues: 0,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    const [tasks, refs, facts, shipEvidence, reworkSignals, rawRows] = await Promise.all([
      prisma.deliveryTask.findMany({ where: { workspaceId } }),
      prisma.taskExternalRef.findMany({ where: { workspaceId } }),
      prisma.taskExternalRefStateFact.findMany({ where: { workspaceId }, orderBy: { occurredAt: 'asc' } }),
      prisma.deliveryShipEvidence.findMany({ where: { workspaceId } }),
      prisma.deliveryReworkSignal.findMany({ where: { workspaceId } }),
      prisma.deliveryRawPayload.findMany({ where: { workspaceId, connectorId }, orderBy: { id: 'asc' } }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(refs).toHaveLength(1);
    const task = tasks[0];
    const ref = refs[0];
    if (!task || !ref) throw new Error('Synthetic Jira import did not create its canonical identity');
    expect(task).toMatchObject({
      id: ref.deliveryTaskId,
      lifecycle: 'active',
      authority: 'connector:jira',
      authorityRefId: ref.id,
      createdBy: `connector:${connectorId}`,
    });
    expect(ref).toMatchObject({
      connectorId,
      externalId: 'synthetic-issue-10001',
      externalKey: 'RENAMED-9',
      externalUrl: 'https://synthetic-jira.invalid/browse/RENAMED-9',
      externalState: 'In Progress',
      sourceUpdatedAt: new Date('2026-08-17T12:00:00.000Z'),
    });
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => [fact.fromState, fact.toState, fact.occurredAt.toISOString()])).toEqual([
      ['In Progress', 'Done', '2026-08-17T09:00:00.000Z'],
      ['Done', 'In Progress', '2026-08-17T11:00:00.000Z'],
    ]);
    expect(facts.every((fact) => fact.actorId !== null)).toBe(true);
    expect(shipEvidence).toHaveLength(1);
    expect(shipEvidence[0]).toMatchObject({
      deliveryTaskId: task.id,
      source: 'connector_transition',
      occurredAt: new Date('2026-08-17T09:00:00.000Z'),
      provider: 'jira',
      repoExternalId: null,
      externalId: 'synthetic-issue-10001',
    });
    expect(reworkSignals).toHaveLength(1);
    expect(reworkSignals[0]).toMatchObject({
      deliveryTaskId: task.id,
      kind: 'tracker_reopened',
      occurredAt: new Date('2026-08-17T11:00:00.000Z'),
    });
    const establishedFactSourceRefs = facts.map((fact) => fact.sourceRef);
    const establishedShipSourceKeys = shipEvidence.map((evidence) => evidence.sourceKey);
    const establishedReworkSourceKeys = reworkSignals.map((signal) => signal.sourceKey);
    expect(rawRows).toHaveLength(2);
    expect(rawRows.every((row) => row.resourceType === 'issue' && row.normVersion === 1)).toBe(true);

    // Supported repair may remove the ref and its dependent state facts, but append-only
    // evidence belongs to the task and must survive the authority fallback.
    await expect(
      canonical.detachExternalRef(workspaceId, task.id, ref.id.toString(), {
        fallbackAuthority: { kind: 'coredoc' },
      }),
    ).resolves.toEqual({ status: 'detached', taskId: task.id, authority: { kind: 'coredoc' } });
    expect(
      await prisma.deliveryTask.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: task.id } } }),
    ).toMatchObject({ authority: 'coredoc', authorityRefId: null });
    expect(await prisma.taskExternalRefStateFact.count({ where: { workspaceId } })).toBe(0);
    expect(
      (await prisma.deliveryShipEvidence.findMany({ where: { workspaceId } })).map((evidence) => evidence.sourceKey),
    ).toEqual(establishedShipSourceKeys);
    expect(
      (await prisma.deliveryReworkSignal.findMany({ where: { workspaceId } })).map((signal) => signal.sourceKey),
    ).toEqual(establishedReworkSourceKeys);

    // Reattaching the same provider identity creates a new database ref ID. Provider
    // occurrence keys must not depend on that surrogate ID: a full refetch rebuilds
    // state history while converging onto the already-retained ship/reopen facts.
    const reattached = await canonical.attachExternalRef(workspaceId, task.id, {
      provider: 'jira',
      externalId: ref.externalId,
      connectorId,
      makeAuthority: true,
    });
    const recreatedRefId = BigInt(reattached.externalRef.id);
    expect(recreatedRefId).not.toBe(ref.id);
    await expect(service.syncConnector(connectorId)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    const [restoredTask, recreatedRef, recreatedFacts, retainedShipEvidence, retainedReworkSignals] = await Promise.all(
      [
        prisma.deliveryTask.findUniqueOrThrow({ where: { workspaceId_id: { workspaceId, id: task.id } } }),
        prisma.taskExternalRef.findUniqueOrThrow({ where: { id: recreatedRefId } }),
        prisma.taskExternalRefStateFact.findMany({
          where: { workspaceId, externalRefId: recreatedRefId },
          orderBy: { occurredAt: 'asc' },
        }),
        prisma.deliveryShipEvidence.findMany({ where: { workspaceId } }),
        prisma.deliveryReworkSignal.findMany({ where: { workspaceId } }),
      ],
    );
    expect(restoredTask).toMatchObject({
      lifecycle: 'active',
      authority: 'connector:jira',
      authorityRefId: recreatedRefId,
    });
    expect(recreatedRef).toMatchObject({
      deliveryTaskId: task.id,
      externalId: ref.externalId,
      externalKey: 'RENAMED-9',
      externalState: 'In Progress',
    });
    expect(recreatedFacts).toHaveLength(2);
    expect(recreatedFacts.map((fact) => fact.sourceRef)).toEqual(establishedFactSourceRefs);
    expect(retainedShipEvidence).toHaveLength(1);
    expect(retainedShipEvidence.map((evidence) => evidence.sourceKey)).toEqual(establishedShipSourceKeys);
    expect(retainedReworkSignals).toHaveLength(1);
    expect(retainedReworkSignals.map((signal) => signal.sourceKey)).toEqual(establishedReworkSourceKeys);
  });

  it('joins a V3 run to the exact Jira issue.id written by the real importer, never its mutable key', async () => {
    const workspaceId = await createWorkspace('v3-importer-identity');
    const connectorId = await createConnector(workspaceId, 'v3-importer-identity');
    await createCanonicalStatusPolicy(workspaceId, connectorId);
    const repositoryKey = 'coredoc/coredoc-parser';
    await prisma.workspaceRepo.create({
      data: {
        workspaceId,
        repoKey: `${RUN}-v3-importer-identity`,
        repoName: `${RUN}-v3-importer-identity`,
        captureRepositoryKey: repositoryKey,
      },
    });

    const issue = syntheticIssue({
      id: '10042',
      key: 'OLD-1',
      status: 'In Progress',
      updated: '2026-08-18T09:00:00.000Z',
      histories: [],
    });
    await expect(importer(syntheticClient([[issue]])).syncConnector(connectorId)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    const [task, importedRef] = await Promise.all([
      prisma.deliveryTask.findFirstOrThrow({ where: { workspaceId } }),
      prisma.taskExternalRef.findFirstOrThrow({ where: { workspaceId } }),
    ]);
    expect(importedRef).toMatchObject({
      deliveryTaskId: task.id,
      connectorId,
      provider: 'jira',
      externalId: '10042',
      externalKey: 'OLD-1',
    });
    expect(importedRef.externalId).not.toBe(importedRef.externalKey);

    const runId = 'cdr-20260818-b30001';
    const eventId = randomUUID();
    const start = {
      schemaVersion: 3,
      eventId,
      occurredAt: '2026-08-18T09:05:00.000Z',
      host: 'claude-code',
      sessionId: `${RUN}-v3-importer-identity`,
      runId,
      repositoryKey,
      type: 'workflow.run.started',
      data: {
        workflowId: 'change:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'normal',
        stages: [{ stageId: 'implement', after: [] }],
        workItems: [{ provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' }],
      },
    };
    await expect(
      capture.ingest(
        workspaceId,
        { id: `${RUN}-v3-importer-actor`, email: `${RUN}-v3-importer@example.com` },
        { events: [start] },
      ),
    ).resolves.toEqual({ acceptedEventIds: [eventId], duplicateEventIds: [], rejected: [] });

    const relation = await prisma.workflowRunWorkItem.findFirstOrThrow({
      where: { workflowRun: { workspaceId, runId } },
      select: { provider: true, externalId: true, externalKey: true },
    });
    expect(relation).toEqual({ provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' });
    expect(
      (
        await prisma.taskExternalRef.findUniqueOrThrow({
          where: { id: importedRef.id },
          select: { externalKey: true },
        })
      ).externalKey,
    ).toBe('OLD-1');

    const page = await canonical.listTaskRuns(workspaceId, task.id, '10');
    expect(page.items.map((run) => run.runId)).toEqual([runId]);
    expect(page.items[0]?.workItems).toEqual([
      { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9', linked: true },
    ]);
  });

  it('retains synthetic non-authoritative Jira history without changing lifecycle or deriving evidence', async () => {
    const workspaceId = await createWorkspace('nonauthority');
    const authorityConnectorId = await createConnector(workspaceId, 'primary');
    const observerConnectorId = await createConnector(workspaceId, 'secondary');
    await createCanonicalStatusPolicy(workspaceId, observerConnectorId);

    const authority = await canonical.resolveConnectorTask(authorityConnectorId, {
      repositoryKey: null,
      externalId: 'synthetic-primary-1',
      externalKey: 'SYN-PRIMARY',
      externalUrl: 'https://synthetic-jira.invalid/browse/SYN-PRIMARY',
      externalState: 'In Progress',
      sourceUpdatedAt: new Date('2026-08-17T08:00:00.000Z'),
      observedAt: new Date('2026-08-17T08:01:00.000Z'),
    });
    const attached = await canonical.attachExternalRef(workspaceId, authority.taskId, {
      provider: 'jira',
      externalId: 'synthetic-secondary-2',
      connectorId: observerConnectorId,
      makeAuthority: false,
    });

    const closed = syntheticHistory('synthetic-secondary-close', 'In Progress', 'Done', '2026-08-17T09:00:00.000Z');
    const reopened = syntheticHistory('synthetic-secondary-reopen', 'Done', 'In Progress', '2026-08-17T10:00:00.000Z');
    const jira = syntheticClient([
      [
        syntheticIssue({
          id: 'synthetic-secondary-2',
          key: 'SYN-SECONDARY',
          status: 'In Progress',
          updated: '2026-08-17T11:00:00.000Z',
          histories: [closed, reopened],
        }),
      ],
    ]);

    await expect(importer(jira).syncConnector(observerConnectorId)).resolves.toEqual({
      issues: 1,
      issuesIncomplete: false,
      changelogsIncomplete: false,
    });

    const observerRefId = BigInt(attached.externalRef.id);
    const [task, facts, shipEvidence, reworkSignals] = await Promise.all([
      prisma.deliveryTask.findUniqueOrThrow({
        where: { workspaceId_id: { workspaceId, id: authority.taskId } },
      }),
      prisma.taskExternalRefStateFact.findMany({ where: { workspaceId, externalRefId: observerRefId } }),
      prisma.deliveryShipEvidence.findMany({ where: { workspaceId } }),
      prisma.deliveryReworkSignal.findMany({ where: { workspaceId } }),
    ]);
    expect(task).toMatchObject({
      lifecycle: 'active',
      authorityRefId: BigInt(authority.externalRef.id),
    });
    expect(task.authorityRefId).not.toBe(observerRefId);
    expect(facts).toHaveLength(2);
    expect(shipEvidence).toHaveLength(0);
    expect(reworkSignals).toHaveLength(0);
  });

  it('converges concurrent identical state facts and bounds a contradictory same-source replay', async () => {
    const workspaceId = await createWorkspace('state-fact-race');
    const connectorId = await createConnector(workspaceId, 'state-fact-race');
    await createCanonicalStatusPolicy(workspaceId, connectorId);
    const resolved = await canonical.resolveConnectorTask(connectorId, {
      repositoryKey: null,
      externalId: 'synthetic-concurrent-3',
      externalKey: 'SYN-RACE',
      externalUrl: 'https://synthetic-jira.invalid/browse/SYN-RACE',
      externalState: 'In Progress',
      sourceUpdatedAt: new Date('2026-08-17T12:00:00.000Z'),
      observedAt: new Date('2026-08-17T12:01:00.000Z'),
    });
    const input = {
      workspaceId,
      connectorId,
      taskId: resolved.taskId,
      externalRefId: BigInt(resolved.externalRef.id),
      currentState: 'In Progress',
      sourceUpdatedAt: new Date('2026-08-17T12:00:00.000Z'),
      observedAt: new Date('2026-08-17T12:01:00.000Z'),
      transitions: [
        {
          sourceRef: 'synthetic-history-concurrent',
          fromState: 'To Do',
          toState: 'In Progress',
          occurredAt: new Date('2026-08-17T11:00:00.000Z'),
          actorId: null,
        },
      ],
    };

    const concurrent = await Promise.all([projection.projectIssue(input), projection.projectIssue(input)]);
    expect(concurrent.map((result) => result.stateFacts).sort()).toEqual([0, 1]);
    expect(
      await prisma.taskExternalRefStateFact.count({
        where: { workspaceId, externalRefId: BigInt(resolved.externalRef.id) },
      }),
    ).toBe(1);

    const contradictory = projection.projectIssue({
      ...input,
      currentState: 'Done',
      transitions: [{ ...input.transitions[0], toState: 'Done' }],
    });
    await expect(contradictory).rejects.toBeInstanceOf(ConflictException);
    await expect(contradictory).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_STATE_FACT_CONFLICT' }),
    });
    const established = await prisma.taskExternalRefStateFact.findFirstOrThrow({
      where: { workspaceId, externalRefId: BigInt(resolved.externalRef.id) },
    });
    expect(established).toMatchObject({ fromState: 'To Do', toState: 'In Progress' });
  });
});
