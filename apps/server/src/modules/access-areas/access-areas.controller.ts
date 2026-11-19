import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { AccessAreasService } from './access-areas.service.js';
import { SaveAccessAreaSchema, type SaveAccessAreaInput } from './access-areas.contract.js';

// Admin-only throughout, reads included: the list says who may read what. Like
// member and repo administration it needs `workspace:manage`, which CI tokens
// never carry.
@Controller('workspaces/:workspaceId/access-areas')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
@WorkspaceRole('admin')
@RequirePermission(TokenPermission.WorkspaceManage)
export class AccessAreasController {
  constructor(private readonly accessAreas: AccessAreasService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.accessAreas.list(workspaceId);
  }

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(SaveAccessAreaSchema, dtoFieldMessages)) dto: SaveAccessAreaInput,
  ) {
    return this.accessAreas.save(workspaceId, null, dto);
  }

  @Put(':areaId')
  async replace(
    @Param('workspaceId') workspaceId: string,
    @Param('areaId', ParseUUIDPipe) areaId: string,
    @Body(new ZodValidationPipe(SaveAccessAreaSchema, dtoFieldMessages)) dto: SaveAccessAreaInput,
  ) {
    return this.accessAreas.save(workspaceId, areaId, dto);
  }

  @Delete(':areaId')
  @HttpCode(204)
  async remove(@Param('workspaceId') workspaceId: string, @Param('areaId', ParseUUIDPipe) areaId: string) {
    await this.accessAreas.remove(workspaceId, areaId);
  }
}
