/**
 * MCP Server Implementation
 *
 * Model Context Protocol server that provides AI agents with structured
 * access to parsed codebase data stored in Neo4j or SQLite.
 */

import { existsSync } from 'node:fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  registerExitHandlers,
  isDatabaseAvailable,
  getConfiguredBackend,
  getRepository,
  openProjectDatabase,
} from '@coredoc/db';
import type { IGraphReadRepository, McpMetricsRepository, ProjectDatabase } from '@coredoc/db';
import { semanticSearchEnabled, getTelemetryConfig } from '@coredoc/core/utils';
import { EventName, initTelemetry, newInvocationId, repoId, shutdownTelemetry, track } from '@coredoc/core/telemetry';
import { BUNDLED_POSTHOG_KEY, BUNDLED_POSTHOG_HOST } from './build-env.js';
import { MCP_VERSION } from './version.js';
import { computeCommitsStale, commitHashFromSummary } from './commits-stale.js';
import { resolveScope, resolveVantageRepo, loadConfig, isScopeBound } from './scope-resolver.js';
import { resolveDetailLevel, getDefaultDetailLevel } from './detail-level.js';
import { TOOL_DESCRIPTIONS, buildCypherDescription, type CypherDialect } from './tool-descriptions.js';
import { TOOL_INPUT_SCHEMAS, TOOL_SCHEMAS } from './tool-schemas.js';
import { toolAnnotations } from './tool-classes.js';
import { formatMcpContent } from './response-formatter.js';
import type { OutputFormat, ScopeContext, McpResponse, DetailLevel, DetailLevelConfig } from './types.js';

// Import tool handlers
import { handleAnalyzeChangeImpact } from './tools/impact/analyze-change-impact.js';
import { handleFindCallers } from './tools/impact/find-callers.js';
import { handleFindDependents } from './tools/impact/find-dependents.js';
import { handleFindEntityUsage } from './tools/impact/find-entity-usage.js';
import { handleExplain } from './tools/understanding/explain.js';
import { handleSearchSymbols } from './tools/discovery/search-symbols.js';
import { handleSemanticSearch } from './tools/discovery/semantic-search.js';
import { handleRunCypherQuery } from './tools/discovery/run-cypher-query.js';
import { handleListFileSymbols } from './tools/discovery/list-file-symbols.js';
import { handleListEntrypoints } from './tools/discovery/list-entrypoints.js';
import { handleDescribeRepository } from './tools/discovery/describe-repository.js';
import { handleDescribeDbSchema } from './tools/discovery/describe-db-schema.js';
import { handleGetExtractionCoverage } from './tools/discovery/get-extraction-coverage.js';
import { handleGetIntentContext } from './tools/intent/get-intent-context.js';
import { handleIntentRead } from './tools/intent/intent-read.js';
import { handleTraceCrossRepoCall } from './tools/cross-repo/trace-cross-repo-call.js';
import { handleListServiceDependencies } from './tools/cross-repo/list-service-dependencies.js';

// =============================================================================
// Shared Schema Definitions
// =============================================================================

/**
 * Detail level parameter schema - shared across all tools
 */
// list_file_symbols is list-shaped, so it is basic-by-default like every other
// list tool (see BASIC_BY_DEFAULT_TOOLS in detail-level.ts). Wording kept in
// step with DETAIL_LEVEL_BASIC_DEFAULT in tool-schemas.ts.
const DETAIL_LEVEL_SCHEMA = {
  type: 'string',
  enum: ['basic', 'full'],
  description:
    'Response granularity: basic (id, name, repo, file:line — the DEFAULT) or full (adds AI summaries, refs, callees, line ranges). Stay on the default for outline questions; re-call with "full" only for the specific symbols whose behaviour you must understand.',
};

// =============================================================================
// Tool Definitions
// =============================================================================

/**
 * Build a tool definition for a tool whose description + schema are shared with
 * the cloud MCP server (single source of truth in @coredoc/mcp).
 */
const sharedTool = (name: keyof typeof TOOL_INPUT_SCHEMAS) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  inputSchema: TOOL_INPUT_SCHEMAS[name],
});

/**
 * semantic_search — LOCAL-ONLY and env-gated (ENABLE_SEMANTIC_SEARCH). Like
 * every local-only tool, its description + schema live here at the single
 * definition site (see the tool-descriptions.ts header rule). The TOOLS /
 * TOOL_HANDLERS entries exist only when the capability flag is on, evaluated
 * once at module load — the SOURCE_PARAM pattern extended to a whole tool, so
 * a disabled deployment never even lists it.
 */
const SEMANTIC_SEARCH_TOOL = {
  name: 'semantic_search',
  description:
    'Search by MEANING over the AI-generated summaries of functions and entrypoints. Your natural-language query is embedded with the same provider/model that embedded the graph, then cosine-ranked against the stored summary vectors — so it answers concept questions ("where do we rotate auth tokens?") that name-based search_symbols cannot. Returns ranked symbols (name, kind, file:line, similarity, one-line summary). It searches the semantic space of AI summaries ONLY — it does not search and never returns source code. Requires embeddings in the graph: when none are stored for the scope it returns guidance to run `coredoc embed` and re-push, not an error.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural-language description of the code you are looking for (a concept, behavior, or responsibility — not a symbol name).',
      },
      scope: {
        type: 'string',
        description:
          'Target repository: a repo name ("server-api"), a "project/repo" qualified name ("coredoc/server-api"), or a filesystem path. Auto-detected from the working directory if omitted. An unresolvable scope hard-errors (it never silently falls back to another repo). A bare repo name that exists in more than one project is rejected as ambiguous — use the "project/repo" form to disambiguate; the error lists the valid project/repo tokens.',
      },
      limit: { type: 'number', description: 'Max results (default: 10, max: 25)' },
    },
    required: ['query'],
  },
};

