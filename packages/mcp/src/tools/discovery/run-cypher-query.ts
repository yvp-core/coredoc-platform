/**
 * run_cypher_query Tool Handler — the read-only Cypher escape hatch.
 *
 * The fixed tool set answers the questions it anticipates; this one lets an
 * agent ask the graph directly (aggregations, custom traversals, ad-hoc joins).
 *
 * The read-only boundary is NOT enforced here: the allowlist guard runs inside
 * the repository methods, next to the engine that would execute the query, so
 * every caller of that capability inherits it (this handler, the REST canvas,
 * the hosted tool). This handler owns only the agent-facing contract — clamping
 * the cap, dispatching the requested shape, feature-detecting the capability,
 * and rendering the result while naming the backend that served it.
 */

import { getConfiguredBackend, CypherResultShape } from '@coredoc/db';
import type { IGraphReadRepository, IGraphCypherReadRepository, CypherRowsResult, CypherScalar } from '@coredoc/db';
import type { CypherGraphResult } from '@coredoc/core/types';
import { createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import type { ScopeContext, OutputFormat, McpResponse, DetailLevel, DetailLevelConfig } from '../../types.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * How many rows the SUMMARY rendering prints. The full result is always within
 * `limit`; this only bounds the prose so a 500-row answer doesn't drown the
 * context — the response says how many were withheld and how to get them.
 */
const DISPLAY_ROW_CAP = 100;

/** How many node names the graph-shape summary names before counting the rest. */
const DISPLAY_NODE_CAP = 20;

/**
 * Errors raised by the repository's read-only guard are already agent-actionable
 * (they name the rejected clause / the scalar-cell contract), so they surface
 * verbatim instead of being re-wrapped with an unhelpful outer sentence.
 */
function isGuardRejection(message: string): boolean {
  return (
    /read-only/i.test(message) || /scalar cells only/i.test(message) || /source-in-graph is disabled/i.test(message)
  );
}

/** Cypher params, filtered to the scalar wire contract the repository accepts. */
function scalarParams(raw: unknown): Record<string, CypherScalar> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `Cypher "params" must be an object/map of scalars (string, number, boolean, or null values) — received ${
        Array.isArray(raw) ? 'an array' : typeof raw
      }.`,
    );
  }
  const params: Record<string, CypherScalar> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params[key] = value;
      continue;
    }
    throw new Error(
      `Cypher parameter "${key}" is not a scalar (${typeof value}). Only string, number, boolean and null parameters are supported — inline the structure into the query instead.`,
    );
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function renderRows(result: CypherRowsResult, backend: string, limit: number): string {
  const shown = result.rows.slice(0, DISPLAY_ROW_CAP);
  const header = result.columns.join(' | ');
  const body = shown.map((row) => row.map((cell) => (cell === null ? 'null' : String(cell))).join(' | '));
  const lines = [
    `Cypher rows via ${backend} — ${result.rows.length} row(s), limit ${limit}`,
    '',
    header,
    '-'.repeat(Math.max(header.length, 3)),
    ...body,
  ];
  if (result.rows.length > shown.length) {
    lines.push(
      '',
      `(${result.rows.length - shown.length} more row(s) not printed — re-run with format: "raw" for the full table.)`,
    );
  }
  if (result.truncated) {
    lines.push(
      '',
      `Truncated at the ${limit}-row cap — more rows matched. Paginate in-query with a stable ORDER BY plus SKIP/LIMIT.`,
    );
  }
  return lines.join('\n');
}

function renderGraph(result: CypherGraphResult, backend: string, limit: number): string {
  const named = result.nodes.slice(0, DISPLAY_NODE_CAP);
  const lines = [
    `Cypher subgraph via ${backend} — ${result.nodes.length} node(s), ${result.edges.length} edge(s), limit ${limit}`,
    '',
    ...named.map((node) => `- ${node.name} (${node.type})${node.filePath ? ` — ${node.filePath}` : ''}`),
  ];
  if (result.nodes.length > named.length) {
    lines.push(`- …and ${result.nodes.length - named.length} more node(s) — use format: "raw" for the full subgraph.`);
  }
  if (result.truncated) {
    lines.push(
      '',
      `Truncated at the ${limit}-node cap — more matched. Paginate in-query with a stable ORDER BY plus SKIP/LIMIT.`,
    );
  }
  return lines.join('\n');
}

