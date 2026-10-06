/**
 * Canonical MCP tool parameter schemas — single source of truth.
 *
 * Defined ONCE in Zod and consumed by both MCP surfaces, so a tool's parameter
 * set (names, types, enums, requiredness, per-parameter descriptions) can never
 * drift between them:
 *  - the cloud NestJS server (`@rekog/mcp-nest` `@Tool({ parameters })`) uses the
 *    Zod object directly from {@link TOOL_SCHEMAS};
 *  - the local stdio server (the MCP SDK `inputSchema`, plain JSON Schema) uses
 *    the pre-converted {@link TOOL_INPUT_SCHEMAS}.
 *
 * Pairs with TOOL_DESCRIPTIONS (the tool-level prose). Only tools present on BOTH
 * surfaces live here; local-only tools (`list_file_symbols`) keep their schema at
 * their single definition site.
 *
 * `scope` is included here intentionally — its semantics are a property of the
 * tool (most tools default to the current repo; `explain` / `describe_repository`
 * default to ALL repos), not of the surface, so it is described once, neutrally,
 * for both.
 */
import { z } from 'zod';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import type { EntrypointType } from '@coredoc/core/types';
import { CypherResultShape } from '@coredoc/db';
import { CYPHER_VOCABULARY } from './tool-descriptions.js';

// Shared parameter fragments.
const SCOPE = z
  .string()
  .optional()
  .describe(
    'Target repository: a repo name ("server-api"), a "project/repo" qualified name ("coredoc/server-api"), or a filesystem path. Omit to use the default repository for the current context (auto-detected from the working directory locally; resolved from the active workspace on the hosted server). An unresolvable scope hard-errors (it never silently falls back to another repo). A bare repo name that exists in more than one project is rejected as ambiguous — use the "project/repo" form to disambiguate; the error lists the valid project/repo tokens.',
  );

// detailLevel defaults differ per tool, so each variant states ITS OWN default
// (a single shared "…; default" text lied for the compact-by-default tools).
// List-shaped tools default to `basic`: a list answers "which symbols" and
// identity + location + the relationship datum answers that. See
// BASIC_BY_DEFAULT_TOOLS in detail-level.ts.
const DETAIL_LEVEL_BASIC_DEFAULT = z
  .enum(['basic', 'full'])
  .optional()
  .describe(
    'Response granularity: basic (id, name, repo, file:line — the DEFAULT) or full (adds AI summaries, refs, callees, line ranges). Stay on the default for inventory/impact questions; re-call with "full" only for the specific rows whose behaviour you must understand.',
  );

const DETAIL_LEVEL_EXPLAIN = z
  .enum(['basic', 'full'])
  .optional()
  .describe(
    'Response granularity: basic (id, name, file, line) or full (everything — AI summaries, refs, callees). Omit for the compact default: functions/entrypoints still render their full structure, but inline field/value previews are truncated with "+N more" — pass "full" to expand them.',
  );

const DETAIL_LEVEL_DB_SCHEMA = z
  .enum(['basic', 'full'])
  .optional()
  .describe(
    'Detail of the whole-schema dump — defaults to a COMPACT overview (each table → column names + relation count); pass "full" for every column with types/flags and enum values. Ignored for a single-table deep-dive (`entityName`), which is always full.',
  );

// `raw` is NOT a token-saver: it carries a full node id per row (which repeats
// the repo, kind, file and name already in the row), so a list is typically
// larger than the same list in `summary`. Ask for it when you need the ids or
// exact fields for a follow-up call, not to save context.
const FORMAT = z
  .enum(['summary', 'raw'])
  .optional()
  .describe(
    'Output format (default: summary). `raw` returns structured JSON with node ids for chaining — it is usually LARGER than `summary`, not a token saver.',
  );

