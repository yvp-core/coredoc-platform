import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE, ObjectStorageArchiveStore } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunImplementService } from './cloud-agent-run-implement.service.js';
import { CloudAgentRunIssueReader } from './cloud-agent-run-issue-reader.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import { LicenseCoreModule } from '../license/license.module.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunIssueResolver } from './cloud-agent-run-issue.resolver.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira.service.js';
import { CloudAgentRunQuestionService } from './cloud-agent-run-questions.service.js';
import { CloudAgentRunRepositoryRequestService } from './cloud-agent-run-repository-requests.service.js';
import { CloudAgentRunSettingsService } from './cloud-agent-run-settings.service.js';
import { CloudAgentRunSweep } from './cloud-agent-run-sweep.service.js';
import { CloudAgentRunSweepCron } from './cloud-agent-run-sweep.cron.js';
import { CloudAgentRunTriggerCron } from './cloud-agent-run-trigger.cron.js';
import { CloudAgentRunTrigger } from './cloud-agent-run-trigger.service.js';
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
  CloudAgentRunIssueReader,
  CloudAgentRunScopeService,
  CloudAgentRunImplementService,
  CloudAgentRunAvailability,
  CloudAgentRunJiraConnector,
  CloudAgentRunTrigger,
  CloudAgentRunQuestionService,
  CloudAgentRunRepositoryRequestService,
  CloudAgentRunSweep,
  GithubRepositoryResolver,
];

const archiveStoreProvider = { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useClass: ObjectStorageArchiveStore };

@Module({
  imports: [DatabaseModule, LicenseCoreModule],
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

/** The trigger cron (creation and promotion) and the run sweep. Worker graph only: crons never run in the api role. */
@Module({
  imports: [CloudAgentRunsCoreModule, LicenseCoreModule],
  providers: [CloudAgentRunTriggerCron, CloudAgentRunSweepCron],
})
export class CloudAgentRunsWorkerScheduleModule {}
