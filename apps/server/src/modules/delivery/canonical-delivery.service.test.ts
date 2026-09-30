import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { deliveryCursorScope, encodeDeliveryCursor } from './canonical-delivery-read.contract.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ARTIFACT_ID = 'cda_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REVISION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_REVISION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CONNECTOR_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EXTERNAL_REF_ID = 9_007_199_254_740_993n;
const SOURCE_UPDATED_AT = '2026-08-17T10:00:00.000Z';
const OBSERVED_AT = '2026-08-17T10:00:03.000Z';

const externalRef = {
  provider: 'jira',
  externalId: '10001',
  externalKey: 'CORE-42',
  externalUrl: 'https://jira.example/browse/CORE-42',
  externalState: 'in_progress',
};

function connectorObservation(overrides: Record<string, unknown> = {}) {
  return {
    repositoryKey: null,
    externalId: externalRef.externalId,
    externalKey: externalRef.externalKey,
    externalUrl: externalRef.externalUrl,
    externalState: externalRef.externalState,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function connectorRecord() {
  return {
    id: CONNECTOR_ID,
    workspaceId: WORKSPACE_ID,
    provider: 'jira',
  };
}

function storedExternalRef(overrides: Record<string, unknown> = {}) {
  return {
    id: EXTERNAL_REF_ID,
    workspaceId: WORKSPACE_ID,
    deliveryTaskId: TASK_ID,
    provider: 'jira',
    externalId: externalRef.externalId,
    externalKey: externalRef.externalKey,
    externalUrl: externalRef.externalUrl,
    externalState: externalRef.externalState,
    connectorId: CONNECTOR_ID,
    sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
    lastObservedAt: new Date(OBSERVED_AT),
    ...overrides,
  };
}

function transactionPrisma(tx: Record<string, unknown>) {
  return {
    ...tx,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  } as unknown as PrismaService;
}

/** A body as the controller's `ZodValidationPipe` hands it over: `runId` already defaulted. */
function artifactBody(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    kind: 'spec' as const,
    checkpoint: 'run-finish' as const,
    markdown: '# V1',
    runId: null,
    ...overrides,
  };
}

describe('CanonicalDeliveryService.ensureTask', () => {
  it('creates only a Coredoc-owned canonical task through the telemetry boundary', async () => {
    const taskUpsert = vi.fn().mockResolvedValue({
      id: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
    });
    const refUpsert = vi.fn();
    const tx = {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
      deliveryTask: { upsert: taskUpsert },
      taskExternalRef: { upsert: refUpsert },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.ensureTask(WORKSPACE_ID, 'actor-1', TASK_ID, {
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
        externalRefs: [],
      }),
    ).resolves.toEqual({
      id: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
      externalRefs: [],
    });

    expect(taskUpsert).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: TASK_ID } },
      create: {
        workspaceId: WORKSPACE_ID,
        id: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: 'actor-1',
      },
      update: {},
      select: { id: true, repositoryKey: true, lifecycle: true, authority: true },
    });
    expect(refUpsert).not.toHaveBeenCalled();
  });

  it('converges an exact Coredoc telemetry retry through an atomic no-update upsert', async () => {
    const taskUpsert = vi.fn().mockResolvedValue({
      id: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
    });
    const refUpsert = vi.fn();
    const tx = {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
      deliveryTask: { upsert: taskUpsert },
      taskExternalRef: { upsert: refUpsert },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.ensureTask(WORKSPACE_ID, 'actor-2', TASK_ID.toUpperCase(), {
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
        externalRefs: [],
      }),
    ).resolves.toEqual({
      id: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
      externalRefs: [],
    });
    expect(taskUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
    expect(refUpsert).not.toHaveBeenCalled();
  });

  it('retries a racing canonical task first-write after P2002 and returns the established identity', async () => {
    const taskUpsert = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('racing task insert'), { code: 'P2002' }))
      .mockResolvedValue({
        id: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
      });
    const tx = {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
      deliveryTask: { upsert: taskUpsert },
      taskExternalRef: { upsert: vi.fn() },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(
      service.ensureTask(WORKSPACE_ID, 'actor-1', TASK_ID, { repositoryKey: 'coredoc/coredoc-parser' }),
    ).resolves.toMatchObject({ id: TASK_ID, repositoryKey: 'coredoc/coredoc-parser' });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(taskUpsert).toHaveBeenCalledTimes(2);
  });

  // The telemetry authority fence and every other body rule now live in the schema the
  // controller's `ZodValidationPipe` applies: see `canonical-delivery.contract.test.ts` for the
  // 403 mapping and `canonical-delivery.validation-parity.test.ts` for the wire bodies.

  it('refuses an unbound repository before creating a canonical task', async () => {
    const taskUpsert = vi.fn();
    const tx = {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue(null) },
      deliveryTask: { upsert: taskUpsert },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.ensureTask(WORKSPACE_ID, 'actor-1', TASK_ID, {
        repositoryKey: 'outside/workspace',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(taskUpsert).not.toHaveBeenCalled();
  });

  it('returns TASK_IDENTITY_CONFLICT when the established task repository differs', async () => {
    const tx = {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
      deliveryTask: {
        upsert: vi.fn().mockResolvedValue({
          id: TASK_ID,
          repositoryKey: 'other/repository',
          lifecycle: 'active',
          authority: 'coredoc',
        }),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.ensureTask(WORKSPACE_ID, 'actor-1', TASK_ID, {
      repositoryKey: 'coredoc/coredoc-parser',
    });
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_IDENTITY_CONFLICT' }),
    });
  });

  it('rejects an invalid canonical task id before persistence', async () => {
    const transaction = vi.fn();
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(
      service.ensureTask(WORKSPACE_ID, 'actor-1', 'not-a-task', { externalRefs: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('CanonicalDeliveryService.resolveConnectorTask', () => {
  it('first-claims an exact connector identity with server-derived workspace, provider, creator, and authority', async () => {
    const taskCreate = vi.fn().mockImplementation(async ({ data }) => ({
      ...data,
      id: TASK_ID,
      authorityRefId: null,
    }));
    const refCreate = vi.fn().mockImplementation(async ({ data }) => storedExternalRef(data));
    const taskUpdate = vi.fn().mockResolvedValue({
      id: TASK_ID,
      lifecycle: 'active',
      authority: 'connector:jira',
      authorityRefId: EXTERNAL_REF_ID,
    });
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(null), create: refCreate },
      deliveryTask: { create: taskCreate, update: taskUpdate },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(service.resolveConnectorTask(CONNECTOR_ID, connectorObservation())).resolves.toMatchObject({
      status: 'accepted',
      taskId: TASK_ID,
      externalRef: {
        id: EXTERNAL_REF_ID.toString(),
        provider: 'jira',
        externalId: externalRef.externalId,
      },
      authority: {
        kind: 'external_ref',
        externalRefId: EXTERNAL_REF_ID.toString(),
        provider: 'jira',
        externalId: externalRef.externalId,
        externalKey: externalRef.externalKey,
        connected: true,
        sourceCreatedAt: null,
      },
    });

    expect(tx.deliveryConnector.findUnique).toHaveBeenCalledWith({
      where: { id: CONNECTOR_ID },
      select: { id: true, workspaceId: true, provider: true },
    });
    expect(taskCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        id: expect.stringMatching(/^cdt_[0-9a-f-]{36}$/),
        repositoryKey: null,
        lifecycle: 'active',
        authority: 'connector:jira',
        authorityRefId: null,
        createdBy: `connector:${CONNECTOR_ID}`,
      }),
      select: expect.any(Object),
    });
    expect(refCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        deliveryTaskId: TASK_ID,
        provider: 'jira',
        externalId: externalRef.externalId,
        connectorId: CONNECTOR_ID,
        sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
        lastObservedAt: new Date(OBSERVED_AT),
      }),
      select: expect.any(Object),
    });
    expect(taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: TASK_ID } },
        data: { authority: 'connector:jira', authorityRefId: EXTERNAL_REF_ID },
      }),
    );
  });

  it('treats an exact same-freshness replay as a duplicate', async () => {
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(storedExternalRef()),
        create: vi.fn(),
        update: vi.fn(),
      },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          lifecycle: 'active',
          authority: 'connector:jira',
          authorityRefId: EXTERNAL_REF_ID,
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(service.resolveConnectorTask(CONNECTOR_ID, connectorObservation())).resolves.toMatchObject({
      status: 'duplicate',
      taskId: TASK_ID,
    });
    expect(tx.deliveryTask.create).not.toHaveBeenCalled();
    expect(tx.taskExternalRef.create).not.toHaveBeenCalled();
    expect(tx.taskExternalRef.update).not.toHaveBeenCalled();
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'advances the observation timestamp',
      '2026-08-17T10:00:04.000Z',
      {
        externalUrl: 'https://jira-renamed.example/browse/CORE-42',
        lastObservedAt: new Date('2026-08-17T10:00:04.000Z'),
      },
    ],
    [
      'preserves a later observation timestamp',
      '2026-08-17T10:00:02.000Z',
      { externalUrl: 'https://jira-renamed.example/browse/CORE-42' },
    ],
  ])('refreshes a derived URL at equal source freshness and %s', async (_label, observedAt, expectedUpdate) => {
    const refreshed = storedExternalRef({
      externalUrl: 'https://jira-renamed.example/browse/CORE-42',
      lastObservedAt:
        expectedUpdate.lastObservedAt instanceof Date ? expectedUpdate.lastObservedAt : new Date(OBSERVED_AT),
    });
    const refUpdate = vi.fn().mockResolvedValue(refreshed);
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(storedExternalRef()),
        update: refUpdate,
      },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          lifecycle: 'active',
          authority: 'connector:jira',
          authorityRefId: EXTERNAL_REF_ID,
        }),
        update: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.resolveConnectorTask(
        CONNECTOR_ID,
        connectorObservation({
          externalUrl: 'https://jira-renamed.example/browse/CORE-42',
          observedAt,
        }),
      ),
    ).resolves.toMatchObject({ status: 'duplicate', taskId: TASK_ID });
    expect(refUpdate).toHaveBeenCalledWith({
      where: { id: EXTERNAL_REF_ID },
      data: expectedUpdate,
      select: expect.any(Object),
    });
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it('retries one concurrent first claim after P2002 and returns the exact established task', async () => {
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(storedExternalRef()),
        create: vi.fn(),
        update: vi.fn(),
      },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          lifecycle: 'active',
          authority: 'connector:jira',
          authorityRefId: EXTERNAL_REF_ID,
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('concurrent identity claim'), { code: 'P2002' }))
      .mockImplementationOnce(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(service.resolveConnectorTask(CONNECTOR_ID, connectorObservation())).resolves.toMatchObject({
      status: 'duplicate',
      taskId: TASK_ID,
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.deliveryTask.create).not.toHaveBeenCalled();
    expect(tx.taskExternalRef.create).not.toHaveBeenCalled();
  });

  it('refreshes mutable presentation/state fields only for a strictly newer source observation', async () => {
    const oldSourceTime = new Date('2026-08-17T09:00:00.000Z');
    const updatedRef = storedExternalRef({
      externalKey: 'CORE-43',
      externalUrl: 'https://jira.example/browse/CORE-43',
      externalState: 'done',
    });
    const refUpdate = vi.fn().mockResolvedValue(updatedRef);
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(
          storedExternalRef({
            externalState: 'to_do',
            sourceUpdatedAt: oldSourceTime,
            lastObservedAt: oldSourceTime,
          }),
        ),
        update: refUpdate,
      },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          lifecycle: 'active',
          authority: 'connector:jira',
          authorityRefId: EXTERNAL_REF_ID,
        }),
        update: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));
    const input = connectorObservation({
      externalKey: 'CORE-43',
      externalUrl: 'https://jira.example/browse/CORE-43',
      externalState: 'done',
    });

    await expect(service.resolveConnectorTask(CONNECTOR_ID, input)).resolves.toMatchObject({
      status: 'updated',
      taskId: TASK_ID,
    });
    expect(refUpdate).toHaveBeenCalledWith({
      where: { id: EXTERNAL_REF_ID },
      data: {
        externalKey: 'CORE-43',
        externalUrl: 'https://jira.example/browse/CORE-43',
        externalState: 'done',
        connectorId: CONNECTOR_ID,
        sourceCreatedAt: null,
        sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
        lastObservedAt: new Date(OBSERVED_AT),
      },
      select: expect.any(Object),
    });
  });

  it('ignores an older overlap instead of rolling mutable ref state or history backward', async () => {
    const refUpdate = vi.fn();
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(
          storedExternalRef({
            externalKey: 'CORE-NEW',
            externalState: 'done',
            sourceUpdatedAt: new Date('2026-08-17T11:00:00.000Z'),
          }),
        ),
        update: refUpdate,
      },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          lifecycle: 'active',
          authority: 'connector:jira',
          authorityRefId: EXTERNAL_REF_ID,
        }),
        update: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(service.resolveConnectorTask(CONNECTOR_ID, connectorObservation())).resolves.toMatchObject({
      status: 'stale',
      taskId: TASK_ID,
    });
    expect(refUpdate).not.toHaveBeenCalled();
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it.each([
    ['externalKey', { externalKey: 'CORE-99' }],
    ['externalState', { externalState: 'done' }],
  ])('fails closed when equal source freshness contradicts %s', async (_field, establishedOverride) => {
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(storedExternalRef(establishedOverride)),
        update: vi.fn(),
      },
      deliveryTask: { findUnique: vi.fn(), update: vi.fn() },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.resolveConnectorTask(CONNECTOR_ID, connectorObservation());
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_EXTERNAL_REF_CONFLICT' }),
    });
    expect(tx.taskExternalRef.update).not.toHaveBeenCalled();
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });
});

