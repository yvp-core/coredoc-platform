/**
 * get_intent_context Tool Handler — LOCAL-ONLY.
 *
 * The single bounded read over the repo-local product-intent overlay
 * (`<repoRoot>/.coredoc/intent.json`, ADR-3). It returns the applicable
 * REVIEWED product intent for a task plus the current state of its code
 * anchors — never a conformance verdict.
 *
 * Three properties this handler must preserve:
 *  - Authority (`accepted`/`candidate`/…), `anchorStatus`, and repo
 *    `snapshotFreshness` are rendered INDEPENDENTLY (BR-4/AC-7). A `matched`
 *    anchor on a `stale` graph is a normal result and must not collapse into
 *    "unaffected".
 *  - Absent overlay, invalid overlay, no match, and unavailable graph are four
 *    DISTINCT results, none of which is a tool error (BR-9/AC-9). An agent that
 *    cannot get context continues under repository rules.
 *  - Reads never create anything: no overlay file, no graph database.
 *
 * Selection is delegated to `selectIntentContext` in `@coredoc/core` — the same
 * function `coredoc intent context` calls — so the CLI reproduces exactly what
 * the agent saw. Anchor resolution is `resolveIntentEvidence` in `@coredoc/db`.
 *
 * The tool serves TWO modes over that one contract (BR-28, keeping ADR-3's
 * single intent tool): the default `context` mode above, and a payload-free
 * `list` mode ({@link listIntentIndex}) for orientation — domains and slug ids
 * before an exact-id fetch. The modes take disjoint arguments, and mixing them
 * is refused rather than silently ignored: a caller whose `query` was dropped
 * would read a whole-overlay index as a search result.
 */

import * as path from 'path';
import {
  IntentOverlayStatus,
  INTENT_INDEX_LIMITS,
  IntentKind,
  IntentMatchReason,
  IntentQueryError,
  listIntentIndex,
  readIntentFile,
  repoHashesForProject,
  resolveCloudAuthority,
  resolveIntentTarget,
  selectIntentContext,
  type CodeAnchor,
  type IntentAuthority,
  type IntentIndexEntry,
  type IntentItem,
  type IntentRelation,
  type IntentSourceRef,
  type IntentValidationError,
} from '@coredoc/core';
import type {
  AnchorMismatchReason,
  AnchorStatus,
  IGraphReadRepository,
  IntentEvidenceResult,
  RepoSnapshotEvidence,
  SnapshotFreshness,
} from '@coredoc/db';
import { loadConfig } from '../../scope-resolver.js';
import { createMetadata } from '../../response-formatter.js';
import { debug } from '../../debug-logger.js';
import type { DetailLevel, DetailLevelConfig, McpResponse, OutputFormat, ScopeContext } from '../../types.js';

/**
 * The one-clause caveat a context response carries whenever it returns an
 * anchor (LIM-2).
 *
 * Deliberately shorter than the CLI's {@link INTENT_ANCHOR_WARNING} and
 * deliberately conditional: this string is paid for on EVERY tool call an agent
 * makes, and a response with no anchor in it has nothing to caveat. The CLI
 * keeps the long form — a human reads it once, an agent re-reads it per call.
 */
export const INTENT_ANCHOR_WARNING_COMPACT =
  'Code anchors are implementation touchpoints — not conformance or runtime proof.';

/** Length a commit SHA is truncated to; enough to identify, short enough to be cheap. */
const COMMIT_PREFIX_LENGTH = 12;

/**
 * One stored anchor plus, when the graph could be read, its resolved status.
 *
 * `capturedVersionedId`/`currentVersionedId` are deliberately NOT carried:
 * `anchorStatus` already IS the comparison between them, and two opaque
 * versioned ids per anchor are pure cost to a reader that cannot act on them.
 * `snapshotFreshness` is not repeated here either — {@link
 * IntentContextResponse.repoSnapshots} is the single per-repo freshness
 * surface, still reported independently of `anchorStatus` (BR-4/AC-7).
 */
