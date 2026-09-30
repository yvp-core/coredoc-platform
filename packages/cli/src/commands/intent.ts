/**
 * `coredoc intent validate | status | context | capture` — the deterministic human/test
 * surface over the product-intent overlay (`<repoRoot>/.coredoc/intent.json`).
 *
 * It shares ONE selection implementation with the local `get_intent_context`
 * MCP tool (`selectIntentContext` in `@coredoc/core`) and one evidence
 * implementation with it (`resolveIntentEvidence` in `@coredoc/db`), so a
 * maintainer debugging what an agent saw can reproduce it here exactly.
 *
 * The read commands are read-only by construction: nothing on those paths
 * creates, repairs, or writes the overlay, and an absent file is a state, not a
 * failure (BR-9). `capture` is the one write path, and it delegates every
 * capture rule to the composed core flow.
 */

import * as fs from 'fs';
import {
  INTENT_ANCHOR_WARNING,
  INTENT_INDEX_LIMITS,
  IntentAuthority,
  IntentOverlayStatus,
  MAX_INTENT_FILE_BYTES,
  assertLocalIntentWritable,
  captureIntoIntentFile,
  describeJsonErrorPosition,
  listIntentIndex,
  parseIntentProposalsDocument,
  readIntentFile,
  repoHashesForProject,
  resolveCloudAuthority,
  resolveIntentTarget,
  selectIntentContext,
  type IntentCloudAuthority,
  type IntentTarget,
  type IntentDomain,
  type IntentIndexEntry,
  type IntentIndexRequest,
  type IntentItem,
  type IntentKind,
  type IntentMatchReason,
  type IntentQueryRequest,
  type IntentRelation,
  type IntentValidationError,
} from '@coredoc/core';
import type { RuntimeConfig } from '@coredoc/core/types';
import type { AnchorEvidence, AnchorStatus, IntentEvidenceResult, RepoSnapshotEvidence } from '@coredoc/db';

/**
 * Re-exported so the CLI surface has one import site for the fixed anchor
 * caveat and for the shared overlay-ownership rule (authored in `@coredoc/core`
 * so the MCP tool resolves the same file for the same project).
 */
export { INTENT_ANCHOR_WARNING, resolveIntentTarget, type IntentTarget };

// =============================================================================
// Post-cutover authority marker
// =============================================================================

/**
 * Set on every LOCAL read result once a cloud workspace owns this project's
 * product intent (`config.projects[].intent.mode === 'cloud'`).
 *
 * After the cutover the overlay on disk is frozen: `intent capture` fails fast,
 * but the reads keep answering from it — deliberately, so a cut-over repo stays
 * readable offline. Without a marker that read presents stale content as
 * authoritative ("Overlay: ready"), which is exactly the silent authority split
 * the cutover exists to prevent. The reads are NOT blocked; they are labelled.
 */
export { resolveCloudAuthority, type IntentCloudAuthority };

/**
 * Printed to STDERR on every read of a frozen overlay.
 *
 * stderr rather than stdout because `intent list --ids` is a machine-readable
 * stream — a warning line on stdout would be consumed as an intent id — and
 * because a maintainer sees stderr in the terminal either way.
 */
export function printCloudAuthorityWarning(authority: IntentCloudAuthority | undefined): void {
  if (!authority) return;
  console.warn(
    `⚠ NON-AUTHORITATIVE: this is a frozen LOCAL snapshot of the product intent.\n` +
      `  Authority lives in workspace ${authority.workspaceId}; local writes are blocked.\n` +
      `  For the live intent use the cloud MCP intent tools, or ` +
      `\`coredoc intent export -w ${authority.workspaceId} -o <path>\`.`,
  );
}

// =============================================================================
// Shared overlay load
// =============================================================================

export interface IntentCounts {
  items: number;
  relations: number;
  byAuthority: Record<IntentAuthority, number>;
  byKind: Partial<Record<IntentKind, number>>;
  codeAnchors: number;
}

/**
 * One declared domain and what lives in it (UC-10).
 *
 * Reported in REGISTRY order, including domains with no items: a
 * declared-but-unused domain is valid (BR-19), and hiding it would make the
 * registry unreviewable from the command that is supposed to show it.
 */
export interface IntentDomainComposition {
  id: string;
  title: string;
  items: number;
  byAuthority: Partial<Record<IntentAuthority, number>>;
}

function composeDomains(domains: IntentDomain[], items: IntentItem[]): IntentDomainComposition[] {
  return domains.map((domain) => {
    const owned = items.filter((item) => item.domain === domain.id);
    const byAuthority: Partial<Record<IntentAuthority, number>> = {};
    for (const item of owned) byAuthority[item.authority] = (byAuthority[item.authority] ?? 0) + 1;
    return { id: domain.id, title: domain.title, items: owned.length, byAuthority };
  });
}

