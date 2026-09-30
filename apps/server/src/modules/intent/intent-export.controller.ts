/**
 * `GET /api/v1/workspaces/:workspaceId/intent/export` — the export projection
 * (spec §9).
 *
 * An ordinary READ gate — `@WorkspaceRole('member')` +
 * `@RequirePermission(IntentRead)` — because that is what it is: the export
 * contains exactly the rows a member may already read through tree, items,
 * anchors and transitions, assembled into one deterministic document. It is
 * never a write authority and the server never reads it back.
 *
 * Separate from `IntentImportController` because the gates differ: import is
 * member + user session, export is member + read permission, and a class whose
 * routes disagree about their gate is how a gate gets applied to the wrong one.
 */
import { Controller, Get, Param, UseFilters, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import { WorkspaceRole } from '../../auth/decorators/workspace-role.decorator.js';
import { PermissionsGuard, TokenPermission } from '../../auth/permissions.guard.js';
import { WorkspaceRoleGuard } from '../../auth/workspace-role.guard.js';
import { IntentEnabledGuard } from './intent-enabled.guard.js';
import { IntentExceptionFilter } from './contract/index.js';
import { IntentExportService } from './intent-export.service.js';

@Controller('workspaces/:workspaceId/intent')
@UseGuards(AuthGuard, WorkspaceRoleGuard, PermissionsGuard, IntentEnabledGuard)
@UseFilters(IntentExceptionFilter)
export class IntentExportController {
  constructor(private readonly exports: IntentExportService) {}

  @Get('export')
  @WorkspaceRole('member')
  @RequirePermission(TokenPermission.IntentRead)
  async export(@Param('workspaceId') workspaceId: string) {
    return this.exports.export(workspaceId);
  }
}
