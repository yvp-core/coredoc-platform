import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { StatusMapService } from './status-map.service.js';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '22222222-2222-4222-8222-222222222222';
const REBOUND_CONNECTOR_ID = '22222222-2222-4222-8222-333333333333';
const TASK_ID = 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_ID = 101n;
const OTHER_REF_ID = 202n;
const RECREATED_REF_ID = 303n;
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_UPDATED_AT = new Date('2026-08-17T12:00:00.000Z');
const OBSERVED_AT = new Date('2026-08-17T12:05:00.000Z');

type Lifecycle = 'active' | 'completed' | 'abandoned';

interface TaskRow {
  workspaceId: string;
  id: string;
  lifecycle: Lifecycle;
  authority: string;
  authorityRefId: bigint | null;
  title: string | null;
}

interface RefRow {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  provider: string;
  externalId: string;
  externalState: string | null;
  connectorId: string | null;
  sourceUpdatedAt: Date | null;
  lastObservedAt: Date | null;
}

interface StatusMapRow {
  workspaceId: string;
  connectorId: string;
  statusRaw: string;
  lifecycle: Lifecycle | null;
  createsShipEvidence: boolean;
  source: 'default' | 'admin';
}

interface StateFactRow {
  id: bigint;
  workspaceId: string;
  externalRefId: bigint;
  sourceRef: string;
  fromState: string | null;
  toState: string;
  occurredAt: Date;
  sourceUpdatedAt: Date;
  receivedAt: Date;
  actorId: string | null;
}

interface ShipEvidenceRow {
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
}

interface ReworkSignalRow {
  id: bigint;
  workspaceId: string;
  deliveryTaskId: string;
  kind: string;
  sourceKey: string;
  sourceRef: string;
  occurredAt: Date;
  observedAt: Date;
}

interface ProjectionSeed {
  task?: Partial<TaskRow>;
  ref?: Partial<RefRow>;
  maps?: StatusMapRow[];
  stateFacts?: StateFactRow[];
  shipEvidence?: ShipEvidenceRow[];
  reworkSignals?: ReworkSignalRow[];
}

