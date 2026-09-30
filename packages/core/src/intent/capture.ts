/**
 * Capture proposed intent items into an existing overlay.
 *
 * This is the ONLY sanctioned mutation path for agent-authored intent, and it
 * enforces the rules general validation cannot:
 *  - BR-1: a captured item is always a `candidate`.
 *  - BR-2: an accepted item is never rewritten or demoted; a proposal touching
 *    its source identity becomes a separate candidate proposal, and the result
 *    is compared against the file loaded at capture start before it is handed
 *    back for writing.
 *  - BR-6: an exact `(ref, localId)` source identity updates the existing
 *    candidate in place instead of appending a duplicate, and that update MERGES
 *    (see {@link mergeIntoCandidate}) — a capture citing one of an item's
 *    sources must not erase the others, or the next capture citing a dropped
 *    identity would append the second candidate BR-6 exists to prevent.
 *  - BR-7: sources without an exact shared identity stay separate candidates —
 *    there is no similarity matching anywhere in this file.
 *  - BR-16/BR-17: a proposal without an id gets a deterministic kind-prefixed
 *    slug derived from its title, and an EXISTING item is never renamed — an
 *    update always keeps the id the item already has.
 */
import {
  type IntentValidationError,
  describeItemIdViolation,
  formatIntentValidationErrors,
  validateIntentFile,
} from './schema.js';
import { canonicalIntentJson } from './storage.js';
import {
  INTENT_ID_MAX_LENGTH,
  INTENT_ID_PREFIX_BY_KIND,
  IntentAuthority,
  type CodeAnchor,
  type IntentFileV2,
  type IntentItem,
  type IntentItemProposal,
  type IntentKind,
  type IntentSourceRef,
} from './types.js';

export enum CaptureOutcome {
  CreatedCandidate = 'created_candidate',
  UpdatedCandidate = 'updated_candidate',
}

export enum IntentCaptureErrorCode {
  /** The current file changed an accepted item relative to the capture baseline. */
  AcceptedItemMutation = 'accepted_item_mutation',
  /** One proposal's sources match more than one existing candidate. */
  AmbiguousSourceIdentity = 'ambiguous_source_identity',
  /** A new proposal reuses an id that already belongs to another item. */
  ItemIdCollision = 'item_id_collision',
  /** A supplied proposal id is not `<kind prefix>-<slug>` for its kind (BR-16). */
  InvalidProposalId = 'invalid_proposal_id',
  /** No slug could be derived from the proposal's title and no id was supplied. */
  UnderivableItemId = 'underivable_item_id',
  /** The title's slug does not fit the id cap, so the derived id would drop words. */
  IdWouldTruncate = 'id_would_truncate',
  /** The captured result would not pass validation. */
  InvalidResult = 'invalid_result',
}

export class IntentCaptureError extends Error {
  constructor(
    readonly code: IntentCaptureErrorCode,
    message: string,
    readonly errors: IntentValidationError[] = [],
  ) {
    super(message);
    this.name = 'IntentCaptureError';
  }
}

export interface CaptureIntentInput {
  /** The overlay as loaded when capture started; the BR-2 comparison baseline. */
  baseline: IntentFileV2;
  /** The overlay as it stands now (may differ from the baseline after a maintainer edit). */
  current: IntentFileV2;
  proposals: IntentItemProposal[];
}

export interface CaptureItemResult {
  proposalIndex: number;
  /** Id of the candidate that now carries the proposal (existing id wins on update). */
  itemId: string;
  outcome: CaptureOutcome;
  /** Accepted items sharing a source identity with the proposal; left untouched. */
  preservedAcceptedItemIds: string[];
  /**
   * The id the proposal supplied when it DIFFERS from the id the item keeps
   * (BR-17). Reported rather than silently dropped: an agent that believes it
   * renamed an item would otherwise keep citing an id that does not exist.
   */
  ignoredProposalId?: string;
  /** True when the id was derived from the title because the proposal omitted one. */
  derivedId?: boolean;
  /**
   * Source identities the matched candidate already carried that the proposal
   * did not repeat, and that the update KEPT (BR-6). Reported so the maintainer
   * can see the item still speaks for documents this batch never named.
   */
  retainedSourceCount?: number;
  /**
   * Stored code anchors displaced because the proposal carried an anchor set of
   * its own — the one field an update still replaces. Reported for the same
   * reason {@link ignoredProposalId} is: a maintainer's anchoring work must
   * never disappear silently.
   */
  droppedAnchorCount?: number;
}

