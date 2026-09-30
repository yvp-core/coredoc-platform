import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPrismaAdapter } from '../../database/create-prisma-client.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const TEST_DATABASE_URL = process.env.CANONICAL_DELIVERY_TEST_DATABASE_URL ?? '';
const RUN = `canonical-delivery-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

function taskId(): string {
  return `cdt_${randomUUID()}`;
}

describe.skipIf(!TEST_DATABASE_URL)('CanonicalDeliveryService (PostgreSQL integration)', () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof buildPrismaAdapter>;
  let service: CanonicalDeliveryService;
  let previousDatabaseUrl: string | undefined;
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    const built = buildPrismaAdapter();
    pool = built;
    prisma = new PrismaClient({ adapter: built?.adapter } as never);
    service = new CanonicalDeliveryService(prisma as unknown as PrismaService);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const workspaceId of workspaceIds.reverse()) {
      await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
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
    await prisma.workspaceRepo.create({
      data: {
        workspaceId: workspace.id,
        repoKey: `graph-${RUN}-${suffix}`,
        repoName: `${RUN}-${suffix}`,
        captureRepositoryKey: 'coredoc/coredoc-parser',
      },
    });
    return workspace.id;
  }

  async function createConnector(workspaceId: string, suffix: string): Promise<string> {
    const connector = await prisma.deliveryConnector.create({
      data: {
        workspaceId,
        provider: 'jira',
        displayName: `${RUN}-${suffix}`,
      },
      select: { id: true },
    });
    return connector.id;
  }

  async function createTask(workspaceId: string, id = taskId()): Promise<string> {
    await prisma.deliveryTask.create({
      data: {
        workspaceId,
        id,
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: 'phase-c-postgres-test',
      },
    });
    return id;
  }

  async function createRef(
    workspaceId: string,
    deliveryTaskId: string,
    connectorId: string,
    suffix: string,
  ): Promise<bigint> {
    const ref = await prisma.taskExternalRef.create({
      data: {
        workspaceId,
        deliveryTaskId,
        provider: 'jira',
        externalId: `${RUN}-${suffix}`,
        connectorId,
      },
      select: { id: true },
    });
    return ref.id;
  }

  it('converges concurrent identical connector first claims to one exact task and reference', async () => {
    const workspaceId = await createWorkspace('resolver');
    const connectorId = await createConnector(workspaceId, 'resolver');
    const observation = {
      repositoryKey: 'coredoc/coredoc-parser',
      externalId: `${RUN}-10042`,
      externalKey: 'CORE-42',
      externalUrl: 'https://jira.example.test/browse/CORE-42',
      externalState: 'In Progress',
      sourceUpdatedAt: '2026-08-17T10:00:00.000Z',
      observedAt: '2026-08-17T10:00:03.000Z',
    };

    const results = await Promise.all([
      service.resolveConnectorTask(connectorId, observation),
      service.resolveConnectorTask(connectorId, observation),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'duplicate']);
    const refs = await prisma.taskExternalRef.findMany({
      where: { workspaceId, provider: 'jira', externalId: observation.externalId },
    });
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw new Error('Resolver did not persist the canonical external reference');
    const tasks = await prisma.deliveryTask.findMany({ where: { workspaceId } });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    if (!task) throw new Error('Resolver did not persist the canonical task');
    expect(task).toMatchObject({
      id: ref.deliveryTaskId,
      authority: 'connector:jira',
      authorityRefId: ref.id,
      createdBy: `connector:${connectorId}`,
    });
    expect(ref).toMatchObject({
      connectorId,
      externalKey: observation.externalKey,
      externalUrl: observation.externalUrl,
      externalState: observation.externalState,
      sourceUpdatedAt: new Date(observation.sourceUpdatedAt),
      lastObservedAt: new Date(observation.observedAt),
    });
    expect(
      results.map(({ taskId: resolvedTaskId, externalRef, authority }) => ({
        taskId: resolvedTaskId,
        externalRef,
        authority,
      })),
    ).toEqual([
      {
        taskId: task.id,
        externalRef: { id: ref.id.toString(), provider: 'jira', externalId: observation.externalId },
        authority: {
          kind: 'external_ref',
          externalRefId: ref.id.toString(),
          provider: 'jira',
          externalId: observation.externalId,
          externalKey: observation.externalKey,
          sourceCreatedAt: null,
          connected: true,
        },
      },
      {
        taskId: task.id,
        externalRef: { id: ref.id.toString(), provider: 'jira', externalId: observation.externalId },
        authority: {
          kind: 'external_ref',
          externalRefId: ref.id.toString(),
          provider: 'jira',
          externalId: observation.externalId,
          externalKey: observation.externalKey,
          sourceCreatedAt: null,
          connected: true,
        },
      },
    ]);
  });

  it('converges concurrent identical admin attaches without leaking a unique race', async () => {
    const workspaceId = await createWorkspace('attach');
    const connectorId = await createConnector(workspaceId, 'attach');
    const deliveryTaskId = await createTask(workspaceId);
    const body = {
      provider: 'jira',
      externalId: `${RUN}-20042`,
      connectorId,
      makeAuthority: false,
    };

    const results = await Promise.all([
      service.attachExternalRef(workspaceId, deliveryTaskId, body),
      service.attachExternalRef(workspaceId, deliveryTaskId, body),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['attached', 'duplicate']);
    const refs = await prisma.taskExternalRef.findMany({
      where: { workspaceId, provider: 'jira', externalId: body.externalId },
    });
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw new Error('Attach did not persist the canonical external reference');
    expect(ref).toMatchObject({ deliveryTaskId, connectorId });
    expect(results.map((result) => result.externalRef.id)).toEqual([ref.id.toString(), ref.id.toString()]);
    expect(
      await prisma.deliveryTask.findUnique({ where: { workspaceId_id: { workspaceId, id: deliveryTaskId } } }),
    ).toMatchObject({ authority: 'coredoc', authorityRefId: null });
  });

  it('records one immutable Coredoc ship fact, dedupes its replay, and rejects cross-task event reuse', async () => {
    const workspaceId = await createWorkspace('coredoc-ship-replay');
    const deliveryTaskId = await createTask(workspaceId);
    const otherTaskId = await createTask(workspaceId);
    const actorId = `${RUN}-ship-actor`;
    const body = {
      eventId: randomUUID(),
      shippedAt: '2026-08-17T12:30:00.000Z',
    };

    await expect(service.recordCoredocShipEvidence(workspaceId, actorId, deliveryTaskId, body)).resolves.toEqual({
      status: 'accepted',
      taskId: deliveryTaskId,
      eventId: body.eventId,
      shippedAt: body.shippedAt,
    });
    await expect(service.recordCoredocShipEvidence(workspaceId, actorId, deliveryTaskId, body)).resolves.toEqual({
      status: 'duplicate',
      taskId: deliveryTaskId,
      eventId: body.eventId,
      shippedAt: body.shippedAt,
    });
    await expect(service.recordCoredocShipEvidence(workspaceId, actorId, otherTaskId, body)).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'SHIP_EVIDENCE_CONFLICT' }),
    });

    const rows = await prisma.deliveryShipEvidence.findMany({
      where: { workspaceId, source: 'coredoc', sourceKey: body.eventId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryTaskId,
      source: 'coredoc',
      sourceKey: body.eventId,
      occurredAt: new Date(body.shippedAt),
      actorId,
      provider: null,
      repoExternalId: null,
      externalId: null,
    });
  });

  it('converges concurrent identical Coredoc ship submissions through one bounded first-write retry', async () => {
    const workspaceId = await createWorkspace('coredoc-ship-race');
    const deliveryTaskId = await createTask(workspaceId);
    const actorId = `${RUN}-ship-race-actor`;
    const body = {
      eventId: randomUUID(),
      shippedAt: '2026-08-17T12:45:00.000Z',
    };

    const results = await Promise.all([
      service.recordCoredocShipEvidence(workspaceId, actorId, deliveryTaskId, body),
      service.recordCoredocShipEvidence(workspaceId, actorId, deliveryTaskId, body),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['accepted', 'duplicate']);
    expect(
      results.map(({ taskId: resultTaskId, eventId, shippedAt }) => ({
        taskId: resultTaskId,
        eventId,
        shippedAt,
      })),
    ).toEqual([
      { taskId: deliveryTaskId, eventId: body.eventId, shippedAt: body.shippedAt },
      { taskId: deliveryTaskId, eventId: body.eventId, shippedAt: body.shippedAt },
    ]);
    expect(
      await prisma.deliveryShipEvidence.count({
        where: { workspaceId, source: 'coredoc', sourceKey: body.eventId },
      }),
    ).toBe(1);
  });

  it('refuses an authoritative detach without fallback and switches then deletes atomically', async () => {
    const workspaceId = await createWorkspace('detach');
    const connectorId = await createConnector(workspaceId, 'detach');
    const deliveryTaskId = await createTask(workspaceId);
    const otherTaskId = await createTask(workspaceId);
    const authoritativeRefId = await createRef(workspaceId, deliveryTaskId, connectorId, 'authority');
    const fallbackRefId = await createRef(workspaceId, deliveryTaskId, connectorId, 'fallback');
    const foreignRefId = await createRef(workspaceId, otherTaskId, connectorId, 'foreign');
    await prisma.deliveryTask.update({
      where: { workspaceId_id: { workspaceId, id: deliveryTaskId } },
      data: { authority: 'connector:jira', authorityRefId: authoritativeRefId },
    });

    await expect(
      service.detachExternalRef(workspaceId, deliveryTaskId, authoritativeRefId.toString(), {}),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TASK_AUTHORITY_CONFLICT' }) });
    expect(
      await prisma.deliveryTask.findUnique({ where: { workspaceId_id: { workspaceId, id: deliveryTaskId } } }),
    ).toMatchObject({ authority: 'connector:jira', authorityRefId: authoritativeRefId });
    expect(await prisma.taskExternalRef.count({ where: { workspaceId, deliveryTaskId } })).toBe(2);

    await expect(
      service.detachExternalRef(workspaceId, deliveryTaskId, authoritativeRefId.toString(), {
        fallbackAuthority: { kind: 'external_ref', externalRefId: foreignRefId.toString() },
      }),
    ).rejects.toBeDefined();
    expect(
      await prisma.deliveryTask.findUnique({ where: { workspaceId_id: { workspaceId, id: deliveryTaskId } } }),
    ).toMatchObject({ authority: 'connector:jira', authorityRefId: authoritativeRefId });
    expect(await prisma.taskExternalRef.count({ where: { workspaceId, deliveryTaskId } })).toBe(2);

    await expect(
      service.detachExternalRef(workspaceId, deliveryTaskId, authoritativeRefId.toString(), {
        fallbackAuthority: { kind: 'external_ref', externalRefId: fallbackRefId.toString() },
      }),
    ).resolves.toEqual({
      status: 'detached',
      taskId: deliveryTaskId,
      authority: {
        kind: 'external_ref',
        externalRefId: fallbackRefId.toString(),
        provider: 'jira',
        externalId: `${RUN}-fallback`,
        externalKey: null,
        sourceCreatedAt: null,
        connected: true,
      },
    });
    expect(
      await prisma.deliveryTask.findUnique({ where: { workspaceId_id: { workspaceId, id: deliveryTaskId } } }),
    ).toMatchObject({ authority: 'connector:jira', authorityRefId: fallbackRefId });
    expect(
      await prisma.taskExternalRef.findUnique({ where: { id: authoritativeRefId }, select: { id: true } }),
    ).toBeNull();
    expect(await prisma.taskExternalRef.findUnique({ where: { id: fallbackRefId }, select: { id: true } })).toEqual({
      id: fallbackRefId,
    });
  });
});
