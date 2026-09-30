import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { HealthController } from './health.controller.js';
import type { HealthService, HealthReport } from './health.service.js';
import { LicenseState } from '../license/license-state.js';

function makeRes(): Response & { status: ReturnType<typeof vi.fn> } {
  const res = { status: vi.fn().mockReturnThis() };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn> };
}

function makeController(report: HealthReport): HealthController {
  const service = { check: vi.fn(async () => report) } as unknown as HealthService;
  return new HealthController(service);
}

describe('HealthController', () => {
  it('returns 200 and the full report when healthy', async () => {
    const report: HealthReport = {
      status: 'ok',
      checks: { postgres: { status: 'up' }, neo4j: { status: 'skipped' } },
      license: { state: LicenseState.Absent },
    };
    const controller = makeController(report);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(result).toBe(report);
  });

  it('returns 503 (not a thrown exception) when a dependency is down', async () => {
    const report: HealthReport = {
      status: 'error',
      checks: { postgres: { status: 'down' }, neo4j: { status: 'skipped' } },
      license: { state: LicenseState.Absent },
    };
    const controller = makeController(report);
    const res = makeRes();

    const result = await controller.getHealth(res);

    expect(res.status).toHaveBeenCalledWith(503);
    // Body is returned (not thrown), so GlobalExceptionFilter never collapses the report.
    expect(result).toBe(report);
    expect(result.checks.postgres.status).toBe('down');
  });

  it('liveness returns ok without probing any dependency', () => {
    const service = { check: vi.fn() } as unknown as HealthService;
    const controller = new HealthController(service);

    // Liveness must never touch the dependency check — a DB outage should not
    // restart the pod (that is the readiness probe's job: take it out of rotation).
    expect(controller.getLiveness()).toEqual({ status: 'ok' });
    expect(service.check).not.toHaveBeenCalled();
  });
});
