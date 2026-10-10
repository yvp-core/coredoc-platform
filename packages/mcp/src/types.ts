/**
 * MCP Server Type Definitions
 *
 * Types for the Model Context Protocol server that provides AI agents
 * with structured access to parsed codebase data stored in Database.
 */

import type {
  EntityField,
  EntityRelation,
  EntityIndex,
  FunctionNode,
  EntrypointType,
  DbOperationType,
} from '@coredoc/core/types';
import type {
  CallerInfo as DbCallerInfo,
  EntityInfo as DbEntityInfo,
  EntrypointInfo as DbEntrypointInfo,
  FunctionInfo as DbFunctionInfo,
} from '@coredoc/db/types';

/** The declaration convention a synthesized node came from (see {@link FunctionInfo.synthesized}). */
type SynthesizedOrigin = FunctionNode['synthesized'];

// =============================================================================
// Scope Resolution Types
// =============================================================================

/**
 * Context for scoping queries to the correct repositories
 */
export interface ScopeContext {
  /** Current workspace path provided by AI agent */
  currentPath: string;
  /** Directory containing the config that resolved this local scope. */
  configDir?: string;
  /** Matched repo names from config */
  resolvedRepos: string[];
  /** Repo hashes for Cypher WHERE clauses */
  repoHashes: string[];
  /** Project name for cross-repo queries */
  project?: string;
  /** Project id (slug) — required to locate parser/output files on disk */
  projectId?: string;
  /**
   * Repo names that bound the current project context (from the resolved
   * `COREDOC_SCOPE=project:X` binding in local MCP, or workspace/project
   * binding in cloud MCP). Set independently of how `resolvedRepos` got
   * populated so tools can still filter discovery output to the project even
   * when the AI's scope arg is a single repo or unresolved.
   */
  projectBoundedRepos?: string[];
  /**
   * The "vantage" repo — the repo the MCP server is physically running from
   * (`COREDOC_CURRENT_REPO`), resolved to a name WITHIN the resolved scope. A
   * HINT distinct from the boundary: present when the host told us where the
   * agent is standing AND that repo is inside the scope. Single-origin tools
   * (list_service_dependencies) prefer this over guessing `resolvedRepos[0]`.
   * Undefined when no vantage was supplied or it fell outside the scope.
   */
  currentRepo?: string;
  /** Repo hash for the vantage repo (parallel to {@link currentRepo}). */
  currentRepoHash?: string;
  /**
   * The per-process stdio session id (see `createServer` in server.ts),
   * threaded through purely so the staleness-banner dedupe
   * (staleness-dedupe.ts) can key repeat-mention compaction per session.
   * Undefined for callers that don't track a session (tests, direct
   * programmatic use) — the dedupe treats that as "always render full".
   */
  sessionKey?: string;
  /** Whether cross-repo queries are enabled */
  crossRepoEnabled: boolean;
  /**
   * How this scope was resolved. `'workspace'` is set ONLY by the cloud
   * workspace resolver (apps/server resolveWorkspaceScope): its `repoHashes`
   * enumerate the workspace's connected repos and are a hard boundary — tools
   * that widen an unbound local scope to the whole graph (destination-mode
   * `trace_cross_repo_call` via `resolveMessagingQueryHashes`, which returns
   * the `[]` = all-repos convention) must NEVER widen past a
   * workspace-resolved scope, because
   * the backing store can hold rows outside it (shared Neo4j; disconnected
   * repos whose data is not purged). Absent for locally resolved scopes.
   */
  origin?: 'workspace' | 'local';
  /**
   * Every repo hash connected to the workspace, set with `origin: 'workspace'`.
   * A `scope` argument narrows `repoHashes` to one repo; this keeps the
   * membership boundary so a cross-repo lookup can still reach the other side.
   */
  workspaceRepoHashes?: string[];
}

/**
 * Result of resolving a scope from a path
 */
export interface ScopeResolutionResult {
  /** Resolved scope context */
  scope: ScopeContext;
  /** Whether resolution was successful */
  success: boolean;
  /** Error message if resolution failed */
  error?: string;
}

// =============================================================================
// Staleness Types
// =============================================================================

/**
 * Staleness information for response metadata
 */
