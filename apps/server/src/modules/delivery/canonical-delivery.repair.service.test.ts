import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_CONNECTOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REF_ID = 101n;
const FALLBACK_REF_ID = 102n;
const SOURCE_UPDATED_AT = '2026-08-17T10:00:00.000Z';
const OBSERVED_AT = '2026-08-17T10:05:00.000Z';

function connector(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    workspaceId: WORKSPACE_ID,
    provider: 'jira',
    ...overrides,
  };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    repositoryKey: null,
    externalId: '10042',
    externalKey: 'CORE-42',
    externalUrl: 'https://jira.example.test/browse/CORE-42',
    externalState: 'In Progress',
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function ref(overrides: Record<string, unknown> = {}) {
  return {
    id: REF_ID,
    workspaceId: WORKSPACE_ID,
    deliveryTaskId: TASK_ID,
    provider: 'jira',
    externalId: '10042',
    externalKey: 'CORE-42',
    externalUrl: 'https://jira.example.test/browse/CORE-42',
    externalState: 'In Progress',
    connectorId: CONNECTOR_ID,
    sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
    lastObservedAt: new Date(OBSERVED_AT),
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    lifecycle: 'active',
    authority: 'coredoc',
    authorityRefId: null,
    authorityRef: null,
    ...overrides,
  };
}

function transactionPrisma(tx: Record<string, unknown>) {
  return {
    ...tx,
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
  } as unknown as PrismaService;
}

function canonicalExternalAuthority(externalRefId = REF_ID, externalId = '10042') {
  return {
    kind: 'external_ref',
    externalRefId: externalRefId.toString(),
    provider: 'jira',
    externalId,
    externalKey: 'CORE-42',
    connected: true,
    sourceCreatedAt: null,
  };
}

function attachBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'jira',
    externalId: '10042',
    connectorId: CONNECTOR_ID,
    makeAuthority: false,
    ...overrides,
  };
}

