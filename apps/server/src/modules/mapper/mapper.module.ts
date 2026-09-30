import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { LeaseModule } from '../lease/lease.module.js';
import { JobQueueModule } from '../job-queue/job-queue.module.js';
import { MapperController } from './mapper.controller.js';
import { MapperService } from './mapper.service.js';
import { MapperStorageService } from './mapper-storage.service.js';
import { ResolverService } from './resolver.service.js';

@Module({
  imports: [DatabaseModule, LeaseModule],
  providers: [MapperService, MapperStorageService, ResolverService],
  exports: [MapperService, ResolverService],
})
export class MapperCoreModule {}

@Module({
  imports: [AuthModule, MapperCoreModule, JobQueueModule],
  controllers: [MapperController],
})
export class MapperApiModule {}

/** Compatibility composition for repository-local consumers. */
@Module({
  imports: [MapperCoreModule, MapperApiModule],
  exports: [MapperCoreModule],
})
export class MapperModule {}