export interface StalenessInfo {
  /** Warning message about data staleness */
  warning: string;
  /** ISO timestamp when data was last parsed */
  parsedAt: string;
  /** Branch that was parsed, if tracked */
  parsedBranch?: string;
  /**
   * The commit the graph was parsed at — the same repo `parsedAt` names, so the
   * pair describes one snapshot. Present only when that repo's parse captured a
   * commit; ABSENT otherwise, never an empty string, because a consumer
   * comparing against '' would decide on a value nobody produced.
   *
   * This is what lets a consumer ask the binary question "does the graph see my
   * base?" — a timestamp cannot answer it: clocks differ between the parse host
   * and the commit's own dates, so a skewed date silently reads as fresh.
   */
  parsedCommit?: string;
  /** Per-repository snapshots; a multi-repo answer has no single parse point. */
  repositories?: Array<{
    name: string;
    parsedAt: string;
    parsedCommit?: string;
    parserVersion?: string;
  }>;
}

// =============================================================================
// Response Types
// =============================================================================

/**
 * Output format for MCP responses
 */
export type OutputFormat = 'summary' | 'raw';

// =============================================================================
// Detail Level Types
// =============================================================================

/**
 * Detail level presets for controlling response granularity
 *
 * | Level | What's Included                                                                   | Use Case                        |
 * |-------|-----------------------------------------------------------------------------------|---------------------------------|
 * | basic | id, name, filePath, startLine                                                     | Quick lookups, counting impacts |
 * | full  | Everything: AI summaries, caller/callee refs with locations, endLine, … (default) | Deep understanding              |
 */
export type DetailLevel = 'basic' | 'full';

/**
 * Configuration for what fields to include based on detail level
 */
export interface DetailLevelConfig {
  /** Include basic fields: id, name, filePath, startLine */
  includeBasic: true;
  /** Include AI-generated summaries (purpose, summary, businessLogic) */
  includeSummaries: boolean;
  /** Include caller/callee references with locations */
  includeRefs: boolean;
  /** Include all optional fields (endLine, visibility, isAsync, etc.) */
  includeFullDetails: boolean;
}

/**
 * One symbol that shares the looked-up name but was NOT the one resolved.
 * Carries exactly the fields an agent needs to re-target it via `fileHint`.
 */
export interface AmbiguityCandidate {
  name: string;
  /** NodeType of the candidate (function, class, entity, …). */
  type: string;
  filePath: string;
  startLine: number;
  /** Owning repository name (multi-repo scope only). */
  repo?: string;
}

/**
 * Set when a by-name lookup matched more than one symbol in scope. The tool
 * still returns full data for the first match; this records the alternatives so
 * the response can say "N more exist — disambiguate with fileHint/className"
 * instead of silently dropping them. Rendered as a header banner (like
 * staleness) so every tool surfaces it consistently.
 */
export interface AmbiguityInfo {
  /** Total exact-name matches in scope, including the resolved one. */
  totalMatches: number;
  /** The alternatives not chosen (capped for display). */
  others: AmbiguityCandidate[];
  /** Alternatives beyond those listed in `others`. */
  moreCount: number;
  /** Human-readable, agent-facing disambiguation hint. */
  hint: string;
}

/**
 * Base response metadata included in all MCP responses
 */
export interface McpResponseMetadata {
  /** Scope context for the query */
  scope: ScopeContext;
  /** Staleness information */
  staleness: StalenessInfo;
  /** Output format used */
  format: OutputFormat;
  /** Detail level used */
  detailLevel: DetailLevel;
  /** Detail level config for filtering fields */
  detailConfig: DetailLevelConfig;
  /**
   * Present when the tool resolved a name that matched multiple symbols. Lets
   * the formatter surface a "N more matches" banner and raw consumers read the
   * alternatives structurally. Omitted when the lookup was unambiguous.
   */
  ambiguity?: AmbiguityInfo;
  /** Evidence limits shown before summary results and preserved in raw output. */
  warnings?: string[];
}

/**
 * Generic MCP response wrapper
 */