function countOverlay(items: IntentItem[], relations: IntentRelation[]): IntentCounts {
  const byAuthority: Record<IntentAuthority, number> = {
    [IntentAuthority.Accepted]: 0,
    [IntentAuthority.Candidate]: 0,
    [IntentAuthority.Rejected]: 0,
    [IntentAuthority.Superseded]: 0,
  };
  const byKind: Partial<Record<IntentKind, number>> = {};
  let codeAnchors = 0;
  for (const item of items) {
    byAuthority[item.authority] += 1;
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    codeAnchors += item.codeAnchors?.length ?? 0;
  }
  return { items: items.length, relations: relations.length, byAuthority, byKind, codeAnchors };
}

/**
 * Whether code-anchor evidence could be computed for this run.
 *
 * `available: false` is NOT an error result (AC-9): the intent itself is still
 * returned, and the consumer is told the graph dimension is unknown rather than
 * being allowed to read an absent `changed` as "unaffected".
 */
export interface IntentEvidenceState {
  available: boolean;
  /** Why evidence is missing — the underlying failure text, surfaced verbatim. */
  reason?: string;
}

/**
 * Injectable evidence seam: the command layer supplies the real graph-backed
 * resolver, tests supply a fake. Keeping it a parameter is what makes the
 * graph-unavailable path testable without a database.
 */
export type IntentEvidenceResolver = (items: IntentItem[]) => Promise<IntentEvidenceResult>;

/**
 * The real resolver: opens the project's graph READ-ONLY and resolves anchors
 * against it. `@coredoc/db` is imported lazily (as everywhere else in the CLI)
 * so `intent validate`, which never needs a graph, does not pay for it.
 *
 * `openProjectDatabase(..., { mode: 'read' })` rather than the process-wide
 * `bindProjectDatabase` + `getRepository()` used by the write commands: the
 * create-mode singleton would MATERIALIZE an empty graph file for a project
 * that was never pushed, turning "the graph is unavailable" into "the graph is
 * empty" — and an inspection command must not create state. Read mode instead
 * throws, which is exactly the graph-unavailable branch (AC-9). Neo4j is the
 * one shared, non-file backend, so it keeps the singleton (same rule as the
 * MCP server's resolveScopedRepository).
 */
export function createGraphEvidenceResolver(config: RuntimeConfig, target: IntentTarget): IntentEvidenceResolver {
  return async (items: IntentItem[]) => {
    const { getConfiguredBackend, getRepository, openProjectDatabase, resolveIntentEvidence, readObservedCheckout } =
      await import('@coredoc/db');
    const backend = getConfiguredBackend();
    const repository =
      backend === 'neo4j'
        ? await getRepository()
        : (
            await openProjectDatabase(config.configDir, target.projectId, {
              mode: 'read',
              ...(backend === 'ladybug' ? { backend: 'ladybug' as const } : {}),
            })
          ).graph;

    const project = config.projects.find((candidate) => candidate.id === target.projectId);
    const repoHashesByName = repoHashesForProject({ repos: project?.repos ?? [] });

    return resolveIntentEvidence({
      repository,
      items,
      repoHashesByName,
      observedCheckouts: { [target.repoName]: await readObservedCheckout(target.repoRoot) },
    });
  };
}

async function resolveEvidenceSafely(
  items: IntentItem[],
  resolver: IntentEvidenceResolver | undefined,
): Promise<{ state: IntentEvidenceState; result?: IntentEvidenceResult }> {
  if (!resolver) {
    return { state: { available: false, reason: 'No local graph was queried for this run.' } };
  }
  try {
    return { state: { available: true }, result: await resolver(items) };
  } catch (error) {
    // A missing/unpushed/locked graph must never fail the command (BR-9): the
    // product intent is still the answer, only its code dimension is unknown.
    return { state: { available: false, reason: error instanceof Error ? error.message : String(error) } };
  }
}

// =============================================================================
// `coredoc intent validate` — file-only, no graph
// =============================================================================

export interface IntentValidateResult {
  projectId: string;
  repo: string;
  intentPath: string;
  status: IntentOverlayStatus;
  /** Set when a cloud workspace owns authority: this read is a frozen snapshot. */
  cloudAuthority?: IntentCloudAuthority;
  counts?: IntentCounts;
  errors?: IntentValidationError[];
  message?: string;
}

