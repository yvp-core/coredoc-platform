import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { defaultRetryDelay, type RetryDelay } from '@coredoc/core/agent-runner';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import {
  JiraApiError,
  JiraAuthError,
  type JiraClient,
  JiraNotFoundError,
  JiraRateLimitError,
} from '../delivery/jira-client.js';
import { recordedPullRequests } from './cloud-agent-run-delivery.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';
import { FAILURE_MESSAGES } from './failure-codes.js';
import { type CommentPullRequest, commentHasMarker, doneComment, failureComment, runMarker } from './jira-comments.js';
import {
  type JiraCommentOutcome,
  jiraOutcomeOf,
  queueStatusTransition,
  type RunJiraOutcome,
  StatusEvent,
  type StatusTransitionOutcome,
  sameStatusName,
  transitionTo,
} from './jira-outcome.js';
import { CLOUD_AGENT_RUNS_RETRY_DELAY, withRetries } from './retry.js';
import { runPageUrl } from './run-links.js';
import { fromColumn, RunEventCode, RunFailureCode, RunStatus, ServerEventType } from './run-states.js';
import {
  appendRunEvents,
  CLOUD_AGENT_RUNS_CLOCK,
  type Clock,
  type NewRunEvent,
  systemClock,
  type Tx,
} from './run-store.js';
import { failRun, lockRun, markRunDone } from './run-transitions.js';

const BATCH = 20;
/** A claimed comment is re-claimable after this, as the intent handoff cron does. */
const CLAIM_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

type CommentKind = 'done' | 'failure';

/** Started before the end-of-run events, so one tick never leaves the issue in the started status. */
const STATUS_EVENTS: readonly StatusEvent[] = [StatusEvent.Started, StatusEvent.Cancelled, StatusEvent.Failed];

const MOVED_OUT = 'The issue moved out of the configured projects.';

const MARKER_UNKNOWN =
  'The issue has too many comments for Coredoc to check whether it already posted this one, so it posted none.';

class ConnectorUnavailable extends Error {}

function transientJira(error: unknown): { retryAfterMs: number | null } | false {
  if (error instanceof JiraRateLimitError) return { retryAfterMs: error.retryAfterMs };
  if (error instanceof JiraApiError)
    return error.status >= 500 || error.status === 408 ? { retryAfterMs: null } : false;
  if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) {
    return { retryAfterMs: null };
  }
  return false;
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof ConnectorUnavailable ||
    error instanceof JiraAuthError ||
    error instanceof JiraNotFoundError ||
    (error instanceof JiraApiError && error.status < 500 && error.status !== 408)
  );
}

/** Server-written; never a provider body. */
function describe(error: unknown): string {
  if (error instanceof ConnectorUnavailable) return error.message;
  if (error instanceof JiraAuthError) return 'Jira refused the connector’s credentials or permissions.';
  if (error instanceof JiraNotFoundError)
    return 'Jira could not find the issue, or the connector’s user cannot see it.';
  if (error instanceof JiraApiError) return `Jira answered ${error.status}.`;
  if (error instanceof JiraRateLimitError) return 'Jira kept rate limiting the connector.';
  return 'Jira could not be reached.';
}

interface IssueTarget {
  client: JiraClient;
  status: string | null;
}

/**
 * Only server-owned facts reach Jira: fixed messages, verified pull requests
 * and the run link. A run marker on each comment keeps a retry after a crash
 * to one comment.
 */
@Injectable()
export class CloudAgentRunJiraOutcomes {
  private readonly logger = new Logger(CloudAgentRunJiraOutcomes.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: CloudAgentRunJiraConnector,
    @Optional() @Inject(CLOUD_AGENT_RUNS_RETRY_DELAY) private readonly retryDelay: RetryDelay = defaultRetryDelay,
    @Optional() @Inject(CLOUD_AGENT_RUNS_CLOCK) private readonly now: Clock = systemClock,
  ) {}

