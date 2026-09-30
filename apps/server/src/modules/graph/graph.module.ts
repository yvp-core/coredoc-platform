/**
 * Graph Module
 *
 * REST parity layer over the parsed code graph — wraps the exact same
 * portable @coredoc/mcp handlers the MCP tools invoke, so the web UI sees
 * what agents see (see GraphService for the parity contract).
 *
 * WorkspaceMcpContextService is declared here (not imported from McpModule,
 * which does not export it) to keep this module independent of MCP transport
 * wiring — global-constraints.md forbids touching mcp.module.ts / the MCP
 * transport surface for this PR. The service itself only depends on
 * WorkspaceDbPoolService + ControlPlaneService (both from the @Global()
 * DatabaseModule), so a second instance here is a plain DI provider, not a
 * duplicate of any MCP-specific state.
 */

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { WorkspaceMcpContextService } from '../../mcp/workspace-mcp-context.service.js';
import { GraphController } from './graph.controller.js';
import { GraphService } from './graph.service.js';
import { GraphRateLimitGuard } from './graph-rate-limit.guard.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [GraphController],
  providers: [GraphService, WorkspaceMcpContextService, GraphRateLimitGuard],
})
export class GraphModule {}