export function runIntentValidate(options: { config: RuntimeConfig; projectId: string }): IntentValidateResult {
  const target = resolveIntentTarget(options.config, options.projectId);
  const read = readIntentFile(target.intentPath, {
    expectedProjectId: options.projectId,
    containmentRoot: target.repoRoot,
  });
  const authority = resolveCloudAuthority(options.config, options.projectId);
  const base = {
    projectId: options.projectId,
    repo: target.repoName,
    intentPath: target.intentPath,
    ...(authority ? { cloudAuthority: authority } : {}),
  };

  if (read.status === IntentOverlayStatus.NotConfigured) {
    return { ...base, status: IntentOverlayStatus.NotConfigured };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    return { ...base, status: IntentOverlayStatus.Invalid, errors: read.errors, message: read.message };
  }
  return { ...base, status: IntentOverlayStatus.Ready, counts: countOverlay(read.file.items, read.file.relations) };
}

export function printValidateResult(result: IntentValidateResult): void {
  printCloudAuthorityWarning(result.cloudAuthority);
  if (result.status === IntentOverlayStatus.NotConfigured) {
    console.log(`No intent overlay for project "${result.projectId}".`);
    console.log(`  Expected at: ${result.intentPath}`);
    console.log('  This is not an error — the overlay is opt-in.');
    return;
  }
  if (result.status === IntentOverlayStatus.Invalid) {
    console.error(`✗ ${result.intentPath} is invalid:`);
    for (const error of result.errors ?? []) {
      // A validation message quotes the offending overlay content back (ids,
      // domains, source identities) and zod echoes offending key names into it,
      // so an INVALID file — one that by definition passed no other check — is
      // the most permissive path to this terminal. Sanitize both halves.
      const prefix = error.path.length > 0 ? `${safe(error.path.join('.'))}: ` : '';
      console.error(`  • ${prefix}${safe(error.message)} [${error.code}]`);
    }
    console.error('  Fix the file and re-run `coredoc intent validate`. Nothing was written.');
    return;
  }
  console.log(`✓ ${result.intentPath} is valid`);
  printCounts(result.counts);
}

function printCounts(counts: IntentCounts | undefined): void {
  if (!counts) return;
  console.log(`  Items:        ${counts.items}`);
  for (const [authority, count] of Object.entries(counts.byAuthority)) {
    if (count > 0) console.log(`    ${authority}: ${count}`);
  }
  console.log(`  Relations:    ${counts.relations}`);
  console.log(`  Code anchors: ${counts.codeAnchors}`);
}

// =============================================================================
// `coredoc intent status` — overlay counts + independent graph evidence
// =============================================================================

export interface IntentStatusResult {
  projectId: string;
  repo: string;
  intentPath: string;
  status: IntentOverlayStatus;
  /** Set when a cloud workspace owns authority: this read is a frozen snapshot. */
  cloudAuthority?: IntentCloudAuthority;
  counts?: IntentCounts;
  /** Per-domain composition of the overlay, in registry order (UC-10). */
  domains?: IntentDomainComposition[];
  errors?: IntentValidationError[];
  message?: string;
  /**
   * Present only when evidence was computed; ANCHOR statuses only (never
   * `AnchorStatus.Unmapped`, which is an item-level result — mixing the two
   * units in one histogram would make e.g. "4 matched, 3 unmapped" ambiguous
   * about whether it is counting anchors or items). See `unanchoredItems`.
   */
  anchorCounts?: Partial<Record<Exclude<AnchorStatus, AnchorStatus.Unmapped>, number>>;
  /** Items that declare no code anchors at all (the item-level `unmapped` result). */
  unanchoredItems?: number;
  /** Present only when evidence was computed; snapshot freshness per referenced repo. */
  repos?: RepoSnapshotEvidence[];
  evidence: IntentEvidenceState;
}

export async function runIntentStatus(options: {
  config: RuntimeConfig;
  projectId: string;
  resolveEvidence?: IntentEvidenceResolver;
}): Promise<IntentStatusResult> {
  const target = resolveIntentTarget(options.config, options.projectId);
  const read = readIntentFile(target.intentPath, {
    expectedProjectId: options.projectId,
    containmentRoot: target.repoRoot,
  });
  const authority = resolveCloudAuthority(options.config, options.projectId);
  const base = {
    projectId: options.projectId,
    repo: target.repoName,
    intentPath: target.intentPath,
    ...(authority ? { cloudAuthority: authority } : {}),
  };

  if (read.status === IntentOverlayStatus.NotConfigured) {
    return {
      ...base,
      status: IntentOverlayStatus.NotConfigured,
      evidence: { available: false, reason: 'No overlay to resolve anchors for.' },
    };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    return {
      ...base,
      status: IntentOverlayStatus.Invalid,
      errors: read.errors,
      message: read.message,
      evidence: { available: false, reason: 'The overlay was not loaded, so no anchor was resolved.' },
    };
  }

  const { state, result } = await resolveEvidenceSafely(read.file.items, options.resolveEvidence);
  const anchorCounts = result ? countAnchors(result) : undefined;
  const unanchoredItems = result ? countUnanchoredItems(result) : undefined;

  return {
    ...base,
    status: IntentOverlayStatus.Ready,
    counts: countOverlay(read.file.items, read.file.relations),
    domains: composeDomains(read.file.domains, read.file.items),
    ...(anchorCounts ? { anchorCounts } : {}),
    ...(unanchoredItems !== undefined ? { unanchoredItems } : {}),
    ...(result ? { repos: result.repos } : {}),
    evidence: state,
  };
}

