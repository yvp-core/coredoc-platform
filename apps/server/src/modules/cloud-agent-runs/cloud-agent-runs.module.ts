import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
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
];

@Module({
  imports: [DatabaseModule],
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
