/**
 * Spend is self-reported by the runner, so a run whose turns stop reporting it
 * can no longer be bounded and fails too.
 */
import type { CloudAgentRun } from '../../generated/prisma/client.js';
import { isTerminalRunStatus, RunFailureCode, RunStatus } from './run-states.js';
import type { Tx } from './run-store.js';
import { failRun } from './run-transitions.js';

export const MAX_UNKNOWN_SPEND_TURNS = 3;

export function spendBudgetFailure(run: CloudAgentRun): string | null {
  if (run.spendUsd >= run.maxSpendUsd) {
    return `The run spent an estimated ${run.spendUsd.toFixed(2)} USD of its ${run.maxSpendUsd.toFixed(2)} USD limit.`;
  }
  if (run.unknownSpendTurns >= MAX_UNKNOWN_SPEND_TURNS) {
    return `${run.unknownSpendTurns} turns ended with unknown spend, so the spend limit can no longer be enforced.`;
  }
  return null;
}

/** Delivery starts no agent session, so a delivering run keeps going. */
export async function failIfBudgetSpent(tx: Tx, run: CloudAgentRun, at: Date): Promise<void> {
  if (isTerminalRunStatus(run.status) || run.status === RunStatus.Delivering) return;
  const reason = spendBudgetFailure(run);
  if (reason) await failRun(tx, run, RunFailureCode.BudgetExhausted, reason, at);
}
