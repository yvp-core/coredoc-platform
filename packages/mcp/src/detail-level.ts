/**
 * Detail Level Configuration
 *
 * Provides preset configurations for different detail levels,
 * allowing LLMs to request different granularity of data to optimize token usage.
 */

import type {
  DetailLevel,
  DetailLevelConfig,
  FunctionInfo,
  CallerInfo,
  EntrypointInfo,
  CodeElementInfo,
  FunctionBasic,
  CallerBasic,
  EntrypointBasic,
  CodeElementBasic,
} from './types.js';

// =============================================================================
// Preset Configurations
// =============================================================================

/**
 * Detail level preset configurations.
 *
 * Two levels only: `basic` (identity + location — cheap lookups, counting) and
 * `full` (everything: AI summaries, caller/callee refs with locations, endLine,
 * visibility, …). The earlier `summary`/`refs` tiers were removed because they
 * collapsed onto `basic` for most node kinds — a function/entrypoint with no AI
 * summary, or any node whose `refs` projection added no fields — so they cost the
 * model a decision without changing the bytes returned.
 */
const DETAIL_LEVEL_CONFIGS: Record<DetailLevel, DetailLevelConfig> = {
  basic: {
    includeBasic: true,
    includeSummaries: false,
    includeRefs: false,
    includeFullDetails: false,
  },
  full: {
    includeBasic: true,
    includeSummaries: true,
    includeRefs: true,
    includeFullDetails: true,
  },
};

/**
 * Resolve detail level to configuration.
 *
 * Defaults to 'full' (backward-compatible) for an unset OR unrecognised level —
 * a stale client still sending the removed `summary`/`refs` gets the full payload
 * rather than a crash.
 */
export function resolveDetailLevel(level?: DetailLevel): DetailLevelConfig {
  return DETAIL_LEVEL_CONFIGS[level as DetailLevel] ?? DETAIL_LEVEL_CONFIGS.full;
}

/**
 * Detail level a dispatcher resolves when the caller omits `detailLevel`.
 *
 * Every LIST-SHAPED tool is basic-by-default: a list answers "which symbols /
 * which callers / which entrypoints", and identity + location + the one
 * relationship datum answers that. Shipping an AI summary per row multiplied the
 * cost of an inventory call by an order of magnitude for content the agent
 * almost never read (measured on the MCP eval runs: list payloads dominated the
 * per-call token budget while the answer used only the names and locations).
 * The full payload stays one explicit `detailLevel: "full"` re-call away, and
 * every basic response says so in its footer.
 *
 * Also basic-by-default, for their own reasons:
 *  - `explain` (per its tool description): its inline field/value previews only
 *    uncap on an explicit 'full' — the handler itself still renders the full
 *    structure for its function/entrypoint sub-dispatches (see explain.ts).
 *  - `get_intent_context`: the intent contract requires compact defaults, so the
 *    full typed product payload is returned only when asked for; identity,
 *    statement, authority, and anchor evidence are always present.
 *
 * Everything absent from this set (describe_repository, get_extraction_coverage,
 * describe_db_schema — which owns its own compact-by-default whole-dump rule —
 * run_cypher_query, list_service_dependencies, semantic_search) keeps 'full'.
 */
const BASIC_BY_DEFAULT_TOOLS = new Set([
  // Compact-by-contract.
  'explain',
  'get_intent_context',
  // List-shaped discovery / impact tools.
  'search_symbols',
  'list_entrypoints',
  'list_file_symbols',
  'find_callers',
  'find_dependents',
  'find_entity_usage',
  'analyze_change_impact',
  'trace_cross_repo_call',
]);

export function getDefaultDetailLevel(toolName?: string): DetailLevel {
  return toolName !== undefined && BASIC_BY_DEFAULT_TOOLS.has(toolName) ? 'basic' : 'full';
}

/**
 * One-line escalation footer for a basic-by-default response.
 *
 * A basic response is a deliberate truncation, so it must carry the exact
 * re-call that undoes it — an agent that cannot see the escalation path either
 * re-issues the same narrow call or (worse) concludes the extra detail does not
 * exist. Kept as one line, in the `>` blockquote register the staleness banner
 * and explain's `Deeper:` footer already use.
 */
export const DETAIL_ESCALATION_HINT =
  '> Basic detail (name · repo · file:line). Re-call with `detailLevel: "full"` for summaries and full refs.';

/**
 * The footer line when `level` is basic, else `undefined`. Summary-format only —
 * `raw` is a machine shape and must stay valid JSON.
 */
export function detailEscalationFooter(level?: DetailLevel): string | undefined {
  return level === 'basic' ? DETAIL_ESCALATION_HINT : undefined;
}

// =============================================================================
// Field Filtering Functions
// =============================================================================

/**
 * Filter function info based on detail level
 */
export function filterFunctionInfo(fn: FunctionInfo, config: DetailLevelConfig): FunctionBasic | FunctionInfo {
  if (config.includeFullDetails) {
    return fn;
  }
  return {
    id: fn.id,
    name: fn.name,
    type: fn.type,
    filePath: fn.filePath,
    startLine: fn.startLine,
    kind: fn.kind,
    className: fn.className,
    // A trust flag, not a detail upgrade: a node the substrate minted from a declaration
    // convention has no body to read, at any detail level.
    ...(fn.synthesized && { synthesized: fn.synthesized }),
  };
}

