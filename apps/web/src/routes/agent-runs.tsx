import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '@/api/client';
import { agentRunsQueryOptions, startAgentRun } from '@/api/queries/agent-runs';
import { meQueryOptions } from '@/api/queries/me';
import { EmptyNote } from '@/components/empty-note';
import { PageHead } from '@/components/page-head';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { statusLabel, statusTone, waitingForRunnerSince } from '@/features/agent-runs/agent-run-presentation';
import { Table, Td, Th, Tr } from '@/features/teams/table';
import { formatRelativeTime } from '@/lib/time';

import { findWorkspace } from './workspace';

const ERROR_CLASS = 'text-[13px] text-danger-text';

const TRIGGER_LABELS: Record<string, string> = { jira_label: 'Jira label', manual: 'Manual', rerun: 'Re-run' };

function StartRunCard({ wsId, slug }: { wsId: string; slug: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [issueKey, setIssueKey] = useState('');
  const mutation = useMutation({
    mutationFn: startAgentRun,
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ['ws', wsId, 'agent-runs', 'list'] });
      void navigate({ to: '/w/$slug/agent-runs/$runId', params: { slug, runId: run.id } });
    },
  });

  return (
    <Card>
      <CardHead title="Start a run" sub="The agent scopes the Jira issue, then waits for your review" />
      <CardBody className="pt-2">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const key = issueKey.trim().toUpperCase();
            if (key) mutation.mutate({ wsId, issueKey: key });
          }}
        >
          <div className="flex min-w-[200px] flex-col gap-1.5">
            <Label htmlFor="agent-run-issue">Jira issue key</Label>
            <Input
              id="agent-run-issue"
              value={issueKey}
              placeholder="PROJ-123"
              onChange={(event) => setIssueKey(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={mutation.isPending || issueKey.trim() === ''}>
            {mutation.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </form>
        {mutation.error && (
          <p className={`mt-2 ${ERROR_CLASS}`}>
            {mutation.error instanceof ApiError ? mutation.error.message : 'Failed to start the run'}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

export function WorkspaceAgentRuns() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = slug ? findWorkspace(me, slug) : undefined;
  const runs = useQuery({ ...agentRunsQueryOptions(workspace?.id ?? ''), enabled: Boolean(workspace) });
  // Unreachable in practice: the parent route redirects an unknown slug.
  if (!workspace || !slug) return null;

  return (
    <div className="flex flex-col gap-4">
      <PageHead title="Agent runs" sub="Jira issues taken to draft pull requests by your agent runner" />
      <StartRunCard wsId={workspace.id} slug={slug} />
      <Card>
        <CardHead title="Runs" sub="Newest first" />
        <CardBody className="pt-2">
          <QueryBoundary query={runs}>
            {(data) =>
              data.runs.length === 0 ? (
                <EmptyNote>No agent runs yet.</EmptyNote>
              ) : (
                <Table minWidth={640}>
                  <thead>
                    <tr>
                      <Th>Issue</Th>
                      <Th>Status</Th>
                      <Th>Trigger</Th>
                      <Th>Acts as</Th>
                      <Th>Created</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.map((run) => {
                      const waiting = waitingForRunnerSince(run);
                      return (
                        <Tr key={run.id}>
                          <Td className="text-left">
                            <Link
                              to="/w/$slug/agent-runs/$runId"
                              params={{ slug, runId: run.id }}
                              className="font-mono text-ink-1 hover:underline"
                            >
                              {run.issueKey}
                            </Link>
                          </Td>
                          <Td>
                            <span className="inline-flex items-center gap-1.5">
                              <Badge variant={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
                              {waiting && <span className="text-[12px] text-ink-4">waiting for a runner</span>}
                            </span>
                          </Td>
                          <Td>{TRIGGER_LABELS[run.trigger] ?? run.trigger}</Td>
                          <Td>{run.runOwner.email ?? run.runOwner.userId}</Td>
                          <Td>{formatRelativeTime(run.createdAt)}</Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              )
            }
          </QueryBoundary>
        </CardBody>
      </Card>
    </div>
  );
}
