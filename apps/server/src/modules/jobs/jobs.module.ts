import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { MapperCoreModule } from '../mapper/mapper.module.js';
import { PushCoreModule } from '../push/push.module.js';
import { DeliveryCoreModule } from '../delivery/delivery.module.js';
import { GraphSnapshotModule } from '../graph-snapshot/graph-snapshot.module.js';
import { LicenseCoreModule } from '../license/license.module.js';
import { JobQueueModule } from '../job-queue/job-queue.module.js';
import { JobProcessor } from './job-processor.service.js';
import { PushWorkerService } from './push-worker.service.js';
import { JobsController } from './jobs.controller.js';
import { StaleJobRecoveryService } from './stale-job-recovery.service.js';

export { JobQueueModule } from '../job-queue/job-queue.module.js';

@Module({
  imports: [AuthModule, JobQueueModule],
  controllers: [JobsController],
})
export class JobsApiModule {}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DatabaseModule,
    JobQueueModule,
    MapperCoreModule,
    PushCoreModule,
    DeliveryCoreModule,
    GraphSnapshotModule,
    // LicenseCoreModule: PushWorkerService stops claiming queued work once the
    // license is expired past grace (see licenseBlocksClaim).
    LicenseCoreModule,
  ],
  providers: [JobProcessor, PushWorkerService, StaleJobRecoveryService],
  exports: [PushWorkerService],
})
export class JobsWorkerModule {}

/** Compatibility composition for repository-local consumers. */
@Module({
  imports: [JobQueueModule, JobsApiModule, JobsWorkerModule],
  exports: [JobQueueModule, JobsWorkerModule],
})
export class JobsModule {}
