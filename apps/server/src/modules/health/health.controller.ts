import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService, type HealthReport } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Readiness probe — gates whether this pod should receive traffic. Returns 200
   * when every probed dependency is reachable, 503 otherwise, with a per-
   * component breakdown in the body. Liveness is intentionally a separate,
   * dependency-free route (see `getLiveness`): a failing dependency must take the
   * pod out of rotation, not restart it.
   *
   * The status is set directly on the response rather than thrown:
   * GlobalExceptionFilter is a catch-all that collapses thrown errors to a
   * generic `{ statusCode, timestamp, path }` shape (dropping the per-component
   * detail) and forwards every 5xx to telemetry — an expected-unhealthy probe
   * must not pollute that signal. `passthrough: true` keeps Nest's normal
   * serialization of the returned body while letting us choose the status code.
   */
  @Get()
  async getHealth(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const report = await this.healthService.check();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  /**
   * Liveness probe — is the process itself alive and serving HTTP? Deliberately
   * touches no external dependency. A liveness failure restarts the pod, and
   * restarting never repairs a downstream Postgres/Neo4j outage — it just thrashes
   * the deployment. Dependency health belongs on the readiness probe (`getHealth`),
   * which removes the pod from rotation without killing it.
   */
  @Get('live')
  getLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
