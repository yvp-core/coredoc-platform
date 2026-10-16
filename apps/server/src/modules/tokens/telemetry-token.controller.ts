import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { TELEMETRY_TOKEN_PERMISSIONS } from '../../auth/permissions.guard.js';
import { TokensService } from './tokens.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { CreateTelemetryTokenSchema, type CreateTelemetryTokenInput } from './tokens.contract.js';

/**
 * Self-service telemetry-token minting. Deliberately separate from the
 * admin-gated TokensController: any workspace *member* may mint a
 * telemetry-scoped token OWNED BY THEMSELVES, and nothing else. Scope is
 * hard-coded server-side; UserSessionGuard blocks service-token principals so a
 * leaked telemetry token cannot mint more tokens.
 */
@Controller('workspaces/:workspaceId/telemetry-token')
@UseGuards(AuthGuard, WorkspaceRoleGuard, UserSessionGuard)
export class TelemetryTokenController {
  constructor(private readonly tokensService: TokensService) {}

  @Post()
  @WorkspaceRole('member')
  async mint(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateTelemetryTokenSchema, dtoFieldMessages)) dto: CreateTelemetryTokenInput,
    @CurrentUser() user: AuthUser,
  ): Promise<{ token: string }> {
    const result = await this.tokensService.createToken(
      workspaceId,
      dto.name ?? 'otel',
      user.id,
      undefined,
      TELEMETRY_TOKEN_PERMISSIONS,
    );
    return { token: result.token };
  }

  @Put('installations/:installationId')
  @WorkspaceRole('member')
  async putInstallation(
    @Param('workspaceId') workspaceId: string,
    @Param('installationId') installationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const result = await this.tokensService.rotateInstallationToken(workspaceId, installationId, user.id);
    return {
      id: result.id,
      name: result.name,
      token: result.token,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
    };
  }

  @Get('installations')
  @WorkspaceRole('member')
  listInstallations(@Param('workspaceId') workspaceId: string, @CurrentUser() user: AuthUser) {
    return this.tokensService.listInstallationTokens(workspaceId, user.id);
  }

  @Get('owned')
  @WorkspaceRole('member')
  listOwned(@Param('workspaceId') workspaceId: string, @CurrentUser() user: AuthUser) {
    return this.tokensService.listOwnedTelemetryTokens(workspaceId, user.id);
  }

  @Delete('installations/:installationId')
  @HttpCode(204)
  @WorkspaceRole('member')
  deleteInstallation(
    @Param('workspaceId') workspaceId: string,
    @Param('installationId') installationId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tokensService.revokeInstallationToken(workspaceId, installationId, user.id);
  }

  @Delete('owned/:tokenId')
  @HttpCode(204)
  @WorkspaceRole('member')
  deleteOwned(
    @Param('workspaceId') workspaceId: string,
    @Param('tokenId') tokenId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tokensService.revokeOwnedTelemetryToken(workspaceId, tokenId, user.id);
  }
}
