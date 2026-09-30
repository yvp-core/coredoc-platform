/**
 * Response Formatter Module
 *
 * Formats MCP tool responses in either 'summary' (AI-friendly prose)
 * or 'raw' (structured JSON) format. Always includes staleness warnings.
 */

import type { IGraphReadRepository } from '@coredoc/db';
import type { EnumMember } from '@coredoc/core/types';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { CALL_RESOLUTION_TEXT, DB_OP_RESOLUTION_TEXT, ResolutionRecordState, classifyResolution } from '@coredoc/core';
import { enumBaseId, enumValuesSuffix } from './entity-enums.js';
import type {
  ScopeContext,
  StalenessInfo,
  McpResponse,
  McpResponseMetadata,
  OutputFormat,
  DetailLevel,
  DetailLevelConfig,
  ChangeImpactResult,
  FunctionExplanationResult,
  EntrypointExplanationResult,
  RepoOverviewResult,
  CallerInfo,
  FunctionInfo,
  EntrypointInfo,
  EntityInfo,
  CodeElementInfo,
  ServiceDependencyResult,
  SemanticSearchResult,
  EntityConsumerInfo,
  DbSchemaEntity,
  ExplainResult,
  ExplainCandidate,
  ExplainMetadata,
  AmbiguityInfo,
} from './types.js';
import { displayEntrypointAddress } from './entrypoint-address.js';
import { ZERO_RESULTS_MARKER, zeroResultsLine } from './empty-results.js';
import {
  formatPercent,
  DYNAMIC_DISPATCH_CAVEAT,
  NO_LOW_COVERAGE_FLAGS,
  STRUCTURALLY_BLIND_HEADING,
  structurallyBlindGuidanceLines,
  type RepoCoverageStats,
} from './coverage.js';
import { getDefaultDetailLevel, resolveDetailLevel, detailEscalationFooter } from './detail-level.js';
import { shouldRenderFullBanner } from './staleness-dedupe.js';

// =============================================================================
// Staleness Information
// =============================================================================

/**
 * Default staleness warning message
 */
const STALENESS_WARNING = 'Data reflects indexed snapshots, not live code' as const;

/** Keep raw JSON unchanged while carrying evidence limits through both MCP transports. */
export function formatMcpContent(
  response: { data: unknown; metadata?: Pick<McpResponseMetadata, 'staleness' | 'warnings'> },
  jsonIndent?: number,
): Array<{ type: 'text'; text: string }> {
  const content: Array<{ type: 'text'; text: string }> = [
    {
      type: 'text',
      text: typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, jsonIndent),
    },
  ];
  if (typeof response.data !== 'string' && response.metadata) {
    const { staleness, warnings } = response.metadata;
    content.push({ type: 'text', text: `Evidence metadata: ${JSON.stringify({ staleness, warnings })}` });
  }
  return content;
}

/**
 * Get staleness info from repository
 *
 * @param scope - Scope context with repo hashes
 * @returns Staleness info
 */
