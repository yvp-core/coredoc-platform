import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { R2StorageService } from '../../database/r2-storage.service.js';
import { GraphSnapshotBuildService } from './graph-snapshot-artifact.service.js';
import { GraphSnapshotControlPlaneService } from './graph-snapshot-control-plane.service.js';
import { GraphSnapshotExecutionService } from './graph-snapshot-execution.service.js';
import { LeaseModule } from '../lease/lease.module.js';

@Module({
  imports: [DatabaseModule, LeaseModule],
  providers: [
    GraphSnapshotControlPlaneService,
    {
      provide: GraphSnapshotBuildService,
      inject: [R2StorageService],
      useFactory: (r2: R2StorageService) => new GraphSnapshotBuildService(r2),
    },
    GraphSnapshotExecutionService,
  ],
  exports: [GraphSnapshotControlPlaneService, GraphSnapshotBuildService, GraphSnapshotExecutionService],
})
export class GraphSnapshotModule {}
