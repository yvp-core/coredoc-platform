import { Inject, Injectable, Optional } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, storageConfigFromEnv } from '../../config/app-config.js';
import { isEncryptionAvailable } from '../../database/encryption.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AgentRunSettings } from '../../generated/prisma/client.js';
import { LicenseService } from '../license/license.service.js';
import { CloudAgentRunJiraConnector } from './cloud-agent-run-jira-connector.js';

export interface AvailabilityReason {
  code: string;
  message: string;
}

export interface Availability {
  available: boolean;
  reasons: AvailabilityReason[];
  /** The Jira trigger additionally needs a valid run owner and at least one project key. */
  trigger: { ready: boolean; projectKeys: string[]; reasons: AvailabilityReason[] };
}

const reason = (code: string, message: string): AvailabilityReason => ({ code, message });

/** Evaluated live, never cached, so a fix takes effect at the next request or trigger tick. */
@Injectable()
export class CloudAgentRunAvailability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: CloudAgentRunJiraConnector,
    @Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = storageConfigFromEnv(),
    @Optional() private readonly license?: LicenseService,
  ) {}

  async check(workspaceId: string, settings: AgentRunSettings): Promise<Availability> {
    const [workspace, jira, github, owner] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { deliveryEnabled: true } }),
      this.jira.state(workspaceId),
      this.prisma.deliveryConnector.findMany({
        where: { workspaceId, provider: 'github' },
        select: { status: true },
      }),
      settings.runOwnerId
        ? this.prisma.workspaceMember.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: settings.runOwnerId } },
            select: { pending: true },
          })
        : null,
    ]);

    const reasons: AvailabilityReason[] = [];
    // Archives must survive across server replicas; the local fallback is per container.
    if (!this.storage.r2.endpoint) {
      reasons.push(
        reason('object_storage_local', 'Object storage has no endpoint; the local fallback cannot hold run archives.'),
      );
    }
    if (!isEncryptionAvailable()) {
      reasons.push(reason('encryption_key_missing', 'SERVER_ENCRYPTION_KEY is not set; the Jira connector needs it.'));
    }
    if (!workspace?.deliveryEnabled) {
      reasons.push(
        reason('delivery_disabled', 'Delivery analytics is not enabled; its Jira and GitHub connectors are required.'),
      );
    }
    if (jira.status === 'missing') reasons.push(reason('jira_connector_missing', 'No Jira connector is configured.'));
    if (jira.status === 'inactive') reasons.push(reason('jira_connector_inactive', 'The Jira connector is paused.'));
    if (github.length === 0) reasons.push(reason('github_connector_missing', 'No GitHub connector is configured.'));
    else if (!github.some((connector) => connector.status === 'active')) {
      reasons.push(reason('github_connector_inactive', 'The GitHub connector is paused.'));
    }
    if (this.license?.isExpired()) reasons.push(reason('license_expired', 'The Coredoc license has expired.'));

    const projectKeys = jira.status === 'active' ? jira.projectKeys : [];
    const triggerReasons: AvailabilityReason[] = [];
    if (!settings.runOwnerId) {
      triggerReasons.push(
        reason('run_owner_missing', 'No run owner is recorded; switch agent runs on or take over ownership.'),
      );
    } else if (!owner || owner.pending) {
      triggerReasons.push(
        reason(
          'run_owner_removed',
          'The run owner is no longer a workspace member; an admin must take over ownership.',
        ),
      );
    }
    if (jira.status === 'active' && projectKeys.length === 0) {
      triggerReasons.push(reason('no_project_keys', 'The Jira connector has no project keys; nothing is searched.'));
    }

    const available = reasons.length === 0;
    return {
      available,
      reasons,
      trigger: {
        ready: settings.enabled && available && triggerReasons.length === 0,
        projectKeys,
        reasons: triggerReasons,
      },
    };
  }
}