/**
 * get_intent_context — LOCAL-ONLY and PERMANENT (no env gate).
 *
 * Its description + schema are authored here, at the single definition site,
 * and deliberately NOT in tool-descriptions.ts / tool-schemas.ts: that shared
 * registry is what the cloud NestJS surface iterates, so absence from it is the
 * mechanism that keeps the pilot's product intent local (LIM-1, spec
 * "Contracts and consumers").
 */
/**
 * intent_read — listed locally only to refuse with a reason (see
 * `tools/intent/intent-read.ts`); the cloud tool's real schema lives with the
 * cloud server.
 */
const INTENT_READ_TOOL = {
  name: 'intent_read',
  description:
    'Cloud workspace only. On a local project this answers with an explicit refusal and points to get_intent_context; on a project cut over to a cloud workspace, call intent_read on the workspace MCP.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
};

const GET_INTENT_CONTEXT_TOOL = {
  name: 'get_intent_context',
  description:
    'Return the project\'s REVIEWED product intent that applies to your task — capabilities, use cases, flows, business rules, limitations, and decisions a maintainer accepted — together with the current state of the code they are anchored to. Use it before planning or reviewing to learn the rules and non-goals the code alone does not state. Pass `intentIds` when a plan or handoff already routed exact ids (cheapest path, and the only way to retrieve a rejected or superseded item), `query` for a bounded lexical search over intent text, and/or `nodeIds` to find the intent anchored to a specific code node (an anchor on the enclosing class or file matches too, and a file id matches anchors on that file\'s members). Add `domain` to narrow any of that to one declared product area; every returned item reports its own `domain`, so one response tells you which areas exist. Defaults are compact and return ACCEPTED items only; candidates require `includeCandidates: true`. Every response reports authority, per-anchor `anchorStatus` (matched/changed/missing), and per-repo `snapshotFreshness` (current/stale/unknown/unverified — `unverified` means no observed checkout was supplied, so nothing was compared) INDEPENDENTLY — a matched anchor on a stale graph does not mean \'unaffected\', and a code anchor is an implementation touchpoint, never proof that the intent is satisfied. When the project has no overlay the response is `not_configured` (not an error), when the file is invalid it is `invalid` with paths, and when the local graph is unavailable the intent is still returned with `evidence.available: false`. ALWAYS pass at least one selector (`intentIds`, `query`, or `nodeIds`): a call with none returns every accepted item up to the limit — the broadest read there is — and one broad lookup per task stage is the budget; follow up by exact ids the response returned instead of searching again. To ORIENT first, call `mode: "list"`: it returns the declared domains plus the matching items as ids + titles only (no payloads, no anchors) — the cheapest call there is — so browse the index (optionally `format: "ids"`, `domain`, `kind`), then fetch the exact ids you need with the default context mode. Never read `.coredoc/intent.json` directly — this tool and the intent CLI are the only read surfaces; the raw file lacks anchor status and freshness. Once the project is cut over to a cloud workspace this tool refuses and names the workspace: call the workspace MCP `get_intent_context` instead.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['context', 'list'],
        description:
          'Which read to perform. "context" (default) returns applicable intent with payloads and code-anchor evidence. "list" returns the payload-free index — the domain registry plus id/title/kind/domain/authority per item — for orienting before an exact-id fetch. List mode takes only `domain`, `kind`, `includeCandidates`, and `format`; passing `intentIds`, `query`, or `nodeIds` there is an ERROR, not an ignored argument.',
      },
      format: {
        type: 'string',
        enum: ['index', 'ids'],
        description:
          'LIST MODE ONLY. "index" (default) returns id + title + kind + domain + authority per item; "ids" returns bare slug ids for a follow-up exact-id fetch.',
      },
      kind: {
        type: 'string',
        enum: ['capability', 'use_case', 'flow', 'business_rule', 'limitation', 'decision'],
        description:
          'LIST MODE ONLY. Restrict the index to one semantic kind; composes with `domain`. An unknown kind is an ERROR naming the valid ones.',
      },
      intentIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact intent ids — kind-prefixed slugs, e.g. ["br-refund-window", "cap-widget-ordering"]. Wins over `query` and is never narrowed by `domain`; the only way to fetch a rejected or superseded item.',
      },
      query: {
        type: 'string',
        description:
          'Bounded lexical search over intent titles, statements, and typed payload text. Matching is substring and case-insensitive: every whitespace-separated word must appear (AND), and ONLY when that conjunction matches nothing does it re-match on any single word, ranked by how many words each item hit. Deterministic — there is no fuzzy, stemming, or semantic layer, so a misspelling still matches nothing.',
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Stable code node ids, e.g. "40080b8c38fc:function:src/formatting/money.ts:roundCurrency"; returns the intent items whose stored code anchors reference them. A bare file path is NOT a node id — take ids from coredoc tool responses; a guessed id matches nothing. Anchors on an ENCLOSING scope match too, so a method id also finds intent anchored to its class or its file (not the reverse).',
      },
      domain: {
        type: 'string',
        description:
          'Declared product-area id (e.g. "ordering"). Returns only that area\'s items and composes with `query`/`nodeIds`; exact `intentIds` are exempt. An id the overlay does not declare is an ERROR naming the declared ones — never an empty result. Read the `domain` field of any response, or run `coredoc intent status`, to learn the declared ids.',
      },
      includeCandidates: {
        type: 'boolean',
        description:
          'Include `candidate` (proposed, not yet reviewed) items. Default false — a candidate is never authoritative and cannot ground a blocking finding.',
      },
      limit: {
        type: 'number',
        description:
          'Max items (1..20, default 5; omitted alongside `intentIds`, it covers every id you named). Truncation is reported explicitly.',
      },
      // NOT the shared DETAIL_LEVEL_SCHEMA: the code-graph wording ("AI
      // summaries, refs, callees; default: full") is wrong for this tool in
      // both dimensions — intent has no such fields, and this tool is
      // compact-by-default (see BASIC_BY_DEFAULT_TOOLS in detail-level.ts).
      detailLevel: {
        type: 'string',
        enum: ['basic', 'full'],
        description:
          'Response granularity: "basic" (DEFAULT) returns each item as identity, domain, title, statement, authority, sources and code-anchor evidence; "full" adds the typed payload of every item (a capability\'s outcome/beneficiary/boundary, a rule\'s condition/requiredOutcome, a flow\'s steps, …). Stay on the default and ask for "full" only when the statement alone is not enough to decide.',
      },
    },
  },
};

