/**
 * Canonical MCP tool descriptions — single source of truth.
 *
 * Both MCP surfaces consume these so each tool is described IDENTICALLY:
 *  - the local stdio server (`server.ts`, the `TOOLS` array), and
 *  - the cloud NestJS server (`apps/server/src/mcp/tools/*.tools.ts`, the
 *    `@Tool` decorators) via `@coredoc/mcp`.
 *
 * Only tools present on BOTH surfaces live here — a description can only drift
 * when it is authored twice. Local-only tools (`list_file_symbols`, `coredoc`)
 * keep their description inline at their single definition site.
 *
 * What stays per-surface: the `scope` PARAMETER description. Scope resolution is
 * genuinely different — working-directory auto-detection locally vs. workspace
 * context on the cloud — so each call site defines its own `scope` text. These
 * constants are the tool-level `description` only (what the tool does + query
 * semantics + return shape), which is surface-independent because both surfaces
 * call the same `@coredoc/mcp` handler.
 *
 * `run_cypher_query` is the one tool whose rendered description is composed per
 * surface: the base entry below carries the surface-independent prose, and
 * {@link buildCypherDescription} appends the query shape of the dialect(s) the
 * calling surface can actually serve (local = the active backend; hosted =
 * Ladybug/Kùzu only). Still authored ONCE — the composition is rendering, not a
 * second authoring site.
 */
import { NodeType, EdgeType } from '@coredoc/core/types';
import type { CypherDialect } from '@coredoc/db';

