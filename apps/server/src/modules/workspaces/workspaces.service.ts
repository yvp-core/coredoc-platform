import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkOSInvitationsService } from '../../auth/workos-invitations.service.js';
import { ControlPlaneService, type Workspace } from '../../database/control-plane.service.js';
import type { CreateWorkspaceInput, EnableCloudInput, UpdateWorkspaceInput } from './workspaces.contract.js';
import { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import { serverUrl } from '../../auth/oauth/server-url.js';
import type { IntentReleaseTrigger } from '../../generated/prisma/client.js';

function sanitizeWorkspace({
  dbUrl,
  dbTokenEncrypted,
  workosOrganizationId,
  retainGraphArtifacts,
  ...safe
}: Workspace) {
  return safe;
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly workosInvitations: WorkOSInvitationsService,
  ) {}

  async getUserWorkspaces(user: { id: string; email: string; displayName?: string }) {
    await this.controlPlane.linkPendingMemberships(user);
    const workspaces = await this.controlPlane.listWorkspacesForUser(user.id);
    return workspaces.map((ws: Workspace & { role: string }) => ({ ...sanitizeWorkspace(ws), role: ws.role }));
  }

  async getWorkspace(workspaceId: string) {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    // Capability advertisement, not state: clients switch to upload-then-batch
    // sync only when the server explicitly says it understands resolve
    // targets. Without this, a new client against an old server would upload
    // artifacts, skip per-repo pushes, and get a targetless resolve that
    // "succeeds" while publishing none of them.
    return { ...sanitizeWorkspace(workspace), capabilities: { batchResolveTargets: true as const } };
  }

  async createWorkspace(userId: string, email: string, displayName: string | undefined, dto: CreateWorkspaceInput) {
    // Authorization always starts locally. MembersService lazily creates the
    // WorkOS organization on first invite; non-WorkOS providers stay local.
    const workspace = await this.controlPlane.createWorkspace(dto.name, dto.slug);

    // The creator becomes owner. `userId` is the OAuth profile_id.
    await this.controlPlane.addMember(workspace.id, userId, email, WorkspaceMemberRole.Owner, displayName);

    return sanitizeWorkspace(workspace);
  }

  async updateWorkspace(workspaceId: string, dto: UpdateWorkspaceInput) {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const updates: {
      name?: string;
      ciCdEnabled?: boolean;
      intentEnabled?: boolean;
      intentReleaseTrigger?: IntentReleaseTrigger;
    } = {};
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.ciCdEnabled !== undefined) updates.ciCdEnabled = dto.ciCdEnabled;
    if (dto.intentEnabled !== undefined) updates.intentEnabled = dto.intentEnabled;
    if (dto.intentReleaseTrigger !== undefined) updates.intentReleaseTrigger = dto.intentReleaseTrigger;

    const updated = await this.controlPlane.updateWorkspace(workspaceId, updates);
    return updated ? sanitizeWorkspace(updated) : null;
  }

  async getMcpConfig(workspaceId: string): Promise<Record<string, unknown>> {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const mcpUrl = `${serverUrl()}/api/v1/workspaces/${workspaceId}/mcp`;

    return {
      mcpServers: {
        coredoc: {
          url: mcpUrl,
          type: 'http',
        },
      },
    };
  }

  async enableCloud(workspaceId: string, dto?: EnableCloudInput) {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    const updates: { isCloud: boolean; ciCdEnabled?: boolean } = { isCloud: true };
    if (dto?.ciCdEnabled !== undefined) updates.ciCdEnabled = dto.ciCdEnabled;
    const updated = await this.controlPlane.updateWorkspace(workspaceId, updates);
    return updated ? sanitizeWorkspace(updated) : null;
  }

  async deleteWorkspace(workspaceId: string) {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (this.workosInvitations.isEnabled() && workspace.workosOrganizationId) {
      try {
        await this.workosInvitations.deleteOrganization(workspace.workosOrganizationId);
      } catch {
        // Keep the local mapping so the external organization can be retried
        // instead of orphaning WorkOS state with no recovery identifier.
        throw new BadGatewayException('Workspace could not be deleted because its WorkOS organization remains active.');
      }
    }
    await this.controlPlane.deleteWorkspace(workspaceId);
    return { deleted: true };
  }
}