// Only surfaced on `explain` / `search_symbols` when this deployment enables
// source-in-graph (ALLOW_SOURCES_IN_GRAPH) — see the conditional spreads below.
// When disabled the param is absent from the schema entirely, so the model never
// sees it.
const INCLUDE_SOURCE = z
  .boolean()
  .optional()
  .describe(
    "Return the matched symbol's raw source body inline (functions/methods; for an entrypoint target, its handler body), so you can skip a follow-up file read. For other symbol kinds, returns available extracted structure with an explicit source-unavailable reason. Reflects the parsed snapshot/branch — re-read the file before editing if it may have changed.",
  );

/** Spread into a schema to add `includeSource` only when the capability is on. */
const SOURCE_PARAM = allowSourcesInGraph() ? { includeSource: INCLUDE_SOURCE } : {};

// Exported (not just module-local) so consumers outside the MCP surface that
// need the same enum — e.g. apps/server's REST graph layer — import the
// single source of truth instead of keeping a hand-copied literal in sync.
export const ENTRYPOINT_TYPES = [
  'http',
  'graphql',
  'grpc',
  'cron',
  'websocket',
  'event',
  'queue',
  'cli',
  'mobile',
] as const satisfies readonly EntrypointType[];

/** Drift guard: a new core `EntrypointType` not listed above is a compile error here. */
const _entrypointTypesExhaustive: Exclude<EntrypointType, (typeof ENTRYPOINT_TYPES)[number]> extends never
  ? true
  : never = true;
void _entrypointTypesExhaustive;

export const SYMBOL_TYPES = [
  'file',
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
] as const;