export async function getStalenessInfo(scope: ScopeContext, repository?: IGraphReadRepository): Promise<StalenessInfo> {
  if (scope.repoHashes.length === 0) {
    return {
      warning: STALENESS_WARNING,
      parsedAt: 'unknown',
    };
  }

  // No scoped repository (e.g. the graph-optional tools): report unknown rather
  // than falling back to the process-default database.
  if (!repository) {
    return {
      warning: STALENESS_WARNING,
      parsedAt: 'unknown',
    };
  }

  try {
    const repoOverviews = await repository.getRepoOverview(scope.repoHashes);

    const repositories = repoOverviews
      .map((overview) => ({
        name: overview.name,
        parsedAt: overview.parsedAt || 'unknown',
        ...(overview.gitCommitHash ? { parsedCommit: overview.gitCommitHash } : {}),
        ...(overview.parserVersion ? { parserVersion: overview.parserVersion } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A newest-repo timestamp made older slices look fresh. Only a single-repo
    // answer can claim one parse point; preserve each slice in multi-repo output.
    const single = scope.repoHashes.length === 1 && repositories.length === 1 ? repositories[0] : undefined;
    return {
      warning: STALENESS_WARNING,
      parsedAt: single?.parsedAt ?? 'unknown',
      ...(single?.parsedCommit ? { parsedCommit: single.parsedCommit } : {}),
      ...(repositories.length ? { repositories } : {}),
    };
  } catch {
    return {
      warning: STALENESS_WARNING,
      parsedAt: 'unknown',
    };
  }
}

/**
 * Create response metadata
 *
 * @param scope - Scope context
 * @param format - Output format
 * @param detailLevel - Detail level (defaults to 'full' for backward compatibility)
 * @param detailConfig - Detail level config (resolved from detailLevel if not provided)
 */
export async function createMetadata(
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel?: DetailLevel,
  detailConfig?: DetailLevelConfig,
  repository?: IGraphReadRepository,
  ambiguity?: AmbiguityInfo,
): Promise<McpResponseMetadata> {
  const staleness = await getStalenessInfo(scope, repository);
  const resolvedLevel = detailLevel || getDefaultDetailLevel();
  const resolvedConfig = detailConfig || resolveDetailLevel(resolvedLevel);
  return {
    scope,
    staleness,
    format,
    detailLevel: resolvedLevel,
    detailConfig: resolvedConfig,
    ...(ambiguity ? { ambiguity } : {}),
  };
}

// =============================================================================
// Repo Annotation (multi-repo scope only)
// =============================================================================

/**
 * A function that maps a node id to its owning repo name, or undefined when
 * the id has no recognizable repo-hash prefix. Built per-response from the
 * scope; see buildRepoResolver.
 */
type RepoResolver = (id: string | undefined) => string | undefined;

/**
 * Extract the repo-hash prefix from a stable node id. Ids are
 * `{repoHash}:{type}:{path}:{name}` (see core/id-generator), so the hash is
 * the segment before the first colon. Returns undefined for empty / unprefixed
 * ids (e.g. the synthetic ids used for not-found placeholders).
 */
function repoHashFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const colon = id.indexOf(':');
  return colon > 0 ? id.slice(0, colon) : undefined;
}

/**
 * Build a hash→repo-name resolver for the current scope, or `null` when the
 * scope spans 0–1 repos. In single-repo scope every node belongs to the same
 * repo, so a per-node `repo` field is pure noise; multi-repo (project / cross-
 * repo) scope is exactly where agents conflate same-named symbols across repos,
 * so that's where we annotate. The map is built from the index-aligned
 * `repoHashes` / `resolvedRepos` pair the scope resolver produces.
 */
function buildRepoResolver(scope: ScopeContext): RepoResolver | null {
  if (scope.repoHashes.length <= 1) return null;
  const byHash = new Map<string, string>();
  scope.repoHashes.forEach((hash, i) => {
    const name = scope.resolvedRepos[i];
    if (hash && name) byHash.set(hash, name);
  });
  if (byHash.size === 0) return null;
  return (id) => {
    const hash = repoHashFromId(id);
    return hash ? byHash.get(hash) : undefined;
  };
}

/**
 * Resolve a single id to its owning repo name for the given scope, or
 * undefined in single-repo scope. Exposed for handlers that build their own
 * result shapes (e.g. explain candidates) and can't route through a shared
 * formatter.
 */
export function resolveRepoName(scope: ScopeContext, id: string | undefined): string | undefined {
  const resolve = buildRepoResolver(scope);
  return resolve ? resolve(id) : undefined;
}

/** Shallow-copy `item` with `repo` set when the resolver yields a name. */
function tagRepo<T extends { id?: string; repo?: string }>(item: T, resolve: RepoResolver | null): T {
  if (!resolve) return item;
  const repo = resolve(item.id);
  return repo ? { ...item, repo } : item;
}

/** tagRepo across an array (returns the same array when no resolver). */
function tagRepoArray<T extends { id?: string; repo?: string }>(items: T[], resolve: RepoResolver | null): T[] {
  return resolve ? items.map((it) => tagRepo(it, resolve)) : items;
}

/**
 * Summary-mode inline tag, e.g. ` [repo: users-api]`, appended to a list line
 * so agents can tell which repo each row belongs to. Empty string in single-
 * repo scope or when the id has no repo prefix.
 */
function repoTag(id: string | undefined, resolve: RepoResolver | null): string {
  if (!resolve) return '';
  const repo = resolve(id);
  return repo ? ` [repo: ${repo}]` : '';
}

// =============================================================================
// Summary Formatters
// =============================================================================

/**
 * Render the compact repeat-mention form of the staleness banner: one line
 * per repo, no warning sentence. `commit unknown` drops the `@<hash>`
 * segment entirely rather than rendering a placeholder.
 */
function formatCompactStalenessBanner(repositories: NonNullable<StalenessInfo['repositories']>): string {
  const lines = repositories.map((repo) => {
    const commit = repo.parsedCommit ? `@${repo.parsedCommit.slice(0, 7)}` : '';
    let date = repo.parsedAt;
    if (repo.parsedAt !== 'unknown') {
      const parsed = new Date(repo.parsedAt);
      // Malformed parsedAt must not throw and fail the whole tool response —
      // fall back to the raw string.
      date = Number.isNaN(parsed.getTime()) ? repo.parsedAt : parsed.toISOString().slice(0, 10);
    }
    return `> snapshot ${repo.name}${commit} · ${date}`;
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Format staleness header for summary output. Exported for tools that build
 * their summary text outside this module, so the
 * banner stays byte-identical everywhere.
 *
 * `sessionKey` (when provided) drives session-scoped dedupe
 * (staleness-dedupe.ts): a repeat mention of the same repo(s) at unchanged
 * parse state renders the compact one-line form instead of the full banner.
 * Undefined `sessionKey`, or a staleness shape with no named repositories
 * (nothing to key dedupe on), always renders full.
 */
export function formatStalenessHeader(staleness: StalenessInfo, sessionKey?: string): string {
  if (staleness.repositories?.length) {
    const full = shouldRenderFullBanner(
      sessionKey,
      staleness.repositories.map((repo) => ({
        name: repo.name,
        parsedAt: repo.parsedAt,
        parsedCommit: repo.parsedCommit,
      })),
    );
    if (!full) {
      return formatCompactStalenessBanner(staleness.repositories);
    }
    const lines = staleness.repositories.map(
      (repo) =>
        `> ${repo.name} — Last parsed: ${repo.parsedAt}` +
        (repo.parsedCommit ? `; Parsed at commit: ${repo.parsedCommit}` : '; commit unknown') +
        (repo.parserVersion ? `; parser: ${repo.parserVersion}` : ''),
    );
    return `> ${staleness.warning}\n${lines.join('\n')}\n`;
  }
  const date = staleness.parsedAt !== 'unknown' ? new Date(staleness.parsedAt).toISOString() : 'unknown';
  const branch = staleness.parsedBranch ? ` (${staleness.parsedBranch})` : '';
  // The commit rides the SUMMARY header too, not only the raw metadata. It is
  // the only field here a consumer can ask a binary question of — "does this
  // graph see my base?" — and a timestamp cannot answer it, so a field reachable
  // only through `format: "raw"` is a field the default caller never sees.
  // Absent stays absent: no line at all rather than an empty one.
  const commit = staleness.parsedCommit ? `\n> Parsed at commit: ${staleness.parsedCommit}` : '';
  return `> ${staleness.warning}\n> Last parsed: ${date}${branch}${commit}\n`;
}

/**
 * Header banners for summary output: the staleness warning plus, when the tool
 * resolved an ambiguous name, a "N more matches" banner. Centralized so every
 * tool that threads `metadata` surfaces the ambiguity hint identically.
 */
/**
 * Push the basic-detail escalation footer onto a summary body (no-op at
 * `full`). Called last by every list-shaped formatter, so the hint is the final
 * line the agent reads.
 */
function pushDetailFooter(lines: string[], metadata: McpResponseMetadata): void {
  const footer = detailEscalationFooter(metadata.detailLevel);
  if (footer) {
    lines.push('');
    lines.push(footer);
  }
}

function formatHeaderBanners(metadata: McpResponseMetadata): string {
  const warnings = (metadata.warnings ?? []).map((warning) => `> ${warning}\n`).join('');
  const staleness = formatStalenessHeader(metadata.staleness, metadata.scope?.sessionKey);
  const ambiguity = metadata.ambiguity ? `> ⚠ ${metadata.ambiguity.hint}\n` : '';
  return `${warnings}${staleness}${ambiguity}`;
}

/**
 * Trim long single-line strings (e.g. AI-generated package descriptions)
 * so a single row doesn't dominate a multi-line list.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Format location string
 */
function formatLocation(filePath: string, startLine: number, endLine?: number): string {
  const lineRange = endLine && endLine !== startLine ? `${startLine}-${endLine}` : String(startLine);
  return `${filePath}:${lineRange}`;
}

/**
 * Wrap source in a Markdown code fence that survives backticks in the content.
 * A fixed ``` fence breaks when the source itself contains a ``` run — common in
 * docstrings, nested fences, or string literals — closing the block early so the
 * remainder leaks out as prose (and, for agent consumers, as injectable text).
 * Per CommonMark the fence must be longer than any backtick run it encloses, so
 * use longest-run + 1 (minimum 3). Returns the fence lines to push.
 */
function fenceSource(source: string): string[] {
  const longestRun = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [fence, source, fence];
}

/**
 * Caveat marker for a row reached over an INFERRED relationship (a call edge the
 * engine bound by a sole-implementation or name-collision heuristic at
 * confidence 0.5, not by a resolved symbol).
 *
 * Rendered from the structured `provenanceInferred` flag and ONLY in the text
 * formatters — `raw` stays a machine shape carrying the flag itself, and the
 * name/id never gain display text (an agent must be able to feed `name` straight
 * back into `explain`).
 */
const PROVENANCE_INFERRED_TAG = ' ⚠ inferred call (heuristic, not resolved)';

/**
 * Marker for a node the substrate SYNTHESIZED from a declaration convention (a Ruby
 * `has_many` mints a reader method Ruby never spells as a `def`). Without it an agent reads
 * the declaration line as a function body and reasons about code that does not exist. Text
 * only — `raw` keeps the structured `synthesized` field, and the name stays clean so it can be
 * fed straight back into `explain`.
 */
function synthesizedTag(fn: Pick<FunctionInfo, 'synthesized'>): string {
  return fn.synthesized ? ` (synthesized: ${fn.synthesized} — no body)` : '';
}

/**
 * Format function info for summary
 */
function formatFunctionSummary(
  fn: FunctionInfo,
  options?: { includeLocation?: boolean; resolve?: RepoResolver | null },
): string {
  const { includeLocation = true, resolve = null } = options || {};
  const parts: string[] = [];

  // Function name with class context
  if (fn.className) {
    parts.push(`\`${fn.className}.${fn.name}\``);
  } else {
    parts.push(`\`${fn.name}\``);
  }

  // Modifiers
  const modifiers: string[] = [];
  if (fn.isAsync) modifiers.push('async');
  if (fn.visibility && fn.visibility !== 'public') modifiers.push(fn.visibility);
  if (modifiers.length > 0) {
    parts.push(`(${modifiers.join(', ')})`);
  }

  // Location
  if (includeLocation) {
    parts.push(`- ${formatLocation(fn.filePath, fn.startLine, fn.endLine)}`);
  }

  // Owning repo (multi-repo scope only)
  const tag = repoTag(fn.id, resolve);
  if (tag) parts.push(tag.trimStart());

  // Inferred-edge caveat (find_callers / analyze_change_impact rows)
  if (fn.provenanceInferred) parts.push(PROVENANCE_INFERRED_TAG.trimStart());

  // Convention-minted node caveat (Ruby association readers and the like)
  const synthesized = synthesizedTag(fn);
  if (synthesized) parts.push(synthesized.trimStart());

  // Summary
  if (fn.summary) {
    parts.push(`\n   ${fn.summary}`);
  }

  return parts.join(' ');
}

/**
 * Format entrypoint info for summary
 */
function formatEntrypointSummary(ep: EntrypointInfo, resolve: RepoResolver | null = null): string {
  const parts: string[] = [];
  const address = displayEntrypointAddress(ep);

  // Type-specific display
  switch (ep.type) {
    case 'http':
      parts.push(`**${ep.method || 'HTTP'}** \`${address || '/'}\``);
      break;
    case 'graphql':
      parts.push(`**GraphQL ${ep.operationType || 'query'}** \`${address}\``);
      break;
    case 'queue':
      parts.push(`**Queue${ep.system ? ` (${ep.system})` : ''}** \`${address || ep.handlerName}\``);
      break;
    case 'cron':
      parts.push(`**Cron** \`${address}\``);
      break;
    case 'cli':
      parts.push(`**CLI** \`${address || ep.handlerName}\``);
      break;
    case 'event':
      parts.push(`**Event${ep.system ? ` (${ep.system})` : ''}** \`${address || ep.handlerName}\``);
      break;
    case 'websocket':
      parts.push(`**WebSocket** \`${address || ep.handlerName}\``);
      break;
    case 'mobile':
      // The trigger is the taxonomy that makes a launcher distinguishable from
      // a push handler in a flat list; the class name is the address.
      parts.push(`**Mobile${ep.trigger ? ` (${ep.trigger})` : ''}** \`${address || ep.handlerName}\``);
      break;
    default:
      // Unknown types still carry an address — render it the way the queue arm
      // does rather than dropping it.
      parts.push(address ? `**${ep.type}** \`${address}\`` : `**${ep.type}**`);
  }

  parts.push(`-> \`${ep.handlerName}\``);
  parts.push(`(${formatLocation(ep.filePath, ep.startLine)})`);

  const tag = repoTag(ep.id, resolve);
  if (tag) parts.push(tag.trimStart());

  if (ep.summary) {
    parts.push(`\n   ${ep.summary}`);
  }

  return parts.join(' ');
}

/**
 * Format caller info with distance
 */
function formatCallerSummary(caller: CallerInfo, resolve: RepoResolver | null = null): string {
  const distanceLabel = caller.distance === 1 ? 'direct' : `${caller.distance} hops`;
  return `${formatFunctionSummary(caller, { includeLocation: true, resolve })} [${distanceLabel}]`;
}

// =============================================================================
// Change Impact Formatter
// =============================================================================

/**
 * Format change impact result
 */
export function formatChangeImpact(
  result: ChangeImpactResult,
  metadata: McpResponseMetadata,
): McpResponse<ChangeImpactResult | string> {
  const resolve = buildRepoResolver(metadata.scope);

  if (metadata.format === 'raw') {
    // Annotate every node with its owning repo (multi-repo scope only) so
    // agents can attribute callers / type users / entrypoints to the right
    // repo instead of guessing.
    const enriched: ChangeImpactResult = resolve
      ? {
          ...result,
          target: tagRepo(result.target, resolve),
          directCallers: tagRepoArray(result.directCallers, resolve),
          transitiveCallers: tagRepoArray(result.transitiveCallers, resolve),
          typeUsers: result.typeUsers ? tagRepoArray(result.typeUsers, resolve) : result.typeUsers,
          affectedEntrypoints: tagRepoArray(result.affectedEntrypoints, resolve),
          affectedTests: tagRepoArray(result.affectedTests, resolve),
        }
      : result;
    return { data: enriched, metadata };
  }

  const lines: string[] = [];

  // Staleness warning
  lines.push(formatHeaderBanners(metadata));

  // Header
  lines.push(`## Impact Analysis: \`${result.target.name}\`\n`);

  // Risk badge
  const riskEmoji = {
    low: '',
    medium: '',
    high: '',
  }[result.riskLevel];
  lines.push(`**Risk Level:** ${riskEmoji} ${result.riskLevel.toUpperCase()}\n`);

  // Impact summary
  lines.push(`${result.impactSummary}\n`);

  // Direct callers
  if (result.directCallers.length > 0) {
    lines.push(`### Direct Callers (${result.directCallers.length})\n`);
    for (const caller of result.directCallers.slice(0, 10)) {
      lines.push(`- ${formatCallerSummary(caller, resolve)}`);
    }
    if (result.directCallers.length > 10) {
      lines.push(`- ... and ${result.directCallers.length - 10} more`);
    }
    lines.push('');
  }

  // Transitive callers
  if (result.transitiveCallers.length > 0) {
    lines.push(`### Transitive Callers (${result.transitiveCallers.length})\n`);
    for (const caller of result.transitiveCallers.slice(0, 10)) {
      lines.push(`- ${formatCallerSummary(caller, resolve)}`);
    }
    if (result.transitiveCallers.length > 10) {
      lines.push(`- ... and ${result.transitiveCallers.length - 10} more`);
    }
    lines.push('');
  }

  // Type users (USES_TYPE consumers; classes/interfaces/type aliases that
  // reference the target as a type — distinct from CALLS-based callers).
  if (result.typeUsers && result.typeUsers.length > 0) {
    lines.push(`### Type Users (${result.typeUsers.length})\n`);
    for (const user of result.typeUsers.slice(0, 10)) {
      const where = user.endLine
        ? `${user.filePath}:${user.startLine}-${user.endLine}`
        : `${user.filePath}:${user.startLine}`;
      const note = user.summary ? ` — ${user.summary}` : '';
      lines.push(`- \`${user.name}\` [${user.type}] (${where})${repoTag(user.id, resolve)}${note}`);
    }
    if (result.typeUsers.length > 10) {
      lines.push(`- ... and ${result.typeUsers.length - 10} more`);
    }
    lines.push('');
  }

  // Affected entrypoints
  if (result.affectedEntrypoints.length > 0) {
    lines.push(`### Affected Entrypoints (${result.affectedEntrypoints.length})\n`);
    for (const ep of result.affectedEntrypoints) {
      lines.push(`- ${formatEntrypointSummary(ep, resolve)}`);
    }
    lines.push('');
  }

  // Affected tests
  if (result.affectedTests.length > 0) {
    lines.push(`### Affected Tests (${result.affectedTests.length})\n`);
    for (const test of result.affectedTests.slice(0, 5)) {
      lines.push(`- \`${test.name}\` (${test.filePath})${repoTag(test.id, resolve)}`);
    }
    if (result.affectedTests.length > 5) {
      lines.push(`- ... and ${result.affectedTests.length - 5} more`);
    }
    lines.push('');
  } else {
    // Always rendered. An omitted section reads as "no test covers this", but
    // extraction profiles routinely exclude test sources, so a zero here is
    // just as often "tests are not in the graph".
    lines.push(`### Affected Tests (0)\n`);
    lines.push(
      `${ZERO_RESULTS_MARKER} — no test-file dependent in the graph. Extraction profiles often exclude test sources, ` +
        `so verify with grep before concluding nothing covers this.\n`,
    );
  }

  // Cross-repo impacts
  if (result.crossRepoImpacts && result.crossRepoImpacts.length > 0) {
    lines.push(`### Cross-Repo Impact\n`);
    for (const impact of result.crossRepoImpacts) {
      lines.push(
        `**${impact.repo}** (${impact.consumers.length} consumer${impact.consumers.length !== 1 ? 's' : ''}):`,
      );
      for (const consumer of impact.consumers.slice(0, 3)) {
        lines.push(`  - ${formatFunctionSummary(consumer, { resolve })}`);
      }
      if (impact.consumers.length > 3) {
        lines.push(`  - ... and ${impact.consumers.length - 3} more`);
      }
    }
  }

  pushDetailFooter(lines, metadata);
  return { data: lines.join('\n'), metadata };
}

// =============================================================================
// Function Explanation Formatter
// =============================================================================

/**
 * Format function explanation result
 */
export function formatFunctionExplanation(
  result: FunctionExplanationResult,
  metadata: McpResponseMetadata,
): McpResponse<FunctionExplanationResult | string> {
  const resolve = buildRepoResolver(metadata.scope);

  if (metadata.format === 'raw') {
    const enriched: FunctionExplanationResult = resolve
      ? {
          ...result,
          function: tagRepo(result.function, resolve),
          callees: result.callees ? tagRepoArray(result.callees, resolve) : result.callees,
          callers: result.callers ? tagRepoArray(result.callers, resolve) : result.callers,
        }
      : result;
    return { data: enriched, metadata };
  }

  const lines: string[] = [];
  const fn = result.function;

  // Staleness warning
  lines.push(formatHeaderBanners(metadata));

  // Header
  const fullName = fn.className ? `${fn.className}.${fn.name}` : fn.name;
  lines.push(`## Function: \`${fullName}\``);
  const fnRepo = resolve ? resolve(fn.id) : undefined;
  lines.push(
    `${formatLocation(fn.filePath, fn.startLine, fn.endLine)}${fnRepo ? ` [repo: ${fnRepo}]` : ''}${synthesizedTag(fn)}\n`,
  );

  // Summary / Intent
  if (fn.purpose) {
    lines.push(`### Purpose`);
    lines.push(`${fn.purpose}\n`);
  } else if (fn.summary) {
    lines.push(`### Summary`);
    lines.push(`${fn.summary}\n`);
  }

  // Business logic
  if (result.businessLogic) {
    lines.push(`### Business Logic`);
    lines.push(`${result.businessLogic}\n`);
  }

  // Side effects
  if (result.sideEffects) {
    lines.push(`### Side Effects`);
    lines.push(`${result.sideEffects}\n`);
  }

  // Source (present only when includeSource was requested AND the operator
  // enabled ALLOW_SOURCES_IN_GRAPH). Reflects the parsed snapshot/branch.
  if (fn.sourceCode) {
    lines.push(`### Source`);
    lines.push(...fenceSource(fn.sourceCode), '');
  }

  // DB operations
  if (result.dbOperations && result.dbOperations.length > 0) {
    lines.push(`### Database Operations`);
    for (const op of result.dbOperations) {
      lines.push(`- **${op.operation.toUpperCase()}** \`${op.entity}\``);
    }
    lines.push('');
  }

  // External calls
  if (result.externalCalls && result.externalCalls.length > 0) {
    lines.push(`### External Calls`);
    for (const call of result.externalCalls) {
      lines.push(`- **${call.service}** \`${call.pattern}\``);
    }
    lines.push('');
  }

  // Callees (what this function calls)
  if (result.callees && result.callees.length > 0) {
    lines.push(`### Calls (${result.callees.length})`);
    for (const callee of result.callees.slice(0, 10)) {
      lines.push(`- ${formatFunctionSummary(callee, { resolve })}`);
    }
    if (result.callees.length > 10) {
      lines.push(`- ... and ${result.callees.length - 10} more`);
    }
    lines.push('');
  }

  // Callers (who calls this)
  if (result.callers && result.callers.length > 0) {
    lines.push(`### Called By (${result.callers.length})`);
    for (const caller of result.callers.slice(0, 5)) {
      lines.push(`- ${formatCallerSummary(caller, resolve)}`);
    }
    if (result.callers.length > 5) {
      lines.push(`- ... and ${result.callers.length - 5} more`);
    }
  }

  return { data: lines.join('\n'), metadata };
}

// =============================================================================
// Entrypoint Explanation Formatter
// =============================================================================

/**
 * Format entrypoint explanation result
 */
export function formatEntrypointExplanation(
  result: EntrypointExplanationResult,
  metadata: McpResponseMetadata,
): McpResponse<EntrypointExplanationResult | string> {
  const resolve = buildRepoResolver(metadata.scope);

  if (metadata.format === 'raw') {
    const enriched: EntrypointExplanationResult = resolve
      ? {
          ...result,
          entrypoint: tagRepo(result.entrypoint, resolve),
          handler: { ...result.handler, function: tagRepo(result.handler.function, resolve) },
          callTree: tagRepoArray(result.callTree, resolve),
          entities: tagRepoArray(result.entities, resolve),
        }
      : result;
    return { data: enriched, metadata };
  }

  const lines: string[] = [];
  const ep = result.entrypoint;

  // Staleness warning
  lines.push(formatHeaderBanners(metadata));

  // Header based on type
  const epRepo = resolve ? resolve(ep.id) : undefined;
  const epRepoTag = epRepo ? ` [repo: ${epRepo}]` : '';
  if (ep.type === 'http') {
    lines.push(`## Endpoint: ${ep.method || 'HTTP'} \`${ep.fullPath || ep.path}\`${epRepoTag}\n`);
  } else if (ep.type === 'graphql') {
    lines.push(`## GraphQL ${ep.operationType}: \`${ep.fieldName}\`${epRepoTag}\n`);
  } else {
    // Human title for every remaining type (queue/event/cron/cli/…).
    // The last resort is the file location, never the node id. A statically
    // unresolvable dimension (UNRESOLVED_PREFIX sentinel) renders as such —
    // never as a literal topic/path/command value (dynamic-boundaries UC-3).
    const address = displayEntrypointAddress(ep) || ep.handlerName || formatLocation(ep.filePath, ep.startLine);
    const system = ep.system ? ` (${ep.system})` : '';
    lines.push(`## ${ep.type}${system}: \`${address}\`${epRepoTag}\n`);
  }

  // Handler info
  lines.push(`### Handler`);
  lines.push(`${formatFunctionSummary(result.handler.function, { resolve })}\n`);

  if (result.handler.function.purpose) {
    lines.push(`**Purpose:** ${result.handler.function.purpose}\n`);
  }

  // Business logic from handler
  if (result.handler.businessLogic) {
    lines.push(`### Business Logic`);
    lines.push(`${result.handler.businessLogic}\n`);
  }

  // Handler source — present only when the caller passed includeSource AND the
  // operator enabled ALLOW_SOURCES_IN_GRAPH (see explain-entrypoint.ts). The
  // structural view alone hides the line-level semantics an endpoint change
  // turns on (guards, predicates, field mappings).
  if (result.handler.function.sourceCode) {
    lines.push(`### Handler Source`);
    lines.push(...fenceSource(result.handler.function.sourceCode), '');
  }

  // Compact "what it touches" block — DB entities + outbound services. Rendered
  // BEFORE the (truncatable) call tree so it's never cut off by the "... and N
  // more" elision; this is the highest-value summary for planning a change.
  if (result.entities.length > 0 || result.externalServices.length > 0) {
    lines.push(`### Touches`);
    if (result.entities.length > 0) {
      const names = result.entities.map((e) => `\`${e.name}\`${e.tableName ? ` (${e.tableName})` : ''}`).join(', ');
      lines.push(`- **DB entities (${result.entities.length}):** ${names}`);
    }
    if (result.externalServices.length > 0) {
      lines.push(`- **Outbound services (${result.externalServices.length}):** ${result.externalServices.join(', ')}`);
    }
    lines.push('');
  }

  // Call tree. Rendered through the same formatFunctionSummary the callee list
  // uses, so every row carries `file:line` — an agent that wants a callee's
  // body is one Read (or one `explain(path:line)`) away, with no extra lookup.
  if (result.callTree.length > 0) {
    lines.push(`### Call Tree (${result.callTree.length} functions)`);
    for (const fn of result.callTree.slice(0, 15)) {
      lines.push(`- ${formatFunctionSummary(fn, { resolve })}`);
    }
    if (result.callTree.length > 15) {
      lines.push(`- ... and ${result.callTree.length - 15} more`);
    }
    lines.push('');
  }

  // Upstream callers
  if (result.upstreamCallers && result.upstreamCallers.length > 0) {
    lines.push(`### Called By (Cross-Repo)`);
    for (const caller of result.upstreamCallers) {
      lines.push(`- **${caller.repo}** (${caller.callSites} call site${caller.callSites !== 1 ? 's' : ''})`);
    }
  }

  const deeper = entrypointDeeperFooter(result);
  if (deeper) {
    lines.push('', `> Deeper: ${deeper}`);
  }

  return { data: lines.join('\n'), metadata };
}

/**
 * The one-line "Deeper:" hop for an entrypoint deep-dive: the handler's BODY.
 *
 * The deep-dive answers structure (handler, call tree, entities touched) but not
 * the line-level semantics a change usually turns on — the guard that gates the
 * handler, the predicate that filters the batch, the validation/DLQ boundary,
 * the field mapping. Measured on the MCP eval lane: agents that pulled source on
 * a function answered correctly, and the entrypoint lane — which never named a
 * source hop — answered structure-only. So name the exact next call.
 *
 * When the operator enabled ALLOW_SOURCES_IN_GRAPH the hop is an `explain` with
 * `includeSource: true` (the body comes back in-graph, no file read); otherwise
 * the graph has no bodies to give, so point at the file on disk instead.
 *
 * Returns '' when the handler didn't resolve (no name/location to point at).
 */
function entrypointDeeperFooter(result: EntrypointExplanationResult): string {
  const fn = result.handler.function;
  // Already inlined above — don't tell the agent to re-fetch what it just got.
  if (fn.sourceCode) return '';
  const name = fn.className ? `${fn.className}.${fn.name}` : fn.name;
  if (!name || name === 'unknown') return '';
  const WHY = 'handler body: guards, predicates, field mappings';
  if (allowSourcesInGraph()) {
    return `explain({target: "${name}", includeSource: true}) — ${WHY}`;
  }
  if (!fn.filePath) return '';
  return `Read \`${formatLocation(fn.filePath, fn.startLine, fn.endLine)}\` — ${WHY}`;
}

// =============================================================================
// Repository Overview Formatter
// =============================================================================

/**
 * Format repository overview result
 */
export function formatRepoOverview(
  result: RepoOverviewResult,
  metadata: McpResponseMetadata,
): McpResponse<RepoOverviewResult | string> {
  if (metadata.format === 'raw') {
    return { data: result, metadata };
  }

  const lines: string[] = [];
  const isProjectView = result.type === 'project' && result.repos && result.repos.length > 0;

  if (isProjectView && result.repos) {
    // Project view: a softer staleness line (no single "last parsed" since
    // each repo carries its own), and a clean "## Project: name" header
    // without the "Repository:" prefix or the misleading project-level
    // Type/Parsed metadata.
    lines.push(`> ${metadata.staleness.warning}\n`);
    lines.push(`## Project: ${result.name}\n`);
    const parsedCount = result.repos.filter((r) => r.parsed).length;
    const total = result.repos.length;
    lines.push(
      parsedCount === total
        ? `**${total} repositories**\n`
        : `**${parsedCount} of ${total} repositories parsed** — unparsed repos appear in the table below.\n`,
    );
  } else {
    // Single-repo / discovery view: keep the original header shape.
    lines.push(formatHeaderBanners(metadata));
    lines.push(`## Repository: ${result.name}\n`);
    if (result.type && result.type !== 'unknown') {
      lines.push(`**Type:** ${result.type}`);
    }
    if (result.gitRemoteUrl) {
      lines.push(`**Git:** ${result.gitRemoteUrl}`);
    }
    lines.push(`**Parsed:** ${result.parsedAt}\n`);
  }

  // AI-generated summary
  if (result.summary) {
    lines.push(`### Summary`);
    lines.push(`${result.summary}\n`);
  }
  if (result.dataModel) {
    lines.push(`### Data Model`);
    lines.push(`${result.dataModel}\n`);
  }
  if (result.externalIntegrations && result.externalIntegrations.length > 0) {
    lines.push(`### External Integrations`);
    lines.push(result.externalIntegrations.map((i) => `- ${i}`).join('\n'));
    lines.push('');
  }

  // Statistics — single-repo only. Project views render per-repo rows
  // instead; aggregated sums across heterogeneous repos hide more than
  // they reveal.
  if (!isProjectView) {
    const s = result.stats;
    // A file count of 0 alongside real functions is impossible (functions live in
    // files) — it means this language's parser doesn't report file/structure
    // counts (e.g. Ruby), not that the repo is empty. Render those as `n/a`
    // rather than a misleading `0`. A genuinely class-free codebase still reports
    // its file count, so a 0 class count is only masked when files are unreported.
    const filesUnreported = s.files === 0 && s.functions > 0;
    const fmtFiles = filesUnreported ? 'n/a' : String(s.files);
    const fmtClasses = s.classes === 0 && filesUnreported ? 'n/a' : String(s.classes);
    lines.push(`### Statistics`);
    lines.push(`| Metric | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Files | ${fmtFiles} |`);
    lines.push(`| Functions | ${s.functions} |`);
    lines.push(`| Classes | ${fmtClasses} |`);
    lines.push(`| Entrypoints | ${s.entrypoints} |`);
    lines.push(`| Entities | ${s.entities} |`);
    if (filesUnreported) {
      lines.push(`\n> \`n/a\` = not reported by this language's parser (the count is unavailable, not zero).`);
    }
    lines.push('');
  }

  // Coverage manifest — single parsed repo only. Makes the index's blind spots
  // explicit so an agent treats a miss as "not indexed, go grep a checkout"
  // rather than "doesn't exist". Static and honest; mirrors what the substrate
  // actually extracts.
  if (!isProjectView && result.stats.functions > 0) {
    lines.push(`### Coverage`);
    lines.push(
      'Indexed: declared symbols (functions, classes, interfaces, enums, entities), entrypoints, and the call graph. ' +
        'NOT indexed: tests, database migrations, seed scripts, rake/CLI management tasks, config files, and raw string literals ' +
        '(URLs, topic names, union-member values) — use a local checkout + grep for those.',
    );
    lines.push('');
  }

  // Per-repo table for project views — the headline content here. The `Repo`
  // column shows the exact, copy-pasteable `scope` token (project-qualified
  // when the project id is known) so agents don't have to guess the qualifier
  // from the displayed project name.
  if (isProjectView && result.repos) {
    const projectId = metadata.scope.projectId;
    const scopeToken = (name: string) => (projectId ? `${projectId}/${name}` : name);
    lines.push(`### Repositories`);
    lines.push(`Pass the \`Repo\` value of one of these as \`scope\` to drill in.\n`);
    lines.push('| Repo | Type | Files | Functions | Classes | Entities | Entrypoints | Parsed |');
    lines.push('|------|------|------:|----------:|--------:|---------:|-------------|--------|');
    for (const r of result.repos) {
      if (!r.parsed) {
        lines.push(`| ${scopeToken(r.name)} | _unparsed_ | — | — | — | — | — | not yet |`);
        continue;
      }
      const eps = r.entrypointTypes.length > 0 ? r.entrypointTypes.join(', ') : '—';
      lines.push(
        `| ${scopeToken(r.name)} | ${r.type || 'unknown'} | ${r.fileCount} | ${r.functionCount} | ${r.classCount} | ${r.entityCount} | ${eps} | ${r.parsedAt || '—'} |`,
      );
    }
    lines.push('');

    // Monorepo packages — only for repos that actually contain >1 package.
    // Keeps the abstraction level honest: the top-level table is repos,
    // this section drills one level into the repos that bundle multiple
    // packages (typically the workspace/monorepo root).
    const monorepos = result.repos.filter((r) => r.parsed && r.packages && r.packages.length > 1);
    if (monorepos.length > 0) {
      lines.push(`### Monorepo packages`);
      for (const r of monorepos) {
        lines.push(`**${r.name}** (${r.packages!.length} packages):`);
        for (const p of r.packages!) {
          const typeLabel = p.type ? ` (${p.type})` : '';
          const desc = p.description ? ` — ${truncate(p.description, 140)}` : '';
          lines.push(`- \`${p.name}\`${typeLabel} at \`${p.path}\`${desc}`);
        }
        lines.push('');
      }
    }

    // Surface per-repo summaries (when present) below the table — keeps the
    // table scannable while still exposing repo intent.
    const withSummary = result.repos.filter((r) => r.parsed && r.summary);
    if (withSummary.length > 0) {
      lines.push(`### Repo summaries`);
      for (const r of withSummary) {
        lines.push(`- **${r.name}**: ${r.summary}`);
      }
      lines.push('');
    }
  }

  // Frameworks — single-repo only. At the project level a "uses Kafka"
  // tag is duplicate noise once the per-repo table already shows each
  // repo's entrypoint kinds.
  if (!isProjectView && result.frameworks.length > 0) {
    lines.push(`### Detected Frameworks`);
    lines.push(result.frameworks.map((f) => `- ${f}`).join('\n'));
    lines.push('');
  }

  // Packages — single-repo only. Project views skip this section because
  // the cross-repo `getPackages` dump mixes monorepo internals, service
  // subdirs, and repo roots at three different abstraction levels. The
  // monorepo packages section above gives the same info correctly scoped.
  if (!isProjectView && result.packages.length > 0) {
    lines.push(`### Packages`);
    lines.push('| Package | Path | Type | Description |');
    lines.push('|---------|------|------|-------------|');
    for (const p of result.packages.slice(0, 15)) {
      const name = typeof p === 'string' ? p : p.name;
      const path = typeof p === 'string' ? '' : p.path || '';
      const type = typeof p === 'string' ? '' : p.type || '';
      const desc = typeof p === 'string' ? '' : p.description || '';
      lines.push(`| ${name} | ${path} | ${type} | ${desc} |`);
    }
    if (result.packages.length > 15) {
      lines.push(`| ... | | | ${result.packages.length - 15} more packages |`);
    }
    lines.push('');
  }

  // Entrypoints by type — single-repo only. The project's per-repo table
  // already lists each repo's entrypoint kinds; a duplicate aggregate row
  // doesn't add signal.
  if (!isProjectView && Object.keys(result.entrypointsByType).length > 0) {
    lines.push(`### Entrypoints by Type`);
    for (const [type, count] of Object.entries(result.entrypointsByType)) {
      lines.push(`- **${type}:** ${count}`);
    }
    lines.push('');
  }

  // Available repos — single-repo only. The project view's per-repo table
  // already names every sibling, so this would duplicate.
  if (!isProjectView && result.availableRepos && result.availableRepos.length > 1) {
    lines.push(`### Available Repositories`);
    lines.push(result.availableRepos.map((r) => `- ${r}`).join('\n'));
    lines.push('');
  }

  // Discovery list (only present on no-scope responses). Header text is
  // already specialized via result.name ("Project repositories (N)" vs
  // "All parsed repositories (N)"), so we don't repeat it here.
  if (result.allKnownRepos && result.allKnownRepos.length > 0) {
    lines.push(`### Repositories (${result.allKnownRepos.length})`);
    // When project membership is known, the Repo cell shows the qualified
    // `project/repo` token so the agent can paste it straight back as `scope`
    // (and it round-trips even when the bare name collides across projects).
    const anyQualified = result.allKnownRepos.some((r) => r.scopeToken);
    lines.push(`Pass the \`Repo\` value of any of these as \`scope\` to narrow follow-up calls.`);
    lines.push('| Repo | Type | Parsed |');
    lines.push('|------|------|--------|');
    for (const r of result.allKnownRepos) {
      const repoCell = r.scopeToken ?? r.name;
      lines.push(`| ${repoCell} | ${r.type || 'unknown'} | ${r.parsedAt || '—'} |`);
    }
    lines.push('');
    if (anyQualified) {
      lines.push(
        `> Repo names are shown as \`project/repo\` — pass that exact value as \`scope\` (a bare name that exists in multiple projects is ambiguous).`,
      );
      lines.push('');
    }
  }

  return { data: lines.join('\n'), metadata };
}

// =============================================================================
// Simple List Formatters
// =============================================================================

/**
 * Format a list of code elements
 */
export function formatCodeElementList(
  elements: CodeElementInfo[],
  title: string,
  metadata: McpResponseMetadata,
  totalResults?: number,
  skip?: number,
): McpResponse<CodeElementInfo[] | string> {
  const resultCount = totalResults ?? elements.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    return { data: tagRepoArray(elements, resolve), metadata, resultCount };
  }

  const offset = skip ?? 0;
  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  // Suppress the "(showing 0 of 0)" suffix on empty results — it carries no
  // information and reads as noise next to a not-found / corrective-hint title
  // (which already explains the zero). Keep the count whenever there's anything
  // to count or paginate.
  const countSuffix =
    elements.length === 0 && resultCount === 0 && offset === 0
      ? ''
      : ` (showing ${elements.length} of ${resultCount}${offset > 0 ? `, skip: ${offset}` : ''})`;
  lines.push(`## ${title}${countSuffix}\n`);

  if (elements.length === 0) {
    lines.push(zeroResultsLine('nothing matched in this scope (the query/filter is in the heading above)'));
  }

  for (const el of elements.slice(0, 50)) {
    // Prefer the AI one-line `purpose` (concise — no truncation needed). Fall back
    // to a capped `summary` (the long detailed prose) with a trailing `…` ONLY when
    // truncated, so the cut reads as intentional rather than a mid-word corruption.
    const desc =
      el.purpose ??
      (el.summary ? (el.summary.length > 120 ? `${el.summary.slice(0, 120).trimEnd()}…` : el.summary) : undefined);
    // Multi-kind declarations (class+entity, function+component) collapse to one
    // row; show every collapsed kind so the dual nature stays visible.
    const kindLabel = el.kinds && el.kinds.length > 1 ? el.kinds.join('+') : el.type;
    // The unverified-identity caveat is rendered from the structured `ambiguous`
    // flag, NOT baked into `el.name` — the name stays clean for a follow-up query.
    const identityTag = el.ambiguous ? ' ⚠ unverified identity (name-matched)' : '';
    // Same discipline for the relationship's own provenance: an edge the engine
    // guessed (sole-implementation / name-collision tier, confidence 0.5) must
    // not read like a resolved one. Text only — `raw` keeps the structured flag.
    const provenanceTag = el.provenanceInferred ? PROVENANCE_INFERRED_TAG : '';
    lines.push(
      `- \`${el.name}\` (${kindLabel}) - ${formatLocation(el.filePath, el.startLine)}${repoTag(el.id, resolve)}${identityTag}${provenanceTag}${desc ? `\n   ${desc}` : ''}`,
    );
    // Source block — present only when includeSource was requested and the
    // operator enabled ALLOW_SOURCES_IN_GRAPH. Reflects the parsed snapshot.
    if (el.sourceCode) {
      lines.push(...fenceSource(el.sourceCode));
    }
  }
  if (elements.length > 50) {
    lines.push(`\n... and ${elements.length - 50} more in this page`);
  }

  pushDetailFooter(lines, metadata);
  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format a list of entrypoints
 */
export function formatEntrypointList(
  entrypoints: EntrypointInfo[],
  metadata: McpResponseMetadata,
  displayLimit: number = 20,
  displaySkip: number = 0,
): McpResponse<EntrypointInfo[] | string> {
  const resultCount = entrypoints.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    // Honor pagination in raw too. The summary path below slices per type; raw is
    // a flat array, so apply a flat skip/limit window. `resultCount` stays the full
    // total (for metrics). Previously raw returned every entrypoint, ignoring
    // limit/skip entirely.
    const paged = entrypoints.slice(displaySkip, displaySkip + displayLimit);
    return { data: tagRepoArray(paged, resolve), metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Entrypoints (${entrypoints.length} total)\n`);

  if (entrypoints.length === 0) {
    lines.push(zeroResultsLine('no entrypoint matched this type/filter in scope'));
  }

  // Group by type
  const byType = new Map<string, EntrypointInfo[]>();
  for (const ep of entrypoints) {
    const list = byType.get(ep.type) || [];
    list.push(ep);
    byType.set(ep.type, list);
  }

  for (const [type, eps] of byType) {
    const sliced = eps.slice(displaySkip, displaySkip + displayLimit);
    const showing = displaySkip > 0 || sliced.length < eps.length ? ` (showing ${sliced.length} of ${eps.length})` : '';
    lines.push(`### ${type.toUpperCase()} (${eps.length})${showing}`);
    for (const ep of sliced) {
      lines.push(`- ${formatEntrypointSummary(ep, resolve)}`);
    }
    const remaining = eps.length - displaySkip - sliced.length;
    if (remaining > 0) {
      lines.push(`- ... and ${remaining} more (use skip: ${displaySkip + displayLimit} to see next page)`);
    }
    lines.push('');
  }

  pushDetailFooter(lines, metadata);
  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format a list of callers
 */
export function formatCallerList(
  callers: CallerInfo[],
  functionName: string,
  metadata: McpResponseMetadata,
  reachingEntrypoints?: EntrypointInfo[],
  displayLimit: number = 20,
): McpResponse<{ callers: CallerInfo[]; reachingEntrypoints: EntrypointInfo[]; totalCallers: number } | string> {
  const resultCount = callers.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    return {
      data: {
        callers: tagRepoArray(callers.slice(0, displayLimit), resolve),
        reachingEntrypoints: tagRepoArray((reachingEntrypoints || []).slice(0, displayLimit), resolve),
        totalCallers: callers.length,
      },
      metadata,
      resultCount,
    };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Callers of \`${functionName}\` (${callers.length})\n`);

  if (callers.length === 0 && (!reachingEntrypoints || reachingEntrypoints.length === 0)) {
    lines.push(zeroResultsLine(`no caller or reaching entrypoint found for \`${functionName}\` in this scope`));
  }

  // Group by distance
  const direct = callers.filter((c) => c.distance === 1);
  const transitive = callers.filter((c) => c.distance > 1);

  if (direct.length > 0) {
    lines.push(`### Direct Callers (${direct.length})`);
    for (const caller of direct.slice(0, displayLimit)) {
      lines.push(`- ${formatFunctionSummary(caller, { resolve })}`);
    }
    if (direct.length > displayLimit) {
      lines.push(`- ... and ${direct.length - displayLimit} more`);
    }
    lines.push('');
  }

  if (transitive.length > 0) {
    lines.push(`### Transitive Callers (${transitive.length})`);
    for (const caller of transitive.slice(0, displayLimit)) {
      lines.push(`- ${formatCallerSummary(caller, resolve)}`);
    }
    if (transitive.length > displayLimit) {
      lines.push(`- ... and ${transitive.length - displayLimit} more`);
    }
  }

  if (reachingEntrypoints && reachingEntrypoints.length > 0) {
    lines.push('');
    lines.push(`### Reaching Entrypoints (${reachingEntrypoints.length})`);
    for (const ep of reachingEntrypoints.slice(0, displayLimit)) {
      lines.push(`- ${formatEntrypointSummary(ep, resolve)}`);
    }
    if (reachingEntrypoints.length > displayLimit) {
      lines.push(`- ... and ${reachingEntrypoints.length - displayLimit} more`);
    }
  }

  pushDetailFooter(lines, metadata);
  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format entity consumers
 */
export function formatEntityConsumers(
  consumers: EntityConsumerInfo[],
  entityName: string,
  metadata: McpResponseMetadata,
): McpResponse<EntityConsumerInfo[] | string> {
  const resultCount = consumers.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    return { data: tagRepoArray(consumers, resolve), metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Functions Operating on \`${entityName}\` (${consumers.length})\n`);

  if (consumers.length === 0) {
    lines.push(zeroResultsLine(`no read/write site recorded for \`${entityName}\` in this scope`));
  }

  // Group by operation
  const byOp = new Map<string, EntityConsumerInfo[]>();
  for (const c of consumers) {
    const list = byOp.get(c.operation) || [];
    list.push(c);
    byOp.set(c.operation, list);
  }

  for (const [op, fns] of byOp) {
    lines.push(`### ${op.toUpperCase()} (${fns.length})`);
    for (const fn of fns.slice(0, 10)) {
      lines.push(`- ${formatFunctionSummary(fn, { resolve })}`);
    }
    if (fns.length > 10) {
      lines.push(`- ... and ${fns.length - 10} more`);
    }
    lines.push('');
  }

  pushDetailFooter(lines, metadata);
  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Render one column as `name[(→columnName)]: type [flags]`.
 */
function formatColumn(field: DbSchemaEntity['fields'][number], enumValues?: Map<string, EnumMember[]>): string {
  const colName = field.columnName && field.columnName !== field.name ? ` → \`${field.columnName}\`` : '';
  const typeText = field.dbType || field.type?.text || 'unknown';
  // Inline the enum value-set when this column's type resolves to a known enum.
  const baseId = enumBaseId(field.type?.text);
  const enumSuffix = baseId ? enumValuesSuffix(enumValues?.get(baseId)) : '';
  const flags: string[] = [];
  if (field.isPrimaryKey) flags.push('PK');
  if (field.isUnique) flags.push('unique');
  if (field.isNullable) flags.push('nullable');
  if (field.isGenerated) flags.push('generated');
  if (field.defaultValue !== undefined) flags.push(`default=${field.defaultValue}`);
  const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
  return `\`${field.name}\`${colName}: ${typeText}${enumSuffix}${flagStr}`;
}

/**
 * Render one relation as `name → Target (type[, join: col])`.
 */
function formatRelation(rel: DbSchemaEntity['relations'][number]): string {
  const join = rel.joinColumn ? `, join: ${rel.joinColumn}` : '';
  return `\`${rel.name}\` → ${rel.targetEntityName} (${rel.type}${join})`;
}

/**
 * Format DB schema (entities with columns + relations + indexes) for
 * describe_db_schema. `single` selects the deep-dive vs whole-schema heading.
 */
export function formatDbSchema(
  entities: DbSchemaEntity[],
  metadata: McpResponseMetadata,
  opts: { single: boolean; compact?: boolean; enumValues?: Map<string, EnumMember[]> },
): McpResponse<DbSchemaEntity[] | string> {
  const resultCount = entities.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    return { data: tagRepoArray(entities, resolve), metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(opts.single ? '## DB Schema\n' : `## DB Schema — ${entities.length} table(s)\n`);

  // Compact one-line-per-table overview (column names + relation count only, no
  // types/flags). Used for the whole-schema dump default and detailLevel='basic',
  // to keep a 30+-table service from blowing the context.
  if (opts.compact || metadata.detailLevel === 'basic') {
    for (const e of entities) {
      const cols = e.fields.map((f) => f.name).join(', ');
      const rel = e.relations.length > 0 ? ` · ${e.relations.length} relation(s)` : '';
      lines.push(`- \`${e.name}\` (table \`${e.tableName}\`): ${cols || '—'}${rel}`);
    }
    if (!opts.single)
      lines.push('\n_Compact view — pass `entityName` or `detailLevel: "full"` for columns with types/flags._');
    return { data: lines.join('\n'), metadata, resultCount };
  }

  for (const e of entities) {
    const repoTag = e.repo ? ` _(${e.repo})_` : '';
    lines.push(`### \`${e.name}\` — table \`${e.tableName}\` (${e.ormType})${repoTag}`);
    lines.push(`${e.filePath}:${e.startLine}`);

    if (e.fields.length > 0) {
      lines.push(`\n**Columns (${e.fields.length})**`);
      for (const f of e.fields) lines.push(`- ${formatColumn(f, opts.enumValues)}`);
    }

    if (e.relations.length > 0) {
      lines.push(`\n**Relations (${e.relations.length})**`);
      for (const r of e.relations) lines.push(`- ${formatRelation(r)}`);
    }

    if (e.indexes && e.indexes.length > 0) {
      lines.push(`\n**Indexes (${e.indexes.length})**`);
      for (const idx of e.indexes) {
        const uniq = idx.isUnique ? ' [unique]' : '';
        lines.push(`- (${idx.columns.join(', ')})${uniq}`);
      }
    }

    if (e.fields.length === 0 && e.relations.length === 0) {
      lines.push('\n_No column/relation detail captured for this entity (re-parse + re-push to populate)._');
    }

    lines.push('');
  }

  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format service dependencies
 */
export function formatServiceDependencies(
  deps: ServiceDependencyResult[],
  repoName: string,
  metadata: McpResponseMetadata,
): McpResponse<ServiceDependencyResult[] | string> {
  const resultCount = deps.length;
  if (metadata.format === 'raw') {
    return { data: deps, metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Service Dependencies of \`${repoName}\` (${deps.length})\n`);

  if (deps.length === 0) {
    lines.push(zeroResultsLine(`no outbound service dependency recorded for \`${repoName}\``));
  }

  for (const dep of deps) {
    lines.push(`### ${dep.service}`);
    lines.push(`- **Calls:** ${dep.callCount}`);
    lines.push(`- **Types:** ${dep.callTypes.join(', ')}`);
    if (dep.patterns.length > 0) {
      lines.push(`- **Patterns:**`);
      for (const pattern of dep.patterns.slice(0, 5)) {
        lines.push(`  - \`${pattern}\``);
      }
      if (dep.patterns.length > 5) {
        lines.push(`  - ... and ${dep.patterns.length - 5} more`);
      }
    }
    lines.push('');
  }

  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format semantic_search results — embedded symbols ranked by cosine
 * similarity against the embedded query. Similarity renders to 2 decimals;
 * rows carry name/kind/location and a one-line summary only (never source).
 */
export function formatSemanticSearchResults(
  results: SemanticSearchResult[],
  query: string,
  embeddedCount: number,
  metadata: McpResponseMetadata,
): McpResponse<SemanticSearchResult[] | string> {
  const resultCount = results.length;
  const resolve = buildRepoResolver(metadata.scope);
  if (metadata.format === 'raw') {
    return { data: tagRepoArray(results, resolve), metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Semantic matches for "${query}" (top ${results.length} of ${embeddedCount} embedded symbols)\n`);

  for (const r of results) {
    // Summaries are multi-line prose; keep list rows one-line (first line,
    // capped) — the trailing … marks an intentional cut (see formatCodeElementList).
    const firstLine = r.summary?.split('\n')[0]?.trim();
    const desc = firstLine && firstLine.length > 120 ? `${firstLine.slice(0, 120).trimEnd()}…` : firstLine;
    lines.push(
      `- ${r.similarity.toFixed(2)} \`${r.name}\` (${r.kind}) - ${formatLocation(r.filePath, r.startLine)}${repoTag(r.id, resolve)}${desc ? `\n   ${desc}` : ''}`,
    );
  }

  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * Format get_extraction_coverage results — per-repo counts (in-repo call
 * resolution, entity operations, external calls) plus the trust-guidance lines
 * computed in coverage.ts.
 */
export function formatExtractionCoverage(
  stats: RepoCoverageStats[],
  metadata: McpResponseMetadata,
): McpResponse<RepoCoverageStats[] | string> {
  const resultCount = stats.length;
  if (metadata.format === 'raw') {
    return { data: stats, metadata, resultCount };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));
  lines.push(`## Extraction Coverage — ${stats.length} repo(s)\n`);

  if (stats.length === 0) {
    lines.push('No parsed repositories matched this scope.');
    return { data: lines.join('\n'), metadata, resultCount };
  }

  for (const s of stats) {
    const nodeCounts = Object.entries(s.nodeCountsByType)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, count]) => `${type} ${count}`)
      .join(', ');

    lines.push(`### ${s.repoName}`);
    for (const record of s.analysis ?? []) {
      const label = record.target ? `${record.target} (${record.language})` : record.language;
      lines.push(
        `- **Analysis — ${label}:** ${record.mode}${record.fallback ? ' (fallback)' : ''}; compiler receiver facts ${record.compilerReceiverTypes ? 'available' : 'unavailable'}`,
      );
    }
    lines.push(`- **Nodes:** ${nodeCounts || 'none'}`);
    lines.push(`- ${dbOperationsLine(s)}`);
    lines.push(`- ${callResolutionLine(s)}`);
    lines.push(
      `- **External calls:** ${s.externalCallCount} total, ${s.resolvedExternalCallCount} resolved (${formatPercent(s.externalResolutionRate)})`,
    );
    lines.push('');
    lines.push('**Trust guidance**');
    if (s.guidance.length > 0) {
      for (const line of s.guidance) lines.push(`- ${line}`);
    } else {
      lines.push(`- ${NO_LOW_COVERAGE_FLAGS}`);
    }
    lines.push('');
  }

  // Printed ONCE for the whole response (not per repo — this response already
  // carries every repo in scope, and repeating ~250 bytes per repo is the kind
  // of payload bloat that made this tool the largest single MCP result).
  // A high resolution rate must never read as "empty results here are real absences".
  lines.push(`> ${DYNAMIC_DISPATCH_CAVEAT}`);

  // Same once-per-response rule, distinct signal: the dispatch caveat is about
  // edges that EXIST but under-resolve at any resolution rate; this block is about
  // categories with no edge to count at all, which no resolution rate can ever flag.
  lines.push('');
  lines.push(STRUCTURALLY_BLIND_HEADING);
  // Some blindness is substrate-conditional (hierarchy edges bind on the TS/JS substrate only), so
  // the languages the scope actually reports decide which entries belong in this response.
  const languages = stats.map((s) => s.primaryLanguage).filter((l): l is string => Boolean(l));
  for (const line of structurallyBlindGuidanceLines({ languages })) lines.push(`- ${line}`);

  return { data: lines.join('\n'), metadata, resultCount };
}

/**
 * The DB-operation line: resolution over the db-operation sites the parser COUNTED, then the
 * entity-coverage clause that line always carried. Same renderings as the call line — "not measured
 * by this graph's parser", "not one site was counted", "nothing in this repository to bind to", a
 * record whose counts cannot all be true, and a real rate are different facts, and only the last
 * one may print a percent.
 */
function dbOperationsLine(s: RepoCoverageStats): string {
  const entities = `${s.entitiesWithDbOps} of ${s.entityCount} entities have at least one recorded operation`;
  const label = '**DB operations:**';
  if (!s.dbOpResolution) {
    return `${label} resolution not measured by this graph's parser — re-parse and re-push to measure; ${entities}`;
  }
  const { dbOpSites, boundDbOps, outOfScopeDbOps } = s.dbOpResolution;
  const counts = { sites: dbOpSites, bound: boundDbOps, outOfScope: outOfScopeDbOps };
  switch (classifyResolution(counts)) {
    case ResolutionRecordState.Inconsistent:
      return `${label} ${DB_OP_RESOLUTION_TEXT.inconsistent} (${boundDbOps} bound, ${outOfScopeDbOps} out of scope over ${dbOpSites} counted sites); ${entities}`;
    case ResolutionRecordState.NoSitesCounted:
      return `${label} ${DB_OP_RESOLUTION_TEXT.noSitesCounted}; ${entities}`;
    case ResolutionRecordState.AllOutOfScope:
      return `${label} ${DB_OP_RESOLUTION_TEXT.allOutOfScope(dbOpSites)}; ${entities}`;
    default: {
      const inScope = dbOpSites - outOfScopeDbOps;
      return `${label} ${boundDbOps}/${inScope} counted sites bound (${formatPercent(boundDbOps / inScope)}); ${outOfScopeDbOps} of ${dbOpSites} counted sites name no entity or table declared in this repository; ${entities}`;
    }
  }
}

/**
 * The in-repo call-resolution line: bound over IN-SCOPE sites, with the raw totals beside it and
 * the out-of-scope count named by its criterion. Several renderings, because "not measured by this
 * graph's parser", "not one site was counted", "nothing in this repository to bind to", an
 * impossible record and a real rate are different facts. The sentences for the non-rate outcomes
 * come from @coredoc/core so this tool, the caveat and `coredoc parse` state them identically.
 */
function callResolutionLine(s: RepoCoverageStats): string {
  const label = '**In-repo call resolution:**';
  if (!s.callResolution) return `${label} not measured by this graph's parser — re-parse and re-push to measure`;
  const { callSites, resolvedCalls, outOfScopeCalls } = s.callResolution;
  const counts = { sites: callSites, bound: resolvedCalls, outOfScope: outOfScopeCalls };
  switch (classifyResolution(counts)) {
    case ResolutionRecordState.Inconsistent:
      return `${label} ${CALL_RESOLUTION_TEXT.inconsistent} (${resolvedCalls} bound, ${outOfScopeCalls} out of scope over ${callSites} counted sites)`;
    case ResolutionRecordState.NoSitesCounted:
      return `${label} ${CALL_RESOLUTION_TEXT.noSitesCounted}`;
    case ResolutionRecordState.AllOutOfScope:
      return `${label} ${CALL_RESOLUTION_TEXT.allOutOfScope(callSites)}`;
    default: {
      const inScope = callSites - outOfScopeCalls;
      return `${label} ${resolvedCalls}/${inScope} counted sites bound (${formatPercent(resolvedCalls / inScope)}); ${outOfScopeCalls} of ${callSites} counted sites name nothing declared in this repository`;
    }
  }
}

// =============================================================================
// Error Formatter
// =============================================================================

/**
 * Format an error response
 */
export function formatError(error: string, metadata: McpResponseMetadata): McpResponse<string> {
  if (metadata.format === 'raw') {
    return {
      data: JSON.stringify({ error }),
      metadata,
    };
  }

  return {
    data: `**Error:** ${error}`,
    metadata,
  };
}

// =============================================================================
// Explain Tool Formatter
// =============================================================================

function formatCandidateRow(c: ExplainCandidate): string {
  const qualified = c.className ? `${c.className}.${c.name}` : c.name;
  const summary = c.summary ? ` — ${truncate(c.summary, 100)}` : '';
  const repo = c.repo ? ` [repo: ${c.repo}]` : '';
  return `- \`${qualified}\` (${c.kind}) at \`${c.filePath}:${c.startLine}\`${repo}${summary}`;
}

/**
 * The label for a usage figure. Tools count a symbol over different edge sets,
 * so every figure states its relation in the same shape — `Usages (<relation>)`
 * — and tools that cannot name their relation fall back to the bare label.
 * Shared so the figures stay comparable across tools.
 */
function usagesLabel(relation?: string): string {
  return relation ? `Usages (${relation})` : 'Usages';
}

function formatExplainMetadata(m: ExplainMetadata): string[] {
  const lines: string[] = [];
  const qualified = m.className ? `${m.className}.${m.name}` : m.name;
  // When the parser emitted this declaration under multiple kinds (class+entity,
  // function+component), show them all so the agent sees the dual nature.
  const kindLabel = m.kinds && m.kinds.length > 1 ? m.kinds.join(', ') : m.kind;
  lines.push(`## ${qualified} (${kindLabel})\n`);
  lines.push(
    `**File:** \`${m.filePath}:${m.startLine}${m.endLine && m.endLine !== m.startLine ? `-${m.endLine}` : ''}\`\n`,
  );
  if (m.repo) {
    lines.push(`**Repo:** ${m.repo}\n`);
  }
  if (m.summary) {
    lines.push(`### Summary`);
    lines.push(m.summary);
    lines.push('');
  }
  if (typeof m.usageCount === 'number') {
    lines.push(`**${usagesLabel(m.usageRelation)}:** ${m.usageCount}\n`);
    // Sub-line for a figure that sums relations with different consequences
    // (e.g. member-value reads inside an enum's usage count).
    if (m.usageNote) lines.push(`${m.usageNote}\n`);
  }
  // Contained methods first: "what does this class do?" is answered by its
  // behaviour, not its data members.
  if (m.methods && m.methods.length > 0) {
    const total = m.methodsTotal ?? m.methods.length;
    lines.push(`### Methods (${total})`);
    for (const method of m.methods) lines.push(`- ${method}`);
    if (total > m.methods.length) lines.push(`- ... and ${total - m.methods.length} more`);
    lines.push('');
  }
  // Inline structure preview (class properties / interface members / enum values
  // / type-alias definition). Rendered before the navigation footer.
  if (m.fields && m.fields.length > 0) {
    const total = m.fieldsTotal ?? m.fields.length;
    lines.push(`### ${m.fieldsLabel ?? 'Fields'} (${total})`);
    for (const f of m.fields) lines.push(`- ${f}`);
    // Overflow line only for genuine multi-item lists that were sliced; single
    // blobs (an enum value-set or a type-alias definition) carry their own
    // `+N more` truncation inside the rendered string.
    if (m.fields.length > 1 && total > m.fields.length) lines.push(`- ... and ${total - m.fields.length} more`);
    lines.push('');
  }
  if (m.structureNote) lines.push(`> ${m.structureNote}`, '');
  if (m.sourceUnavailableReason) {
    lines.push(
      m.sourceUnavailableReason === 'disabled'
        ? '> Requested source is unavailable: source-in-graph is disabled for this deployment. Read the file in a checkout.'
        : '> Raw source bodies are not stored for this symbol kind. Extracted structure is shown where available; read the file in a checkout for the exact declaration.',
      '',
    );
  }
  if (m.followUpHint) {
    lines.push(`> Deeper: ${m.followUpHint}`);
    lines.push('');
  }
  return lines;
}

/**
 * Render an ExplainResult. Five branches:
 *   - function / entrypoint: the wrapped tool already rendered prose;
 *     pass through. (Callers never feed those through formatExplain — the
 *     handler returns the wrapped response directly when dispatching.)
 *   - metadata: per-kind shallow explainer.
 *   - disambiguation / fuzzy: candidate list with hint.
 *   - not-found: just the hint.
 */
export function formatExplain(
  result: ExplainResult,
  metadata: McpResponseMetadata,
): McpResponse<ExplainResult | string> {
  if (metadata.format === 'raw') {
    return { data: result, metadata };
  }

  const lines: string[] = [];
  lines.push(formatHeaderBanners(metadata));

  switch (result.resolution) {
    case 'metadata':
      if (result.metadata) lines.push(...formatExplainMetadata(result.metadata));
      break;
    case 'disambiguation':
      lines.push(`## Multiple matches for \`${result.target}\`\n`);
      if (result.hint) lines.push(`${result.hint}\n`);
      lines.push(`### Candidates`);
      for (const c of result.candidates ?? []) lines.push(formatCandidateRow(c));
      lines.push('');
      break;
    case 'fuzzy':
      lines.push(`## No exact match for \`${result.target}\`\n`);
      if (result.hint) lines.push(`${result.hint}\n`);
      if (result.candidates && result.candidates.length > 0) {
        lines.push(`### Close matches`);
        for (const c of result.candidates) lines.push(formatCandidateRow(c));
        lines.push('');
      }
      break;
    case 'not-found':
      lines.push(`## \`${result.target}\` not found\n`);
      if (result.hint) lines.push(result.hint);
      break;
    default:
      // function / entrypoint resolutions are handled by their own formatters
      // before reaching this point — defensive fallback.
      lines.push(`## Explain result`);
      lines.push(`Resolution: ${result.resolution}`);
  }

  return { data: lines.join('\n'), metadata };
}
