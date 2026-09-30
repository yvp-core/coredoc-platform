import {
  BadRequestException,
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  WorkOSApiError,
  WorkOSInvitationsService,
  type DeliveredInvitation,
} from '../../auth/workos-invitations.service.js';
import { invitationExpiresAt, isInvitationLive } from '../../auth/oauth/invitation-eligibility.js';
import { emailDomain, parseCsv } from '../../auth/oauth/provider-utils.js';
import { serverUrl } from '../../auth/oauth/server-url.js';
import { authConfigFromEnv } from '../../config/app-config.js';
import { ControlPlaneService } from '../../database/control-plane.service.js';
import { WorkspaceMemberRole } from './dto/workspace-role.enum.js';

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly workosInvitations: WorkOSInvitationsService,
  ) {}

  async listMembers(workspaceId: string) {
    return this.controlPlane.listMembers(workspaceId);
  }

  /**
   * Resolve the optional WorkOS organization, reserve local workspace access,
   * then send the organization-scoped AuthKit invitation. The local rows are
   * removed again if delivery fails, so a successful response always means the
   * pending grant and delivery metadata agree.
   */
  async inviteMember(workspaceId: string, invitedBy: string, email: string, role: string = WorkspaceMemberRole.Member) {
    const normalizedEmail = email.toLowerCase();
    this.assertAllowedEmail(normalizedEmail);
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    let workosOrganizationId: string | null;
    try {
      workosOrganizationId = await this.ensureWorkosOrganization(workspace);
    } catch (error) {
      this.logger.warn(
        `WorkOS organization preparation failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException('Invitation email could not be prepared; try again.');
    }
    try {
      const invitation = await this.controlPlane.createPendingInvitation(workspaceId, normalizedEmail, role);
      try {
        const delivery = await this.deliverInvitation(invitation, workosOrganizationId);
        this.logger.log(
          `${invitedBy} invited ${invitation.member.email} to workspace ${workspaceId} as ${role} (emailSent=${Boolean(delivery)})`,
        );
        return {
          invited: true as const,
          emailSent: Boolean(delivery),
          expiresAt: (delivery?.expiresAt ?? invitationExpiresAt(invitation)).toISOString(),
          signInUrl: this.signInUrl(),
        };
      } catch (deliveryError) {
        // A transport failure is ambiguous: WorkOS may have accepted the
        // idempotent create before the response was lost. Preserve the local
        // invitation id so resend can repeat the same operation key and recover
        // the remote object instead of creating an orphan.
        if (deliveryError instanceof WorkOSApiError && deliveryError.outcomeUnknown) {
          throw new BadGatewayException(
            'Invitation delivery could not be confirmed. The pending invite was kept so it can be resent safely.',
          );
        }
        const cleanedUp = await this.rollbackPendingInvitation(workspaceId, invitation.id);
        if (!cleanedUp) {
          throw new BadGatewayException(
            'Invitation email delivery failed and pending access cleanup could not be confirmed; revoke the pending invite before retrying.',
          );
        }
        this.logger.warn(
          `Invitation email delivery failed for workspace ${workspaceId}: ${deliveryError instanceof Error ? deliveryError.message : String(deliveryError)}`,
        );
        throw new BadGatewayException(
          'Invitation email could not be sent. No pending workspace access was created; try again.',
        );
      }
    } catch (err) {
      // Prisma raises P2002 on the (workspaceId, userId) primary-key collision
      // when this email was already invited — its placeholder userId is derived
      // from the email. Match the stable error code, not the message text.
      if (err && typeof err === 'object' && (err as { code?: string }).code === 'P2002') {
        throw new ConflictException(`${email} is already a member of or invited to this workspace`);
      }
      throw err;
    }
  }

  async removeMember(workspaceId: string, userId: string) {
    const member = await this.controlPlane.getMember(workspaceId, userId);
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    if (member.role === WorkspaceMemberRole.Owner) {
      throw new ForbiddenException('Owner role cannot be removed');
    }
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    let providerCleanupSucceeded: boolean | null = null;
    if (this.workosInvitations.isEnabled() && workspace?.workosOrganizationId) {
      if (member.pending) {
        // GET /members is unfiltered and includes pending placeholder rows, so
        // deleting one through this route is a normal admin action — and the FK
        // cascade would destroy the invitation row holding the only reference
        // to the live WorkOS invitation. Revoke it here the way revokeInvite
        // does, or the invitee could still accept after being removed.
        providerCleanupSucceeded = await this.revokePendingMemberInvitation(workspaceId, userId);
      } else {
        const identity = await this.controlPlane.getWorkosIdentity(userId);
        if (identity) {
          try {
            await this.workosInvitations.removeOrganizationMembership(
              workspace.workosOrganizationId,
              identity.provider_user_id,
            );
            providerCleanupSucceeded = true;
          } catch (error) {
            providerCleanupSucceeded = false;
            // Local membership is the authorization boundary, so removal must
            // still succeed when the secondary WorkOS mirror is unavailable.
            this.logger.warn(
              `WorkOS membership cleanup failed while removing member ${userId} from workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    await this.controlPlane.removeMember(workspaceId, userId);
    return { removed: true as const, providerCleanupSucceeded };
  }

  /**
   * Best-effort mirror cleanup for a pending member. Local membership is the
   * authorization boundary, so a provider outage must not keep an access grant
   * alive after an administrator removes it.
   */
  private async revokePendingMemberInvitation(workspaceId: string, userId: string): Promise<boolean | null> {
    const invitation = await this.controlPlane.getInvitationForMember(workspaceId, userId);
    if (!invitation?.workosInvitationId) return null;
    const references = await this.controlPlane.countPendingInvitationsByWorkosId(invitation.workosInvitationId);
    if (references !== 1) return false;
    try {
      await this.workosInvitations.revoke(invitation.workosInvitationId);
      return true;
    } catch (error) {
      this.logger.warn(
        `WorkOS invitation revocation failed while removing pending member ${userId} from workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceMemberRole) {
    const member = await this.controlPlane.getMember(workspaceId, userId);
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    if (member.role === WorkspaceMemberRole.Owner) {
      throw new ForbiddenException('Owner role cannot be changed');
    }
    return this.controlPlane.updateMemberRole(workspaceId, userId, role);
  }

  async listPendingInvites(workspaceId: string) {
    const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    const pending = await this.controlPlane.listPendingInvitations(workspaceId);
    const now = new Date();
    return pending.map((invitation) => ({
      id: invitation.id,
      email: invitation.member.email,
      role: invitation.member.role,
      state: isInvitationLive(invitation, now) ? ('pending' as const) : ('expired' as const),
      emailSent: Boolean(invitation.workosInvitationId),
      createdAt: invitation.createdAt,
      invitedAt: invitation.createdAt,
      expiresAt: invitationExpiresAt(invitation),
      lastSentAt: invitation.lastSentAt,
    }));
  }

  async revokeInvite(workspaceId: string, invitationId: string) {
    const invitation = await this.controlPlane.getPendingInvitation(workspaceId, invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found in this workspace');
    }

    let emailRevoked: boolean | null = null;
    if (this.workosInvitations.isEnabled() && invitation.workosInvitationId) {
      const references = await this.controlPlane.countPendingInvitationsByWorkosId(invitation.workosInvitationId);
      if (references === 1) {
        try {
          await this.workosInvitations.revoke(invitation.workosInvitationId);
          emailRevoked = true;
        } catch (error) {
          emailRevoked = false;
          this.logger.warn(
            `Workspace invite ${invitation.id} will be revoked locally, but WorkOS revocation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        emailRevoked = false;
        this.logger.warn(
          `Workspace invite ${invitation.id} will be revoked locally, but its WorkOS invitation has ${references} local references and was not revoked`,
        );
      }
    }

    const removed = await this.controlPlane.removePendingInvitation(workspaceId, invitationId);
    if (!removed) {
      throw new NotFoundException('Invitation not found in this workspace');
    }
    return { revoked: true as const, emailRevoked };
  }

  async resendInvite(workspaceId: string, invitationId: string) {
    const invitation = await this.controlPlane.getPendingInvitation(workspaceId, invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found in this workspace');
    }
    this.assertAllowedEmail(invitation.member.email);
    if (!this.workosInvitations.isEnabled()) {
      const sentAt = new Date();
      const renewed = await this.controlPlane.renewManualInvitation(workspaceId, invitationId, sentAt);
      if (renewed.count !== 1) throw new NotFoundException('Invitation not found in this workspace');
      return {
        resent: false as const,
        emailSent: false as const,
        expiresAt: invitationExpiresAt({ ...invitation, lastSentAt: sentAt }).toISOString(),
        signInUrl: this.signInUrl(),
      };
    }

    try {
      const workspace = await this.controlPlane.getWorkspaceById(workspaceId);
      if (!workspace) throw new NotFoundException('Workspace not found');
      const workosOrganizationId = await this.ensureWorkosOrganization(workspace);
      const delivery = await this.deliverInvitation(invitation, workosOrganizationId);
      return {
        resent: true as const,
        emailSent: true as const,
        expiresAt: delivery?.expiresAt.toISOString() ?? null,
        signInUrl: this.signInUrl(),
      };
    } catch (error) {
      this.logger.warn(
        `Invitation email resend failed for workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException('Invitation email could not be resent; the pending workspace invite is unchanged.');
    }
  }

  private async deliverInvitation(
    invitation: {
      id: string;
      workosInvitationId: string | null;
      expiresAt: Date | null;
      member: { email: string };
    },
    workosOrganizationId: string | null,
  ): Promise<DeliveredInvitation | null> {
    if (!this.workosInvitations.isEnabled()) return null;
    if (!workosOrganizationId) throw new Error('WorkOS workspace organization is missing');

    const now = new Date();
    const currentDeliveryIsLive =
      invitation.workosInvitationId !== null &&
      invitation.expiresAt !== null &&
      invitation.expiresAt.getTime() > now.getTime();
    let delivery: DeliveredInvitation;
    let createdNew = false;
    if (currentDeliveryIsLive && invitation.workosInvitationId) {
      delivery = await this.workosInvitations.resend(invitation.workosInvitationId);
    } else {
      delivery = await this.workosInvitations.send(invitation.member.email, workosOrganizationId, invitation.id);
      createdNew = true;
    }

    try {
      await this.controlPlane.markInvitationDelivered(invitation.id, delivery.id, delivery.expiresAt, now);
    } catch (error) {
      if (createdNew) {
        try {
          await this.workosInvitations.revoke(delivery.id);
        } catch (revokeError) {
          this.logger.error(
            `Failed to compensate WorkOS invitation ${delivery.id}: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
          );
        }
      }
      throw error;
    }

    return delivery;
  }

  private async ensureWorkosOrganization(workspace: {
    id: string;
    name: string;
    workosOrganizationId: string | null;
  }): Promise<string | null> {
    if (!this.workosInvitations.isEnabled()) return null;
    if (workspace.workosOrganizationId) return workspace.workosOrganizationId;

    const owner = await this.controlPlane.getWorkspaceOwnerWorkosIdentity(workspace.id);
    if (!owner || owner.provider !== 'workos') {
      throw new Error('workspace owner has no WorkOS identity');
    }
    const organizationId = await this.workosInvitations.ensureOrganization(workspace.id, workspace.name);
    await this.workosInvitations.ensureOrganizationMembership(organizationId, owner.provider_user_id);
    await this.controlPlane.setWorkspaceWorkosOrganizationId(workspace.id, organizationId);
    return organizationId;
  }

  private async rollbackPendingInvitation(workspaceId: string, invitationId: string): Promise<boolean> {
    try {
      return await this.controlPlane.removePendingInvitation(workspaceId, invitationId);
    } catch (error) {
      this.logger.error(
        `Failed to roll back pending invitation ${invitationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private signInUrl(): string {
    return `${serverUrl().replace(/\/+$/, '')}/api/v1/auth/web/login`;
  }

  private assertAllowedEmail(email: string): void {
    const allowedDomains = parseCsv(authConfigFromEnv().allowedEmailDomains);
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain(email))) {
      throw new BadRequestException('The invited email cannot authenticate with the configured email-domain policy');
    }
  }
}