/**
 * The domain registry as a review surface: every declared domain, its item
 * count, and the authority split inside it. Domains are also the id an agent
 * passes to `intent context --domain`, so the list doubles as their discovery
 * path (BR-20).
 */
function printDomains(domains: IntentDomainComposition[] | undefined): void {
  if (!domains) return;
  console.log(`  Domains:      ${domains.length}`);
  for (const domain of domains) {
    const split = Object.entries(domain.byAuthority)
      .map(([authority, count]) => `${authority} ${count}`)
      .join(', ');
    console.log(
      `    ${domain.id} (${stripControlChars(domain.title)}): ${domain.items} item(s)${split ? ` — ${split}` : ''}`,
    );
  }
}

/** Anchor-status histogram — ANCHORS only, never the item-level `unmapped` count. */
function countAnchors(
  result: IntentEvidenceResult,
): Partial<Record<Exclude<AnchorStatus, AnchorStatus.Unmapped>, number>> {
  const counts: Partial<Record<Exclude<AnchorStatus, AnchorStatus.Unmapped>, number>> = {};
  for (const item of result.items) {
    for (const anchor of item.anchors) counts[anchor.status] = (counts[anchor.status] ?? 0) + 1;
  }
  return counts;
}

/** Items that declare no code anchors at all — a separate unit from anchor counts. */
function countUnanchoredItems(result: IntentEvidenceResult): number {
  return result.items.filter((item) => item.itemStatus !== undefined).length;
}

export function printStatusResult(result: IntentStatusResult): void {
  printCloudAuthorityWarning(result.cloudAuthority);
  console.log(`  Project:  ${result.projectId}`);
  console.log(`  Repo:     ${result.repo}`);
  console.log(`  Overlay:  ${result.status} (${result.intentPath})`);
  if (result.status === IntentOverlayStatus.Invalid) {
    console.error(safe(result.message) || 'The overlay is invalid.');
    return;
  }
  if (result.status === IntentOverlayStatus.NotConfigured) return;

  printCounts(result.counts);
  printDomains(result.domains);
  if (!result.evidence.available) {
    console.log('  Code evidence: UNAVAILABLE — anchor status and snapshot freshness are unknown.');
    if (result.evidence.reason) console.log(`    Reason: ${result.evidence.reason}`);
    return;
  }
  console.log('  Anchor status:');
  for (const [status, count] of Object.entries(result.anchorCounts ?? {})) {
    console.log(`    ${status}: ${count}`);
  }
  console.log(`  Unanchored items: ${result.unanchoredItems ?? 0}`);
  for (const repo of result.repos ?? []) {
    console.log(`  Graph snapshot (${repo.repo}): ${repo.snapshotFreshness}`);
  }
  console.log(`  Note: ${INTENT_ANCHOR_WARNING}`);
}

// =============================================================================
// `coredoc intent context` — the bounded agent-facing read
// =============================================================================

export interface IntentContextItem {
  item: IntentItem;
  matchReason: IntentMatchReason;
  /** Empty when the item has no anchors OR when evidence is unavailable — read `evidence` to tell them apart. */
  anchors: AnchorEvidence[];
  /** The item-level `unmapped` result: the item declares no code anchors at all. */
  itemStatus?: AnchorStatus.Unmapped;
}

export interface IntentContextResult {
  projectId: string;
  repo: string;
  intentPath: string;
  status: IntentOverlayStatus;
  /** Set when a cloud workspace owns authority: this read is a frozen snapshot. */
  cloudAuthority?: IntentCloudAuthority;
  errors?: IntentValidationError[];
  message?: string;
  items?: IntentContextItem[];
  relations?: IntentRelation[];
  limit?: number;
  truncated?: boolean;
  omittedCount?: number;
  relationsTruncated?: boolean;
  omittedRelationCount?: number;
  totalMatched?: number;
  unknownIntentIds?: string[];
  repos?: RepoSnapshotEvidence[];
  evidence: IntentEvidenceState;
  /** Always present, on every status, so no rendering path can drop it. */
  warning: string;
}

