/**
 * Retention sweep for `intent_mutation_requests` (spec §4.8).
 *
 * The idempotency ledger is the one intent table that is pure MACHINERY: it
 * holds no reviewed content, only "this key was spent on this request, and this
 * is what it answered". Its retention window is 30 days, documented with
 * migration `20260901101000`. The archived branch never expired these rows at
 * all (audit §2.12) — an unbounded ledger is the gap this closes.
 *
 * Nothing else in the module is swept: items, transitions, and audit events are
 * user data and decision history, and they are deleted only by an operator's
 * documented teardown (spec §16).
 *
 * Shape follows `metrics-retention.cron.ts`: its own kill switch (so pausing
 * one sweep never silently stops another), and a >= 1-day clamp so a
 * mis-typed window can never become "purge everything".
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, configFromEnv } from '../../config/app-config.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service.js';
import { parseRetentionDays, parseRetentionFlag, retentionCutoff, runRetentionSweep } from '../../libs/retention.js';

const DEFAULT_RETENTION_DAYS = 30;

@Injectable()
export class IntentRetentionCron {
  private readonly logger = new Logger(IntentRetentionCron.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = configFromEnv().workers,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'intent:mutation-request-retention' })
  async purgeExpiredMutationRequests(): Promise<void> {
    // Default ON: an unbounded idempotency ledger is the gap this closes, so an
    // operator opts OUT of the sweep rather than into it.
    if (!parseRetentionFlag(this.workers.retention.intentMutationEnabled, { defaultEnabled: true })) return;

    // Unset means the documented default. An explicit value — including `0` or
    // a negative — is a misconfiguration rather than "unset": it is clamped to
    // one day instead of silently falling back, so the operator's mistake stays
    // visible and can never widen the sweep.
    const days = parseRetentionDays(this.workers.retention.intentMutationDays, { fallback: DEFAULT_RETENTION_DAYS });

    await runRetentionSweep({
      name: 'intent mutation-request retention',
      unit: 'rows',
      cutoff: retentionCutoff(days),
      logger: this.logger,
      purge: async (cutoff) => {
        const { count } = await this.prisma.intentMutationRequest.deleteMany({ where: { createdAt: { lt: cutoff } } });
        return count;
      },
    });
  }
}
