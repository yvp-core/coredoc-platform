import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigModule } from './config/app-config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { CaptureWorkerScheduleModule } from './modules/capture/capture.module.js';
import {
  CloudAgentRunsCoreModule,
  CloudAgentRunsWorkerScheduleModule,
} from './modules/cloud-agent-runs/cloud-agent-runs.module.js';
import { DeliveryCoreModule, DeliveryWorkerScheduleModule } from './modules/delivery/delivery.module.js';
import { IntentWorkerScheduleModule } from './modules/intent/intent.module.js';
import { JobsWorkerModule } from './modules/jobs/jobs.module.js';
import { LicenseCoreModule } from './modules/license/license.module.js';
import { MapperCoreModule } from './modules/mapper/mapper.module.js';
import { MetricsCoreModule, MetricsWorkerScheduleModule } from './modules/metrics/metrics.module.js';
import { PushCoreModule } from './modules/push/push.module.js';
import { TelemetryModule } from './modules/telemetry/telemetry.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AppConfigModule.forRole('worker'),
    DatabaseModule,
    TelemetryModule,
    // The worker graph verifies the license for the same reason the API graph
    // does: it fails fast at boot on a present-but-bad file, and an expired
    // deployment must stop pulling NEW product data in through the back door
    // (the sync cron and the job claim honour LicenseService — the API guard
    // never sees either).
    LicenseCoreModule,
    CaptureWorkerScheduleModule,
    MapperCoreModule,
    MetricsCoreModule,
    MetricsWorkerScheduleModule,
    DeliveryCoreModule,
    DeliveryWorkerScheduleModule,
    CloudAgentRunsCoreModule,
    CloudAgentRunsWorkerScheduleModule,
    PushCoreModule,
    JobsWorkerModule,
    IntentWorkerScheduleModule,
  ],
})
export class WorkerAppModule {}
