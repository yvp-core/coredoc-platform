/**
 * Pure presentation of cloud agent runs: polling cadence, timeline merging and
 * wording. Kept free of React so polling and merging are table-tested without
 * timers. Payloads are free-form on the wire, so nothing here may assume a
 * shape or throw on one it does not recognise.
 */
import type { AgentRun, AgentRunEvent, RunStatus } from './types.js';

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

export type TimelineItem =
  | { kind: 'entry'; seq: number; text: string }
  | { kind: 'raw'; seq: number; lines: string[] }
  /** Workflow changes withheld from the push, with their diff for a person to apply when it was shown. */
  | { kind: 'diff'; seq: number; text: string; paths: string[]; diff: string | null; note: string | null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const TURN_OUTCOME_WORDS: Record<string, string> = {
  no_outcome: 'without an outcome',
  question_asked: 'with a question for a person',
  scope_proposed: 'with a scope proposal',
};

function describeEvent(event: AgentRunEvent): string {
  const payload = event.payload ?? {};
  switch (event.type) {
    case 'status_changed': {
      const to = text(payload.to);
      return to ? `Status: ${statusLabel(to)}` : 'Status changed';
    }
    case 'turn_started': {
      const kind = text(payload.kind) ?? 'agent';
      const attempt = typeof payload.attempt === 'number' ? ` (attempt ${payload.attempt})` : '';
      return `${capitalize(kind)} turn started${attempt}`;
    }
    case 'turn_ended': {
      const outcome = TURN_OUTCOME_WORDS[String(payload.outcome)] ?? text(payload.outcome);
      const spend = typeof payload.spendUsd === 'number' ? `$${payload.spendUsd.toFixed(2)}` : 'spend not reported';
      return `Turn ended${outcome ? ` ${outcome}` : ''} (${spend})`;
    }
    case 'phase': {
      const phase = text(payload.phase);
      return phase ? `Phase: ${phase}` : 'Phase changed';
    }
    case 'todos':
      return 'Task list updated';
    case 'question': {
      const headers = Array.isArray(payload.headers) ? payload.headers.filter((h) => typeof h === 'string') : [];
      const about = headers.length ? `: ${headers.join(', ')}` : '';
      return payload.state === 'auto_answered'
        ? `The agent asked${about}; answered automatically (assume policy)`
        : `The agent asked a question${about}`;
    }
    case 'question_resolved':
      return payload.state === 'cancelled' ? 'Question cancelled: the run ended' : 'Question answered';
    case 'run_event':
      return text(payload.text) ?? 'Run event';
    case 'done':
      return payload.ok === false
        ? `Agent session failed${text(payload.error) ? `: ${payload.error}` : ''}`
        : 'Agent session finished';
    default:
      return event.type;
  }
}

/** Timeline rows: raw agent activity collapsed into one group per consecutive run. */
export function timelineItems(events: readonly AgentRunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.type === 'raw') {
      const line = text(event.payload?.text) ?? (event.truncated ? '[truncated]' : '');
      const last = items[items.length - 1];
      if (last?.kind === 'raw') last.lines.push(line);
      else items.push({ kind: 'raw', seq: event.seq, lines: [line] });
      continue;
    }
    if (event.type === 'run_event' && event.payload?.code === 'workflow_diff_withheld') {
      const paths = Array.isArray(event.payload.paths)
        ? event.payload.paths.filter((path): path is string => typeof path === 'string')
        : [];
      items.push({
        kind: 'diff',
        seq: event.seq,
        text: describeEvent(event),
        paths,
        diff: text(event.payload.diff),
        note: text(event.payload.note) ?? (event.truncated ? 'The diff was too large to keep.' : null),
      });
      continue;
    }
    items.push({ kind: 'entry', seq: event.seq, text: describeEvent(event) });
  }
  return items;
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
