import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, workersConfigFromEnv } from '../../config/app-config.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service.js';
import { parseRetentionFlag, retentionCutoff, runRetentionSweep } from '../../libs/retention.js';
import { DeliveryProvider } from '../../generated/prisma/client.js';
import { LicenseService } from '../license/license.service.js';
import { DeliveryService } from './delivery.service.js';
import { CODE_CHANGE_NORM_VERSION } from './github-normalizer.js';
import { GITHUB_CANONICAL_PROJECTION_VERSION } from './github-canonical-projection.service.js';

/**
 * Hourly sweep that enqueues a connector_sync job for every active GitHub or Jira
 * connector. Mirrors the stale-recovery cron idiom in jobs.controller.ts:
 * env-gate early-return + per-item try/catch so one bad connector never aborts
 * the sweep. Enqueue is delegated to DeliveryService (single writer of
 * connector_sync jobs, shared with the manual trigger endpoint) so this cron
 * carries no Prisma-write logic of its own.
 */
@Injectable()
export class DeliverySyncCron {
  private readonly logger = new Logger(DeliverySyncCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: DeliveryService,
    // Optional: deployments with no license file (hosted, dev) and the unit
    // tests construct this cron without one, which reads as "no enforcement" —
    // the same meaning LicenseState.Absent has everywhere else.
    @Optional() private readonly license?: LicenseService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = workersConfigFromEnv(),
  ) {}