describe('CanonicalDeliveryService C2 repair acceptance gaps', () => {
  it('returns the same privacy-preserving 404 for a missing task and a cross-workspace connector', async () => {
    const missingTaskTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(null) },
      deliveryConnector: { findFirst: vi.fn() },
      taskExternalRef: { findUnique: vi.fn(), create: vi.fn() },
    };
    const missingTask = new CanonicalDeliveryService(transactionPrisma(missingTaskTx));
    await expect(missingTask.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(missingTaskTx.deliveryConnector.findFirst).not.toHaveBeenCalled();

    const foreignConnectorTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()) },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(null) },
      taskExternalRef: { findUnique: vi.fn(), create: vi.fn() },
    };
    const foreignConnector = new CanonicalDeliveryService(transactionPrisma(foreignConnectorTx));
    await expect(foreignConnector.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(foreignConnectorTx.taskExternalRef.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a supplied connector whose provider contradicts the requested identity', async () => {
    const tx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()) },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connector({ provider: 'github' })) },
      taskExternalRef: { findUnique: vi.fn(), create: vi.fn() },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    const promise = service.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody());
    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_EXTERNAL_REF_CONFLICT' }),
    });
    expect(tx.taskExternalRef.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 and preserves state for a missing target ref or unattached external fallback', async () => {
    const missingTargetTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()) },
      taskExternalRef: { findFirst: vi.fn().mockResolvedValue(null), delete: vi.fn() },
    };
    const missingTarget = new CanonicalDeliveryService(transactionPrisma(missingTargetTx));
    await expect(missingTarget.detachExternalRef(WORKSPACE_ID, TASK_ID, REF_ID.toString(), {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(missingTargetTx.taskExternalRef.delete).not.toHaveBeenCalled();

    const findFirst = vi.fn().mockResolvedValueOnce(ref()).mockResolvedValueOnce(null);
    const foreignFallbackTx = {
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(task({ authority: 'connector:jira', authorityRefId: REF_ID, authorityRef: ref() })),
        update: vi.fn(),
      },
      taskExternalRef: { findFirst, delete: vi.fn() },
    };
    const foreignFallback = new CanonicalDeliveryService(transactionPrisma(foreignFallbackTx));
    await expect(
      foreignFallback.detachExternalRef(WORKSPACE_ID, TASK_ID, REF_ID.toString(), {
        fallbackAuthority: { kind: 'external_ref', externalRefId: FALLBACK_REF_ID.toString() },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(foreignFallbackTx.deliveryTask.update).not.toHaveBeenCalled();
    expect(foreignFallbackTx.taskExternalRef.delete).not.toHaveBeenCalled();
  });

  it('rebinds disconnected provenance on matching refresh and rejects a different live connector claim', async () => {
    const rebindUpdate = vi.fn().mockResolvedValue(ref({ connectorId: CONNECTOR_ID }));
    const rebindTx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(ref({ connectorId: null })),
        update: rebindUpdate,
      },
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            task({ authority: 'connector:jira', authorityRefId: REF_ID, authorityRef: ref({ connectorId: null }) }),
          ),
        update: vi.fn(),
      },
    };
    const rebind = new CanonicalDeliveryService(transactionPrisma(rebindTx));
    await expect(rebind.resolveConnectorTask(CONNECTOR_ID, observation())).resolves.toMatchObject({
      status: 'duplicate',
      authority: canonicalExternalAuthority(),
    });
    expect(rebindUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ connectorId: CONNECTOR_ID }) }),
    );

    const conflictTx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(ref({ connectorId: OTHER_CONNECTOR_ID })),
        update: vi.fn(),
      },
      deliveryTask: { findUnique: vi.fn(), update: vi.fn() },
    };
    const conflict = new CanonicalDeliveryService(transactionPrisma(conflictTx));
    const promise = conflict.resolveConnectorTask(CONNECTOR_ID, observation());
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_EXTERNAL_REF_CONFLICT' }),
    });
    expect(conflictTx.taskExternalRef.update).not.toHaveBeenCalled();
  });

  it('rebinds a same-task manual ref through explicit repair without ever clearing live provenance', async () => {
    const rebindUpdate = vi.fn().mockResolvedValue(ref({ connectorId: CONNECTOR_ID }));
    const rebindTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()), update: vi.fn() },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(ref({ connectorId: null })),
        update: rebindUpdate,
        create: vi.fn(),
      },
    };
    const rebind = new CanonicalDeliveryService(transactionPrisma(rebindTx));
    await expect(rebind.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody())).resolves.toMatchObject({
      status: 'duplicate',
      taskId: TASK_ID,
    });
    expect(rebindUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ connectorId: CONNECTOR_ID }) }),
    );

    const retainTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()), update: vi.fn() },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(ref()),
        update: vi.fn(),
        create: vi.fn(),
      },
    };
    const retain = new CanonicalDeliveryService(transactionPrisma(retainTx));
    await expect(
      retain.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody({ connectorId: null })),
    ).resolves.toMatchObject({ status: 'duplicate' });
    expect(retainTx.taskExternalRef.update).not.toHaveBeenCalled();
  });

  it('fails closed on unresolved legacy authority but lets explicit makeAuthority repair it', async () => {
    const unresolvedTask = task({ authority: 'connector:jira', authorityRefId: null, authorityRef: null });
    const resolverTx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(ref()), update: vi.fn() },
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(unresolvedTask), update: vi.fn() },
    };
    const resolver = new CanonicalDeliveryService(transactionPrisma(resolverTx));
    await expect(resolver.resolveConnectorTask(CONNECTOR_ID, observation())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TASK_AUTHORITY_MIGRATION_REQUIRED' }),
    });
    expect(resolverTx.deliveryTask.update).not.toHaveBeenCalled();

    const repairedTask = task({
      authority: 'connector:jira',
      authorityRefId: REF_ID,
      authorityRef: ref(),
    });
    const repairTx = {
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue(unresolvedTask),
        update: vi.fn().mockResolvedValue(repairedTask),
      },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(ref()), update: vi.fn(), create: vi.fn() },
    };
    const repair = new CanonicalDeliveryService(transactionPrisma(repairTx));
    await expect(
      repair.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody({ makeAuthority: true })),
    ).resolves.toMatchObject({
      status: 'duplicate',
      authority: canonicalExternalAuthority(),
    });
    expect(repairTx.deliveryTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { authority: 'connector:jira', authorityRefId: REF_ID } }),
    );
  });

  it('does not let connector refresh steal authority from a Coredoc-owned task', async () => {
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(ref()), update: vi.fn() },
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()), update: vi.fn() },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(service.resolveConnectorTask(CONNECTOR_ID, observation())).resolves.toMatchObject({
      status: 'duplicate',
      taskId: TASK_ID,
      authority: { kind: 'coredoc' },
    });
    expect(tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  // Malformed *bodies* are rejected by the controller's `ZodValidationPipe` and are covered by
  // `canonical-delivery.contract.test.ts` and `canonical-delivery.validation-parity.test.ts`;
  // what remains here is what the service still owns — path segments and connector input.
  it('maps malformed path and unsafe provider input to bounded 400s before persistence', async () => {
    const transaction = vi.fn();
    const service = new CanonicalDeliveryService({ $transaction: transaction } as unknown as PrismaService);

    await expect(service.detachExternalRef(WORKSPACE_ID, TASK_ID, '01', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.resolveConnectorTask(CONNECTOR_ID, observation({ externalUrl: 'http://jira.example.test/CORE-42' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate', SOURCE_UPDATED_AT],
    ['stale', '2026-08-17T09:00:00.000Z'],
  ])('advances lastObservedAt without changing source facts on a %s observation', async (_label, sourceUpdatedAt) => {
    const laterObservedAt = '2026-08-17T10:10:00.000Z';
    const update = vi.fn().mockResolvedValue(ref({ lastObservedAt: new Date(laterObservedAt) }));
    const tx = {
      deliveryConnector: { findUnique: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: { findUnique: vi.fn().mockResolvedValue(ref()), update },
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(task({ authority: 'connector:jira', authorityRefId: REF_ID, authorityRef: ref() })),
        update: vi.fn(),
      },
    };
    const service = new CanonicalDeliveryService(transactionPrisma(tx));

    await expect(
      service.resolveConnectorTask(CONNECTOR_ID, observation({ sourceUpdatedAt, observedAt: laterObservedAt })),
    ).resolves.toMatchObject({ taskId: TASK_ID });
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ lastObservedAt: new Date(laterObservedAt) });
    expect(data).not.toHaveProperty('sourceUpdatedAt');
    expect(data).not.toHaveProperty('externalKey');
    expect(data).not.toHaveProperty('externalUrl');
    expect(data).not.toHaveProperty('externalState');
  });

  it('creates a connector-owned ref with exact authority and a manual ref without authority', async () => {
    const connectorRef = ref();
    const authoritativeTask = task({
      authority: 'connector:jira',
      authorityRefId: REF_ID,
      authorityRef: connectorRef,
    });
    const connectorTx = {
      deliveryTask: {
        findUnique: vi.fn().mockResolvedValue(task()),
        update: vi.fn().mockResolvedValue(authoritativeTask),
      },
      deliveryConnector: { findFirst: vi.fn().mockResolvedValue(connector()) },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(connectorRef),
        update: vi.fn(),
      },
    };
    const connectorAttach = new CanonicalDeliveryService(transactionPrisma(connectorTx));
    await expect(
      connectorAttach.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody({ makeAuthority: true })),
    ).resolves.toEqual({
      status: 'attached',
      taskId: TASK_ID,
      externalRef: { id: REF_ID.toString(), provider: 'jira', externalId: '10042' },
      authority: canonicalExternalAuthority(),
    });
    expect(connectorTx.taskExternalRef.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ connectorId: CONNECTOR_ID }) }),
    );
    expect(connectorTx.deliveryTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { authority: 'connector:jira', authorityRefId: REF_ID } }),
    );

    const manualRef = ref({ connectorId: null });
    const manualTx = {
      deliveryTask: { findUnique: vi.fn().mockResolvedValue(task()), update: vi.fn() },
      taskExternalRef: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(manualRef),
        update: vi.fn(),
      },
    };
    const manualAttach = new CanonicalDeliveryService(transactionPrisma(manualTx));
    await expect(
      manualAttach.attachExternalRef(WORKSPACE_ID, TASK_ID, attachBody({ connectorId: null })),
    ).resolves.toMatchObject({
      status: 'attached',
      authority: { kind: 'coredoc' },
    });
    expect(manualTx.taskExternalRef.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ connectorId: null }) }),
    );
    expect(manualTx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it('rejects a disconnected external fallback and returns the full frozen shape for a live fallback', async () => {
    const target = ref();
    const disconnectedFallback = ref({ id: FALLBACK_REF_ID, externalId: '10043', connectorId: null });
    const disconnectedTx = {
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(task({ authority: 'connector:jira', authorityRefId: REF_ID, authorityRef: target })),
        update: vi.fn(),
      },
      taskExternalRef: {
        findFirst: vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(disconnectedFallback),
        delete: vi.fn(),
      },
    };
    const disconnected = new CanonicalDeliveryService(transactionPrisma(disconnectedTx));
    await expect(
      disconnected.detachExternalRef(WORKSPACE_ID, TASK_ID, REF_ID.toString(), {
        fallbackAuthority: { kind: 'external_ref', externalRefId: FALLBACK_REF_ID.toString() },
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'TASK_AUTHORITY_CONFLICT' }) });
    expect(disconnectedTx.deliveryTask.update).not.toHaveBeenCalled();
    expect(disconnectedTx.taskExternalRef.delete).not.toHaveBeenCalled();

    const liveFallback = ref({ id: FALLBACK_REF_ID, externalId: '10043' });
    const switchedTask = task({
      authority: 'connector:jira',
      authorityRefId: FALLBACK_REF_ID,
      authorityRef: liveFallback,
    });
    const liveTx = {
      deliveryTask: {
        findUnique: vi
          .fn()
          .mockResolvedValue(task({ authority: 'connector:jira', authorityRefId: REF_ID, authorityRef: target })),
        update: vi.fn().mockResolvedValue(switchedTask),
      },
      taskExternalRef: {
        findFirst: vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(liveFallback),
        delete: vi.fn().mockResolvedValue(target),
      },
    };
    const live = new CanonicalDeliveryService(transactionPrisma(liveTx));
    await expect(
      live.detachExternalRef(WORKSPACE_ID, TASK_ID, REF_ID.toString(), {
        fallbackAuthority: { kind: 'external_ref', externalRefId: FALLBACK_REF_ID.toString() },
      }),
    ).resolves.toEqual({
      status: 'detached',
      taskId: TASK_ID,
      authority: canonicalExternalAuthority(FALLBACK_REF_ID, '10043'),
    });
    expect(liveTx.deliveryTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { authority: 'connector:jira', authorityRefId: FALLBACK_REF_ID } }),
    );
    expect(liveTx.taskExternalRef.delete).toHaveBeenCalled();
  });
});
