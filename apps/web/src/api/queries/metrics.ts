import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { McpQueryCount, MetricsSummary, MetricsTimeseries, TimeseriesMetric } from '../types.js';

// Graph totals + coverage, from the latest push per repo. staleTime 30s matches
// the repos page — push-derived state changes only when someone pushes.
export const metricsSummaryQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'metrics-summary'] as const,
    queryFn: () => request<MetricsSummary>(`/api/v1/workspaces/${wsId}/metrics/summary`),
    staleTime: 30_000,
  });

// Total MCP queries this calendar month — a single counter.
export const mcpCountQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'mcp-count'] as const,
    queryFn: () => request<McpQueryCount>(`/api/v1/workspaces/${wsId}/metrics/mcp/count`),
    staleTime: 30_000,
  });

// Daily series feeding KPI sparklines/deltas. Default 60 days = 2× the 30-day
// display window so computeDelta can compare the two halves.
export const metricsTimeseriesQueryOptions = (wsId: string, metric: TimeseriesMetric, days = 60) =>
  queryOptions({
    queryKey: ['ws', wsId, 'metrics-timeseries', metric, days] as const,
    queryFn: () =>
      request<MetricsTimeseries>(`/api/v1/workspaces/${wsId}/metrics/timeseries?metric=${metric}&days=${days}`),
    staleTime: 30_000,
  });
