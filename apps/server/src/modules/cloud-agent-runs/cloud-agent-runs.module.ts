import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE, ObjectStorageArchiveStore } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunJiraService } from './cloud-agent-run-jira.service.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunService } from './cloud-agent-run.service.js';
import { CloudAgentRunnerController } from './cloud-agent-runner.controller.js';
import { CloudAgentRunsController } from './cloud-agent-runs.controller.js';
import { CloudAgentTurnService } from './cloud-agent-turn.service.js';

export { CLOUD_AGENT_RUNS_CLOCK } from './run-store.js';

/**
 * Run service and state machine, turns and leases, scope, settings. No
 * controllers: the worker graph imports it. The state-archive store is
 * provided separately so suites can put an in-memory one at that port.
 */
export const cloudAgentRunsCoreProviders = [
  CloudAgentRunService,
  CloudAgentTurnService,
  CloudAgentRunSettingsService,
  CloudAgentRunIssueResolver,
  CloudAgentRunJiraService,
  CloudAgentRunScopeService,
  GithubRepositoryResolver,
];

const archiveStoreProvider = { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useClass: ObjectStorageArchiveStore };

@Module({
  imports: [DatabaseModule],
  providers: [...cloudAgentRunsCoreProviders, archiveStoreProvider],
  exports: cloudAgentRunsCoreProviders,
})
export class CloudAgentRunsCoreModule {}

/** The human run API and the runner API. Not the desktop telemetry `AgentRunsModule`. */
@Module({
  imports: [AuthModule, CloudAgentRunsCoreModule],
  controllers: [CloudAgentRunsController, CloudAgentRunnerController],
})
export class CloudAgentRunsApiModule {}