  /** Delivered runs: one done comment, then the configured transition, and only then `done`. */
  async postDoneComments(): Promise<void> {
    const at = this.now();
    const due = await this.prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
      WITH due AS (
        SELECT id FROM cloud_agent_runs
        WHERE status = ${RunStatus.Delivering}
          AND jira_outcome->'done'->>'state' = 'pending'
          AND (jira_outcome->'done'->>'nextAttemptAt')::timestamptz <= ${at}
        ORDER BY created_at, id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE cloud_agent_runs r
      SET jira_outcome = jsonb_set(r.jira_outcome, '{done,nextAttemptAt}',
                                   to_jsonb(${new Date(at.getTime() + CLAIM_MS).toISOString()}::text))
      FROM due WHERE r.id = due.id
      RETURNING r.id, r.workspace_id`;
    for (const row of due) {
      try {
        await this.postDone(row.workspace_id, row.id);
      } catch (error) {
        this.logger.error(`Could not settle the done comment of run ${row.id}: ${(error as Error).message}`);
      }
    }
  }

  async postFailureComments(): Promise<void> {
    const at = this.now();
    const due = await this.prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
      WITH due AS (
        SELECT id FROM cloud_agent_runs
        WHERE status = ${RunStatus.Failed}
          AND COALESCE(jira_outcome->'failure'->>'state', 'pending') = 'pending'
          AND COALESCE((jira_outcome->'failure'->>'nextAttemptAt')::timestamptz, '-infinity'::timestamptz) <= ${at}
        ORDER BY created_at, id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE cloud_agent_runs r
      SET jira_outcome = jsonb_set(
        r.jira_outcome, '{failure}',
        COALESCE(r.jira_outcome->'failure', '{"state":"pending","attempts":0}'::jsonb)
          || jsonb_build_object('nextAttemptAt', ${new Date(at.getTime() + CLAIM_MS).toISOString()}::text))
      FROM due WHERE r.id = due.id
      RETURNING r.id, r.workspace_id`;
    for (const row of due) {
      try {
        await this.postFailure(row.workspace_id, row.id);
      } catch (error) {
        this.logger.error(`Could not settle the failure comment of run ${row.id}: ${(error as Error).message}`);
      }
    }
  }

  /** A transition never changes the run's outcome: problems end as warnings on the run. */
  async applyStatusTransitions(): Promise<void> {
    for (const event of STATUS_EVENTS) {
      const at = this.now();
      const due = await this.prisma.$queryRaw<Array<{ id: string; workspace_id: string }>>`
        WITH due AS (
          SELECT id FROM cloud_agent_runs
          WHERE jira_outcome->'transitions'->${event}::text->>'state' = 'pending'
            AND (jira_outcome->'transitions'->${event}::text->>'nextAttemptAt')::timestamptz <= ${at}
          ORDER BY created_at, id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE cloud_agent_runs r
        SET jira_outcome = jsonb_set(r.jira_outcome, ARRAY['transitions', ${event}::text, 'nextAttemptAt'],
                                     to_jsonb(${new Date(at.getTime() + CLAIM_MS).toISOString()}::text))
        FROM due WHERE r.id = due.id
        RETURNING r.id, r.workspace_id`;
      for (const row of due) {
        try {
          await this.applyStatusTransition(row.workspace_id, row.id, event);
        } catch (error) {
          this.logger.error(`Could not settle the ${event} transition of run ${row.id}: ${(error as Error).message}`);
        }
      }
    }
  }

  /** A crash after Jira moved the issue is retried and ends in the already-in-status skip. */
  private async applyStatusTransition(workspaceId: string, runId: string, event: StatusEvent): Promise<void> {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId } });
    const queued = run ? jiraOutcomeOf(run).transitions?.[event] : undefined;
    if (!run || queued?.state !== 'pending') return;
    const status = queued.status;
    try {
      const target = await this.issueTarget(run);
      if (!target) {
        await this.settleTransition(run, event, { state: 'skipped', reason: MOVED_OUT }, [
          warning(`The issue moved out of the configured projects, so it was not moved to ${status}.`),
        ]);
        return;
      }
      if (sameStatusName(target.status, status)) {
        await this.settleTransition(run, event, { state: 'already_in_status' }, [
          {
            type: ServerEventType.RunEvent,
            payload: { code: RunEventCode.TransitionSkipped, text: `The issue is already in ${status}` },
          },
        ]);
        return;
      }
      const chosen = transitionTo(await this.retry(() => target.client.listTransitions(run.jiraIssueId)), status);
      if (!chosen) {
        const reason = `No transition to ${status} is available for the issue.`;
        await this.settleTransition(run, event, { state: 'warning', reason }, [warning(reason)]);
        return;
      }
      await this.retry(() => target.client.transitionIssue(run.jiraIssueId, chosen.id));
      await this.settleTransition(run, event, { state: 'transitioned' }, [
        {
          type: ServerEventType.RunEvent,
          payload: { code: RunEventCode.JiraTransitioned, text: `Moved the Jira issue to ${status}` },
        },
      ]);
    } catch (error) {
      await this.recordFailedTransition(run, event, error);
    }
  }

  private async settleTransition(
    run: CloudAgentRun,
    event: StatusEvent,
    patch: Pick<StatusTransitionOutcome, 'state' | 'reason'>,
    events: NewRunEvent[],
  ): Promise<void> {
    const at = this.now();
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      const queued = current?.transitions?.[event];
      if (!locked || !current || queued?.state !== 'pending') return;
      await this.writeTransition(tx, locked, current, event, { ...queued, ...patch, nextAttemptAt: null });
      await appendRunEvents(tx, { workspaceId: locked.workspaceId, runId: locked.id }, events, at);
    });
  }

  private async recordFailedTransition(run: CloudAgentRun, event: StatusEvent, error: unknown): Promise<void> {
    const at = this.now();
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      const queued = current?.transitions?.[event];
      if (!locked || !current || queued?.state !== 'pending') return;
      const attempts = queued.attempts + 1;
      const reason = `The issue could not be moved to ${queued.status}: ${describe(error)}`;
      if (!isPermanent(error) && attempts < MAX_ATTEMPTS) {
        await this.writeTransition(tx, locked, current, event, { ...queued, attempts, reason });
        return;
      }
      await this.writeTransition(tx, locked, current, event, {
        ...queued,
        state: 'warning',
        attempts,
        nextAttemptAt: null,
        reason,
      });
      await appendRunEvents(tx, { workspaceId: locked.workspaceId, runId: locked.id }, [warning(reason)], at);
    });
  }

  private async writeTransition(
    tx: Tx,
    run: CloudAgentRun,
    current: RunJiraOutcome,
    event: StatusEvent,
    next: StatusTransitionOutcome,
  ): Promise<void> {
    await tx.cloudAgentRun.update({
      where: { id: run.id },
      data: {
        jiraOutcome: {
          ...current,
          transitions: { ...current.transitions, [event]: next },
        } as unknown as Prisma.InputJsonObject,
      },
    });
  }

  private async postDone(workspaceId: string, runId: string): Promise<void> {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId } });
    const outcome = run ? jiraOutcomeOf(run).done : undefined;
    if (!run || run.status !== RunStatus.Delivering || outcome?.state !== 'pending') return;
    try {
      const target = await this.issueTarget(run);
      if (!target) {
        await this.finishDone(
          run,
          { state: 'skipped', reason: MOVED_OUT },
          {
            outcome: 'skipped',
            reason: MOVED_OUT,
          },
        );
        return;
      }
      let commentId = outcome.commentId ?? null;
      if (!commentId) {
        const runUrl = await runPageUrl(this.prisma, run.workspaceId, run.id);
        commentId = await this.postOnce(target.client, run, runMarker(run.id, 'done'), (marker) =>
          doneComment({ pullRequests: this.commentPulls(run), runUrl, marker }),
        );
        if (!commentId) {
          await this.finishDone(run, { state: 'skipped', reason: MARKER_UNKNOWN }, await this.transition(target, run));
          return;
        }
        // Kept before the transition: a crash between the two never posts again.
        await this.patch(run, 'done', { commentId });
      }
      await this.finishDone(run, { state: 'posted', commentId }, await this.transition(target, run));
    } catch (error) {
      await this.recordFailedAttempt(run, 'done', error);
    }
  }

  private async postFailure(workspaceId: string, runId: string): Promise<void> {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId } });
    const state = run ? (jiraOutcomeOf(run).failure?.state ?? 'pending') : null;
    if (!run || run.status !== RunStatus.Failed || state !== 'pending') return;
    try {
      const target = await this.issueTarget(run);
      if (!target) {
        await this.settle(run, 'failure', { state: 'skipped', reason: MOVED_OUT }, [
          warning('The issue moved out of the configured projects, so no failure comment was posted.'),
        ]);
        return;
      }
      const runUrl = await runPageUrl(this.prisma, run.workspaceId, run.id);
      const message = run.failureCode
        ? FAILURE_MESSAGES[fromColumn(RunFailureCode, run.failureCode)]
        : 'The run failed; the run page says why.';
      const commentId = await this.postOnce(target.client, run, runMarker(run.id, 'failure'), (marker) =>
        failureComment({ message, pullRequests: this.commentPulls(run), runUrl, marker }),
      );
      if (!commentId) {
        await this.settle(run, 'failure', { state: 'skipped', reason: MARKER_UNKNOWN }, [warning(MARKER_UNKNOWN)]);
        return;
      }
      await this.settle(run, 'failure', { state: 'posted', commentId }, [
        commented('Posted the failure comment on Jira'),
      ]);
    } catch (error) {
      await this.recordFailedAttempt(run, 'failure', error);
    }
  }

  private commentPulls(run: CloudAgentRun): CommentPullRequest[] {
    return recordedPullRequests(run).map(({ repository, number, url }) => ({ repository, number, url }));
  }

  /** The issue as Jira has it now, or null when it moved out of the configured projects. */
  private async issueTarget(run: CloudAgentRun): Promise<IssueTarget | null> {
    const state = await this.connector.state(run.workspaceId);
    if (state.status !== 'active')
      throw new ConnectorUnavailable('The workspace’s Jira connector is missing or paused.');
    let client: JiraClient;
    try {
      client = this.connector.client(state.connector);
    } catch {
      throw new ConnectorUnavailable('The workspace’s Jira connector has unusable credentials.');
    }
    const issue = await this.retry(() => client.getIssue(run.jiraIssueId, ['project', 'status']));
    const fields = (issue.fields ?? {}) as { project?: { key?: unknown }; status?: { name?: unknown } };
    if (typeof fields.project?.key !== 'string' || !state.projectKeys.includes(fields.project.key)) return null;
    return { client, status: typeof fields.status?.name === 'string' ? fields.status.name : null };
  }

  /**
   * Reuses a comment carrying the marker (a crash after Jira accepted it). Null
   * when the listing hit its cap without the marker: posting could duplicate it.
   */
  private postOnce(
    client: JiraClient,
    run: CloudAgentRun,
    marker: string,
    build: (marker: string) => unknown,
  ): Promise<string | null> {
    return this.retry(async () => {
      const listed = await client.listComments(run.jiraIssueId);
      const existing = listed.comments.find((comment) => commentHasMarker(comment.body, marker));
      if (existing) return existing.id;
      if (!listed.complete) return null;
      return (await client.addComment(run.jiraIssueId, build(marker))).id;
    });
  }

  /** Never fails the run: problems after the done comment are recorded as warnings. */
  private async transition(
    target: IssueTarget,
    run: CloudAgentRun,
  ): Promise<NonNullable<RunJiraOutcome['transition']>> {
    const settings = await this.prisma.agentRunSettings.findUnique({ where: { workspaceId: run.workspaceId } });
    const status = settings?.doneStatus;
    if (!status) return { outcome: 'not_configured' };
    if (sameStatusName(target.status, status)) return { outcome: 'already_in_status' };
    try {
      const chosen = transitionTo(await this.retry(() => target.client.listTransitions(run.jiraIssueId)), status);
      if (!chosen) return { outcome: 'warning', reason: `No transition to ${status} is available for the issue.` };
      await this.retry(() => target.client.transitionIssue(run.jiraIssueId, chosen.id));
      return { outcome: 'transitioned' };
    } catch (error) {
      return { outcome: 'warning', reason: `The issue could not be moved to ${status}: ${describe(error)}` };
    }
  }

  private async finishDone(
    run: CloudAgentRun,
    done: Partial<JiraCommentOutcome>,
    transition: NonNullable<RunJiraOutcome['transition']>,
  ): Promise<void> {
    const at = this.now();
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      if (!locked || locked.status !== RunStatus.Delivering || current?.done?.state !== 'pending') return;
      const events: NewRunEvent[] = [];
      if (done.state === 'posted') events.push(commented('Posted the done comment on Jira'));
      else if (done.reason === MARKER_UNKNOWN) events.push(warning(MARKER_UNKNOWN));
      else events.push(warning('The issue moved out of the configured projects, so Jira was left unchanged.'));
      if (transition.outcome === 'warning') events.push(warning(transition.reason ?? 'The Jira transition failed.'));
      else if (transition.outcome !== 'transitioned' && done.state === 'posted') {
        events.push({
          type: ServerEventType.RunEvent,
          payload: {
            code: RunEventCode.TransitionSkipped,
            text:
              transition.outcome === 'already_in_status'
                ? 'The issue is already in the done status'
                : 'No done status is configured',
          },
        });
      }
      const jiraOutcome = {
        ...current,
        done: { ...current.done, ...done, nextAttemptAt: null },
        transition,
      };
      await markRunDone(tx, locked, at, { jiraOutcome: jiraOutcome as unknown as Prisma.InputJsonObject }, events);
    });
  }

  private async settle(
    run: CloudAgentRun,
    kind: CommentKind,
    patch: Partial<JiraCommentOutcome>,
    events: NewRunEvent[],
  ): Promise<void> {
    const at = this.now();
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      if (!locked || !current || (current[kind]?.state ?? 'pending') !== 'pending') return;
      const next: RunJiraOutcome = {
        ...current,
        [kind]: { state: 'pending', attempts: 0, ...current[kind], nextAttemptAt: null, ...patch },
      };
      await tx.cloudAgentRun.update({
        where: { id: locked.id },
        data: {
          jiraOutcome: (kind === 'failure'
            ? await this.queueFailedTransition(tx, locked, next, at)
            : next) as unknown as Prisma.InputJsonObject,
        },
      });
      await appendRunEvents(tx, { workspaceId: locked.workspaceId, runId: locked.id }, events, at);
    });
  }

  private async patch(run: CloudAgentRun, kind: CommentKind, patch: Partial<JiraCommentOutcome>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      if (!locked || !current || current[kind]?.state !== 'pending') return;
      await tx.cloudAgentRun.update({
        where: { id: locked.id },
        data: {
          jiraOutcome: { ...current, [kind]: { ...current[kind], ...patch } } as unknown as Prisma.InputJsonObject,
        },
      });
    });
  }

  /** Giving up on the done comment fails the run with `delivery_failed`. */
  private async recordFailedAttempt(run: CloudAgentRun, kind: CommentKind, error: unknown): Promise<void> {
    const at = this.now();
    const reason = describe(error);
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockRun(tx, run.workspaceId, run.id);
      const current = locked ? jiraOutcomeOf(locked) : null;
      const outcome = current?.[kind] ?? { state: 'pending', attempts: 0, nextAttemptAt: null };
      if (!locked || !current || outcome.state !== 'pending') return;
      const attempts = outcome.attempts + 1;
      const giveUp = isPermanent(error) || attempts >= MAX_ATTEMPTS;
      const next: JiraCommentOutcome = giveUp
        ? { ...outcome, state: 'not_posted', attempts, nextAttemptAt: null, reason }
        : { ...outcome, attempts, reason };
      const recorded: RunJiraOutcome = { ...current, [kind]: next };
      const updated = await tx.cloudAgentRun.update({
        where: { id: locked.id },
        data: {
          jiraOutcome: (giveUp && kind === 'failure'
            ? await this.queueFailedTransition(tx, locked, recorded, at)
            : recorded) as unknown as Prisma.InputJsonObject,
        },
      });
      if (!giveUp) return;
      await appendRunEvents(
        tx,
        { workspaceId: locked.workspaceId, runId: locked.id },
        [warning(`The Jira ${kind} comment was not posted: ${reason}`)],
        at,
      );
      if (kind === 'done' && updated.status === RunStatus.Delivering) {
        await failRun(
          tx,
          updated,
          RunFailureCode.DeliveryFailed,
          `The Jira done comment was not posted: ${reason}`,
          at,
        );
      }
    });
  }

  /** Once the failure comment is posted, skipped or given up on, the configured failed status is queued. */
  private async queueFailedTransition(
    tx: Tx,
    run: CloudAgentRun,
    outcome: RunJiraOutcome,
    at: Date,
  ): Promise<RunJiraOutcome> {
    const settings = await tx.agentRunSettings.findUnique({
      where: { workspaceId: run.workspaceId },
      select: { failedStatus: true },
    });
    return queueStatusTransition(outcome, StatusEvent.Failed, settings?.failedStatus, at);
  }

  private retry<T>(call: () => Promise<T>): Promise<T> {
    return withRetries(call, transientJira, this.retryDelay);
  }
}

function warning(text: string): NewRunEvent {
  return { type: ServerEventType.RunEvent, payload: { code: RunEventCode.Warning, text } };
}

function commented(text: string): NewRunEvent {
  return { type: ServerEventType.RunEvent, payload: { code: RunEventCode.JiraCommented, text } };
}
