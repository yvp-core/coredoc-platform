import { randomUUID } from 'node:crypto';
import {
  DeliveryKind,
  PhaseGate,
  RepositoryMode,
  type WorkflowShape,
  WorkflowShapeSchema,
} from '@coredoc/core/agent-runner';
import type { CloudAgentRun } from '../../generated/prisma/client.js';

type RunWorkflow = Pick<CloudAgentRun, 'workflowShape'>;

/** The shape the run started with; a row that fails to parse is corrupt and fails loudly. */
export function workflowOf(run: RunWorkflow): WorkflowShape {
  return WorkflowShapeSchema.parse(run.workflowShape);
}

export function firstPhase(shape: WorkflowShape): string {
  return shape.phases[0]!.id;
}

/** The phase that ends with the run's result. */
export function finalPhase(shape: WorkflowShape): string {
  return shape.phases.at(-1)!.id;
}

/** True for a phase that ends with a proposal for a person; false for the final phase and for delivery. */
export function isGatedPhase(run: RunWorkflow, phase: string): boolean {
  return workflowOf(run).phases.find((candidate) => candidate.id === phase)?.gate === PhaseGate.Acceptance;
}

export function isFinalPhase(run: RunWorkflow, phase: string): boolean {
  return finalPhase(workflowOf(run)) === phase;
}

export function phaseAfter(run: RunWorkflow, phase: string): string {
  const { id, phases } = workflowOf(run);
  const next = phases[phases.findIndex((candidate) => candidate.id === phase) + 1];
  if (!next) throw new Error(`Phase ${phase} has no successor in workflow ${id}`);
  return next.id;
}

export function usesRepositories(run: RunWorkflow): boolean {
  return workflowOf(run).repositories !== RepositoryMode.None;
}

export function deliversPullRequests(run: RunWorkflow): boolean {
  return workflowOf(run).delivery === DeliveryKind.PullRequest;
}

export function newSessionIds(shape: WorkflowShape): Record<string, string> {
  return Object.fromEntries(shape.phases.map((phase) => [phase.id, randomUUID()]));
}

/** Null for a phase the run's workflow does not have. */
export function sessionIdOf(run: Pick<CloudAgentRun, 'sessionIds'>, phase: string): string | null {
  const ids = run.sessionIds as Record<string, unknown> | null;
  const id = ids?.[phase];
  return typeof id === 'string' ? id : null;
}