describe('CanonicalDeliveryService external-ref repair', () => {
  function repairTask(overrides: Record<string, unknown> = {}) {
    return {
      id: TASK_ID,
      lifecycle: 'active',
      authority: 'coredoc',
      authorityRefId: null,
      ...overrides,
    };
  }

  it.each([
    ['connector-backed', CONNECTOR_ID],
    ['manual', null],
  ])('attaches a brand-new %s identity without changing Coredoc authority', async (_label, connectorId) => {
    const refCreate = vi.fn().mockImplementation(async ({ data }) => storedExternalRef(data));
    const tx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(repairTask()), update: vi.fn() },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(null), create: refCreate },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.attachExternalRef(WORKSPACE_ID, TASK_ID, {
        provider: 'jira',
        externalId: externalRef.externalId,
        connectorId,
        makeAuthority: false,
      }),
    ).resolves.toEqual({
      status: 'attached',
      taskId: TASK_ID,
      externalRef: {
        id: EXTERNAL_REF_ID.toString(),
        provider: 'jira',
        externalId: externalRef.externalId,
      },
      authority: { kind: 'coredoc' },
    });
    expect(refCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          deliveryTaskId: TASK_ID,
          provider: 'jira',
          externalId: externalRef.externalId,
          connectorId,
        }),
      }),
    );
    expect(tx.deliveryConnector.findFirst).toHaveBeenCalledTimes(connectorId === null ? 0 : 1);
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it('returns duplicate for an exact attached identity and can make that exact ref authoritative', async () => {
    const taskUpdate = vi
      .fn()
      .mockResolvedValue(repairTask({ authority: 'connector:jira', authorityRefId: EXTERNAL_REF_ID }));
    const tx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(repairTask()), update: taskUpdate },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(storedExternalRef()), create: vi.fn() },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.attachExternalRef(WORKSPACE_ID, TASK_ID, {
        provider: 'jira',
        externalId: externalRef.externalId,
        connectorId: CONNECTOR_ID,
        makeAuthority: true,
      }),
    ).resolves.toEqual({
      status: 'duplicate',
      taskId: TASK_ID,
      externalRef: {
        id: EXTERNAL_REF_ID.toString(),
        provider: 'jira',
        externalId: externalRef.externalId,
      },
      authority: {
        kind: 'external_ref',
        externalRefId: EXTERNAL_REF_ID.toString(),
        provider: 'jira',
        externalId: externalRef.externalId,
        externalKey: externalRef.externalKey,
        connected: true,
        sourceCreatedAt: null,
      },
    });
    expect(tx.taskExternalRef.create).not.toHaveBeenCalled();
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: TASK_ID } },
      data: { authority: 'connector:jira', authorityRefId: EXTERNAL_REF_ID },
      select: expect.any(Object),
    });
  });

  it('returns TASK_IDENTITY_CONFLICT instead of attaching an identity owned by another task', async () => {
    const tx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(repairTask()), update: vi.fn() },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connectorRecord()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(storedExternalRef({ deliveryTaskId: OTHER_TASK_ID })),
        create: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.attachExternalRef(WORKSPACE_ID, TASK_ID, {
      provider: 'jira',
      externalId: externalRef.externalId,
      connectorId: CONNECTOR_ID,
      makeAuthority: false,
    });
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_IDENTITY_CONFLICT' }),
    });
    expect(tx.taskExternalRef.create).not.toHaveBeenCalled();
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it('refuses to detach the authoritative ref without an explicit fallback', async () => {
    const tx = {
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(repairTask({ authority: 'connector:jira', authorityRefId: EXTERNAL_REF_ID })),
        update: vi.fn(),
      },
      taskExternalRef: { findFirst: vi.fn().mockResolvedValue(storedExternalRef()), delete: vi.fn() },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.detachExternalRef(WORKSPACE_ID, TASK_ID, EXTERNAL_REF_ID.toString(), {});
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_AUTHORITY_CONFLICT' }),
    });
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
    expect(tx.taskExternalRef.delete).not.toHaveBeenCalled();
  });

  it('atomically switches authoritative fallback to Coredoc before detaching the ref', async () => {
    const writes: string[] = [];
    const taskUpdate = vi.fn().mockImplementation(async () => {
      writes.push('authority');
      return repairTask();
    });
    const refDelete = vi.fn().mockImplementation(async () => {
      writes.push('detach');
      return storedExternalRef();
    });
    const tx = {
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(repairTask({ authority: 'connector:jira', authorityRefId: EXTERNAL_REF_ID })),
        update: taskUpdate,
      },
      taskExternalRef: { findFirst: vi.fn().mockResolvedValue(storedExternalRef()), delete: refDelete },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(
      service.detachExternalRef(WORKSPACE_ID, TASK_ID, EXTERNAL_REF_ID.toString(), {
        fallbackAuthority: { kind: 'coredoc' },
      }),
    ).resolves.toEqual({
      status: 'detached',
      taskId: TASK_ID,
      authority: { kind: 'coredoc' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: TASK_ID } },
      data: { authority: 'coredoc', authorityRefId: null },
      select: expect.any(Object),
    });
    expect(refDelete).toHaveBeenCalledWith({
      where: { id: EXTERNAL_REF_ID },
    });
    expect(writes).toEqual(['authority', 'detach']);
  });
});