export interface McpResponse<T> {
  /** Response data */
  data: T;
  /** Response metadata */
  metadata: McpResponseMetadata;
  /**
   * Set by tool handlers that "succeeded at running" but resolved nothing
   * (entity / function / entrypoint not in scope). Lets composing tools
   * — e.g. `explain` dispatching to `explain_function` — detect a miss
   * without sniffing the formatted prose, which collides with the
   * success-summary string.
   */
  isError?: boolean;
  /**
   * Number of items the handler produced — set by list-returning tools so
   * MCP metrics can track empty/low-yield retrieval (drives the embedding
   * decision: high empty-rate on search_symbols → embeddings help). Omit
   * for single-entity tools; the server falls back to `isError` to flag
   * those as empty.
   */
  resultCount?: number;
  /**
   * Total items available BEFORE the `limit` cut — set by paginated list
   * tools on a truncated raw page, so raw consumers can tell
   * "limit returned" from "limit exist". Omitted when nothing was cut.
   */
  totalCount?: number;
}

// =============================================================================
// Tool Input Filter Types
// =============================================================================

/**
 * Database operation filter type
 */
export type DbOperationFilter = DbOperationType | 'all';

/**
 * Entrypoint type filter
 */
export type EntrypointTypeFilter = EntrypointType | 'all';

/**
 * Code element type for search
 */
export type CodeElementType =
  | 'file'
  | 'function'
  | 'class'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'entrypoint'
  | 'entity'
  | 'component'
  | 'route'
  | 'variable'
  | 'state_store'
  | 'all';

// =============================================================================
// Tool Output Types
// =============================================================================

/**
 * Basic code element info returned in results
 */
export interface CodeElementInfo {
  /** Element name */
  name: string;
  /** File path relative to repo */
  filePath: string;
  /** Start line number */
  startLine: number;
  /** End line number */
  endLine?: number;
  /** Element type */
  type: CodeElementType;
  /**
   * Every node kind collapsed at this location, in precedence order, when the
   * substrate emitted one declaration under multiple kinds (class+entity,
   * function+component). Length > 1 only for genuine multi-kind declarations;
   * `type` is the precedence winner (`kinds[0]`). Absent for ordinary
   * single-kind symbols. Lets a row show its dual nature without a duplicate row.
   */
  kinds?: CodeElementType[];
  /** Stable ID for further queries */
  id: string;
  /** AI-generated summary */
  summary?: string;
  /** AI-generated one-line purpose — concise; preferred over `summary` in list output. */
  purpose?: string;
  /**
   * Raw source body. Present ONLY when ALLOW_SOURCES_IN_GRAPH is enabled (it
   * gates both storage and retrieval) AND the caller passed `includeSource: true`.
   * Reflects the parsed snapshot/branch — verify against the working tree before
   * editing. Omitted otherwise.
   */
  sourceCode?: string;
  /**
   * Owning repository name. Populated ONLY when the query scope spans more
   * than one repo (project / cross-repo scope) so agents don't conflate
   * same-named symbols across repos; omitted in single-repo scope where every
   * node is from the same repo and the field would be redundant. Derived from
   * the repo-hash prefix of `id` (`{repoHash}:{type}:…`).
   */
  repo?: string;
  /**
   * The row's symbol identity was never verified — it was matched by NAME only
   * (a name-matched import), so it may be a DIFFERENT symbol than the one asked
   * about. A structured trust flag, never folded into `name`: `name`/`id` stay
   * machine-usable for a follow-up `explain`, and the text formatter renders the
   * caveat from this flag. Survives the basic detail level (see filterCodeElementInfo).
   */
  ambiguous?: boolean;
  /**
   * The RELATIONSHIP that produced this row was inferred, not proven: the engine
   * bound it by a heuristic tier (a sole `implements` declaration, a name
   * collision) rather than a resolved symbol, and wrote the edge at confidence
   * 0.5. `CallProvenance` in @coredoc/core states consumers "must render it as
   * inferred" — this field is how they do it.
   *
   * Distinct from `ambiguous`, which is about the row's own IDENTITY: an
   * `ambiguous` row may be the wrong symbol, a `provenanceInferred` row is the
   * right symbol reached over an edge that may not exist. Both are structured
   * trust flags, never folded into `name`/`id` (an agent re-issuing
   * `explain("X (inferred)")` gets nothing), and both survive the basic detail
   * level — a caveat that only appears at `detailLevel: "full"` is a caveat the
   * default response never shows.
   */
  provenanceInferred?: true;
}

