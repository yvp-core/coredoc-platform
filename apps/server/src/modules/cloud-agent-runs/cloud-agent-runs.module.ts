import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { LicenseCoreModule } from '../license/license.module.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira.service.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunTriggerCron } from './cloud-agent-run-trigger.cron.js';
import { CloudAgentRunTrigger } from './cloud-agent-run-trigger.service.js';
import { CloudAgentRunService } from './cloud-agent-run.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { CloudAgentTurnService } from './cloud-agent-turn.service.js';

export { CLOUD_AGENT_RUNS_CLOCK } from './run-store.js';

/** Run service and state machine, turns and leases, settings. No controllers: the worker graph imports it. */
export const cloudAgentRunsCoreProviders = [
  CloudAgentRunService,
  CloudAgentTurnService,
  CloudAgentRunSettingsService,
  CloudAgentRunIssueResolver,
  CloudAgentRunAvailability,
  CloudAgentRunJiraConnector,
  CloudAgentRunTrigger,
  GithubRepositoryResolver,
];

@Module({
  imports: [DatabaseModule, LicenseCoreModule],
  providers: cloudAgentRunsCoreProviders,
  exports: cloudAgentRunsCoreProviders,
})
export class CloudAgentRunsCoreModule {}

/** The human run API and the runner API. Not the desktop telemetry `AgentRunsModule`. */
@Module({
  imports: [AuthModule, CloudAgentRunsCoreModule],
  controllers: [CloudAgentRunsController, CloudAgentRunnerController],
})
export class CloudAgentRunsApiModule {}

/** The trigger cron (creation and promotion). Worker graph only: crons never run in the api role. */
@Module({
  imports: [CloudAgentRunsCoreModule, LicenseCoreModule],
  providers: [CloudAgentRunTriggerCron],
})
export class CloudAgentRunsWorkerScheduleModule {}