function deepField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = deepField(entry, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (key in record) return record[key];
  for (const entry of Object.values(record)) {
    const found = deepField(entry, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function p2002(): Error & { code: string } {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

/**
 * Stateful Prisma double for the C3 append-only projection. It models unique-key
 * convergence rather than merely recording calls, so a duplicate projection has to
 * take an established-row path and a contradictory replay remains observable.
 */
function projectionPrisma(seed: ProjectionSeed = {}) {
  const task: TaskRow = {
    workspaceId: WORKSPACE_ID,
    id: TASK_ID,
    lifecycle: 'active',
    authority: 'connector:jira',
    authorityRefId: REF_ID,
    title: null,
    ...seed.task,
  };
  const ref: RefRow = {
    id: REF_ID,
    workspaceId: WORKSPACE_ID,
    deliveryTaskId: TASK_ID,
    provider: 'jira',
    externalId: '10042',
    externalState: 'In Progress',
    connectorId: CONNECTOR_ID,
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    lastObservedAt: OBSERVED_AT,
    ...seed.ref,
  };
  const maps = seed.maps ?? [
    statusMap('In Progress', 'active'),
    statusMap('Done', 'completed'),
    statusMap('Abandoned', 'abandoned'),
  ];
  const stateFacts = [...(seed.stateFacts ?? [])];
  const shipEvidence = [...(seed.shipEvidence ?? [])];
  const reworkSignals = [...(seed.reworkSignals ?? [])];

  const findFact = (args: unknown) => {
    const sourceRef = deepField(args, 'sourceRef');
    const externalRefId = deepField(args, 'externalRefId');
    return (
      stateFacts.find(
        (row) =>
          (sourceRef === undefined || row.sourceRef === sourceRef) &&
          (externalRefId === undefined || row.externalRefId === externalRefId),
      ) ?? null
    );
  };
  const findEvidence = (args: unknown) => {
    const source = deepField(args, 'source');
    const sourceKey = deepField(args, 'sourceKey');
    return (
      shipEvidence.find(
        (row) =>
          (source === undefined || row.source === source) && (sourceKey === undefined || row.sourceKey === sourceKey),
      ) ?? null
    );
  };
  const findSignal = (args: unknown) => {
    const kind = deepField(args, 'kind');
    const sourceKey = deepField(args, 'sourceKey');
    return (
      reworkSignals.find(
        (row) => (kind === undefined || row.kind === kind) && (sourceKey === undefined || row.sourceKey === sourceKey),
      ) ?? null
    );
  };

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: CONNECTOR_ID }]),
    deliveryTask: {
      findUnique: vi.fn(async (_args: unknown) => ({ ...task })),
      findFirst: vi.fn(async () => ({ ...task })),
      update: vi.fn(async (args: unknown) => {
        const lifecycle = deepField(args, 'lifecycle');
        if (lifecycle === 'active' || lifecycle === 'completed' || lifecycle === 'abandoned') {
          task.lifecycle = lifecycle;
        }
        const data = (args as { data?: Record<string, unknown> }).data ?? {};
        if (typeof data.title === 'string') task.title = data.title;
        return { ...task };
      }),
    },
    taskExternalRef: {
      findUnique: vi.fn(async () => ({ ...ref })),
      findFirst: vi.fn(async () => ({ ...ref })),
      findMany: vi.fn(async (_args: unknown) => [{ ...ref }]),
    },
    deliveryStatusMap: {
      findMany: vi.fn(async (args: unknown) => {
        const connectorId = deepField(args, 'connectorId');
        return maps
          .filter((row) => connectorId === undefined || row.connectorId === connectorId)
          .map((row) => ({ ...row }));
      }),
      findFirst: vi.fn(async (args: unknown) => {
        const statusRaw = deepField(args, 'statusRaw');
        return maps.find((row) => row.statusRaw === statusRaw) ?? null;
      }),
      findUnique: vi.fn(async (args: unknown) => {
        const statusRaw = deepField(args, 'statusRaw');
        return maps.find((row) => row.statusRaw === statusRaw) ?? null;
      }),
    },
    taskExternalRefStateFact: {
      findUnique: vi.fn(async (args: unknown) => findFact(args)),
      findFirst: vi.fn(async (args: unknown) => findFact(args)),
      findMany: vi.fn(async (args: unknown) => {
        const externalRefId = deepField(args, 'externalRefId');
        return stateFacts
          .filter((row) => externalRefId === undefined || row.externalRefId === externalRefId)
          .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || Number(left.id - right.id));
      }),
      create: vi.fn(async (args: { data: Omit<StateFactRow, 'id'> }) => {
        if (findFact(args)) throw p2002();
        const row = { id: BigInt(stateFacts.length + 1), ...args.data };
        stateFacts.push(row);
        return { ...row };
      }),
      upsert: vi.fn(async (args: { create: Omit<StateFactRow, 'id'> }) => {
        const established = findFact(args);
        if (established) return established;
        const row = { id: BigInt(stateFacts.length + 1), ...args.create };
        stateFacts.push(row);
        return { ...row };
      }),
    },
    deliveryShipEvidence: {
      findUnique: vi.fn(async (args: unknown) => findEvidence(args)),
      findFirst: vi.fn(async (args: unknown) => findEvidence(args)),
      create: vi.fn(async (args: { data: Omit<ShipEvidenceRow, 'id'> }) => {
        if (findEvidence(args)) throw p2002();
        const row = { id: BigInt(shipEvidence.length + 1), ...args.data };
        shipEvidence.push(row);
        return { ...row };
      }),
      upsert: vi.fn(async (args: { create: Omit<ShipEvidenceRow, 'id'> }) => {
        const established = findEvidence(args);
        if (established) return established;
        const row = { id: BigInt(shipEvidence.length + 1), ...args.create };
        shipEvidence.push(row);
        return { ...row };
      }),
    },
    deliveryReworkSignal: {
      findUnique: vi.fn(async (args: unknown) => findSignal(args)),
      findFirst: vi.fn(async (args: unknown) => findSignal(args)),
      create: vi.fn(async (args: { data: Omit<ReworkSignalRow, 'id'> }) => {
        if (findSignal(args)) throw p2002();
        const row = { id: BigInt(reworkSignals.length + 1), ...args.data };
        reworkSignals.push(row);
        return { ...row };
      }),
      upsert: vi.fn(async (args: { create: Omit<ReworkSignalRow, 'id'> }) => {
        const established = findSignal(args);
        if (established) return established;
        const row = { id: BigInt(reworkSignals.length + 1), ...args.create };
        reworkSignals.push(row);
        return { ...row };
      }),
    },
  };

  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
  const prisma = {
    ...tx,
    $transaction: transaction,
  } as unknown as PrismaService;

  return { prisma, tx, transaction, task, ref, maps, stateFacts, shipEvidence, reworkSignals };
}

