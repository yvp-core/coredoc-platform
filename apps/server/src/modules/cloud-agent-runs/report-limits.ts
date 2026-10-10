/** Runner reports are untrusted: a runaway or compromised runner fails its run instead of filling the timeline. */
import { RunFailureCode } from './run-states.js';
import type { Tx } from './run-store.js';
import { failRun, lockRun } from './run-transitions.js';

export const CLOUD_AGENT_RUN_REPORT_CAPS = Symbol('CLOUD_AGENT_RUN_REPORT_CAPS');

export interface ReportCaps {
  events: number;
  /** Measured as the runner sent it. */
  eventBytes: number;
  /** `propose_scope` calls, refused ones included. */
  proposals: number;
  questions: number;
}

export const DEFAULT_REPORT_CAPS: ReportCaps = {
  events: 5_000,
  eventBytes: 8 * 1024 * 1024,
  proposals: 10,
  questions: 20,
};

export type Report = { events: number; eventBytes: number } | { proposals: 1 } | { questions: 1 };

/** Over a cap the run fails, and the caller tells the runner to stop without recording the report. */
export async function chargeReport(
  tx: Tx,
  turn: { id: string; run_id: string; workspace_id: string },
  report: Report,
  caps: ReportCaps,
  at: Date,
): Promise<boolean> {
  const counted = await tx.cloudAgentRunTurn.update({
    where: { id: turn.id },
    data: {
      ...('events' in report
        ? {
            reportedEvents: { increment: report.events },
            reportedEventBytes: { increment: report.eventBytes },
          }
        : {}),
      ...('proposals' in report ? { reportedProposals: { increment: 1 } } : {}),
      ...('questions' in report ? { reportedQuestions: { increment: 1 } } : {}),
    },
    select: { reportedEvents: true, reportedEventBytes: true, reportedProposals: true, reportedQuestions: true },
  });
  const exceeded =
    counted.reportedEvents > caps.events
      ? `more than ${caps.events} events`
      : counted.reportedEventBytes > caps.eventBytes
        ? `more than ${caps.eventBytes} bytes of events`
        : counted.reportedProposals > caps.proposals
          ? `more than ${caps.proposals} scope proposals`
          : counted.reportedQuestions > caps.questions
            ? `more than ${caps.questions} questions`
            : null;
  if (!exceeded) return false;
  const run = await lockRun(tx, turn.workspace_id, turn.run_id);
  if (run) {
    await failRun(tx, run, RunFailureCode.ReportLimitExceeded, `The runner sent ${exceeded} in one turn.`, at);
  }
  return true;
}
