import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { mergeTimeline, pollInterval } from '../../features/agent-runs/agent-run-presentation.js';
import type {
  AgentRun,
  AgentRunActivity,
  AgentRunDetail,
  AgentRunEvent,
  AgentRunEventPage,
  AgentRunList,
  AgentRunSettings,
  AgentRunSettingsUpdate,
  AgentRunSpec,
  JiraStatusChoices,
  QuestionAnswer,
} from '../../features/agent-runs/types.js';
import { request } from '../client.js';

// The desktop telemetry ingest owns `/agent-runs`; cloud agent runs live under their own prefix.
const base = (wsId: string) => `/api/v1/workspaces/${wsId}/cloud-agent-runs`;

export const AGENT_RUN_LIST_LIMIT = 50;

export const agentRunsQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs', 'list'] as const,
    queryFn: () => request<AgentRunList>(`${base(wsId)}?limit=${AGENT_RUN_LIST_LIMIT}`),
    // Runs move on their own (runners, sweeps), so the list refreshes while open.
    refetchInterval: 10_000,
  });

export const agentRunQueryOptions = (wsId: string, runId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs', runId] as const,
    queryFn: () => request<AgentRunDetail>(`${base(wsId)}/${runId}`),
    refetchInterval: (query) => pollInterval(query.state.data?.status),
  });

const timelineKey = (wsId: string, runId: string) => ['ws', wsId, 'agent-runs', runId, 'timeline'] as const;

const TIMELINE_PAGE = 500;

/** Each fetch asks only for events after the cached last seq, page by page until caught up. */
export const agentRunTimelineQueryOptions = (
  queryClient: QueryClient,
  wsId: string,
  runId: string,
  status: AgentRun['status'] | undefined,
) =>
  queryOptions({
    queryKey: timelineKey(wsId, runId),
    queryFn: async () => {
      let events = queryClient.getQueryData<AgentRunEvent[]>(timelineKey(wsId, runId)) ?? [];
      for (;;) {
        const after = events.at(-1)?.seq ?? 0;
        const page = await request<AgentRunEventPage>(
          `${base(wsId)}/${runId}/events?after=${after}&limit=${TIMELINE_PAGE}`,
        );
        events = mergeTimeline(events, page.events);
        if (page.events.length < TIMELINE_PAGE || (events.at(-1)?.seq ?? 0) >= page.lastSeq) return events;
      }
    },
    refetchInterval: pollInterval(status),
  });

export const agentRunActivityQueryOptions = (wsId: string, runId: string, status: AgentRun['status'] | undefined) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs', runId, 'activity'] as const,
    queryFn: () => request<AgentRunActivity>(`${base(wsId)}/${runId}/activity`),
    refetchInterval: pollInterval(status),
  });

/** A plain link: the session cookie authenticates the download, which the browser streams to disk. */
export function agentRunTranscriptUrl(wsId: string, runId: string, phase: 'scope' | 'implement'): string {
  return `${base(wsId)}/${runId}/transcript?phase=${phase}`;
}

export function startAgentRun(params: {
  wsId: string;
  issueKey: string;
  repositoryKeys?: string[];
}): Promise<AgentRun> {
  const { wsId, ...body } = params;
  return request<AgentRun>(base(wsId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const agentRunSpecsQueryOptions = (wsId: string, runId: string, latestVersion: number | undefined) =>
  queryOptions({
    // The latest version is in the key, so a new proposal refetches the list.
    queryKey: ['ws', wsId, 'agent-runs', runId, 'specs', latestVersion ?? 0] as const,
    queryFn: async () => (await request<{ versions: AgentRunSpec[] }>(`${base(wsId)}/${runId}/specs`)).versions,
  });

/** Accept the version the reviewer saw; anything but the latest proposed one is refused as stale. */
export function acceptAgentRunScope(params: { wsId: string; runId: string; version: number }): Promise<AgentRunDetail> {
  return request<AgentRunDetail>(`${base(params.wsId)}/${params.runId}/specs/${params.version}/accept`, {
    method: 'POST',
  });
}

export function requestAgentRunScopeChanges(params: {
  wsId: string;
  runId: string;
  version: number;
  text: string;
}): Promise<AgentRunDetail> {
  return request<AgentRunDetail>(`${base(params.wsId)}/${params.runId}/specs/${params.version}/request-changes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: params.text }),
  });
}

export function answerAgentRunQuestion(params: {
  wsId: string;
  runId: string;
  requestId: string;
  answers: QuestionAnswer[];
}): Promise<AgentRunDetail> {
  return request<AgentRunDetail>(`${base(params.wsId)}/${params.runId}/questions/${params.requestId}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers: params.answers }),
  });
}

export function cancelAgentRun(params: { wsId: string; runId: string }): Promise<AgentRunDetail> {
  return request<AgentRunDetail>(`${base(params.wsId)}/${params.runId}/cancel`, { method: 'POST' });
}

export function rerunAgentRun(params: { wsId: string; runId: string }): Promise<AgentRun> {
  return request<AgentRun>(`${base(params.wsId)}/${params.runId}/rerun`, { method: 'POST' });
}

export const agentRunSettingsQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs-settings'] as const,
    queryFn: () => request<AgentRunSettings>(`${base(wsId)}/settings`),
    staleTime: 0,
  });

export const agentRunJiraStatusesQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'agent-runs-settings', 'jira-statuses'] as const,
    queryFn: () => request<JiraStatusChoices>(`${base(wsId)}/settings/jira-statuses`),
  });

export function updateAgentRunSettings(params: { wsId: string } & AgentRunSettingsUpdate): Promise<AgentRunSettings> {
  const { wsId, ...body } = params;
  return request<AgentRunSettings>(`${base(wsId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
