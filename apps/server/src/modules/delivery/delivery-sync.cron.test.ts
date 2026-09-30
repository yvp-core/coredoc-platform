import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeliverySyncCron } from './delivery-sync.cron.js';
import { CODE_CHANGE_NORM_VERSION } from './github-normalizer.js';
import { GITHUB_CANONICAL_PROJECTION_VERSION } from './github-canonical-projection.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type { DeliveryService } from './delivery.service.js';
import { LicenseState } from '../license/license-state.js';
import { licenseServiceIn } from '../license/license.test-support.js';

function mockPrisma(connectors: Array<Record<string, unknown>>) {
  const prisma = {
    deliveryConnector: {
      findMany: vi.fn().mockResolvedValue(connectors),
    },
    deliveryRawPayload: {
      deleteMany: vi.fn().mockResolvedValue({ count: 4 }),
      // Workspaces still holding payloads below the current normalizer version.
      // Empty by default: a drained fleet must enqueue nothing.
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return prisma as unknown as PrismaService & typeof prisma;
}

describe('DeliverySyncCron', () => {
  let deliveryService: {
    enqueueConnectorSyncJob: ReturnType<typeof vi.fn>;
    enqueueRenormalizeJob: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deliveryService = {
      enqueueConnectorSyncJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
      enqueueRenormalizeJob: vi.fn().mockResolvedValue({ id: 'job-r1' }),
    };
    delete process.env.DELIVERY_SYNC_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.DELIVERY_SYNC_ENABLED;
    delete process.env.DELIVERY_RAW_RETENTION_DAYS;
  });

  describe('renormalize backfill', () => {
    it('enqueues one backfill per workspace with stale normalization or stale canonical projection', async () => {
      const prisma = mockPrisma([]);
      prisma.deliveryRawPayload.findMany.mockResolvedValue([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.backfillStaleNormalizations();

      // The staleness predicate lives in the query, not in JS — and it asks the
      // table the backfill re-derives FROM, skipping truncated rows the backfill
      // itself skips (else a workspace holding only those is enqueued forever).
      const args = prisma.deliveryRawPayload.findMany.mock.calls[0][0];
      expect(args.where.workspace).toEqual({ deliveryEnabled: true });
      expect(args.where.truncated).toBe(false);
      expect(args.where.OR).toEqual([
        { normVersion: null },
        { normVersion: { lt: CODE_CHANGE_NORM_VERSION } },
        { canonicalProjectionVersion: null },
        { canonicalProjectionVersion: { lt: GITHUB_CANONICAL_PROJECTION_VERSION } },
      ]);
      expect(args.distinct).toEqual(['workspaceId']);

      expect(deliveryService.enqueueRenormalizeJob).toHaveBeenCalledTimes(2);
      expect(deliveryService.enqueueRenormalizeJob).toHaveBeenCalledWith('ws-1');
      expect(deliveryService.enqueueRenormalizeJob).toHaveBeenCalledWith('ws-2');
    });

    it('enqueues nothing once the fleet has drained', async () => {
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.backfillStaleNormalizations();

      // Self-limiting: the sweep runs hourly forever, so a drained fleet costing a
      // job per workspace per hour would be the defect, not the fix.
      expect(deliveryService.enqueueRenormalizeJob).not.toHaveBeenCalled();
    });

    it('keeps sweeping when one workspace fails to enqueue', async () => {
      const prisma = mockPrisma([]);
      prisma.deliveryRawPayload.findMany.mockResolvedValue([{ workspaceId: 'ws-1' }, { workspaceId: 'ws-2' }]);
      deliveryService.enqueueRenormalizeJob.mockRejectedValueOnce(new Error('boom'));
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await expect(cron.backfillStaleNormalizations()).resolves.toBeUndefined();
      expect(deliveryService.enqueueRenormalizeJob).toHaveBeenCalledTimes(2);
    });

    it('is paused by the same env gate as every other delivery sweep', async () => {
      process.env.DELIVERY_SYNC_ENABLED = 'false';
      const prisma = mockPrisma([]);
      prisma.deliveryRawPayload.findMany.mockResolvedValue([{ workspaceId: 'ws-1' }]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.backfillStaleNormalizations();

      expect(prisma.deliveryRawPayload.findMany).not.toHaveBeenCalled();
      expect(deliveryService.enqueueRenormalizeJob).not.toHaveBeenCalled();
    });
  });

  it('enqueues one sync job per active github/jira connector (findMany filters status/provider)', async () => {
    const prisma = mockPrisma([{ id: 'conn-1', workspaceId: 'ws-1' }]);
    const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

    await cron.syncActiveConnectors();

    // The active + github|jira filter AND the delivery-enabled relation gate live in
    // the Prisma query, not in JS.
    expect(prisma.deliveryConnector.findMany).toHaveBeenCalledWith({
      where: {
        provider: { in: ['github', 'jira'] },
        status: 'active',
        workspace: { deliveryEnabled: true },
      },
      select: { id: true, workspaceId: true },
    });
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledTimes(1);
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-1', 'conn-1');
  });

  it('enqueues a jira connector alongside a github connector', async () => {
    const prisma = mockPrisma([
      { id: 'gh-1', workspaceId: 'ws-1' },
      { id: 'jira-1', workspaceId: 'ws-2' },
    ]);
    const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

    await cron.syncActiveConnectors();

    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-1', 'gh-1');
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-2', 'jira-1');
  });

  it('two connectors from the query → one enqueue call each', async () => {
    // The query only returns active github rows; an error-status connector is
    // never returned, so it is never enqueued. Prove the per-row fan-out.
    const prisma = mockPrisma([
      { id: 'conn-1', workspaceId: 'ws-1' },
      { id: 'conn-2', workspaceId: 'ws-2' },
    ]);
    const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

    await cron.syncActiveConnectors();

    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledTimes(2);
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-1', 'conn-1');
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-2', 'conn-2');
  });

  it('DELIVERY_SYNC_ENABLED=false → no-op (no query, no enqueue)', async () => {
    process.env.DELIVERY_SYNC_ENABLED = 'false';
    const prisma = mockPrisma([{ id: 'conn-1', workspaceId: 'ws-1' }]);
    const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

    await cron.syncActiveConnectors();

    expect(prisma.deliveryConnector.findMany).not.toHaveBeenCalled();
    expect(deliveryService.enqueueConnectorSyncJob).not.toHaveBeenCalled();
  });

  it('a per-connector enqueue error is logged, not thrown, and other connectors continue', async () => {
    const prisma = mockPrisma([
      { id: 'conn-1', workspaceId: 'ws-1' },
      { id: 'conn-2', workspaceId: 'ws-2' },
    ]);
    deliveryService.enqueueConnectorSyncJob
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'job-2' });
    const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);
    const errSpy = vi.spyOn((cron as unknown as { logger: { error: (m: string) => void } }).logger, 'error');

    await expect(cron.syncActiveConnectors()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledTimes(2);
  });

  describe('license gate', () => {
    it.each([
      LicenseState.Absent,
      LicenseState.Valid,
      LicenseState.Grace,
    ])('sweeps normally while the license is %s', async (state) => {
      const prisma = mockPrisma([{ id: 'conn-1', workspaceId: 'ws-1' }]);
      const license = licenseServiceIn(state);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService, license);

      await cron.syncActiveConnectors();

      expect(deliveryService.enqueueConnectorSyncJob).toHaveBeenCalledWith('ws-1', 'conn-1');
      license.onModuleDestroy();
    });

    it('enqueues no new connector sync once the license is expired past grace', async () => {
      // The REST trigger for this same enqueue is refused by LicenseGuard; the
      // worker has no HTTP guard, so an expired deployment would otherwise keep
      // importing fresh external data every hour forever.
      const prisma = mockPrisma([{ id: 'conn-1', workspaceId: 'ws-1' }]);
      const license = licenseServiceIn(LicenseState.Expired);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService, license);
      const warnSpy = vi.spyOn((cron as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');

      await cron.syncActiveConnectors();

      expect(prisma.deliveryConnector.findMany).not.toHaveBeenCalled();
      expect(deliveryService.enqueueConnectorSyncJob).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('license has expired'));
      license.onModuleDestroy();
    });

    it('keeps re-deriving already-imported rows while expired (the backfill imports nothing)', async () => {
      const prisma = mockPrisma([]);
      prisma.deliveryRawPayload.findMany.mockResolvedValue([{ workspaceId: 'ws-1' }]);
      const license = licenseServiceIn(LicenseState.Expired);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService, license);

      await cron.backfillStaleNormalizations();

      expect(deliveryService.enqueueRenormalizeJob).toHaveBeenCalledWith('ws-1');
      license.onModuleDestroy();
    });
  });

  describe('purgeExpiredRawPayloads (retention)', () => {
    const NOW = new Date('2026-07-20T04:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    it('deletes raw payloads older than the default 30-day cutoff', async () => {
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      const expectedCutoff = new Date(NOW.getTime() - 30 * 86_400_000);
      expect(prisma.deliveryRawPayload.deleteMany).toHaveBeenCalledWith({
        where: { fetchedAt: { lt: expectedCutoff } },
      });
    });

    it('honors a custom DELIVERY_RAW_RETENTION_DAYS', async () => {
      process.env.DELIVERY_RAW_RETENTION_DAYS = '90';
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      const expectedCutoff = new Date(NOW.getTime() - 90 * 86_400_000);
      expect(prisma.deliveryRawPayload.deleteMany).toHaveBeenCalledWith({
        where: { fetchedAt: { lt: expectedCutoff } },
      });
    });

    it('clamps a negative DELIVERY_RAW_RETENTION_DAYS to 1 day — cutoff is in the past, never the future', async () => {
      // days=-30 would compute a future cutoff and deleteMany EVERY payload; clamp guards it.
      process.env.DELIVERY_RAW_RETENTION_DAYS = '-30';
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      const expectedCutoff = new Date(NOW.getTime() - 1 * 86_400_000);
      expect(prisma.deliveryRawPayload.deleteMany).toHaveBeenCalledWith({
        where: { fetchedAt: { lt: expectedCutoff } },
      });
      expect(expectedCutoff.getTime()).toBeLessThan(NOW.getTime());
    });

    // Falsy-but-set values mean "unset" here, not a 1-day window: "0" and a
    // non-number both fall back to the documented 30 days.
    it.each(['0', 'not-a-number'])('falls back to the 30-day cutoff for %j', async (raw) => {
      process.env.DELIVERY_RAW_RETENTION_DAYS = raw;
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      const expectedCutoff = new Date(NOW.getTime() - 30 * 86_400_000);
      expect(prisma.deliveryRawPayload.deleteMany).toHaveBeenCalledWith({
        where: { fetchedAt: { lt: expectedCutoff } },
      });
    });

    it('DELIVERY_SYNC_ENABLED=false → no-op (no deleteMany)', async () => {
      process.env.DELIVERY_SYNC_ENABLED = 'false';
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      expect(prisma.deliveryRawPayload.deleteMany).not.toHaveBeenCalled();
    });

    // Only the literal "false" pauses the sweep — "0" is not a kill-switch.
    it('DELIVERY_SYNC_ENABLED=0 → still sweeps', async () => {
      process.env.DELIVERY_SYNC_ENABLED = '0';
      const prisma = mockPrisma([]);
      const cron = new DeliverySyncCron(prisma, deliveryService as unknown as DeliveryService);

      await cron.purgeExpiredRawPayloads();

      expect(prisma.deliveryRawPayload.deleteMany).toHaveBeenCalled();
    });
  });
});
