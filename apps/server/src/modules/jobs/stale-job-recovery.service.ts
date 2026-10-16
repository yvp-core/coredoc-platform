import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, configFromEnv } from '../../config/app-config.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PushWorkerService } from './push-worker.service.js';

@Injectable()
export class StaleJobRecoveryService {
  private readonly logger = new Logger(StaleJobRecoveryService.name);

  constructor(
    private readonly worker: PushWorkerService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = configFromEnv().workers,
  ) {}

  /**
   * Boot-time recovery cannot catch a job that hangs forever inside the live
   * worker process. This periodic sweep releases rows after their heartbeat
   * crosses the stale threshold so one hang cannot block the queue forever.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'push-worker:stale-recovery' })
  async runStaleRecoveryCron(): Promise<void> {
    if (this.workers.pushWorkerEnabled === 'false') return;
    try {
      await this.worker.recoverStaleRunningJobs();
    } catch (error) {
      this.logger.error(`Periodic stale recovery failed: ${(error as Error).message}`);
    }
  }
}
