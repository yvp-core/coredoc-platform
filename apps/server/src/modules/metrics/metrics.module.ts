import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { MetricsRetentionCron } from './metrics-retention.cron.js';

@Module({
  imports: [DatabaseModule],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsCoreModule {}

@Module({
  imports: [AuthModule, MetricsCoreModule],
  controllers: [MetricsController],
})
export class MetricsApiModule {}

@Module({
  imports: [MetricsCoreModule],
  providers: [MetricsRetentionCron],
})
export class MetricsWorkerScheduleModule {}
