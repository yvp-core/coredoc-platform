import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import type { CloudAgentRun, Prisma } from '../../generated/prisma/client.js';
import {
  JiraApiError,
  JiraAuthError,
  type JiraClient,
  JiraNotFoundError,
  JiraRateLimitError,
} from '../delivery/jira-client.js';
import {
  type JiraCommentOutcome,
  jiraOutcomeOf,
  type RunJiraOutcome,
  recordedPullRequests,
} from './cloud-agent-run-delivery.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira.service.js';
import { FAILURE_MESSAGES, type FailureCode } from './failure-codes.js';
import { type CommentPullRequest, commentHasMarker, doneComment, failureComment, runMarker } from './jira-comments.js';
import { CLOUD_AGENT_RUNS_RETRY_DELAY, defaultRetryDelay, type RetryDelay, withRetries } from './retry.js';
import { runPageUrl } from './run-links.js';
import { RunEventCode, RunFailureCode, RunStatus, ServerEventType } from './run-states.js';
import { appendRunEvents, CLOUD_AGENT_RUNS_CLOCK, type Clock, type NewRunEvent, systemClock } from './run-store.js';
import { failRun, lockRun, markRunDone } from './run-transitions.js';

/** Rows claimed per job and tick. */
const BATCH = 20;
/** A claimed comment is re-claimable after this, as the intent handoff cron does. */
const CLAIM_MS = 5 * 60_000;
/** After this many failed attempts a comment is recorded as not posted. */
const MAX_ATTEMPTS = 5;

type CommentKind = 'done' | 'failure';

/** Why a comment is skipped when the run marker check cannot see every comment. */
const MARKER_UNKNOWN =
  'The issue has too many comments for Coredoc to check whether it already posted this one, so it posted none.';

/** The workspace's Jira connector cannot be used: a permanent failure for the comment. */
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

/** Permanent: retrying cannot help. Anything else counts as one failed attempt. */
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
  statusId: string | null;
}

/**
 * The run sweep's Jira jobs: the done comment and transition for delivered
 * runs, and one failure comment per failed run. Rows are claimed with
 * skip-locked claims and a next-attempt time; a run marker on each comment
 * keeps a retry after a crash to one comment. Only server-owned facts reach
 * Jira: fixed messages, verified pull requests and the run link.
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

  /** Failed runs without a failure comment: one comment each. Cancelled runs get none. */
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

  private async postDone(workspaceId: string, runId: string): Promise<void> {
    const run = await this.prisma.cloudAgentRun.findFirst({ where: { id: runId, workspaceId } });
    const outcome = run ? jiraOutcomeOf(run).done : undefined;
    if (!run || run.status !== RunStatus.Delivering || outcome?.state !== 'pending') return;
    try {
      const target = await this.issueTarget(run);
      if (!target) {
        await this.finishDone(
          run,
          { state: 'skipped', reason: 'The issue moved out of the configured projects.' },
          {
            outcome: 'skipped',
            reason: 'The issue moved out of the configured projects.',
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
        await this.settle(
          run,
          'failure',
          { state: 'skipped', reason: 'The issue moved out of the configured projects.' },
          [warning('The issue moved out of the configured projects, so no failure comment was posted.')],
        );
        return;
      }
      const runUrl = await runPageUrl(this.prisma, run.workspaceId, run.id);
      const message = FAILURE_MESSAGES[run.failureCode as FailureCode] ?? 'The run failed; the run page says why.';
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
    const fields = (issue.fields ?? {}) as { project?: { key?: unknown }; status?: { id?: unknown } };
    if (typeof fields.project?.key !== 'string' || !state.projectKeys.includes(fields.project.key)) return null;
    return { client, statusId: typeof fields.status?.id === 'string' ? fields.status.id : null };
  }

  /**
   * Posts the comment unless one with the marker is already there (a crash
   * after Jira accepted it), and returns its id. A retry looks again first.
   * Null when the listing stopped at its cap without the marker: posting
   * could duplicate a comment, so nothing is posted.
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

  /**
   * The configured transition, preferring one without a screen. Never fails
   * the run: problems after the done comment are recorded as warnings.
   */
  private async transition(
    target: IssueTarget,
    run: CloudAgentRun,
  ): Promise<NonNullable<RunJiraOutcome['transition']>> {
    const settings = await this.prisma.agentRunSettings.findUnique({ where: { workspaceId: run.workspaceId } });
    const statusId = settings?.doneStatusId;
    if (!statusId) return { outcome: 'not_configured' };
    if (target.statusId === statusId) return { outcome: 'already_in_status' };
    const status = settings.doneStatusName ?? statusId;
    try {
      const candidates = (await this.retry(() => target.client.listTransitions(run.jiraIssueId)))
        .filter((transition) => transition.to?.id === statusId)
        .sort((a, b) => Number(Boolean(a.hasScreen)) - Number(Boolean(b.hasScreen)));
      const chosen = candidates[0];
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

  /** Merges into one comment's outcome while it is still pending; adds the events. */
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
      await tx.cloudAgentRun.update({
        where: { id: locked.id },
        data: {
          jiraOutcome: {
            ...current,
            [kind]: { state: 'pending', attempts: 0, ...current[kind], nextAttemptAt: null, ...patch },
          } as unknown as Prisma.InputJsonObject,
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

  /**
   * One failed attempt. A permanent error, or the fifth attempt, records the
   * comment as not posted; for the done comment that fails the run with
   * `delivery_failed`, and its failure comment then lists the pull requests.
   */
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
      const updated = await tx.cloudAgentRun.update({
        where: { id: locked.id },
        data: { jiraOutcome: { ...current, [kind]: next } as unknown as Prisma.InputJsonObject },
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