export interface IntentContextAnchor extends Omit<CodeAnchor, 'capturedVersionedId'> {
  /** Absent when graph evidence is unavailable — never defaulted to a status. */
  anchorStatus?: AnchorStatus.Matched | AnchorStatus.Changed | AnchorStatus.Missing;
  mismatchReason?: AnchorMismatchReason;
}

/** Per-repo freshness: the response's ONLY freshness surface, with commits truncated. */
export interface IntentContextRepoSnapshot {
  repo: string;
  repoHash?: string;
  snapshotFreshness: SnapshotFreshness;
  graphCommit?: string;
  observedCommit?: string;
}

export interface IntentContextItem {
  id: string;
  kind: IntentKind;
  /** Declared domain the item belongs to; also the value the `domain` filter takes. */
  domain: string;
  title: string;
  statement: string;
  authority: IntentAuthority;
  /** Omitted for {@link IntentMatchReason.ExactId}: the caller asked for this id. */
  matchReason?: IntentMatchReason;
  /** Full typed payload only at `detailLevel: "full"` — the default stays compact (ADR-3). */
  payload?: IntentItem['payload'];
  sources: IntentSourceRef[];
  codeAnchors: IntentContextAnchor[];
  /** The item-level result: the item declares no code anchors at all. */
  itemStatus?: AnchorStatus.Unmapped;
}

/**
 * The context response.
 *
 * The optional fields are optional BY DESIGN, not by accident: a field that
 * always reads `false`/`[]`/`true` teaches the caller nothing and is paid for
 * on every call, so truncation metadata appears only when something WAS
 * truncated, `unknownIntentIds` only when an id was not found, and `evidence`
 * only when it is unavailable (its `available: true` state is implied by the
 * anchor statuses that are then present).
 *
 * `intentPath` is deliberately ABSENT. Naming the overlay file to an agent
 * invites it to read that file directly, which bypasses this bounded read and
 * the anchor/freshness resolution that only exists here. `coredoc intent`
 * still prints the path for humans.
 */
export interface IntentContextResponse {
  project: { id: string; repo: string };
  overlayStatus: IntentOverlayStatus;
  /** Populated only for `invalid`, with JSON paths pointing at what to fix. */
  validationErrors?: IntentValidationError[];
  items: IntentContextItem[];
  relations: IntentRelation[];
  repoSnapshots: IntentContextRepoSnapshot[];
  limit: number;
  truncated?: boolean;
  omittedCount?: number;
  relationsTruncated?: boolean;
  omittedRelationCount?: number;
  totalMatched: number;
  /** Present only when a requested id does not exist in the overlay. */
  unknownIntentIds?: string[];
  /** Present only when anchor evidence could NOT be resolved (AC-9). */
  evidence?: { available: false; reason?: string };
  /** Present only when the response actually carries a code anchor (LIM-2). */
  warning?: string;
}

/** Which of the tool's two reads is being asked for (BR-28). */
export enum IntentToolMode {
  /** The default: applicable intent with payloads and anchor evidence. */
  Context = 'context',
  /** Payload-free orientation: the domain registry plus matching ids/titles. */
  List = 'list',
}

/** Shape of a list-mode response (BR-26). List mode only. */
export enum IntentIndexFormat {
  /** Default: id + title + kind + domain + authority per entry. */
  Index = 'index',
  /** Slug ids only, for a caller that will follow up by exact id. */
  Ids = 'ids',
}

export interface IntentIndexResponse {
  project: { id: string; repo: string };
  overlayStatus: IntentOverlayStatus;
  validationErrors?: IntentValidationError[];
  /** Echoed so a response can never be mistaken for the context read. */
  mode: IntentToolMode.List;
  /** The full declared registry, in registry order — never narrowed by the filters. */
  domains: Array<{ id: string; title: string }>;
  /** Present at `format: "index"`. */
  entries?: IntentIndexEntry[];
  /** Present at `format: "ids"`. */
  ids?: string[];
  /** The index bound (its own constant, not the context limit). */
  limit: number;
  truncated: boolean;
  omittedCount: number;
  totalMatched: number;
}

