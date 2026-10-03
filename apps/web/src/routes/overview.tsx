import { useQueries, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { jobsQueryOptions } from '@/api/queries/jobs';
import { meQueryOptions } from '@/api/queries/me';
import { mcpCountQueryOptions, metricsSummaryQueryOptions, metricsTimeseriesQueryOptions } from '@/api/queries/metrics';
import { reposQueryOptions } from '@/api/queries/repos';
import { sessionSummaryQueryOptions } from '@/api/queries/sessions';
import { workspaceConfigQueryOptions } from '@/api/queries/workspace-config';
import type { Job, TimeseriesPoint } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { KpiCard } from '@/components/kpi-card';
import { PageHead } from '@/components/page-head';
import { QueryBoundary } from '@/components/query-boundary';
import { RoleBadge } from '@/components/role-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/time';
import { findWorkspace } from './workspace';

const TH = 'border-b border-border-soft pb-[7px] text-[11.5px] font-normal uppercase tracking-[0.04em] text-ink-4';
const TD = 'border-b border-border-soft py-2 text-ink-2 last:border-b-0';

const NUM = new Intl.NumberFormat('en-US');
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : NUM.format(Math.round(n)));

const JOB_BADGE = { succeeded: 'ok', failed: 'err', running: 'warn', pending: 'neutral' } as const;

/**
 * Split a 2×-window daily series into "previous half vs. current half".
 * `sum` suits flow metrics (calls, sessions), `last` a level (graph nodes).
 * No delta without a positive baseline — an honest spark beats a fake %.
 */
function trend(points: TimeseriesPoint[] | undefined, mode: 'sum' | 'last') {
  if (!points || points.length < 4) return undefined;
  const mid = Math.floor(points.length / 2);
  const agg = (half: TimeseriesPoint[]) =>
    mode === 'sum' ? half.reduce((acc, p) => acc + p.value, 0) : (half.at(-1)?.value ?? 0);
  const currHalf = points.slice(mid);
  const prev = agg(points.slice(0, mid));
  const spark = currHalf.slice(-16).map((p) => p.value);
  if (prev <= 0) return { spark, delta: undefined };
  return { spark, delta: { pct: ((agg(currHalf) - prev) / prev) * 100 } };
}

function JobRow({ job }: { job: Job }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-soft py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="truncate text-[13.5px] text-ink-1">{job.repoName ?? job.type}</div>
        <div className="truncate text-[12px] text-ink-4">
          {job.status === 'failed' && job.lastError ? job.lastError.split('\n', 1)[0] : job.type}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="num text-[12px] text-ink-4">{formatRelativeTime(job.finishedAt ?? job.queuedAt)}</span>
        <Badge variant={JOB_BADGE[job.status]}>{job.status}</Badge>
      </div>
    </div>
  );
}

