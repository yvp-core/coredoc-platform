/**
 * What one proposal DOES — decided as pure logic, before any row is written.
 *
 * This is `captureIntentItems` (packages/core/src/intent/capture.ts) adapted
 * from an in-memory overlay to relational rows. The rules it carries over,
 * unchanged, are the ones that make agent-authored intent safe:
 *
 *  - BR-1: a proposal always yields a CANDIDATE. There is no path from propose
 *    to accepted.
 *  - BR-2: an ACCEPTED item is never rewritten. A proposal sharing an accepted
 *    item's source identity becomes a separate candidate and reports the
 *    accepted ids it preserved.
 *  - BR-6: an exact `(ref, localId)` source identity UPDATES the matching
 *    candidate instead of appending a duplicate — this is what makes re-running
 *    a bootstrap packet against the same revision idempotent (spec §8.2).
 *  - BR-7: no similarity matching anywhere. Only exact source identity matches.
 *  - BR-16/BR-17: an id-less proposal gets a deterministic kind-prefixed slug,
 *    and an EXISTING item is never renamed.
 *
 * The one widening (plan decision, audit §3): an EXPLICIT `id` wins when it is
 * supplied. Core's capture treats the id as advisory and matches by source
 * identity alone; the cloud propose API is documented as an upsert by item id,
 * so both are supported — id first, source identity as the fallback.
 *
 * Ambiguity is a REFUSAL, never a guess: two candidates matching one proposal's
 * sources, or an explicit id that points at a different item than the sources
 * do, both stop the request. Picking a winner there would silently fork one
 * intent into two rows, which is the exact failure BR-6 exists to prevent.
 */
import type { IntentKind } from '@coredoc/core';
import { IntentItemAuthority } from '../../generated/prisma/client.js';
import { assertItemIdMatchesKind, deriveIntentItemId } from './intent-id.js';
import { intentStateError } from './intent-state-errors.js';
import { IntentErrorCode } from './contract/index.js';

export enum ProposalOutcome {
  CreatedCandidate = 'created_candidate',
  UpdatedCandidate = 'updated_candidate',
}

/** Source identity is `(ref, localId)` — the document plus the position inside it. */
export function sourceIdentity(source: { ref: string; localId: string }): string {
  return JSON.stringify([source.ref, source.localId]);
}

/** The existing-item facts the decision needs. Everything else stays in the database. */
export interface ExistingItemFacts {
  id: string;
  kind: IntentKind;
  authority: (typeof IntentItemAuthority)[keyof typeof IntentItemAuthority];
}

export interface ProposalContext {
  /** The item the proposal's explicit id names, when it exists. */
  byId: ExistingItemFacts | undefined;
  /** Items sharing at least one source identity with the proposal. */
  sourceMatches: ExistingItemFacts[];
  /** Ids already taken in this workspace under the derivation's scan prefix. */
  takenIds: Iterable<string>;
}

export interface ProposalPlan {
  outcome: ProposalOutcome;
  itemId: string;
  /** True when the id came from the title rather than the request. */
  derivedId: boolean;
  /** Accepted items sharing a source identity with the proposal; left untouched (BR-2). */
  preservedAcceptedItemIds: string[];
}

/**
 * Decide what a single proposal does. Pure: no IO, no clock, no randomness.
 *
 * `path` is the request path of this proposal (`['items', '0']`), so every
 * refusal names the exact item in a batch.
 */
export function planProposal(
  proposal: { id?: string; kind: IntentKind; title: string; sources: { ref: string; localId: string }[] },
  context: ProposalContext,
  path: string[],
): ProposalPlan {
  const candidateMatches = context.sourceMatches.filter((item) => item.authority === IntentItemAuthority.candidate);
  const preservedAcceptedItemIds = context.sourceMatches
    .filter((item) => item.authority === IntentItemAuthority.accepted)
    .map((item) => item.id)
    .sort();

  if (candidateMatches.length > 1) {
    throw intentStateError(
      IntentErrorCode.AmbiguousSourceIdentity,
      `This proposal's sources match more than one existing candidate (${candidateMatches
        .map((item) => item.id)
        .sort()
        .join(', ')}). Split the proposal so each candidate keeps a single source identity.`,
      [...path, 'sources'],
    );
  }
  const candidateMatch = candidateMatches[0];

  if (proposal.id !== undefined) {
    assertItemIdMatchesKind(proposal.id, proposal.kind, [...path, 'id']);

    // The explicit id and the source identity must not point at different
    // items: honouring the id would leave the matched candidate holding the
    // same source identity, and the NEXT proposal citing it would be ambiguous.
    if (candidateMatch !== undefined && candidateMatch.id !== proposal.id) {
      throw intentStateError(
        IntentErrorCode.SourceIdentityConflict,
        `This proposal names item '${proposal.id}', but its sources already belong to candidate '${candidateMatch.id}'. Propose against that id, or cite a different source identity.`,
        [...path, 'id'],
      );
    }

    const existing = context.byId;
    if (existing === undefined) {
      return {
        outcome: ProposalOutcome.CreatedCandidate,
        itemId: proposal.id,
        derivedId: false,
        preservedAcceptedItemIds,
      };
    }
    if (existing.kind !== proposal.kind) {
      throw intentStateError(
        IntentErrorCode.ItemKindImmutable,
        `Intent item '${existing.id}' is a '${existing.kind}'; an item's kind is part of its id and never changes. Propose a new item instead.`,
        [...path, 'kind'],
      );
    }
    if (existing.authority !== IntentItemAuthority.candidate) {
      // BR-2. Reviewed content is never rewritten by a propose call, and an
      // explicit id is not a way around that.
      throw intentStateError(
        IntentErrorCode.ItemNotCandidate,
        `Intent item '${existing.id}' is ${existing.authority} and propose never rewrites reviewed content. Propose a new candidate, naming it as 'proposedSuccessorOfId' to replace it.`,
        [...path, 'id'],
      );
    }
    return {
      outcome: ProposalOutcome.UpdatedCandidate,
      itemId: existing.id,
      derivedId: false,
      preservedAcceptedItemIds,
    };
  }

  if (candidateMatch !== undefined) {
    if (candidateMatch.kind !== proposal.kind) {
      throw intentStateError(
        IntentErrorCode.ItemKindImmutable,
        `This proposal's sources belong to candidate '${candidateMatch.id}', which is a '${candidateMatch.kind}'. An item's kind is part of its id and never changes.`,
        [...path, 'kind'],
      );
    }
    return {
      outcome: ProposalOutcome.UpdatedCandidate,
      itemId: candidateMatch.id,
      derivedId: false,
      preservedAcceptedItemIds,
    };
  }

  return {
    outcome: ProposalOutcome.CreatedCandidate,
    itemId: deriveIntentItemId(proposal.kind, proposal.title, context.takenIds, [...path, 'title']),
    derivedId: true,
    preservedAcceptedItemIds,
  };
}
