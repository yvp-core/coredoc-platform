/**
 * License Modules
 *
 * Split provider/API the same way Push and Jobs are split, and for the same
 * reason: the worker process root must recursively contain NO controllers
 * (pinned by app.module.isolation.test.ts). The worker needs LicenseService —
 * it fails fast at boot on a bad file and gates the sync cron and the job
 * claim — but must never pull in LicenseController.
 *
 * - LicenseCoreModule: the service only. Imported by every consumer that just
 *   needs the license state (worker root, jobs worker, delivery worker cron,
 *   health readiness payload).
 * - LicenseApiModule: adds GET /api/v1/license. API root only.
 */

import { Module } from '@nestjs/common';
import { LicenseController } from './license.controller.js';
import { LicenseService } from './license.service.js';

@Module({
  providers: [LicenseService],
  exports: [LicenseService],
})
export class LicenseCoreModule {}

@Module({
  imports: [LicenseCoreModule],
  controllers: [LicenseController],
  exports: [LicenseCoreModule],
})
export class LicenseApiModule {}