export async function runIntentContext(options: {
  config: RuntimeConfig;
  projectId: string;
  request: IntentQueryRequest;
  resolveEvidence?: IntentEvidenceResolver;
}): Promise<IntentContextResult> {
  const target = resolveIntentTarget(options.config, options.projectId);
  const read = readIntentFile(target.intentPath, {
    expectedProjectId: options.projectId,
    containmentRoot: target.repoRoot,
  });
  const authority = resolveCloudAuthority(options.config, options.projectId);
  const base = {
    projectId: options.projectId,
    repo: target.repoName,
    intentPath: target.intentPath,
    warning: INTENT_ANCHOR_WARNING,
    ...(authority ? { cloudAuthority: authority } : {}),
  };

  if (read.status === IntentOverlayStatus.NotConfigured) {
    return {
      ...base,
      status: IntentOverlayStatus.NotConfigured,
      evidence: { available: false, reason: 'No overlay to resolve anchors for.' },
    };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    return {
      ...base,
      status: IntentOverlayStatus.Invalid,
      errors: read.errors,
      message: read.message,
      evidence: { available: false, reason: 'The overlay was not loaded, so no anchor was resolved.' },
    };
  }

  const selection = selectIntentContext(read.file, options.request);
  // Evidence is resolved for the RETURNED items only — the bound the caller
  // asked for also bounds the graph work.
  const selected = selection.matches.map((match) => match.item);
  const { state, result } = selected.length
    ? await resolveEvidenceSafely(selected, options.resolveEvidence)
    : { state: { available: false, reason: 'No item matched, so no anchor was resolved.' }, result: undefined };
  const evidenceById = new Map((result?.items ?? []).map((entry) => [entry.intentId, entry]));

  return {
    ...base,
    status: IntentOverlayStatus.Ready,
    items: selection.matches.map((match) => {
      const evidence = evidenceById.get(match.item.id);
      return {
        item: match.item,
        matchReason: match.matchReason,
        anchors: evidence?.anchors ?? [],
        ...(evidence?.itemStatus ? { itemStatus: evidence.itemStatus } : {}),
      };
    }),
    relations: selection.relations,
    limit: selection.limit,
    truncated: selection.truncated,
    omittedCount: selection.omittedCount,
    relationsTruncated: selection.relationsTruncated,
    omittedRelationCount: selection.omittedRelationCount,
    totalMatched: selection.totalMatched,
    unknownIntentIds: selection.unknownIntentIds,
    ...(result ? { repos: result.repos } : {}),
    evidence: state,
  };
}

/**
 * Strip C0/C1 control characters (including ESC/CSI/OSC sequences' control
 * bytes) from untrusted, agent-authored text before it is written to a
 * terminal. Titles, statements, domain titles and source refs on captured
 * candidates come from LLM/agent proposals, and `intent context`/`intent list`
 * are the surfaces a maintainer uses to review them — an embedded ANSI/OSC
 * escape could rewrite that terminal. Every free-text field on those paths is
 * routed through this; constrained fields (ids, slugs, kinds) are not.
 *
 * Exported because the SERVER is an untrusted source of terminal text for the
 * same reason an agent is: `commands/intent-cloud.ts` prints refusal messages,
 * field paths and imported item ids verbatim (spec §12 forbids paraphrasing
 * them), so it routes every server-derived string through this one function
 * rather than growing a second, drifting copy.
 *
 * Normal printable text and ordinary spaces survive; tabs and newlines are
 * dropped so a single rendered line cannot be split or repositioned. The stored
 * overlay is never mutated: this sanitizes at render time only.
 *
 * `JSON.stringify` is NOT a substitute. It escapes C0 (so `\x1b` becomes
 * ``) but passes C1 and DEL through verbatim — `\x9b` is 8-bit CSI and
 * `\x9d` is 8-bit OSC on any terminal that honours them, so a payload rendered
 * with `JSON.stringify` alone is still an injection vector. {@link safeJson}
 * routes the serialized form through this function for that reason.
 */
