/**
 * Health Service
 *
 * Probes the backing stores the server depends on so the /health route reports
 * real readiness rather than a static "ok":
 * - Postgres (control plane) — always probed via a trivial `SELECT 1`.
 * - Neo4j (data plane) — only probed in on-prem deployments where Neo4j is the
 *   configured backend (COREDOC_DB_BACKEND=neo4j); reported as "skipped" in the
 *   default cloud deployment, where the data plane is per-workspace Turso/SQLite
 *   and there is no Neo4j to probe.
 *
 * The offline license state is reported alongside the checks but deliberately
 * does NOT participate in the ok/error decision: an expired license degrades
 * writes, and taking every pod out of rotation for it would be exactly the
 * "brick the deployment" outcome the licensing design rejects.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, storageConfigFromEnv } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { LicenseState } from '../license/license-state.js';
import { LicenseService } from '../license/license.service.js';

export type ComponentStatus = 'up' | 'down' | 'skipped';

export interface ComponentCheck {
  status: ComponentStatus;
}

export interface HealthReport {
  status: 'ok' | 'error';
  checks: {
    postgres: ComponentCheck;
    neo4j: ComponentCheck;
  };
  license: { state: LicenseState };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly license: LicenseService,
    @Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = storageConfigFromEnv(),
  ) {}

  /**
   * Run all dependency checks concurrently. Overall status is 'error' if any
   * probed component is 'down'; a 'skipped' component never fails the report.
   */
  async check(): Promise<HealthReport> {
    const [postgres, neo4j] = await Promise.all([this.checkPostgres(), this.checkNeo4j()]);
    const healthy = postgres.status !== 'down' && neo4j.status !== 'down';
    return {
      status: healthy ? 'ok' : 'error',
      checks: { postgres, neo4j },
      license: { state: this.license.getStatus().state },
    };
  }

  private async checkPostgres(): Promise<ComponentCheck> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up' };
    } catch (error) {
      // Full reason goes to the logs only — the /health body is public and
      // unauthenticated, so it must not leak connection strings or driver errors.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Postgres health check failed: ${message}`);
      return { status: 'down' };
    }
  }

  private async checkNeo4j(): Promise<ComponentCheck> {
    // Neo4j is the data-plane backend only in on-prem deployments. In the default
    // cloud deployment the data plane is per-workspace Turso/SQLite and no Neo4j
    // exists, so probing it would always fail — report 'skipped' instead.
    if (!this.isNeo4jBackend()) {
      return { status: 'skipped' };
    }
    try {
      // Dynamic import so the SQLite/cloud deployment never eagerly loads the
      // Neo4j driver module. Verify against the shared singleton driver (the one
      // the app actually serves graph requests from) so the probe reuses its
      // bolt connection pool instead of opening a throwaway connection per hit.
      const { getNeo4jDriver } = await import('@coredoc/db');
      const driver = await getNeo4jDriver();
      await driver.verifyConnectivity();
      return { status: 'up' };
    } catch (error) {
      // Logged, not returned — see checkPostgres: keep internals out of the body.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Neo4j health check failed: ${message}`);
      return { status: 'down' };
    }
  }

  /**
   * Mirrors WorkspaceDbPoolService.isNeo4jBackend and @coredoc/db's
   * getConfiguredBackend: only the literal lowercased "neo4j" selects Neo4j.
   * Compared inline (rather than importing getConfiguredBackend) so the
   * SQLite/cloud deployment never eagerly loads the @coredoc/db module.
   */
  private isNeo4jBackend(): boolean {
    return this.storage.dbBackend.toLowerCase() === 'neo4j';
  }
}
