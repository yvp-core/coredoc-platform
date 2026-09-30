import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CaptureController } from './capture.controller.js';
import { CaptureRetentionCron } from './capture-retention.cron.js';
import { CaptureService } from './capture.service.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [CaptureController],
  providers: [CaptureService],
})
export class CaptureModule {}

@Module({
  imports: [DatabaseModule],
  providers: [CaptureRetentionCron],
})
export class CaptureWorkerScheduleModule {}