function statusMap(
  statusRaw: string,
  lifecycle: Lifecycle | null,
  overrides: Partial<StatusMapRow> = {},
): StatusMapRow {
  return {
    workspaceId: WORKSPACE_ID,
    connectorId: CONNECTOR_ID,
    statusRaw,
    lifecycle,
    createsShipEvidence: false,
    source: 'default',
    ...overrides,
  };
}

function transition(
  sourceRef: string,
  fromState: string | null,
  toState: string,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sourceRef,
    fromState,
    toState,
    occurredAt: new Date(occurredAt),
    actorId: ACTOR_ID,
    ...overrides,
  };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    connectorId: CONNECTOR_ID,
    taskId: TASK_ID,
    externalRefId: REF_ID,
    currentState: 'In Progress',
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    observedAt: OBSERVED_AT,
    transitions: [transition('history-1', null, 'In Progress', '2026-08-17T10:00:00.000Z')],
    ...overrides,
  };
}

function projectionService(state: ReturnType<typeof projectionPrisma>): JiraCanonicalProjectionService {
  return new JiraCanonicalProjectionService(state.prisma, new StatusMapService(state.prisma));
}

describe('JiraCanonicalProjectionService.projectIssue', () => {
  let state: ReturnType<typeof projectionPrisma>;
  let service: JiraCanonicalProjectionService;

  beforeEach(() => {
    state = projectionPrisma();
    service = projectionService(state);
  });

  it('locks the connector for share and reads its map in the same transaction before derived writes', async () => {
    const canonicalMap = new Map([
      ['in progress', { lifecycle: 'active' as const, createsShipEvidence: false }],
      ['done', { lifecycle: 'completed' as const, createsShipEvidence: true }],
    ]);
    const getCanonicalMap = vi.fn().mockResolvedValue(canonicalMap);
    service = new JiraCanonicalProjectionService(state.prisma, { getCanonicalMap } as unknown as StatusMapService);

    await service.projectIssue(
      projection({
        currentState: 'Done',
        transitions: [transition('history-lock', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z')],
      }),
    );

    expect(state.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [segments, ...parameters] = state.tx.$queryRaw.mock.calls[0];
    expect(segments.join('?')).toContain('FOR SHARE');
    expect(parameters).toEqual([WORKSPACE_ID, CONNECTOR_ID]);
    expect(getCanonicalMap).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTOR_ID, state.tx);
    expect(state.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(getCanonicalMap.mock.invocationCallOrder[0]);
    expect(getCanonicalMap.mock.invocationCallOrder[0]).toBeLessThan(
      state.tx.deliveryShipEvidence.create.mock.invocationCallOrder[0],
    );
  });

  it('appends one immutable state fact, treats its exact replay as duplicate, and rejects a contradictory replay', async () => {
    const longProviderRef = `jira-history-${'x'.repeat(900)}`;
    const occurredAt = new Date('2026-08-17T10:00:00.000Z');
    const input = projection({
      transitions: [transition(longProviderRef, 'To Do', 'In Progress', occurredAt.toISOString())],
    });

    await expect(service.projectIssue(input)).resolves.toMatchObject({
      stateFacts: 1,
      shipEvidence: 0,
      reworkSignals: 0,
    });
    await expect(service.projectIssue(input)).resolves.toMatchObject({
      stateFacts: 0,
      shipEvidence: 0,
      reworkSignals: 0,
    });

    expect(state.stateFacts).toHaveLength(1);
    expect(state.stateFacts[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      externalRefId: REF_ID,
      fromState: 'To Do',
      toState: 'In Progress',
      occurredAt,
      // A transition's immutable occurrence—not the mutable issue freshness—is the
      // history fact freshness stamp.
      sourceUpdatedAt: occurredAt,
      receivedAt: OBSERVED_AT,
      actorId: ACTOR_ID,
    });
    expect(state.stateFacts[0].sourceUpdatedAt).not.toEqual(SOURCE_UPDATED_AT);
    expect(state.stateFacts[0].sourceRef).toMatch(/^jira-transition:[a-f0-9]{64}$/);
    expect(state.stateFacts[0].sourceRef).not.toContain(longProviderRef);
    expect(state.stateFacts[0].sourceRef.length).toBeLessThanOrEqual(512);

    const contradictory = service.projectIssue(
      projection({
        transitions: [transition(longProviderRef, 'To Do', 'Done', occurredAt.toISOString())],
        currentState: 'Done',
      }),
    );
    await expect(contradictory).rejects.toBeInstanceOf(ConflictException);
    await expect(contradictory).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_STATE_FACT_CONFLICT' }),
    });
    expect(state.stateFacts).toHaveLength(1);
  });

  it('keeps transition identity stable when the same exact ref is rebound to a replacement connector', async () => {
    const input = projection({
      transitions: [transition('history-stable', 'To Do', 'In Progress', '2026-08-17T10:00:00.000Z')],
    });
    await expect(service.projectIssue(input)).resolves.toMatchObject({ stateFacts: 1 });
    const establishedKey = state.stateFacts[0].sourceRef;

    state.ref.connectorId = REBOUND_CONNECTOR_ID;
    state.maps.push(
      statusMap('In Progress', 'active', { connectorId: REBOUND_CONNECTOR_ID }),
      statusMap('Done', 'completed', { connectorId: REBOUND_CONNECTOR_ID }),
    );
    await expect(
      service.projectIssue(projection({ ...input, connectorId: REBOUND_CONNECTOR_ID })),
    ).resolves.toMatchObject({ stateFacts: 0 });

    expect(state.stateFacts).toHaveLength(1);
    expect(state.stateFacts[0].sourceRef).toBe(establishedKey);
  });

  it('dedupes durable derived evidence when an exact provider identity is detached and reattached with a new ref row', async () => {
    state = projectionPrisma({
      maps: [
        statusMap('In Progress', 'active'),
        statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' }),
      ],
    });
    service = projectionService(state);
    const input = projection({
      currentState: 'In Progress',
      transitions: [
        transition('history-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z'),
        transition('history-reopen', 'Done', 'In Progress', '2026-08-17T11:00:00.000Z'),
      ],
    });
    await expect(service.projectIssue(input)).resolves.toMatchObject({
      stateFacts: 2,
      shipEvidence: 1,
      reworkSignals: 1,
    });
    const originalFactKeys = state.stateFacts.map((fact) => fact.sourceRef);
    const originalShipKey = state.shipEvidence[0].sourceKey;
    const originalReopenKey = state.reworkSignals[0].sourceKey;

    // Detach deletes the ref and cascades its state facts. Reattaching the same
    // immutable Jira identity creates a fresh surrogate row, while durable evidence
    // remains by contract.
    state.stateFacts.splice(0);
    state.ref.id = RECREATED_REF_ID;
    state.task.authorityRefId = RECREATED_REF_ID;
    await expect(
      service.projectIssue(projection({ ...input, externalRefId: RECREATED_REF_ID })),
    ).resolves.toMatchObject({ stateFacts: 2, shipEvidence: 0, reworkSignals: 0 });

    expect(state.stateFacts.map((fact) => fact.sourceRef)).toEqual(originalFactKeys);
    expect(state.shipEvidence).toHaveLength(1);
    expect(state.shipEvidence[0].sourceKey).toBe(originalShipKey);
    expect(state.reworkSignals).toHaveLength(1);
    expect(state.reworkSignals[0].sourceKey).toBe(originalReopenKey);
  });

  it('orders transitions by occurrence, applies lifecycle only from the exact authority, and emits one reopen signal', async () => {
    const closedAt = '2026-08-17T10:00:00.000Z';
    const reopenedAt = '2026-08-17T11:00:00.000Z';
    const historicalShip: ShipEvidenceRow = {
      id: 9n,
      workspaceId: WORKSPACE_ID,
      deliveryTaskId: TASK_ID,
      source: 'coredoc',
      sourceKey: 'event-before-reopen',
      occurredAt: new Date('2026-08-16T09:00:00.000Z'),
      receivedAt: new Date('2026-08-16T09:01:00.000Z'),
      actorId: ACTOR_ID,
      provider: null,
      repoExternalId: null,
      externalId: null,
    };
    state = projectionPrisma({ shipEvidence: [historicalShip] });
    service = projectionService(state);

    const input = projection({
      currentState: 'In Progress',
      // Deliberately newest-first: the projector, not caller order, owns chronology.
      transitions: [
        transition('history-reopen', 'Done', 'In Progress', reopenedAt),
        transition('history-close', 'In Progress', 'Done', closedAt),
      ],
    });

    await expect(service.projectIssue(input)).resolves.toMatchObject({ stateFacts: 2, reworkSignals: 1 });
    await expect(service.projectIssue(input)).resolves.toMatchObject({ stateFacts: 0, reworkSignals: 0 });

    expect(state.stateFacts.map((fact) => fact.occurredAt.toISOString())).toEqual([closedAt, reopenedAt]);
    expect(state.task.lifecycle).toBe('active');
    expect(state.reworkSignals).toHaveLength(1);
    expect(state.reworkSignals[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deliveryTaskId: TASK_ID,
      kind: 'tracker_reopened',
      occurredAt: new Date(reopenedAt),
      observedAt: OBSERVED_AT,
    });
    expect(state.reworkSignals[0].sourceKey).toMatch(/^jira-transition:[a-f0-9]{64}$/);
    expect(state.reworkSignals[0].sourceRef).toBe(state.reworkSignals[0].sourceKey);
    expect(state.reworkSignals[0].sourceKey.length).toBeLessThanOrEqual(512);
    // Reopening changes current lifecycle but never erases historical ship facts.
    expect(state.shipEvidence).toEqual([historicalShip]);
  });

  it('creates connector-transition ship evidence once only for an explicit authoritative mapping', async () => {
    state = projectionPrisma({
      maps: [
        statusMap('In Progress', 'active'),
        statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' }),
      ],
    });
    service = projectionService(state);
    const input = projection({
      currentState: 'Done',
      transitions: [transition('history-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z')],
    });

    await expect(service.projectIssue(input)).resolves.toMatchObject({ shipEvidence: 1 });
    await expect(service.projectIssue(input)).resolves.toMatchObject({ shipEvidence: 0 });

    expect(state.task.lifecycle).toBe('completed');
    expect(state.shipEvidence).toHaveLength(1);
    expect(state.shipEvidence[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deliveryTaskId: TASK_ID,
      source: 'connector_transition',
      occurredAt: new Date('2026-08-17T10:00:00.000Z'),
      receivedAt: OBSERVED_AT,
      actorId: ACTOR_ID,
      provider: 'jira',
      repoExternalId: null,
      externalId: '10042',
    });
    expect(state.shipEvidence[0].sourceKey).toMatch(/^jira-transition:[a-f0-9]{64}$/);
    expect(state.shipEvidence[0].sourceKey.length).toBeLessThanOrEqual(512);
  });

  it('never treats a default completed lifecycle mapping as ship evidence', async () => {
    const input = projection({
      currentState: 'Done',
      transitions: [transition('history-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z')],
    });

    await expect(service.projectIssue(input)).resolves.toMatchObject({
      lifecycleChanged: true,
      shipEvidence: 0,
    });
    expect(state.task.lifecycle).toBe('completed');
    expect(state.shipEvidence).toHaveLength(0);
  });

  it('retains non-authoritative history but cannot change lifecycle, ship, or emit reopen signals', async () => {
    state = projectionPrisma({
      task: { authorityRefId: OTHER_REF_ID },
      maps: [
        statusMap('In Progress', 'active'),
        statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' }),
      ],
    });
    service = projectionService(state);

    await expect(
      service.projectIssue(
        projection({
          currentState: 'In Progress',
          transitions: [
            transition('history-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z'),
            transition('history-reopen', 'Done', 'In Progress', '2026-08-17T11:00:00.000Z'),
          ],
        }),
      ),
    ).resolves.toMatchObject({
      stateFacts: 2,
      lifecycleChanged: false,
      shipEvidence: 0,
      reworkSignals: 0,
    });

    expect(state.task.lifecycle).toBe('active');
    expect(state.shipEvidence).toHaveLength(0);
    expect(state.reworkSignals).toHaveLength(0);
  });

  it('ignores an older source observation before it can append history or derived facts', async () => {
    state = projectionPrisma({
      ref: { sourceUpdatedAt: new Date('2026-08-18T00:00:00.000Z') },
      maps: [statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' })],
    });
    service = projectionService(state);

    await expect(
      service.projectIssue(
        projection({
          currentState: 'Done',
          sourceUpdatedAt: SOURCE_UPDATED_AT,
          transitions: [transition('stale-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z')],
        }),
      ),
    ).resolves.toEqual({ stateFacts: 0, lifecycleChanged: false, shipEvidence: 0, reworkSignals: 0 });

    expect(state.stateFacts).toHaveLength(0);
    expect(state.task.lifecycle).toBe('active');
    expect(state.shipEvidence).toHaveLength(0);
    expect(state.reworkSignals).toHaveLength(0);
  });

  it('may project authoritative current lifecycle without fabricating evidence from a refresh with no transition', async () => {
    state = projectionPrisma({
      maps: [statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' })],
      ref: { externalState: 'Done' },
    });
    service = projectionService(state);

    await expect(service.projectIssue(projection({ currentState: 'Done', transitions: [] }))).resolves.toEqual({
      stateFacts: 0,
      lifecycleChanged: true,
      shipEvidence: 0,
      reworkSignals: 0,
    });

    expect(state.task.lifecycle).toBe('completed');
    expect(state.stateFacts).toHaveLength(0);
    expect(state.shipEvidence).toHaveLength(0);
    expect(state.reworkSignals).toHaveLength(0);
  });

  it('re-stamps the authority task title on every pass so a later Jira summary edit lands', async () => {
    await expect(service.projectIssue(projection({ title: 'Fix the login redirect' }))).resolves.toMatchObject({
      stateFacts: 1,
    });
    expect(state.task.title).toBe('Fix the login redirect');

    // A second pass over an already-projected issue: Jira is the authority, so the
    // edited summary must overwrite the stamped title, not stay at the first value.
    await expect(
      service.projectIssue(projection({ title: 'Fix the login redirect on mobile' })),
    ).resolves.toMatchObject({ stateFacts: 0 });
    expect(state.task.title).toBe('Fix the login redirect on mobile');
  });

  it('truncates an oversized Jira summary to the stored title width', async () => {
    const summary = `${'s'.repeat(600)}tail`;

    await service.projectIssue(projection({ title: summary }));

    expect(state.task.title).toHaveLength(512);
    expect(state.task.title).toBe(summary.slice(0, 512));
  });

  it('truncates on code points, so an astral character on the boundary never leaves a lone surrogate', async () => {
    // The emoji straddles the 512th UTF-16 unit: a naive slice would store half a code
    // point, and Postgres rejects that invalid UTF-8 inside the projection transaction —
    // a watermark-gated poison pill that replays forever.
    const summary = `${'s'.repeat(511)}😀 tail`;

    await service.projectIssue(projection({ title: summary }));

    const stored = state.task.title!;
    expect([...stored]).toHaveLength(512);
    expect(stored).toBe(`${'s'.repeat(511)}😀`);
    // No unpaired surrogate: the string round-trips through UTF-8 unchanged.
    expect(/[\uD800-\uDFFF]/.test(stored.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))).toBe(false);
    expect(Buffer.from(stored, 'utf8').toString('utf8')).toBe(stored);
  });

  it('leaves the title untouched when the projected ref is not the task authority', async () => {
    state = projectionPrisma({ task: { authorityRefId: OTHER_REF_ID, title: 'Title from the authority ref' } });
    service = projectionService(state);

    await expect(service.projectIssue(projection({ title: 'Summary of a non-authority ref' }))).resolves.toMatchObject({
      lifecycleChanged: false,
    });

    expect(state.task.title).toBe('Title from the authority ref');
    expect(state.tx.deliveryTask.update).not.toHaveBeenCalled();
  });

  it('keeps an established title when the pass carries no Jira summary', async () => {
    await service.projectIssue(projection({ title: 'Established Jira summary' }));
    state.tx.deliveryTask.update.mockClear();

    await service.projectIssue(projection({ title: undefined }));

    expect(state.task.title).toBe('Established Jira summary');
    expect(state.tx.deliveryTask.update).not.toHaveBeenCalled();
  });
});

describe('JiraCanonicalProjectionService.reprojectConnector', () => {
  it('keyset-batches refs into bounded transactions and accumulates exact counts', async () => {
    const state = projectionPrisma();
    const refs = Array.from({ length: 201 }, (_, index) => ({
      ...state.ref,
      id: BigInt(index + 1),
      deliveryTaskId: `task-${index + 1}`,
    }));
    state.task.authorityRefId = 999n;
    state.tx.taskExternalRef.findMany.mockImplementation(async (args: unknown) => {
      const after = deepField(args, 'gt');
      const take = deepField(args, 'take');
      const page = refs.filter((ref) => typeof after !== 'bigint' || ref.id > after);
      return page.slice(0, typeof take === 'number' ? take : page.length);
    });
    state.tx.deliveryTask.findUnique.mockImplementation(async (args: unknown) => {
      const taskId = deepField(args, 'id');
      const refId = BigInt(Number(String(taskId).replace('task-', '')));
      return { ...state.task, id: taskId, lifecycle: 'active', authorityRefId: refId };
    });
    const getCanonicalMap = vi
      .fn()
      .mockResolvedValue(new Map([['in progress', { lifecycle: 'completed' as const, createsShipEvidence: false }]]));
    const service = new JiraCanonicalProjectionService(state.prisma, {
      getCanonicalMap,
    } as unknown as StatusMapService);

    await expect(service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID)).resolves.toEqual({
      externalRefs: 201,
      lifecycleChanges: 201,
      shipEvidence: 0,
      reworkSignals: 0,
    });

    expect(state.transaction).toHaveBeenCalledTimes(3);
    expect(state.tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(getCanonicalMap).toHaveBeenCalledTimes(3);
    for (let index = 1; index <= 3; index += 1) {
      expect(getCanonicalMap).toHaveBeenNthCalledWith(index, WORKSPACE_ID, CONNECTOR_ID, state.tx);
    }
    expect(state.tx.taskExternalRef.findMany).toHaveBeenCalledTimes(3);
    const queries = state.tx.taskExternalRef.findMany.mock.calls.map(([query]) => query as Record<string, unknown>);
    expect(queries[0]).toMatchObject({
      where: { workspaceId: WORKSPACE_ID, connectorId: CONNECTOR_ID, provider: 'jira' },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(queries[0].where).not.toHaveProperty('id');
    expect(queries[1]).toMatchObject({ where: { id: { gt: 100n } }, orderBy: { id: 'asc' }, take: 100 });
    expect(queries[2]).toMatchObject({ where: { id: { gt: 200n } }, orderBy: { id: 'asc' }, take: 100 });
    expect(state.tx.deliveryTask.update).toHaveBeenCalledTimes(201);
  });

  it('replays stored transition facts after a status-map edit and remains idempotent', async () => {
    const state = projectionPrisma();
    const service = projectionService(state);
    const input = projection({
      currentState: 'Done',
      transitions: [transition('historical-close', 'In Progress', 'Done', '2026-08-17T10:00:00.000Z')],
    });

    await service.projectIssue(input);
    expect(state.shipEvidence).toHaveLength(0);
    expect(state.stateFacts).toHaveLength(1);

    const doneMap = state.maps.find((row) => row.statusRaw === 'Done');
    expect(doneMap).toBeDefined();
    if (doneMap) {
      doneMap.createsShipEvidence = true;
      doneMap.source = 'admin';
    }

    await service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID);
    await service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID);

    expect(state.stateFacts).toHaveLength(1);
    expect(state.shipEvidence).toHaveLength(1);
    expect(state.shipEvidence[0]).toMatchObject({
      source: 'connector_transition',
      deliveryTaskId: TASK_ID,
      occurredAt: new Date('2026-08-17T10:00:00.000Z'),
    });
  });

  it('replays retained terminal-to-active history into one tracker reopen signal after a status-map edit', async () => {
    const state = projectionPrisma({
      maps: [statusMap('Done', null), statusMap('In Progress', 'active')],
    });
    const service = projectionService(state);
    const input = projection({
      currentState: 'In Progress',
      transitions: [transition('historical-reopen', 'Done', 'In Progress', '2026-08-17T11:00:00.000Z')],
    });

    await expect(service.projectIssue(input)).resolves.toMatchObject({
      stateFacts: 1,
      reworkSignals: 0,
    });
    expect(state.stateFacts).toHaveLength(1);
    expect(state.reworkSignals).toHaveLength(0);

    const doneMap = state.maps.find((row) => row.statusRaw === 'Done');
    expect(doneMap).toBeDefined();
    if (doneMap) {
      doneMap.lifecycle = 'completed';
      doneMap.source = 'admin';
    }

    await expect(service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID)).resolves.toMatchObject({
      reworkSignals: 1,
    });
    await expect(service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID)).resolves.toMatchObject({
      reworkSignals: 0,
    });

    expect(state.reworkSignals).toHaveLength(1);
    expect(state.reworkSignals[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      deliveryTaskId: TASK_ID,
      kind: 'tracker_reopened',
      sourceKey: state.stateFacts[0].sourceRef,
      sourceRef: state.stateFacts[0].sourceRef,
      occurredAt: new Date('2026-08-17T11:00:00.000Z'),
      observedAt: OBSERVED_AT,
    });
  });

  it('fails closed before derived writes when connector replay encounters unresolved legacy authority', async () => {
    const state = projectionPrisma({
      task: { authority: 'connector:jira', authorityRefId: null },
      maps: [statusMap('Done', 'completed', { createsShipEvidence: true, source: 'admin' })],
    });
    const service = projectionService(state);

    const replay = service.reprojectConnector(WORKSPACE_ID, CONNECTOR_ID);
    await expect(replay).rejects.toBeInstanceOf(ConflictException);
    await expect(replay).rejects.toMatchObject({
      response: expect.objectContaining({ statusCode: 409, code: 'TASK_AUTHORITY_MIGRATION_REQUIRED' }),
    });

    expect(state.tx.deliveryTask.update).not.toHaveBeenCalled();
    expect(state.shipEvidence).toHaveLength(0);
    expect(state.reworkSignals).toHaveLength(0);
  });
});
