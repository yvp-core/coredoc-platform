/** Payloads are free-form on the wire, so nothing here throws on a shape it does not recognise. */
import { isTerminalStatus } from './agent-run-presentation.js';
import type {
  AgentRunDetail,
  AgentRunEvent,
  AgentRunJiraComment,
  AgentRunJiraOutcome,
  AgentRunPullRequest,
  AgentRunQuestion,
  AgentRunResult,
  AgentRunSpec,
  AgentRunTurnActivity,
  RunStatus,
} from './types.js';

export type StageKind = 'scope' | 'review' | 'implement' | 'delivery';

export interface RunStage {
  key: string;
  kind: StageKind;
  name: string;
  startedAt: string;
  /** Null while the stage is under way. */
  endedAt: string | null;
  durationSeconds: number;
  /** Time spent waiting for a person: the whole of a review, a question's wait elsewhere. */
  waitingSeconds: number;
}

const STAGE_OF: Partial<Record<RunStatus, StageKind>> = {
  scoping: 'scope',
  awaiting_scope_acceptance: 'review',
  implementing: 'implement',
  delivering: 'delivery',
};

const STAGE_NAMES: Record<StageKind, string> = {
  scope: 'Scope',
  review: 'Review',
  implement: 'Implement',
  delivery: 'Delivery',
};