describe('CanonicalDeliveryService.uploadArtifactRevision', () => {
  function baseTransaction() {
    return {
      workspaceRepo: { findFirst: vi.fn().mockResolvedValue({ id: 'repo-1' }) },
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({ id: TASK_ID, repositoryKey: 'coredoc/coredoc-parser' }),
      },
      deliveryArtifact: {
        upsert: vi.fn().mockResolvedValue({
          id: ARTIFACT_ID,
          deliveryTaskId: TASK_ID,
          repositoryKey: 'coredoc/coredoc-parser',
          kind: 'spec',
        }),
      },
      artifactRevision: { upsert: vi.fn() },
    };
  }

  it('creates a server-hashed revision through atomic no-update upserts without returning Markdown', async () => {
    const createdAt = new Date('2026-08-16T20:00:00.000Z');
    const tx = baseTransaction();
    tx.artifactRevision.upsert.mockImplementation(async ({ create }) => ({ ...create, createdAt }));
    const service = new CanonicalDeliveryService(transactionPrisma(tx));
    const expectedSha = createHash('sha256').update('# V1', 'utf8').digest('hex');

    const result = await service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody());

    expect(result).toEqual({
      status: 'accepted',
      artifact: {
        id: ARTIFACT_ID,
        taskId: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
      },
      revision: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sha256: expectedSha,
        byteCount: 4,
        checkpoint: 'run-finish',
        runId: null,
        createdAt: createdAt.toISOString(),
      },
    });
    expect(JSON.stringify(result)).not.toContain('# V1');
    expect(tx.deliveryArtifact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: ARTIFACT_ID } },
        update: {},
      }),
    );
    expect(tx.artifactRevision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId_artifactId_sha256: {
            workspaceId: WORKSPACE_ID,
            artifactId: ARTIFACT_ID,
            sha256: expectedSha,
          },
        },
        create: expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          artifactId: ARTIFACT_ID,
          sha256: expectedSha,
          byteCount: 4,
          markdown: '# V1',
          checkpoint: 'run-finish',
          runId: null,
        }),
        update: {},
      }),
    );
  });

  it('returns duplicate from the established revision identity without rewriting metadata', async () => {
    const tx = baseTransaction();
    tx.artifactRevision.upsert.mockResolvedValue({
      id: REVISION_ID,
      sha256: createHash('sha256').update('# V1').digest('hex'),
      byteCount: 4,
      checkpoint: 'session-end',
      runId: 'cdr-20260816-a1b2c3',
      createdAt: new Date('2026-08-16T20:00:00.000Z'),
    });
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.uploadArtifactRevision(WORKSPACE_ID, 'actor-2', ARTIFACT_ID, artifactBody()),
    ).resolves.toMatchObject({
      status: 'duplicate',
      revision: {
        id: REVISION_ID,
        checkpoint: 'session-end',
        runId: 'cdr-20260816-a1b2c3',
      },
    });
    expect(tx.artifactRevision.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it('retries a racing artifact first-write after P2002 and converges on the stored revision', async () => {
    const createdAt = new Date('2026-08-16T20:00:00.000Z');
    const tx = baseTransaction();
    tx.artifactRevision.upsert
      .mockRejectedValueOnce(Object.assign(new Error('racing revision insert'), { code: 'P2002' }))
      .mockResolvedValue({
        id: REVISION_ID,
        sha256: createHash('sha256').update('# V1').digest('hex'),
        byteCount: 4,
        checkpoint: 'run-finish',
        runId: null,
        createdAt,
      });
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(
      service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody()),
    ).resolves.toMatchObject({ status: 'duplicate', revision: { id: REVISION_ID } });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.artifactRevision.upsert).toHaveBeenCalledTimes(2);
  });

  it('bounds artifact first-write retries when a unique violation does not converge', async () => {
    const tx = baseTransaction();
    tx.artifactRevision.upsert.mockRejectedValue(Object.assign(new Error('persistent conflict'), { code: 'P2002' }));
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(
      service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.artifactRevision.upsert).toHaveBeenCalledTimes(2);
  });

  it('stores exactly two revisions for V1, duplicate V1, and V2', async () => {
    const tx = baseTransaction();
    const rows = new Map<string, Record<string, unknown>>();
    tx.artifactRevision.upsert.mockImplementation(async ({ create }) => {
      const existing = rows.get(create.sha256);
      if (existing) return existing;
      const row = { ...create, createdAt: new Date(`2026-08-16T20:00:0${rows.size}.000Z`) };
      rows.set(create.sha256, row);
      return row;
    });
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const statuses = [];
    statuses.push((await service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody())).status);
    statuses.push((await service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody())).status);
    statuses.push(
      (
        await service.uploadArtifactRevision(
          WORKSPACE_ID,
          'actor-1',
          ARTIFACT_ID,
          artifactBody({ markdown: '# V2', checkpoint: 'session-start-reconcile' }),
        )
      ).status,
    );

    expect(statuses).toEqual(['accepted', 'duplicate', 'accepted']);
    expect(rows.size).toBe(2);
  });

  it('returns a non-enumerating 404 when the scoped task is absent', async () => {
    const tx = baseTransaction();
    tx.workspaceRepo.findFirst.mockResolvedValue(null);
    tx.deliveryTask.findUnique.mockResolvedValue(null);
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.deliveryArtifact.upsert).not.toHaveBeenCalled();
  });

  it('returns ARTIFACT_IDENTITY_CONFLICT for task or established artifact identity drift', async () => {
    const taskConflict = baseTransaction();
    taskConflict.deliveryTask.findUnique.mockResolvedValue({ id: TASK_ID, repositoryKey: 'other/repository' });
    const taskService = new CanonicalDeliveryService(transactionPrisma(taskConflict));
    const taskPromise = taskService.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody());
    await expect(taskPromise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'ARTIFACT_IDENTITY_CONFLICT' }),
    });

    const artifactConflict = baseTransaction();
    artifactConflict.deliveryArtifact.upsert.mockResolvedValue({
      id: ARTIFACT_ID,
      deliveryTaskId: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      kind: 'design',
    });
    const artifactService = new CanonicalDeliveryService(transactionPrisma(artifactConflict));
    const artifactPromise = artifactService.uploadArtifactRevision(
      WORKSPACE_ID,
      'actor-1',
      ARTIFACT_ID,
      artifactBody(),
    );
    await expect(artifactPromise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'ARTIFACT_IDENTITY_CONFLICT' }),
    });
    expect(artifactConflict.artifactRevision.upsert).not.toHaveBeenCalled();
  });

  it('refuses an unbound repository before any artifact or revision write', async () => {
    const tx = baseTransaction();
    tx.workspaceRepo.findFirst.mockResolvedValue(null);
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.uploadArtifactRevision(WORKSPACE_ID, 'actor-1', ARTIFACT_ID, artifactBody()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.deliveryTask.findUnique).toHaveBeenCalled();
    expect(tx.deliveryArtifact.upsert).not.toHaveBeenCalled();
    expect(tx.artifactRevision.upsert).not.toHaveBeenCalled();
  });

  it('maps unexpected persistence diagnostics to a bounded response without Markdown', async () => {
    const sentinel = 'PRIVATE-MARKDOWN-SENTINEL';
    const tx = baseTransaction();
    tx.artifactRevision.upsert.mockRejectedValue(new Error(`database failed near ${sentinel}`));
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.uploadArtifactRevision(
      WORKSPACE_ID,
      'actor-1',
      ARTIFACT_ID,
      artifactBody({ markdown: sentinel }),
    );
    await expect(promise).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(promise).rejects.not.toMatchObject({ message: expect.stringContaining(sentinel) });
  });
});

