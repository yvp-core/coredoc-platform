/**
 * REST surface of the cloud intent service (spec §7), under
 * `/api/v1/workspaces/:workspaceId/intent/…`.
 *
 * GUARDS. The class stack is the house one — `AuthGuard` → `WorkspaceRoleGuard`
 * → `PermissionsGuard` — and each route adds what it needs on top:
 *
 * - reads: `@WorkspaceRole('member')` + `@RequirePermission(IntentRead)`;
 * - propose: `@WorkspaceRole('member')` + `@RequirePermission(IntentPropose)`;
 * - tree writes: `@WorkspaceRole('member')` + `UserSessionGuard` (BR-1: any member, own session).
 *
 * The tree routes carry no `@RequirePermission` ON PURPOSE. No token permission
 * may stand in for a user session there: `AuthGuard` resolves a service token to
 * the user who CREATED it, so an owner-created CI token already satisfies every
 * role check, and only `UserSessionGuard`'s structural test can refuse it (spec
 * §5 — there is no machine-only path to tree or authority changes).
 *
 * VALIDATION. Bodies and queries are parsed at the boundary by
 * `intentContractPipe(Schema)`, which runs `parseContract` — the same schema
 * instance the MCP tools use, the same content walk, the same refusal body — so
 * the two surfaces cannot drift and a handler only ever sees parsed input.
 * Nest's global `ValidationPipe` is not involved: these are zod schemas, not
 * class-validator DTOs.
 *
 * PATH VS BODY. Ids that appear in a route path are ALSO in the body, because
 * MCP has no path. Each route asserts the two agree rather than preferring one,
 * so a request means the same thing on both surfaces.
 *
 * VERBS. Every mutation carries an idempotency key, so every mutation has a
 * body — including the deletes, which are therefore explicit `…/delete` POSTs
 * rather than `DELETE` requests with a body that intermediaries are free to
 * drop.
 */
import { Body, Controller, Get, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuthGuard } from '../../auth/auth.guard.js';
import { CurrentUser, type AuthUser } from '../../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { WorkspaceRoleValue } from '../../auth/decorators/workspace-role-value.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { UserSessionGuard } from '../../auth/user-session.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import type { WorkspaceMemberRole } from '../members/dto/workspace-role.enum.js';
import {
  ArchiveIntentDimensionSchema,
  ArchiveIntentDomainSchema,
  ArchiveIntentFeatureSchema,
  CreateIntentDimensionSchema,
  CreateIntentDomainSchema,
  CreateIntentFeatureSchema,
  DeleteIntentDimensionSchema,
  DeleteIntentFeatureSeedSchema,
  IntentExceptionFilter,
  ListIntentDimensionsQuerySchema,
  ProposeIntentItemsSchema,
  PutIntentFeatureSeedSchema,
  UpdateIntentDimensionSchema,
  UpdateIntentDomainSchema,
  UpdateIntentFeatureSchema,
  intentContractPipe,
} from './contract/index.js';
import { parseIntentPageLimit } from './intent-cursor.js';
import type { IntentActor } from './intent-idempotency.js';
import { IntentItemService } from './intent-item.service.js';
import {
  DeleteIntentDomainSchema,
  DeleteIntentFeatureSchema,
  IntentNodeDocumentQuerySchema,
  ListIntentFeatureSeedsQuerySchema,
  ListIntentFeaturesQuerySchema,
  ListIntentItemsQuerySchema,
  ListIntentSourcesQuerySchema,
  ListIntentTreeQuerySchema,
} from './intent-module-operations.js';
import { IntentProposeService } from './intent-propose.service.js';
import { IntentReadService } from './intent-read.service.js';
import { assertPathMatchesBody } from './intent-state-errors.js';
import { IntentTreeService } from './intent-tree.service.js';
import { IntentActorRole } from '../../mcp/intent-auth.js';

/**
 * The actor recorded on every audit row and transition. Identity and role come
 * from the token via the guards — never from the request payload (spec §4.7).
 * A tree route always has a resolved role, because `UserSessionGuard` has
 * already refused every service token by the time this runs.
 */