/**
 * Arguments that belong to exactly one mode; naming one in the other mode is
 * refused (BR-28).
 *
 * `format` is deliberately absent from both lists: it is the SERVER-WIDE output
 * argument every tool accepts (`summary`/`raw`), and list mode overloads it with
 * {@link IntentIndexFormat}. Rejecting it in context mode would break existing
 * `format: "raw"` calls, so only its VALUE is constrained, and only in list mode.
 */
const CONTEXT_ONLY_ARGS = ['intentIds', 'nodeIds', 'query', 'limit'] as const;
const LIST_ONLY_ARGS = ['kind'] as const;

/**
 * A selector that is PRESENT but of the wrong type is a malformed request, not a
 * filter to widen away. `intentIds: 5`, `nodeIds: [1]`, `query: 42`,
 * `limit: '10'`, `includeCandidates: 'true'` must be refused the same way a
 * non-string `domain` is (BR-28), because silently coercing them to `undefined`
 * returns the UNFILTERED accepted set — the widest possible read for a caller who
 * asked for a narrow one. get_intent_context is deliberately absent from the
 * zod-validated TOOL_SCHEMAS, so this is the only place the shapes are enforced.
 */
function malformedSelector(args: Record<string, unknown>): string | undefined {
  for (const name of ['intentIds', 'nodeIds'] as const) {
    const value = args[name];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      return `intent selector \`${name}\` must be an array of strings`;
    }
  }
  if (args.query !== undefined && typeof args.query !== 'string') return 'intent selector `query` must be a string';
  if (args.limit !== undefined && typeof args.limit !== 'number') return 'intent selector `limit` must be a number';
  if (args.includeCandidates !== undefined && typeof args.includeCandidates !== 'boolean') {
    return 'intent selector `includeCandidates` must be a boolean';
  }
  return undefined;
}

