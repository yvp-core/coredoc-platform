/**
 * Health Module
 *
 * Exposes the public, unauthenticated probes: readiness at /health (dependency-
 * gated) and liveness at /health/live (dependency-free). PrismaService is injected
 * from the @Global() DatabaseModule, so no import is needed here; LicenseCoreModule is
 * imported for the license state folded into the readiness payload.
 */

import { Module } from '@nestjs/common';
import { LicenseCoreModule } from '../license/license.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [LicenseCoreModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