describe('CanonicalDeliveryService.getArtifact', () => {
  it('returns Markdown only through the explicit workspace-scoped artifact drilldown', async () => {
    const createdAt = new Date('2026-08-16T20:00:00.000Z');
    const findUnique = vi.fn().mockResolvedValue({
      id: ARTIFACT_ID,
      deliveryTaskId: TASK_ID,
      repositoryKey: 'coredoc/coredoc-parser',
      kind: 'spec',
      revisions: [
        {
          id: REVISION_ID,
          sha256: 'a'.repeat(64),
          byteCount: 4,
          checkpoint: 'run-finish',
          runId: null,
          createdAt,
          markdown: '# V1',
        },
      ],
    });
    const service = new CanonicalDeliveryService({ deliveryArtifact: { findUnique } } as unknown as PrismaService);

    await expect(service.getArtifact(WORKSPACE_ID, ARTIFACT_ID)).resolves.toEqual({
      artifact: {
        id: ARTIFACT_ID,
        taskId: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        kind: 'spec',
      },
      revisions: [
        {
          id: REVISION_ID,
          sha256: 'a'.repeat(64),
          byteCount: 4,
          checkpoint: 'run-finish',
          runId: null,
          createdAt: createdAt.toISOString(),
          markdown: '# V1',
        },
      ],
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId_id: { workspaceId: WORKSPACE_ID, id: ARTIFACT_ID } } }),
    );
    expect(findUnique.mock.calls[0]?.[0].select.revisions.select.markdown).toBe(true);
  });

  it('returns 404 for a missing or cross-workspace artifact', async () => {
    const service = new CanonicalDeliveryService({
      deliveryArtifact: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);
    await expect(service.getArtifact(WORKSPACE_ID, ARTIFACT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CanonicalDeliveryService.listTasks', () => {
  it('reads canonical task/run/stage/ref/artifact metadata without Markdown and unions V2/V3 runs once', async () => {
    const createdAt = new Date('2026-08-16T10:00:00.000Z');
    const updatedAt = new Date('2026-08-16T10:05:00.000Z');
    const directRun = {
      runId: 'cdr-20260816-a1b2c3',
      actorId: 'actor-1',
      workflowId: 'change:normal',
      intent: 'change',
      risk: 'normal',
      scale: 'normal',
      repositoryKey: 'coredoc/coredoc-parser',
      declaredStages: [{ stageId: 'tdd', after: [] }],
      createdAt,
      startedAt: createdAt,
      finishedAt: updatedAt,
      outcome: 'success',
      stageOccurrences: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          stageId: 'tdd',
          attempt: 1,
          startedAt: createdAt,
          finishedAt: updatedAt,
          outcome: 'success',
        },
      ],
    };
    const relatedRun = {
      ...directRun,
      runId: 'cdr-20260816-b2c3d4',
      workflowId: 'change:large',
      createdAt: updatedAt,
      stageOccurrences: [],
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        id: TASK_ID,
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
        createdBy: 'actor-1',
        createdAt,
        updatedAt,
        externalRefs: [externalRef],
        artifacts: [
          {
            id: ARTIFACT_ID,
            deliveryTaskId: TASK_ID,
            repositoryKey: 'coredoc/coredoc-parser',
            kind: 'spec',
            createdAt,
            updatedAt: createdAt,
            revisions: [
              {
                id: REVISION_ID,
                sha256: 'a'.repeat(64),
                byteCount: 4,
                checkpoint: 'run-finish',
                runId: null,
                createdAt,
              },
              {
                id: OTHER_REVISION_ID,
                sha256: 'b'.repeat(64),
                byteCount: 4,
                checkpoint: 'session-start-reconcile',
                runId: 'cdr-20260816-a1b2c3',
                createdAt: updatedAt,
              },
            ],
          },
        ],
        workflowRuns: [directRun],
      },
    ]);
    const queryRaw = vi.fn().mockResolvedValue([
      { taskId: TASK_ID, runId: directRun.runId },
      { taskId: TASK_ID, runId: relatedRun.runId },
    ]);
    const relatedFindMany = vi.fn().mockResolvedValue([directRun, relatedRun]);
    const service = new CanonicalDeliveryService({
      deliveryTask: { findMany },
      workflowRun: { findMany: relatedFindMany },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);

    await expect(service.listTasks(WORKSPACE_ID)).resolves.toEqual({
      tasks: [
        {
          id: TASK_ID,
          repositoryKey: 'coredoc/coredoc-parser',
          lifecycle: 'active',
          authority: 'coredoc',
          createdBy: 'actor-1',
          createdAt: createdAt.toISOString(),
          updatedAt: updatedAt.toISOString(),
          externalRefs: [externalRef],
          artifacts: [
            {
              id: ARTIFACT_ID,
              taskId: TASK_ID,
              repositoryKey: 'coredoc/coredoc-parser',
              kind: 'spec',
              createdAt: createdAt.toISOString(),
              updatedAt: updatedAt.toISOString(),
              revisions: [
                {
                  id: REVISION_ID,
                  sha256: 'a'.repeat(64),
                  byteCount: 4,
                  checkpoint: 'run-finish',
                  runId: null,
                  createdAt: createdAt.toISOString(),
                },
                {
                  id: OTHER_REVISION_ID,
                  sha256: 'b'.repeat(64),
                  byteCount: 4,
                  checkpoint: 'session-start-reconcile',
                  runId: 'cdr-20260816-a1b2c3',
                  createdAt: updatedAt.toISOString(),
                },
              ],
            },
          ],
          workflowRuns: [
            {
              runId: 'cdr-20260816-a1b2c3',
              actorId: 'actor-1',
              workflowId: 'change:normal',
              intent: 'change',
              risk: 'normal',
              scale: 'normal',
              repositoryKey: 'coredoc/coredoc-parser',
              declaredStages: [{ stageId: 'tdd', after: [] }],
              startedAt: createdAt.toISOString(),
              finishedAt: updatedAt.toISOString(),
              outcome: 'success',
              stageOccurrences: [
                {
                  occurrenceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                  stageId: 'tdd',
                  attempt: 1,
                  startedAt: createdAt.toISOString(),
                  finishedAt: updatedAt.toISOString(),
                  outcome: 'success',
                },
              ],
            },
            {
              runId: 'cdr-20260816-b2c3d4',
              actorId: 'actor-1',
              workflowId: 'change:large',
              intent: 'change',
              risk: 'normal',
              scale: 'normal',
              repositoryKey: 'coredoc/coredoc-parser',
              declaredStages: [{ stageId: 'tdd', after: [] }],
              startedAt: createdAt.toISOString(),
              finishedAt: updatedAt.toISOString(),
              outcome: 'success',
              stageOccurrences: [],
            },
          ],
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: WORKSPACE_ID } }));
    expect(findMany.mock.calls[0]?.[0].select.artifacts.select.revisions.select).not.toHaveProperty('markdown');
    expect(relatedFindMany).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await service.listTasks(WORKSPACE_ID))).not.toContain('markdown');
  });
});

