/**
 * Base Tool Class
 *
 * Abstract base for all MCP tool classes. Provides shared context resolution
 * that converts a raw request + tool args into the repository, scope, format,
 * and detail-level config needed by @coredoc/mcp handler functions.
 */

import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { IGraphReadRepository } from '@coredoc/db';
import type { ScopeContext, OutputFormat, DetailLevel, DetailLevelConfig, McpResponseMetadata } from '@coredoc/mcp';
import { resolveDetailLevel, getDefaultDetailLevel, formatMcpContent } from '@coredoc/mcp';

import { WorkspaceMcpContextService, type WorkspaceContext } from '../workspace-mcp-context.service.js';
import type { GraphBackend } from '../../database/graph-backend.js';
import { resolveWorkspaceScope, resolveWorkspaceVantage } from '../workspace-scope-resolver.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

export interface ToolContext {
  repository: IGraphReadRepository;
  scope: ScopeContext;
  format: OutputFormat;
  detailLevel: DetailLevel;
  detailConfig: DetailLevelConfig;
  /** The workspace's graph backend, so a tool can name it in an error. */
  graphBackend: GraphBackend;
}

export abstract class BaseCoredocTool {
  private readonly logger = new Logger(BaseCoredocTool.name);

  constructor(
    protected readonly wsContext: WorkspaceMcpContextService,
    protected readonly metricsService: MetricsService,
  ) {}

  protected buildToolContext(
    args: Record<string, unknown>,
    request: Request,
    workspaceContext: WorkspaceContext,
    toolName?: string,
  ): ToolContext {
    const { repository, scope, repos, graphBackend } = workspaceContext;

    // If args.scope specifies a target repo, narrow within workspace
    let resolvedScope = scope;
    if (args.scope && typeof args.scope === 'string') {
      resolvedScope = resolveWorkspaceScope(repos, args.scope as string);
    } else {
      // No explicit scope: apply the per-request "vantage" (current repo) the
      // client sent via the X-Coredoc-Current-Repo header, if any. The cloud
      // analogue of the local server's COREDOC_CURRENT_REPO — a HINT, not a
      // boundary: it sharpens single-origin tools (list_service_dependencies)
      // and ranks the current repo first in search_symbols, but never narrows
      // what the workspace scope can see. An explicit `scope` arg (above)
      // overrides it. Silently ignored when it names a repo outside the
      // workspace (fail-soft).
      const headerValue = request.headers['x-coredoc-current-repo'];
      const signal = Array.isArray(headerValue) ? headerValue[0] : headerValue;
      if (signal) {
        const vantage = resolveWorkspaceVantage(repos, signal);
        if (vantage) {
          resolvedScope = { ...scope, ...vantage };
        }
      }
    }

    const format = ((args.format as string) || 'summary') as OutputFormat;
    // Per-tool default: explain resolves an omitted detailLevel to 'basic'
    // (compact previews), everything else to 'full' — same as the local server.
    const detailLevel = ((args.detailLevel as string) || getDefaultDetailLevel(toolName)) as DetailLevel;
    const detailConfig = resolveDetailLevel(detailLevel);

    return {
      repository,
      scope: resolvedScope,
      format,
      detailLevel,
      detailConfig,
      graphBackend,
    };
  }

