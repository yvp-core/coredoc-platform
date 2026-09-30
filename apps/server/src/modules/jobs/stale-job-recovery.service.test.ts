import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PushWorkerService } from './push-worker.service.js';
import { StaleJobRecoveryService } from './stale-job-recovery.service.js';

function workerMock(implementation: () => Promise<number> = async () => 0) {
  return {
    recoverStaleRunningJobs: vi.fn(implementation),
  } as unknown as PushWorkerService & {
    recoverStaleRunningJobs: ReturnType<typeof vi.fn>;
  };
}

describe('StaleJobRecoveryService', () => {
  afterEach(() => {
    delete process.env.PUSH_WORKER_ENABLED;
    vi.restoreAllMocks();
  });

  it('does nothing when the worker is disabled', async () => {
    process.env.PUSH_WORKER_ENABLED = 'false';
    const worker = workerMock();
    const service = new StaleJobRecoveryService(worker);

    await service.runStaleRecoveryCron();

    expect(worker.recoverStaleRunningJobs).not.toHaveBeenCalled();
  });

  it('logs and swallows recovery failures so the schedule keeps running', async () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const worker = workerMock(async () => {
      throw new Error('db down');
    });
    const service = new StaleJobRecoveryService(worker);

    await expect(service.runStaleRecoveryCron()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('Periodic stale recovery failed: db down');
  });
});
