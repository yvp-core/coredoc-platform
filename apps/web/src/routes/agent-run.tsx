import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';

import { ApiError } from '@/api/client';
import {
  agentRunQueryOptions,
  agentRunTimelineQueryOptions,
  cancelAgentRun,
  rerunAgentRun,
} from '@/api/queries/agent-runs';
import { meQueryOptions } from '@/api/queries/me';
import { EmptyNote } from '@/components/empty-note';
import { PageHead } from '@/components/page-head';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import {
  currentTasks,
  isTerminalStatus,
  phaseLabel,
  spendText,
  statusLabel,
  statusTone,
  TASK_STATUS_LABELS,
  timelineItems,
  waitingForRunnerSince,
} from '@/features/agent-runs/agent-run-presentation';
import { Assumptions, QuestionCard } from '@/features/agent-runs/QuestionCard';
import { RunPullRequests } from '@/features/agent-runs/RunPullRequests';
import { RunRepositories } from '@/features/agent-runs/RunRepositories';
import { ScopeReview } from '@/features/agent-runs/ScopeReview';
import type { AgentRun, AgentRunDetail } from '@/features/agent-runs/types';
import { formatRelativeTime } from '@/lib/time';

import { findWorkspace } from './workspace';

const TRIGGER_LABELS: Record<string, string> = { jira_label: 'Jira label', manual: 'Manual', rerun: 'Re-run' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{label}</dt>
      <dd className="text-[13.5px] text-ink-2">{children}</dd>
    </div>
  );
}

/** A terminal run can be re-run: a new run for the same issue, which opens at once. */
function RerunAction({ wsId, slug, run }: { wsId: string; slug: string; run: AgentRun }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: rerunAgentRun,
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
      void navigate({ to: '/w/$slug/agent-runs/$runId', params: { slug, runId: next.id } });
    },
  });
  if (!isTerminalStatus(run.status)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ wsId, runId: run.id })}
      >
        {mutation.isPending ? 'Starting…' : 'Re-run'}
      </Button>
      {mutation.error && (
        <span className="text-[13px] text-danger-text">
          {mutation.error instanceof ApiError ? mutation.error.message : 'Failed to re-run'}
        </span>
      )}
    </div>
  );
}

/**
 * Any member can cancel a run that has not ended, after confirming: its turn
 * is abandoned and a runner working on it stops at its next heartbeat.
 */
function CancelAction({ wsId, run }: { wsId: string; run: AgentRun }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: cancelAgentRun,
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', run.id] });
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
    },
  });
  if (isTerminalStatus(run.status)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <span className="text-[13px] text-ink-2">Cancel this run? Work already pushed stays on its branches.</span>
          <Button
            size="sm"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate({ wsId, runId: run.id })}
          >
            {mutation.isPending ? 'Cancelling…' : 'Confirm cancel'}
          </Button>
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={() => setConfirming(false)}>
            Keep running
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          Cancel run
        </Button>
      )}
      {mutation.error && (
        <span className="text-[13px] text-danger-text">
          {mutation.error instanceof ApiError ? mutation.error.message : 'Failed to cancel'}
        </span>
      )}
    </div>
  );
}