  /**
   * Execute a tool handler with metrics recording.
   * Measures duration, records success/failure, and returns the formatted response.
   */
  protected async executeWithMetrics(
    toolName: string,
    args: Record<string, unknown>,
    request: Request,
    handler: (ctx: ToolContext) => Promise<{ data: unknown }>,
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const startTime = Date.now();
    const workspaceId = (request as unknown as Record<string, unknown>).workspaceId as string | undefined;
    const user = (request as unknown as Record<string, unknown>).user as { id?: string } | undefined;
    let scope: string | null = null;

    try {
      const completed = await this.wsContext.withContext(request, async (workspaceContext) => {
        const ctx = this.buildToolContext(args, request, workspaceContext, toolName);
        // "The" repo scope the tool resolved: the vantage repo (currentRepo)
        // when one applied, else a single explicitly narrowed repo.
        scope = ctx.scope.currentRepo ?? (ctx.scope.resolvedRepos.length === 1 ? ctx.scope.resolvedRepos[0] : null);
        const response = await handler(ctx);
        return { response, result: this.formatResponse(response) };
      });

      if (workspaceId) {
        this.metricsService
          .recordMcpQuery({
            workspaceId,
            toolName,
            userId: user?.id ?? null,
            durationMs: Date.now() - startTime,
            success: true,
            resultCount: this.safeResultCountOf(completed.response, toolName),
            scope,
          })
          .catch((err) => {
            // Best-effort write — never fails the tool call — but a swallowed
            // write outage must still be distinguishable from zero usage. No
            // counter infrastructure exists for MCP metrics; the log IS the
            // observability here.
            this.logger.warn(`Failed to record MCP query metric for ${toolName}: ${(err as Error)?.message ?? err}`);
          });
      }

      return completed.result;
    } catch (err) {
      if (workspaceId) {
        this.metricsService
          .recordMcpQuery({
            workspaceId,
            toolName,
            userId: user?.id ?? null,
            durationMs: Date.now() - startTime,
            success: false,
            resultCount: null,
            scope,
          })
          .catch((writeErr) => {
            this.logger.warn(
              `Failed to record MCP query metric for ${toolName}: ${(writeErr as Error)?.message ?? writeErr}`,
            );
          });
      }
      throw err;
    }
  }

  /**
   * Classify a handler's `{ data }` result into a metrics-facing result count.
   * Cloud tool handlers surface only `{ data }` here — no `resultCount` /
   * `isError` slot the way the local server's `McpResponse` return value
   * carries (`packages/mcp/src/server.ts:501-502`) — so this is a
   * re-implementation of that split, not a port, against the shapes the
   * cloud handlers actually produce:
   *   - list-shaped tools in `format: 'raw'` return their items as an array
   *     directly in `data` → its length (0 counts as an explicit empty list).
   *   - a single-entity miss is reported either as `data: []` (raw format) or
   *     as a "<kind> '<name>' not found in scope" string (other formats) → 0.
   *   - anything else (a hit, formatted markdown, an opaque object) → null,
   *     so an unclassifiable call never dilutes the empty-rate denominator.
   * Base default: null — tools that never override this classifier record no
   * result count, same as before this change.
   */
  protected resultCountOf(_result: unknown): number | null {
    return null;
  }

  /**
   * The classifier is a metrics-only side channel — a throwing override must
   * never fail the tool call it observes, so the guard lives here rather than
   * trusting every future subclass to stay exception-free.
   */
  private safeResultCountOf(response: unknown, toolName: string): number | null {
    try {
      return this.resultCountOf(response);
    } catch (err) {
      this.logger.warn(`resultCountOf threw for ${toolName}; recording null: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  /**
   * Shared classifier body for list-shaped tool subclasses — see
   * {@link resultCountOf}. Exposed as a protected helper (rather than baked
   * into the base default) so `resultCountOf` truly defaults to null for
   * tools that never call it, and subclasses opt in explicitly.
   */
  protected classifyListOrMiss(result: unknown): number | null {
    const data = (result as { data?: unknown } | undefined)?.data;
    if (Array.isArray(data)) return data.length;
    if (typeof data === 'string' && /not found in scope\.?$/.test(data.trim())) return 0;
    return null;
  }

  /**
   * Wrap a handler response as an MCP content block.
   * Returns the `{ content: [...] }` shape so MCP-Nest passes it through
   * without re-encoding (avoids double JSON.stringify on string results).
   */
  protected formatResponse(response: {
    data: unknown;
    metadata?: Pick<McpResponseMetadata, 'staleness' | 'warnings'>;
  }): { content: { type: 'text'; text: string }[] } {
    return { content: formatMcpContent(response, 2) };
  }
}
