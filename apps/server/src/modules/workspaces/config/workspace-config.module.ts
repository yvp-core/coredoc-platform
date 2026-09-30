import { Module } from '@nestjs/common';
import { AuthModule } from '../../../auth/auth.module.js';
import { DatabaseModule } from '../../../database/database.module.js';
import { WorkspaceConfigController } from './workspace-config.controller.js';
import { WorkspaceConfigService } from './workspace-config.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [WorkspaceConfigController],
  providers: [WorkspaceConfigService],
  exports: [WorkspaceConfigService],
})
export class WorkspaceConfigModule {}
