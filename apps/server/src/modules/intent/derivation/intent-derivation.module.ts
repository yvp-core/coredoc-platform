/**
 * Derivation half of the cloud intent service (spec §6).
 *
 * Self-contained on purpose: it exports {@link IntentDerivationService} and
 * imports nothing from the rest of the intent module, so the context read
 * depends on it without this module having to know that it exists.
 *
 * `WorkspaceMcpContextService` is DECLARED here rather than imported from
 * `McpModule` (which does not export it), following `GraphModule`'s precedent:
 * the service's own dependencies come from the `@Global()` `DatabaseModule`, so
 * a second provider instance is plain DI, not duplicated state, and this module
 * stays independent of MCP transport wiring.
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../../database/database.module.js';
import { WorkspaceMcpContextService } from '../../../mcp/workspace-mcp-context.service.js';
import { IntentDerivationService } from './intent-derivation.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [WorkspaceMcpContextService, IntentDerivationService],
  exports: [IntentDerivationService],
})
export class IntentDerivationModule {}