const TOOLS = [
  sharedTool('analyze_change_impact'),
  sharedTool('find_callers'),
  sharedTool('find_dependents'),
  sharedTool('find_entity_usage'),
  sharedTool('explain'),
  sharedTool('search_symbols'),
  {
    name: 'list_file_symbols',
    description:
      'List every named symbol declared in a single file (functions, classes, interfaces, entities, components, etc.), ordered by line. The inverse of search_symbols: use this when you already know the file and want its full contents/outline in one call instead of grepping. The `path` matches a stored file path exactly or by trailing segment, so you can pass a full repo-relative path or just the distinctive tail.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description:
            'Target repository: a repo name ("server-api"), a "project/repo" qualified name ("coredoc/server-api"), or a filesystem path. Auto-detected from the working directory if omitted. An unresolvable scope hard-errors (it never silently falls back to another repo). A bare repo name that exists in more than one project is rejected as ambiguous — use the "project/repo" form to disambiguate; the error lists the valid project/repo tokens.',
        },
        path: {
          type: 'string',
          description:
            'File to list symbols from: a full repo-relative path ("src/modules/templates/templates.service.ts") or just enough of the trailing segment to identify it ("templates.service.ts").',
        },
        type: {
          type: 'string',
          enum: [
            'function',
            'class',
            'interface',
            'type_alias',
            'enum',
            'entrypoint',
            'entity',
            'component',
            'route',
            'variable',
            'state_store',
            'all',
          ],
          description: 'Optional kind filter (default: all kinds in the file).',
        },
        limit: { type: 'number', description: 'Result limit (default: 200)' },
        skip: { type: 'number', description: 'Skip first N results for pagination (default: 0)' },
        format: { type: 'string', enum: ['summary', 'raw'] },
        detailLevel: DETAIL_LEVEL_SCHEMA,
      },
      required: ['path'],
    },
  },
  sharedTool('list_entrypoints'),
  sharedTool('describe_repository'),
  sharedTool('describe_db_schema'),
  sharedTool('get_extraction_coverage'),
  sharedTool('trace_cross_repo_call'),
  sharedTool('list_service_dependencies'),
  // Local-only and permanent: no env gate, but absent from the shared registry.
  GET_INTENT_CONTEXT_TOOL,
  INTENT_READ_TOOL,
  // Env-gated: listed only when ENABLE_SEMANTIC_SEARCH is on (module-load check).
  ...(semanticSearchEnabled() ? [SEMANTIC_SEARCH_TOOL] : []),
];

/**
 * Every tool name this server can list in ANY configuration: the ungated TOOLS
 * plus both gated ones, which are absent from TOOLS in a process where their
 * gate is off. Exported for `tool-classes.test.ts`, which fails when one of
 * these has no declared read/write class in `tool-classes.ts`.
 */
export const LOCAL_TOOL_NAMES: readonly string[] = [
  ...new Set([...TOOLS.map((tool) => tool.name), SEMANTIC_SEARCH_TOOL.name, sharedTool('run_cypher_query').name]),
];

// =============================================================================
// Tool Handler Dispatcher
// =============================================================================

type ToolHandler = (
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
) => Promise<McpResponse<unknown>>;

/**
 * Handler shape for {@link GRAPH_OPTIONAL_TOOLS}: same call, but the graph may
 * be absent. Kept separate because a graph-required handler is (correctly) not
 * assignable to a slot that may be called without one.
 */
type GraphOptionalToolHandler = (
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository?: IGraphReadRepository,
) => Promise<McpResponse<unknown>>;

/**
 * Tools that answer from a source OTHER than the graph and must therefore
 * survive an unavailable one.
 *
 * `get_intent_context` reads the repo-local intent overlay; the graph only adds
 * code-anchor evidence. Failing the whole call because a project was never
 * pushed would violate BR-9/AC-9 — the handler instead returns the intent with
 * `evidence.available: false`. Every other tool keeps failing closed: for them
 * a missing graph means there is no answer at all.
 */
const GRAPH_OPTIONAL_HANDLERS: Record<string, GraphOptionalToolHandler> = {
  get_intent_context: handleGetIntentContext,
  intent_read: handleIntentRead,
};

const GRAPH_OPTIONAL_TOOLS = new Set(Object.keys(GRAPH_OPTIONAL_HANDLERS));

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  analyze_change_impact: handleAnalyzeChangeImpact,
  find_callers: handleFindCallers,
  find_dependents: handleFindDependents,
  find_entity_usage: handleFindEntityUsage,
  explain: handleExplain,
  search_symbols: handleSearchSymbols,
  list_file_symbols: handleListFileSymbols,
  list_entrypoints: handleListEntrypoints,
  describe_repository: handleDescribeRepository,
  describe_db_schema: handleDescribeDbSchema,
  get_extraction_coverage: handleGetExtractionCoverage,
  trace_cross_repo_call: handleTraceCrossRepoCall,
  list_service_dependencies: handleListServiceDependencies,
  ...GRAPH_OPTIONAL_HANDLERS,
  // Env-gated: dispatchable only when ENABLE_SEMANTIC_SEARCH is on (matches TOOLS).
  ...(semanticSearchEnabled() ? { semantic_search: handleSemanticSearch } : {}),
};

/**
 * The tool names `createServer` can actually dispatch in this process (the
 * backend-gated `run_cypher_query` is added per server, on top of these).
 * Exported so `tool-classes.test.ts` fails when a handler is wired up for a
 * name that never reached LOCAL_TOOL_NAMES — and therefore was never classified.
 */
