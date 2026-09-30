import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { MembersService } from './members.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import {
  InviteMemberSchema,
  UpdateMemberRoleSchema,
  type InviteMemberInput,
  type UpdateMemberRoleInput,
} from './members.contract.js';
import { InvitationRateLimitGuard } from './invitation-rate-limit.guard.js';

// Member administration is a control-plane action. AuthGuard + WorkspaceRoleGuard
// alone would let any admin-created service token (e.g. a leaked CI/CD token)
// invite/remove members and change roles. PermissionsGuard + @RequirePermission
// gates the mutators on `workspace:manage`, which CI tokens never carry; human
// admins still pass (JWT bypasses permission checks). Read routes are left open
// so data-plane tokens can still list members.
@Controller('workspaces/:workspaceId/members')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @WorkspaceRole('member')
  async listMembers(@Param('workspaceId') workspaceId: string) {
    return this.membersService.listMembers(workspaceId);
  }

  @Post('invites')
  @UseGuards(InvitationRateLimitGuard)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async inviteMember(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(InviteMemberSchema, dtoFieldMessages)) dto: InviteMemberInput,
  ) {
    return this.membersService.inviteMember(workspaceId, user.id, dto.email, dto.role);
  }

  @Get('invites')
  @WorkspaceRole('member')
  async listPendingInvites(@Param('workspaceId') workspaceId: string) {
    return this.membersService.listPendingInvites(workspaceId);
  }

  @Delete('invites/:invitationId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async revokeInvite(@Param('workspaceId') workspaceId: string, @Param('invitationId') invitationId: string) {
    return this.membersService.revokeInvite(workspaceId, invitationId);
  }

  @Post('invites/:invitationId/resend')
  @UseGuards(InvitationRateLimitGuard)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async resendInvite(@Param('workspaceId') workspaceId: string, @Param('invitationId') invitationId: string) {
    return this.membersService.resendInvite(workspaceId, invitationId);
  }

  @Delete(':userId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async removeMember(@Param('workspaceId') workspaceId: string, @Param('userId') userId: string) {
    return this.membersService.removeMember(workspaceId, userId);
  }

  @Patch(':userId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async updateMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(UpdateMemberRoleSchema, dtoFieldMessages)) dto: UpdateMemberRoleInput,
  ) {
    return this.membersService.updateMemberRole(workspaceId, userId, dto.role);
  }
}
