import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service.js';
import { LicenseService } from '../license/license.service.js';
import { CloudAgentRunTrigger } from './cloud-agent-run-trigger.service.js';

/**
 * Every minute, for each workspace with agent runs enabled: promote queued
 * runs and turn labelled Jira issues into runs. It runs in every worker and
 * all-role process at once; the per-workspace creation lock, not this
 * schedule, keeps that safe.
 */
@Injectable()
export class CloudAgentRunTriggerCron {
  private readonly logger = new Logger(CloudAgentRunTriggerCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trigger: CloudAgentRunTrigger,
    @Optional() private readonly license?: LicenseService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'cloud-agent-runs:trigger', waitForCompletion: true })
  async run(): Promise<void> {
    // While the license is expired nothing creates or promotes runs; queued runs wait for renewal.
    if (this.license?.isExpired()) return;
    const workspaces = await this.prisma.agentRunSettings.findMany({
      where: { enabled: true },
      select: { workspaceId: true },
    });
    for (const { workspaceId } of workspaces) {
      try {
        await this.trigger.tick(workspaceId);
      } catch (error) {
        this.logger.error(`Agent run trigger failed for workspace ${workspaceId}: ${(error as Error).message}`);
      }
    }
  }
}