function canonicalTaskSummaryRow(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date('2026-08-17T10:00:00.000Z');
  return {
    id: TASK_ID,
    repositoryKey: 'coredoc/coredoc-parser',
    lifecycle: 'active',
    authority: 'coredoc',
    authorityRefId: null,
    authorityRef: null,
    title: null,
    createdBy: 'actor-1',
    createdAt,
    updatedAt: createdAt,
    shipEvidence: [],
    _count: {
      externalRefs: 0,
      workflowRuns: 0,
      codeChanges: 0,
      shipEvidence: 0,
      reworkSignals: 0,
      artifacts: 0,
    },
    ...overrides,
  };
}

describe('CanonicalDeliveryService task title (S3)', () => {
  it('carries the Jira-stamped title through task summaries', async () => {
    const findMany = vi.fn().mockResolvedValue([canonicalTaskSummaryRow({ title: 'Fix the flaky login test' })]);
    const service = new CanonicalDeliveryService({
      deliveryTask: { findMany },
      deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaService);

    const page = await service.listTaskSummaries(WORKSPACE_ID);

    expect(page.tasks[0]?.title).toBe('Fix the flaky login test');
  });

  it('carries the title through task detail, falling back to null when unstamped', async () => {
    const findUnique = vi.fn().mockResolvedValue(canonicalTaskSummaryRow({ title: null }));
    const service = new CanonicalDeliveryService({
      deliveryTask: { findUnique },
      deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue([]) },
      captureRetentionCheckpoint: { findUnique: vi.fn().mockResolvedValue(null) },
      workflowRun: { findMany: vi.fn().mockResolvedValue([]) },
      agentSession: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as unknown as PrismaService);

    const detail = await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    expect(detail.title).toBeNull();
  });
});

describe('CanonicalDeliveryService.listTaskCodeChanges (S4)', () => {
  function codeChangeRow(overrides: Record<string, unknown> = {}) {
    return {
      associationSource: 'issue_key',
      associationSourceValue: 'CORE-42',
      codeChange: {
        id: 'cc-1',
        provider: 'github',
        repoExternalId: 'repo-a',
        externalId: 'pr-1',
        number: 1,
        title: 'Add feature',
        state: 'open',
        isDraft: false,
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        mergedAt: null,
        updatedAt: new Date('2026-08-17T11:00:00.000Z'),
        createdAtSource: new Date('2026-08-17T10:00:00.000Z'),
        externalUrl: 'https://github.example/repo-a/pull/1',
        reviewCount: 3,
        commentCount: 7,
        ...overrides,
      },
    };
  }

  function contextPrisma(rows: unknown[]) {
    return {
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue({
          id: TASK_ID,
          authority: 'coredoc',
          authorityRefId: null,
          authorityRef: null,
        }),
      },
      deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue(rows) },
    } as unknown as PrismaService;
  }

  it('exposes externalUrl, reviewCount, and commentCount from the detail-shaped read', async () => {
    const service = new CanonicalDeliveryService(contextPrisma([codeChangeRow()]));

    const page = await service.listTaskCodeChanges(WORKSPACE_ID, TASK_ID);

    expect(page.items[0]).toMatchObject({
      externalUrl: 'https://github.example/repo-a/pull/1',
      reviewCount: 3,
      commentCount: 7,
    });
  });

  it('passes through null when a code change has no URL or counts recorded', async () => {
    const service = new CanonicalDeliveryService(
      contextPrisma([codeChangeRow({ externalUrl: null, reviewCount: null, commentCount: null })]),
    );

    const page = await service.listTaskCodeChanges(WORKSPACE_ID, TASK_ID);

    expect(page.items[0]).toMatchObject({ externalUrl: null, reviewCount: null, commentCount: null });
  });
});

