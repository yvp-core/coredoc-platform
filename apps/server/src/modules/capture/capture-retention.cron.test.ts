import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { CaptureRetentionCron } from './capture-retention.cron.js';

interface BatchResult {
  deletedCount: number;
  lastDeletedReceivedAt: Date | null;
}

function mockPrisma(results: BatchResult[], remaining?: boolean[]) {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    captureEvent: {
      findFirst: vi.fn(),
    },
  };
  for (const result of results) tx.$queryRaw.mockResolvedValueOnce([result]);
  for (const [index, result] of results.entries()) {
    const hasRemaining = remaining?.[index] ?? result.deletedCount === 1_000;
    tx.captureEvent.findFirst.mockResolvedValueOnce(hasRemaining ? { id: 1n } : null);
  }
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  return {
    prisma: prisma as unknown as PrismaService,
    transaction: prisma.$transaction,
    tx,
  };
}

function checkpointValues(tx: { $executeRaw: ReturnType<typeof vi.fn> }, callIndex = 0): unknown[] {
  const sql = tx.$executeRaw.mock.calls[callIndex]?.[0] as { values?: unknown[] } | undefined;
  return sql?.values ?? [];
}

describe('CaptureRetentionCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T04:00:00.000Z'));
    delete process.env.CAPTURE_FINE_RETENTION_ENABLED;
    delete process.env.CAPTURE_FINE_RETENTION_DAYS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CAPTURE_FINE_RETENTION_ENABLED;
    delete process.env.CAPTURE_FINE_RETENTION_DAYS;
  });

  it('uses the default 90-day cutoff and proves exhaustion when explicitly enabled', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const { prisma, transaction, tx } = mockPrisma([{ deletedCount: 0, lastDeletedReceivedAt: null }]);
    const cron = new CaptureRetentionCron(prisma);
    const log = vi.spyOn((cron as unknown as { logger: { log: (message: string) => void } }).logger, 'log');

    await cron.purgeExpiredCaptureEvents();

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    expect(log).toHaveBeenCalledWith(`capture fine-event retention: deleted 0 events (cutoff ${cutoff.toISOString()})`);
  });

  it.each([undefined, 'false', 'TRUE', '1'])('is a no-op unless the opt-in is exactly true (%s)', async (enabled) => {
    if (enabled === undefined) delete process.env.CAPTURE_FINE_RETENTION_ENABLED;
    else process.env.CAPTURE_FINE_RETENTION_ENABLED = enabled;
    const { prisma, transaction } = mockPrisma([]);
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    '',
    ' ',
    'not-a-number',
    'Infinity',
    '0',
    '-1',
  ])('fails closed with a bounded error for invalid enabled days %j', async (days) => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    process.env.CAPTURE_FINE_RETENTION_DAYS = days;
    const { prisma, transaction } = mockPrisma([]);
    const cron = new CaptureRetentionCron(prisma);
    const error = vi.spyOn((cron as unknown as { logger: { error: (message: string) => void } }).logger, 'error');

    await cron.purgeExpiredCaptureEvents();

    expect(transaction).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('capture fine-event retention disabled: invalid CAPTURE_FINE_RETENTION_DAYS');
    if (days.trim().length > 0) expect(error.mock.calls.flat().join(' ')).not.toContain(days);
  });

  it('honors a positive configured window', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    process.env.CAPTURE_FINE_RETENTION_DAYS = '30';
    const { prisma } = mockPrisma([{ deletedCount: 0, lastDeletedReceivedAt: null }]);
    const cron = new CaptureRetentionCron(prisma);
    const log = vi.spyOn((cron as unknown as { logger: { log: (message: string) => void } }).logger, 'log');

    await cron.purgeExpiredCaptureEvents();

    expect(log).toHaveBeenCalledWith(
      'capture fine-event retention: deleted 0 events (cutoff 2026-07-18T04:00:00.000Z)',
    );
  });

  it('runs at most ten nonempty 1,000-row transactions and leaves the checkpoint conservative', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const batchTimes = Array.from(
      { length: 10 },
      (_, index) => new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
    );
    const { prisma, transaction, tx } = mockPrisma(
      batchTimes.map((lastDeletedReceivedAt) => ({ deletedCount: 1_000, lastDeletedReceivedAt })),
    );
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    expect(transaction).toHaveBeenCalledTimes(10);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(10);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(10);
    expect(checkpointValues(tx, 9)).toEqual(['capture_fine_events', batchTimes[9]]);
  });

  it('advances the checkpoint to the cutoff only when a short batch proves exhaustion', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const lastDeleted = new Date('2026-02-01T00:00:00.000Z');
    const { prisma, transaction, tx } = mockPrisma([
      { deletedCount: 1_000, lastDeletedReceivedAt: lastDeleted },
      { deletedCount: 3, lastDeletedReceivedAt: new Date('2026-02-02T00:00:00.000Z') },
    ]);
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(checkpointValues(tx, 0)).toEqual(['capture_fine_events', lastDeleted]);
    expect(checkpointValues(tx, 1)).toEqual(['capture_fine_events', cutoff]);
  });

  it('does not advance the checkpoint when a concurrent sweep leaves an empty batch with old rows still visible', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const { prisma, tx } = mockPrisma([{ deletedCount: 0, lastDeletedReceivedAt: null }], [true]);
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    expect(tx.captureEvent.findFirst).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
      select: { id: true },
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('advances only to the last deleted receive time when a concurrent sweep makes a batch short', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const lastDeletedReceivedAt = new Date('2026-02-03T00:00:00.000Z');
    const { prisma, tx } = mockPrisma([{ deletedCount: 3, lastDeletedReceivedAt }], [true]);
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    expect(checkpointValues(tx)).toEqual(['capture_fine_events', lastDeletedReceivedAt]);
  });

  it('pins strict received-time ordering, locking, scoped watermark backfill, and delete-by-selected-id in SQL', async () => {
    process.env.CAPTURE_FINE_RETENTION_ENABLED = 'true';
    const { prisma, tx } = mockPrisma([{ deletedCount: 0, lastDeletedReceivedAt: null }]);
    const cron = new CaptureRetentionCron(prisma);

    await cron.purgeExpiredCaptureEvents();

    const queryCall = tx.$queryRaw.mock.calls[0] as unknown[];
    const sql = (queryCall[0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('WHERE received_at <');
    expect(sql).toContain('ORDER BY received_at ASC, id ASC');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).not.toContain('SKIP LOCKED');
    expect(sql).toContain('WHERE repository_key IS NOT NULL');
    expect(sql).toContain("'repo:' || repository_key");
    expect(sql).not.toContain("'profile'");
    expect(sql).toContain("WHERE type <> 'capability.used'");
    expect(sql).toContain('ON CONFLICT (workspace_id, actor_id, host, scope_key) DO UPDATE');
    expect(sql).toContain('LEAST(');
    expect(sql).toContain('GREATEST(');
    expect(sql).toContain('DELETE FROM capture_events');
    expect(sql).toContain('capture_events.id = selected.id');
    expect(queryCall.slice(1)).toEqual([new Date(Date.now() - 90 * 86_400_000), 1_000]);
  });
});
