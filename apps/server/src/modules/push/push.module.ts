import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { MetricsCoreModule } from '../metrics/metrics.module.js';
import { MapperCoreModule } from '../mapper/mapper.module.js';
import { JobQueueModule } from '../job-queue/job-queue.module.js';
import { GraphSnapshotModule } from '../graph-snapshot/graph-snapshot.module.js';
import { LeaseModule } from '../lease/lease.module.js';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';
import { ResultStorageService } from './result-storage.service.js';
import { DiffEngine } from './diff-engine.js';

@Module({
  imports: [DatabaseModule, MetricsCoreModule, LeaseModule, MapperCoreModule, GraphSnapshotModule],
  providers: [PushService, ResultStorageService, DiffEngine],
  exports: [PushService, ResultStorageService],
})
export class PushCoreModule {}

@Module({
  imports: [AuthModule, PushCoreModule, JobQueueModule],
  controllers: [PushController],
})
export class PushApiModule {}

/** Compatibility composition for repository-local consumers. */
@Module({
  imports: [PushCoreModule, PushApiModule],
  exports: [PushCoreModule],
})
export class PushModule {}