describe('CanonicalDeliveryService cost-per-task rollup (S9)', () => {
  function detailPrisma(agentSessionIds: string[], sessionRows: unknown[]) {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(agentSessionIds.map((agentSessionId) => ({ agentSessionId })))
      .mockResolvedValueOnce([]);
    return {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(canonicalTaskSummaryRow()) },
      deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue([]) },
      captureRetentionCheckpoint: { findUnique: vi.fn().mockResolvedValue(null) },
      agentSession: { findMany: vi.fn().mockResolvedValue(sessionRows) },
      $queryRaw: queryRaw,
    } as unknown as PrismaService;
  }

  function sessionRow(overrides: Record<string, unknown> = {}) {
    return {
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
      tokensInput: 1_000_000,
      tokensOutput: 1_000_000,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensReasoning: 0,
      ...overrides,
    };
  }

  it('sums estimated cost over priced sessions and counts unpriced sessions separately', async () => {
    const priced = sessionRow();
    const unpriced = sessionRow({ model: 'a-model-not-in-the-price-map' });
    const service = new CanonicalDeliveryService(detailPrisma(['session-a', 'session-b'], [priced, unpriced]));

    const detail = await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    // priced: (1_000_000 * 3 + 1_000_000 * 15) / 1_000_000 = 18
    expect(detail.estimatedCost).toEqual({ totalUsd: 18, sessions: 2, unpricedSessions: 1, sessionsWithoutUsage: 0 });
  });

  it('keeps totalUsd null when every joined session is unpriced — never a computed $0.00', async () => {
    const unpricedA = sessionRow({ model: 'a-model-not-in-the-price-map' });
    const noUsage = sessionRow({
      model: null,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensReasoning: 0,
    });
    const service = new CanonicalDeliveryService(detailPrisma(['session-a', 'session-b'], [unpricedA, noUsage]));

    const detail = await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    expect(detail.estimatedCost).toEqual({
      totalUsd: null,
      sessions: 2,
      unpricedSessions: 1,
      sessionsWithoutUsage: 1,
    });
  });

  it('counts usage-less sessions in their own bucket so the three counters partition `sessions`', async () => {
    const priced = sessionRow();
    const unpriced = sessionRow({ model: 'a-model-not-in-the-price-map' });
    const noUsageA = sessionRow({ tokensInput: 0, tokensOutput: 0 });
    const noUsageB = sessionRow({ model: null, tokensInput: 0, tokensOutput: 0 });
    const service = new CanonicalDeliveryService(
      detailPrisma(['a', 'b', 'c', 'd'], [priced, unpriced, noUsageA, noUsageB]),
    );

    const { estimatedCost } = await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    // Without the third counter this renders "unpriced · 4 sessions · 1 unpriced session"
    // and leaves two sessions unaccounted for.
    expect(estimatedCost).toEqual({ totalUsd: 18, sessions: 4, unpricedSessions: 1, sessionsWithoutUsage: 2 });
    const priceable = estimatedCost.sessions - estimatedCost.unpricedSessions - estimatedCost.sessionsWithoutUsage;
    expect(priceable).toBe(1);
  });

  it('reports no session data when the task has no joined workflow runs', async () => {
    const service = new CanonicalDeliveryService(detailPrisma([], []));

    const detail = await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    expect(detail.estimatedCost).toEqual({
      totalUsd: null,
      sessions: 0,
      unpricedSessions: 0,
      sessionsWithoutUsage: 0,
    });
  });

  it('dedupes agent sessions shared by more than one run before joining', async () => {
    const prisma = detailPrisma(['session-a', 'session-a'], [sessionRow()]);
    const service = new CanonicalDeliveryService(prisma);

    await service.getTaskDetail(WORKSPACE_ID, TASK_ID);

    expect(prisma.agentSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WORKSPACE_ID, id: { in: ['session-a'] } } }),
    );
  });
});