export const TOOL_DESCRIPTIONS = {
  // Impact Analysis
  analyze_change_impact:
    'Given a function, class, interface, type alias, enum, or entity NAME — shows everything affected if it changed: direct callers, transitive callers, type users, exposed entrypoints, and cross-repo impacts. `target` must be a declaration name, not a file path — call list_file_symbols first to get the names declared in a file, then pass one of those here. For package/npm exported-symbol impact, use the project-wide scope token `project:<project-id>`; scoping to the declaring repo intentionally returns only that repo and excludes external importers.',
  find_callers:
    'Find everything that calls a function — direct and transitive, plus which entrypoints ultimately trigger it. Use find_dependents for types/interfaces instead.',
  find_dependents:
    'Find code that depends on a class or interface: subclasses, implementations, and functions that use it as a type. Use find_callers for functions. For package/npm exported-symbol impact, use the project-wide scope token `project:<project-id>`; scoping to the declaring repo intentionally returns only that repo and excludes external importers.',
  find_entity_usage:
    'Find all functions that read, write, update, or delete a specific DB model. Filter by operation (create/read/update/delete) to narrow results.',

  // Understanding Code
  explain:
    'Default entry point for "what is X?" — returns the declaration\'s structure INLINE, in one call. Pass any symbol name (`User`, `UserService.createUser`, `UserPermissionsPage`), an HTTP path (`POST /v1/users`), or a `path:line` location (`src/foo.ts:42`) and explain routes to the right handler. Functions/methods → full function structure (purpose, callees, DB operations, external calls). HTTP/queue/cron paths → entrypoint deep-dive (handler, full call tree, DB models touched). A `path:line` resolves to the innermost symbol spanning that line — handy for stack frames or grep hits where you have a location but not a name. Structural types return their members inline: entities → the full describe_db_schema block (columns with types/flags, relations, and enum-typed columns showing their values); enums → their values; interfaces/DTOs → their fields with types and optionality; type aliases → the resolved type; classes → their properties. Deeper navigation tools (find_entity_usage, find_dependents, …) are listed as a one-line "Deeper:" footer below the inlined structure. Default detail is compact (lists/values truncated with `+N more`); `detailLevel: "full"` expands everything. When one declaration maps to multiple node kinds (class+entity for a TypeORM/MikroORM model, class+component for a React class component, function+component for a React FC), it returns a single result inlining the richest applicable view (entity schema for class+entity) and notes the other kinds — you do NOT get a disambiguation choice for these. A genuine name collision across DIFFERENT files still returns a disambiguation list — pass `className` or `fileHint` to pick one. When nothing matches exactly, returns up to 5 "did you mean…?" suggestions.',
  // Discovery
  search_symbols:
    'Search for any named symbol by DECLARED NAME (not full-text, not semantic). QUERY MATCHING — READ FIRST: multiple words are AND-matched — every whitespace-separated word must appear in the same symbol name (e.g. `Webhook SendEvent` matches only a name containing BOTH, like `WebhookSendEventHandler`). Listing related-but-distinct terms (`Consumer Integration Webhook Partner`) will usually match nothing, because no single name contains all of them — search one concept at a time. A single bare word is a substring match (`createTemplate` finds `createTemplateFromSource`); `*`/`?` are wildcards passed through verbatim. Searches declared names only — it cannot answer concept questions like "where is the token encrypted" (no term-level/semantic index). With default `type=all`, it covers functions, classes, interfaces, type aliases, enums, entrypoints, DB entities, React components, frontend routes, and exported top-level variables/constants; use `type=file` explicitly to search files, or `type=variable` to include non-exported variables/constants too. To VERIFY a known reference instead of discovering candidates, pass `exact: true` (and optionally `path`) to pin down the single canonical node and its owning repo.',
  list_entrypoints:
    'List all entrypoints — HTTP, queue, cron, CLI. Filter by type, or by `pathFilter` — which matches any address the entrypoint has: HTTP path, queue/event destination, Kafka topic, GraphQL field, cron schedule, CLI command.',
  describe_repository:
    'Start here. Use mode: inventory for compact repository membership and parse coverage without packages; omit it for the full overview. Returns codebase summary: language, framework, file/function counts, entrypoint types, and connected services. Call with no `scope` to list the repositories in the current project — the response narrows to the active workspace/project boundary, so you never have to guess scope names (and never see repos from unrelated workspaces). Pass `scope` once you know which repo to dive into; `availableRepos` in that response lists sibling repos you can pivot to. To see a DIFFERENT project than the current one, pass the project-wide scope token `project:<project-id>` — it returns the repo list of that project in the same shape.',
  describe_db_schema:
    'Return the database structure — entities (tables) with their columns (name, db type, primary-key/unique/nullable/generated flags, defaults), relations (associations + join columns), and indexes where available. Pass `entityName` (entity name like "User" or a table name like "users") to deep-dive ONE table at full detail — use this for the schema context needed to write correct SQL. Omit `entityName` to dump the whole schema for a SINGLE repo: these are per-service DBs, so you must pass `scope` to pick the repo (it errors if scope spans 0 or many repos). The whole-schema dump defaults to a COMPACT overview (each table → its column names + relation count); pass `detailLevel: "full"` for every column with types/flags, or `entityName` for one table. Pairs with find_entity_usage, which shows which functions read/write a given entity.',
  get_extraction_coverage:
    'Report what the extraction actually bound per repo in scope — use it to judge whether an EMPTY result from another tool means "the code has none" or "the extractor missed it". Returns, per repo: raw node counts by kind; IN-REPO CALL RESOLUTION over the call sites the parser counted — how many of the sites whose callee name IS declared in this repository were bound, plus how many counted sites name nothing declared here (out of scope: no node in the graph could be their target); DB-OPERATION RESOLUTION over the db-operation sites the parser counted — how many bound to an entity, plus how many name no entity or table declared here — beside how many entities have at least one recorded DB operation; and external calls total + share resolved to a known target. Call resolution, db-operation resolution and entity operations carry NO threshold, target or verdict — they are counts, and a repo of small leaf functions is not a defect; only external-call resolution is still flagged LOW. "Not measured by this graph\'s parser" means the graph predates the measurement: re-parse and re-push to measure it, and until then unbound calls are neither proven nor excluded. Unbound in-repo call sites, unmeasured repos and sparse entity operations all mean empty results (find_callers, find_entity_usage, list_service_dependencies) are inconclusive: verify with source (grep) before asserting nonexistence.',

  // Cross-Repo
  trace_cross_repo_call:
    'Trace a call across service boundaries. For request/response calls, provide targetService or a callPattern such as POST /api/users or an SDK method. For async messaging, provide a case-sensitive destination and optional case-insensitive system; when the same destination exists in multiple systems and system is omitted, the result is an explicit ambiguity listing available systems. Legacy systemless rows appear under the reserved system value "unknown". For request/response tracing, `scope` is the VANTAGE, not a boundary: the caller of a cross-repo call normally lives in another repo, so the whole local graph is searched for the counterpart and the answer says when it came from outside the requested scope. A callPattern may name the call (`GET /path`, an SDK method) or the callee (a handler name), and other bridges matching the same pattern are listed with both repo names.',
  list_service_dependencies:
    'List all external services and internal systems this repo calls — third-party APIs, microservices, IPC — with call counts and usage patterns.',

  // Escape hatch: the base prose is deliberately DIALECT-NEUTRAL (no table or
  // label names) so buildCypherDescription can append exactly the query shape
  // the calling surface serves, without contradicting it.
  run_cypher_query:
    'Escape hatch for graph questions the fixed tools do not cover — run ONE read-only Cypher query directly against the parsed code graph (aggregations like "functions per repo", custom traversals, property filters, ad-hoc joins of node kinds). Prefer the purpose-built tools when one fits: they are scoped, formatted and cheaper. RESTRICTIONS: read-only and a single statement — mutations and side-effecting/administrative clauses (CREATE, MERGE, SET, DELETE, REMOVE, DROP, FOREACH, CALL, LOAD, INSERT, USE, ATTACH, COPY, EXPORT, IMPORT, INSTALL, SHOW, GRANT, …) and multiple `;`-separated statements are rejected before execution; there is no full-text index, so use search_symbols for name search. RESULT SHAPES: `rows` (default) returns a scalar table — project scalars (`RETURN n.name AS name, count(*) AS total`); returning a whole node, list or map is rejected with projection guidance (aggregates are fine). `graph` returns nodes/edges for subgraph questions. LIMITS: results are capped (default 200, max 500) and the response reports a `truncated` flag when the cap bit; there is no cursor — paginate INSIDE the query with a stable ORDER BY plus SKIP/LIMIT. SCOPE WARNING: `scope` selects WHICH graph is queried, but the Cypher itself is NOT repo-filtered within that graph — add your own `repoId`/repo predicate when you mean one repo. GOTCHA: a node\'s `properties` field is a JSON string, not a map — read it as text (or project the top-level columns instead). SOURCE: function/method source bodies are NOT stored in this graph — by default a NODE\'s `properties`/`sourceCode`, and any `x.*` star projection (it expands to the whole node table), are rejected before execution (a hosted deployment MAY opt in to storing source, in which case `properties` can contain it). A RELATIONSHIP variable bound by a pattern (`MATCH (a)-[r:OPERATES_ON]->(b)`) may project `r.properties` and `r.*`: edge properties are operation metadata, not source. Query the fields that ARE always available instead — `name`, `type`, `filePath`, `startLine`, `endLine`, `summary`, `repoId` — or call describe_db_schema for the full field-level schema.',
} as const;

