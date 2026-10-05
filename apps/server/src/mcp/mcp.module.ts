/**
 * Coredoc MCP Module
 *
 * Provides MCP Streamable HTTP endpoints for workspace-scoped code graph queries.
 * Uses @rekog/mcp-nest for decorator-based tool registration, automatic transport
 * management, and guard integration.
 *
 * Tools delegate to @coredoc/mcp handler functions, keeping the portable MCP
 * library working for CLI/stdio mode while adding NestJS DI for server mode.
 */

import { Module } from '@nestjs/common';
import { McpModule as McpNestModule, type McpOptions, McpTransportType } from '@rekog/mcp-nest';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MetricsCoreModule } from '../modules/metrics/metrics.module.js';
import { FeedbackModule } from '../modules/feedback/feedback.module.js';
import { IntentAnchorModule } from '../modules/intent/intent-anchor.module.js';
import { IntentModule } from '../modules/intent/intent.module.js';
import { SessionFeedbackTools } from './tools/feedback.tools.js';

import { McpRewriteMiddleware } from './mcp-rewrite.middleware.js';
import { McpTrustedContextGuard } from './mcp-trusted-context.guard.js';
import { IntentEnabledToolGuard } from './intent-enabled.tool-guard.js';
import { McpDiscoveryController } from './mcp-discovery.controller.js';
import { WorkspaceMcpContextService } from './workspace-mcp-context.service.js';
import { restrictToToolset } from './mcp-toolset.js';

import { ImpactTools } from './tools/impact.tools.js';
import { UnderstandingTools } from './tools/understanding.tools.js';
import { DiscoveryTools } from './tools/discovery.tools.js';
import { CrossRepoTools } from './tools/cross-repo.tools.js';
import { CypherTools } from './tools/cypher.tools.js';
import { IntentTools } from './tools/intent.tools.js';

/** The MCP-Nest options, exported so the transport tests run the same server configuration. */
export const MCP_SERVER_OPTIONS: McpOptions = {
  name: 'coredoc',
  version: '1.0.0',
  transport: [McpTransportType.STREAMABLE_HTTP, McpTransportType.SSE],
  // Token + workspace-membership auth is performed by McpRewriteMiddleware,
  // which only runs for /api/v1/workspaces/:id/mcp. The transport
  // controllers, though, are mounted at the root /mcp,/sse,/messages paths,
  // so McpTrustedContextGuard runs on every transport route and rejects any
  // direct hit that lacks the trusted context the middleware attaches —
  // closing the direct-path auth bypass. The guard is dependency-free by
  // design: a guard injecting AuthService can't resolve in MCP-Nest's
  // dynamic controller scope, which is why the heavy auth stays in the
  // middleware.
  guards: [McpTrustedContextGuard],
  streamableHttp: {
    enableJsonResponse: false,
    statelessMode: true,
  },
  serverMutator: restrictToToolset,
};

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    MetricsCoreModule,
    FeedbackModule,
    // The intent tools serve the SAME services the REST intent routes do, so
    // the two surfaces cannot drift. Registration is unconditional (spec §11).
    // `IntentAnchorModule` is imported directly rather than re-exported through
    // `IntentModule`: `intent_anchor` needs exactly one provider out of it, and
    // a module import is idempotent — Nest instantiates it once whichever
    // importer names it first.
    IntentModule,
    IntentAnchorModule,
    McpNestModule.forRoot(MCP_SERVER_OPTIONS),
  ],
  controllers: [McpDiscoveryController],
  providers: [
    WorkspaceMcpContextService,
    McpTrustedContextGuard,
    McpRewriteMiddleware,
    IntentEnabledToolGuard,
    ImpactTools,
    UnderstandingTools,
    DiscoveryTools,
    CrossRepoTools,
    CypherTools,
    IntentTools,
    SessionFeedbackTools,
  ],
  exports: [McpRewriteMiddleware],
})
export class McpModule {}