export interface CaptureIntentResult {
  file: IntentFileV2;
  results: CaptureItemResult[];
}

/**
 * Source identity is the document plus the position inside it — `kind` is a
 * classification of that document and deliberately NOT part of it. Including it
 * would let a re-capture that reclassified the same source (spec → ticket)
 * append a second candidate for one source position, breaking BR-6.
 */
function identityOf(source: IntentSourceRef): string {
  return JSON.stringify([source.ref, source.localId]);
}

function identitiesOf(item: { sources: IntentSourceRef[] }): Set<string> {
  return new Set(item.sources.map(identityOf));
}

/**
 * Apply a proposal to the candidate it matched, PRESERVING what the proposal
 * does not carry.
 *
 * A capture states what one batch of documents says about an intent; it is not a
 * redefinition of the item. The same intent is routinely re-captured from one of
 * several documents that describe it, and from a spec that says nothing about
 * code — so a plain spread of the proposal over the item silently deletes work
 * the overlay already holds:
 *
 *  - `sources` are UNIONED by `(ref, localId)`. Dropping an identity a previous
 *    capture recorded makes the NEXT capture citing it match nothing and append
 *    a second candidate for one intent, which is exactly the duplicate BR-6/BR-7
 *    exist to prevent.
 *  - `codeAnchors` a maintainer added survive a re-capture that carries none.
 *    A proposal WITH anchors is stating the anchor set, so it still replaces —
 *    and the touchpoints it displaced are counted for the caller to report.
 *
 * Every other field is required by `IntentItemBase`, so a proposal always
 * carries one; an absent one is refused loudly by the validation pass at the end
 * of capture rather than blanking the stored value here.
 */
function mergeIntoCandidate(
  existing: IntentItem,
  proposal: IntentItemProposal,
): { item: IntentItem; retainedSourceCount: number; droppedAnchorCount: number } {
  const proposalIdentities = identitiesOf(proposal);
  const retainedSources = existing.sources.filter((source) => !proposalIdentities.has(identityOf(source)));
  const anchors = proposal.codeAnchors ?? existing.codeAnchors;

  const item = {
    ...proposal,
    id: existing.id,
    authority: IntentAuthority.Candidate,
    sources: unionSources(existing.sources, proposal.sources),
    ...(anchors !== undefined ? { codeAnchors: anchors } : {}),
  } as IntentItem;

  return {
    item,
    retainedSourceCount: retainedSources.length,
    droppedAnchorCount:
      proposal.codeAnchors === undefined ? 0 : droppedAnchorCount(existing.codeAnchors ?? [], proposal.codeAnchors),
  };
}

/**
 * Existing order first, then the identities only the proposal cites.
 *
 * Append-only, so a re-capture never reorders the authored list and the diff a
 * maintainer reviews shows what was added and nothing else. A repeated identity
 * takes the PROPOSAL's copy of the ref: same `(ref, localId)`, possibly a newer
 * `revision`/`locator`.
 */
function unionSources(existing: IntentSourceRef[], proposed: IntentSourceRef[]): IntentSourceRef[] {
  const proposedByIdentity = new Map(proposed.map((source) => [identityOf(source), source]));
  const existingIdentities = identitiesOf({ sources: existing });
  const union = existing.map((source) => proposedByIdentity.get(identityOf(source)) ?? source);
  for (const source of proposed) {
    if (!existingIdentities.has(identityOf(source))) union.push(source);
  }
  return union;
}

/**
 * Stored anchors whose CODE NODE the proposal's anchor set does not mention.
 *
 * Identity is `(repo, nodeId)` rather than the whole anchor: re-observing the
 * same node at a new `capturedVersionedId` is the anchor being refreshed, while
 * a node that disappears from the set is a touchpoint the overlay loses.
 */
function droppedAnchorCount(existing: CodeAnchor[], proposed: CodeAnchor[]): number {
  const kept = new Set(proposed.map((anchor) => JSON.stringify([anchor.repo, anchor.nodeId])));
  return existing.filter((anchor) => !kept.has(JSON.stringify([anchor.repo, anchor.nodeId]))).length;
}