function OverviewContent({ wsId, slug, role }: { wsId: string; slug: string; role: string }) {
  const configQuery = useQuery(workspaceConfigQueryOptions(wsId));
  const reposQuery = useQuery(reposQueryOptions(wsId));
  const jobsQuery = useQuery(jobsQueryOptions(wsId, undefined, 5));
  const [summary, mcp, sessions] = useQueries({
    queries: [metricsSummaryQueryOptions(wsId), mcpCountQueryOptions(wsId), sessionSummaryQueryOptions(wsId, 30)],
  });
  // Sparklines stream in after first paint: a failed series drops the trend,
  // it never blocks the tile. 60 days = 2× the visible window.
  const [nodesSeries, mcpSeries, sessionsSeries] = useQueries({
    queries: [
      metricsTimeseriesQueryOptions(wsId, 'nodes', 60),
      metricsTimeseriesQueryOptions(wsId, 'mcp_calls', 60),
      metricsTimeseriesQueryOptions(wsId, 'sessions', 60),
    ],
  });
  const nodesTrend = trend(nodesSeries.data?.points, 'last');
  const mcpTrend = trend(mcpSeries.data?.points, 'sum');
  const sessionsTrend = trend(sessionsSeries.data?.points, 'sum');

  return (
    <>
      <QueryBoundary query={configQuery}>
        {(config) => (
          <PageHead
            title={config.workspace.name}
            sub={
              <>
                <span className="font-mono text-[12.5px]">{slug}</span>
                <RoleBadge role={role} />
              </>
            }
          />
        )}
      </QueryBoundary>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard label="Repositories" value={fmt(reposQuery.data?.length)} hint="connected to this workspace" />
        <KpiCard
          label="Graph nodes"
          value={fmt(summary.data?.totalNodes)}
          hint={`${fmt(summary.data?.totalEdges)} edges`}
          spark={nodesTrend?.spark}
          delta={nodesTrend?.delta}
        />
        <KpiCard
          label="MCP calls · 30d"
          value={fmt(mcp.data?.count)}
          hint="across connected assistants"
          spark={mcpTrend?.spark}
          delta={mcpTrend?.delta}
        />
        <KpiCard
          label="Agent sessions · 30d"
          value={fmt(sessions.data?.sessionCount)}
          hint={`${fmt(sessions.data?.distinctUserCount)} active users`}
          spark={sessionsTrend?.spark}
          delta={sessionsTrend?.delta}
        />
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHead
            title="Repositories"
            sub="graph size and last push"
            right={
              <Link to="/w/$slug/repos" params={{ slug }} className="text-[12.5px] text-ink-3 hover:text-ink-1">
                Manage →
              </Link>
            }
          />
          <CardBody className="overflow-x-auto pt-2">
            <QueryBoundary query={reposQuery}>
              {(repos) =>
                repos.length === 0 ? (
                  <EmptyNote>No repositories pushed to this workspace yet.</EmptyNote>
                ) : (
                  <table className="w-full border-collapse text-[13.5px]">
                    <thead>
                      <tr>
                        <th className={`${TH} text-left`}>Repository</th>
                        <th className={`${TH} text-right`}>Nodes</th>
                        <th className={`${TH} text-right`}>Last push</th>
                      </tr>
                    </thead>
                    <tbody>
                      {repos.map((repo) => (
                        <tr key={repo.id} className="hover:bg-surface-2">
                          <td className={`${TD} pr-3 text-ink-1`}>{repo.repoName}</td>
                          <td className={`${TD} num pr-3 text-right`}>{fmt(repo.nodeCount)}</td>
                          <td className={`${TD} text-right text-ink-4`}>{formatRelativeTime(repo.lastPushedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </QueryBoundary>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHead title="Recent jobs" sub="push and resolve queue" />
            <CardBody className="pt-1">
              <QueryBoundary query={jobsQuery}>
                {(jobs) =>
                  jobs.length === 0 ? (
                    <EmptyNote>No jobs have run yet.</EmptyNote>
                  ) : (
                    <div>
                      {jobs.map((job) => (
                        <JobRow key={job.id} job={job} />
                      ))}
                    </div>
                  )
                }
              </QueryBoundary>
            </CardBody>
          </Card>

          <Card>
            <CardHead title="Team" />
            <CardBody className="flex items-baseline justify-between gap-3 pt-3">
              <div>
                <div className="num text-[24px] font-medium tracking-[-0.02em] text-ink-1">
                  {fmt(configQuery.data?.members.length)}
                </div>
                <div className="text-[12px] text-ink-4">members with workspace access</div>
              </div>
              <Link to="/w/$slug/teams" params={{ slug }} className="text-[12.5px] text-ink-3 hover:text-ink-1">
                Manage →
              </Link>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

export function WorkspaceOverview() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = slug ? findWorkspace(me, slug) : undefined;

  // Unreachable: /w/$slug's beforeLoad redirects an unknown slug before this renders.
  if (!workspace || !slug) return null;

  return <OverviewContent wsId={workspace.id} slug={slug} role={workspace.role} />;
}
