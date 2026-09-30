/**
 * Anchor half of the cloud intent service (spec §4.6, §6.5).
 *
 * `WorkspaceMcpContextService` is DECLARED here rather than imported from
 * `McpModule` (which does not export it), following `IntentDerivationModule`'s
 * precedent: the service's own dependencies come from the `@Global()`
 * `DatabaseModule`, so a second provider instance is plain DI, not duplicated
 * state, and this module stays independent of MCP transport wiring.
 *
 * `IntentProposeService` (in `IntentModule`) resolves anchor suggestions
 * through {@link IntentAnchorTargetService}; `IntentModule` imports this module
 * for that dependency.
 */
import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { IntentAnchorController } from './intent-anchor.controller.js';
import { IntentAnchorService } from './intent-anchor.service.js';
import { IntentAnchorTargetService } from './intent-anchor-target.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [IntentAnchorController],
  providers: [WorkspaceMcpContextService, IntentAnchorTargetService, IntentAnchorService],
  // `WorkspaceMcpContextService` is exported so the bindings sync leases the
  // SAME snapshot service rather than a second instance of it.
  exports: [IntentAnchorTargetService, IntentAnchorService, WorkspaceMcpContextService],
})
export class IntentAnchorModule {}