/** Cypher dialects this tool can document — the guard's vocabulary, not a second copy. */
export type { CypherDialect };

/**
 * Compact vocabulary line. Built from the enums so it cannot drift from the
 * graph itself; the per-kind meaning lives in the skill reference, not here.
 */
const GRAPH_VOCABULARY =
  `Node kinds: ${Object.values(NodeType).join(', ')}. ` +
  `Edge kinds: ${Object.values(EdgeType).join(', ')}. ` +
  "Full field-level schema: the coredoc-mcp skill's references/graph-schema.md.";

const DIALECT_SHAPES: Record<CypherDialect, string> = {
  ladybug:
    "Query shape (Ladybug/Kùzu): ONE node table `GraphNode(id, type, name, properties, summary, repoId, filePath, startLine, endLine)` — filter kinds by property, e.g. `MATCH (n:GraphNode) WHERE n.type = 'function' RETURN n.name AS name`. Each edge kind is its OWN relationship table named after the edge kind (`MATCH (a:GraphNode)-[:CALLS]->(b:GraphNode)`), each carrying `id, confidence, createdBy, properties`.",
  neo4j:
    'Query shape (Neo4j): every node carries the shared `CodeNode` label PLUS a per-kind label, so filter by label — `MATCH (n:function) RETURN n.name AS name` — and use `MATCH (n:CodeNode)` to span all kinds. Relationship types are the edge kinds (`MATCH (a:CodeNode)-[:CALLS]->(b:CodeNode)`).',
};

/**
 * Render the `run_cypher_query` description for a surface: the shared base
 * prose plus the query-shape section of each dialect that surface can serve
 * (local renders the active backend; hosted renders Ladybug/Kùzu only).
 */
export function buildCypherDescription(opts: { dialects: CypherDialect[] }): string {
  const shapes = opts.dialects.map((dialect) => DIALECT_SHAPES[dialect]);
  return [TOOL_DESCRIPTIONS.run_cypher_query, GRAPH_VOCABULARY, ...shapes].join(' ');
}
