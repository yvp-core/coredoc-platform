import type { RunnerFailureCode, TurnOutcome } from '@coredoc/core/agent-runner';
import type { TurnResult } from './runner.js';

export class TurnFailure extends Error {
  constructor(
    readonly code: RunnerFailureCode,
    reason: string,
  ) {
    super(reason.slice(0, 2_000));
    this.name = 'TurnFailure';
  }
}

export function failedOutcome(error: TurnFailure): TurnOutcome {
  return { kind: 'failed', code: error.code, reason: error.message };
}

/** Runs a turn's work; a TurnFailure becomes the turn's failed outcome instead of an error. */
export async function reportingFailures(work: () => Promise<TurnResult>): Promise<TurnResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TurnFailure) return { spend: null, outcome: failedOutcome(error) };
    throw error;
  }
}

/** GitHub calls retry in process up to three times (four attempts), then fail the run. */
export const GITHUB_ATTEMPTS = 4;
