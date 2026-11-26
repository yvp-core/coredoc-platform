/**
 * Every caller holds `lockCloudAgentRunCreation` for the workspace, so creation
 * and promotion see one consistent order across all processes.
 */
import type { WorkflowShape } from '@coredoc/core/agent-runner';
import type { AgentRunSettings, CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import { FAILURE_MESSAGES } from './failure-codes.js';
import { jiraOutcomeOf, queueStatusTransition, StatusEvent } from './jira-outcome.js';
import {
  activeStatusOf,
  type QuestionsPolicy,
  type RunFailureCode,
  RunStatus,
  type RunTrigger,
  type ScopeAcceptancePolicy,
  ServerEventType,
  TERMINAL_RUN_STATUSES,
} from './run-states.js';
import { appendRunEvents, type Tx } from './run-store.js';
import { firstPhase, newSessionIds } from './run-workflow.js';

export interface NewRun {
  jiraIssueId: string;
  issueKey: string;
  issueTitle: string | null;
  jiraConnectorId: string | null;
  trigger: RunTrigger;
  startedBy: string | null;
  runOwnerId: string;
  previousRunId?: string;
  workflow: WorkflowShape;
  scopeQuestionsPolicy: QuestionsPolicy;
  implementQuestionsPolicy: QuestionsPolicy;
  scopeAcceptancePolicy: ScopeAcceptancePolicy;
  seeds: string[];
  notes?: string | null;
  /** A Jira-triggered run that fails validation is created `failed`. */
  failure?: { code: RunFailureCode; reason: string };
}

const ISSUE_TITLE_MAX_CHARS = 255;

function runBranch(issueKey: string, ordinal: number): string {
  return ordinal === 1 ? `coredoc/${issueKey}` : `coredoc/${issueKey}-${ordinal}`;
}

/** Budgets and the model always come from the current settings; policies come from the caller. */
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
      issueTitle: input.issueTitle ? [...input.issueTitle].slice(0, ISSUE_TITLE_MAX_CHARS).join('') : null,
      jiraConnectorId: input.jiraConnectorId,
      trigger: input.trigger,
      startedBy: input.startedBy,
      runOwnerId: input.runOwnerId,
      previousRunId: input.previousRunId ?? null,
      status,
      phase: firstPhase(input.workflow),
      workflow: input.workflow.id,
      workflowShape: input.workflow as unknown as Prisma.InputJsonObject,
      sessionIds: newSessionIds(input.workflow),
      scopeQuestionsPolicy: input.scopeQuestionsPolicy,
      implementQuestionsPolicy: input.implementQuestionsPolicy,
      scopeAcceptancePolicy: input.scopeAcceptancePolicy,
      model: settings.model,
      seeds: input.seeds,
      notes: input.notes ?? null,
      runOrdinal: ordinal,
      branch: runBranch(input.issueKey, ordinal),
      maxSpendUsd: settings.maxSpendUsd,
      maxActiveSeconds: settings.maxActiveSeconds,
      waitingLimitSeconds: settings.waitingLimitSeconds,
      maxTurnDurationSeconds: settings.maxTurnDurationSeconds,
      maxRepositories: settings.maxRepositories,
      failureCode: input.failure?.code ?? null,
      failureReason: input.failure?.reason ?? null,
      finishedAt: input.failure ? at : null,
      createdAt: at,
      queuedAt: at,
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
 * Runs waiting for a person keep their slot. The caller has checked that runs may start. A
 * continued run already has its turn and goes back to its phase; a new one starts its first phase.
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
    orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
    take: free,
    select: { id: true, jiraOutcome: true, phase: true, continuations: true, startedAt: true },
  });
  for (const { id, jiraOutcome, phase, continuations, startedAt } of queued) {
    const status = activeStatusOf(phase);
    await tx.cloudAgentRun.update({
      where: { id },
      data: {
        status,
        startedAt: startedAt ?? at,
        activeSince: at,
        jiraOutcome: queueStatusTransition(
          jiraOutcomeOf({ jiraOutcome }),
          StatusEvent.Started,
          settings.startedStatus,
          at,
        ) as unknown as Prisma.InputJsonObject,
      },
    });
    if (continuations === 0) {
      await tx.cloudAgentRunTurn.create({
        data: { workspaceId, runId: id, ordinal: 1, kind: phase, createdAt: at },
      });
    }
    await appendRunEvents(
      tx,
      { workspaceId, runId: id },
      [{ type: ServerEventType.StatusChanged, payload: { from: RunStatus.Queued, to: status } }],
      at,
    );
  }
  return queued.map(({ id }) => id);
}