export function stripControlChars(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0/C1 to strip them.
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Render an untrusted value that may be absent.
 *
 * Every overlay field that is not slug-constrained by the schema goes through
 * this on its way to the terminal. Schema `text()` fields are `z.string()` with
 * a length bound and no character class, so a validated overlay can still carry
 * raw ESC — only `id` and `domain` (INTENT_SLUG_PATTERN) are safe unrouted.
 */
export function safe(value: string | undefined): string {
  return value === undefined ? '' : stripControlChars(value);
}

/** {@link safe} for a serialized structure — see the C1 caveat on {@link stripControlChars}. */
function safeJson(value: unknown): string {
  return stripControlChars(JSON.stringify(value) ?? 'undefined');
}

export function printContextResult(result: IntentContextResult): void {
  printCloudAuthorityWarning(result.cloudAuthority);
  if (result.status === IntentOverlayStatus.NotConfigured) {
    console.log(`No intent overlay for project "${result.projectId}" (expected at ${result.intentPath}).`);
    console.log('  Intent context is unavailable — this is distinct from "no applicable rule".');
    return;
  }
  if (result.status === IntentOverlayStatus.Invalid) {
    console.error(`Intent overlay at ${result.intentPath} is invalid — no context was returned.`);
    console.error(safe(result.message));
    console.error('  Run `coredoc intent validate` for the full path list.');
    return;
  }

  if ((result.unknownIntentIds?.length ?? 0) > 0) {
    console.log(`  Unknown intent ids: ${result.unknownIntentIds?.join(', ')}`);
  }
  if ((result.items?.length ?? 0) === 0) {
    console.log(`No intent item matched in project "${result.projectId}" (the overlay is valid and readable).`);
    return;
  }

  for (const entry of result.items ?? []) {
    const { item } = entry;
    // title/statement are agent-authored (untrusted) — sanitize before they
    // reach the maintainer's terminal, which is the review surface itself.
    console.log(`\n[${item.id}] ${stripControlChars(item.title)}`);
    console.log(
      `  kind: ${item.kind}   domain: ${item.domain}   authority: ${item.authority}   match: ${entry.matchReason}`,
    );
    console.log(`  ${stripControlChars(item.statement)}`);
    console.log(`  payload: ${safeJson(item.payload)}`);
    console.log(
      `  sources: ${item.sources.map((source) => `${source.kind}:${safe(source.ref)}#${safe(source.localId)}`).join(', ')}`,
    );
    if (entry.itemStatus) {
      console.log('  anchors: unmapped (the item declares no code anchors)');
    } else if (!result.evidence.available) {
      const anchors = item.codeAnchors ?? [];
      console.log(`  anchors: ${anchors.length} stored; status UNKNOWN (graph evidence unavailable)`);
      for (const anchor of anchors) {
        console.log(`    - ${safe(anchor.repo)} ${safe(anchor.nodeId)} (${safe(anchor.nodeType)})`);
      }
    } else {
      for (const anchor of entry.anchors) {
        console.log(
          `    - ${safe(anchor.anchor.repo)} ${safe(anchor.anchor.nodeId)}: anchor=${anchor.status}, ` +
            `snapshot=${anchor.snapshotFreshness}${anchor.mismatchReason ? ` (${safe(anchor.mismatchReason)})` : ''}`,
        );
      }
    }
  }

  const relations = result.relations ?? [];
  if (relations.length > 0) {
    console.log('\nRelations (one hop):');
    // Relation endpoints are slug ids, but the schema validates endpoint EXISTENCE,
    // not the slug shape, on every path that reaches this renderer.
    for (const relation of relations) {
      console.log(`  ${safe(relation.from)} --${relation.type}--> ${safe(relation.to)}`);
    }
  }
  if (result.truncated) {
    console.log(`\nTruncated at limit ${result.limit}: ${result.omittedCount} more item(s) matched.`);
  }
  if (result.relationsTruncated) {
    console.log(`Relations truncated: ${result.omittedRelationCount} more relation(s) touch the returned items.`);
  }
  if (!result.evidence.available) {
    console.log('\nCode evidence: UNAVAILABLE — anchor status and snapshot freshness are unknown.');
    if (result.evidence.reason) console.log(`  Reason: ${result.evidence.reason}`);
  } else {
    for (const repo of result.repos ?? []) {
      console.log(`\nGraph snapshot (${repo.repo}): ${repo.snapshotFreshness}`);
    }
  }
  console.log(`\nNote: ${INTENT_ANCHOR_WARNING}`);
}

// =============================================================================
// `coredoc intent list` — the payload-free index
// =============================================================================
//
// The cheap orientation read: what is in this overlay / this domain, as ids and
// titles. It never touches the graph — an index carries no anchors, so there is
// no code dimension to resolve — which also makes it the one intent read that
// cannot be slowed down by an unavailable database.

export interface IntentListResult {
  projectId: string;
  repo: string;
  intentPath: string;
  status: IntentOverlayStatus;
  /** Set when a cloud workspace owns authority: this read is a frozen snapshot. */
  cloudAuthority?: IntentCloudAuthority;
  /** Full declared registry, in registry order; present whenever the overlay loaded. */
  domains?: Array<{ id: string; title: string }>;
  entries?: IntentIndexEntry[];
  truncated?: boolean;
  omittedCount?: number;
  totalMatched?: number;
  errors?: IntentValidationError[];
  message?: string;
}

export function runIntentList(options: {
  config: RuntimeConfig;
  projectId: string;
  request: IntentIndexRequest;
}): IntentListResult {
  const target = resolveIntentTarget(options.config, options.projectId);
  const read = readIntentFile(target.intentPath, {
    expectedProjectId: options.projectId,
    containmentRoot: target.repoRoot,
  });
  const authority = resolveCloudAuthority(options.config, options.projectId);
  const base = {
    projectId: options.projectId,
    repo: target.repoName,
    intentPath: target.intentPath,
    ...(authority ? { cloudAuthority: authority } : {}),
  };

  if (read.status === IntentOverlayStatus.NotConfigured) {
    return { ...base, status: IntentOverlayStatus.NotConfigured };
  }
  if (read.status === IntentOverlayStatus.Invalid) {
    return { ...base, status: IntentOverlayStatus.Invalid, errors: read.errors, message: read.message };
  }

  // An undeclared domain or unknown kind throws out of here (BR-24); the command
  // layer turns that into an exit-1 error, exactly like the other intent reads.
  const index = listIntentIndex(read.file, options.request);
  return {
    ...base,
    status: IntentOverlayStatus.Ready,
    domains: index.domains,
    entries: index.entries,
    truncated: index.truncated,
    omittedCount: index.omittedCount,
    totalMatched: index.totalMatched,
  };
}

/**
 * `idsOnly` is the machine-readable mode, so every DIAGNOSTIC line (absent
 * overlay, invalid overlay, truncation) goes to stderr: a consumer piping
 * stdout into a loop must receive intent ids and nothing else.
 */
export function printListResult(result: IntentListResult, options: { idsOnly?: boolean } = {}): void {
  printCloudAuthorityWarning(result.cloudAuthority);
  if (result.status === IntentOverlayStatus.NotConfigured) {
    console.error(`No intent overlay for project "${result.projectId}" (expected at ${result.intentPath}).`);
    console.error('  The overlay is opt-in — this is distinct from "no applicable rule".');
    return;
  }
  if (result.status === IntentOverlayStatus.Invalid) {
    console.error(`Intent overlay at ${result.intentPath} is invalid — no index was returned.`);
    console.error(safe(result.message));
    console.error('  Run `coredoc intent validate` for the full path list.');
    return;
  }

  const entries = result.entries ?? [];
  if (options.idsOnly) {
    for (const entry of entries) console.log(entry.id);
    if (result.truncated) {
      console.error(`Truncated at ${INTENT_INDEX_LIMITS.max}: ${result.omittedCount} more item(s) matched.`);
    }
    return;
  }

  console.log(`  Project:  ${result.projectId}`);
  console.log(`  Repo:     ${result.repo}`);
  console.log(`  Overlay:  ${result.status} (${result.intentPath})`);
  const domains = result.domains ?? [];
  console.log(`  Domains:  ${domains.length}`);
  for (const domain of domains) console.log(`    ${domain.id}  ${stripControlChars(domain.title)}`);

  const shown = result.truncated ? `${entries.length} of ${result.totalMatched}` : `${entries.length}`;
  console.log(`  Items:    ${shown}`);
  if (entries.length === 0) {
    console.log('    (no item matched this filter — the overlay is valid and readable)');
    return;
  }
  const width = Math.max(...entries.map((entry) => entry.id.length));
  for (const entry of entries) {
    console.log(
      `    ${entry.id.padEnd(width)}  ${stripControlChars(entry.title)}  [${entry.kind}/${entry.domain}/${entry.authority}]`,
    );
  }
  if (result.truncated) {
    console.log(
      `\nTruncated at ${INTENT_INDEX_LIMITS.max}: ${result.omittedCount} more item(s) matched. ` +
        'Narrow with --domain or --kind.',
    );
  }
}

// =============================================================================
// `coredoc intent capture` — the ONE sanctioned write path
// =============================================================================
//
// Every rule this command must not break (BR-1 candidates only, BR-2 accepted
// preservation, BR-6/BR-7 source identity) lives in the composed core flow
// (`captureIntoIntentFile`). This layer only resolves the overlay for a project,
// turns a proposals document into typed proposals, and renders the outcome —
// deliberately, so the CLI cannot become a second, weaker capture implementation.
//
// Nothing here reports content anywhere: capture is local file I/O only (AC-11).

export interface IntentCaptureCliResult {
  projectId: string;
  repo: string;
  intentPath: string;
  createdFile: boolean;
  changed: boolean;
  createdItemIds: string[];
  updatedItemIds: string[];
  unchangedItemIds: string[];
  preservedAcceptedItemIds: string[];
  /** Domain ids a newly created overlay declared from the proposals (review their titles). */
  seededDomainIds: string[];
  /** Ids a proposal supplied that the matched item did not adopt — ids are immutable (BR-17). */
  ignoredProposalIds: string[];
  /** Items whose stored code anchors a proposal's own anchor set replaced, and by how many. */
  droppedAnchors: Array<{ itemId: string; count: number }>;
}

/**
 * `input` is a path to the proposals document, or `-` for stdin.
 *
 * `readStdin` is an injected seam so the stdin path is testable without
 * attaching a pipe to the test process's fd 0.
 */
export function runIntentCapture(options: {
  config: RuntimeConfig;
  projectId: string;
  input: string;
  readStdin?: () => string;
}): IntentCaptureCliResult {
  // Spec §8.1: after cutover a cloud workspace owns authority; the gate lives
  // here so every caller of the write path hits it, not only the CLI verb.
  assertLocalIntentWritable(options.config, options.projectId);
  const target = resolveIntentTarget(options.config, options.projectId);
  const text = options.input === '-' ? readBoundedStdin(options.readStdin) : readBoundedProposalsFile(options.input);

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    // Node embeds the offending BYTES of the input in its parse message, and the
    // proposals document is untrusted authored text: only the position travels.
    throw new Error(
      `--input ${options.input} is not parseable JSON${describeJsonErrorPosition(error)}. ` +
        'Expected {"items": [<intent proposals>]}.',
    );
  }

  const proposals = parseIntentProposalsDocument(document, options.projectId);
  const result = captureIntoIntentFile(target.intentPath, proposals, {
    expectedProjectId: options.projectId,
    containmentRoot: target.repoRoot,
  });

  return {
    projectId: options.projectId,
    repo: target.repoName,
    intentPath: result.path,
    createdFile: result.createdFile,
    changed: result.changed,
    createdItemIds: result.createdItemIds,
    updatedItemIds: result.updatedItemIds,
    unchangedItemIds: result.unchangedItemIds,
    preservedAcceptedItemIds: result.preservedAcceptedItemIds,
    seededDomainIds: result.seededDomainIds,
    ignoredProposalIds: result.ignoredProposalIds,
    droppedAnchors: result.droppedAnchors,
  };
}