export const DISPATCHABLE_TOOL_NAMES: readonly string[] = Object.keys(TOOL_HANDLERS);

/**
 * The Cypher dialect this process can serve, or null when raw Cypher must not
 * be offered at all.
 *
 * Ladybug auto-enables because its isolation is STRUCTURAL — the local server
 * opens one per-project file read-only, so a query cannot reach past it. Neo4j
 * is one shared graph per deployment and raw Cypher applies no repo narrowing,
 * so it stays behind the operator opt-in that also gates the REST endpoint
 * (auto-enabling it there would nullify that gate). SQLite has no Cypher
 * surface at all, so no opt-in can enable it.
 *
 * Evaluated per {@link createServer} call rather than once at module load
 * (unlike `semantic_search`): the backend is host configuration, and a stale
 * module-load snapshot would list a tool the server can no longer serve.
 */
export function cypherDialect(): CypherDialect | null {
  const backend = getConfiguredBackend();
  if (backend === 'ladybug') return 'ladybug';
  if (backend === 'neo4j' && process.env.COREDOC_ALLOW_CYPHER === 'true') return 'neo4j';
  return null;
}

/** Whether `run_cypher_query` is listed and dispatchable in this process. */
export function cypherToolEnabled(): boolean {
  return cypherDialect() !== null;
}

/**
 * The `run_cypher_query` tool definition for the ACTIVE dialect: the shared
 * schema plus a description rendered for the backend that will serve it (single
 * authoring in tool-descriptions.ts, per-surface rendering here).
 */
function cypherTool(dialect: CypherDialect) {
  return { ...sharedTool('run_cypher_query'), description: buildCypherDescription({ dialects: [dialect] }) };
}

/**
 * Tools whose no-scope call is a legitimate discovery/whole-graph question, so
 * a FAILED scope resolution may fall through instead of erroring (unbound only):
 *   - describe_repository: the bootstrap all-repos discovery list;
 *   - trace_cross_repo_call destination mode: its internal messaging join may span
 *     the whole graph only when the local invocation is genuinely unbound.
 */
const UNBOUND_DISCOVERY_TOOLS = new Set(['describe_repository', 'trace_cross_repo_call']);

/**
 * Whether a FAILED scope resolution may fall through to the tool's unbound
 * discovery/whole-graph response instead of surfacing the error.
 *
 * SECURITY (fail-closed): only when the server is UNBOUND. A no-scope call to
 * one of the UNBOUND_DISCOVERY_TOOLS is the intended whole-graph question when
 * there is genuinely no project context. But under a COREDOC_SCOPE binding
 * (`project:X`, or a pinned repo — anything other than `auto`/unset) a
 * resolution failure means the requested boundary could NOT be applied;
 * falling through would answer across EVERY workspace, leaking repository
 * metadata past the boundary the host meant to isolate. In that case we fail
 * closed and surface the resolution error.
 *
 * Note: a SUCCESSFUL bound resolution already carries `projectBoundedRepos`, so
 * the discovery handlers filter correctly there — this guard only governs the
 * failure path, which has no boundary to filter by.
 */
export function isUnboundDiscoveryCall(
  toolName: string,
  argsScope: string | undefined,
  envScope: string | undefined,
  destination?: string,
): boolean {
  if (!UNBOUND_DISCOVERY_TOOLS.has(toolName) || argsScope || isScopeBound(envScope)) return false;
  return toolName === 'describe_repository' || (toolName === 'trace_cross_repo_call' && Boolean(destination));
}

// =============================================================================
// Server Setup
// =============================================================================

/**
 * Repos that have already emitted `mcp_first_answer` this process. Module-level
 * so the dedupe spans every tool call within one stdio session — the point of
 * the "first non-empty answer per repo" activation milestone. Keyed on the
 * resolved scope path (the scope's repo identity); the emitted `repo_id` is the
 * deterministic HMAC derived from it.
 */
const firstAnswerRepos = new Set<string>();

/**
 * Eval runs can suppress the local query-metrics side channel without changing
 * ordinary MCP telemetry or graph access. Only the explicit `1` value opts out.
 */
function mcpMetricsDisabled(): boolean {
  return process.env.COREDOC_MCP_METRICS_DISABLED === '1';
}

/**
 * Emit `mcp_first_answer` the FIRST time this server returns a non-empty answer
 * for a given repo. Net-new telemetry, independent of the per-call recordQuery
 * metrics. The Set guard (keyed on the scope's `currentPath`) is synchronous so
 * concurrent calls can't double-emit; the `repo_id` HMAC (which needs the
 * install id) and `commits_stale` (a DB read + git shell-out) are both resolved
 * off the hot path and the whole thing is fire-and-forget — telemetry must never
 * block or throw into a tool call.
 *
 * `commits_stale` rides on THIS event (not `mcp_session_summary`) because here
 * the repo is known, so the staleness is at the correct grain — a session
 * summary can span repos, so a single staleness number there would be wrong.
 */
function emitFirstAnswer(scope: ScopeContext): void {
  const repoPath = scope.currentPath;
  if (!repoPath || firstAnswerRepos.has(repoPath)) {
    return;
  }
  firstAnswerRepos.add(repoPath);
  void Promise.all([getTelemetryConfig(), resolveRepoCommitsStale(scope)])
    .then(([{ installId }, commitsStale]) => {
      track(EventName.McpFirstAnswer, {
        repo_id: repoId(installId, repoPath),
        // Omit when unknown rather than emit a misleading 0.
        ...(commitsStale !== null ? { commits_stale: commitsStale } : {}),
      });
    })
    .catch(() => {
      /* best-effort — telemetry must never surface into a tool call */
    });
}

function projectReadOptions(): { mode: 'read'; backend?: 'ladybug' } {
  return getConfiguredBackend() === 'ladybug' ? { mode: 'read', backend: 'ladybug' } : { mode: 'read' };
}

