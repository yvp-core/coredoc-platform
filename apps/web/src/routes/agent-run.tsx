import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';

import { ApiError } from '@/api/client';
import {
  agentRunActivityQueryOptions,
  agentRunQueryOptions,
  agentRunSpecsQueryOptions,
  agentRunTimelineQueryOptions,
  cancelAgentRun,
  continueAgentRun,
  rerunAgentRun,
} from '@/api/queries/agent-runs';
import { meQueryOptions } from '@/api/queries/me';
import { PageHead } from '@/components/page-head';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  conversationItems,
  type RunStage,
  runSpan,
  runStages,
  stageTarget,
} from '@/features/agent-runs/agent-run-page';
import {
  currentTasks,
  isTerminalStatus,
  phaseLabel,
  spendText,
  statusLabel,
  statusTone,
  waitingForRunnerSince,
} from '@/features/agent-runs/agent-run-presentation';
import { type ActivityDrawer, RunActivityDrawer } from '@/features/agent-runs/RunActivityDrawers';
import { RunConversation } from '@/features/agent-runs/RunConversation';
import { ArtifactCards, StageRail } from '@/features/agent-runs/RunRail';
import type { AgentRun, AgentRunDetail } from '@/features/agent-runs/types';

import { findWorkspace } from './workspace';

const TRIGGER_LABELS: Record<string, string> = { jira_label: 'Jira label', manual: 'Manual', rerun: 'Re-run' };

function Field({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-0.5${wide ? ' col-span-2' : ''}`}>
      <dt className="text-[11.5px] uppercase tracking-[0.04em] text-ink-4">{label}</dt>
      <dd className="break-words text-[13px] text-ink-2">{children}</dd>
    </div>
  );
}

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

function ContinueForm({ wsId, run }: { wsId: string; run: AgentRun }) {
  const queryClient = useQueryClient();
  const textId = useId();
  const [text, setText] = useState('');
  const mutation = useMutation({
    mutationFn: continueAgentRun,
    onSuccess: () => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', run.id] });
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
    },
  });
  if (run.status !== 'failed' && run.status !== 'done') return null;
  const done = run.status === 'done';
  return (
    <form
      aria-label="Continue the run"
      className="flex flex-col gap-2 rounded-xl border border-border-soft p-3"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ wsId, runId: run.id, text: text.trim() });
      }}
    >
      <label htmlFor={textId} className="text-[12.5px] text-ink-3">
        {done ? 'Review feedback for the agent' : 'Message for the agent (optional)'}
      </label>
      <Textarea
        id={textId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={
          done
            ? 'What should change in the pull requests? "Read the PR comments and fix them" works too.'
            : 'Leave empty to continue where it stopped.'
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={mutation.isPending || (done && !text.trim())}>
          {mutation.isPending ? 'Continuing…' : 'Continue'}
        </Button>
        {mutation.error && (
          <span className="text-[13px] text-danger-text">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Failed to continue'}
          </span>
        )}
      </div>
    </form>
  );
}

/** Any member can cancel; a runner working on the run stops at its next heartbeat. */
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

function RunDetails({ run }: { run: AgentRunDetail }) {
  return (
    <dl
      aria-label="Run details"
      className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface px-3 py-3 shadow-card"
    >
      <Field label="Acts as">{run.runOwner.email ?? run.runOwner.userId}</Field>
      <Field label="Trigger">{TRIGGER_LABELS[run.trigger] ?? run.trigger}</Field>
      <Field label="Scope questions">{run.scopeQuestionsPolicy}</Field>
      <Field label="Implement questions">{run.implementQuestionsPolicy}</Field>
      <Field label="Scope acceptance">{run.scopeAcceptancePolicy}</Field>
      <Field label="Model">{run.model ?? 'Claude Code default'}</Field>
      <Field label="Branch">
        <span className="break-all font-mono text-[12px]">{run.branch}</span>
      </Field>
      {run.seeds.length > 0 && (
        <Field label="Seed repositories">
          <span className="font-mono text-[12px]">{run.seeds.join(', ')}</span>
        </Field>
      )}
      {run.notes && (
        <Field label="Notes for the agent" wide>
          <span className="whitespace-pre-wrap">{run.notes}</span>
        </Field>
      )}
    </dl>
  );
}

function RunPage({ wsId, slug, run }: { wsId: string; slug: string; run: AgentRunDetail }) {
  const queryClient = useQueryClient();
  const timeline = useQuery(agentRunTimelineQueryOptions(queryClient, wsId, run.id, run.status));
  const activity = useQuery(agentRunActivityQueryOptions(wsId, run.id, run.status));
  const specs = useQuery(agentRunSpecsQueryOptions(wsId, run.id, run.latestSpec?.version));
  const [drawer, setDrawer] = useState<ActivityDrawer>(null);
  const { refetch } = timeline;
  const shownStatus = useRef(run.status);
  // Polling stops when the run ends; the events written as it ended are read once more.
  useEffect(() => {
    if (shownStatus.current !== run.status && isTerminalStatus(run.status)) void refetch();
    shownStatus.current = run.status;
  }, [run.status, refetch]);

  const now = new Date();
  const events = timeline.data ?? [];
  const turns = activity.data?.turns ?? [];
  const stages = runStages(run, events, now);
  const items = conversationItems(run, specs.data ?? [], turns, events);
  const jump = (stage: RunStage) => {
    const target = stageTarget(stage, items);
    if (target) document.getElementById(`run-${target}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };

  return (
    <>
      <PageHead
        title={run.issueKey}
        sub={
          <>
            <Badge variant={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
            <Badge variant="neutral">{phaseLabel(run.phase)}</Badge>
            <span className="tabular-nums">{spendText(run.spend)}</span>
            {run.previousRunId && (
              <Link
                to="/w/$slug/agent-runs/$runId"
                params={{ slug, runId: run.previousRunId }}
                className="hover:underline"
              >
                Previous run
              </Link>
            )}
            <Link to="/w/$slug/agent-runs" params={{ slug }} className="hover:underline">
              All agent runs
            </Link>
          </>
        }
        right={
          <>
            <CancelAction wsId={wsId} run={run} />
            <RerunAction wsId={wsId} slug={slug} run={run} />
          </>
        }
      />
      <div className="grid items-start gap-5 md:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3 md:sticky md:top-3">
          <StageRail
            stages={stages}
            span={runSpan(run, stages, now)}
            running={!isTerminalStatus(run.status)}
            onJump={jump}
          />
          <ArtifactCards run={run} specs={specs.data ?? []} activity={activity.data} onOpen={setDrawer} />
          <RunDetails run={run} />
        </aside>
        <div className="flex min-w-0 flex-col gap-3">
          <RunConversation
            wsId={wsId}
            run={run}
            items={items}
            tasks={isTerminalStatus(run.status) ? [] : currentTasks(events)}
            waitingSince={waitingForRunnerSince(run)}
            now={now}
            onOpen={setDrawer}
          />
          <ContinueForm wsId={wsId} run={run} />
        </div>
      </div>
      <RunActivityDrawer wsId={wsId} slug={slug} run={run} drawer={drawer} onClose={() => setDrawer(null)} />
    </>
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
      <QueryBoundary query={run}>{(data) => <RunPage wsId={workspace.id} slug={slug} run={data} />}</QueryBoundary>
    </div>
  );
}
