import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WORKERS_CONFIG, type WorkersConfig, configFromEnv } from '../../config/app-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { parseRetentionFlag } from '../../libs/retention.js';
import { CLOUD_AGENT_RUN_ARCHIVE_STORE, type CloudAgentRunArchiveStore } from './cloud-agent-run-archive.store.js';
import { CloudAgentRunJiraOutcomes } from './cloud-agent-run-jira-outcomes.service.js';
import { settleTurnQuestions } from './cloud-agent-run-questions.service.js';
import {
  fromColumn,
  QuestionState,
  RunFailureCode,
  RunStatus,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
  TurnOutcome,
  TurnState,
} from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, systemClock } from './run-store.js';
import { expireActiveTime, expireLeases, type SweepDeps } from './run-limits.sweep.js';
import { pruneEndedRuns } from './run-retention.sweep.js';
import { deleteTurnTokens, failRun, lockRun } from './run-transitions.js';

const BATCH = 100;

const WAITING_STATUSES = [RunStatus.AwaitingAnswer, RunStatus.AwaitingScopeAcceptance];

/**
 * Every API and worker process runs the sweep at once; each item re-checks its
 * condition under the row locks, so concurrent sweeps act on an item once.
 */
@Injectable()
export class CloudAgentRunSweep {
  private readonly logger = new Logger(CloudAgentRunSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOUD_AGENT_RUN_ARCHIVE_STORE) private readonly archives: CloudAgentRunArchiveStore,
    private readonly jiraOutcomes: CloudAgentRunJiraOutcomes,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
    @Optional() @Inject(WORKERS_CONFIG) private readonly workers: WorkersConfig = configFromEnv().workers,
  ) {}

  async tick(): Promise<void> {
    await this.completeParkedTurns();
    await expireLeases(this.deps);
    await this.expireWaiting();
    await expireActiveTime(this.deps);
    // After the jobs that fail runs, so a run failed in this tick gets its comment in it.
    await this.jiraOutcomes.postDoneComments();
    await this.jiraOutcomes.postFailureComments();
    // After the failure comments, which queue the failed transition.
    await this.jiraOutcomes.applyStatusTransitions();
    if (parseRetentionFlag(this.workers.retention.agentRunsEnabled, { defaultEnabled: true })) {
      await pruneEndedRuns(this.deps);
    }
  }

  private get deps(): SweepDeps {
    return { prisma: this.prisma, archives: this.archives, now: this.now, logger: this.logger };
  }

  /** Completed as paused, not re-queued: the session already ended with the question. */
  async completeParkedTurns(): Promise<void> {
    const at = this.now();
    const due = await this.prisma.$queryRaw<Array<{ id: string; run_id: string; workspace_id: string }>>`
      SELECT t.id, t.run_id, t.workspace_id
      FROM cloud_agent_run_turns t
      JOIN cloud_agent_runs r ON r.id = t.run_id
      WHERE t.state = ${TurnState.Claimed}
        AND t.lease_expires_at <= ${at}
        AND r.status <> ALL(${[...TERMINAL_RUN_STATUSES]}::text[])
        AND EXISTS (
          SELECT 1 FROM cloud_agent_run_questions q
          WHERE q.asked_in_turn_id = t.id
            AND (q.state = ${QuestionState.Open} OR (q.state = ${QuestionState.Answered} AND q.resume_turn_id IS NULL))
        )
      ORDER BY t.lease_expires_at, t.id
      LIMIT ${BATCH}`;
    for (const turn of due) {
      try {
        await this.completeParkedTurn(turn.workspace_id, turn.run_id, turn.id);
      } catch (error) {
        this.logger.error(`Could not complete parked turn ${turn.id}: ${(error as Error).message}`);
      }
    }
  }

  private async completeParkedTurn(workspaceId: string, runId: string, turnId: string): Promise<void> {
    const at = this.now();
    const replaced = await this.prisma.$transaction(async (tx) => {
      // Lock order as in the runner API: the turn, then the run.
      const locked = await tx.$queryRaw<Array<{ state: string; lease_expires_at: Date | null }>>`
        SELECT state, lease_expires_at FROM cloud_agent_run_turns WHERE id = ${turnId}::uuid FOR UPDATE`;
      const turn = locked[0];
      if (!turn || turn.state !== TurnState.Claimed || !turn.lease_expires_at || turn.lease_expires_at > at) {
        return null;
      }
      const run = await lockRun(tx, workspaceId, runId);
      if (!run || (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return null;

      const row = await tx.cloudAgentRunTurn.update({
        where: { id: turnId },
        data: { state: TurnState.Completed, outcome: TurnOutcome.QuestionAsked, completedAt: at },
      });
      await deleteTurnTokens(tx, [turnId]);
      // The archive the turn uploaded after its session ended holds the parked call.
      const adopt = row.stateArchiveKey !== null && row.stateArchiveKey !== run.stateArchiveKey;
      const current = await tx.cloudAgentRun.update({
        where: { id: run.id },
        data: { lastTurnEndedAt: at, ...(adopt ? { stateArchiveKey: row.stateArchiveKey } : {}) },
      });
      await appendRunEvents(
        tx,
        { workspaceId, runId, turnId },
        [{ type: ServerEventType.TurnEnded, payload: { outcome: TurnOutcome.QuestionAsked, spendUsd: null } }],
        at,
      );
      await settleTurnQuestions(tx, current, turnId, at);
      return adopt ? run.stateArchiveKey : null;
    });
    if (replaced) await this.archives.delete(replaced).catch(() => undefined);
  }

  /** Elapsed time never answers a question: it is cancelled with the run. */
  async expireWaiting(): Promise<void> {
    const at = this.now();
    const due = await this.prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
      SELECT id, workspace_id
      FROM cloud_agent_runs
      WHERE status = ANY(${WAITING_STATUSES}::text[])
        AND waiting_since + make_interval(secs => waiting_limit_seconds) <= ${at}
      ORDER BY waiting_since, id
      LIMIT ${BATCH}`;
    for (const { id, workspace_id: workspaceId } of due) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const run = await lockRun(tx, workspaceId, id);
          if (!run || !WAITING_STATUSES.includes(fromColumn(RunStatus, run.status))) return;
          if (!run.waitingSince || run.waitingSince.getTime() + run.waitingLimitSeconds * 1000 > at.getTime()) return;
          await failRun(tx, run, RunFailureCode.WaitingExpired, null, at);
        });
      } catch (error) {
        this.logger.error(`Could not expire waiting run ${id}: ${(error as Error).message}`);
      }
    }
  }
}
