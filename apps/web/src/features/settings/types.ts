/** GET/PUT /workspaces/:id/delivery/settings (DeliveryService.getDeliverySettings). */
export interface DeliverySettings {
  enabled: boolean;
}

/** The `config` JSON the server persists per connector (delivery.service.ts upsert*). */
export interface DeliveryConnectorConfig {
  repos?: string[];
  projects?: string[];
  since?: string;
  lookbackDays?: number;
}

/**
 * `SafeConnector` from apps/server/src/modules/delivery/delivery.service.ts —
 * the credential is never echoed back, and neither is `baseUrl` (not in the
 * list projection), so the table identifies a connector by provider + the
 * repos/projects in `config`.
 */
export interface DeliveryConnector {
  id: string;
  provider: 'github' | 'jira';
  providerVariant: string | null;
  displayName: string;
  status: string;
  lastSyncAt: string | null;
  config: DeliveryConnectorConfig | null;
  createdAt: string;
}