function actorOf(user: AuthUser, role: WorkspaceMemberRole | undefined): IntentActor {
  return { id: user.id, role: role ?? IntentActorRole.ServiceToken };
}

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentController {
  constructor(
    private readonly tree: IntentTreeService,
    private readonly items: IntentItemService,
    private readonly propose: IntentProposeService,
    private readonly reads: IntentReadService,
  ) {}

  /* -------------------------------------------------------------- reads --- */

  @Get('tree')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async getTree(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentTreeQuerySchema)) parsed: z.infer<typeof ListIntentTreeQuerySchema>,
  ) {
    return this.tree.getTree(workspaceId, parsed, parseIntentPageLimit(parsed.limit));
  }

  @Get('document')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async getDocument(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(IntentNodeDocumentQuerySchema)) parsed: z.infer<typeof IntentNodeDocumentQuerySchema>,
  ) {
    return this.reads.document(workspaceId, {
      ...(parsed.domainId ? { domain: parsed.domainId } : {}),
      ...(parsed.featureId ? { feature: parsed.featureId } : {}),
      includeCandidates: parsed.includeCandidates === 'true',
    });
  }

  @Get('features')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listFeatures(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentFeaturesQuerySchema)) parsed: z.infer<typeof ListIntentFeaturesQuerySchema>,
  ) {
    return this.tree.listFeatures(workspaceId, parsed, parseIntentPageLimit(parsed.limit));
  }

  @Get('features/:featureId/seeds')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listSeeds(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @Query(intentContractPipe(ListIntentFeatureSeedsQuerySchema)) parsed: z.infer<
      typeof ListIntentFeatureSeedsQuerySchema
    >,
  ) {
    return this.tree.listSeeds(workspaceId, featureId, parsed, parseIntentPageLimit(parsed.limit));
  }

  @Get('sources')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  listSources(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentSourcesQuerySchema)) query: z.infer<typeof ListIntentSourcesQuerySchema>,
  ) {
    return this.items.listSources(workspaceId, query.search);
  }

  @Get('items')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listItems(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentItemsQuerySchema)) parsed: z.infer<typeof ListIntentItemsQuerySchema>,
  ) {
    return this.items.listItems(workspaceId, parsed, parseIntentPageLimit(parsed.limit));
  }

  /* ------------------------------------------------------------ domains --- */

  @Post('domains')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async createDomain(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(CreateIntentDomainSchema)) body: z.infer<typeof CreateIntentDomainSchema>,
  ) {
    return this.tree.createDomain(workspaceId, actorOf(user, role), body);
  }

  @Patch('domains/:domainId')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async updateDomain(
    @Param('workspaceId') workspaceId: string,
    @Param('domainId') domainId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(UpdateIntentDomainSchema)) input: z.infer<typeof UpdateIntentDomainSchema>,
  ) {
    assertPathMatchesBody(domainId, input.id, 'id');
    return this.tree.updateDomain(workspaceId, actorOf(user, role), input);
  }

  @Post('domains/:domainId/archive')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async archiveDomain(
    @Param('workspaceId') workspaceId: string,
    @Param('domainId') domainId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(ArchiveIntentDomainSchema)) input: z.infer<typeof ArchiveIntentDomainSchema>,
  ) {
    assertPathMatchesBody(domainId, input.id, 'id');
    return this.tree.archiveDomain(workspaceId, actorOf(user, role), input);
  }

  @Post('domains/:domainId/delete')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async deleteDomain(
    @Param('workspaceId') workspaceId: string,
    @Param('domainId') domainId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(DeleteIntentDomainSchema)) input: z.infer<typeof DeleteIntentDomainSchema>,
  ) {
    assertPathMatchesBody(domainId, input.id, 'id');
    return this.tree.deleteDomain(workspaceId, actorOf(user, role), input);
  }

  /* --------------------------------------------------------- dimensions --- */

  @Get('dimensions')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async listDimensions(
    @Param('workspaceId') workspaceId: string,
    @Query(intentContractPipe(ListIntentDimensionsQuerySchema)) parsed: z.infer<typeof ListIntentDimensionsQuerySchema>,
  ) {
    return this.tree.listDimensions(workspaceId, parsed);
  }

  @Post('dimensions')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async createDimension(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(CreateIntentDimensionSchema)) body: z.infer<typeof CreateIntentDimensionSchema>,
  ) {
    return this.tree.createDimension(workspaceId, actorOf(user, role), body);
  }

  @Patch('dimensions/:dimensionId')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async updateDimension(
    @Param('workspaceId') workspaceId: string,
    @Param('dimensionId') dimensionId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(UpdateIntentDimensionSchema)) input: z.infer<typeof UpdateIntentDimensionSchema>,
  ) {
    assertPathMatchesBody(dimensionId, input.id, 'id');
    return this.tree.updateDimension(workspaceId, actorOf(user, role), input);
  }

  @Post('dimensions/:dimensionId/archive')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async archiveDimension(
    @Param('workspaceId') workspaceId: string,
    @Param('dimensionId') dimensionId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(ArchiveIntentDimensionSchema)) input: z.infer<typeof ArchiveIntentDimensionSchema>,
  ) {
    assertPathMatchesBody(dimensionId, input.id, 'id');
    return this.tree.archiveDimension(workspaceId, actorOf(user, role), input);
  }

  @Post('dimensions/:dimensionId/delete')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async deleteDimension(
    @Param('workspaceId') workspaceId: string,
    @Param('dimensionId') dimensionId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(DeleteIntentDimensionSchema)) input: z.infer<typeof DeleteIntentDimensionSchema>,
  ) {
    assertPathMatchesBody(dimensionId, input.id, 'id');
    return this.tree.deleteDimension(workspaceId, actorOf(user, role), input);
  }

  /* ----------------------------------------------------------- features --- */

  @Post('features')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async createFeature(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(CreateIntentFeatureSchema)) body: z.infer<typeof CreateIntentFeatureSchema>,
  ) {
    return this.tree.createFeature(workspaceId, actorOf(user, role), body);
  }

  @Patch('features/:featureId')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async updateFeature(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(UpdateIntentFeatureSchema)) input: z.infer<typeof UpdateIntentFeatureSchema>,
  ) {
    assertPathMatchesBody(featureId, input.id, 'id');
    return this.tree.updateFeature(workspaceId, actorOf(user, role), input);
  }

  @Post('features/:featureId/archive')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async archiveFeature(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(ArchiveIntentFeatureSchema)) input: z.infer<typeof ArchiveIntentFeatureSchema>,
  ) {
    assertPathMatchesBody(featureId, input.id, 'id');
    return this.tree.archiveFeature(workspaceId, actorOf(user, role), input);
  }

  @Post('features/:featureId/delete')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async deleteFeature(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(DeleteIntentFeatureSchema)) input: z.infer<typeof DeleteIntentFeatureSchema>,
  ) {
    assertPathMatchesBody(featureId, input.id, 'id');
    return this.tree.deleteFeature(workspaceId, actorOf(user, role), input);
  }

  /* -------------------------------------------------------------- seeds --- */

  @Post('features/:featureId/seeds')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async putSeed(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(PutIntentFeatureSeedSchema)) input: z.infer<typeof PutIntentFeatureSeedSchema>,
  ) {
    assertPathMatchesBody(featureId, input.featureId, 'featureId');
    return this.tree.putSeed(workspaceId, actorOf(user, role), input);
  }

  @Post('features/:featureId/seeds/delete')
  @UseGuards(UserSessionGuard)
  @WorkspaceRole('member')
  async deleteSeed(
    @Param('workspaceId') workspaceId: string,
    @Param('featureId') featureId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(DeleteIntentFeatureSeedSchema)) input: z.infer<typeof DeleteIntentFeatureSeedSchema>,
  ) {
    assertPathMatchesBody(featureId, input.featureId, 'featureId');
    return this.tree.deleteSeed(workspaceId, actorOf(user, role), input);
  }

  /* ------------------------------------------------------------ propose --- */

  @Post('items/propose')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentPropose)
  async proposeItems(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthUser,
    @WorkspaceRoleValue() role: WorkspaceMemberRole | undefined,
    @Body(intentContractPipe(ProposeIntentItemsSchema)) body: z.infer<typeof ProposeIntentItemsSchema>,
  ) {
    return this.propose.propose(workspaceId, actorOf(user, role), body);
  }
}