/**
 * A graph the caller may legitimately not have: no project is bound, or the
 * bound project was never pushed.
 *
 * Typed separately from every other failure so the graph-optional degradation
 * below can key on ABSENCE OF DATA and nothing else. A corrupt file, a locked
 * database, or a permission-denied read is not evidence that a project was
 * never pushed, and answering both with the same silent `undefined` let an
 * unreadable graph reach the agent as legitimate absence of evidence.
 */
class GraphUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphUnavailableError';
  }
}

async function projectDatabaseForScope(scope: ScopeContext | undefined): Promise<ProjectDatabase> {
  if (!scope?.projectId || !scope.configDir) {
    throw new GraphUnavailableError(
      'No project bound. Local MCP requires MCP_CONFIG_PATH and COREDOC_SCOPE=project:<id>.',
    );
  }
  return openProjectDatabase(scope.configDir, scope.projectId, projectReadOptions());
}

/**
 * The graph database this call should read.
 *
 * Databases are per project (`{workspace}/coredoc.db.d/{id}.db`): graph node
 * ids embed only the repo name's hash, so a repo named the same in two
 * projects collides in a shared file. It is resolved here — once, at the single
 * dispatch point — and handed to the handler, which takes it as a REQUIRED
 * parameter and has no fallback of its own to read the wrong database from.
 *
 * Precedence: an injected repository (tests, embedders) → a non-SQLite backend
 * → the database derived from the resolved config + project id. There is no
 * URL override and no cwd-relative fallback.
 *
 * `scope.projectId` is the resolved `project.id`, never the display name the
 * `COREDOC_SCOPE=project:X` token may carry, so it is safe to build a path from.
 */
async function resolveScopedRepository(
  scope: ScopeContext | undefined,
  injected?: IGraphReadRepository,
): Promise<IGraphReadRepository> {
  if (injected) return injected;

  // SQLite and Ladybug are project-owned files. Neo4j is the only shared
  // singleton backend; routing it through the file pool would answer from an
  // unrelated local graph.
  if (getConfiguredBackend() === 'neo4j') return getRepository();

  const database = await projectDatabaseForScope(scope);
  const repositories = await database.graph.listAllRepositories();
  if (repositories.length === 0) {
    throw new GraphUnavailableError(
      `No graph data for project "${database.projectId}". ` +
        `Run \`coredoc push --config "${scope!.configDir}/coredoc.config.json" --project ${database.projectId}\`.`,
    );
  }
  return database.graph;
}

/**
 * Resolve the graph for `toolName`, degrading to `undefined` ONLY where that is
 * an honest answer.
 *
 * The degradation is spec-required (BR-9/AC-9) but it is a degradation, so it
 * is scoped to {@link GraphUnavailableError} — "no project bound" and "this
 * project was never pushed". Anything else (a corrupt or locked database file,
 * a permission-denied read, a backend that failed to open) is logged with the
 * tool name and rethrown: a graph the server could not READ is not a graph the
 * agent may treat as empty, and failing fast here beats an intent answer that
 * silently claims no code evidence exists.
 */
async function resolveScopedRepositoryFor(
  toolName: string,
  scope: ScopeContext | undefined,
  injected?: IGraphReadRepository,
): Promise<IGraphReadRepository | undefined> {
  try {
    return await resolveScopedRepository(scope, injected);
  } catch (error) {
    if (!GRAPH_OPTIONAL_TOOLS.has(toolName)) throw error;
    if (error instanceof GraphUnavailableError) return undefined;
    console.error(
      `Warning: ${toolName} could not open the project graph — ` +
        `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}. ` +
        `This is a read failure, not an unpushed project; the call is failing rather than reporting no evidence.`,
    );
    throw error;
  }
}

/**
 * Create and configure the MCP server.
 *
 * `sessionId` is the per-process stdio session id (minted in {@link startServer});
 * it is stamped on every recorded query so rows group into a session that the
 * next start rolls up into an `mcp_session_summary`. Undefined in tests / direct
 * callers that don't track sessions — those rows simply never roll up.
 */
