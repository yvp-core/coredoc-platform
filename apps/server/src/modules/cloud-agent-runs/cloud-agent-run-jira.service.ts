import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { decrypt, isEncryptionAvailable } from '../../database/encryption.js';
import type { DeliveryConnector } from '../../generated/prisma/client.js';
import { JiraClient, normalizeJiraBaseUrl } from '../delivery/jira-client.js';
import { JIRA_CLIENT_FACTORY, type JiraClientFactory } from '../delivery/jira-importer.service.js';

/** The importer's project-key rule: only these keys ever reach a JQL clause unquoted by Jira. */
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export type JiraConnectorState =
  | { status: 'missing' }
  | { status: 'inactive'; connector: DeliveryConnector }
  | { status: 'active'; connector: DeliveryConnector; projectKeys: string[] };

/**
 * The workspace's Jira Delivery analytics connector as agent runs see it: its
 * state, the configured project keys, and a client. Jira credentials stay in
 * the connector and are used only by the server.
 */
@Injectable()
export class CloudAgentRunJiraConnector {
  private readonly clientFactory: JiraClientFactory;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(JIRA_CLIENT_FACTORY) clientFactory?: JiraClientFactory,
  ) {
    this.clientFactory = clientFactory ?? ((options) => new JiraClient(options));
  }

  async state(workspaceId: string): Promise<JiraConnectorState> {
    const connectors = await this.prisma.deliveryConnector.findMany({
      where: { workspaceId, provider: 'jira' },
      orderBy: { createdAt: 'asc' },
    });
    const active = connectors.find((connector) => connector.status === 'active');
    if (active) return { status: 'active', connector: active, projectKeys: projectKeysOf(active.config) };
    return connectors[0] ? { status: 'inactive', connector: connectors[0] } : { status: 'missing' };
  }

  /** A client for the connector; throws when its host or credentials are unusable. */
  client(connector: DeliveryConnector): JiraClient {
    if (!connector.baseUrl) throw new Error('jira_connector_base_url_missing');
    if (!isEncryptionAvailable() || !connector.credentialsEncrypted)
      throw new Error('jira_connector_credentials_missing');
    const credentials = JSON.parse(decrypt(connector.credentialsEncrypted)) as { email?: unknown; apiToken?: unknown };
    if (typeof credentials.email !== 'string' || typeof credentials.apiToken !== 'string') {
      throw new Error('jira_connector_credentials_invalid');
    }
    return this.clientFactory({
      baseUrl: normalizeJiraBaseUrl(connector.baseUrl),
      email: credentials.email,
      apiToken: credentials.apiToken,
    });
  }
}

export function projectKeysOf(config: unknown): string[] {
  const projects = (config as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(projects)) return [];
  return [...new Set(projects.filter((key): key is string => typeof key === 'string' && PROJECT_KEY_RE.test(key)))];
}