/**
 * Derive the durable slug id of a new item from its title (BR-17 / AC-15).
 *
 * Pure and deterministic: the same `(kind, title, takenIds)` always yields the
 * same id, so a re-run of the same capture batch produces the same file. The
 * title is lowercased and split into `a-z0-9` words, the kind's fixed prefix is
 * prepended, the result is truncated at a WORD boundary to
 * {@link INTENT_ID_MAX_LENGTH}, and a collision takes the first free `-2`,
 * `-3`, … suffix rather than overwriting anything.
 *
 * Throws when the title has no `a-z0-9` content at all (inventing an id there
 * would produce an unsearchable identity, which is the whole reason slugs
 * replaced numeric ids), and when its slug does not FIT the cap: a shortened id
 * is a stub the item would carry forever.
 */
export function deriveIntentId(kind: IntentKind, title: string, takenIds: Iterable<string>): string {
  const prefix = INTENT_ID_PREFIX_BY_KIND[kind];
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    throw new IntentCaptureError(
      IntentCaptureErrorCode.UnderivableItemId,
      `no intent id can be derived from title '${title}': it carries no a-z0-9 characters; supply an explicit '${prefix}-<slug>' id`,
    );
  }

  const taken = new Set(takenIds);
  const base = boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH);
  // A base that does not carry EVERY slug word is a stub, and ids are immutable:
  // an accepted item would keep it forever, so the item is refused instead of
  // written. Dropping words is not a safe shortening — `-are-not` carries the
  // rule's polarity. The collision rebuild below is exempt: shortening there is
  // the price of a distinct id for a title that already derived cleanly.
  if (base !== `${prefix}-${words.join('-')}`) {
    throw new IntentCaptureError(
      IntentCaptureErrorCode.IdWouldTruncate,
      `title '${title}' does not fit an intent id: its slug is longer than ${INTENT_ID_MAX_LENGTH} characters, so the ` +
        `id would be shortened to '${base}' and lose words; supply a shorter title or an explicit '${prefix}-<slug>' id`,
    );
  }
  if (!taken.has(base)) return base;

  // The suffix must fit INSIDE the cap, so the base is rebuilt against the
  // room the suffix leaves rather than appended to a full-length id.
  for (let suffix = 2; ; suffix++) {
    const marker = `-${suffix}`;
    const candidate = `${boundedSlugId(prefix, words, INTENT_ID_MAX_LENGTH - marker.length)}${marker}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * `<prefix>-<word>[-<word>…]` bounded by `max`, cut at a word boundary.
 *
 * The first word is never dropped — an id must carry at least one slug word
 * beyond its prefix (BR-16) — so a single over-long word is hard-sliced rather
 * than removed.
 */
function boundedSlugId(prefix: string, words: string[], max: number): string {
  let out = `${prefix}-${words[0] as string}`;
  if (out.length > max) out = out.slice(0, max);
  for (const word of words.slice(1)) {
    if (out.length + 1 + word.length > max) break;
    out = `${out}-${word}`;
  }
  return out;
}

/** Never mutates its inputs; the caller writes the returned file. */
export function captureIntentItems(input: CaptureIntentInput): CaptureIntentResult {
  const file: IntentFileV2 = structuredClone(input.current);
  const results: CaptureItemResult[] = [];

  input.proposals.forEach((proposal, proposalIndex) => {
    const proposalIdentities = identitiesOf(proposal);
    const matchedCandidateIndexes: number[] = [];
    const preservedAcceptedItemIds: string[] = [];

    file.items.forEach((item, index) => {
      const shared = item.sources.some((source) => proposalIdentities.has(identityOf(source)));
      if (!shared) return;
      if (item.authority === IntentAuthority.Candidate) matchedCandidateIndexes.push(index);
      else if (item.authority === IntentAuthority.Accepted) preservedAcceptedItemIds.push(item.id);
    });

    if (matchedCandidateIndexes.length > 1) {
      const ids = matchedCandidateIndexes.map((i) => file.items[i]?.id).join(', ');
      throw new IntentCaptureError(
        IntentCaptureErrorCode.AmbiguousSourceIdentity,
        `proposal ${proposalIndex} ('${proposal.title}') matches more than one existing candidate (${ids}); ` +
          'split the proposal so each candidate keeps a single source identity',
      );
    }

    // A supplied id is checked against BR-16 before it can reach the file; an
    // omitted one is derived below, so an authoring surface never has to invent
    // an identity scheme of its own.
    if (proposal.id !== undefined) {
      const violation = describeItemIdViolation(proposal.id, proposal.kind);
      if (violation !== undefined) {
        throw new IntentCaptureError(
          IntentCaptureErrorCode.InvalidProposalId,
          `proposal ${proposalIndex}: ${violation}`,
        );
      }
    }

    const matchedIndex = matchedCandidateIndexes[0];
    if (matchedIndex !== undefined) {
      const existing = file.items[matchedIndex] as IntentItem;
      const merged = mergeIntoCandidate(existing, proposal);
      file.items[matchedIndex] = merged.item;
      results.push({
        proposalIndex,
        itemId: existing.id,
        outcome: CaptureOutcome.UpdatedCandidate,
        preservedAcceptedItemIds,
        // An id change is not applied and not silent: the matched item keeps
        // the identity it already has (BR-17).
        ...(proposal.id !== undefined && proposal.id !== existing.id ? { ignoredProposalId: proposal.id } : {}),
        ...(merged.retainedSourceCount > 0 ? { retainedSourceCount: merged.retainedSourceCount } : {}),
        ...(merged.droppedAnchorCount > 0 ? { droppedAnchorCount: merged.droppedAnchorCount } : {}),
      });
      return;
    }

    if (proposal.id !== undefined && file.items.some((item) => item.id === proposal.id)) {
      throw new IntentCaptureError(
        IntentCaptureErrorCode.ItemIdCollision,
        `proposal ${proposalIndex} uses intent id '${proposal.id}', which already belongs to another item; ` +
          'choose a new id or reuse the exact source identity of the item to update',
      );
    }

    const itemId =
      proposal.id ??
      deriveIntentId(
        proposal.kind,
        proposal.title,
        file.items.map((item) => item.id),
      );
    file.items.push({ ...proposal, id: itemId, authority: IntentAuthority.Candidate } as IntentItem);
    results.push({
      proposalIndex,
      itemId,
      outcome: CaptureOutcome.CreatedCandidate,
      preservedAcceptedItemIds,
      ...(proposal.id === undefined ? { derivedId: true } : {}),
    });
  });

  assertAcceptedItemsPreserved(input.baseline, file);

  const validated = validateIntentFile(file);
  if (!validated.ok) {
    throw new IntentCaptureError(
      IntentCaptureErrorCode.InvalidResult,
      `captured intent would be invalid:\n${formatIntentValidationErrors(validated.errors)}`,
      validated.errors,
    );
  }

  return { file: validated.file, results };
}

/**
 * BR-2's hard stop: every accepted item present when capture started must still
 * be present and byte-identical.
 *
 * The guard compares `baseline` against the captured result, so it only fires
 * for a caller that supplies a `current` newer than its `baseline`. The shipped
 * CLI composition (`captureIntoIntentFile`) is single-read — it passes the same
 * file as both — so within its process window the write is last-write-wins and
 * this guard is checking capture's own output, not a concurrent maintainer edit
 * (plan-review D3). Re-reading before the write is deliberately not done: no
 * requirement asks for it, and it would trade a narrow race for a second read
 * whose result capture could not tell from the first.
 */
function assertAcceptedItemsPreserved(baseline: IntentFileV2, result: IntentFileV2): void {
  const resultById = new Map(result.items.map((item) => [item.id, item]));
  for (const accepted of baseline.items) {
    if (accepted.authority !== IntentAuthority.Accepted) continue;
    const after = resultById.get(accepted.id);
    if (!after) {
      throw new IntentCaptureError(
        IntentCaptureErrorCode.AcceptedItemMutation,
        `accepted intent item '${accepted.id}' disappeared during capture; accepted intent may only change through a reviewed edit`,
      );
    }
    if (canonicalIntentJson(after) !== canonicalIntentJson(accepted)) {
      throw new IntentCaptureError(
        IntentCaptureErrorCode.AcceptedItemMutation,
        `accepted intent item '${accepted.id}' would change during capture; capture must propose a candidate instead`,
      );
    }
  }
}
