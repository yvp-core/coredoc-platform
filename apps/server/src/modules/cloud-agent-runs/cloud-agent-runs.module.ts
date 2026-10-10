import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { GithubRepositoryResolver } from '../../libs/github/github-repository-resolver.service.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE, ObjectStorageArchiveStore } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunActivityService } from './cloud-agent-run-activity.service.js';
import { CloudAgentRunDeliveryService } from './cloud-agent-run-delivery.service.js';
import { CloudAgentRunImplementService } from './cloud-agent-run-implement.service.js';
import { CloudAgentRunJiraOutcomes } from './cloud-agent-run-jira-outcomes.service.js';
import { CloudAgentRunIssueReader } from './cloud-agent-run-issue-reader.js';
import { CloudAgentRunScopeService } from './cloud-agent-run-scope.service.js';
import { LicenseCoreModule } from '../license/license.module.js';
import { CloudAgentRunAvailability } from './cloud-agent-run-availability.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';
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
import { CloudAgentTurnArchiveService } from './cloud-agent-turn-archive.service.js';
import { CloudAgentTurnService } from './cloud-agent-turn.service.js';

export { CLOUD_AGENT_RUNS_RETRY_DELAY } from './retry.js';
export { CLOUD_AGENT_RUNS_CLOCK } from './run-store.js';

/** No controllers: the worker graph imports it. */
export const cloudAgentRunsCoreProviders = [
  CloudAgentRunService,
  CloudAgentTurnService,
  CloudAgentTurnArchiveService,
  CloudAgentRunSettingsService,
  CloudAgentRunIssueReader,
  CloudAgentRunScopeService,
  CloudAgentRunImplementService,
  CloudAgentRunAvailability,
  CloudAgentRunJiraConnector,
  CloudAgentRunTrigger,
  CloudAgentRunQuestionService,
  CloudAgentRunRepositoryRequestService,
  CloudAgentRunSweep,
  CloudAgentRunDeliveryService,
  CloudAgentRunJiraOutcomes,
  CloudAgentRunActivityService,
  GithubRepositoryResolver,
];

const archiveStoreProvider = { provide: CLOUD_AGENT_RUN_ARCHIVE_STORE, useClass: ObjectStorageArchiveStore };

@Module({
  imports: [DatabaseModule, LicenseCoreModule],
  providers: [...cloudAgentRunsCoreProviders, archiveStoreProvider],
  exports: cloudAgentRunsCoreProviders,
})
export class CloudAgentRunsCoreModule {}

/** Not the desktop telemetry `AgentRunsModule`. */
@Module({
  imports: [AuthModule, CloudAgentRunsCoreModule],
  controllers: [CloudAgentRunsController, CloudAgentRunnerController],
})
export class CloudAgentRunsApiModule {}

/** Worker graph only: crons never run in the api role. */
@Module({
  imports: [CloudAgentRunsCoreModule, LicenseCoreModule],
  providers: [CloudAgentRunTriggerCron, CloudAgentRunSweepCron],
})
export class CloudAgentRunsWorkerScheduleModule {}
