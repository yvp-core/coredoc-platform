/**
 * Run creation and the concurrency queue, as transaction-level steps. Every
 * caller holds `lockCloudAgentRunCreation` for the workspace, so the "never
 * had a run" check, the ordinal, the count of started runs and promotion see
 * one consistent order across all API and worker processes.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRunSettings, CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import { FAILURE_MESSAGES, type FailureCode } from './failure-codes.js';
import { jiraOutcomeOf, queueStatusTransition, StatusEvent } from './jira-outcome.js';
import { RunPhase, RunStatus, ServerEventType, TERMINAL_RUN_STATUSES } from './run-states.js';
import { appendRunEvents, type Tx } from './run-store.js';

export interface NewRun {
  jiraIssueId: string;
  issueKey: string;
  jiraConnectorId: string | null;
  trigger: string;
  startedBy: string | null;
  runOwnerId: string;
  previousRunId?: string;
  questionsPolicy: string;
  scopeAcceptancePolicy: string;
  seeds: string[];
  /** A Jira-triggered run that fails validation is created `failed`. */
  failure?: { code: FailureCode; reason: string };
}

/** Run branch: `coredoc/<KEY>` for an issue's first run, `coredoc/<KEY>-<n>` for later ones. */
function runBranch(issueKey: string, ordinal: number): string {
  return ordinal === 1 ? `coredoc/${issueKey}` : `coredoc/${issueKey}-${ordinal}`;
}

/**
 * Create a run, `queued` or failed at creation. Budgets and the model always
 * come from the current settings; policies come from the caller.
 */
export async function createRun(
  tx: Tx,
  workspaceId: string,
  settings: AgentRunSettings,
  input: NewRun,
  at: Date,
): Promise<CloudAgentRun> {
  const ordinal = (await tx.cloudAgentRun.count({ where: { workspaceId, jiraIssueId: input.jiraIssueId } })) + 1;
  const status = input.failure ? RunStatus.Failed : RunStatus.Queued;
  const run = await tx.cloudAgentRun.create({
    data: {
      workspaceId,
      jiraIssueId: input.jiraIssueId,
      issueKey: input.issueKey,
      jiraConnectorId: input.jiraConnectorId,
      trigger: input.trigger,
      startedBy: input.startedBy,
      runOwnerId: input.runOwnerId,
      previousRunId: input.previousRunId ?? null,
      status,
      phase: RunPhase.Scope,
      questionsPolicy: input.questionsPolicy,
      scopeAcceptancePolicy: input.scopeAcceptancePolicy,
      model: settings.model,
      seeds: input.seeds,
      runOrdinal: ordinal,
      branch: runBranch(input.issueKey, ordinal),
      scopeSessionId: randomUUID(),
      implementSessionId: randomUUID(),
      maxSpendUsd: settings.maxSpendUsd,
      maxActiveSeconds: settings.maxActiveSeconds,
      waitingLimitSeconds: settings.waitingLimitSeconds,
      maxTurnDurationSeconds: settings.maxTurnDurationSeconds,
      maxRepositories: settings.maxRepositories,
      failureCode: input.failure?.code ?? null,
      failureReason: input.failure?.reason ?? null,
      finishedAt: input.failure ? at : null,
      createdAt: at,
    },
  });
  await appendRunEvents(
    tx,
    { workspaceId, runId: run.id },
    [
      {
        type: ServerEventType.StatusChanged,
        payload: input.failure
          ? {
              from: null,
              to: status,
              code: input.failure.code,
              message: FAILURE_MESSAGES[input.failure.code],
              reason: input.failure.reason,
            }
          : { from: null, to: status },
      },
    ],
    at,
  );
  return run;
}

/**
 * Start queued runs, oldest first, while the workspace has fewer than its
 * limit of started, unfinished runs (every status except `queued` and the
 * terminal ones; runs waiting for a person keep their slot). Returns the ids
 * of the runs it started. The caller has checked that runs may start.
 */
export async function promoteQueuedRuns(
  tx: Tx,
  workspaceId: string,
  settings: AgentRunSettings,
  at: Date,
): Promise<string[]> {
  const started = await tx.cloudAgentRun.count({
    where: { workspaceId, status: { notIn: [RunStatus.Queued, ...TERMINAL_RUN_STATUSES] } },
  });
  const free = settings.maxStartedRuns - started;
  if (free <= 0) return [];
  const queued = await tx.cloudAgentRun.findMany({
    where: { workspaceId, status: RunStatus.Queued },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: free,
    select: { id: true, jiraOutcome: true },
  });
  for (const { id, jiraOutcome } of queued) {
    await tx.cloudAgentRun.update({
      where: { id },
      data: {
        status: RunStatus.Scoping,
        startedAt: at,
        activeSince: at,
        // The run sweep moves the issue to the configured started status.
        jiraOutcome: queueStatusTransition(
          jiraOutcomeOf({ jiraOutcome }),
          StatusEvent.Started,
          settings.startedStatus,
          at,
        ) as unknown as Prisma.InputJsonObject,
      },
    });
    await tx.cloudAgentRunTurn.create({
      data: { workspaceId, runId: id, ordinal: 1, kind: RunPhase.Scope, createdAt: at },
    });
    await appendRunEvents(
      tx,
      { workspaceId, runId: id },
      [{ type: ServerEventType.StatusChanged, payload: { from: RunStatus.Queued, to: RunStatus.Scoping } }],
      at,
    );
  }
  return queued.map(({ id }) => id);
}