function enumValue<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * An ARRAY argument stays an array, empty included.
 *
 * Collapsing `[]` to `undefined` erased the difference between "the caller passed
 * no selector" and "the caller computed a selector that matched nothing" — an
 * agent that derived `nodeIds` from a diff and found no anchored node got the
 * whole default accepted set back, the widest answer to the narrowest question.
 * `selectIntentContext` now treats a present-but-empty array as a selector that
 * matched nothing, so it must actually receive one. A non-array is still absent,
 * and non-string entries are still dropped.
 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function handleGetIntentContext(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel?: DetailLevel,
  detailConfig?: DetailLevelConfig,
  repository?: IGraphReadRepository,
): Promise<McpResponse<IntentContextResponse | IntentIndexResponse | string>> {
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);

  const mode = args.mode === undefined ? IntentToolMode.Context : enumValue(Object.values(IntentToolMode), args.mode);
  if (mode === undefined) {
    return {
      data: `Unknown mode '${String(args.mode)}'. Valid modes: ${Object.values(IntentToolMode).join(', ')}.`,
      metadata,
      isError: true,
    };
  }

  // Mode confusion is refused before any file is read: silently ignoring a
  // selector would answer a different question than the one asked (BR-28).
  const misplaced = (mode === IntentToolMode.List ? CONTEXT_ONLY_ARGS : LIST_ONLY_ARGS).filter(
    (name) => args[name] !== undefined,
  );
  if (misplaced.length > 0) {
    const remedy =
      mode === IntentToolMode.List
        ? 'List mode indexes the overlay and takes only `domain`, `kind`, `includeCandidates`, and `format`. Drop them, or re-issue the call with mode "context" to fetch or search items.'
        : 'Context mode fetches items and takes `intentIds`, `query`, `nodeIds`, `domain`, `includeCandidates`, and `limit`. Drop them, or re-issue the call with mode "list" to browse the index.';
    return {
      data: `Invalid arguments for mode "${mode}": ${misplaced.join(', ')}. ${remedy}`,
      metadata,
      isError: true,
    };
  }

  // The overlay is per PROJECT, so an unbound server has nothing to read: there
  // is no cwd fallback that could pick the right project's product intent.
  if (!scope.projectId || !scope.configDir) {
    return {
      data: 'No project bound. get_intent_context requires MCP_CONFIG_PATH and COREDOC_SCOPE=project:<id>.',
      metadata,
      isError: true,
    };
  }

  const config = loadConfig(process.env.MCP_CONFIG_PATH ?? path.join(scope.configDir, 'coredoc.config.json'));
  // LIM-1: after cutover the overlay is a frozen snapshot, not authority. Refuse
  // in both modes before reading it, so an agent never plans against stale intent.
  const authority = resolveCloudAuthority(config, scope.projectId);
  if (authority) {
    return {
      data:
        `Product intent for project "${scope.projectId}" is owned by cloud workspace ${authority.workspaceId}. ` +
        'The local overlay is a frozen snapshot and is not served. ' +
        'Call get_intent_context on the workspace MCP instead.',
      metadata,
      isError: true,
    };
  }

  const target = resolveIntentTarget(config, scope.projectId);
  const read = readIntentFile(target.intentPath, {
    expectedProjectId: scope.projectId,
    containmentRoot: target.repoRoot,
  });

  if (mode === IntentToolMode.List) {
    return respondWithIndex(args, read, { id: scope.projectId, repo: target.repoName }, metadata);
  }

  const base: IntentContextResponse = {
    project: { id: scope.projectId, repo: target.repoName },
    overlayStatus: read.status,
    items: [],
    relations: [],
    repoSnapshots: [],
    limit: 0,
    totalMatched: 0,
  };

  // No overlay was loaded, so nothing was resolved — an explicit AC-9 state,
  // never an empty result that reads as "no intent applies".
  const unloaded = { available: false, reason: 'No overlay was loaded, so no anchor was resolved.' } as const;

  if (read.status === IntentOverlayStatus.NotConfigured) {
    debug('get_intent_context', `not_configured at ${target.intentPath}`);
    return { data: { ...base, evidence: unloaded }, metadata, resultCount: 0 };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    debug('get_intent_context', `invalid overlay at ${target.intentPath}`);
    return { data: { ...base, validationErrors: read.errors, evidence: unloaded }, metadata, resultCount: 0 };
  }

  // A `domain` that is present but not a string is a malformed REQUEST, not a
  // filter to widen away: `typeof === 'string' ? … : undefined` would silently
  // drop it and return the UNFILTERED accepted set, the opposite of what the
  // caller asked for. Refuse it the same way an undeclared domain id is
  // refused, before it ever reaches the query engine.
  if (args.domain !== undefined && typeof args.domain !== 'string') {
    const declared = read.file.domains.map((entry) => entry.id).join(', ') || '<none declared>';
    debug('get_intent_context', 'rejected request: domain must be a string');
    return {
      data: `intent domain must be a string; declared domains: ${declared}`,
      metadata,
      isError: true,
    };
  }

  const malformed = malformedSelector(args);
  if (malformed !== undefined) {
    debug('get_intent_context', `rejected request: ${malformed}`);
    return { data: malformed, metadata, isError: true };
  }

  let selection: ReturnType<typeof selectIntentContext>;
  try {
    selection = selectIntentContext(read.file, {
      intentIds: stringArray(args.intentIds),
      query: typeof args.query === 'string' ? args.query : undefined,
      nodeIds: stringArray(args.nodeIds),
      domain: typeof args.domain === 'string' ? args.domain : undefined,
      includeCandidates: args.includeCandidates === true,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
  } catch (error) {
    // A malformed REQUEST (today: an undeclared `domain`) is a tool error, NOT
    // one of the four non-error overlay states: returning an empty item list
    // would read as "no intent applies" for a question the overlay cannot
    // answer at all (BR-20).
    if (!(error instanceof IntentQueryError)) throw error;
    debug('get_intent_context', `rejected request: ${error.code}`);
    return { data: error.message, metadata, isError: true };
  }

  const selected = selection.matches.map((match) => match.item);
  const evidence = await resolveEvidence(
    config,
    target.projectId,
    target.repoName,
    target.repoRoot,
    selected,
    repository,
  );
  const evidenceByItem = new Map((evidence.result?.items ?? []).map((entry) => [entry.intentId, entry]));
  const includePayload = detailConfig?.includeFullDetails === true;

  const items = selection.matches.map((match): IntentContextItem => {
    const itemEvidence = evidenceByItem.get(match.item.id);
    // `resolveIntentEvidence` resolves `item.codeAnchors` IN ORDER and returns
    // one `AnchorEvidence` per input anchor, so anchors are zipped positionally
    // — never re-keyed by `repo nodeId` — because two anchors on the same node
    // (e.g. different `capturedVersionedId`s across a rename) would otherwise
    // collapse onto one evidence entry and silently drop the other's status.
    const storedAnchors = match.item.codeAnchors ?? [];
    const resolvedAnchors = itemEvidence?.anchors ?? [];

    return {
      id: match.item.id,
      kind: match.item.kind,
      domain: match.item.domain,
      title: match.item.title,
      statement: match.item.statement,
      authority: match.item.authority,
      // An exact-id fetch already knows why the item is here — the caller named
      // it — so the reason is reported only when it carries information.
      ...(match.matchReason === IntentMatchReason.ExactId ? {} : { matchReason: match.matchReason }),
      ...(includePayload ? { payload: match.item.payload } : {}),
      sources: match.item.sources,
      // Stored anchors are echoed even without evidence: the agent still learns
      // WHERE the intent is implemented, it just does not learn whether that
      // code moved.
      codeAnchors: storedAnchors.map((anchor, index): IntentContextAnchor => {
        const resolved = resolvedAnchors[index];
        const { capturedVersionedId: _captured, ...rendered } = anchor;
        if (!resolved) return rendered;
        return {
          ...rendered,
          anchorStatus: resolved.status,
          ...(resolved.mismatchReason ? { mismatchReason: resolved.mismatchReason } : {}),
        };
      }),
      ...(itemEvidence?.itemStatus ? { itemStatus: itemEvidence.itemStatus } : {}),
    };
  });

  const hasAnchor = items.some((item) => item.codeAnchors.length > 0);

  return {
    data: {
      ...base,
      items,
      relations: selection.relations,
      repoSnapshots: (evidence.result?.repos ?? []).map(compactSnapshot),
      limit: selection.limit,
      ...(selection.truncated ? { truncated: true, omittedCount: selection.omittedCount } : {}),
      ...(selection.relationsTruncated
        ? { relationsTruncated: true, omittedRelationCount: selection.omittedRelationCount }
        : {}),
      totalMatched: selection.totalMatched,
      ...(selection.unknownIntentIds.length > 0 ? { unknownIntentIds: selection.unknownIntentIds } : {}),
      ...(evidence.state.available ? {} : { evidence: evidence.state }),
      // The caveat is about anchors, so it is carried exactly when anchors are.
      ...(hasAnchor ? { warning: INTENT_ANCHOR_WARNING_COMPACT } : {}),
    },
    metadata,
    resultCount: items.length,
  };
}

/** Resolution outcome; only the unavailable half reaches the response (it is the AC-9 signal). */
type EvidenceState = { available: true } | { available: false; reason: string };

/** Per-repo freshness with commits cut to a recognisable prefix (AC-7 dimensions intact). */
function compactSnapshot(snapshot: RepoSnapshotEvidence): IntentContextRepoSnapshot {
  return {
    repo: snapshot.repo,
    ...(snapshot.repoHash ? { repoHash: snapshot.repoHash } : {}),
    snapshotFreshness: snapshot.snapshotFreshness,
    ...(snapshot.graphCommit ? { graphCommit: snapshot.graphCommit.slice(0, COMMIT_PREFIX_LENGTH) } : {}),
    ...(snapshot.observedCommit ? { observedCommit: snapshot.observedCommit.slice(0, COMMIT_PREFIX_LENGTH) } : {}),
  };
}

/**
 * List mode: the payload-free index (BR-23..BR-27).
 *
 * It never touches the graph — an index carries no anchors, so there is no code
 * dimension to resolve — which is what makes it the cheap orientation call an
 * agent can afford before an exact-id fetch. The four overlay states stay the
 * same non-error results they are in context mode (BR-9); only a malformed
 * REQUEST (undeclared domain, unknown kind, unknown format) is a tool error.
 */
function respondWithIndex(
  args: Record<string, unknown>,
  read: ReturnType<typeof readIntentFile>,
  project: { id: string; repo: string },
  metadata: Awaited<ReturnType<typeof createMetadata>>,
): McpResponse<IntentIndexResponse | string> {
  const base: IntentIndexResponse = {
    project,
    overlayStatus: read.status,
    mode: IntentToolMode.List,
    domains: [],
    limit: INTENT_INDEX_LIMITS.max,
    truncated: false,
    omittedCount: 0,
    totalMatched: 0,
  };

  if (read.status === IntentOverlayStatus.NotConfigured) {
    debug('get_intent_context', `list: not_configured for project ${project.id}`);
    return { data: base, metadata, resultCount: 0 };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    debug('get_intent_context', `list: invalid overlay for project ${project.id}`);
    return { data: { ...base, validationErrors: read.errors }, metadata, resultCount: 0 };
  }

  const format =
    args.format === undefined ? IntentIndexFormat.Index : enumValue(Object.values(IntentIndexFormat), args.format);
  if (format === undefined) {
    return {
      data: `Unknown list format '${String(args.format)}'. Valid formats: ${Object.values(IntentIndexFormat).join(', ')}.`,
      metadata,
      isError: true,
    };
  }

  // A present-but-non-string filter is a malformed REQUEST, never a filter to
  // drop: dropping it would return the UNFILTERED index, the opposite of what
  // the caller asked for (same rule as context mode's `domain` check).
  if (args.domain !== undefined && typeof args.domain !== 'string') {
    const declared = read.file.domains.map((entry) => entry.id).join(', ') || '<none declared>';
    return { data: `intent domain must be a string; declared domains: ${declared}`, metadata, isError: true };
  }
  if (args.kind !== undefined && typeof args.kind !== 'string') {
    return {
      data: `intent kind must be a string; valid kinds: ${Object.values(IntentKind).join(', ')}`,
      metadata,
      isError: true,
    };
  }

  let index: ReturnType<typeof listIntentIndex>;
  try {
    index = listIntentIndex(read.file, {
      domain: typeof args.domain === 'string' ? args.domain : undefined,
      kind: typeof args.kind === 'string' ? (args.kind as IntentKind) : undefined,
      includeCandidates: args.includeCandidates === true,
    });
  } catch (error) {
    if (!(error instanceof IntentQueryError)) throw error;
    debug('get_intent_context', `list: rejected request: ${error.code}`);
    return { data: error.message, metadata, isError: true };
  }

  return {
    data: {
      ...base,
      domains: index.domains,
      ...(format === IntentIndexFormat.Ids
        ? { ids: index.entries.map((entry) => entry.id) }
        : { entries: index.entries }),
      truncated: index.truncated,
      omittedCount: index.omittedCount,
      totalMatched: index.totalMatched,
    },
    metadata,
    resultCount: index.entries.length,
  };
}

/**
 * Resolve anchors for the SELECTED items only, and degrade to
 * `available: false` on any graph failure.
 *
 * The catch is deliberate and is the AC-9 contract: an unpushed, locked, or
 * unreadable graph must not turn a context request into a tool error, because
 * the reviewed product intent is still a correct and useful answer without it.
 */
async function resolveEvidence(
  config: ReturnType<typeof loadConfig>,
  projectId: string,
  repoName: string,
  repoRoot: string,
  items: IntentItem[],
  repository: IGraphReadRepository | undefined,
): Promise<{ state: EvidenceState; result?: IntentEvidenceResult }> {
  if (items.length === 0) {
    return { state: { available: false, reason: 'No item matched, so no anchor was resolved.' } };
  }
  if (!repository) {
    return { state: { available: false, reason: 'No local graph is available for this project.' } };
  }

  try {
    const { resolveIntentEvidence, readObservedCheckout } = await import('@coredoc/db');
    const project = config.projects.find((candidate) => candidate.id === projectId);
    const repoHashesByName = repoHashesForProject({ repos: project?.repos ?? [] });

    return {
      state: { available: true },
      result: await resolveIntentEvidence({
        repository,
        items,
        repoHashesByName,
        observedCheckouts: { [repoName]: await readObservedCheckout(repoRoot) },
      }),
    };
  } catch (error) {
    return { state: { available: false, reason: error instanceof Error ? error.message : String(error) } };
  }
}
