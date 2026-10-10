import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, configFromEnv } from '../../config/app-config.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import { parseRetentionDays, parseRetentionFlag, retentionCutoff, runRetentionSweep } from '../../libs/retention.js';

const DEFAULT_RETENTION_DAYS = 90;
const BATCH_SIZE = 1_000;
const MAX_NONEMPTY_BATCHES = 10;
const CHECKPOINT_ID = 'capture_fine_events';

interface DeletedCaptureBatch {
  deletedCount: number;
  lastDeletedReceivedAt: Date | null;
}

@Injectable()
export class CaptureRetentionCron {
  private readonly logger = new Logger(CaptureRetentionCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = configFromEnv().workers,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'capture:fine-event-retention' })
  async purgeExpiredCaptureEvents(): Promise<void> {
    // Default OFF, unlike every other retention sweep: fine-grained capture
    // events are the operator's own telemetry, so deleting them stays an
    // explicit opt-in. Do not "align" this default with the others.
    if (!parseRetentionFlag(this.workers.retention.captureFineEnabled, { defaultEnabled: false })) return;

    // `refuse`, not clamp: a window nobody can read must not become a 1-day
    // sweep of the operator's telemetry.
    const days = parseRetentionDays(this.workers.retention.captureFineDays, {
      fallback: DEFAULT_RETENTION_DAYS,
      onInvalid: 'refuse',
    });
    if (days === null) {
      this.logger.error('capture fine-event retention disabled: invalid CAPTURE_FINE_RETENTION_DAYS');
      return;
    }

    await runRetentionSweep({
      name: 'capture fine-event retention',
      unit: 'events',
      cutoff: retentionCutoff(days),
      logger: this.logger,
      purge: async (cutoff) => {
        let deletedTotal = 0;
        let nonemptyBatches = 0;
        while (nonemptyBatches < MAX_NONEMPTY_BATCHES) {
          const deleted = await this.purgeBatch(cutoff);
          deletedTotal += deleted;
          if (deleted === 0) break;
          nonemptyBatches += 1;
          if (deleted < BATCH_SIZE) break;
        }
        return deletedTotal;
      },
    });
  }

  private async purgeBatch(cutoff: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const [batch] = await tx.$queryRaw<DeletedCaptureBatch[]>`
        WITH selected AS MATERIALIZED (
          SELECT
            id,
            workspace_id,
            actor_id,
            host,
            repository_key,
            received_at,
            type
          FROM capture_events
          WHERE received_at < ${cutoff}
          ORDER BY received_at ASC, id ASC
          LIMIT ${BATCH_SIZE}
          FOR UPDATE
        ), upserted_watermarks AS (
          INSERT INTO capture_accepted_watermarks (
            workspace_id,
            actor_id,
            host,
            scope_key,
            repository_key,
            first_accepted_at,
            last_accepted_at,
            workflow_last_accepted_at
          )
          SELECT
            workspace_id,
            actor_id,
            host,
            'repo:' || repository_key,
            repository_key,
            MIN(received_at),
            MAX(received_at),
            MAX(received_at) FILTER (
              WHERE type <> 'capability.used'
            )
          FROM selected
          WHERE repository_key IS NOT NULL
          GROUP BY
            workspace_id,
            actor_id,
            host,
            repository_key
          ON CONFLICT (workspace_id, actor_id, host, scope_key) DO UPDATE SET
            first_accepted_at = LEAST(
              capture_accepted_watermarks.first_accepted_at,
              EXCLUDED.first_accepted_at
            ),
            last_accepted_at = GREATEST(
              capture_accepted_watermarks.last_accepted_at,
              EXCLUDED.last_accepted_at
            ),
            workflow_last_accepted_at = GREATEST(
              capture_accepted_watermarks.workflow_last_accepted_at,
              EXCLUDED.workflow_last_accepted_at
            )
          RETURNING 1
        ), deleted AS (
          DELETE FROM capture_events
          USING selected
          WHERE capture_events.id = selected.id
          RETURNING capture_events.received_at
        )
        SELECT
          COUNT(*)::integer AS "deletedCount",
          MAX(received_at) AS "lastDeletedReceivedAt"
        FROM deleted
      `;

      const deletedCount = batch?.deletedCount ?? 0;
      const remaining = await tx.captureEvent.findFirst({
        where: { receivedAt: { lt: cutoff } },
        select: { id: true },
      });
      if (remaining !== null && batch?.lastDeletedReceivedAt == null) return deletedCount;

      // A concurrent sweep can make this batch short without proving global
      // exhaustion. Only the follow-up read may stamp the full cutoff.
      const progress = remaining === null ? cutoff : batch!.lastDeletedReceivedAt!;
      await tx.$executeRaw(
        Prisma.sql`
          INSERT INTO capture_retention_checkpoints (
            id,
            purged_through_received_at,
            updated_at
          )
          VALUES (${CHECKPOINT_ID}, ${progress}, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO UPDATE SET
            purged_through_received_at = GREATEST(
              capture_retention_checkpoints.purged_through_received_at,
              EXCLUDED.purged_through_received_at
            ),
            updated_at = CURRENT_TIMESTAMP
        `,
      );
      return deletedCount;
    });
  }
}
