/**
 * Cross-Repo Tools
 *
 * MCP tools for tracing cross-repository calls and finding service dependencies
 * between repos. Tool descriptions and parameter schemas come from @coredoc/mcp
 * so this cloud surface stays identical to the local stdio server.
 */

import { Injectable } from '@nestjs/common';
import { toolAnnotations } from '@coredoc/mcp';
import { Tool } from '@rekog/mcp-nest';
import type { Request } from 'express';
import type { Context } from '@rekog/mcp-nest';

import { handleTraceCrossRepoCall, handleListServiceDependencies } from '@coredoc/mcp/tools';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '@coredoc/mcp';

import { BaseCoredocTool } from './base-tool.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

@Injectable()
export class CrossRepoTools extends BaseCoredocTool {
  constructor(wsContext: WorkspaceMcpContextService, metricsService: MetricsService) {
    super(wsContext, metricsService);
  }

  // list_service_dependencies is list-shaped; trace_cross_repo_call's misses
  // ("No cross-repo calls found to ...") don't match the shared "not found in
  // scope" pattern, so both fall through the shared classifier's array/miss
  // checks and trace_cross_repo_call naturally stays null (never guessed).
  protected override resultCountOf(result: unknown): number | null {
    return this.classifyListOrMiss(result);
  }

  @Tool({
    name: 'trace_cross_repo_call',
    annotations: toolAnnotations('trace_cross_repo_call'),
    description: TOOL_DESCRIPTIONS.trace_cross_repo_call,
    parameters: TOOL_SCHEMAS.trace_cross_repo_call,
  })
  async traceCrossRepoCall(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('trace_cross_repo_call', args, request, (ctx) =>
      handleTraceCrossRepoCall(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'list_service_dependencies',
    annotations: toolAnnotations('list_service_dependencies'),
    description: TOOL_DESCRIPTIONS.list_service_dependencies,
    parameters: TOOL_SCHEMAS.list_service_dependencies,
  })
  async listServiceDependencies(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('list_service_dependencies', args, request, (ctx) =>
      handleListServiceDependencies(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }
}
