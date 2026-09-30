/**
 * Hosted `run_cypher_query` — the read-only Cypher escape hatch on the cloud MCP.
 *
 * Two things differ from the local stdio surface:
 *
 * 1. REGISTRATION IS STATIC. `@Tool` decorators are evaluated once per process,
 *    but the graph backend is a per-WORKSPACE fact — one deployment serves both
 *    Turso and file-snapshot workspaces — so listing cannot be the gate. The
 *    tool is always listed and every call is gated instead: operator opt-in
 *    first, then feature detection on the leased workspace repository.
 *
 * 2. IT CATCHES ITS OWN ERRORS. `executeWithMetrics` rethrows, and a throw from
 *    a tool method escapes into mcp-nest as a transport-level failure. A
 *    workspace whose graph simply cannot speak Cypher is not a server fault —
 *    it is an answer the agent must be able to read, so every failure comes back
 *    as an `isError` content block. The catch sits AROUND `executeWithMetrics`,
 *    not inside the handler callback, so the existing failure path still records
 *    the call as `success: false` before the error is rendered.
 *
 * Hosted graphs are Turso or file-snapshot Ladybug only (Neo4j is unreachable
 * through the workspace context), so the description documents the Ladybug/Kùzu
 * dialect and nothing else.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { STORAGE_CONFIG, type StorageConfig, storageConfigFromEnv } from '../../config/app-config.js';
import { Tool } from '@rekog/mcp-nest';
import type { Context } from '@rekog/mcp-nest';
import type { Request } from 'express';

import { CypherResultShape, type IGraphCypherReadRepository } from '@coredoc/db';
import { handleRunCypherQuery } from '@coredoc/mcp/tools';
import { buildCypherDescription, TOOL_SCHEMAS, toolAnnotations } from '@coredoc/mcp';

import { BaseCoredocTool, type ToolContext } from './base-tool.js';
import { WorkspaceMcpContextService } from '../workspace-mcp-context.service.js';
import { MetricsService } from '../../modules/metrics/metrics.service.js';

const TOOL_NAME = 'run_cypher_query';

/** Hosted serves the Ladybug/Kùzu shape only — a Neo4j graph never reaches here. */
export const HOSTED_CYPHER_DESCRIPTION = buildCypherDescription({ dialects: ['ladybug'] });

/**
 * Operator opt-in. Raw Cypher is not narrowed by `scope.repoHashes` the way
 * every other tool is, so exposing it is a deployment decision, not a default.
 * Fail closed: only the exact string `'true'` enables it.
 */
function assertCypherOptIn(allowCypher: boolean): void {
  if (allowCypher) return;
  throw new Error(
    'Cypher querying is not enabled for this deployment. run_cypher_query stays behind an operator opt-in ' +
      '(COREDOC_ALLOW_CYPHER=true) because a raw Cypher query is not repo-filtered within the graph it reads. ' +
      'Ask your operator to enable it, or use the purpose-built tools (search_symbols, describe_repository, …).',
  );
}

/**
 * Feature-detect the capability on the LEASED repository — the facade carries
 * the optional Cypher methods only when the underlying graph implements them,
 * so their absence is the honest signal that this workspace's plane (Turso)
 * has no Cypher engine behind it.
 */
function assertCypherCapable(ctx: ToolContext, shape: CypherResultShape): void {
  const method = shape === CypherResultShape.Graph ? 'runReadOnlyCypher' : 'runReadOnlyCypherRows';
  const repository = ctx.repository as IGraphCypherReadRepository;
  if (typeof repository[method] === 'function') return;
  throw new Error(
    `This workspace's "${ctx.graphBackend}" graph backend cannot serve Cypher in the "${shape}" shape — ` +
      `it does not implement \`${method}\`. Hosted Cypher needs a graph-native workspace graph ` +
      '(the Ladybug/Kùzu file plane); on turso use the purpose-built tools instead.',
  );
}

function requestedShape(args: Record<string, unknown>): CypherResultShape {
  return args.resultShape === CypherResultShape.Graph ? CypherResultShape.Graph : CypherResultShape.Rows;
}

@Injectable()
export class CypherTools extends BaseCoredocTool {
  constructor(
    wsContext: WorkspaceMcpContextService,
    metricsService: MetricsService,
    @Optional() @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig = storageConfigFromEnv(),
  ) {
    super(wsContext, metricsService);
  }

  /**
   * The handler already computes the row/node count for its own response; reuse
   * it rather than re-deriving a count from rendered prose.
   */
  protected override resultCountOf(result: unknown): number | null {
    const count = (result as { resultCount?: unknown } | undefined)?.resultCount;
    return typeof count === 'number' ? count : null;
  }

  @Tool({
    name: TOOL_NAME,
    annotations: toolAnnotations(TOOL_NAME),
    description: HOSTED_CYPHER_DESCRIPTION,
    parameters: TOOL_SCHEMAS.run_cypher_query,
  })
  async runCypherQuery(
    args: Record<string, unknown>,
    _context: Context,
    request: Request,
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    try {
      return await this.executeWithMetrics(TOOL_NAME, args, request, (ctx) => {
        assertCypherOptIn(this.storage.allowCypher);
        assertCypherCapable(ctx, requestedShape(args));
        return handleRunCypherQuery(
          args,
          ctx.scope,
          ctx.format,
          ctx.detailLevel,
          ctx.detailConfig,
          ctx.repository,
          ctx.graphBackend,
        );
      });
    } catch (error) {
      // Gating refusals, guard rejections and engine failures alike: the agent
      // can act on all of them, and none of them is a transport fault.
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }
}