export const TOOL_SCHEMAS = {
  // Impact Analysis
  analyze_change_impact: z.strictObject({
    scope: SCOPE,
    target: z
      .string()
      .describe(
        'Name of a function, class, interface, type alias, enum, or entity to analyze — NOT a file path. Function names accept a bare name (myFn) or a class-qualified form (MyClass.myMethod); the qualifier is parsed off for the lookup. A file path is rejected with guidance to call list_file_symbols first and pass one of its returned names here.',
      ),
    targetType: z
      .enum(['function', 'class', 'interface', 'type_alias', 'enum', 'entity'])
      .optional()
      .describe('Target type (auto-detected if not provided)'),
    fileHint: z
      .string()
      .optional()
      .describe(
        "File path hint to disambiguate when multiple functions share the same name (only used for function targets). Substring match against the function's file_path.",
      ),
    depth: z.number().optional().describe('How many levels deep to traverse (default: 3)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),
  find_callers: z.strictObject({
    scope: SCOPE,
    // `functionName` and `target` are both optional in the SCHEMA because exactly one is
    // required; the handler reads `functionName ?? target`. Declaring the alias is what makes
    // it discoverable — a schema-validating client previously stripped or rejected `target`.
    target: z.string().optional().describe('Alias for `functionName`, matching explain.'),
    functionName: z
      .string()
      .optional()
      .describe(
        'Name of the function to find callers for. Accepts a bare name (myFn) or a class-qualified form (MyClass.myMethod / Outer.Inner.method); the qualifier is parsed off for the lookup. When name collisions exist across classes, check the className field in the response to confirm the match. Also accepted under the alias `target`, matching explain.',
      ),
    fileHint: z.string().optional().describe('File path hint to disambiguate if multiple functions have the same name'),
    depth: z
      .number()
      .optional()
      .describe(
        'How far to walk the call chain. 1 = direct callers only (default — what you want for rename/edit-site questions). 2+ = include transitive callers (what you want for "what breaks if I change behavior"). Transitive callers compile against the renamed symbol via the chain — they do NOT need editing.',
      ),
    includeEntrypoints: z.boolean().optional().describe('Show which APIs trigger this function (default: true)'),
    limit: z.number().optional().describe('Max callers to return per distance level (default: 20)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),
  find_dependents: z.strictObject({
    scope: SCOPE,
    // As with find_callers: exactly one of `name` / `target` is required, enforced by the
    // handler. Both are declared so the advertised contract matches what is accepted.
    target: z.string().optional().describe('Alias for `name`.'),
    name: z.string().optional().describe('Name of the type to find dependents for.'),
    type: z
      .enum(['class', 'interface', 'type_alias', 'enum'])
      .optional()
      .describe(
        'Type category. Omit it to have the kind resolved from the graph; a function or component target is redirected to find_callers.',
      ),
    includeExtensions: z.boolean().optional().describe('Include classes that extend/implement (default: true)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),
  find_entity_usage: z.strictObject({
    scope: SCOPE,
    entityName: z.string().describe('Entity name (e.g., "User", "Order")'),
    operation: z
      // Every DbOperationType plus `all`. `ddl` (schema change), `query` and `transaction` are
      // real emitted values; omitting them made whole categories of usage unfilterable.
      .enum(['create', 'read', 'update', 'delete', 'query', 'transaction', 'ddl', 'all'])
      .optional()
      .describe('Filter by operation type (default: all)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),

  // Understanding Code
  explain: z.strictObject({
    scope: z
      .string()
      .optional()
      .describe(
        'Target repository name or path. Omit to search every parsed repo (use when you do not know which repo owns the symbol).',
      ),
    target: z
      .string()
      .describe(
        'Symbol name, qualified method (`Class.method`), HTTP path (`POST /v1/users`), or a `path:line` location (`src/foo.ts:42`, resolved to the symbol spanning that line). Whitespace and surrounding backticks are stripped.',
      ),
    fileHint: z
      .string()
      .optional()
      .describe('File path or basename to disambiguate when the same name exists in multiple files.'),
    className: z.string().optional().describe('Explicit owning class for methods — bypasses parsing `Class.method`.'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_EXPLAIN,
    ...SOURCE_PARAM,
  }),
  // Discovery
  search_symbols: z.strictObject({
    scope: SCOPE,
    query: z
      .string()
      .describe(
        'Name or pattern. Single word = substring match. Multiple words = AND (every word must appear in ONE name; an empty AND result stays empty). `*`/`?` = wildcards passed through. Search one concept per call — unrelated terms AND-match to nothing.',
      ),
    exact: z
      .boolean()
      .optional()
      .describe(
        'When true, keep only symbols whose declared name equals `query` exactly (case-insensitive), dropping substring/fuzzy near-misses. Use to verify a specific known symbol rather than discover candidates.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Disambiguate by file: keep only symbols whose file path equals this value or ends with "/<path>". Pairs with `exact` to resolve a collision-heavy name (e.g. `createTemplate` declared in several repos) to the one node in the file you mean.',
      ),
    type: z
      .enum(SYMBOL_TYPES)
      .optional()
      .describe(
        'Type filter (default: all). Pass `file` explicitly to search file nodes. `all` includes `state_store` (Kea-style logics) and exported `variable` rows; pass `variable` explicitly to bypass the exported-only filter.',
      ),
    limit: z.number().optional().describe('Result limit (default: 20)'),
    skip: z.number().optional().describe('Skip first N results for pagination (default: 0)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
    ...SOURCE_PARAM,
  }),
  list_entrypoints: z.strictObject({
    scope: SCOPE,
    type: z
      .enum([...ENTRYPOINT_TYPES, 'all'])
      .optional()
      .describe('Entrypoint type filter (default: all)'),
    pathFilter: z
      .string()
      .optional()
      .describe(
        'Filter by address substring — matches HTTP path, queue/event destination, Kafka topic, GraphQL field, cron schedule or CLI command (e.g. "DailySummaryRecalculateV2").',
      ),
    system: z
      .string()
      .optional()
      .describe(
        'Messaging system filter for queue/event entrypoints (case-insensitive). The literal "unknown" is reserved and selects legacy rows with no persisted system.',
      ),
    limit: z.number().optional().describe('Max items per type in summary format (default: 20, max: 100)'),
    skip: z.number().optional().describe('Skip first N items per type for pagination (default: 0)'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),
  describe_repository: z.strictObject({
    mode: z
      .enum(['overview', 'inventory'])
      .optional()
      .describe(
        'inventory: compact repository membership and parse coverage without package expansion; overview (default): full repository summary',
      ),
    scope: z
      .string()
      .optional()
      .describe(
        'Target repository name or path, OR the project-wide scope token `project:<project-id>` to get the repo-list overview of THAT project (the same shape an omitted scope returns for the current project context). OMIT to list every parsed repository in the current project context (use this first if you do not know which repos exist in the workspace). An unresolvable project hard-errors listing the valid project tokens; it never falls back to another project.',
      ),
    format: FORMAT,
  }),
  describe_db_schema: z.strictObject({
    scope: SCOPE,
    entityName: z
      .string()
      .optional()
      .describe('Entity or table name to deep-dive (e.g. "User" or "users"). Omit to return all tables.'),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_DB_SCHEMA,
  }),
  get_extraction_coverage: z.strictObject({
    scope: SCOPE,
    format: FORMAT,
  }),
  run_cypher_query: z.strictObject({
    scope: SCOPE,
    query: z
      .string()
      .min(1)
      .describe(
        'One read-only Cypher statement. Project scalars for the rows shape (`RETURN n.name AS name, count(*) AS total`). Mutating/administrative clauses and multiple `;`-separated statements are rejected. Paginate in-query with ORDER BY + SKIP/LIMIT — there is no cursor. ' +
          CYPHER_VOCABULARY,
      ),
    resultShape: z
      .enum(CypherResultShape)
      .optional()
      .describe(
        'rows (default) = a scalar table of the projected columns; graph = the matched nodes/edges as a subgraph. A rows query that returns a whole node, list or map is rejected — project scalars or switch to graph.',
      ),
    limit: z
      .number()
      .int()
      .optional()
      .describe('Max rows/nodes returned (default: 200, max: 500 — values are clamped)'),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe('Scalar Cypher parameters referenced as $name in the query. Only string/number/boolean/null values.'),
    format: FORMAT,
  }),

  // Cross-Repo
  trace_cross_repo_call: z.strictObject({
    scope: SCOPE,
    targetService: z
      .string()
      .optional()
      .describe('Target service name or the repo name the call resolves to (optional, auto-detect)'),
    callPattern: z.string().optional().describe('Call pattern (e.g., "POST /api/users" or an SDK method name)'),
    destination: z
      .string()
      .optional()
      .describe('Case-sensitive messaging destination. Cannot be combined with targetService or callPattern.'),
    system: z
      .string()
      .optional()
      .describe(
        'Optional messaging system for destination mode (case-insensitive). The literal "unknown" is reserved for legacy systemless rows.',
      ),
    format: FORMAT,
    detailLevel: DETAIL_LEVEL_BASIC_DEFAULT,
  }),
  list_service_dependencies: z.strictObject({
    scope: SCOPE,
    format: FORMAT,
  }),
} satisfies Record<string, z.ZodObject>;

/** JSON Schema shape the MCP SDK expects for a tool's `inputSchema`. */
export interface McpInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** Preserve strict argument validation on the local JSON-schema surface too. */
function toMcpInputSchema(schema: z.ZodObject): McpInputSchema {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return {
    type: 'object',
    properties: json.properties ?? {},
    required: json.required ?? [],
    additionalProperties: false,
  };
}

/** Pre-converted JSON Schema inputs, keyed identically to {@link TOOL_SCHEMAS}. */
export const TOOL_INPUT_SCHEMAS = Object.fromEntries(
  Object.entries(TOOL_SCHEMAS).map(([name, schema]) => [name, toMcpInputSchema(schema)]),
) as Record<keyof typeof TOOL_SCHEMAS, McpInputSchema>;