// =============================================================================
// Detail Level Response Variants
// =============================================================================

/**
 * Basic code element (detailLevel: 'basic')
 * Minimal fields for quick lookups and counting
 */
export interface CodeElementBasic {
  /** Stable ID for further queries */
  id: string;
  /** Element name */
  name: string;
  /** Element type */
  type: CodeElementType;
  /** File path relative to repo */
  filePath: string;
  /** Start line number */
  startLine: number;
  /**
   * Every node kind collapsed at this location, when the declaration is
   * genuinely multi-kind (class+entity, function+component). See
   * CodeElementInfo.kinds — identity, not a detail upgrade, so it survives the
   * basic filter whenever `length > 1`; otherwise `type` already says it.
   */
  kinds?: CodeElementType[];
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
  /** Unverified (name-matched) identity. See CodeElementInfo.ambiguous — a trust flag, not display text. */
  ambiguous?: boolean;
  /** Inferred (not proven) relationship. See CodeElementInfo.provenanceInferred — a trust flag, not display text. */
  provenanceInferred?: true;
  /**
   * The tool's one relationship datum ("used as parameter (status)", "branches
   * on Status.Locked (value)"), present at basic ONLY for the tools that opt in
   * via `filterCodeElementInfo`'s `preserveSummary` — never an AI summary.
   */
  summary?: string;
}

/**
 * Function info with basic fields only
 */
export interface FunctionBasic extends CodeElementBasic {
  /** Kind of function */
  kind?: 'function' | 'method';
  /** Parent class name (for methods) */
  className?: string;
  /** See {@link FunctionInfo.synthesized}. A trust flag, preserved at every detail level. */
  synthesized?: SynthesizedOrigin;
}

/**
 * Caller info with basic fields only
 */
export interface CallerBasic extends FunctionBasic {
  /** Distance from target (1 = direct caller) */
  distance: number;
}

/**
 * Entrypoint with basic fields only
 */
