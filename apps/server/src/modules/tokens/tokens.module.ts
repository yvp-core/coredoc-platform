import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { TokensController } from './tokens.controller.js';
import { TelemetryTokenController } from './telemetry-token.controller.js';
import { TokensService } from './tokens.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [TokensController, TelemetryTokenController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