  /**
   * An expired deployment keeps serving what it already has, but must not pull
   * NEW external data in. The REST trigger for the same enqueue is refused by
   * LicenseGuard; this cron runs in the worker where no HTTP guard exists, so
   * it carries the same refusal itself.
   */
  private refusedByLicense(what: string): boolean {
    if (!this.license?.isExpired()) return false;
    this.logger.warn(`delivery sync: skipping ${what} — the Coredoc license has expired past its grace window.`);
    return true;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'delivery:connector-sync' })
  async syncActiveConnectors(): Promise<void> {
    if (!parseRetentionFlag(this.workers.retention.deliverySyncEnabled, { defaultEnabled: true })) return;
    if (this.refusedByLicense('connector sync enqueue')) return;

    const connectors = await this.prisma.deliveryConnector.findMany({
      // Gate on the workspace's delivery flag via the relation filter: a disabled
      // workspace's connectors are never swept (the enqueued job would skip anyway).
      where: {
        provider: { in: [DeliveryProvider.github, DeliveryProvider.jira] },
        status: 'active',
        workspace: { deliveryEnabled: true },
      },
      select: { id: true, workspaceId: true },
    });

    for (const connector of connectors) {
      try {
        await this.deliveryService.enqueueConnectorSyncJob(connector.workspaceId, connector.id);
      } catch (err) {
        // Per-connector isolation: log and continue so one failure doesn't
        // starve the rest of the fleet of its scheduled sync.
        this.logger.error(
          `delivery sync: enqueue failed for connector ${connector.id} — ${(err as Error)?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Hourly sweep that enqueues a renormalize job for any workspace still holding
   * GitHub raw rows below either the normalized-wire or canonical-projection version.
   *
   * A normalizer version bump is only half a change: the new derivation applies to
   * rows the importer writes AFTER it, and every row already stored keeps whatever
   * the old version derived until something re-runs it. Nothing did — the only
   * producer of renormalize jobs was a manual admin POST. That is a deadline, not
   * just a gap: the backfill re-derives from the retained raw payloads, and the
   * retention sweep below hard-deletes those after DELIVERY_RAW_RETENTION_DAYS. A
   * row whose payload ages out before an operator remembers to press the button can
   * never be upgraded, because its source is gone.
   *
   * Self-limiting rather than one-shot: the predicate is "a stale row exists", so
   * the sweep stops enqueuing once the backfill has drained, and resumes by itself
   * on the next version bump. `enqueueRenormalizeJob` dedups per workspace, so an
   * in-flight backfill is never enqueued twice.
   *
   * Deliberately NOT license-gated, unlike the connector sweep: this imports
   * nothing, it re-derives rows the deployment already holds — and the raw
   * payloads it derives from are hard-deleted by the retention sweep, so
   * pausing it during an expiry would permanently strand those rows.
   *
   * That only holds because the CLAIM side agrees: an expired PushWorker
   * narrows its claim to `renormalize` rather than refusing everything (see
   * PushWorkerService.licenseRestrictsClaimToRenormalize). Enqueuing here while
   * the worker refused to claim would leave the jobs pending until retention
   * deleted their sources — the exact data loss this exemption exists to avoid.
   * The two sites are one policy; change them together.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'delivery:renormalize-backfill' })
  async backfillStaleNormalizations(): Promise<void> {
    if (!parseRetentionFlag(this.workers.retention.deliverySyncEnabled, { defaultEnabled: true })) return;

    // Asked of the RAW payloads, which is what the backfill actually re-derives
    // from — and the same predicate RenormalizeService scans by, so a workspace is
    // named here exactly when that scan would find it work to do.
    const stale = await this.prisma.deliveryRawPayload.findMany({
      where: {
        workspace: { deliveryEnabled: true },
        resourceType: 'pull_request',
        // Truncated rows lack sub-resources — the backfill skips them, so a
        // workspace holding only those is NOT behind and must not be enqueued
        // every hour forever.
        truncated: false,
        OR: [
          { normVersion: null },
          { normVersion: { lt: CODE_CHANGE_NORM_VERSION } },
          { canonicalProjectionVersion: null },
          { canonicalProjectionVersion: { lt: GITHUB_CANONICAL_PROJECTION_VERSION } },
        ],
      },
      // One row per workspace is all the predicate needs — this asks WHETHER a
      // workspace is behind, never how far.
      select: { workspaceId: true },
      distinct: ['workspaceId'],
    });

    for (const { workspaceId } of stale) {
      try {
        await this.deliveryService.enqueueRenormalizeJob(workspaceId);
      } catch (err) {
        // Per-workspace isolation, same as the connector sweep above.
        this.logger.error(
          `delivery renormalize backfill: enqueue failed for workspace ${workspaceId} — ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (stale.length > 0) {
      this.logger.log(
        `delivery renormalize backfill: enqueued for ${stale.length} workspace(s) behind norm v${CODE_CHANGE_NORM_VERSION} or projection v${GITHUB_CANONICAL_PROJECTION_VERSION}`,
      );
    }
  }

  /**
   * Daily retention sweep: hard-delete raw connector payloads older than
   * DELIVERY_RAW_RETENTION_DAYS (default 30). The raw payloads are the audit
   * trail behind the normalized delivery tables; once past the retention window
   * they are dead weight. Same env gate as the sync cron so both pause together.
   *
   * Intentionally NOT gated by the per-workspace deliveryEnabled flag: purging
   * expired raw payloads is storage hygiene, independent of whether L4 is enabled
   * for a workspace. Disabling delivery must not silently strand old payloads past
   * their retention window.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'delivery:raw-retention' })
  async purgeExpiredRawPayloads(): Promise<void> {
    // Default ON, shared with the sync cron above so both pause together.
    if (!parseRetentionFlag(this.workers.retention.deliverySyncEnabled, { defaultEnabled: true })) return;

    // Clamp to >= 1 day: a negative or zero DELIVERY_RAW_RETENTION_DAYS would push
    // the cutoff into the future and deleteMany would purge EVERY raw payload —
    // irreversible data loss. Clamp per repo rollback-first guardrails.
    // Kept as the original one-liner rather than `parseRetentionDays`: here a
    // falsy value (including "0" and "") means the 30-day default, while the
    // shared helper clamps an explicit "0" to one day. Changing that would flip
    // the window under existing deployments.
    const days = Math.max(1, Number(this.workers.retention.deliveryRawDays) || 30);

    await runRetentionSweep({
      name: 'delivery retention',
      unit: 'raw payloads',
      days,
      cutoff: retentionCutoff(days),
      logger: this.logger,
      purge: async (cutoff) => {
        const { count } = await this.prisma.deliveryRawPayload.deleteMany({ where: { fetchedAt: { lt: cutoff } } });
        return count;
      },
    });
  }
}
