import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../../auth/workspace-role.guard.js';
import { WorkspaceRole } from '../../../auth/decorators/workspace-role.decorator.js';
import { CurrentReader } from '../../../auth/decorators/current-reader.decorator.js';
import type { RepoReader } from '../../../database/control-plane.service.js';
import { WorkspaceConfigService } from './workspace-config.service.js';

@Controller('workspaces/:workspaceId/config')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class WorkspaceConfigController {
  constructor(private readonly workspaceConfigService: WorkspaceConfigService) {}

  @Get()
  @WorkspaceRole('member')
  async getWorkspaceConfig(@Param('workspaceId') workspaceId: string, @CurrentReader() reader: RepoReader) {
    return this.workspaceConfigService.getWorkspaceConfig(workspaceId, reader);
  }
}
