import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { TokensModule } from '../tokens/tokens.module.js';
import { MapperCoreModule } from '../mapper/mapper.module.js';
import { JobQueueModule } from '../job-queue/job-queue.module.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';
import { WorkspaceConfigModule } from './config/workspace-config.module.js';

@Module({
  imports: [AuthModule, DatabaseModule, TokensModule, WorkspaceConfigModule, MapperCoreModule, JobQueueModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