export interface EntrypointBasic {
  /** Stable ID */
  id: string;
  /** Entrypoint type */
  type: EntrypointInfo['type'];
  /** HTTP method (if http) */
  method?: string;
  /** Route path (if http) */
  path?: string;
  /** Full path including base */
  fullPath?: string;
  /** GraphQL field name */
  fieldName?: string;
  /** GraphQL operation type */
  operationType?: 'query' | 'mutation' | 'subscription';
  /** Topic/queue name */
  topic?: string;
  /** Runtime topic string when `topic` is a source-level token. */
  topicValue?: string;
  /** Queue system or event emitter. */
  system?: string;
  /** Destination token as written in source. */
  destination?: string;
  /** Runtime destination when statically resolved. */
  destinationValue?: string;
  /** Cron schedule */
  schedule?: string;
  /** Event name (for event/websocket entrypoints) */
  eventName?: string;
  /** CLI command (for cli entrypoints) */
  command?: string;
  /** Component class name — the ADDRESS of a mobile entrypoint, as `command` is for cli. */
  className?: string;
  /** What triggers a mobile entrypoint (launcher, push, broadcast, …). A label, not an address. */
  trigger?: string;
  /** Handler function ID */
  handlerId: string;
  /** Handler function name */
  handlerName: string;
  /** File path */
  filePath: string;
  /** Line number */
  startLine: number;
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Function info with optional summary
 */
export interface FunctionInfo
  extends CodeElementInfo,
    Pick<DbFunctionInfo, 'kind' | 'className' | 'visibility' | 'synthesized'> {
  type: 'function';
  /** Is async function */
  isAsync?: boolean;
}

/**
 * Caller information with distance
 */
export interface CallerInfo extends FunctionInfo, Pick<DbCallerInfo, 'distance' | 'callSiteLine'> {
  /** Call site file path */
  callSiteFile?: string;
}

/**
 * Entrypoint information
 */
export interface EntrypointInfo
  extends Pick<
    DbEntrypointInfo,
    | 'type'
    | 'method'
    | 'path'
    | 'fullPath'
    | 'fieldName'
    | 'operationType'
    | 'topic'
    | 'topicValue'
    | 'system'
    | 'destination'
    | 'destinationValue'
    | 'schedule'
    | 'handlerId'
    | 'eventName'
    | 'className'
    | 'trigger'
    | 'command'
    | 'filePath'
    | 'startLine'
    | 'id'
    | 'summary'
    | 'purpose'
  > {
  /** Handler function name */
  handlerName: string;
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Entity (database model) information
 */
export interface EntityInfo
  extends Pick<DbEntityInfo, 'name' | 'tableName' | 'ormType' | 'schema' | 'filePath' | 'startLine' | 'id'> {
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Entity consumer (function that operates on entity)
 */
export interface EntityConsumerInfo extends FunctionInfo {
  /** Operation type. `ddl` is a schema change (CREATE/DROP/ALTER/TRUNCATE), not row traffic. */
  operation: DbOperationType;
}

/**
 * Full DB structure for one entity (table) — columns, relations, and indexes.
 * Returned by `describe_db_schema`. Carries the complete schema an assistant
 * needs to describe the data model or write correct SQL against it.
 */
export interface DbSchemaEntity {
  /** Stable entity id */
  id: string;
  /** Entity (model) name */
  name: string;
  /** DB table name */
  tableName: string;
  /** ORM type (prisma, typeorm, sequelize, activerecord, …) */
  ormType: string;
  /** DB schema name, when set */
  schema?: string;
  /** Source file path */
  filePath: string;
  /** Declaration line */
  startLine: number;
  /** Columns */
  fields: EntityField[];
  /** Relations to other entities */
  relations: EntityRelation[];
  /** Indexes — only populated by ORM paths that expose them (e.g. ActiveRecord) */
  indexes?: EntityIndex[];
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Impact analysis result
 */
export interface ChangeImpactResult {
  /** Target element info */
  target: CodeElementInfo;
  /** Direct callers */
  directCallers: CallerInfo[];
  /** Transitive callers (beyond direct) */
  transitiveCallers: CallerInfo[];
  /** Elements that reference the target as a type (USES_TYPE edges).
   * Distinct from directCallers because type users may be classes,
   * interfaces, or type aliases — not just functions. The `summary` field
   * carries the precise usage ("used as parameter (userId)", "used as
   * return", "used as property (config)", etc.). */
  typeUsers?: CodeElementInfo[];
  /** Entrypoints that reach this code */
  affectedEntrypoints: EntrypointInfo[];
  /** Test files that cover this */
  affectedTests: CodeElementInfo[];
  /** Cross-repo impacts */
  crossRepoImpacts?: {
    /** Repo name */
    repo: string;
    /** Consumers in that repo */
    consumers: CallerInfo[];
  }[];
  /** Risk assessment */
  riskLevel: 'low' | 'medium' | 'high';
  /** Summary of impact */
  impactSummary: string;
}

/**
 * Function explanation result
 */
export interface FunctionExplanationResult {
  /** Function info */
  function: FunctionInfo;
  /** AI-generated business logic description */
  businessLogic?: string;
  /** AI-generated side effects description */
  sideEffects?: string;
  /** What this function calls */
  callees?: FunctionInfo[];
  /** Who calls this function */
  callers?: CallerInfo[];
  /** Database operations performed */
  dbOperations?: {
    /** Entity affected */
    entity: string;
    /** Operation type */
    operation: string;
  }[];
  /** External service calls */
  externalCalls?: {
    /** Service/API called */
    service: string;
    /** Pattern (URL, topic, etc.) */
    pattern: string;
  }[];
}

/**
 * Entrypoint explanation result
 */
export interface EntrypointExplanationResult {
  /** Entrypoint info */
  entrypoint: EntrypointInfo;
  /** Handler function explanation */
  handler: FunctionExplanationResult;
  /** Full call tree from handler */
  callTree: FunctionInfo[];
  /** Entities touched */
  entities: EntityInfo[];
  /** External services called */
  externalServices: string[];
  /** Services that call this endpoint */
  upstreamCallers?: {
    repo: string;
    callSites: number;
  }[];
}

/**
 * Repository overview result
 */
export interface RepoOverviewResult {
  /** Repo name */
  name: string;
  /** Repo type */
  type: string;
  /** When it was parsed */
  parsedAt: string;
  /** The `origin` remote URL (the "git link"), if captured at parse time. */
  gitRemoteUrl?: string;
  /**
   * Per-repo overview (only populated when scope spans multiple repos, e.g.
   * `COREDOC_SCOPE=project:foo`). Each row carries the repo's own stats so
   * agents see the project structure as a table of distinct repos instead
   * of a single aggregated dump that hides parse gaps and conflates
   * unrelated packages.
   */
  repos?: Array<{
    name: string;
    /**
     * Repo role. `type` from the repository node when set; otherwise
     * derived from contained packages: 1 package → that package's type
     * (backend / frontend / library / etc.), >1 → 'monorepo'.
     */
    type: string;
    parsedAt: string;
    fileCount: number;
    functionCount: number;
    classCount: number;
    entityCount: number;
    entrypointTypes: string[];
    summary?: string;
    parsed: boolean;
    /**
     * Packages inside this repo. Populated only when there's >1 (i.e. the
     * repo is a monorepo) — single-package repos already convey their
     * type via the `type` field.
     */
    packages?: Array<{ name: string; path: string; type?: string; description?: string }>;
  }>;
  /** Statistics */
  stats: {
    /** Total files */
    files: number;
    /** Total functions */
    functions: number;
    /** Total classes */
    classes: number;
    /** Total entrypoints */
    entrypoints: number;
    /** Total entities */
    entities: number;
  };
  /** Detected frameworks */
  frameworks: string[];
  /** Main packages/modules */
  packages: Array<{ name: string; path: string; type?: string; language?: string; description?: string }>;
  /** Entrypoint breakdown by type */
  entrypointsByType: Record<string, number>;
  /** Available repos in scope */
  availableRepos?: string[];
  /**
   * Discovery list populated ONLY on no-scope `describe_repository` calls.
   * Filtered to the current project boundary (the `COREDOC_SCOPE=project:X`
   * binding in local MCP, workspace binding in cloud MCP) so agents see the sibling
   * repos they care about and never repos from unrelated workspaces. Falls
   * back to the full graph when no project boundary is known (bootstrap
   * case only).
   */
  allKnownRepos?: Array<{
    name: string;
    type: string;
    parsedAt: string;
    summary?: string;
    /** Owning project id from config, when known. Discovery list only. */
    project?: string;
    /**
     * Copy-pasteable `scope` token. Equals the qualified `project/repo` form
     * when the repo's project is known (so it round-trips even across name
     * collisions), else the bare name. Discovery list only.
     */
    scopeToken?: string;
  }>;
  /** AI-generated repository summary */
  summary?: string;
  /** Data model description */
  dataModel?: string;
  /** External integrations list */
  externalIntegrations?: string[];
}

/**
 * Service dependency result
 */
export interface ServiceDependencyResult {
  /** Service/repo name */
  service: string;
  /** Number of call sites */
  callCount: number;
  /** Number of call sites resolved to a downstream entrypoint */
  resolvedCount: number;
  /** Types of calls (http, kafka, etc.) */
  callTypes: string[];
  /** Example patterns */
  patterns: string[];
}

/**
 * One semantic_search match — an embedded node ranked by cosine similarity
 * against the embedded query. Carries names/locations/summaries only, never
 * source code (GUARDRAILS: semantic_search must not expose sourceCode).
 */
export interface SemanticSearchResult {
  /** Stable node ID */
  id: string;
  /** Symbol name */
  name: string;
  /** Node kind (function or entrypoint — the only embedded kinds) */
  kind: string;
  /** File path relative to repo */
  filePath: string;
  /** Declaration line */
  startLine: number;
  /** Cosine similarity to the query, rounded to 2 decimals */
  similarity: number;
  /** AI-generated summary, when stored */
  summary?: string;
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

// =============================================================================
// Explain Tool Types
// =============================================================================

/**
 * One candidate row returned when `explain` can't pick a single match. The
 * agent retries with `className` or `fileHint` to disambiguate. Also used
 * for the "did you mean…?" fuzzy fallback when no exact match exists.
 */
export interface ExplainCandidate {
  name: string;
  kind: CodeElementType | 'unknown';
  filePath: string;
  startLine: number;
  endLine?: number;
  summary?: string;
  /** Owning class for method nodes, so candidates render `Foo.bar`. */
  className?: string;
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Per-kind metadata returned when `explain` resolves to exactly one node and
 * the kind isn't covered by a dedicated tool (function/entrypoint route to
 * those instead). Intentionally narrow.
 */
export interface ExplainMetadata {
  name: string;
  kind: CodeElementType | 'unknown';
  /**
   * All node kinds the parser emitted at this exact location, when more than
   * one. The parser stores a single source declaration under multiple kinds —
   * a TypeORM model is both `class` and `entity`, a React FC is both `function`
   * and `component`. `kind` is the precedence winner (kept for prose); `kinds`
   * makes the dual nature explicit so the agent knows it can use EITHER
   * follow-up tool (e.g. find_dependents for the class AND find_entity_usage
   * for the entity). Omitted when the location has a single kind.
   */
  kinds?: (CodeElementType | 'unknown')[];
  filePath: string;
  startLine: number;
  endLine?: number;
  summary?: string;
  /** Type declarations expose extracted structure; their raw bodies are not stored. */
  sourceUnavailableReason?: 'disabled' | 'not-stored-for-kind';
  /** Missing extracted members do not establish that a declaration is empty. */
  structureNote?: string;
  /** Usage count via the kind-appropriate edge (USES_TYPE / OPERATES_ON / USES_COMPONENT / etc.). 0 when no edge applies. */
  usageCount?: number;
  /**
   * What `usageCount` actually counts, as a short relation phrase ("type
   * references + subclasses"). Different tools count a symbol over different
   * edge sets and each figure is individually correct, so a bare number reads
   * as a contradiction; the phrase is what makes the figure interpretable —
   * and keeps a structural zero from reading as a confident "nothing uses it".
   */
  usageRelation?: string;
  /**
   * One-line breakdown of a figure that sums relations the agent must act on
   * differently — currently how many enum usages are member-value reads and
   * which members they branch on. Omitted when there is nothing to break down;
   * omission is silence, not a claim that the other relation has no rows.
   */
  usageNote?: string;
  /**
   * Compact, pre-rendered preview of the methods the declaration CONTAINS
   * (class bodies). Separate from `fields`, which holds the declaration's own
   * data members — an agent asking "what does this class do?" needs the
   * methods, not the properties. Capped like `fields`.
   */
  methods?: string[];
  /** True count of contained methods; drives the "... and N more" line. */
  methodsTotal?: number;
  /** Owning class for methods/properties — surfaced so the agent sees `Foo.bar`. */
  className?: string;
  /** Pointer to the right follow-up tool, e.g. "Use find_dependents to list every consumer". */
  followUpHint?: string;
  /**
   * Compact, pre-rendered preview of the declaration's own fields — class
   * properties, interface members, or entity columns/relations — so an `explain`
   * on a DTO/model answers "what fields does it have?" inline, without a second
   * call. Capped; the follow-up hint points at the full view. Omitted for kinds
   * with no field structure.
   */
  fields?: string[];
  /** Heading for the `fields` block ("Columns", "Properties", "Members"). */
  fieldsLabel?: string;
  /** True when `fields` was truncated; total count for the "... and N more" line. */
  fieldsTotal?: number;
  /** Owning repository name (multi-repo scope only). See CodeElementInfo.repo. */
  repo?: string;
}

/**
 * Top-level shape returned by `explain`. Exactly one of `metadata` /
 * `function` / `entrypoint` / `candidates` is set, depending on the
 * resolution outcome.
 */
export interface ExplainResult {
  /** What was looked up — echoed for clarity in the response. */
  target: string;
  /** Resolution kind — drives formatter branching. */
  resolution: 'function' | 'entrypoint' | 'metadata' | 'disambiguation' | 'fuzzy' | 'not-found';
  /** When `resolution === 'function'`, the explain_function payload, unmodified. */
  function?: FunctionExplanationResult;
  /** When `resolution === 'entrypoint'`, the explain_entrypoint payload, unmodified. */
  entrypoint?: EntrypointExplanationResult;
  /** When `resolution === 'metadata'`, the per-kind shallow explainer payload. */
  metadata?: ExplainMetadata;
  /** When `resolution === 'disambiguation'` or `'fuzzy'`, candidate list. */
  candidates?: ExplainCandidate[];
  /** Human-readable hint for the agent's next call. */
  hint?: string;
}
