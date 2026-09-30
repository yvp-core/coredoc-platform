import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { IntentReleaseModule } from '../intent/intent-release.module.js';
import { LicenseCoreModule } from '../license/license.module.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { ActorRegistryService } from './actor-registry.service.js';
import { CanonicalDeliveryController } from './canonical-delivery.controller.js';
import { CanonicalDeliveryService } from './canonical-delivery.service.js';
import { DeliveryController } from './delivery.controller.js';
import { DeliveryEnabledGuard } from './delivery-enabled.guard.js';
import { DeliveryService } from './delivery.service.js';
import { DeliverySyncCron } from './delivery-sync.cron.js';
import { GithubCanonicalProjectionService } from './github-canonical-projection.service.js';
import { GithubCodeChangePersistenceService } from './github-code-change-persistence.service.js';
import { GithubImporterService } from './github-importer.service.js';
import { GithubIntentReleaseService } from '../intent/github-intent-release.service.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { JiraImporterService } from './jira-importer.service.js';
import { RenormalizeService } from './renormalize.service.js';
import { StatusMapService } from './status-map.service.js';

const deliveryCoreProviders = [
  DeliveryService,
  DeliveryEnabledGuard,
  GithubImporterService,
  JiraImporterService,
  ActorRegistryService,
  StatusMapService,
  RenormalizeService,
  WorkspaceMcpContextService,
  CanonicalDeliveryService,
  JiraCanonicalProjectionService,
  GithubCanonicalProjectionService,
  GithubCodeChangePersistenceService,
  GithubIntentReleaseService,
];

@Module({
  // IntentReleaseModule: the GitHub projection is an automatic intent actor in a
  // `merge`/`deploy` workspace (amendment §3.1) and writes through the same service
  // the REST route does.
  imports: [DatabaseModule, IntentReleaseModule],
  providers: deliveryCoreProviders,
  exports: [
    DeliveryService,
    DeliveryEnabledGuard,
    ActorRegistryService,
    StatusMapService,
    RenormalizeService,
    CanonicalDeliveryService,
    JiraCanonicalProjectionService,
  ],
})
export class DeliveryCoreModule {}

@Module({
  imports: [AuthModule, DeliveryCoreModule],
  controllers: [DeliveryController, CanonicalDeliveryController],
})
export class DeliveryApiModule {}

@Module({
  // LicenseCoreModule: the cron refuses to enqueue new connector syncs once the
  // license is expired past grace (the worker has no HTTP guard).
  imports: [DeliveryCoreModule, LicenseCoreModule],
  providers: [DeliverySyncCron],
})
export class DeliveryWorkerScheduleModule {}

@Module({
  imports: [DeliveryCoreModule, DeliveryApiModule, DeliveryWorkerScheduleModule],
  exports: [DeliveryCoreModule],
})
export class DeliveryModule {}
