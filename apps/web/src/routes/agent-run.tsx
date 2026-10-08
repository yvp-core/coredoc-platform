import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';

import { agentRunQueryOptions, agentRunTimelineQueryOptions } from '@/api/queries/agent-runs';
import { meQueryOptions } from '@/api/queries/me';
import { EmptyNote } from '@/components/empty-note';
import { PageHead } from '@/components/page-head';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import {
  spendText,
  statusLabel,
  statusTone,
  timelineItems,
  waitingForRunnerSince,
} from '@/features/agent-runs/agent-run-presentation';
import type { AgentRun } from '@/features/agent-runs/types';
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

function RunHeader({ run }: { run: AgentRun }) {
  const waiting = waitingForRunnerSince(run);
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
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
          <Field label="Phase">{run.phase}</Field>
          <Field label="Acts as">{run.runOwner.email ?? run.runOwner.userId}</Field>
          <Field label="Trigger">{TRIGGER_LABELS[run.trigger] ?? run.trigger}</Field>
          <Field label="Spend">{spendText(run.spend)}</Field>
          <Field label="Questions">{run.questionsPolicy}</Field>
          <Field label="Scope acceptance">{run.scopeAcceptancePolicy}</Field>
          <Field label="Branch">
            <span className="font-mono text-[12.5px]">{run.branch}</span>
          </Field>
          <Field label="Model">{run.model ?? 'Claude Code default'}</Field>
        </dl>
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
                  <Link to="/w/$slug/agent-runs" params={{ slug }} className="hover:underline">
                    All agent runs
                  </Link>
                </>
              }
            />
            <RunHeader run={data} />
            <Timeline wsId={workspace.id} run={data} />
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
