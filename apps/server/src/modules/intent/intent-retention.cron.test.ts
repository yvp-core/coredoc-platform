import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { IntentRetentionCron } from './intent-retention.cron.js';

function mockPrisma(deleteCount = 0) {
  return {
    intentMutationRequest: { deleteMany: vi.fn().mockResolvedValue({ count: deleteCount }) },
  } as unknown as PrismaService & { intentMutationRequest: { deleteMany: ReturnType<typeof vi.fn> } };
}

describe('IntentRetentionCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'));
    delete process.env.INTENT_MUTATION_RETENTION_ENABLED;
    delete process.env.INTENT_MUTATION_RETENTION_DAYS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.INTENT_MUTATION_RETENTION_ENABLED;
    delete process.env.INTENT_MUTATION_RETENTION_DAYS;
  });

  it('sweeps the ledger on the 30-day window documented with the migration', async () => {
    const prisma = mockPrisma(7);
    await new IntentRetentionCron(prisma).purgeExpiredMutationRequests();
    expect(prisma.intentMutationRequest.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-08-03T00:00:00.000Z') } },
    });
  });

  it('honours a configured window', async () => {
    process.env.INTENT_MUTATION_RETENTION_DAYS = '7';
    const prisma = mockPrisma(1);
    await new IntentRetentionCron(prisma).purgeExpiredMutationRequests();
    expect(prisma.intentMutationRequest.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-08-26T00:00:00.000Z') } },
    });
  });

  it('clamps a non-positive window to one day rather than purging everything', async () => {
    process.env.INTENT_MUTATION_RETENTION_DAYS = '0';
    const prisma = mockPrisma(0);
    await new IntentRetentionCron(prisma).purgeExpiredMutationRequests();
    expect(prisma.intentMutationRequest.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-09-01T00:00:00.000Z') } },
    });
  });

  it('sweeps nothing while its own kill switch is off', async () => {
    process.env.INTENT_MUTATION_RETENTION_ENABLED = 'false';
    const prisma = mockPrisma(0);
    await new IntentRetentionCron(prisma).purgeExpiredMutationRequests();
    expect(prisma.intentMutationRequest.deleteMany).not.toHaveBeenCalled();
  });
});
