import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { FeedbackModule } from '../feedback/feedback.module.js';
import { MetricsCoreModule } from '../metrics/metrics.module.js';
import { AnalyticsController } from './analytics.controller.js';
import { UsageAnalyticsService } from './usage-analytics.service.js';

@Module({
  imports: [DatabaseModule, AuthModule, MetricsCoreModule, FeedbackModule],
  controllers: [AnalyticsController],
  providers: [UsageAnalyticsService],
})
export class AnalyticsModule {}
