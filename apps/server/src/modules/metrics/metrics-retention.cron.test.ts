import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsRetentionCron } from './metrics-retention.cron.js';
import type { PrismaService } from '../../database/prisma.service.js';

function mockPrisma(deleteCount = 0) {
  return {
    mcpQueryMetric: {
      deleteMany: vi.fn().mockResolvedValue({ count: deleteCount }),
    },
  } as unknown as PrismaService & { mcpQueryMetric: { deleteMany: ReturnType<typeof vi.fn> } };
}

describe('MetricsRetentionCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'));
    delete process.env.MCP_METRICS_RETENTION_ENABLED;
    delete process.env.MCP_METRICS_RETENTION_DAYS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MCP_METRICS_RETENTION_ENABLED;
    delete process.env.MCP_METRICS_RETENTION_DAYS;
  });

  it('deletes rows older than the default 180-day window when MCP_METRICS_RETENTION_DAYS is unset', async () => {
    const prisma = mockPrisma(12);
    const cron = new MetricsRetentionCron(prisma);

    await cron.purgeExpiredMcpQueryMetrics();

    expect(prisma.mcpQueryMetric.deleteMany).toHaveBeenCalledWith({
      where: { queriedAt: { lt: new Date('2026-02-09T00:00:00.000Z') } },
    });
  });

  it('honors a configured MCP_METRICS_RETENTION_DAYS window', async () => {
    process.env.MCP_METRICS_RETENTION_DAYS = '30';
    const prisma = mockPrisma(3);
    const cron = new MetricsRetentionCron(prisma);

    await cron.purgeExpiredMcpQueryMetrics();

    expect(prisma.mcpQueryMetric.deleteMany).toHaveBeenCalledWith({
      where: { queriedAt: { lt: new Date('2026-07-09T00:00:00.000Z') } },
    });
  });

  it('clamps a non-positive retention window to >= 1 day (never purges everything)', async () => {
    process.env.MCP_METRICS_RETENTION_DAYS = '0';
    const prisma = mockPrisma(0);
    const cron = new MetricsRetentionCron(prisma);

    await cron.purgeExpiredMcpQueryMetrics();

    expect(prisma.mcpQueryMetric.deleteMany).toHaveBeenCalledWith({
      where: { queriedAt: { lt: new Date('2026-08-07T00:00:00.000Z') } },
    });
  });

  it('logs the deletion count', async () => {
    const prisma = mockPrisma(42);
    const cron = new MetricsRetentionCron(prisma);
    const logSpy = vi.spyOn((cron as unknown as { logger: { log: (msg: string) => void } }).logger, 'log');

    await cron.purgeExpiredMcpQueryMetrics();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('42'));
  });

  it('respects its own MCP_METRICS_RETENTION_ENABLED=false kill-switch (dedicated flag, not the delivery one)', async () => {
    process.env.MCP_METRICS_RETENTION_ENABLED = 'false';
    const prisma = mockPrisma();
    const cron = new MetricsRetentionCron(prisma);

    await cron.purgeExpiredMcpQueryMetrics();

    expect(prisma.mcpQueryMetric.deleteMany).not.toHaveBeenCalled();
  });
});
