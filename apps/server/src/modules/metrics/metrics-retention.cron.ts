import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, configFromEnv } from '../../config/app-config.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service.js';
import { parseRetentionDays, parseRetentionFlag, retentionCutoff, runRetentionSweep } from '../../libs/retention.js';

/**
 * Daily retention sweep for `mcp_query_metrics` (C3, spec.md run
 * cdr-20260807-f6d09a): one row per cloud MCP tool call, previously unbounded
 * — only `DeliveryRawPayload` had a purge cron. Hard-deletes rows older than
 * `MCP_METRICS_RETENTION_DAYS` (default 180). Env-gated by its OWN
 * `MCP_METRICS_RETENTION_ENABLED` kill-switch (same STYLE as
 * `delivery-sync.cron.ts`, deliberately not the same FLAG — pausing delivery
 * sync must not silently stop metrics retention, and vice versa), with the
 * same non-positive-window clamp (rollback-first guardrail: a misconfigured
 * 0/negative window must never turn into "purge everything").
 */
@Injectable()
export class MetricsRetentionCron {
  private readonly logger = new Logger(MetricsRetentionCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = configFromEnv().workers,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'metrics:mcp-query-retention' })
  async purgeExpiredMcpQueryMetrics(): Promise<void> {
    // Default ON: metrics retention is storage hygiene an operator opts OUT of.
    if (!parseRetentionFlag(this.workers.retention.mcpMetricsEnabled, { defaultEnabled: true })) return;

    // Unset → the default (180). An explicit value — including "0" or negative
    // — is a misconfiguration, not "unset": it is clamped to >= 1 day rather
    // than silently falling back to the default, which would mask the
    // operator's mistake and risk purging everything on a bad negative value.
    const days = parseRetentionDays(this.workers.retention.mcpMetricsDays, { fallback: 180 });

    await runRetentionSweep({
      name: 'mcp query metrics retention',
      unit: 'rows',
      days,
      cutoff: retentionCutoff(days),
      logger: this.logger,
      purge: async (cutoff) => {
        const { count } = await this.prisma.mcpQueryMetric.deleteMany({ where: { queriedAt: { lt: cutoff } } });
        return count;
      },
    });
  }
}