function JiraLink({ run }: { run: AgentRunDetail }) {
  if (!run.issueUrl) return null;
  return (
    <a
      href={run.issueUrl}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${run.issueKey} in Jira`}
      className="hover:underline"
    >
      Open in Jira
    </a>
  );
}

function RunHeader({ wsId, slug, run }: { wsId: string; slug: string; run: AgentRun }) {
  const waiting = waitingForRunnerSince(run);
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <RerunAction wsId={wsId} slug={slug} run={run} />
        <CancelAction wsId={wsId} run={run} />
        {waiting && (
          <p className="rounded-lg bg-warn-wash px-3 py-2 text-[13px] text-warn-text">
            Waiting for an agent runner since {formatRelativeTime(waiting)}.
          </p>
        )}
        {run.failureReason && (
          <p className="rounded-lg bg-danger-wash px-3 py-2 text-[13px] text-danger-text">
            {run.failureCode ? `${run.failureCode}: ` : ''}
            {run.failureReason}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Acts as">{run.runOwner.email ?? run.runOwner.userId}</Field>
          <Field label="Trigger">{TRIGGER_LABELS[run.trigger] ?? run.trigger}</Field>
          <Field label="Spend">{spendText(run.spend)}</Field>
          <Field label="Questions">{run.questionsPolicy}</Field>
          <Field label="Scope acceptance">{run.scopeAcceptancePolicy}</Field>
          <Field label="Branch">
            <span className="font-mono text-[12.5px]">{run.branch}</span>
          </Field>
          <Field label="Model">{run.model ?? 'Claude Code default'}</Field>
          {run.seeds.length > 0 && (
            <Field label="Seed repositories">
              <span className="font-mono text-[12.5px]">{run.seeds.join(', ')}</span>
            </Field>
          )}
          {run.previousRunId && (
            <Field label="Re-run of">
              <Link
                to="/w/$slug/agent-runs/$runId"
                params={{ slug, runId: run.previousRunId }}
                className="hover:underline"
              >
                Previous run
              </Link>
            </Field>
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

const TASK_MARKERS = { completed: 'bg-brand', in_progress: 'bg-blue', pending: 'border border-border-soft' } as const;

/** The agent's current tasks, from the latest todos event of the timeline. */
function RunTasks({ wsId, run }: { wsId: string; run: AgentRun }) {
  const queryClient = useQueryClient();
  const timeline = useQuery(agentRunTimelineQueryOptions(queryClient, wsId, run.id, run.status));
  const tasks = currentTasks(timeline.data ?? []);
  if (tasks.length === 0) return null;
  return (
    <Card>
      <CardHead title="Agent tasks" sub="The agent’s own checklist, as it last reported it" />
      <CardBody className="pt-2">
        <ul aria-label="Agent tasks" className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li key={`${task.status}:${task.text}`} className="flex items-start gap-2 text-[13.5px] text-ink-2">
              <span aria-hidden className={`mt-[5px] size-2.5 shrink-0 rounded-full ${TASK_MARKERS[task.status]}`} />
              <span className="sr-only">{TASK_STATUS_LABELS[task.status]}: </span>
              <span className={task.status === 'completed' ? 'text-ink-4 line-through' : undefined}>{task.text}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function Timeline({ wsId, run }: { wsId: string; run: AgentRun }) {
  const queryClient = useQueryClient();
  const timeline = useQuery(agentRunTimelineQueryOptions(queryClient, wsId, run.id, run.status));
  return (
    <Card>
      <CardHead title="Timeline" sub="Updates every few seconds while the run is active" />
      <CardBody className="pt-2">
        <QueryBoundary query={timeline}>
          {(events) =>
            events.length === 0 ? (
              <EmptyNote>Nothing has happened yet.</EmptyNote>
            ) : (
              <ol aria-label="Timeline" className="flex flex-col gap-1.5">
                {timelineItems(events).map((item) =>
                  item.kind === 'raw' ? (
                    <li key={item.seq} className="text-[13px] text-ink-3">
                      <details>
                        <summary className="cursor-pointer">Agent activity ({item.lines.length})</summary>
                        <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[12px] text-ink-3">
                          {item.lines.join('\n')}
                        </pre>
                      </details>
                    </li>
                  ) : item.kind === 'diff' ? (
                    <li key={item.seq} className="text-[13.5px] text-ink-2">
                      <details>
                        <summary className="cursor-pointer">{item.text}</summary>
                        <p className="mt-1 font-mono text-[12px] text-ink-3">{item.paths.join(', ')}</p>
                        {item.diff ? (
                          <pre className="mt-1 overflow-x-auto whitespace-pre rounded-lg bg-surface-2 p-2 font-mono text-[12px] text-ink-3">
                            {item.diff}
                          </pre>
                        ) : (
                          item.note && <p className="mt-1 text-[12.5px] text-ink-4">{item.note}</p>
                        )}
                      </details>
                    </li>
                  ) : (
                    <li key={item.seq} className="text-[13.5px] text-ink-2">
                      {item.text}
                    </li>
                  ),
                )}
              </ol>
            )
          }
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}

export function WorkspaceAgentRun() {
  const { slug, runId } = useParams({ from: '/w/$slug/agent-runs/$runId' });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = findWorkspace(me, slug);
  const run = useQuery({ ...agentRunQueryOptions(workspace?.id ?? '', runId), enabled: Boolean(workspace) });
  if (!workspace) return null;

  return (
    <div className="flex flex-col gap-4">
      <QueryBoundary query={run}>
        {(data) => (
          <>
            <PageHead
              title={data.issueKey}
              sub={
                <>
                  <Badge variant={statusTone(data.status)}>{statusLabel(data.status)}</Badge>
                  <Badge variant="neutral">{phaseLabel(data.phase)}</Badge>
                  <JiraLink run={data} />
                  <Link to="/w/$slug/agent-runs" params={{ slug }} className="hover:underline">
                    All agent runs
                  </Link>
                </>
              }
            />
            <RunHeader wsId={workspace.id} slug={slug} run={data} />
            <QuestionCard wsId={workspace.id} run={data} />
            <ScopeReview wsId={workspace.id} run={data} />
            <RunRepositories run={data} />
            <RunPullRequests run={data} />
            <Assumptions run={data} />
            <RunTasks wsId={workspace.id} run={data} />
            <Timeline wsId={workspace.id} run={data} />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
