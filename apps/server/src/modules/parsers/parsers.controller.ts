import { Controller, Delete, Get, Param, Post, RawBody, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { ParsersService } from './parsers.service.js';

@Controller('workspaces/:workspaceId/parsers')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class ParsersController {
  constructor(private readonly parsersService: ParsersService) {}

  @Get()
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ParserRead)
  async listParsers(@Param('workspaceId') workspaceId: string) {
    return this.parsersService.listParsers(workspaceId);
  }

  @Post(':repoName')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ParserWrite)
  async uploadParser(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @RawBody() body: Buffer,
    @CurrentUser() user: AuthUser,
  ) {
    return this.parsersService.uploadParser(workspaceId, repoName, body, user.id);
  }

  @Get(':repoName')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ParserRead)
  async downloadParser(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @Res() res: Response,
  ) {
    const data = await this.parsersService.downloadParser(workspaceId, repoName);
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="${repoName}-parser.tar.gz"`);
    res.send(data);
  }

  /** Get parser metadata (version, size, uploader) without downloading the tarball. */
  @Get(':repoName/meta')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.ParserRead)
  async getParserMeta(@Param('workspaceId') workspaceId: string, @Param('repoName') repoName: string) {
    const meta = await this.parsersService.getParserMeta(workspaceId, repoName);
    if (!meta) {
      return { found: false };
    }
    return meta;
  }

  @Delete(':repoName')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.ParserWrite)
  async deleteParser(@Param('workspaceId') workspaceId: string, @Param('repoName') repoName: string) {
    await this.parsersService.deleteParser(workspaceId, repoName);
    return { deleted: true };
  }
}
