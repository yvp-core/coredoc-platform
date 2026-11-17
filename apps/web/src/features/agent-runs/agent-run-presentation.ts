/**
 * Kept free of React so polling and merging are table-tested without timers. Payloads are
 * free-form on the wire, so nothing here may throw on a shape it does not recognise.
 */
import { formatRelativeTime } from '@/lib/time';
import type {
  AgentRun,
  AgentRunEvent,
  RunnerTokenStatus,
  RunStatus,
  RunWorkflow,
  SubscriptionKeyStatus,
} from './types.js';

const POLL_INTERVAL_MS = 3000;

const TERMINAL: readonly RunStatus[] = ['done', 'failed', 'cancelled'];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

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
  running: 'Running',
  awaiting_answer: 'Awaiting an answer',
  awaiting_scope_acceptance: 'Awaiting scope acceptance',
  delivering: 'Delivering',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const RUNNING_LABELS: Record<string, string> = { scope: 'Scoping', implement: 'Implementing' };

/** A running run reads by its phase: the default workflow's own words, any other phase by its id. */
export function statusLabel(status: string, phase?: string): string {
  if (status === 'running' && phase) return RUNNING_LABELS[phase] ?? `Running ${phase}`;
  return STATUS_LABELS[status as RunStatus] ?? status;
}

/** True for a phase that ends with a proposal a person accepts or sends back. */
export function isGatedPhase(workflow: RunWorkflow | undefined, phase: string): boolean {
  return workflow?.phases.find((candidate) => candidate.id === phase)?.gate === 'acceptance';
}

const PHASE_ACTIVITY: Record<string, string> = { scope: 'scoping', implement: 'implementing' };

/** Reads after "while": "scoping", "in the review phase". */
export function phaseActivity(phase: string): string {
  return PHASE_ACTIVITY[phase] ?? `in the ${phase} phase`;
}

type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

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

export function waitingForRunnerSince(run: Pick<AgentRun, 'currentTurn'>): string | null {
  return run.currentTurn?.state === 'queued' ? run.currentTurn.queuedAt : null;
}

const PHASE_LABELS: Record<string, string> = {
  scope: 'Scope phase',
  implement: 'Implement phase',
  delivery: 'Delivery phase',
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? `${phase} phase`;
}

type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

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

export function runnerRefusalText(token: Pick<RunnerTokenStatus, 'refusal' | 'refusalDetail'>): string | null {
  if (!token.refusal) return null;
  if (token.refusal === 'startup_check_failed') {
    return `Start-up check failed: ${token.refusalDetail ?? 'no reason reported'}`;
  }
  return RUNNER_REFUSALS[token.refusal] ?? token.refusal;
}

export function runnerVersionsText(versions: RunnerTokenStatus['versions']): string | null {
  if (!versions) return null;
  const { manifest, subscriptionKeys: _keys, ...tools } = versions;
  const parts = Object.entries(tools)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `${name === 'claudeCode' ? 'claude code' : name} ${value}`);
  if (manifest) {
    const workflows = (manifest.workflows ?? []).map(({ id, phases }) => {
      const models = phases
        .filter((phase) => phase.model || phase.effort)
        .map((phase) => [phase.id, phase.model, phase.effort].filter(Boolean).join(' '));
      return models.length > 0 ? `${id} (${models.join(', ')})` : id;
    });
    const plugins = manifest.plugins.map(({ name, version }) => (version ? `${name} ${version}` : name));
    if (workflows.length > 0) parts.push(`workflows: ${workflows.join(', ')}`);
    if (plugins.length > 0) parts.push(`plugins: ${plugins.join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function usageWindowText(name: string, window: SubscriptionKeyStatus['fiveHour'], now: Date): string {
  if (!window || window.utilization === null) return `${name} —`;
  const used = `${name} ${Math.round(window.utilization)}%`;
  // A window whose reset has passed has started over; the runner has not read it since.
  return window.resetsAt && new Date(window.resetsAt) > now
    ? `${used} (resets ${formatRelativeTime(window.resetsAt, now)})`
    : used;
}

/** One line per subscription key: its state, then the 5-hour and weekly windows as last read by the runner. */
export function subscriptionKeyText(key: SubscriptionKeyStatus, now: Date = new Date()): string {
  const exhausted = key.exhaustedUntil !== null && new Date(key.exhaustedUntil) > now;
  const state = exhausted
    ? `at its limit, back ${formatRelativeTime(key.exhaustedUntil, now)}`
    : key.active
      ? 'in use'
      : 'standby';
  return [
    key.label,
    state,
    usageWindowText('5 h', key.fiveHour, now),
    usageWindowText('week', key.sevenDay, now),
    key.checkedAt ? `read ${formatRelativeTime(key.checkedAt, now)}` : 'not read yet',
  ].join(' · ');
}
