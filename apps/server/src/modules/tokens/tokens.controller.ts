import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import {
  PermissionsGuard,
  TokenPermission,
  CI_TOKEN_PERMISSIONS,
  INTENT_AGENT_TOKEN_PERMISSIONS,
} from '../../auth/permissions.guard.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { isWildcardExemptPermission } from '../../auth/token-permissions.js';
import { TokensService } from './tokens.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import { CreateTokenSchema, TokenScope, type CreateTokenInput } from './tokens.contract.js';

/** A service token cannot obtain explicit intent grants by minting or revealing another credential. */
function isServiceTokenRequest(request: Request): boolean {
  return Boolean((request as Request & { serviceTokenWorkspaceId?: string }).serviceTokenWorkspaceId);
}

const INTENT_AGENT_USER_SESSION_RULE =
  'Minting or revealing a CI or intent-agent token requires a user session, not a service token: ' +
  'intent scopes are granted only by a human admin, and a service token must not obtain them by delegation';

/** The scopes whose permissions a service token must never obtain by delegation. */
const USER_SESSION_ONLY_SCOPES: TokenScope[] = [TokenScope.Ci, TokenScope.IntentAgent];

// Token lifecycle is high-privilege. AuthGuard + WorkspaceRoleGuard alone would
// let any workspace-admin-scoped service token (e.g. a leaked CI/CD token) mint,
// list, reveal, or revoke tokens. PermissionsGuard + @RequirePermission(TokenManage)
// gates these routes: human admins still pass (JWT bypasses permission checks),
// but service tokens must explicitly carry `token:manage`, which CI tokens never do.
@Controller('workspaces/:workspaceId/tokens')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard)
export class TokensController {
  constructor(private readonly tokensService: TokensService) {}

  @Post()
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.TokenManage)
  async createToken(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateTokenSchema, dtoFieldMessages)) dto: CreateTokenInput,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ) {
    // The main-process member route is the sole telemetry-token mint boundary;
    // the generic admin surface remains limited to CI/MCP credentials.
    if (dto.scope === TokenScope.Telemetry) {
      throw new BadRequestException('Telemetry tokens must be minted through the telemetry-token endpoint');
    }

    if (USER_SESSION_ONLY_SCOPES.includes(dto.scope ?? TokenScope.Ci) && isServiceTokenRequest(request)) {
      throw new ForbiddenException(INTENT_AGENT_USER_SESSION_RULE);
    }

    // Curated per scope — a request never supplies a permission array. An
    // intent-agent token gets read + propose and nothing else: authority
    // changes have no permission to grant (see TokenPermission.IntentPropose).
    const permissions = dto.scope === TokenScope.IntentAgent ? INTENT_AGENT_TOKEN_PERMISSIONS : CI_TOKEN_PERMISSIONS;

    return this.tokensService.createToken(
      workspaceId,
      dto.name,
      user.id,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      permissions,
    );
  }

  @Get()
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.TokenManage)
  async listTokens(@Param('workspaceId') workspaceId: string) {
    return this.tokensService.listTokens(workspaceId);
  }

  @Get(':tokenId/value')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.TokenManage)
  async getTokenValue(
    @Param('workspaceId') workspaceId: string,
    @Param('tokenId') tokenId: string,
    @Req() request: Request,
  ) {
    // Same rule as the mint, one step earlier in the chain: reading out an
    // existing intent-agent token's plaintext is how a service token would
    // acquire intent scopes without minting anything. Checked only on the
    // service-token path, so a human admin's reveal costs no extra query.
    if (isServiceTokenRequest(request)) {
      const tokens = await this.tokensService.listTokens(workspaceId);
      const target = tokens.find((candidate) => candidate.id === tokenId);
      if (target?.permissions.some(isWildcardExemptPermission)) {
        throw new ForbiddenException(INTENT_AGENT_USER_SESSION_RULE);
      }
    }

    const token = await this.tokensService.getTokenValue(workspaceId, tokenId);
    if (!token) {
      throw new NotFoundException('Token value not available (created before encrypted storage was enabled)');
    }
    return { token };
  }

  @Delete(':tokenId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.TokenManage)
  async revokeToken(@Param('workspaceId') workspaceId: string, @Param('tokenId') tokenId: string) {
    await this.tokensService.revokeToken(workspaceId, tokenId);
    return { revoked: true };
  }
}