/**
 * The proposals document is untrusted input handed to the one write path, and
 * reading it into memory is unbounded unless something stops it. It is bounded
 * by the SAME cap the overlay reader enforces (`MAX_INTENT_FILE_BYTES`): a
 * document too large to be written as an overlay can never be a valid proposals
 * batch, so it is refused before `JSON.parse` ever sees it.
 */
function readBoundedProposalsFile(input: string): string {
  const stats = fs.statSync(input);
  if (!stats.isFile()) throw new Error(`--input ${input} is not a regular file.`);
  if (stats.size > MAX_INTENT_FILE_BYTES) {
    throw new Error(`--input ${input} is larger than the ${MAX_INTENT_FILE_BYTES} byte intent overlay limit.`);
  }
  return fs.readFileSync(input, 'utf-8');
}

/**
 * stdin has no size to stat, so the read itself is bounded: at most one byte
 * past the cap is pulled in, which is enough to know the cap was exceeded
 * without buffering the rest.
 */
function readBoundedStdin(readStdin?: () => string): string {
  const text = (readStdin ?? readStdinUpToCap)();
  if (Buffer.byteLength(text, 'utf-8') > MAX_INTENT_FILE_BYTES) {
    throw new Error(`--input - is larger than the ${MAX_INTENT_FILE_BYTES} byte intent overlay limit.`);
  }
  return text;
}

