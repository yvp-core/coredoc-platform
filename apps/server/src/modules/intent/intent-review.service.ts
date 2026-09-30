/**
 * Review: the only path from `candidate` to any other authority (spec §5).
 *
 * The row adapter around `intent-review.plan.ts`. The plan decides what each
 * decision does; this service locks the rows it will judge, applies the plans,
 * and writes one `intent_authority_transitions` row per authority change —
 * everything inside the single transaction `runIntentMutation` opens, so a
 * decision, its transition, and the idempotency ledger commit together or not
 * at all.
 *
 * ITEM BY ITEM. A refused decision is a VALUE in the response, not an
 * exception: one reviewer's stale version must not roll back the nine decisions
 * either side of it (spec §5, §14). That is only safe because every refusal is
 * decided from a READ — no refusal here is a caught constraint violation, which
 * would have aborted the surrounding transaction and taken the applied
 * decisions with it.
 *
 * LOCK FIRST, IN ID ORDER. Every item the batch names — subjects and
 * replacements alike — is locked up front with one `SELECT … ORDER BY id FOR
 * UPDATE`. Two properties follow, and both are requirements rather than
 * optimisations:
 *  - a replacement pair's two version checks are made against state that cannot
 *    move before its two writes, so the pair is atomic without a savepoint: it
 *    is refused before anything is written, or both writes succeed;
 *  - concurrent batches take row locks in the same ascending order, so they
 *    queue instead of deadlocking (spec §13). The loser reads the winner's
 *    committed version and reports a version conflict — the competing
 *    replacement of §14, which stays a candidate.
 *
 * `updateItemWithVersion` is still used for every write. Under the locks its
 * `WHERE version = ?` can no longer fail; keeping it means the version check is
 * enforced by the same statement everywhere, not by this file's reasoning.
 *
 * NO AUDIT ROWS. Authority changes are recorded in
 * `intent_authority_transitions`, not in `intent_audit_events` (spec §4.8):
 * transitions carry the provenance an audit row has no columns for, and one
 * change must not produce two half-descriptions of itself.
 */
import { Injectable } from '@nestjs/common';
import { IntentAuthoritySourceKind, IntentItemAuthority, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  IntentErrorCode,
  IntentAuthorizingSourceKind,
  type IntentAuthorizingSourceInput,
  type IntentErrorDetail,
  type IntentReviewDecisionInput,
  type ReviewIntentItemsInput,
} from './contract/index.js';
import { IntentOperation, runIntentMutation, type IntentActor, type IntentTransaction } from './intent-idempotency.js';
import { updateItemWithVersion } from './intent-optimistic.js';
import {
  IntentReviewEffect,
  IntentReviewOutcome,
  planReviewDecision,
  reviewSubjectIds,
  type IntentReviewPlan,
  type PlannedTransition,
  type ReviewItemFacts,
} from './intent-review.plan.js';
import { intentStateError } from './intent-state-errors.js';

type Authority = (typeof IntentItemAuthority)[keyof typeof IntentItemAuthority];

/** One decision's result. `error` is present exactly when `outcome` is `refused`. */
export interface IntentReviewDecisionResult {
  decisionIndex: number;
  itemId: string;
  action: string;
  outcome: IntentReviewOutcome;
  /** The subject's authority AFTER this decision — unchanged for a refusal or a defer. */
  authority: Authority | null;
  /** The subject's version after this decision, or the current one on a refusal. `null` when it does not exist. */
  version: number | null;
  /** Present on an applied `supersede`: the replacement this decision accepted. */
  replacement?: { itemId: string; authority: Authority; version: number };
  error?: IntentErrorDetail;
}

/** The columns a decision is judged against, read under `FOR UPDATE`. */
interface LockedItemRow {
  id: string;
  kind: string;
  authority: Authority;
  version: number;
  proposedSuccessorOfId: string | null;
}