export function createServer(repository?: IGraphReadRepository, sessionId?: string): Server {
  const server = new Server(
    {
      name: 'coredoc',
      version: MCP_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Backend-gated: run_cypher_query is listed AND dispatchable only where this
  // process may serve raw Cypher, resolved once per server so tools/list and
  // tools/call can never disagree.
  const dialect = cypherDialect();
  const tools = dialect ? [...TOOLS, cypherTool(dialect)] : TOOLS;
  const handlers: Record<string, ToolHandler> = dialect
    ? { ...TOOL_HANDLERS, run_cypher_query: handleRunCypherQuery }
    : TOOL_HANDLERS;

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: tools.map((tool) => ({ ...tool, annotations: toolAnnotations(tool.name) })) };
  });

  /**
   * Metrics land in the same per-project database as the graph they describe.
   *
   * Returns null when no project database resolves. Metrics never create a
   * fallback database merely because a tool call was attempted.
   */
  async function getMetrics(scope: ScopeContext | undefined): Promise<McpMetricsRepository | null> {
    if (mcpMetricsDisabled()) return null;
    try {
      return (await projectDatabaseForScope(scope)).metrics;
    } catch {
      return null;
    }
  }

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Get handler
    const handler = handlers[name];
    if (!handler) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    }

    // Validate before resolving scope: an ignored `repository` argument must
    // never turn a repo-scoped request into a successful project-wide answer.
    if (Object.hasOwn(TOOL_SCHEMAS, name)) {
      const schema = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS];
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
          .join('; ');
        return {
          content: [
            {
              type: 'text',
              text: `Invalid arguments for ${name}: ${issues}. Accepted parameters: ${Object.keys(schema.shape).join(', ')}.`,
            },
          ],
          isError: true,
        };
      }
    }

    // Resolve scope with support for narrowing within a project boundary.
    // COREDOC_SCOPE (from the host's .mcp.json) acts as a HARD BOUNDARY, not an
    // override: the AI's `scope` arg can NARROW within it but never cross it.
    // We forward argsScope as-is; resolveScope enforces the fence via
    // `projectConstraint` and fails closed on any scope that resolves to a repo
    // outside the bound project.
    const envScope = process.env.COREDOC_SCOPE;
    const argsScope = args?.scope as string;

    let scopePath: string;
    let projectConstraint: string | undefined;

    if (envScope?.startsWith('project:')) {
      // Project boundary - the AI may narrow to a repo within it via argsScope;
      // with no argsScope the whole project is in scope.
      projectConstraint = envScope.slice(8); // e.g., "coredoc"
      scopePath = argsScope || envScope;
    } else if (envScope && envScope !== 'auto') {
      // Hard constraint - specific repo only (env wins)
      scopePath = envScope;
    } else {
      // No constraint or "auto" - traditional path-based resolution
      scopePath = argsScope || process.cwd();
    }

    const format = ((args?.format as string) || 'summary') as OutputFormat;
    // For project-level scope, always enable cross-repo
    // Otherwise, only enable if explicitly requested (default to single-repo)
    const isProjectScope = scopePath.startsWith('project:');
    const includeCrossRepo = isProjectScope || args?.includeCrossRepo === true;
    // Per-tool default: list-shaped tools (plus explain / get_intent_context)
    // resolve an omitted detailLevel to 'basic'; everything else to 'full'.
    const detailLevel = ((args?.detailLevel as string) || getDefaultDetailLevel(name)) as DetailLevel;
    const detailConfig = resolveDetailLevel(detailLevel);

    const scopeResult = resolveScope(scopePath, {
      configPath: process.env.MCP_CONFIG_PATH,
      includeCrossRepo,
      projectConstraint,
    });

    // Carry the project boundary on the scope so tools can filter
    // discovery output (e.g. describe_repository's `allKnownRepos`) to the
    // current project context instead of leaking unrelated workspaces. The
    // boundary is the resolved project binding (`COREDOC_SCOPE=project:X`).
    if (scopeResult.scope) {
      // Threaded onto scope (already carried into every formatter call) so the
      // staleness-banner dedupe can key repeat-mention compaction per session
      // without a new parameter through every handler / createMetadata call site.
      scopeResult.scope.sessionKey = sessionId;

      if (scopeResult.scope.project && scopeResult.scope.resolvedRepos.length > 0) {
        scopeResult.scope.projectBoundedRepos = scopeResult.scope.resolvedRepos;
      }

      // Vantage repo: the default "current repo" the .mcp.json declares via
      // COREDOC_CURRENT_REPO. A HINT, not a boundary — it only sharpens
      // single-origin tools (list_service_dependencies) within the already
      // resolved scope, leaving the project-wide boundary (and cross-repo reach)
      // untouched. Applied ONLY when the agent passed no explicit `scope` arg:
      // an explicit scope IS the agent overriding the default, so the vantage
      // steps aside entirely.
      // Also silently ignored when it names a repo outside the scope (fail-soft:
      // a stale value never breaks a query).
      const vantageSignal = process.env.COREDOC_CURRENT_REPO;
      if (!argsScope && vantageSignal) {
        const vantage = resolveVantageRepo(scopeResult.scope, vantageSignal);
        if (vantage) {
          scopeResult.scope.currentRepo = vantage.name;
          scopeResult.scope.currentRepoHash = vantage.hash;
        }
      }
    }

    // describe_repository is a discovery tool — it must work even when scope
    // can't be resolved (no config, agent invoked without a scope arg and
    // cwd isn't a known repo). In that UNBOUND case fall through with an empty
    // scope and let the handler return its all-repos discovery response.
    //
    // SECURITY: only the unbound case may fall through. Under a COREDOC_SCOPE
    // binding a resolution failure means the boundary couldn't be applied, so
    // we fail closed rather than leak repos across workspaces. See
    // isUnboundDiscoveryCall.
    const isDiscoveryWithoutScope = isUnboundDiscoveryCall(
      name,
      argsScope,
      envScope,
      args?.destination as string | undefined,
    );
    if (!scopeResult.success && !isDiscoveryWithoutScope) {
      return {
        content: [
          {
            type: 'text',
            text: `Scope resolution failed: ${scopeResult.error}`,
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();

    try {
      // Execute tool handler
      const scopedRepository = await resolveScopedRepositoryFor(name, scopeResult.scope, repository);
      if (!scopedRepository && !GRAPH_OPTIONAL_TOOLS.has(name)) {
        throw new Error(`No graph repository available for tool '${name}'`);
      }
      const response = scopedRepository
        ? await handler(args || {}, scopeResult.scope, format, detailLevel, detailConfig, scopedRepository)
        : // Guarded above: a missing graph only reaches GRAPH_OPTIONAL_HANDLERS.
          await GRAPH_OPTIONAL_HANDLERS[name](args || {}, scopeResult.scope, format, detailLevel, detailConfig);

      // Resolve resultCount for metrics:
      //   - list-returning tools set it explicitly via the formatter
      //   - single-entity tools surface "found nothing" through isError; map that to 0
      //   - otherwise leave null so we don't pollute empty-rate stats with N/A rows
      const resultCount =
        response.resultCount !== undefined ? response.resultCount : response.isError === true ? 0 : null;

      // mcp_first_answer: the first NON-EMPTY answer for this repo is the
      // activation milestone (success is implicit here — this is the success
      // branch). resultCount === 0 means an empty list or a single-entity miss
      // (isError→0); a null count is a single-entity HIT, which counts as an
      // answer. Deduped once per repo. Net-new — recordQuery below is untouched.
      if (resultCount !== 0) {
        emitFirstAnswer(scopeResult.scope);
      }

      // Record success metrics (non-blocking)
      getMetrics(scopeResult.scope)
        .then((m) =>
          m?.recordQuery({
            toolName: name,
            durationMs: Date.now() - startTime,
            success: true,
            scope: scopePath,
            resultCount,
            sessionId,
          }),
        )
        .catch(() => {
          /* swallowed */
        });

      return {
        content: formatMcpContent(response),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Record failure metrics (non-blocking)
      getMetrics(scopeResult.scope)
        .then((m) =>
          m?.recordQuery({
            toolName: name,
            durationMs: Date.now() - startTime,
            success: false,
            scope: scopePath,
            sessionId,
          }),
        )
        .catch(() => {
          /* swallowed */
        });

      return {
        content: [
          {
            type: 'text',
            text: `Tool execution failed: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// =============================================================================
// Server Startup
// =============================================================================

/**
 * Surface configured-but-unparsed repos. A repo named in coredoc.config.json
 * with zero nodes in the graph (e.g. an iOS/Swift repo the parser doesn't
 * support yet) resolves fine but returns empty results for every query. Warn
 * once at startup so the gap shows up in the client log instead of mid-task.
 * Best-effort: needs MCP_CONFIG_PATH and an available DB, otherwise it silently
 * does nothing.
 */
export async function warnUnparsedRepos(): Promise<void> {
  try {
    const binding = envBoundProject();
    if (!binding || binding.repoNames.length === 0) return;

    const repository =
      getConfiguredBackend() === 'neo4j'
        ? await getRepository()
        : (await openProjectDatabase(binding.configDir, binding.projectId, projectReadOptions())).graph;
    const parsed = new Set((await repository.listAllRepositories()).map((repo) => repo.name));
    const missing = binding.repoNames.filter((name) => !parsed.has(name));
    if (missing.length > 0) {
      console.error(
        `Warning: ${missing.length} repo(s) in project "${binding.projectId}" have no graph data: ${missing.join(', ')}. ` +
          `Run \`coredoc push --config "${binding.configDir}/coredoc.config.json" --project ${binding.projectId}\`.`,
      );
    }
  } catch {
    /* diagnostic only — never block startup on it */
  }
}

/**
 * Emit one durable `mcp_session_summary` per un-summarized prior session (the
 * plan's "next-start durable" strategy — at-close is confirmed lossy, so the
 * guarantee lives here, not in a shutdown hook).
 *
 * The claim is atomic and comes BEFORE the emit: `claimUnsummarizedSessionRollups`
 * marks the sessions summarized in the same `BEGIN IMMEDIATE` transaction that
 * reads their counters, so a concurrent start on the shared local db can't select
 * the same sessions and double-emit, and a swallowed failure can't leave rows
 * `summarized = 0` for the next start to re-emit. We emit only the sessions this
 * process actually claimed; the residual gap is a crash between the claim commit
 * and these emits, which drops at most this batch — accepted best-effort.
 *
 * `excludeSessionId` skips the in-flight process's own session — pass it at
 * startup (that session has no rows yet, and is claimed on a LATER start once its
 * rows fall past the repository's idle-grace window). The claim itself only
 * returns sessions quiescent past that window, so a concurrent live instance's
 * open session is never summarized here. `track` is fire-and-forget; the
 * summaries flush during the long-lived session that follows. Separated from the
 * wiring below so it is unit-testable against a fake repo + spied `track`.
 *
 * No `commits_stale` here: a summarized session can span multiple repos, so a
 * single cwd-derived staleness number would carry the wrong grain. Staleness is
 * emitted at the correct grain on the repo-scoped `mcp_first_answer` event
 * ({@link emitFirstAnswer}) instead.
 */
export async function summarizePriorSessions(
  metrics: McpMetricsRepository,
  excludeSessionId: string | undefined,
): Promise<void> {
  // Atomic claim (mark) first, emit second — see the doc above.
  const rollups = await metrics.claimUnsummarizedSessionRollups({ excludeSessionId });

  for (const rollup of rollups) {
    track(EventName.McpSessionSummary, {
      tool_calls: rollup.toolCalls,
      distinct_tools: rollup.distinctTools,
      error_count: rollup.errorCount,
      duration_ms_total: rollup.totalDurationMs,
      duration_ms_avg: rollup.avgDurationMs,
    });
  }
}

/**
 * Best-effort staleness for the repo THIS answer is scoped to: how far its
 * working tree (the resolved scope's `currentPath`) has moved past the commit
 * the graph was parsed at. Reads the scope the server already resolved for the
 * in-flight call — the repo IS known here, so the value carries the right grain
 * (unlike a cwd-derived number that would be wrong on any prior session that
 * served a different repo). Reads the parsed commit from the operations log and
 * shells `git rev-list` (via the T2 helper). Any gap — missing projectId / repo
 * / path, unparsed repo, non-git dir, git unavailable — resolves to null.
 *
 * The scope fields are guarded BEFORE any deref or IO, so a partial scope
 * short-circuits to null rather than relying on the catch to mask a TypeError.
 */
async function resolveRepoCommitsStale(scope: ScopeContext): Promise<number | null> {
  try {
    const projectId = scope.projectId;
    const repoName = scope.resolvedRepos[0];
    const repoPath = scope.currentPath;
    if (!projectId || !repoName || !repoPath || !scope.configDir) {
      return null;
    }
    const opsRepo = (await openProjectDatabase(scope.configDir, projectId, projectReadOptions())).operations;
    const summary = await opsRepo.getOperationSummary(projectId, repoName);
    return await computeCommitsStale(repoPath, commitHashFromSummary(summary));
  } catch {
    return null;
  }
}

/**
 * The project this process is bound to by its environment, if any.
 *
 * Only `COREDOC_SCOPE=project:<id>` is a process-wide binding. Display names
 * are deliberately rejected: the id is the stable database owner.
 */
function envBoundProject():
  | { projectId: string; configDir: string; configPath: string; repoNames: string[] }
  | undefined {
  const envScope = process.env.COREDOC_SCOPE;
  const configPath = process.env.MCP_CONFIG_PATH;
  if (!envScope?.startsWith('project:') || !configPath || !existsSync(configPath)) return undefined;
  const token = envScope.slice('project:'.length);
  try {
    const config = loadConfig(configPath);
    const projectMatches = config.projects.filter((candidate) => candidate.id === token);
    if (projectMatches.length !== 1) return undefined;
    const [project] = projectMatches;
    return {
      projectId: project.id,
      configDir: config.configDir,
      configPath,
      repoNames: project.repos.map((repo) => repo.name),
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the metrics repo, then run {@link summarizePriorSessions}.
 * Fully guarded — a telemetry rollup must never block startup or shutdown.
 *
 * Skipped entirely when no project database resolves, so telemetry never owns
 * database selection or creates storage as a side effect.
 */
async function rollupUnsummarizedSessions(excludeSessionId: string | undefined): Promise<void> {
  if (mcpMetricsDisabled()) return;
  try {
    const binding = envBoundProject();
    if (!binding) return;
    const database = await openProjectDatabase(binding.configDir, binding.projectId, projectReadOptions());
    await summarizePriorSessions(database.metrics, excludeSessionId);
  } catch {
    /* best-effort — never surface a rollup failure into the process lifecycle */
  }
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer(): Promise<void> {
  // Per-process stdio session id: groups this connection's mcp_queries rows so a
  // later start rolls them up into one mcp_session_summary. A fresh uuid per
  // process is the natural session (connection-lifetime) boundary. Minted BEFORE
  // initTelemetry so it can be passed in as the explicit telemetry session id.
  const mcpSessionId = newInvocationId();

  // Tag this process's telemetry as the MCP surface and pin its session id +
  // anon key up front:
  //   - surface 'mcp' distinguishes these rows from cli/desktop;
  //   - the EXPLICIT sessionId wins over resolveSession() inside the client, so
  //     the MCP process keeps its OWN session instead of sliding into — and
  //     colliding with — the shared ~/.coredoc/session.json CLI file. A parallel
  //     `coredoc` command and this server must never share one session id;
  //   - channels carries the build-time bundled anon key so a STANDALONE MCP
  //     install actually ships its P3 events (mcp_first_answer,
  //     mcp_session_summary) instead of being dark. Empty key (dev/test) ⇒ no-op,
  //     unchanged default-off behavior; a runtime COREDOC_POSTHOG_* env still
  //     wins over the bundled key inside the anon channel.
  // Init is lazy + idempotent (the first `track` auto-inits), so this only has to
  // record the context before any tool call — which can only happen after
  // connect() below.
  // Env-driven version base props (see the CLI entry): a desktop parent's stamp wins.
  process.env.COREDOC_CLI_VERSION ??= MCP_VERSION;
  process.env.COREDOC_ENGINE_VERSION ??= MCP_VERSION;
  initTelemetry({
    surface: 'mcp',
    sessionId: mcpSessionId,
    channels: { posthogKey: BUNDLED_POSTHOG_KEY, posthogHost: BUNDLED_POSTHOG_HOST },
  });

  // Drain telemetry on a CLEAN exit so in-flight anon emits (e.g. mcp_first_answer)
  // flush before the process goes away — posthog-node batches, so a short-lived
  // session would otherwise drop them. A hard kill (SIGKILL) skips beforeExit;
  // that's an accepted best-effort gap.
  //
  // Session rollup is deliberately NOT done here. beforeExit also fires the DB
  // driver close in registerExitHandlers() below; both listeners enter the same
  // emit synchronously, but a rollup awaits the metrics repo + a git shell-out
  // before its claim, so it would run against an already-closed driver (throw +
  // swallow). The durable next-start rollup — a fresh open driver, excludes the
  // current session, idle-gated, and claiming each session ATOMICALLY (the mark
  // commits in the same BEGIN IMMEDIATE transaction that reads its counters, then
  // we emit) — is the single owner of session summaries: concurrent starts can't
  // both claim the same session, so none double-emits.
  process.once('beforeExit', () => {
    void shutdownTelemetry();
  });

  // Register cleanup handlers
  registerExitHandlers();

  if (getConfiguredBackend() !== 'neo4j') {
    const binding = envBoundProject();
    if (!binding) {
      throw new Error(
        'Local MCP requires MCP_CONFIG_PATH and COREDOC_SCOPE=project:<id>; the id must exist exactly in that config.',
      );
    }
    // A valid binding with no pushed graph is a supported degraded state (AC-9):
    // graph-backed tools fail per call with an actionable error, while
    // graph-optional tools (get_intent_context) still serve overlay data with
    // evidence marked unavailable. Only a missing/ambiguous binding is fatal.
    try {
      const database = await openProjectDatabase(binding.configDir, binding.projectId, projectReadOptions());
      if ((await database.graph.listAllRepositories()).length === 0) {
        console.error(
          `Warning: No graph data for project "${binding.projectId}" — graph-backed tools will return errors. ` +
            `Run \`coredoc push --config "${binding.configPath}" --project ${binding.projectId}\`.`,
        );
      }
    } catch (error) {
      console.error(
        `Warning: project graph unavailable (${error instanceof Error ? error.message : String(error)}) — ` +
          `graph-backed tools will return errors. ` +
          `Run \`coredoc push --config "${binding.configPath}" --project ${binding.projectId}\`.`,
      );
    }
  } else {
    const dbAvailable = await isDatabaseAvailable();
    if (!dbAvailable) throw new Error('Configured Neo4j database is not available.');
  }

  await warnUnparsedRepos();
  // Durable rollup: emit a summary for every PRIOR session and mark it done.
  // Excludes the just-minted current session (it has no rows yet).
  await rollupUnsummarizedSessions(mcpSessionId);

  // Create and start server
  const server = createServer(undefined, mcpSessionId);
  const transport = new StdioServerTransport();

  await server.connect(transport);
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  try {
    await startServer();
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}
