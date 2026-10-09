/**
 * Pure presentation of cloud agent runs: polling cadence, timeline merging and
 * wording. Kept free of React so polling and merging are table-tested without
 * timers. Payloads are free-form on the wire, so nothing here may assume a
 * shape or throw on one it does not recognise.
 */
import type { AgentRun, AgentRunEvent, RunnerTokenStatus, RunStatus, TurnKind } from './types.js';

export const POLL_INTERVAL_MS = 3000;

const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

/** Poll every 3 s while the run is non-terminal (or not loaded yet); stop at terminal. */
export function pollInterval(status: RunStatus | undefined): number | false {
  return status && isTerminalStatus(status) ? false : POLL_INTERVAL_MS;
}

/** Append a forward page to the timeline: deduplicated by sequence, ascending. */
export function mergeTimeline(existing: readonly AgentRunEvent[], incoming: readonly AgentRunEvent[]): AgentRunEvent[] {
  const bySeq = new Map<number, AgentRunEvent>();
  for (const event of [...existing, ...incoming]) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  scoping: 'Scoping',
  awaiting_answer: 'Awaiting an answer',
  awaiting_scope_acceptance: 'Awaiting scope acceptance',
  implementing: 'Implementing',
  delivering: 'Delivering',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as RunStatus] ?? status;
}

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

export function statusTone(status: RunStatus): StatusTone {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'cancelled' || status === 'queued') return 'neutral';
  if (status === 'awaiting_answer' || status === 'awaiting_scope_acceptance') return 'warn';
  return 'info';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/** Spend against budget; unreported turns make the total explicitly partial, never a silent zero. */
export function spendText(spend: AgentRun['spend']): string {
  const base = `${usd(spend.usd)} of ${usd(spend.maxUsd)}`;
  if (spend.unknownTurns === 0) return base;
  const turns = spend.unknownTurns === 1 ? '1 turn' : `${spend.unknownTurns} turns`;
  return `${base} (partial: ${turns} did not report spend)`;
}

/** When a turn waits in the queue, the run is waiting for an agent runner since then. */
export function waitingForRunnerSince(run: Pick<AgentRun, 'currentTurn'>): string | null {
  return run.currentTurn?.state === 'queued' ? run.currentTurn.queuedAt : null;
}

const PHASE_LABELS: Record<TurnKind, string> = {
  scope: 'Scope phase',
  implement: 'Implement phase',
  delivery: 'Delivery phase',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as TurnKind] ?? phase;
}

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentTask {
  text: string;
  status: AgentTaskStatus;
}

const TASK_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed'];

export const TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
};

/** The agent's current tasks: the items of the latest todos event. */
export function currentTasks(events: readonly AgentRunEvent[]): AgentTask[] {
  const latest = [...events].reverse().find((event) => event.type === 'todos');
  const items = latest?.payload?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    const { text: taskText, status } = (item ?? {}) as Record<string, unknown>;
    const label = text(taskText);
    return label
      ? [{ text: label, status: TASK_STATUSES.includes(String(status)) ? (status as AgentTaskStatus) : 'pending' }]
      : [];
  });
}

const RUNNER_REFUSALS: Record<string, string> = {
  creator_not_admin: 'Refused: its creator is no longer an admin of this workspace. Mint a new token.',
  runner_incompatible: 'Refused: this runner version is not supported. Upgrade the runner.',
};

/** Why a runner token is refused or claims nothing, with the runner's own reason for a failed start-up check. */
export function runnerRefusalText(token: Pick<RunnerTokenStatus, 'refusal' | 'refusalDetail'>): string | null {
  if (!token.refusal) return null;
  if (token.refusal === 'startup_check_failed') {
    return `Start-up check failed: ${token.refusalDetail ?? 'no reason reported'}`;
  }
  return RUNNER_REFUSALS[token.refusal] ?? token.refusal;
}

export function runnerVersionsText(versions: RunnerTokenStatus['versions']): string | null {
  if (!versions) return null;
  const parts = Object.entries(versions)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name === 'claudeCode' ? 'claude code' : name} ${value}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
