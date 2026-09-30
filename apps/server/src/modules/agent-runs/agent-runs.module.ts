import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AgentRunsService } from './agent-runs.service.js';
import { AgentRunsController } from './agent-runs.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AgentRunsController],
  providers: [AgentRunsService],
  exports: [AgentRunsService],
})
export class AgentRunsModule {}
