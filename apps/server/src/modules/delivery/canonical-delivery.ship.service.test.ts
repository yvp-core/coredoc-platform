import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TASK_ID = 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHIPPED_AT = '2026-08-17T12:34:56.789Z';
const RECEIVED_AT = new Date('2026-08-17T12:35:00.000Z');

type TaskRow = {
  workspaceId: string;
  id: string;
  lifecycle: string;
};

type EvidenceRow = {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  source: string;
  sourceKey: string;
  occurredAt: Date;
  receivedAt: Date;
  actorId: string | null;
  provider: string | null;
  repoExternalId: string | null;
  externalId: string | null;
};

function evidenceKey(workspaceId: string, source: string, sourceKey: string): string {
  return `${workspaceId}:${source}:${sourceKey}`;
}

function shipStore(options: { concurrentFirstWrite?: boolean } = {}) {
  const tasks = new Map<string, TaskRow>(
    [TASK_ID, OTHER_TASK_ID].map((id) => [
      `${WORKSPACE_ID}:${id}`,
      { workspaceId: WORKSPACE_ID, id, lifecycle: 'active' },
    ]),
  );
  const evidence = new Map<string, EvidenceRow>();
  let createAttempts = 0;

  const deliveryTaskFindUnique = vi.fn(
    async (args: { where: { workspaceId_id: { workspaceId: string; id: string } } }) => {
      const key = args.where.workspaceId_id;
      return tasks.get(`${key.workspaceId}:${key.id}`) ?? null;
    },
  );
  const deliveryTaskUpdate = vi.fn();
  const evidenceFindUnique = vi.fn(
    async (args: {
      where: { workspaceId_source_sourceKey: { workspaceId: string; source: string; sourceKey: string } };
    }) => {
      const key = args.where.workspaceId_source_sourceKey;
      return evidence.get(evidenceKey(key.workspaceId, key.source, key.sourceKey)) ?? null;
    },
  );
  const evidenceCreate = vi.fn(async (args: { data: Omit<EvidenceRow, 'id' | 'receivedAt'> }) => {
    createAttempts += 1;
    const key = evidenceKey(args.data.workspaceId, args.data.source, args.data.sourceKey);
    const proposed: EvidenceRow = {
      id: BigInt(evidence.size + 1),
      receivedAt: RECEIVED_AT,
      ...args.data,
    };

    if (options.concurrentFirstWrite && createAttempts === 1) {
      // Model another transaction winning the same unique insert before this
      // transaction reports P2002. The service must retry once and take the
      // established duplicate path.
      evidence.set(key, proposed);
      throw Object.assign(new Error('concurrent ship-evidence insert'), { code: 'P2002' });
    }
    if (evidence.has(key)) throw Object.assign(new Error('duplicate ship evidence'), { code: 'P2002' });
    evidence.set(key, proposed);
    return proposed;
  });

  const tx = {
    deliveryTask: { findUnique: deliveryTaskFindUnique, update: deliveryTaskUpdate },
    deliveryShipEvidence: { findUnique: evidenceFindUnique, create: evidenceCreate },
  };
  const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaService;

  return {
    service: new CanonicalDeliveryService(prisma),
    tasks,
    evidence,
    transaction,
    deliveryTaskFindUnique,
    deliveryTaskUpdate,
    evidenceFindUnique,
    evidenceCreate,
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return { eventId: EVENT_ID, shippedAt: SHIPPED_AT, ...overrides };
}

describe('CanonicalDeliveryService.recordCoredocShipEvidence', () => {
  it('stores one bounded historical fact without mutating current lifecycle', async () => {
    const store = shipStore();

    await expect(store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', TASK_ID, body())).resolves.toEqual({
      status: 'accepted',
      taskId: TASK_ID,
      eventId: EVENT_ID,
      shippedAt: SHIPPED_AT,
    });

    expect([...store.evidence.values()]).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        deliveryTaskId: TASK_ID,
        source: 'coredoc',
        sourceKey: EVENT_ID,
        occurredAt: new Date(SHIPPED_AT),
        receivedAt: RECEIVED_AT,
        actorId: 'admin-a',
        provider: null,
        repoExternalId: null,
        externalId: null,
      }),
    ]);
    expect(store.tasks.get(`${WORKSPACE_ID}:${TASK_ID}`)?.lifecycle).toBe('active');
    expect(store.deliveryTaskUpdate).not.toHaveBeenCalled();
  });

  it('returns an identical duplicate receipt without replacing the first authenticated actor', async () => {
    const store = shipStore();
    await store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', TASK_ID, body());

    await expect(store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-b', TASK_ID, body())).resolves.toEqual({
      status: 'duplicate',
      taskId: TASK_ID,
      eventId: EVENT_ID,
      shippedAt: SHIPPED_AT,
    });

    expect(store.evidence).toHaveLength(1);
    expect([...store.evidence.values()][0]?.actorId).toBe('admin-a');
    expect(store.evidenceCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse on the same task with a changed occurrence time', async () => {
    const store = shipStore();
    await store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', TASK_ID, body());

    await expect(
      store.service.recordCoredocShipEvidence(
        WORKSPACE_ID,
        'admin-a',
        TASK_ID,
        body({ shippedAt: '2026-08-17T12:35:56.789Z' }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'SHIP_EVIDENCE_CONFLICT' }),
    });
    expect(store.evidence).toHaveLength(1);
  });

  it('rejects reuse of one event identity against another task', async () => {
    const store = shipStore();
    await store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', TASK_ID, body());

    await expect(
      store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', OTHER_TASK_ID, body()),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'SHIP_EVIDENCE_CONFLICT' }),
    });
    expect(store.evidence).toHaveLength(1);
  });

  it('uses the same bounded 404 for an absent or cross-workspace task before reading evidence', async () => {
    const store = shipStore();

    await expect(
      store.service.recordCoredocShipEvidence(
        WORKSPACE_ID,
        'admin-a',
        'cdt_dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        body(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      store.service.recordCoredocShipEvidence(OTHER_WORKSPACE_ID, 'admin-a', TASK_ID, body()),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(store.evidenceFindUnique).not.toHaveBeenCalled();
    expect(store.evidenceCreate).not.toHaveBeenCalled();
  });

  it('retries one concurrent first-write P2002 and returns the established duplicate', async () => {
    const store = shipStore({ concurrentFirstWrite: true });

    await expect(store.service.recordCoredocShipEvidence(WORKSPACE_ID, 'admin-a', TASK_ID, body())).resolves.toEqual({
      status: 'duplicate',
      taskId: TASK_ID,
      eventId: EVENT_ID,
      shippedAt: SHIPPED_AT,
    });

    expect(store.transaction).toHaveBeenCalledTimes(2);
    expect(store.evidence).toHaveLength(1);
  });
});
