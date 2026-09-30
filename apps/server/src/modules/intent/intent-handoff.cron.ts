import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service.js';
import { IntentHandoffProcessor } from './intent-handoff-processor.service.js';

@Injectable()
export class IntentHandoffCron {
  private readonly logger = new Logger(IntentHandoffCron.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly processor: IntentHandoffProcessor,
  ) {}

  @Cron('*/1 * * * *', { waitForCompletion: true })
  async run() {
    // The short claim survives a worker crash. Processing is idempotent and guarded by
    // handoff revision, so another worker cannot overwrite completed outcomes.
    const rows = await this.prisma.$transaction(async (tx) => {
      // Owner decision: a workspace with intent OFF costs nothing per tick. Filtering
      // here rather than in the worker keeps disabled workspaces out of the claim
      // entirely, so their rows keep their `nextAttemptAt` and resume when the flag
      // comes back. The subquery is not locked; FOR UPDATE SKIP LOCKED still applies
      // to the handoff rows exactly as before.
      const due = await tx.$queryRaw<Array<{ id: string; workspace_id: string }>>`
        SELECT id, workspace_id FROM intent_handoffs WHERE next_attempt_at <= now()
        AND workspace_id IN (SELECT id FROM workspaces WHERE intent_enabled = true)
        ORDER BY next_attempt_at, id LIMIT 20 FOR UPDATE SKIP LOCKED`;
      await tx.intentHandoff.updateMany({
        where: { id: { in: due.map((r) => r.id) } },
        data: { nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
      });
      return due;
    });
    for (const row of rows) {
      try {
        await this.processor.process(row.workspace_id, row.id);
      } catch {
        this.logger.warn(`Handoff ${row.id} will retry after worker failure`);
      }
    }
  }
}
