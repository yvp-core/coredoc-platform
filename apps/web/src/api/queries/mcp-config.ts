import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { McpConfig } from '../types.js';

// Same `signal`-omission rationale as meQueryOptions (src/api/queries/me.ts).
//
// staleTime: 30_000 — mirrors workspaceConfigQueryOptions: the underlying
// value (server env's MCP_SERVER_URL + the workspace id) never changes within
// a session, but a short staleTime (not Infinity) keeps this consistent with
// the rest of the workspace-scoped queries rather than a special case.
export const mcpConfigQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'mcp-config'] as const,
    queryFn: () => request<McpConfig>(`/api/v1/workspaces/${wsId}/mcp-config`),
    staleTime: 30_000,
  });
