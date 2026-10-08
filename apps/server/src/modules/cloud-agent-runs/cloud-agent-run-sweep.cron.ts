import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CloudAgentRunSweep } from './cloud-agent-run-sweep.service.js';

/**
 * Every minute: the run sweep's time-based transitions. It runs in every
 * worker and all-role process at once; each item re-checks under row locks.
 */
@Injectable()
export class CloudAgentRunSweepCron {
  private readonly logger = new Logger(CloudAgentRunSweepCron.name);

  constructor(private readonly sweep: CloudAgentRunSweep) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'cloud-agent-runs:sweep', waitForCompletion: true })
  async run(): Promise<void> {
    try {
      await this.sweep.tick();
    } catch (error) {
      this.logger.error(`Agent run sweep failed: ${(error as Error).message}`);
    }
  }
}