function readStdinUpToCap(): string {
  const limit = MAX_INTENT_FILE_BYTES + 1;
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  while (total < limit) {
    let read: number;
    try {
      read = fs.readSync(0, buffer, 0, Math.min(buffer.length, limit - total), null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((error as NodeJS.ErrnoException).code === 'EOF') break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function printCaptureResult(result: IntentCaptureCliResult): void {
  console.log(`${result.changed ? '✓ Captured into' : '= No change to'} ${result.intentPath}`);
  if (result.createdFile) console.log('  Created a new overlay for this project.');
  if (result.seededDomainIds.length > 0) {
    printIds('declared domains (placeholder titles — rename in review)', result.seededDomainIds);
  }
  printIds('created candidates', result.createdItemIds);
  printIds('updated candidates', result.updatedItemIds);
  printIds('unchanged candidates', result.unchangedItemIds);
  printIds('preserved accepted items', result.preservedAcceptedItemIds);
  if (result.ignoredProposalIds.length > 0) {
    // Never silent: an agent that believed it renamed an item would keep citing
    // an id the overlay does not contain.
    printIds('ignored proposal ids (an existing item keeps its id)', result.ignoredProposalIds);
  }
  if (result.droppedAnchors.length > 0) {
    // Same rule for the one field an update still replaces: a maintainer's
    // anchoring work must not disappear without a line saying it did.
    for (const dropped of result.droppedAnchors) {
      console.log(
        `  replaced code anchors on ${safe(dropped.itemId)}: ${dropped.count} stored anchor(s) the proposal did not carry`,
      );
    }
  }
  console.log('  Everything captured is a candidate — acceptance is a reviewed maintainer edit.');
  console.log('  Next: review the diff, then run `coredoc intent validate`.');
}

function printIds(label: string, ids: string[]): void {
  console.log(`  ${label}: ${ids.length}${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`);
}