@Injectable()
export class IntentReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async review(
    workspaceId: string,
    actor: IntentActor,
    input: ReviewIntentItemsInput,
  ): Promise<{ decisions: IntentReviewDecisionResult[] }> {
    // Batch-level refusals: neither depends on workspace state, so both are
    // decided before the transaction opens and refuse the whole request.
    const sourceKind = reviewSourceKind(input.authorizingSource);
    assertDistinctSubjects(input.decisions);

    return runIntentMutation(
      this.prisma,
      {
        workspaceId,
        actor,
        operation: IntentOperation.ItemsReview,
        idempotencyKey: input.idempotencyKey,
        request: input,
      },
      async (tx) => {
        const facts = await this.lockItems(tx, workspaceId, reviewSubjectIds(input.decisions));
        const decisions: IntentReviewDecisionResult[] = [];

        for (const [index, decision] of input.decisions.entries()) {
          const plan = planReviewDecision(
            decision,
            {
              subject: facts.get(decision.itemId),
              replacement: decision.replacementItemId === undefined ? undefined : facts.get(decision.replacementItemId),
            },
            ['decisions', String(index)],
          );
          decisions.push(
            await this.applyPlan(tx, { workspaceId, actor, input, sourceKind }, decision, plan, index, facts),
          );
        }
        // Authority history lives in transitions, not in the audit trail (§4.8).
        return { response: { decisions }, audits: [] };
      },
    );
  }

  /**
   * Lock every item the batch names, in ascending id order, and return the facts
   * a plan is decided from. Rows the workspace does not hold are simply absent;
   * the planner turns that into a per-decision `item_not_found`.
   */
  private async lockItems(
    tx: IntentTransaction,
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, ReviewItemFacts>> {
    const unique = [...new Set(ids)];
    const rows = await tx.$queryRaw<LockedItemRow[]>`
      SELECT "id",
             "kind"::text AS "kind",
             "authority"::text AS "authority",
             "version",
             "proposed_successor_of_id" AS "proposedSuccessorOfId"
        FROM "intent_items"
       WHERE "workspace_id" = ${workspaceId}::uuid
         AND "id" IN (${Prisma.join(unique)})
       ORDER BY "id"
         FOR UPDATE`;
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async applyPlan(
    tx: IntentTransaction,
    context: {
      workspaceId: string;
      actor: IntentActor;
      input: ReviewIntentItemsInput;
      sourceKind: (typeof IntentAuthoritySourceKind)[keyof typeof IntentAuthoritySourceKind];
    },
    decision: IntentReviewDecisionInput,
    plan: IntentReviewPlan,
    index: number,
    facts: Map<string, ReviewItemFacts>,
  ): Promise<IntentReviewDecisionResult> {
    const subject = facts.get(decision.itemId);
    const base = {
      decisionIndex: index,
      itemId: decision.itemId,
      action: decision.action,
      // Unless the plan changes something, the item stands exactly as it was
      // read — which is also what a refusal must report, so the reviewer can
      // re-decide against the version that is actually there.
      authority: subject?.authority ?? null,
      version: subject?.version ?? null,
    };

    if (plan.effect === IntentReviewEffect.Refusal) {
      return { ...base, outcome: plan.outcome, error: plan.refusal };
    }
    if (plan.effect === IntentReviewEffect.None) {
      return { ...base, outcome: plan.outcome };
    }
    if (plan.effect === IntentReviewEffect.Transition) {
      const version = await this.applyTransition(tx, context, decision, plan.transition);
      return { ...base, outcome: plan.outcome, authority: plan.transition.to, version };
    }

    // Replacement: both writes, in the ascending id order the plan fixed.
    const versions = new Map<string, number>();
    for (const transition of plan.ordered) {
      versions.set(transition.itemId, await this.applyTransition(tx, context, decision, transition));
    }
    return {
      ...base,
      outcome: plan.outcome,
      authority: plan.predecessor.to,
      version: versions.get(plan.predecessor.itemId) as number,
      replacement: {
        itemId: plan.successor.itemId,
        authority: plan.successor.to,
        version: versions.get(plan.successor.itemId) as number,
      },
    };
  }

  /** One authority change: the versioned item update and its transition row, in that order. */
  private async applyTransition(
    tx: IntentTransaction,
    context: {
      workspaceId: string;
      actor: IntentActor;
      input: ReviewIntentItemsInput;
      sourceKind: (typeof IntentAuthoritySourceKind)[keyof typeof IntentAuthoritySourceKind];
    },
    decision: IntentReviewDecisionInput,
    transition: PlannedTransition,
  ): Promise<number> {
    const version = await updateItemWithVersion(tx, {
      workspaceId: context.workspaceId,
      itemId: transition.itemId,
      expectedVersion: transition.expectedVersion,
      updatedBy: context.actor.id,
      data: {
        authority: transition.to,
        ...(transition.supersededById === undefined ? {} : { supersededById: transition.supersededById }),
      },
    });

    const source = context.input.authorizingSource;
    await tx.intentAuthorityTransition.create({
      data: {
        workspaceId: context.workspaceId,
        itemId: transition.itemId,
        fromAuthority: transition.from,
        toAuthority: transition.to,
        // Identity is the token's, never the payload's (spec §4.7).
        actorId: context.actor.id,
        actorRole: context.actor.role,
        reason: decision.reason,
        sourceKind: context.sourceKind,
        sourceRef: source.ref,
        sourceLocalId: source.localId,
        sourceRevision: source.revision ?? null,
        workItem: (context.input.workItem as Prisma.InputJsonValue) ?? Prisma.DbNull,
      },
    });
    return version;
  }
}

/**
 * `import` is the arrival kind (spec §4.7): it belongs to the import flow, which
 * writes NULL-from transitions for content that was decided elsewhere. A review
 * is a decision taken here and now, so accepting `import` as its authorization
 * would let a reviewer's transition claim it merely recorded someone else's.
 *
 * Doubles as the enum bridge: the contract's authorizing-source kinds are a
 * TypeScript enum and the column's are Prisma's string literals, so the mapping
 * is stated once, exhaustively, rather than cast at the write site.
 */
function reviewSourceKind(
  source: IntentAuthorizingSourceInput,
): (typeof IntentAuthoritySourceKind)[keyof typeof IntentAuthoritySourceKind] {
  switch (source.kind) {
    case IntentAuthorizingSourceKind.Spec:
      return IntentAuthoritySourceKind.spec;
    case IntentAuthorizingSourceKind.Issue:
      return IntentAuthoritySourceKind.issue;
    case IntentAuthorizingSourceKind.Adr:
      return IntentAuthoritySourceKind.adr;
    case IntentAuthorizingSourceKind.Manual:
      return IntentAuthoritySourceKind.manual;
    case IntentAuthorizingSourceKind.Import:
      throw intentStateError(
        IntentErrorCode.AuthorizingSourceKindNotAllowed,
        "'import' authorizes the import of already-decided content, not a review decision. Use spec, issue, adr, or manual.",
        ['authorizingSource', 'kind'],
      );
  }
}

/**
 * One item, one decision per batch — counting the replacements.
 *
 * The operation schema already refuses two decisions naming the same `itemId`.
 * It cannot see the other half: a batch that supersedes A with B and also
 * decides B directly would move B twice under one provenance group, and the two
 * moves have no defined order. Refused as a request-shape error, like its
 * sibling in the schema.
 */
function assertDistinctSubjects(decisions: readonly IntentReviewDecisionInput[]): void {
  const seen = new Set<string>();
  decisions.forEach((decision, index) => {
    for (const [field, itemId] of [
      ['itemId', decision.itemId],
      ['replacementItemId', decision.replacementItemId],
    ] as const) {
      if (itemId === undefined) continue;
      if (seen.has(itemId)) {
        throw intentStateError(
          IntentErrorCode.ReviewSubjectRepeated,
          `Intent item '${itemId}' is the subject of more than one decision in this batch; decide it once.`,
          ['decisions', String(index), field],
        );
      }
      seen.add(itemId);
    }
  });
}
