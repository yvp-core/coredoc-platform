import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AgentSessionsService } from './agent-sessions.service.js';
import { OtelIngestController } from './otel-ingest.controller.js';
import { AgentSessionsController } from './agent-sessions.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [OtelIngestController, AgentSessionsController],
  providers: [AgentSessionsService],
  exports: [AgentSessionsService],
})
export class AgentSessionsModule {}
