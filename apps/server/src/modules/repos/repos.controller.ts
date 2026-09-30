import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { ReposService } from './repos.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { ConnectRepoSchema, UpdateRepoSchema, type ConnectRepoInput, type UpdateRepoInput } from './repos.contract.js';

// Repo connect/update/disconnect is control-plane administration, distinct from
// the data-plane `repo:push`. AuthGuard + WorkspaceRoleGuard alone would let an
// admin-created service token (e.g. a leaked CI/CD token) reshape the workspace's
// connected repos. PermissionsGuard + @RequirePermission gates the mutators on
// `workspace:manage`, which CI tokens never carry; human admins still pass (JWT
// bypasses permission checks). Read routes stay open for data-plane tokens.
@Controller('workspaces/:workspaceId/repos')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  @Get()
  @WorkspaceRole('member')
  async listRepos(@Param('workspaceId') workspaceId: string) {
    return this.reposService.listRepos(workspaceId);
  }

  @Post()
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async connectRepo(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(ConnectRepoSchema, dtoFieldMessages)) dto: ConnectRepoInput,
  ) {
    return this.reposService.connectRepo(workspaceId, dto);
  }

  /**
   * Partial update for an already-connected repo. Use this to sync mutable
   * connect-time fields (gitUrl, repoType, httpPrefix). POST stays create-only.
   */
  @Patch(':repoKey')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async updateRepo(
    @Param('workspaceId') workspaceId: string,
    @Param('repoKey') repoKey: string,
    @Body(new ZodValidationPipe(UpdateRepoSchema, dtoFieldMessages)) dto: UpdateRepoInput,
  ) {
    return this.reposService.updateRepo(workspaceId, repoKey, dto);
  }

  @Get(':repoName/state')
  @WorkspaceRole('member')
  async getRepoState(@Param('workspaceId') workspaceId: string, @Param('repoName') repoName: string) {
    const state = await this.reposService.getRepoState(workspaceId, repoName);
    if (!state) throw new NotFoundException(`Repo "${repoName}" not found`);
    return state;
  }

  @Delete(':repoId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async disconnectRepo(@Param('workspaceId') workspaceId: string, @Param('repoId') repoId: string) {
    return this.reposService.disconnectRepo(workspaceId, repoId);
  }
}
