import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard } from '../../auth/permissions.guard.js';
import { TokenPermission } from '../../auth/token-permissions.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { ActorRegistryService } from './actor-registry.service.js';
import { DeliveryEnabledGuard, SkipDeliveryEnabled } from './delivery-enabled.guard.js';
import { DeliveryService } from './delivery.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { dtoFieldMessages } from '../../common/pipes/dto-field-messages.js';
import {
  CreateConnectorSchema,
  MergeActorSchema,
  UpdateDeliverySettingsSchema,
  UpdateStatusMapSchema,
  type CreateConnectorInput,
  type MergeActorInput,
  type UpdateDeliverySettingsInput,
  type UpdateStatusMapInput,
} from './delivery.contract.js';
import { JiraCanonicalProjectionService } from './jira-canonical-projection.service.js';
import { StatusMapService } from './status-map.service.js';

@Controller('workspaces/:workspaceId/delivery')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, DeliveryEnabledGuard)
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly statusMap: StatusMapService,
    private readonly jiraProjection: JiraCanonicalProjectionService,
    private readonly actorRegistry: ActorRegistryService,
  ) {}

  @Get('settings')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  @SkipDeliveryEnabled()
  async getSettings(@Param('workspaceId') workspaceId: string) {
    return this.delivery.getDeliverySettings(workspaceId);
  }

  @Put('settings')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  @SkipDeliveryEnabled()
  async setSettings(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(UpdateDeliverySettingsSchema, dtoFieldMessages)) body: UpdateDeliverySettingsInput,
  ) {
    return this.delivery.setDeliverySettings(workspaceId, body.enabled);
  }

  @Post('connectors')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async createConnector(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(CreateConnectorSchema, dtoFieldMessages)) body: CreateConnectorInput,
  ) {
    return this.delivery.upsertConnector(workspaceId, body);
  }

  @Get('connectors')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async connectors(@Param('workspaceId') workspaceId: string) {
    return this.delivery.listConnectors(workspaceId);
  }

  @Post('connectors/:connectorId/sync')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async syncConnector(
    @Param('workspaceId') workspaceId: string,
    @Param('connectorId') connectorId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.delivery.triggerConnectorSync(workspaceId, connectorId, user?.id ?? null);
  }

  @Post('connectors/:connectorId/pause')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async pauseConnector(@Param('workspaceId') workspaceId: string, @Param('connectorId') connectorId: string) {
    return this.delivery.setConnectorStatus(workspaceId, connectorId, 'paused');
  }

  @Post('connectors/:connectorId/resume')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async resumeConnector(@Param('workspaceId') workspaceId: string, @Param('connectorId') connectorId: string) {
    return this.delivery.setConnectorStatus(workspaceId, connectorId, 'active');
  }

  @Delete('connectors/:connectorId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async deleteConnector(
    @Param('workspaceId') workspaceId: string,
    @Param('connectorId') connectorId: string,
    @Query('confirm') confirm?: string,
  ) {
    if (confirm !== connectorId) {
      throw new BadRequestException(
        `This permanently deletes connector ${connectorId}, its raw payloads, status policy, and connector-scoped ` +
          `code changes. Canonical task references are detached. This cannot be undone. Re-send the request with ` +
          `?confirm=${connectorId} to proceed.`,
      );
    }
    return this.delivery.deleteConnector(workspaceId, connectorId);
  }

  @Post('renormalize')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async renormalize(@Param('workspaceId') workspaceId: string, @Query('connectorId') connectorId?: string) {
    const job = await this.delivery.enqueueRenormalizeJob(workspaceId, connectorId || undefined);
    return { jobId: job.id };
  }

  @Get('status-map')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async getStatusMap(@Param('workspaceId') workspaceId: string, @Query('connectorId') connectorId: string) {
    if (!connectorId) throw new BadRequestException('connectorId query parameter is required');
    await this.delivery.assertConnectorInWorkspace(workspaceId, connectorId);
    return this.statusMap.listMap(workspaceId, connectorId);
  }

  @Put('status-map/:connectorId')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async updateStatusMap(
    @Param('workspaceId') workspaceId: string,
    @Param('connectorId') connectorId: string,
    @Body(new ZodValidationPipe(UpdateStatusMapSchema, dtoFieldMessages)) body: UpdateStatusMapInput,
  ) {
    await this.delivery.assertConnectorInWorkspace(workspaceId, connectorId);
    const result = await this.statusMap.updateMap(workspaceId, connectorId, body.entries);
    await this.jiraProjection.reprojectConnector(workspaceId, connectorId);
    return result;
  }

  @Get('actors/unmatched')
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async unmatchedActors(@Param('workspaceId') workspaceId: string) {
    return this.actorRegistry.listUnmatched(workspaceId);
  }

  @Post('actors/:actorId/merge')
  @HttpCode(200)
  @WorkspaceRole('admin')
  @RequirePermission(TokenPermission.WorkspaceManage)
  async mergeActor(
    @Param('workspaceId') workspaceId: string,
    @Param('actorId') actorId: string,
    @Body(new ZodValidationPipe(MergeActorSchema, dtoFieldMessages)) body: MergeActorInput,
  ) {
    return this.actorRegistry.mergeActors(workspaceId, actorId, body.intoActorId);
  }
}
