import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { AccessService } from './access.service.js';
import {
  SaveGroupSchema,
  SaveRepoAccessSchema,
  type SaveGroupInput,
  type SaveRepoAccessInput,
} from './access.contract.js';

// Admin-only throughout, reads included: the answer says who may read what. Like
// member and repo administration it needs `workspace:manage`, which CI tokens
// never carry.
@Controller('workspaces/:workspaceId/access')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
@WorkspaceRole('admin')
@RequirePermission(TokenPermission.WorkspaceManage)
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.access.list(workspaceId);
  }

  @Post('groups')
  async createGroup(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(SaveGroupSchema, dtoFieldMessages)) dto: SaveGroupInput,
  ) {
    return this.access.saveGroup(workspaceId, null, dto);
  }

  @Put('groups/:groupId')
  async replaceGroup(
    @Param('workspaceId') workspaceId: string,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body(new ZodValidationPipe(SaveGroupSchema, dtoFieldMessages)) dto: SaveGroupInput,
  ) {
    return this.access.saveGroup(workspaceId, groupId, dto);
  }

  @Delete('groups/:groupId')
  @HttpCode(204)
  async removeGroup(@Param('workspaceId') workspaceId: string, @Param('groupId', ParseUUIDPipe) groupId: string) {
    await this.access.removeGroup(workspaceId, groupId);
  }

  @Put('repos/:repoKey')
  async replaceRepoAccess(
    @Param('workspaceId') workspaceId: string,
    @Param('repoKey') repoKey: string,
    @Body(new ZodValidationPipe(SaveRepoAccessSchema, dtoFieldMessages)) dto: SaveRepoAccessInput,
  ) {
    return this.access.saveResourceAccess(workspaceId, 'repo', repoKey, dto);
  }

  @Put('domains/:domainId')
  async replaceDomainAccess(
    @Param('workspaceId') workspaceId: string,
    @Param('domainId') domainId: string,
    @Body(new ZodValidationPipe(SaveRepoAccessSchema, dtoFieldMessages)) dto: SaveRepoAccessInput,
  ) {
    return this.access.saveResourceAccess(workspaceId, 'intent_domain', domainId, dto);
  }
}
