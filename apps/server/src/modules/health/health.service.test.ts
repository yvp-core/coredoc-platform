import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { HealthService } from './health.service.js';
import type { PrismaService } from '../../database/prisma.service.js';
import { LicenseState } from '../license/license-state.js';
import type { LicenseService } from '../license/license.service.js';

// Intercept both the static and the dynamic `import('@coredoc/db')`. The Neo4j
// probe resolves getNeo4jDriver() to a stub driver whose verifyConnectivity is
// reconfigured per test (resolve = up, reject = down).
const { verifyConnectivityMock, getNeo4jDriverMock } = vi.hoisted(() => {
  const verifyConnectivityMock = vi.fn();
  return {
    verifyConnectivityMock,
    getNeo4jDriverMock: vi.fn(async () => ({ verifyConnectivity: verifyConnectivityMock })),
  };
});

vi.mock('@coredoc/db', () => ({
  getNeo4jDriver: getNeo4jDriverMock,
}));

function makePrisma(queryImpl: () => Promise<unknown>): PrismaService {
  return { $queryRaw: vi.fn(queryImpl) } as unknown as PrismaService;
}

function makeLicense(state: LicenseState = LicenseState.Absent): LicenseService {
  return { getStatus: vi.fn(() => ({ state })) } as unknown as LicenseService;
}

const ORIGINAL_BACKEND = process.env.COREDOC_DB_BACKEND;

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) {
    delete process.env.COREDOC_DB_BACKEND;
  } else {
    process.env.COREDOC_DB_BACKEND = ORIGINAL_BACKEND;
  }
  verifyConnectivityMock.mockReset();
  getNeo4jDriverMock.mockClear();
  vi.restoreAllMocks();
});

describe('HealthService', () => {
  it('reports ok with postgres up and neo4j skipped on the default (non-neo4j) backend', async () => {
    delete process.env.COREDOC_DB_BACKEND;
    const service = new HealthService(
      makePrisma(async () => [{ '?column?': 1 }]),
      makeLicense(),
    );

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.checks.postgres).toEqual({ status: 'up' });
    expect(report.checks.neo4j).toEqual({ status: 'skipped' });
    // The Neo4j driver module must not even be loaded on the cloud/SQLite path.
    expect(getNeo4jDriverMock).not.toHaveBeenCalled();
  });

  it('reports error when postgres is unreachable, logging the reason without leaking it in the body', async () => {
    delete process.env.COREDOC_DB_BACKEND;
    const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new HealthService(
      makePrisma(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      }),
      makeLicense(),
    );

    const report = await service.check();

    expect(report.status).toBe('error');
    expect(report.checks.postgres).toEqual({ status: 'down' });
    expect(report.checks.neo4j.status).toBe('skipped');
    // Body carries only the status; the reason is logged server-side, not returned.
    expect(report.checks.postgres).not.toHaveProperty('error');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('probes the shared Neo4j driver and reports ok when both stores are up (neo4j backend)', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    verifyConnectivityMock.mockResolvedValue(undefined);
    const service = new HealthService(
      makePrisma(async () => [{ '?column?': 1 }]),
      makeLicense(),
    );

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.checks.postgres).toEqual({ status: 'up' });
    expect(report.checks.neo4j).toEqual({ status: 'up' });
    expect(getNeo4jDriverMock).toHaveBeenCalledTimes(1);
    expect(verifyConnectivityMock).toHaveBeenCalledTimes(1);
  });

  it('reports error when the neo4j backend is configured but Neo4j is unreachable', async () => {
    process.env.COREDOC_DB_BACKEND = 'neo4j';
    const logSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    verifyConnectivityMock.mockRejectedValue(new Error('Failed to connect to bolt://neo4j:7687'));
    const service = new HealthService(
      makePrisma(async () => [{ '?column?': 1 }]),
      makeLicense(),
    );

    const report = await service.check();

    expect(report.status).toBe('error');
    expect(report.checks.postgres.status).toBe('up');
    expect(report.checks.neo4j).toEqual({ status: 'down' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bolt://neo4j:7687'));
  });

  it('reports the license state without letting it change the ok/error decision', async () => {
    delete process.env.COREDOC_DB_BACKEND;
    const service = new HealthService(
      makePrisma(async () => [{ '?column?': 1 }]),
      makeLicense(LicenseState.Expired),
    );

    const report = await service.check();

    // An expired license degrades writes; it must NOT take the pod out of
    // rotation, so readiness stays 200/ok and only the payload reflects it.
    expect(report.status).toBe('ok');
    expect(report.license).toEqual({ state: LicenseState.Expired });
  });

  it('normalizes the backend env (case-insensitive) before probing Neo4j', async () => {
    process.env.COREDOC_DB_BACKEND = 'NEO4J';
    verifyConnectivityMock.mockResolvedValue(undefined);
    const service = new HealthService(
      makePrisma(async () => []),
      makeLicense(),
    );

    const report = await service.check();

    expect(report.checks.neo4j.status).toBe('up');
    expect(getNeo4jDriverMock).toHaveBeenCalledTimes(1);
  });
});