// Engine complaints that mean "you used names this graph doesn't have":
// Ladybug/Kùzu Binder + Catalog exceptions, Neo4j's unknown-label warnings.
const VOCABULARY_ERROR_PATTERN =
  /Binder exception|Catalog exception|does not exist|Cannot find property|Unknown function/i;

/**
 * One line of graph vocabulary, appended when the engine rejected the query's
 * NAMES rather than its syntax. Measured agent misses all came from guessing a
 * property-graph schema that this graph doesn't use: `(f:Function)`, `t.file`,
 * `type(r)`.
 */
function vocabularyHint(message: string): string {
  if (!VOCABULARY_ERROR_PATTERN.test(message)) return '';
  return (
    '\n\nGraph vocabulary: every node is labelled `GraphNode` — the kind is the `type` property (`n.type = "function"`), ' +
    'not the label, so `(f:Function)` matches nothing. The file is `filePath`, not `file`. Write the relationship type ' +
    'into the pattern (`-[:CALLS]->`) and read it back with `label(r)`; there is no `type(r)`. ' +
    'Call describe_db_schema for the full field-level schema.'
  );
}

/**
 * Handle run_cypher_query.
 *
 * Registration is gated per surface (local: Ladybug, or Neo4j with the operator
 * opt-in), so reaching this handler already means the deployment allows Cypher —
 * but the CAPABILITY still has to be feature-detected, because the optional
 * repository methods are the only honest signal that this graph can serve it.
 */
export async function handleRunCypherQuery(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
  /**
   * The authoritative backend name to report, overriding the server-process
   * default. Local/stdio has one process-wide backend, so `getConfiguredBackend()`
   * is honest there; the hosted surface serves many workspaces from one process,
   * so the caller supplies the per-workspace backend (`ctx.graphBackend`) instead.
   */
  backendOverride?: string,
): Promise<McpResponse<unknown>> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    throw new Error('Must specify "query" — a single read-only Cypher statement.');
  }

  const requested = Math.floor(Number(args.limit));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;
  const shape = args.resultShape === CypherResultShape.Graph ? CypherResultShape.Graph : CypherResultShape.Rows;
  const params = scalarParams(args.params);

  const repo = repository as IGraphCypherReadRepository;
  const backend = backendOverride ?? getConfiguredBackend();
  const method = shape === CypherResultShape.Graph ? 'runReadOnlyCypher' : 'runReadOnlyCypherRows';
  if (typeof repo[method] !== 'function') {
    throw new Error(
      `The "${backend}" graph backend cannot serve Cypher in the "${shape}" shape — it does not implement \`${method}\`. ` +
        'Cypher needs a graph-native backend (ladybug locally, or neo4j); on sqlite/turso use the purpose-built tools instead.',
    );
  }

  const opts = { limit, ...(params ? { params } : {}) };
  debug('runCypher', `backend=${backend} shape=${shape} limit=${limit}`);

  let result: CypherRowsResult | CypherGraphResult;
  try {
    result =
      shape === CypherResultShape.Graph
        ? await repo.runReadOnlyCypher!(query, opts)
        : await repo.runReadOnlyCypherRows!(query, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Guard rejections already explain themselves; everything else gets the
    // serving backend attached so the agent knows whose engine complained,
    // plus the graph vocabulary when the engine rejected the query's names.
    if (isGuardRejection(message)) throw error;
    throw new Error(`Cypher query failed on the "${backend}" backend: ${message}${vocabularyHint(message)}`);
  }

  const isGraph = 'nodes' in result;
  debugResult(
    'runCypher',
    isGraph ? (result as CypherGraphResult).nodes.length : (result as CypherRowsResult).rows.length,
  );

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
  const resultCount = isGraph ? (result as CypherGraphResult).nodes.length : (result as CypherRowsResult).rows.length;

  if (format === 'raw') {
    return { data: { backend, shape, ...result }, metadata, resultCount };
  }

  return {
    data: isGraph
      ? renderGraph(result as CypherGraphResult, backend, limit)
      : renderRows(result as CypherRowsResult, backend, limit),
    metadata,
    resultCount,
  };
}
