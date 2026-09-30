import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { UpdateStatusMapSchema } from './delivery.contract.js';
import { StatusMapService } from './status-map.service.js';

const WS = 'ws-1';
const CONN = 'conn-1';

function mockPrisma() {
  const tx = {
    deliveryStatusMap: {
      createMany: vi.fn((args: { data: unknown[] }) => Promise.resolve({ count: args.data.length })),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: CONN }]),
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)),
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

describe('StatusMapService', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: StatusMapService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new StatusMapService(prisma);
  });

  it('maps Jira status categories to canonical lifecycle policy without persisting a legacy stage', async () => {
    await expect(
      service.bootstrapFromStatuses(WS, CONN, [
        { name: 'To Do', statusCategory: { key: 'new' } },
        { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
        { name: 'Done', statusCategory: { key: 'done' } },
      ]),
    ).resolves.toEqual({ created: 3 });

    expect(prisma.deliveryStatusMap.createMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: WS,
          connectorId: CONN,
          statusRaw: 'To Do',
          lifecycle: 'active',
          createsShipEvidence: false,
          source: 'default',
        },
        {
          workspaceId: WS,
          connectorId: CONN,
          statusRaw: 'In Progress',
          lifecycle: 'active',
          createsShipEvidence: false,
          source: 'default',
        },
        {
          workspaceId: WS,
          connectorId: CONN,
          statusRaw: 'Done',
          lifecycle: 'completed',
          createsShipEvidence: false,
          source: 'default',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('skips malformed statuses and trims and caps stored names', async () => {
    await service.bootstrapFromStatuses(WS, CONN, [
      { name: '  Valid  ', statusCategory: { key: 'new' } },
      { name: 'x'.repeat(200), statusCategory: { key: 'done' } },
      { statusCategory: { key: 'done' } },
      null,
    ]);
    const data = prisma.deliveryStatusMap.createMany.mock.calls[0][0].data as Array<{ statusRaw: string }>;
    expect(data.map((row) => row.statusRaw)).toEqual(['Valid', 'x'.repeat(128)]);
  });

  it('returns deterministic canonical policy with admin rows winning case collisions', async () => {
    const rows = [
      { statusRaw: 'DONE', lifecycle: 'abandoned', createsShipEvidence: false, source: 'admin' },
      { statusRaw: 'Done', lifecycle: 'completed', createsShipEvidence: true, source: 'default' },
    ];
    prisma.deliveryStatusMap.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([...rows].reverse());

    expect((await service.getCanonicalMap(WS, CONN)).get('done')).toEqual({
      lifecycle: 'abandoned',
      createsShipEvidence: false,
    });
    expect((await service.getCanonicalMap(WS, CONN)).get('done')).toEqual({
      lifecycle: 'abandoned',
      createsShipEvidence: false,
    });
  });

  it('lists canonical fields only', async () => {
    prisma.deliveryStatusMap.findMany.mockResolvedValue([
      {
        id: 'map-1',
        statusRaw: 'Done',
        lifecycle: 'completed',
        createsShipEvidence: true,
        source: 'admin',
        createdAt: new Date(),
      },
    ]);
    await expect(service.listMap(WS, CONN)).resolves.toEqual({
      entries: [{ statusRaw: 'Done', lifecycle: 'completed', createsShipEvidence: true, source: 'admin' }],
    });
  });

  it('locks the connector and upserts canonical policy only', async () => {
    await expect(
      service.updateMap(WS, CONN, [{ status: ' Done ', lifecycle: 'completed', createsShipEvidence: true }]),
    ).resolves.toEqual({ upserted: 1 });

    const [segments, ...parameters] = prisma.$queryRaw.mock.calls[0];
    expect(segments.join('?')).toContain('FOR UPDATE');
    expect(parameters).toEqual([WS, CONN]);
    expect(prisma.deliveryStatusMap.upsert).toHaveBeenCalledWith({
      where: { workspaceId_connectorId_statusRaw: { workspaceId: WS, connectorId: CONN, statusRaw: 'Done' } },
      create: {
        workspaceId: WS,
        connectorId: CONN,
        statusRaw: 'Done',
        lifecycle: 'completed',
        createsShipEvidence: true,
        source: 'admin',
      },
      update: { lifecycle: 'completed', createsShipEvidence: true, source: 'admin' },
    });
  });
});

describe('UpdateStatusMapSchema canonical contract', () => {
  function parse(entry: Record<string, unknown>) {
    return UpdateStatusMapSchema.safeParse({ entries: [{ status: 'Done', ...entry }] });
  }

  it.each([
    'active',
    'completed',
    'abandoned',
    null,
  ] as const)('accepts lifecycle=%s with boolean evidence', (lifecycle) => {
    expect(parse({ lifecycle, createsShipEvidence: false }).success).toBe(true);
  });

  // The route has always STRIPPED an undeclared field rather than refusing it: the global
  // `ValidationPipe` ran with `whitelist: true` and no `forbidNonWhitelisted`, and a zod object
  // strips the same way. This case asserted the stricter policy the route never applied.
  it('strips the removed legacy stage field', () => {
    const parsed = parse({ stage: 'done' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.entries[0]).not.toHaveProperty('stage');
  });

  it.each([
    { lifecycle: 'done' },
    { createsShipEvidence: 'true' },
    { createsShipEvidence: null },
  ])('rejects invalid canonical policy %#', (entry) => {
    expect(parse(entry).success).toBe(false);
  });
});