/**
 * Filter caller info based on detail level
 */
export function filterCallerInfo(caller: CallerInfo, config: DetailLevelConfig): CallerBasic | CallerInfo {
  if (config.includeFullDetails) {
    return caller;
  }
  return {
    id: caller.id,
    name: caller.name,
    type: caller.type,
    filePath: caller.filePath,
    startLine: caller.startLine,
    kind: caller.kind,
    className: caller.className,
    distance: caller.distance,
    // A trust flag, not a detail upgrade: an inferred CALLS edge must not read
    // as a proven one just because the caller stayed on the default level.
    ...(caller.provenanceInferred && { provenanceInferred: true as const }),
    ...(caller.synthesized && { synthesized: caller.synthesized }),
  };
}

/**
 * Filter entrypoint info based on detail level
 */
export function filterEntrypointInfo(ep: EntrypointInfo, config: DetailLevelConfig): EntrypointBasic | EntrypointInfo {
  if (config.includeFullDetails) {
    return ep;
  }
  return {
    id: ep.id,
    type: ep.type,
    method: ep.method,
    path: ep.path,
    fullPath: ep.fullPath,
    fieldName: ep.fieldName,
    operationType: ep.operationType,
    topic: ep.topic,
    topicValue: ep.topicValue,
    system: ep.system,
    destination: ep.destination,
    destinationValue: ep.destinationValue,
    schedule: ep.schedule,
    eventName: ep.eventName,
    command: ep.command,
    // A mobile entrypoint's address is its class name, exactly as a cli entrypoint's is its
    // command. Dropping it here would leave every row of a `list_entrypoints` call — which
    // defaults to BASIC detail — anonymous, and the agent with nothing to type back.
    className: ep.className,
    trigger: ep.trigger,
    handlerId: ep.handlerId,
    handlerName: ep.handlerName,
    filePath: ep.filePath,
    startLine: ep.startLine,
  };
}

/**
 * Per-call options for {@link filterCodeElementInfo}.
 */
export interface CodeElementFilterOptions {
  /**
   * Keep `summary` at basic detail.
   *
   * Set ONLY by the tools whose `summary` IS their one relationship datum:
   * find_dependents and analyze_change_impact write the USES_TYPE relation
   * ("used as parameter (status)", "constructs UserService", "branches on
   * Status.Locked (value)") into that field, so stripping it returns a list of
   * dependents that never says HOW anything depends — the one thing the call
   * was made to learn, and the datum the documented basic contract promises
   * ("name, repo, file:line, plus the tool's one relationship datum").
   *
   * A caller-supplied flag rather than a new wire field because "is this row's
   * summary the relation or an AI summary?" is knowledge the TOOL has and the
   * filter cannot recover — and because moving the datum to a new field would
   * break every existing consumer reading it from `summary` at full detail.
   */
  preserveSummary?: boolean;
}

/**
 * Filter code element info based on detail level
 */
export function filterCodeElementInfo(
  el: CodeElementInfo,
  config: DetailLevelConfig,
  options?: CodeElementFilterOptions,
): CodeElementBasic | CodeElementInfo {
  if (config.includeFullDetails) {
    return el;
  }
  // `repo`, `kinds`, `ambiguous` and `provenanceInferred` are preserved across
  // both levels — `repo` is the multi-repo attribution agents rely on, `kinds`
  // is what a genuinely dual-kind declaration IS (dropping it makes
  // response-formatter fall back to `type` and render a class+entity as a plain
  // class), and the two flags are trust signals: an unverified identity or an
  // inferred edge must not read as proven just because the caller stayed on the
  // default level. None of them is a detail-level upgrade.
  return {
    id: el.id,
    name: el.name,
    type: el.type,
    filePath: el.filePath,
    startLine: el.startLine,
    // Only a genuine multi-kind collapse carries information here; a
    // single-element `kinds` says exactly what `type` already says.
    ...(el.kinds && el.kinds.length > 1 && { kinds: el.kinds }),
    ...(el.repo && { repo: el.repo }),
    ...(el.ambiguous && { ambiguous: true }),
    ...(el.provenanceInferred && { provenanceInferred: true as const }),
    ...(options?.preserveSummary && el.summary ? { summary: el.summary } : {}),
  };
}

/**
 * Filter array of functions based on detail level
 */
export function filterFunctionArray(
  functions: FunctionInfo[],
  config: DetailLevelConfig,
): (FunctionBasic | FunctionInfo)[] {
  return functions.map((fn) => filterFunctionInfo(fn, config));
}

/**
 * Filter array of callers based on detail level
 */
export function filterCallerArray(callers: CallerInfo[], config: DetailLevelConfig): (CallerBasic | CallerInfo)[] {
  return callers.map((caller) => filterCallerInfo(caller, config));
}

/**
 * Filter array of entrypoints based on detail level
 */
export function filterEntrypointArray(
  entrypoints: EntrypointInfo[],
  config: DetailLevelConfig,
): (EntrypointBasic | EntrypointInfo)[] {
  return entrypoints.map((ep) => filterEntrypointInfo(ep, config));
}

/**
 * Filter array of code elements based on detail level
 */
export function filterCodeElementArray(
  elements: CodeElementInfo[],
  config: DetailLevelConfig,
  options?: CodeElementFilterOptions,
): (CodeElementBasic | CodeElementInfo)[] {
  return elements.map((el) => filterCodeElementInfo(el, config, options));
}
