import { queryOptions } from '@tanstack/react-query';
import { request } from '../client.js';
import type { DeliveryConnector, DeliverySettings } from '../../features/settings/types.js';

const base = (wsId: string) => `/api/v1/workspaces/${wsId}/delivery`;

// Both endpoints are admin-gated (@WorkspaceRole('admin') +
// WorkspaceManage). `connectors` additionally sits behind DeliveryEnabledGuard,
// so the caller only enables that query once settings.enabled is true.
export const deliverySettingsQueryOptions = (wsId: string) =>
  queryOptions({
    queryKey: ['ws', wsId, 'delivery-settings'] as const,
    queryFn: () => request<DeliverySettings>(`${base(wsId)}/settings`),
    staleTime: 30_000,
  });

export const deliveryConnectorsQueryOptions = (wsId: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['ws', wsId, 'delivery-connectors'] as const,
    queryFn: () => request<{ connectors: DeliveryConnector[] }>(`${base(wsId)}/connectors`),
    enabled,
    staleTime: 0,
  });

export function setDeliveryEnabled(params: { wsId: string; enabled: boolean }): Promise<DeliverySettings> {
  return request<DeliverySettings>(`${base(params.wsId)}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: params.enabled }),
  });
}

/** Mirrors CreateConnectorDto — the service upserts on (workspace, provider). */
export interface CreateConnectorInput {
  provider: 'github' | 'jira';
  token: string;
  email?: string;
  repos?: string[];
  projects?: string[];
  baseUrl?: string;
  lookbackDays?: number;
}

export function createConnector(params: { wsId: string; input: CreateConnectorInput }): Promise<{ id: string }> {
  return request<{ id: string }>(`${base(params.wsId)}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.input),
  });
}

export function syncConnector(params: { wsId: string; connectorId: string }): Promise<{ jobId: string }> {
  return request<{ jobId: string }>(`${base(params.wsId)}/connectors/${params.connectorId}/sync`, { method: 'POST' });
}

export function setConnectorStatus(params: {
  wsId: string;
  connectorId: string;
  action: 'pause' | 'resume';
}): Promise<{ id: string; status: string }> {
  return request<{ id: string; status: string }>(
    `${base(params.wsId)}/connectors/${params.connectorId}/${params.action}`,
    { method: 'POST' },
  );
}

// The server refuses the delete unless ?confirm equals the connector id — an
// explicit second factor for an irreversible teardown, not a UI nicety.
export function deleteConnector(params: { wsId: string; connectorId: string }): Promise<{ deleted: true }> {
  const { wsId, connectorId } = params;
  return request<{ deleted: true }>(
    `${base(wsId)}/connectors/${connectorId}?confirm=${encodeURIComponent(connectorId)}`,
    { method: 'DELETE' },
  );
}