describe('CanonicalDeliveryService window and member filters', () => {
  const USER_ID = 'user-1';
  const MEMBER_TASK_IDS = [TASK_ID, OTHER_TASK_ID];

  function readPrisma() {
    const findMany = vi.fn().mockResolvedValue([]);
    const queryRaw = vi.fn().mockResolvedValue(MEMBER_TASK_IDS.map((taskId) => ({ taskId })));
    return {
      findMany,
      queryRaw,
      service: new CanonicalDeliveryService({
        deliveryTask: { findMany },
        deliveryTaskCodeChange: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: queryRaw,
      } as unknown as PrismaService),
    };
  }

  it('rejects a half-specified, inverted or oversized custom range on both reads', async () => {
    const { service } = readPrisma();

    await expect(
      service.listTaskSummaries(WORKSPACE_ID, undefined, undefined, undefined, undefined, '2026-08-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getDeliverySummary(WORKSPACE_ID, undefined, undefined, undefined, '2026-08-31'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getDeliverySummary(WORKSPACE_ID, undefined, undefined, '2026-08-31', '2026-08-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getDeliverySummary(WORKSPACE_ID, undefined, undefined, '2026-01-01', '2026-08-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getDeliverySummary(WORKSPACE_ID, undefined, undefined, '2026-02-30', '2026-03-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bounds the population by the custom range on both edges and reports it in the summary window', async () => {
    const { findMany, service } = readPrisma();

    const summary = await service.getDeliverySummary(WORKSPACE_ID, '7', 'all', '2026-08-01', '2026-08-31');

    expect(summary.window).toEqual({
      days: 31,
      since: '2026-08-01T00:00:00.000Z',
      until: '2026-09-01T00:00:00.000Z',
      lifecycle: 'all',
      userId: null,
    });
    expect(findMany.mock.calls[0][0].where.updatedAt).toEqual({
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lt: new Date('2026-09-01T00:00:00.000Z'),
    });
  });

  it('binds the effective window and the member filter to the cursor scope', async () => {
    const { service } = readPrisma();
    const mineCursor = encodeDeliveryCursor(deliveryCursorScope.taskSummaries({ days: 7 }, 'all', USER_ID), [
      '2026-08-17T12:34:56.789Z',
      TASK_ID,
    ]);

    // Same window, but replayed without the member filter — the page would otherwise widen.
    await expect(service.listTaskSummaries(WORKSPACE_ID, undefined, mineCursor, '7', 'all')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.listTaskSummaries(
        WORKSPACE_ID,
        undefined,
        mineCursor,
        undefined,
        'all',
        '2026-08-01',
        '2026-08-31',
        USER_ID,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.listTaskSummaries(WORKSPACE_ID, undefined, mineCursor, '7', 'all', undefined, undefined, USER_ID),
    ).resolves.toEqual({ tasks: [], nextCursor: null });
  });

  it('resolves the caller task ids once per read and intersects them under AND in both reads', async () => {
    const list = readPrisma();
    await list.service.listTaskSummaries(WORKSPACE_ID, undefined, undefined, '7', 'all', undefined, undefined, USER_ID);

    expect(list.queryRaw).toHaveBeenCalledTimes(1);
    expect(list.findMany.mock.calls[0][0].where.AND).toEqual([{ id: { in: MEMBER_TASK_IDS } }]);
    // The association query is self-scoped and bounded on both window edges.
    const values = list.queryRaw.mock.calls[0][0].values;
    expect(values).toContain(USER_ID);
    expect(values.filter((value: unknown) => value instanceof Date)).toHaveLength(2);
    expect(list.queryRaw.mock.calls[0][0].strings.join(' ')).toContain('agent_sessions');

    const summary = readPrisma();
    const result = await summary.service.getDeliverySummary(WORKSPACE_ID, '7', 'all', undefined, undefined, USER_ID);

    expect(summary.queryRaw).toHaveBeenCalledTimes(1);
    expect(summary.findMany.mock.calls[0][0].where.AND).toEqual([{ id: { in: MEMBER_TASK_IDS } }]);
    expect(result.window.userId).toBe(USER_ID);
  });

  it('keeps the rework predicate alongside the member filter instead of overwriting it', async () => {
    const { findMany, service } = readPrisma();

    await service.getDeliverySummary(WORKSPACE_ID, '7', 'rework', undefined, undefined, USER_ID);

    const where = findMany.mock.calls[0][0].where;
    expect(where.reworkSignals).toEqual({
      some: { kind: { in: ['tracker_reopened', 'review_changes_requested', 'review_commented'] } },
    });
    expect(where.AND).toEqual([{ id: { in: MEMBER_TASK_IDS } }]);
  });

  it('leaves the unfiltered task-summaries read unwindowed and unfiltered', async () => {
    const { findMany, queryRaw, service } = readPrisma();

    await service.listTaskSummaries(WORKSPACE_ID);

    expect(findMany.mock.calls[0][0].where).toEqual({ workspaceId: WORKSPACE_ID });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
