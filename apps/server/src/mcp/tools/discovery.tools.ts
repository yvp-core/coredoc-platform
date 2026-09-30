/**
 * Discovery Tools
 *
 * MCP tools for finding code elements, listing entrypoints, getting repository
 * overviews, and describing DB schemas. Tool descriptions and parameter schemas
 * come from @coredoc/mcp so this cloud surface stays identical to the local
 * stdio server.
 */

import { Injectable } from '@nestjs/common';
import { toolAnnotations } from '@coredoc/mcp';
import { Tool } from '@rekog/mcp-nest';
import type { Request } from 'express';
import type { Context } from '@rekog/mcp-nest';

import {
  handleSearchSymbols,
  handleListEntrypoints,
  handleDescribeRepository,
  handleDescribeDbSchema,
  handleGetExtractionCoverage,
} from '@coredoc/mcp/tools';
import { TOOL_DESCRIPTIONS, TOOL_SCHEMAS } from '@coredoc/mcp';

import { BaseCoredocTool } from './base-tool.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

@Injectable()
export class DiscoveryTools extends BaseCoredocTool {
  constructor(wsContext: WorkspaceMcpContextService, metricsService: MetricsService) {
    super(wsContext, metricsService);
  }

  // search_symbols / list_entrypoints / get_extraction_coverage / describe_db_schema
  // are list-shaped (or single-entity-with-a-miss-message) — see
  // BaseCoredocTool.classifyListOrMiss. describe_repository never returns an
  // array or a "not found in scope" string, so it naturally classifies as null.
  protected override resultCountOf(result: unknown): number | null {
    return this.classifyListOrMiss(result);
  }

  @Tool({
    name: 'search_symbols',
    annotations: toolAnnotations('search_symbols'),
    description: TOOL_DESCRIPTIONS.search_symbols,
    parameters: TOOL_SCHEMAS.search_symbols,
  })
  async searchSymbols(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('search_symbols', args, request, (ctx) =>
      handleSearchSymbols(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'list_entrypoints',
    annotations: toolAnnotations('list_entrypoints'),
    description: TOOL_DESCRIPTIONS.list_entrypoints,
    parameters: TOOL_SCHEMAS.list_entrypoints,
  })
  async listEntrypoints(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('list_entrypoints', args, request, (ctx) =>
      handleListEntrypoints(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'describe_repository',
    annotations: toolAnnotations('describe_repository'),
    description: TOOL_DESCRIPTIONS.describe_repository,
    parameters: TOOL_SCHEMAS.describe_repository,
  })
  async describeRepository(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('describe_repository', args, request, (ctx) =>
      handleDescribeRepository(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'describe_db_schema',
    annotations: toolAnnotations('describe_db_schema'),
    description: TOOL_DESCRIPTIONS.describe_db_schema,
    parameters: TOOL_SCHEMAS.describe_db_schema,
  })
  async describeDbSchema(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('describe_db_schema', args, request, (ctx) =>
      handleDescribeDbSchema(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }

  @Tool({
    name: 'get_extraction_coverage',
    annotations: toolAnnotations('get_extraction_coverage'),
    description: TOOL_DESCRIPTIONS.get_extraction_coverage,
    parameters: TOOL_SCHEMAS.get_extraction_coverage,
  })
  async getExtractionCoverage(args: Record<string, unknown>, _context: Context, request: Request) {
    return this.executeWithMetrics('get_extraction_coverage', args, request, (ctx) =>
      handleGetExtractionCoverage(args, ctx.scope, ctx.format, ctx.detailLevel, ctx.detailConfig, ctx.repository),
    );
  }
}