function seconds(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Time queued counts towards the stage it leads to, a question's wait towards the stage it
 * interrupts; repeated scope and review stages are numbered by the spec version.
 */
export function runStages(
  run: Pick<AgentRunDetail, 'status' | 'createdAt' | 'finishedAt'>,
  events: readonly AgentRunEvent[],
  now: Date,
): RunStage[] {
  const changes = events
    .filter((event) => event.type === 'status_changed' && text(event.payload?.to))
    .sort((a, b) => a.seq - b.seq);
  const end = run.finishedAt ?? (isTerminalStatus(run.status) ? null : now.toISOString());
  const stages: RunStage[] = [];
  const counts: Partial<Record<StageKind, number>> = {};
  let pendingStart: string | null = null;

  changes.forEach((change, index) => {
    const status = String(change.payload.to) as RunStatus;
    const from = change.createdAt;
    const to = changes[index + 1]?.createdAt ?? end ?? from;
    const current = stages.at(-1);
    if (status === 'queued') {
      pendingStart ??= from;
      return;
    }
    if (status === 'awaiting_answer' && current) {
      current.waitingSeconds += seconds(from, to);
      return;
    }
    const kind = STAGE_OF[status];
    if (!kind) return;
    const startedAt = pendingStart ?? from;
    pendingStart = null;
    if (current?.kind === kind) return;
    const count = (counts[kind] ?? 0) + 1;
    counts[kind] = count;
    stages.push({
      key: `${kind}-${count}`,
      kind,
      name: (kind === 'scope' || kind === 'review') && count > 1 ? `${STAGE_NAMES[kind]} v${count}` : STAGE_NAMES[kind],
      startedAt,
      endedAt: null,
      durationSeconds: 0,
      waitingSeconds: 0,
    });
  });

  stages.forEach((stage, index) => {
    const next = stages[index + 1]?.startedAt ?? run.finishedAt ?? null;
    stage.endedAt = next;
    stage.durationSeconds = seconds(stage.startedAt, next ?? now.toISOString());
    if (stage.kind === 'review') stage.waitingSeconds = stage.durationSeconds;
  });
  return stages;
}

export function runSpan(
  run: Pick<AgentRunDetail, 'createdAt' | 'startedAt' | 'finishedAt'>,
  stages: readonly RunStage[],
  now: Date,
): { startedAt: string; endedAt: string | null; durationSeconds: number } {
  const startedAt = stages[0]?.startedAt ?? run.startedAt ?? run.createdAt;
  return {
    startedAt,
    endedAt: run.finishedAt,
    durationSeconds: seconds(startedAt, run.finishedAt ?? now.toISOString()),
  };
}

export function durationText(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export type ConversationItem =
  | { kind: 'started'; id: string; at: string; text: string }
  | { kind: 'turn'; id: string; at: string; turn: AgentRunTurnActivity }
  | { kind: 'proposal'; id: string; at: string; spec: AgentRunSpec; reviewable: boolean }
  | { kind: 'review'; id: string; at: string; spec: AgentRunSpec }
  | { kind: 'accepted'; id: string; at: string; spec: AgentRunSpec }
  | { kind: 'question'; id: string; at: string; question: AgentRunQuestion; open: boolean }
  | {
      kind: 'withheld';
      id: string;
      at: string;
      text: string;
      paths: string[];
      diff: string | null;
      note: string | null;
    }
  | { kind: 'result'; id: string; at: string; result: AgentRunResult; points: string[]; pulls: AgentRunPullRequest[] }
  | { kind: 'delivery'; id: string; at: string; pulls: AgentRunPullRequest[]; lines: JiraLine[] }
  | { kind: 'ended'; id: string; at: string; status: 'done' | 'failed' | 'cancelled'; text: string };

const TRIGGER_TEXT: Record<string, string> = {
  jira_label: 'Started by the Jira label',
  manual: 'Started',
  rerun: 'Started as a re-run',
};

export interface JiraLine {
  text: string;
  warning: boolean;
}

const TRANSITION_TEXT: Record<string, string> = {
  transitioned: 'Jira issue moved to the done status',
  already_in_status: 'Jira issue was already in the done status',
  not_configured: 'No Jira done status is configured',
  skipped: 'Jira issue left unchanged',
};

function commentLine(kind: 'Done' | 'Failure', comment: AgentRunJiraComment | undefined): JiraLine | null {
  if (!comment) return null;
  switch (comment.state) {
    case 'posted':
      return { text: `${kind} comment posted on Jira`, warning: false };
    case 'skipped':
      return {
        text: `${kind} comment skipped: ${comment.reason ?? 'the issue moved out of the configured projects'}`,
        warning: false,
      };
    case 'not_posted':
      return { text: `${kind} comment not posted on Jira: ${comment.reason ?? 'Jira kept failing.'}`, warning: true };
    default:
      return {
        text:
          comment.attempts > 0
            ? `${kind} comment pending (attempt ${comment.attempts + 1})`
            : `${kind} comment pending`,
        warning: false,
      };
  }
}

export function jiraOutcomeLines(outcome: AgentRunJiraOutcome | undefined): JiraLine[] {
  const transition = outcome?.transition;
  return [
    commentLine('Done', outcome?.done),
    transition
      ? transition.outcome === 'warning'
        ? { text: `Jira transition warning: ${transition.reason ?? 'the issue could not be moved.'}`, warning: true }
        : TRANSITION_TEXT[transition.outcome]
          ? { text: TRANSITION_TEXT[transition.outcome]!, warning: false }
          : null
      : null,
    commentLine('Failure', outcome?.failure),
  ].filter((line): line is JiraLine => line !== null);
}

function resultPoints(run: AgentRunDetail, event: AgentRunEvent | undefined): string[] {
  const reported = Array.isArray(event?.payload?.points)
    ? event.payload.points.filter((point): point is string => typeof point === 'string')
    : null;
  const points =
    reported ?? (run.result?.repositories ?? []).map((repository) => `${repository.key}: ${repository.summary}`);
  for (const repository of run.repositories ?? []) {
    if (repository.notBuiltOrTested && !reported) {
      points.push(`${repository.key}: not built or tested in the runner (${repository.notBuiltOrTested})`);
    }
    if (repository.withheldPaths?.length) {
      points.push(`${repository.key}: left out of the push: ${repository.withheldPaths.join(', ')}`);
    }
  }
  return points;
}

/** The run is polled and the version list is not, so the run's copy of the latest spec wins. */
export function specVersions(run: Pick<AgentRunDetail, 'latestSpec'>, specs: readonly AgentRunSpec[]): AgentRunSpec[] {
  const byVersion = new Map(specs.map((spec) => [spec.version, spec]));
  if (run.latestSpec) byVersion.set(run.latestSpec.version, run.latestSpec);
  return [...byVersion.values()].sort((a, b) => a.version - b.version);
}

const latest = (values: Array<string | null | undefined>): string | null =>
  values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

export function conversationItems(
  run: AgentRunDetail,
  specs: readonly AgentRunSpec[],
  turns: readonly AgentRunTurnActivity[],
  events: readonly AgentRunEvent[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  const startedAt = run.startedAt ?? run.createdAt;
  items.push({ kind: 'started', id: 'started', at: startedAt, text: TRIGGER_TEXT[run.trigger] ?? 'Started' });

  const versions = specVersions(run, specs);
  const newest = versions.at(-1)?.version;
  for (const spec of versions) {
    items.push({
      kind: 'proposal',
      id: `spec-${spec.version}`,
      at: spec.proposedAt,
      spec,
      reviewable: run.status === 'awaiting_scope_acceptance' && spec.status === 'proposed' && spec.version === newest,
    });
    if (spec.status === 'changes_requested' && spec.reviewText) {
      items.push({ kind: 'review', id: `review-${spec.version}`, at: spec.reviewedAt ?? spec.proposedAt, spec });
    }
    if (spec.status === 'accepted') {
      items.push({ kind: 'accepted', id: `accepted-${spec.version}`, at: spec.reviewedAt ?? spec.proposedAt, spec });
    }
  }

  for (const question of run.questions ?? []) {
    items.push({
      kind: 'question',
      id: `question-${question.requestId}`,
      at: question.askedAt,
      question,
      open: question.state === 'open' && run.status === 'awaiting_answer',
    });
  }

  for (const event of events) {
    if (event.type !== 'run_event' || event.payload?.code !== 'workflow_diff_withheld') continue;
    items.push({
      kind: 'withheld',
      id: `withheld-${event.seq}`,
      at: event.createdAt,
      text: text(event.payload.text) ?? 'Workflow changes were withheld from the push for a person to apply',
      paths: Array.isArray(event.payload.paths)
        ? event.payload.paths.filter((path): path is string => typeof path === 'string')
        : [],
      diff: text(event.payload.diff),
      note: text(event.payload.note) ?? (event.truncated ? 'The diff was too large to keep.' : null),
    });
  }

  const pulls = run.pullRequests ?? [];
  if (run.result) {
    const resultEvent = [...events].reverse().find((event) => event.type === 'result');
    const lastImplement = [...turns].reverse().find((turn) => turn.kind === 'implement');
    items.push({
      kind: 'result',
      id: 'result',
      at: resultEvent?.createdAt ?? lastImplement?.endedAt ?? run.finishedAt ?? startedAt,
      result: run.result,
      points: resultPoints(run, resultEvent),
      pulls,
    });
  }

  const lines = jiraOutcomeLines(run.jiraOutcome);
  if (pulls.length > 0 || lines.length > 0) {
    items.push({
      kind: 'delivery',
      id: 'delivery',
      at: latest(pulls.map((pull) => pull.verifiedAt)) ?? run.finishedAt ?? startedAt,
      pulls,
      lines,
    });
  }

  if (run.finishedAt && (run.status === 'failed' || run.status === 'cancelled' || run.status === 'done')) {
    items.push({
      kind: 'ended',
      id: 'ended',
      at: run.finishedAt,
      status: run.status,
      text:
        run.status === 'failed'
          ? `Failed${run.failureCode ? ` (${run.failureCode})` : ''}${run.failureReason ? `: ${run.failureReason}` : ''}`
          : run.status === 'cancelled'
            ? `Cancelled${run.failureReason ? `: ${run.failureReason}` : ''}`
            : 'Done',
    });
  }

  // Last, so a decision and the turn it starts at the same moment read in that order.
  for (const turn of turns) {
    if (turn.startedAt) items.push({ kind: 'turn', id: `turn-${turn.id}`, at: turn.startedAt, turn });
  }

  // Stable: items at the same moment keep the order above.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
    .map(({ item }) => item);
}

export function stageTarget(stage: RunStage, items: readonly ConversationItem[]): string | null {
  const end = stage.endedAt ?? '￿';
  const inside = items.filter((item) => item.at >= stage.startedAt && item.at <= end && item.kind !== 'turn');
  return inside.at(-1)?.id ?? items.find((item) => item.at >= stage.startedAt)?.id ?? null;
}
