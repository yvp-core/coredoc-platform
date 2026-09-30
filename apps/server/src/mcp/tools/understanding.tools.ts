/**
 * Understanding Tools
 *
 * MCP tools for understanding code: the unified `explain` entry point (it routes
 * functions, entrypoints, and structural types to the right handler internally).
 * Tool descriptions and parameter schemas come from @coredoc/mcp so this cloud
 * surface stays identical to the local stdio server.
 */

import { Injectable } from '@nestjs/common';
import { toolAnnotations } from '@coredoc/mcp';
import { Tool } from '@rekog/mcp-nest';
import type { Request } from 'express';
import type { Context } from '@rekog/mcp-nest';

import { handleExplain } from '@coredoc/mcp/tools';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '@coredoc/mcp';

import { BaseCoredocTool } from './base-tool.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

@Injectable()
export class UnderstandingTools extends BaseCoredocTool {
  constructor(wsContext: WorkspaceMcpContextService, metricsService: MetricsService) {
    super(wsContext, metricsService);
  }

  @Tool({
    name: 'explain',
    annotations: toolAnnotations('explain'),
    description: TOOL_DESCRIPTIONS.explain,
    parameters: TOOL_SCHEMAS.explain,
  })
  async explain(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('explain', args, request, (ctx) =>
      handleExplain(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }
}
