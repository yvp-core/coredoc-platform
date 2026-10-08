import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { mergeTimeline, pollInterval } from '../../features/agent-runs/agent-run-presentation.js';
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunEventPage,
  AgentRunList,
  AgentRunSettings,
} from '../../features/agent-runs/types.js';
import { request } from '../client.js';

// The desktop telemetry ingest owns `/agent-runs`; cloud agent runs live under their own prefix.
const base = (wsId: string) => `/api/v1/workspaces/${wsId}/cloud-agent-runs`;

export const agentRunsQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs', 'list'] as const,
    queryFn: () => request<AgentRunList>(`${base(wsId)}?limit=50`),
    // Runs move on their own (runners, sweeps), so the list refreshes while open.
    refetchInterval: 10_000,
  });

export const agentRunQueryOptions = (wsId: string, runId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs', runId] as const,
    queryFn: () => request<AgentRun>(`${base(wsId)}/${runId}`),
    refetchInterval: (query) => pollInterval(query.state.data?.status),
  });

const timelineKey = (wsId: string, runId: string) => ['ws', wsId, 'agent-runs', runId, 'timeline'] as const;

/**
 * The timeline, appended forwards: each fetch asks only for events after the
 * last sequence already in the cache and merges them in. The caller passes the
 * run's status so polling stops once the run is terminal.
 */
export const agentRunTimelineQueryOptions = (
  queryClient: QueryClient,
  wsId: string,
  runId: string,
  status: AgentRun['status'] | undefined,
) =>
  queryOptions({
    queryKey: timelineKey(wsId, runId),
    queryFn: async () => {
      const existing = queryClient.getQueryData<AgentRunEvent[]>(timelineKey(wsId, runId)) ?? [];
      const after = existing.at(-1)?.seq ?? 0;
      const page = await request<AgentRunEventPage>(`${base(wsId)}/${runId}/events?after=${after}&limit=500`);
      return mergeTimeline(existing, page.events);
    },
    refetchInterval: pollInterval(status),
  });

export function startAgentRun(params: { wsId: string; issueKey: string }): Promise<AgentRun> {
  return request<AgentRun>(base(params.wsId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueKey: params.issueKey }),
  });
}

export const agentRunSettingsQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs-settings'] as const,
    queryFn: () => request<AgentRunSettings>(`${base(wsId)}/settings`),
    staleTime: 0,
  });

export function updateAgentRunSettings(params: {
  wsId: string;
  enabled?: boolean;
  takeOverOwnership?: true;
}): Promise<AgentRunSettings> {
  const { wsId, ...body } = params;
  return request<AgentRunSettings>(`${base(wsId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
