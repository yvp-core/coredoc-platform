import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { SourceService } from './source.service.js';

@Controller('workspaces/:workspaceId/source/:repoName')
@UseGuards(AuthGuard, WorkspaceRoleGuard)
export class SourceController {
  constructor(private readonly sourceService: SourceService) {}

  @Get('{*filePath}')
  @WorkspaceRole('member')
  async fetchFile(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Param('filePath') filePath: string,
    @Query('ref') ref?: string,
  ) {
    return this.sourceService.fetchFile(workspaceId, repoName, filePath, ref);
  }
}
