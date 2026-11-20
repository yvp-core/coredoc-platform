import { Controller, Delete, Get, NotFoundException, Param, Post, RawBody, Res, UseGuards } from '@nestjs/common';
import { CurrentReader } from '../../auth/decorators/current-reader.decorator.js';
import { ControlPlaneService, readableRepos, type RepoReader } from '../../database/control-plane.service.js';
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
  constructor(
    private readonly parsersService: ParsersService,
    private readonly controlPlane: ControlPlaneService,
  ) {}

  /**
   * Names of the repos this reader may not read. A parser archive holds the
   * repo's extraction profile and parser sources, so it follows the repo.
   */
  private async withheldRepoNames(workspaceId: string, reader: RepoReader): Promise<Set<string>> {
    const { withheld } = await readableRepos(this.controlPlane, workspaceId, reader);
    return new Set(withheld.map((repo) => repo.repoName));
  }

  @Get()
  @WorkspaceRole('code')
  @RequirePermission(TokenPermission.ParserRead)
  async listParsers(@Param('workspaceId') workspaceId: string, @CurrentReader() reader: RepoReader) {
    const withheld = await this.withheldRepoNames(workspaceId, reader);
    return (await this.parsersService.listParsers(workspaceId)).filter((parser) => !withheld.has(parser.repoName));
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
  @WorkspaceRole('code')
  @RequirePermission(TokenPermission.ParserRead)
  async downloadParser(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @CurrentReader() reader: RepoReader,
    @Res() res: Response,
  ) {
    if ((await this.withheldRepoNames(workspaceId, reader)).has(repoName)) {
      // The same words as a parser that was never uploaded.
      throw new NotFoundException(
        `Parser not found for repo "${repoName}". Upload one first: coredoc parser push -r ${repoName}`,
      );
    }
    const data = await this.parsersService.downloadParser(workspaceId, repoName);
    res.set('Content-Type', 'application/gzip');
    res.set('Content-Disposition', `attachment; filename="${repoName}-parser.tar.gz"`);
    res.send(data);
  }

  /** Get parser metadata (version, size, uploader) without downloading the tarball. */
  @Get(':repoName/meta')
  @WorkspaceRole('code')
  @RequirePermission(TokenPermission.ParserRead)
  async getParserMeta(
    @Param('workspaceId') workspaceId: string,
    @Param('repoName') repoName: string,
    @CurrentReader() reader: RepoReader,
  ) {
    const meta = await this.parsersService.getParserMeta(workspaceId, repoName);
    if (!meta || (await this.withheldRepoNames(workspaceId, reader)).has(repoName)) {
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
