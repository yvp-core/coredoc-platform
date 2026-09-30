/**
 * Impact Analysis Tools
 *
 * MCP tools for analyzing code change impact, finding callers, dependents, and
 * entity consumers. Tool descriptions and parameter schemas come from
 * @coredoc/mcp so this cloud surface stays identical to the local stdio server.
 */

import { Injectable } from '@nestjs/common';
import { toolAnnotations } from '@coredoc/mcp';
import { Tool } from '@rekog/mcp-nest';
import type { Request } from 'express';
import type { Context } from '@rekog/mcp-nest';

import {
  handleAnalyzeChangeImpact,
  handleFindCallers,
  handleFindDependents,
  handleFindEntityUsage,
} from '@coredoc/mcp/tools';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '@coredoc/mcp';

import { BaseCoredocTool } from './base-tool.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

@Injectable()
export class ImpactTools extends BaseCoredocTool {
  constructor(wsContext: WorkspaceMcpContextService, metricsService: MetricsService) {
    super(wsContext, metricsService);
  }

  // find_callers / find_dependents / find_entity_usage are list-shaped (or
  // single-entity-with-a-miss-message) — see BaseCoredocTool.classifyListOrMiss.
  // analyze_change_impact never returns an array or a "not found in scope"
  // string, so it naturally classifies as null.
  protected override resultCountOf(result: unknown): number | null {
    return this.classifyListOrMiss(result);
  }

  @Tool({
    name: 'analyze_change_impact',
    annotations: toolAnnotations('analyze_change_impact'),
    description: TOOL_DESCRIPTIONS.analyze_change_impact,
    parameters: TOOL_SCHEMAS.analyze_change_impact,
  })
  async analyzeChangeImpact(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('analyze_change_impact', args, request, (ctx) =>
      handleAnalyzeChangeImpact(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'find_callers',
    annotations: toolAnnotations('find_callers'),
    description: TOOL_DESCRIPTIONS.find_callers,
    parameters: TOOL_SCHEMAS.find_callers,
  })
  async findCallers(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('find_callers', args, request, (ctx) =>
      handleFindCallers(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'find_dependents',
    annotations: toolAnnotations('find_dependents'),
    description: TOOL_DESCRIPTIONS.find_dependents,
    parameters: TOOL_SCHEMAS.find_dependents,
  })
  async findDependents(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('find_dependents', args, request, (ctx) =>
      handleFindDependents(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'find_entity_usage',
    annotations: toolAnnotations('find_entity_usage'),
    description: TOOL_DESCRIPTIONS.find_entity_usage,
    parameters: TOOL_SCHEMAS.find_entity_usage,
  })
  async findEntityUsage(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('find_entity_usage', args, request, (ctx) =>
      handleFindEntityUsage(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }
}
